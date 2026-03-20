/**
 * HTTP Health-Check Endpoint
 *
 * Minimal HTTP handler that responds to GET /health with a JSON payload
 * indicating service liveness. Designed for load-balancer and orchestrator
 * health probes. Uses Node.js built-ins only — no external dependencies.
 *
 * Response: `{ "status": "ok", "timestamp": "<ISO 8601>" }`
 *
 * @module health
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Shape of the health-check JSON response body */
export interface HealthResponse {
  status: "ok";
  timestamp: string;
}

/**
 * HTTP request handler for GET /health.
 *
 * Returns 200 + JSON `{ status: "ok", timestamp }` on a GET /health request.
 * Returns 404 for any other path and 405 for non-GET methods on /health.
 *
 * @param req - Incoming HTTP request
 * @param res - Outgoing HTTP response
 */
export function healthHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.url !== "/health") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const body: HealthResponse = { status: "ok", timestamp: new Date().toISOString() };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
