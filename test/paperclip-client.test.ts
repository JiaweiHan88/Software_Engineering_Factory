/**
 * Paperclip Client — Unit Tests
 *
 * Tests the HTTP client methods aligned with the real Paperclip API.
 * Covers agents, issues, issue comments, org tree, goals, and error handling.
 *
 * Key changes from previous tests:
 * - No polling/heartbeat endpoints (push model)
 * - Issues instead of tickets
 * - Issue comments instead of status reports
 * - Agent lifecycle: active/paused/terminated
 * - Real API paths: /api (no version prefix)
 * - No X-Paperclip-Org header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PaperclipClient,
  PaperclipApiError,
} from "../src/adapter/paperclip-client.js";
import type {
  PaperclipAgent,
  PaperclipIssue,
  OrgNode,
  PaperclipGoal,
} from "../src/adapter/paperclip-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock fetch
// ─────────────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse<T>(data: T, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function errorResponse(status: number, body = "Error"): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("Not JSON")),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error("No content")),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PaperclipClient", () => {
  let client: PaperclipClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      agentApiKey: "test-agent-key",
      companyId: "bmad-factory",
      timeoutMs: 5000,
    });
  });

  describe("headers", () => {
    it("includes Bearer auth in requests (no X-Paperclip-Org)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "a1" }));

      await client.getAgent("a1");

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBe("Bearer test-agent-key");
      expect(opts.headers["X-Paperclip-Org"]).toBeUndefined();
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("omits auth header when no agent API key provided", async () => {
      const noAuthClient = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        companyId: "test",
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await noAuthClient.listAgents();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("agent management", () => {
    it("creates an agent via POST /api/companies/:companyId/agents", async () => {
      const agent: PaperclipAgent = {
        id: "agent-1",
        name: "BMAD Developer",
        title: "Developer",
        companyId: "bmad-factory",
        status: "active",
        heartbeatEnabled: true,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(agent));

      const result = await client.createAgent({
        name: "BMAD Developer",
        title: "Developer",
        companyId: "bmad-factory",
        status: "active",
        heartbeatEnabled: true,
      });

      expect(result.id).toBe("agent-1");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/companies/bmad-factory/agent-hires");
      expect(opts.method).toBe("POST");
    });

    it("lists agents via GET /api/companies/:companyId/agents", async () => {
      const agents: PaperclipAgent[] = [
        { id: "a1", name: "Dev", title: "Developer", companyId: "bmad-factory", status: "active", heartbeatEnabled: true },
        { id: "a2", name: "PM", title: "PM", companyId: "bmad-factory", status: "active", heartbeatEnabled: true },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(agents));

      const result = await client.listAgents();

      expect(result).toHaveLength(2);
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/agents");
    });

    it("gets a single agent via GET /api/agents/:id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "a1", name: "Dev", title: "Developer", companyId: "bmad-factory", status: "active", heartbeatEnabled: true }));

      const result = await client.getAgent("a1");

      expect(result.id).toBe("a1");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/agents/a1");
    });

    it("gets agent self via GET /api/agents/me", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "self", name: "Self", title: "Me", companyId: "bmad-factory", status: "active", heartbeatEnabled: true }));

      const result = await client.getAgentSelf();

      expect(result.id).toBe("self");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/agents/me");
    });

    it("updates agent metadata via PATCH /api/agents/:id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "a1", name: "Updated Dev" }));

      await client.updateAgent("a1", { name: "Updated Dev" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1");
      expect(opts.method).toBe("PATCH");
    });

    it("pauses agent via POST /api/agents/:id/pause", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.pauseAgent("a1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1/pause");
      expect(opts.method).toBe("POST");
    });

    it("resumes agent via POST /api/agents/:id/resume", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.resumeAgent("a1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1/resume");
      expect(opts.method).toBe("POST");
    });

    it("terminates agent via POST /api/agents/:id/terminate", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.terminateAgent("a1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1/terminate");
      expect(opts.method).toBe("POST");
    });
  });

  describe("heartbeat / wakeup", () => {
    it("invokes heartbeat via POST /api/agents/:id/heartbeat/invoke", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "run-1", agentId: "a1", companyId: "bmad-factory", status: "running", startedAt: "2026-03-19T00:00:00Z" }));

      const result = await client.invokeHeartbeat("a1");

      expect(result.id).toBe("run-1");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1/heartbeat/invoke");
      expect(opts.method).toBe("POST");
    });

    it("wakes agent via POST /api/agents/:id/wakeup", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.wakeAgent("a1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/agents/a1/wakeup");
      expect(opts.method).toBe("POST");
    });

    it("gets agent inbox via GET /api/agents/me/inbox-lite", async () => {
      const issues: PaperclipIssue[] = [
        { id: "i1", title: "Implement auth", description: "OAuth2", status: "assigned" },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(issues));

      const result = await client.getAgentInbox();

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Implement auth");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/agents/me/inbox-lite");
    });
  });

  describe("issues (not tickets)", () => {
    it("lists issues via GET /api/companies/:companyId/issues", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listIssues();

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/issues");
    });

    it("lists issues with filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listIssues({ status: "open", assigneeAgentId: "a1" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("status=open");
      expect(url).toContain("assigneeAgentId=a1");
    });

    it("gets a single issue via GET /api/issues/:id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "i1", title: "Test", description: "Desc", status: "open" }));

      const result = await client.getIssue("i1");

      expect(result.id).toBe("i1");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/issues/i1");
    });

    it("creates an issue via POST /api/companies/:companyId/issues", async () => {
      const issue: PaperclipIssue = {
        id: "i1",
        title: "Test",
        description: "Test issue",
        status: "open",
        createdAt: "2026-03-19T00:00:00Z",
        updatedAt: "2026-03-19T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(issue));

      const result = await client.createIssue({
        title: "Test",
        description: "Test issue",
        status: "open",
      });

      expect(result.id).toBe("i1");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/companies/bmad-factory/issues");
      expect(opts.method).toBe("POST");
    });

    it("updates an issue via PATCH /api/issues/:id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "i1", status: "done" }));

      await client.updateIssue("i1", { status: "done" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/issues/i1");
      expect(opts.method).toBe("PATCH");
    });

    it("adds a comment to an issue via POST /api/issues/:id/comments", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "c1", issueId: "i1", body: "Done!" }));

      const result = await client.addIssueComment("i1", "Done!");

      expect(result.body).toBe("Done!");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/issues/i1/comments");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ body: "Done!" });
    });
  });

  describe("organization & goals", () => {
    it("gets org tree via GET /api/companies/:companyId/org", async () => {
      const orgTree: OrgNode = {
        agent: { id: "ceo", name: "CEO", title: "CEO", companyId: "bmad-factory", status: "active", heartbeatEnabled: false },
        children: [],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(orgTree));

      const result = await client.getOrgTree();

      expect(result.agent.name).toBe("CEO");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/org");
    });

    it("lists goals via GET /api/companies/:companyId/goals", async () => {
      const goals: PaperclipGoal[] = [
        { id: "g1", title: "Ship MVP", status: "active", companyId: "bmad-factory" },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(goals));

      const result = await client.listGoals();

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Ship MVP");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/goals");
    });
  });

  describe("heartbeat runs", () => {
    it("lists heartbeat runs via GET /api/companies/:companyId/heartbeat-runs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listHeartbeatRuns();

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/heartbeat-runs");
    });

    it("gets a specific heartbeat run via GET /api/heartbeat-runs/:runId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "run-1", agentId: "a1", companyId: "bmad-factory", status: "completed", startedAt: "2026-03-19T00:00:00Z" }));

      const result = await client.getHeartbeatRun("run-1");

      expect(result.id).toBe("run-1");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/heartbeat-runs/run-1");
    });

    it("cancels a heartbeat run via POST /api/heartbeat-runs/:runId/cancel", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.cancelHeartbeatRun("run-1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/heartbeat-runs/run-1/cancel");
      expect(opts.method).toBe("POST");
    });

    it("gets live runs via GET /api/companies/:companyId/live-runs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getLiveRuns();

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/companies/bmad-factory/live-runs");
    });
  });

  describe("health check / ping", () => {
    it("pings via GET /api/health (correct path, no version prefix)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await client.ping();

      expect(result).toBe(true);
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/health");
    });

    it("returns false when server is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await client.ping();

      expect(result).toBe(false);
    });
  });

  describe("error handling", () => {
    it("throws PaperclipApiError on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not found"));

      await expect(client.getAgent("nonexistent")).rejects.toThrow(PaperclipApiError);
    });

    it("PaperclipApiError has status code and endpoint", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

      try {
        await client.listAgents();
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PaperclipApiError);
        const apiErr = err as PaperclipApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.endpoint).toContain("GET");
        expect(apiErr.responseBody).toContain("Internal Server Error");
      }
    });

    it("strips trailing slash from base URL", () => {
      const c = new PaperclipClient({ baseUrl: "http://localhost:3100///", companyId: "test" });
      expect(c.url).toBe("http://localhost:3100");
    });
  });

  describe("url and company properties", () => {
    it("returns the base URL", () => {
      expect(client.url).toBe("http://localhost:3100");
    });

    it("returns the company ID", () => {
      expect(client.company).toBe("bmad-factory");
    });
  });
});
