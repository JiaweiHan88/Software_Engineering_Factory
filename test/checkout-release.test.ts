/**
 * Phase A — Checkout/Release + Comments — Unit Tests
 *
 * Tests the new PaperclipClient methods:
 * - A1: checkoutIssue(), releaseIssue()
 * - A7: getIssueComments(), getIssueComment()
 * - A6: X-Paperclip-Run-Id header always sent when available
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PaperclipClient,
  PaperclipApiError,
} from "../src/adapter/paperclip-client.js";
import type {
  PaperclipIssue,
  PaperclipIssueComment,
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

describe("PaperclipClient — Phase A: Checkout/Release/Comments", () => {
  let client: PaperclipClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      agentApiKey: "test-agent-key",
      agentId: "agent-uuid-123",
      companyId: "bmad-factory",
      timeoutMs: 5000,
      heartbeatRunId: "run-abc",
    });
  });

  // ─── A1: checkoutIssue ──────────────────────────────────────────────

  describe("checkoutIssue", () => {
    it("checks out an issue via POST /api/issues/:id/checkout", async () => {
      const issue: PaperclipIssue = {
        id: "issue-1",
        title: "Test",
        description: "Desc",
        status: "in_progress",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(issue));

      const result = await client.checkoutIssue("issue-1", ["todo", "in_progress"]);

      expect(result).not.toBeNull();
      expect(result!.id).toBe("issue-1");
      expect(result!.status).toBe("in_progress");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/issues/issue-1/checkout");
      expect(opts.method).toBe("POST");
    });

    it("sends agentId and expectedStatuses in body", async () => {
      const issue: PaperclipIssue = {
        id: "issue-1",
        title: "Test",
        description: "Desc",
        status: "in_progress",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(issue));

      await client.checkoutIssue("issue-1", ["todo", "in_progress"]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.agentId).toBe("agent-uuid-123");
      expect(body.expectedStatuses).toEqual(["todo", "in_progress"]);
    });

    it("throws when expectedStatuses is empty", async () => {
      await expect(
        client.checkoutIssue("issue-1", []),
      ).rejects.toThrow("non-empty expectedStatuses");
    });

    it("throws when agentId is not configured", async () => {
      const noAgentClient = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        companyId: "test",
      });
      await expect(
        noAgentClient.checkoutIssue("issue-1", ["todo"]),
      ).rejects.toThrow("requires agentId");
    });

    it("returns null on 409 Conflict when another agent owns the task", async () => {
      // 409 on checkout
      mockFetch.mockResolvedValueOnce(errorResponse(409, "Already checked out"));
      // getIssue follow-up: issue assigned to a DIFFERENT agent
      const otherAgentIssue: PaperclipIssue = {
        id: "issue-1",
        title: "Test",
        description: "Desc",
        status: "in_progress",
        assigneeAgentId: "other-agent-uuid",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(otherAgentIssue));

      const result = await client.checkoutIssue("issue-1", ["todo"]);

      expect(result).toBeNull();
    });

    it("returns issue on 409 when executionRunId lock belongs to our agent (invoke path)", async () => {
      // 409 on checkout (executionRunId already set by enqueueWakeup)
      mockFetch.mockResolvedValueOnce(errorResponse(409, "Issue checkout conflict"));
      // getIssue follow-up: issue assigned to OUR agent
      const ourIssue: PaperclipIssue = {
        id: "issue-1",
        title: "Test",
        description: "Desc",
        status: "todo",
        assigneeAgentId: "agent-uuid-123",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(ourIssue));

      const result = await client.checkoutIssue("issue-1", ["todo"]);

      expect(result).not.toBeNull();
      expect(result!.id).toBe("issue-1");
      expect(result!.assigneeAgentId).toBe("agent-uuid-123");
    });

    it("returns null on 409 when getIssue follow-up also fails", async () => {
      // 409 on checkout
      mockFetch.mockResolvedValueOnce(errorResponse(409, "Already checked out"));
      // getIssue follow-up also fails (e.g., 500)
      mockFetch.mockResolvedValueOnce(errorResponse(500, "Server Error"));

      const result = await client.checkoutIssue("issue-1", ["todo"]);

      expect(result).toBeNull();
    });

    it("throws on non-409 errors (e.g., 500)", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

      await expect(client.checkoutIssue("issue-1", ["todo"])).rejects.toThrow(PaperclipApiError);
    });

    it("throws on 404 (issue not found)", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not found"));

      await expect(client.checkoutIssue("nonexistent", ["todo"])).rejects.toThrow(PaperclipApiError);
    });
  });

  // ─── A1: releaseIssue ──────────────────────────────────────────────

  describe("releaseIssue", () => {
    it("releases an issue via POST /api/issues/:id/release", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.releaseIssue("issue-1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/issues/issue-1/release");
      expect(opts.method).toBe("POST");
    });

    it("is idempotent — swallows 404 (unchecked-out task)", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not found"));

      // Should not throw
      await expect(client.releaseIssue("issue-1")).resolves.toBeUndefined();
    });

    it("is idempotent — swallows 409 (not checked out by this agent)", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(409, "Not checked out"));

      // Should not throw
      await expect(client.releaseIssue("issue-1")).resolves.toBeUndefined();
    });

    it("throws on 500 server error", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, "Server Error"));

      await expect(client.releaseIssue("issue-1")).rejects.toThrow(PaperclipApiError);
    });
  });

  // ─── A7: getIssueComments ────────────────────────────────────────────

  describe("getIssueComments", () => {
    it("gets comments via GET /api/issues/:id/comments", async () => {
      const comments: PaperclipIssueComment[] = [
        { id: "c1", issueId: "issue-1", body: "Hello", authorId: "agent-1" },
        { id: "c2", issueId: "issue-1", body: "World", authorId: "agent-2" },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(comments));

      const result = await client.getIssueComments("issue-1");

      expect(result).toHaveLength(2);
      expect(result[0].body).toBe("Hello");
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:3100/api/issues/issue-1/comments",
      );
    });

    it("supports incremental read with 'after' cursor", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getIssueComments("issue-1", { after: "c1", order: "asc" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("after=c1");
      expect(url).toContain("order=asc");
    });

    it("sends no query params when options are empty", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getIssueComments("issue-1");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe("http://localhost:3100/api/issues/issue-1/comments");
      expect(url).not.toContain("?");
    });
  });

  // ─── A7: getIssueComment ────────────────────────────────────────────

  describe("getIssueComment", () => {
    it("gets a single comment via GET /api/issues/:id/comments/:commentId", async () => {
      const comment: PaperclipIssueComment = {
        id: "c1",
        issueId: "issue-1",
        body: "Hello",
        authorId: "agent-1",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(comment));

      const result = await client.getIssueComment("issue-1", "c1");

      expect(result.body).toBe("Hello");
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:3100/api/issues/issue-1/comments/c1",
      );
    });
  });

  // ─── A6: X-Paperclip-Run-Id header ────────────────────────────────

  describe("X-Paperclip-Run-Id header", () => {
    it("sends X-Paperclip-Run-Id on all requests when heartbeatRunId is set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "i1" }));

      await client.getIssue("i1");

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["X-Paperclip-Run-Id"]).toBe("run-abc");
    });

    it("sends X-Paperclip-Run-Id even without agentApiKey", async () => {
      const noAuthClient = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        companyId: "test",
        heartbeatRunId: "run-xyz",
        // no agentApiKey
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await noAuthClient.listAgents();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBeUndefined();
      expect(opts.headers["X-Paperclip-Run-Id"]).toBe("run-xyz");
    });

    it("omits X-Paperclip-Run-Id when heartbeatRunId is not set", async () => {
      const noRunIdClient = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        companyId: "test",
        // no heartbeatRunId
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await noRunIdClient.listAgents();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["X-Paperclip-Run-Id"]).toBeUndefined();
    });

    it("sends run ID on POST (mutating) requests", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "c1", issueId: "i1", body: "Done" }));

      await client.addIssueComment("i1", "Done");

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["X-Paperclip-Run-Id"]).toBe("run-abc");
    });

    it("sends run ID on checkout requests", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: "i1", title: "T", description: "D", status: "in_progress" }),
      );

      await client.checkoutIssue("i1", ["todo"]);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["X-Paperclip-Run-Id"]).toBe("run-abc");
    });
  });
});
