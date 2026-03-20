/**
 * Heartbeat Handler — Unit Tests
 *
 * Tests phase resolution (metadata, role-based inference),
 * handleHeartbeat flow, and handlePaperclipIssue conversion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Copilot SDK
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
  traceAgentDispatch: vi.fn(
    async (_agent: string, _phase: string, _story: string, fn: (span: { setAttribute: () => void }) => Promise<unknown>) =>
      fn({ setAttribute: vi.fn() } as unknown as { setAttribute: () => void }),
  ),
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordDispatchDuration: vi.fn(),
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
}));

import {
  handleHeartbeat,
  handlePaperclipIssue,
} from "../src/adapter/heartbeat-handler.js";
import type { HeartbeatContext } from "../src/adapter/heartbeat-handler.js";
import type { AgentDispatcher, DispatchResult } from "../src/adapter/agent-dispatcher.js";
import type { PaperclipIssue } from "../src/adapter/paperclip-client.js";
import type { PaperclipReporter } from "../src/adapter/reporter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockDispatcher(overrides?: Partial<DispatchResult>): AgentDispatcher {
  const defaultResult: DispatchResult = {
    success: true,
    response: "Task completed.",
    agentName: "bmad-dev",
    sessionId: "sess-123",
    ...overrides,
  };

  return {
    dispatch: vi.fn().mockResolvedValue(defaultResult),
    dispatchDirect: vi.fn().mockResolvedValue(defaultResult),
  } as unknown as AgentDispatcher;
}

function makeMockReporter(): PaperclipReporter {
  return {
    reportHeartbeatResult: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaperclipReporter;
}

function makeIssue(overrides?: Partial<PaperclipIssue>): PaperclipIssue {
  return {
    id: "issue-1",
    title: "Implement feature X",
    description: "Build the REST API for feature X",
    status: "todo",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("heartbeat-handler", () => {
  let dispatcher: AgentDispatcher;
  let reporter: PaperclipReporter;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatcher = makeMockDispatcher();
    reporter = makeMockReporter();
  });

  // ─── handleHeartbeat ────────────────────────────────────────────────

  describe("handleHeartbeat", () => {
    it("returns idle when no issue is assigned", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-dev",
      };

      const result = await handleHeartbeat(ctx, dispatcher);

      expect(result.status).toBe("working");
      expect(result.message).toContain("idle");
      expect((dispatcher.dispatch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("returns needs-human for unknown BMAD role", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-nonexistent",
        issue: { id: "i-1", title: "Task", description: "desc" },
      };

      const result = await handleHeartbeat(ctx, dispatcher);

      expect(result.status).toBe("needs-human");
      expect(result.message).toContain("Unknown BMAD role");
    });

    it("dispatches to the correct phase from explicit issue.phase", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-dev",
        issue: {
          id: "i-1",
          title: "Write code",
          description: "Implement feature",
          phase: "dev-story",
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("dev-story");
    });

    it("resolves phase from metadata.bmadPhase when issue.phase is not set", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-analyst",
        issue: {
          id: "i-1",
          title: "Research APIs",
          description: "Investigate REST vs GraphQL",
          metadata: { bmadPhase: "research" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("research");
    });

    it("resolves phase from metadata.workPhase (explicit WorkPhase)", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-pm",
        issue: {
          id: "i-1",
          title: "Create PRD",
          description: "Write product requirements document",
          metadata: { workPhase: "create-prd" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("create-prd");
    });

    it("prefers metadata.workPhase over metadata.bmadPhase", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-architect",
        issue: {
          id: "i-1",
          title: "Architecture task",
          description: "Design the system",
          metadata: {
            workPhase: "create-architecture",
            bmadPhase: "define", // would map to create-prd
          },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("create-architecture");
    });

    it("falls back to inferPhaseFromRole when no metadata phase", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-architect",
        issue: {
          id: "i-1",
          title: "Some task",
          description: "Details",
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // bmad-architect defaults to create-architecture
      expect(dispatchCall.phase).toBe("create-architecture");
    });

    it("maps bmadPhase 'define' to create-prd", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-pm",
        issue: {
          id: "i-1",
          title: "Define product",
          description: "Create specifications",
          metadata: { bmadPhase: "define" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("create-prd");
    });

    it("maps bmadPhase 'plan' to sprint-planning", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-sm",
        issue: {
          id: "i-1",
          title: "Plan sprint",
          description: "Create sprint backlog",
          metadata: { bmadPhase: "plan" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("sprint-planning");
    });

    it("maps bmadPhase 'execute' to dev-story", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-dev",
        issue: {
          id: "i-1",
          title: "Build API",
          description: "Implement REST endpoints",
          metadata: { bmadPhase: "execute" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("dev-story");
    });

    it("maps bmadPhase 'review' to code-review", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-qa",
        issue: {
          id: "i-1",
          title: "Review code",
          description: "Adversarial code review",
          metadata: { bmadPhase: "review" },
        },
      };

      await handleHeartbeat(ctx, dispatcher);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("code-review");
    });

    it("returns stalled when dispatch fails", async () => {
      dispatcher = makeMockDispatcher({ success: false, error: "SDK timeout" });

      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-dev",
        issue: {
          id: "i-1",
          title: "Task",
          description: "desc",
          phase: "dev-story",
        },
      };

      const result = await handleHeartbeat(ctx, dispatcher);

      expect(result.status).toBe("stalled");
      expect(result.message).toContain("Failed");
    });

    it("returns completed on success", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-dev",
        issue: {
          id: "i-1",
          title: "Build feature",
          description: "desc",
          phase: "dev-story",
        },
      };

      const result = await handleHeartbeat(ctx, dispatcher);

      expect(result.status).toBe("completed");
      expect(result.message).toContain("Build feature");
    });
  });

  // ─── inferPhaseFromRole (via handleHeartbeat) ───────────────────────

  describe("inferPhaseFromRole", () => {
    const testCases: Array<{ role: string; expectedPhase: string }> = [
      { role: "bmad-pm", expectedPhase: "create-story" },
      { role: "bmad-analyst", expectedPhase: "research" },
      { role: "bmad-dev", expectedPhase: "dev-story" },
      { role: "bmad-qa", expectedPhase: "code-review" },
      { role: "bmad-sm", expectedPhase: "sprint-planning" },
      { role: "bmad-architect", expectedPhase: "create-architecture" },
      { role: "bmad-ux-designer", expectedPhase: "create-ux-design" },
      { role: "bmad-tech-writer", expectedPhase: "documentation" },
      { role: "bmad-quick-flow-solo-dev", expectedPhase: "quick-dev" },
    ];

    for (const { role, expectedPhase } of testCases) {
      it(`infers ${expectedPhase} for ${role}`, async () => {
        const ctx: HeartbeatContext = {
          agentId: "agent-1",
          bmadRole: role,
          issue: {
            id: "i-1",
            title: "Some task",
            description: "desc",
            // No phase, no metadata → falls through to inferPhaseFromRole
          },
        };

        await handleHeartbeat(ctx, dispatcher);

        const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(dispatchCall.phase).toBe(expectedPhase);
      });
    }

    it("defaults unknown roles to delegated-task", async () => {
      const ctx: HeartbeatContext = {
        agentId: "agent-1",
        bmadRole: "bmad-unknown-role",
        issue: {
          id: "i-1",
          title: "Unknown",
          description: "desc",
        },
      };

      // bmad-unknown-role won't be found in the agent registry
      const result = await handleHeartbeat(ctx, dispatcher);

      expect(result.status).toBe("needs-human");
    });
  });

  // ─── handlePaperclipIssue ───────────────────────────────────────────

  describe("handlePaperclipIssue", () => {
    it("converts PaperclipIssue to HeartbeatContext and dispatches", async () => {
      const issue = makeIssue();

      const result = await handlePaperclipIssue(
        issue, "agent-1", "bmad-dev", dispatcher, reporter,
      );

      expect(result.status).toBe("completed");
      expect((dispatcher.dispatch as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });

    it("reports result back to Paperclip via reporter", async () => {
      const issue = makeIssue();

      await handlePaperclipIssue(issue, "agent-1", "bmad-dev", dispatcher, reporter);

      expect((reporter.reportHeartbeatResult as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect((reporter.reportHeartbeatResult as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent-1",
        "issue-1",
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("passes issue metadata through for phase resolution", async () => {
      const issue = makeIssue({
        metadata: { bmadPhase: "research", delegatedBy: "ceo" },
      });

      await handlePaperclipIssue(issue, "agent-1", "bmad-analyst", dispatcher, reporter);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("research");
    });

    it("uses issue.phase when set on PaperclipIssue", async () => {
      const issue = makeIssue({ phase: "create-prd" });

      await handlePaperclipIssue(issue, "agent-1", "bmad-pm", dispatcher, reporter);

      const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(dispatchCall.phase).toBe("create-prd");
    });
  });
});
