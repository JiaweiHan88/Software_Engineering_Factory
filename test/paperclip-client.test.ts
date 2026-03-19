/**
 * Paperclip Client — Unit Tests
 *
 * Tests the HTTP client methods with mocked global fetch.
 * Covers agents, heartbeats, tickets, status reports, org, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PaperclipClient,
  PaperclipApiError,
} from "../src/adapter/paperclip-client.js";
import type {
  PaperclipAgent,
  PaperclipTicket,
  HeartbeatPollResponse,
  PaperclipOrg,
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
      apiKey: "test-key",
      orgId: "bmad-factory",
      timeoutMs: 5000,
    });
  });

  describe("headers", () => {
    it("includes auth and org headers in requests", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "a1" }));

      await client.getAgent("a1");

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBe("Bearer test-key");
      expect(opts.headers["X-Paperclip-Org"]).toBe("bmad-factory");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("omits auth header when no API key provided", async () => {
      const noAuthClient = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        orgId: "test",
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await noAuthClient.listAgents();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("agent management", () => {
    it("registers an agent", async () => {
      const agent: PaperclipAgent = {
        id: "bmad-dev",
        name: "BMAD Developer",
        role: "developer",
        status: "idle",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(agent));

      const result = await client.registerAgent(agent);

      expect(result.id).toBe("bmad-dev");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/agents/bmad-dev");
      expect(opts.method).toBe("PUT");
    });

    it("lists agents", async () => {
      const agents: PaperclipAgent[] = [
        { id: "bmad-dev", name: "Dev", role: "developer", status: "idle" },
        { id: "bmad-pm", name: "PM", role: "pm", status: "working" },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(agents));

      const result = await client.listAgents();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("bmad-dev");
    });

    it("gets a single agent", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "bmad-dev", name: "Dev", role: "developer", status: "idle" }));

      const result = await client.getAgent("bmad-dev");

      expect(result.id).toBe("bmad-dev");
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/v1/agents/bmad-dev");
    });

    it("updates agent status", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.updateAgentStatus("bmad-dev", "working", { storyId: "S-001" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/agents/bmad-dev/status");
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body)).toEqual({ status: "working", metadata: { storyId: "S-001" } });
    });
  });

  describe("heartbeats", () => {
    it("polls heartbeats for given agents", async () => {
      const response: HeartbeatPollResponse = {
        heartbeats: [
          { agentId: "bmad-dev", agentRole: "developer", timestamp: "2026-03-19T00:00:00Z" },
        ],
        nextPollAfterMs: 5000,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.pollHeartbeats(["bmad-dev"]);

      expect(result.heartbeats).toHaveLength(1);
      expect(result.nextPollAfterMs).toBe(5000);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/heartbeats/poll");
      expect(opts.method).toBe("POST");
    });

    it("acknowledges a heartbeat", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.acknowledgeHeartbeat("bmad-dev", "T-1");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/heartbeats/bmad-dev/ack");
      expect(JSON.parse(opts.body)).toEqual({ ticketId: "T-1" });
    });
  });

  describe("tickets", () => {
    it("lists tickets without filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listTickets();

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/v1/tickets");
    });

    it("lists tickets with filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.listTickets({ status: "open", assignedAgent: "bmad-dev" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("status=open");
      expect(url).toContain("assigned_agent=bmad-dev");
    });

    it("creates a ticket", async () => {
      const ticket: PaperclipTicket = {
        id: "T-1",
        title: "Test",
        description: "Test ticket",
        status: "open",
        priority: 1,
        labels: ["test"],
        createdAt: "2026-03-19T00:00:00Z",
        updatedAt: "2026-03-19T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(ticket));

      const result = await client.createTicket({
        title: "Test",
        description: "Test ticket",
        status: "open",
        priority: 1,
        labels: ["test"],
      });

      expect(result.id).toBe("T-1");
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
    });

    it("updates a ticket", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "T-1", status: "done" }));

      await client.updateTicket("T-1", { status: "done" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/tickets/T-1");
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("status reports", () => {
    it("sends a status report", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      await client.reportStatus({
        agentId: "bmad-dev",
        ticketId: "T-1",
        status: "completed",
        message: "Story implemented",
        artifacts: ["src/app.ts"],
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3100/api/v1/reports");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body).status).toBe("completed");
    });
  });

  describe("organization", () => {
    it("gets organization summary", async () => {
      const org: PaperclipOrg = {
        id: "bmad-factory",
        name: "BMAD Factory",
        agentCount: 9,
        activeTickets: 3,
        goals: [{ id: "g1", title: "Ship MVP", status: "active", progress: 0.5 }],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(org));

      const result = await client.getOrg();

      expect(result.name).toBe("BMAD Factory");
      expect(result.goals).toHaveLength(1);
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3100/api/v1/orgs/bmad-factory");
    });

    it("lists goals", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([{ id: "g1", title: "Ship MVP", status: "active", progress: 0.5 }]));

      const result = await client.listGoals();

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Ship MVP");
    });
  });

  describe("health check / ping", () => {
    it("returns true when server is reachable", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await client.ping();

      expect(result).toBe(true);
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
      try {
        await client.getAgent("nonexistent");
      } catch (err) {
        // Already thrown above, this is just for type narrowing
      }
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
      const c = new PaperclipClient({ baseUrl: "http://localhost:3100///", orgId: "test" });
      expect(c.url).toBe("http://localhost:3100");
    });
  });

  describe("url property", () => {
    it("returns the base URL", () => {
      expect(client.url).toBe("http://localhost:3100");
    });
  });
});
