/**
 * BMAD Sprint MCP Server — Entry Point
 *
 * A Model Context Protocol server that exposes BMAD sprint data as tools
 * for GitHub Copilot and other MCP-compatible clients.
 *
 * Transport: stdio (default for Copilot / VS Code integration)
 *
 * Available tools:
 *   - get_sprint_status   — current sprint state
 *   - get_next_story      — next story in ready-for-dev queue
 *   - update_story_status — move story through lifecycle
 *   - get_architecture_docs — project architecture context
 *   - get_story_details   — full story with ACs and tasks
 *
 * Usage:
 *   pnpm mcp:sprint              # Run via npm script
 *   tsx src/mcp/bmad-sprint-server/index.ts  # Run directly
 *
 * @module mcp/bmad-sprint-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSprintTools } from "./tools.js";

const SERVER_NAME = "bmad-sprint-server";
const SERVER_VERSION = "0.1.0";

/**
 * Create and configure the BMAD Sprint MCP server.
 *
 * @returns Configured McpServer instance with all tools registered
 */
export function createSprintServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerSprintTools(server);

  return server;
}

/**
 * Main — start the MCP server with stdio transport.
 * Only runs when this file is the entry point (not when imported).
 */
async function main(): Promise<void> {
  const server = createSprintServer();
  const transport = new StdioServerTransport();

  // Log to stderr so it doesn't interfere with MCP JSON-RPC on stdout
  console.error(`[${SERVER_NAME}] Starting MCP server v${SERVER_VERSION}...`);
  console.error(`[${SERVER_NAME}] Transport: stdio`);
  console.error(`[${SERVER_NAME}] Tools: get_sprint_status, get_next_story, update_story_status, get_architecture_docs, get_story_details`);

  await server.connect(transport);

  console.error(`[${SERVER_NAME}] Server connected and ready.`);
}

// Run main when executed directly
main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
