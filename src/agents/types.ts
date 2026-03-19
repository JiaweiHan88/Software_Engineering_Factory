/**
 * BMAD Agent Type — matches Copilot SDK customAgent shape.
 * We define our own interface so we can type-check before the SDK is installed.
 */
export interface BmadAgent {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
}
