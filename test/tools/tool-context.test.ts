/**
 * Tool Context — Unit Tests
 *
 * Tests the singleton tool context lifecycle:
 * - setToolContext / getToolContext / tryGetToolContext / clearToolContext
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  setToolContext,
  getToolContext,
  tryGetToolContext,
  clearToolContext,
} from "../../src/tools/tool-context.js";
import type { ToolContext } from "../../src/tools/tool-context.js";
import type { PaperclipClient } from "../../src/adapter/paperclip-client.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    paperclipClient: {} as PaperclipClient,
    agentId: "agent-1",
    issueId: "issue-1",
    workspaceDir: "/workspace",
    companyId: "company-1",
    ...overrides,
  };
}

describe("tool-context", () => {
  beforeEach(() => {
    clearToolContext();
  });

  describe("setToolContext / getToolContext", () => {
    it("stores and retrieves context", () => {
      const ctx = makeContext();
      setToolContext(ctx);
      expect(getToolContext()).toBe(ctx);
    });

    it("overwrites previous context", () => {
      const ctx1 = makeContext({ agentId: "agent-1" });
      const ctx2 = makeContext({ agentId: "agent-2" });
      setToolContext(ctx1);
      setToolContext(ctx2);
      expect(getToolContext().agentId).toBe("agent-2");
    });
  });

  describe("getToolContext", () => {
    it("throws when no context has been set", () => {
      expect(() => getToolContext()).toThrow("Tool context not set");
    });

    it("throws after context is cleared", () => {
      setToolContext(makeContext());
      clearToolContext();
      expect(() => getToolContext()).toThrow("Tool context not set");
    });
  });

  describe("tryGetToolContext", () => {
    it("returns undefined when no context is set", () => {
      expect(tryGetToolContext()).toBeUndefined();
    });

    it("returns context when set", () => {
      const ctx = makeContext();
      setToolContext(ctx);
      expect(tryGetToolContext()).toBe(ctx);
    });

    it("returns undefined after clear", () => {
      setToolContext(makeContext());
      clearToolContext();
      expect(tryGetToolContext()).toBeUndefined();
    });
  });

  describe("clearToolContext", () => {
    it("is safe to call when no context is set", () => {
      expect(() => clearToolContext()).not.toThrow();
    });

    it("removes the stored context", () => {
      setToolContext(makeContext());
      clearToolContext();
      expect(tryGetToolContext()).toBeUndefined();
    });
  });

  describe("context properties", () => {
    it("preserves all fields", () => {
      const ctx = makeContext({
        agentId: "ag-uuid",
        issueId: "iss-uuid",
        parentIssueId: "parent-uuid",
        workspaceDir: "/projects/my-app",
        companyId: "co-uuid",
      });
      setToolContext(ctx);

      const retrieved = getToolContext();
      expect(retrieved.agentId).toBe("ag-uuid");
      expect(retrieved.issueId).toBe("iss-uuid");
      expect(retrieved.parentIssueId).toBe("parent-uuid");
      expect(retrieved.workspaceDir).toBe("/projects/my-app");
      expect(retrieved.companyId).toBe("co-uuid");
    });

    it("parentIssueId is optional", () => {
      const ctx = makeContext({ parentIssueId: undefined });
      setToolContext(ctx);
      expect(getToolContext().parentIssueId).toBeUndefined();
    });
  });
});
