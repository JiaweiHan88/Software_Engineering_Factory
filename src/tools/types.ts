/**
 * BMAD Tool Types — re-exports from Copilot SDK for convenience.
 *
 * Tools are created via the SDK's `defineTool()` helper which provides
 * Zod schema → JSON Schema conversion and type-safe handlers.
 *
 * @module tools/types
 */

export { defineTool } from "@github/copilot-sdk";
export type { Tool, ToolHandler, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";

