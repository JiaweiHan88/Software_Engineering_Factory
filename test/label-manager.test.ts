/**
 * Label Manager — Unit Tests
 *
 * Tests ensureLabel() behavior: creation, caching, idempotency,
 * and concurrent-call safety.
 *
 * @module test/label-manager
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureLabel, clearLabelCache, LABEL_COLORS } from "../src/adapter/label-manager.js";
import type { PaperclipClient, PaperclipLabel } from "../src/adapter/paperclip-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock client factory
// ─────────────────────────────────────────────────────────────────────────────

function createMockClient(existingLabels: PaperclipLabel[] = []): PaperclipClient {
  let labelStore = [...existingLabels];
  let createCounter = 0;

  return {
    company: "test-company",
    listLabels: vi.fn(async () => [...labelStore]),
    createLabel: vi.fn(async (name: string, color: string) => {
      createCounter++;
      const label: PaperclipLabel = {
        id: `label-${createCounter}`,
        name,
        color,
      };
      labelStore.push(label);
      return label;
    }),
  } as unknown as PaperclipClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("label-manager", () => {
  beforeEach(() => {
    clearLabelCache();
  });

  describe("ensureLabel()", () => {
    it("creates a label when it does not exist", async () => {
      const client = createMockClient();

      const id = await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);

      expect(id).toBe("label-1");
      expect(client.listLabels).toHaveBeenCalledOnce();
      expect(client.createLabel).toHaveBeenCalledOnce();
      expect(client.createLabel).toHaveBeenCalledWith("phase:execute", "#3B82F6");
    });

    it("returns existing label ID without creating", async () => {
      const client = createMockClient([
        { id: "existing-uuid", name: "phase:execute", color: "#3B82F6" },
      ]);

      const id = await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);

      expect(id).toBe("existing-uuid");
      expect(client.listLabels).toHaveBeenCalledOnce();
      expect(client.createLabel).not.toHaveBeenCalled();
    });

    it("returns cached ID on second call (AC-5: idempotent)", async () => {
      const client = createMockClient();

      const id1 = await ensureLabel(client, "phase:review", LABEL_COLORS.phase);
      const id2 = await ensureLabel(client, "phase:review", LABEL_COLORS.phase);

      expect(id1).toBe(id2);
      // Only one listLabels + one createLabel call total
      expect(client.listLabels).toHaveBeenCalledOnce();
      expect(client.createLabel).toHaveBeenCalledOnce();
    });

    it("handles concurrent calls for the same label without duplicates", async () => {
      const client = createMockClient();

      // Fire two concurrent calls for the same label
      const [id1, id2] = await Promise.all([
        ensureLabel(client, "epic:BMA-1", LABEL_COLORS.epic),
        ensureLabel(client, "epic:BMA-1", LABEL_COLORS.epic),
      ]);

      expect(id1).toBe(id2);
      // Should only have made one API call, not two
      expect(client.createLabel).toHaveBeenCalledOnce();
    });

    it("creates different labels for different names", async () => {
      const client = createMockClient();

      const phaseId = await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);
      const epicId = await ensureLabel(client, "epic:BMA-2", LABEL_COLORS.epic);
      const typeId = await ensureLabel(client, "story", LABEL_COLORS.type);

      expect(phaseId).not.toBe(epicId);
      expect(epicId).not.toBe(typeId);
      expect(client.createLabel).toHaveBeenCalledTimes(3);
    });

    it("uses correct default colors for each category", () => {
      expect(LABEL_COLORS.phase).toBe("#3B82F6");
      expect(LABEL_COLORS.epic).toBe("#8B5CF6");
      expect(LABEL_COLORS.type).toBe("#10B981");
    });

    it("clears cache on clearLabelCache()", async () => {
      const client = createMockClient();

      await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);
      clearLabelCache();

      // After clear, should make API calls again
      await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);
      expect(client.listLabels).toHaveBeenCalledTimes(2);
    });

    it("removes from cache on error so retry can succeed", async () => {
      const client = createMockClient();
      // Make first listLabels call fail
      (client.listLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

      await expect(ensureLabel(client, "phase:execute", LABEL_COLORS.phase)).rejects.toThrow("Network error");

      // After failure, cache entry should be removed — retry should work
      (client.listLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const id = await ensureLabel(client, "phase:execute", LABEL_COLORS.phase);
      expect(id).toBe("label-1");
    });
  });

  describe("PaperclipIssue interface", () => {
    it("uses labelIds (not labels) in type definition", async () => {
      // Type-level assertion: import the interface and verify the field exists
      const { PaperclipClient } = await import("../src/adapter/paperclip-client.js");
      const client = new PaperclipClient({
        baseUrl: "http://localhost:3100",
        companyId: "test",
      });

      // Verify createIssue accepts labelIds
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "issue-1", title: "Test", description: "Test", status: "backlog" }),
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      await client.createIssue({
        title: "Test Issue",
        description: "Test desc",
        status: "backlog",
        labelIds: ["label-uuid-1", "label-uuid-2"],
      });

      // Verify labelIds was sent in the request body
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.labelIds).toEqual(["label-uuid-1", "label-uuid-2"]);

      vi.restoreAllMocks();
    });
  });
});
