/**
 * HTTP Health-Check Endpoint — Unit Tests
 *
 * Tests the healthHandler function: correct response on GET /health,
 * 404 on unknown paths, and 405 on non-GET methods.
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { healthHandler } from "../src/health.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function makeRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body: string) {
      this._body = body;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("healthHandler", () => {
  it("GET /health returns 200 with status=ok and ISO timestamp", () => {
    const before = Date.now();
    const req = makeReq("GET", "/health");
    const res = makeRes();

    healthHandler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(res._body) as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(body.timestamp).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("GET /other returns 404", () => {
    const req = makeReq("GET", "/other");
    const res = makeRes();

    healthHandler(req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it("POST /health returns 405", () => {
    const req = makeReq("POST", "/health");
    const res = makeRes();

    healthHandler(req, res);

    expect(res._status).toBe(405);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe("Method Not Allowed");
  });
});
