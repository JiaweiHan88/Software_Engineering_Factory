import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { healthHandler } from "./health.js";

describe("GET /health", () => {
  it("returns 200 with status ok and ISO timestamp", async () => {
    const server = createServer(healthHandler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json() as { status: string; timestamp: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 404 for unknown paths", async () => {
    const server = createServer(healthHandler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 405 for non-GET methods on /health", async () => {
    const server = createServer(healthHandler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://localhost:${port}/health`, { method: "POST" });
    expect(res.status).toBe(405);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
