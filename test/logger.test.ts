/**
 * Structured Logger — Unit Tests
 *
 * Tests the logger output formatting and level filtering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/observability/logger.js";

describe("Logger", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe("level filtering", () => {
    it("should emit info messages when level is info", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("test");

      log.info("hello");

      expect(stdoutSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
      expect(output.level).toBe("info");
      expect(output.message).toBe("hello");
    });

    it("should suppress debug messages when level is info", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("test");

      log.debug("should not appear");

      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("should emit error messages to stderr", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("test");

      log.error("bad thing");

      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(output.level).toBe("error");
    });

    it("should emit debug messages when level is debug", () => {
      Logger.configure({ level: "debug", format: "json" });
      const log = Logger.child("test");

      log.debug("trace info");

      expect(stdoutSpy).toHaveBeenCalledOnce();
    });
  });

  describe("JSON format", () => {
    it("should output valid JSON with all fields", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("sprint-runner");

      log.info("Sprint started", { storyCount: 5 });

      const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
      expect(output.timestamp).toBeTruthy();
      expect(output.level).toBe("info");
      expect(output.component).toBe("sprint-runner");
      expect(output.message).toBe("Sprint started");
      expect(output.context.storyCount).toBe(5);
    });

    it("should include error details when provided", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("test");

      log.error("Failed", { op: "dispatch" }, new Error("timeout"));

      const output = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(output.error.message).toBe("timeout");
      expect(output.error.stack).toBeTruthy();
    });

    it("should merge child context with per-call context", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("agent", { agentName: "bmad-dev" });

      log.info("dispatching", { phase: "dev-story" });

      const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
      expect(output.context.agentName).toBe("bmad-dev");
      expect(output.context.phase).toBe("dev-story");
    });

    it("should omit empty context object", () => {
      Logger.configure({ level: "info", format: "json" });
      const log = Logger.child("test");

      log.info("no context");

      const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
      expect(output.context).toBeUndefined();
    });
  });

  describe("human format", () => {
    it("should output human-readable format", () => {
      Logger.configure({ level: "info", format: "human" });
      const log = Logger.child("test-component");

      log.info("Hello world");

      expect(stdoutSpy).toHaveBeenCalledOnce();
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain("INFO");
      expect(output).toContain("[test-component]");
      expect(output).toContain("Hello world");
    });
  });
});
