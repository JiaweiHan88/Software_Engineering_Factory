/**
 * BMAD Tool Type — matches Copilot SDK defineTool() shape.
 * We define our own interface so we can type-check before the SDK is installed.
 *
 * When the SDK is installed, these will be passed to defineTool() directly.
 */
export interface BmadToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
