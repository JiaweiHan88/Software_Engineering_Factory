/**
 * SMOKE-001: Hello from BMAD Factory — Unit Test
 */

import { describe, it, expect } from "vitest";
import { hello } from "../src/sandbox/hello-bmad.js";

describe("SMOKE-001: hello", () => {
  it('responds with "Hello from BMAD Factory!"', () => {
    expect(hello()).toBe("Hello from BMAD Factory!");
  });
});
