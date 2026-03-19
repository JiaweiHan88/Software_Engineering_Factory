/**
 * SMOKE-001: Hello from BMAD Factory
 *
 * Minimal smoke-test entry point that verifies the factory can respond.
 */

/**
 * Returns the BMAD Factory greeting message.
 */
export function hello(): string {
  return "Hello from BMAD Factory!";
}

// Script entry-point
if (process.argv[1] && process.argv[1].endsWith("hello-bmad.ts")) {
  console.log(hello());
}
