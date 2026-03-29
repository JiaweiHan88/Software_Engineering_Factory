/**
 * Label Manager — ensures labels exist in Paperclip and caches IDs.
 *
 * Provides `ensureLabel()` which creates a label if it doesn't exist,
 * or returns the existing label's ID. Caches results in-memory to avoid
 * redundant API calls.
 *
 * @module adapter/label-manager
 */

import type { PaperclipClient } from "./paperclip-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Default Colors
// ─────────────────────────────────────────────────────────────────────────────

/** Default colors for BMAD label categories. */
export const LABEL_COLORS = {
  phase: "#3B82F6",
  epic: "#8B5CF6",
  type: "#10B981",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Label Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory label cache keyed by `companyId:name`.
 *
 * Stores the label UUID so repeated calls with the same name skip the API.
 * The cache stores Promises (not resolved values) to prevent duplicate
 * concurrent `POST /labels` calls for the same name.
 */
const labelCache = new Map<string, Promise<string>>();

/**
 * Clear the label cache. Primarily for testing.
 */
export function clearLabelCache(): void {
  labelCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// ensureLabel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a label exists in Paperclip and return its UUID.
 *
 * On first call for a given `(companyId, name)` pair:
 * 1. Fetches existing labels via `GET /api/companies/:companyId/labels`
 * 2. If found, caches and returns the ID
 * 3. Otherwise, creates via `POST /api/companies/:companyId/labels`
 *
 * Subsequent calls return the cached ID immediately.
 *
 * Concurrent-call safe: the Promise is cached before awaiting, so two
 * simultaneous calls for the same label share the same in-flight request.
 *
 * @param client - PaperclipClient instance (must have companyId set)
 * @param name - Label name (e.g., "phase:execute", "epic:BMA-2")
 * @param color - Hex color string (e.g., "#3B82F6")
 * @returns Label UUID
 */
export function ensureLabel(
  client: PaperclipClient,
  name: string,
  color: string,
): Promise<string> {
  const cacheKey = `${client.company}:${name}`;

  const existing = labelCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  // Cache the promise immediately to prevent duplicate concurrent requests
  const promise = resolveLabel(client, name, color);
  labelCache.set(cacheKey, promise);

  // If the promise rejects, remove from cache so a retry can succeed
  promise.catch(() => {
    labelCache.delete(cacheKey);
  });

  return promise;
}

/**
 * Internal: resolve a label ID — find existing or create new.
 */
async function resolveLabel(
  client: PaperclipClient,
  name: string,
  color: string,
): Promise<string> {
  // Check if label already exists
  const existing = await client.listLabels();
  const match = existing.find((l) => l.name === name);
  if (match) {
    return match.id;
  }

  // Create new label
  const created = await client.createLabel(name, color);
  return created.id;
}
