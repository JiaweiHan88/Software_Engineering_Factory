/**
 * CEO Orchestrator Tests
 *
 * Tests for the CEO's strategic delegation logic:
 * - parseDelegationPlan() — JSON parsing with LLM quirks
 * - resolveAgentId() — BMAD role → Paperclip UUID resolution
 * - orchestrateCeoIssue() — end-to-end orchestration flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Copilot SDK (required for transitive imports)
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

// Mock observability
vi.mock("../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../src/observability/tracing.js", () => ({
  traceAgentDispatch: vi.fn(),
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordDispatchDuration: vi.fn(),
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
}));

import {
  parseDelegationPlan,
  resolveAgentId,
  clearAgentIdCache,
  orchestrateCeoIssue,
} from "../src/adapter/ceo-orchestrator.js";
import type { DelegationPlan } from "../src/adapter/ceo-orchestrator.js";
import type { PaperclipAgent, PaperclipIssue } from "../src/adapter/paperclip-client.js";
import type { RoleMappingEntry } from "../src/config/role-mapping.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseDelegationPlan
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDelegationPlan", () => {
  const validPlan: DelegationPlan = {
    analysis: "This issue needs research first",
    phases: ["research", "define"],
    tasks: [
      {
        title: "Research market requirements",
        description: "Investigate market needs",
        assignTo: "bmad-analyst",
        priority: "medium",
        phase: "research",
      },
      {
        title: "Create PRD",
        description: "Create product requirements document",
        assignTo: "bmad-pm",
        priority: "high",
        phase: "define",
      },
    ],
    requiresApproval: false,
  };

  it("parses clean JSON", () => {
    const result = parseDelegationPlan(JSON.stringify(validPlan));
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(2);
    expect(result!.tasks[0].assignTo).toBe("bmad-analyst");
    expect(result!.tasks[1].assignTo).toBe("bmad-pm");
    expect(result!.analysis).toBe("This issue needs research first");
    expect(result!.phases).toEqual(["research", "define"]);
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const wrapped = "```json\n" + JSON.stringify(validPlan) + "\n```";
    const result = parseDelegationPlan(wrapped);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(2);
  });

  it("parses JSON with leading prose text", () => {
    const withProse = "Here is my delegation plan:\n\n" + JSON.stringify(validPlan);
    const result = parseDelegationPlan(withProse);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(2);
  });

  it("parses JSON with trailing text", () => {
    const withTrailing = JSON.stringify(validPlan) + "\n\nLet me know if you want changes.";
    const result = parseDelegationPlan(withTrailing);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(2);
  });

  it("returns null for empty response", () => {
    expect(parseDelegationPlan("")).toBeNull();
  });

  it("returns null for response with no JSON", () => {
    expect(parseDelegationPlan("I don't know how to handle this")).toBeNull();
  });

  it("returns null for JSON with no tasks", () => {
    const noTasks = JSON.stringify({
      analysis: "test",
      phases: [],
      tasks: [],
      requiresApproval: false,
    });
    expect(parseDelegationPlan(noTasks)).toBeNull();
  });

  it("returns null for JSON with invalid tasks (missing title)", () => {
    const invalidTasks = JSON.stringify({
      analysis: "test",
      phases: [],
      tasks: [{ description: "no title", assignTo: "bmad-pm" }],
      requiresApproval: false,
    });
    // Task without title is skipped, leaving 0 valid tasks
    expect(parseDelegationPlan(invalidTasks)).toBeNull();
  });

  it("skips tasks missing assignTo but keeps valid ones", () => {
    const mixed = JSON.stringify({
      analysis: "test",
      phases: ["execute"],
      tasks: [
        { title: "Valid task", assignTo: "bmad-dev", priority: "high", phase: "execute" },
        { title: "Invalid task" }, // missing assignTo
      ],
      requiresApproval: false,
    });
    const result = parseDelegationPlan(mixed);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0].title).toBe("Valid task");
  });

  it("defaults invalid priority to medium", () => {
    const badPriority = JSON.stringify({
      analysis: "test",
      phases: [],
      tasks: [{ title: "Task", assignTo: "bmad-dev", priority: "urgent", phase: "execute" }],
      requiresApproval: false,
    });
    const result = parseDelegationPlan(badPriority);
    expect(result).not.toBeNull();
    expect(result!.tasks[0].priority).toBe("medium");
  });

  it("defaults invalid phase to execute", () => {
    const badPhase = JSON.stringify({
      analysis: "test",
      phases: [],
      tasks: [{ title: "Task", assignTo: "bmad-dev", priority: "high", phase: "deploy" }],
      requiresApproval: false,
    });
    const result = parseDelegationPlan(badPhase);
    expect(result).not.toBeNull();
    expect(result!.tasks[0].phase).toBe("execute");
  });

  it("handles approval required plan", () => {
    const approval = JSON.stringify({
      analysis: "Big change",
      phases: ["define"],
      tasks: [{ title: "Task", assignTo: "bmad-architect", priority: "critical", phase: "define" }],
      requiresApproval: true,
      approvalReason: "Infrastructure cost > $1000",
    });
    const result = parseDelegationPlan(approval);
    expect(result).not.toBeNull();
    expect(result!.requiresApproval).toBe(true);
    expect(result!.approvalReason).toBe("Infrastructure cost > $1000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAgentId
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAgentId", () => {
  beforeEach(() => {
    clearAgentIdCache();
  });

  const mockAgents: PaperclipAgent[] = [
    {
      id: "uuid-ceo",
      name: "CEO",
      title: "ceo",
      companyId: "c1",
      status: "active",
      heartbeatEnabled: true,
    },
    {
      id: "uuid-pm",
      name: "Product Manager (John)",
      title: "bmad-pm",
      companyId: "c1",
      status: "active",
      heartbeatEnabled: true,
    },
    {
      id: "uuid-dev",
      name: "Developer (Amelia)",
      title: "bmad-dev",
      companyId: "c1",
      status: "active",
      heartbeatEnabled: true,
    },
  ];

  function createMockClient(agents: PaperclipAgent[]) {
    return {
      listAgents: vi.fn().mockResolvedValue(agents),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("resolves role name to agent UUID via title", async () => {
    const client = createMockClient(mockAgents);
    const id = await resolveAgentId("bmad-pm", client);
    expect(id).toBe("uuid-pm");
  });

  it("resolves case-insensitively", async () => {
    const client = createMockClient(mockAgents);
    const id = await resolveAgentId("BMAD-DEV", client);
    expect(id).toBe("uuid-dev");
  });

  it("returns undefined for unknown role", async () => {
    const client = createMockClient(mockAgents);
    const id = await resolveAgentId("bmad-unknown", client);
    expect(id).toBeUndefined();
  });

  it("caches agent list (only calls listAgents once)", async () => {
    const client = createMockClient(mockAgents);
    await resolveAgentId("bmad-pm", client);
    await resolveAgentId("bmad-dev", client);
    expect(client.listAgents).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when listAgents fails", async () => {
    const client = {
      listAgents: vi.fn().mockRejectedValue(new Error("Network error")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const id = await resolveAgentId("bmad-pm", client);
    expect(id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orchestrateCeoIssue (integration-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrateCeoIssue", () => {
  beforeEach(() => {
    clearAgentIdCache();
  });

  const mockIssue: PaperclipIssue = {
    id: "issue-1",
    title: "Build a REST API for a todo app",
    description: "We need a simple CRUD API for managing todos",
    status: "todo",
    priority: "medium",
  };

  const mockCeoAgent: PaperclipAgent = {
    id: "uuid-ceo",
    name: "CEO",
    title: "ceo",
    companyId: "c1",
    status: "active",
    heartbeatEnabled: true,
  };

  const mockAgentList: PaperclipAgent[] = [
    mockCeoAgent,
    { id: "uuid-pm", name: "PM", title: "bmad-pm", companyId: "c1", status: "active", heartbeatEnabled: true },
    { id: "uuid-dev", name: "Dev", title: "bmad-dev", companyId: "c1", status: "active", heartbeatEnabled: true },
    { id: "uuid-analyst", name: "Analyst", title: "bmad-analyst", companyId: "c1", status: "active", heartbeatEnabled: true },
  ];

  const mockMapping: RoleMappingEntry = {
    bmadAgentName: null,
    displayName: "CEO",
    isOrchestrator: true,
    agentConfigDir: "ceo",
    bmadSkills: [],
    tools: [],
  };

  function createMockClient() {
    return {
      listAgents: vi.fn().mockResolvedValue(mockAgentList),
      createIssue: vi.fn().mockImplementation(async (issue: Partial<PaperclipIssue>) => ({
        id: `sub-${Math.random().toString(36).slice(2, 8)}`,
        ...issue,
      })),
      addIssueComment: vi.fn().mockResolvedValue({ id: "comment-1", body: "", issueId: "" }),
      updateIssue: vi.fn().mockResolvedValue(mockIssue),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function createMockReporter() {
    return {
      reportHeartbeatResult: vi.fn(),
      reportDispatchResult: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function createMockSessionManager(responseJson: string) {
    return {
      createAgentSession: vi.fn().mockResolvedValue("session-1"),
      sendAndWait: vi.fn().mockResolvedValue(responseJson),
      closeSession: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function createMockConfig() {
    return {
      model: "gpt-4o",
      agentSystemMessage: "You are the CEO...",
      outputDir: "/tmp/bmad-output",
      targetProjectRoot: "/tmp/project",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("creates sub-issues from CEO delegation plan", async () => {
    const plan = {
      analysis: "This needs research then implementation",
      phases: ["research", "execute"],
      tasks: [
        { title: "Research API patterns", description: "Look into REST best practices", assignTo: "bmad-analyst", priority: "medium", phase: "research" },
        { title: "Implement the API", description: "Build the CRUD endpoints", assignTo: "bmad-dev", priority: "high", phase: "execute" },
      ],
      requiresApproval: false,
    };

    const client = createMockClient();
    const sessionManager = createMockSessionManager(JSON.stringify(plan));

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(true);
    expect(result.subtasksCreated).toBe(2);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.tasks).toHaveLength(2);

    // Verify sub-issues were created with correct fields
    expect(client.createIssue).toHaveBeenCalledTimes(2);

    const firstCall = client.createIssue.mock.calls[0][0];
    expect(firstCall.title).toBe("Research API patterns");
    expect(firstCall.assigneeAgentId).toBe("uuid-analyst");
    expect(firstCall.parentId).toBe("issue-1");
    expect(firstCall.status).toBe("todo");

    const secondCall = client.createIssue.mock.calls[1][0];
    expect(secondCall.title).toBe("Implement the API");
    expect(secondCall.assigneeAgentId).toBe("uuid-dev");
    expect(secondCall.priority).toBe("high");
  });

  it("posts approval comment when plan requires approval", async () => {
    const plan = {
      analysis: "Major infrastructure change",
      phases: ["define"],
      tasks: [{ title: "Design infra", assignTo: "bmad-architect", priority: "critical", phase: "define" }],
      requiresApproval: true,
      approvalReason: "Cost exceeds $1000",
    };

    const client = createMockClient();
    const sessionManager = createMockSessionManager(JSON.stringify(plan));

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(true);
    expect(result.subtasksCreated).toBe(0); // No sub-issues created, awaiting approval
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.addIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Approval Required"),
    );
  });

  it("handles unparseable CEO response gracefully", async () => {
    const client = createMockClient();
    const sessionManager = createMockSessionManager("I'm not sure what to do with this issue.");

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse delegation plan");
    expect(client.addIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Could not parse delegation plan"),
    );
  });

  it("handles session creation failure gracefully", async () => {
    const client = createMockClient();
    const sessionManager = {
      createAgentSession: vi.fn().mockRejectedValue(new Error("SDK not available")),
      sendAndWait: vi.fn(),
      closeSession: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create CEO session");
  });

  it("handles listAgents failure gracefully", async () => {
    const client = {
      ...createMockClient(),
      listAgents: vi.fn().mockRejectedValue(new Error("API down")),
    };

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      createMockReporter(),
      createMockSessionManager("{}"),
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to list agents");
  });

  it("continues creating remaining sub-issues when one fails", async () => {
    const plan = {
      analysis: "Two tasks",
      phases: ["execute"],
      tasks: [
        { title: "Task 1", description: "First", assignTo: "bmad-dev", priority: "high", phase: "execute" },
        { title: "Task 2", description: "Second", assignTo: "bmad-pm", priority: "medium", phase: "execute" },
      ],
      requiresApproval: false,
    };

    const client = createMockClient();
    // First createIssue fails, second succeeds
    client.createIssue
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({ id: "sub-2", title: "Task 2" });

    const sessionManager = createMockSessionManager(JSON.stringify(plan));

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(true); // At least one task succeeded
    expect(result.subtasksCreated).toBe(1);
    expect(client.createIssue).toHaveBeenCalledTimes(2);
    // Should have posted a warning comment about the failed task
    expect(client.addIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Failed to create sub-task"),
    );
  });

  it("creates unassigned sub-issue when agent ID resolution fails", async () => {
    const plan = {
      analysis: "Unknown agent role",
      phases: ["execute"],
      tasks: [{ title: "Task", description: "Do work", assignTo: "bmad-nonexistent", priority: "medium", phase: "execute" }],
      requiresApproval: false,
    };

    const client = createMockClient();
    const sessionManager = createMockSessionManager(JSON.stringify(plan));

    const result = await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    expect(result.success).toBe(true);
    expect(result.subtasksCreated).toBe(1);

    // Should still create the issue, just without assigneeAgentId
    const createCall = client.createIssue.mock.calls[0][0];
    expect(createCall.assigneeAgentId).toBeUndefined();
  });

  it("posts delegation summary on parent issue", async () => {
    const plan = {
      analysis: "Simple task",
      phases: ["execute"],
      tasks: [{ title: "Implement feature", description: "Build it", assignTo: "bmad-dev", priority: "high", phase: "execute" }],
      requiresApproval: false,
    };

    const client = createMockClient();
    const sessionManager = createMockSessionManager(JSON.stringify(plan));

    await orchestrateCeoIssue(
      mockIssue,
      mockCeoAgent,
      client,
      createMockReporter(),
      sessionManager,
      createMockConfig(),
      mockMapping,
    );

    // Last addIssueComment call should be the summary
    const calls = client.addIssueComment.mock.calls;
    const lastComment = calls[calls.length - 1][1] as string;
    expect(lastComment).toContain("Delegation Complete");
    expect(lastComment).toContain("Implement feature");
    expect(lastComment).toContain("bmad-dev");
  });
});
