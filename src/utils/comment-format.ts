/**
 * Comment formatting utilities — Paperclip ticket-linking and URL helpers.
 *
 * Paperclip requires markdown links for all issue references (P2-6).
 * Plain ticket IDs like `PAP-123` must become `[PAP-123](/PAP/issues/PAP-123)`.
 *
 * All TS-generated comments pass through `linkifyTickets()` before being
 * posted. LLM-generated content is handled via the dispatch prompt reminder.
 *
 * @module utils/comment-format
 */

/**
 * Derive the company prefix from a Paperclip issue identifier.
 * e.g. "PAP-123" → "PAP", "ZED-24" → "ZED"
 */
export function derivePrefixFromId(issueId: string): string {
  const match = issueId.match(/^([A-Z][A-Z0-9]+)-\d+$/);
  return match ? match[1] : "";
}

/**
 * Build the company-prefixed URL for an issue.
 * e.g. ("PAP-123") → "/PAP/issues/PAP-123"
 */
export function issueUrl(issueId: string): string {
  const prefix = derivePrefixFromId(issueId);
  if (!prefix) return `/issues/${issueId}`;
  return `/${prefix}/issues/${issueId}`;
}

/**
 * Build the company-prefixed URL for an agent.
 * e.g. ("claudecoder", "PAP") → "/PAP/agents/claudecoder"
 */
export function agentUrl(agentUrlKey: string, prefix: string): string {
  if (!prefix) return `/agents/${agentUrlKey}`;
  return `/${prefix}/agents/${agentUrlKey}`;
}

/**
 * Build the company-prefixed URL for an approval.
 * e.g. ("abc123", "PAP") → "/PAP/approvals/abc123"
 */
export function approvalUrl(approvalId: string, prefix: string): string {
  if (!prefix) return `/approvals/${approvalId}`;
  return `/${prefix}/approvals/${approvalId}`;
}

/**
 * Replace bare Paperclip ticket identifiers with markdown links.
 *
 * Matches patterns like `PAP-123`, `ZED-24`, `BMAD-1` — uppercase prefix
 * followed by a hyphen and digits — that are NOT already inside a markdown
 * link (`[...](...)`).
 *
 * @param text - Raw comment text potentially containing bare ticket IDs
 * @returns Text with all bare ticket IDs wrapped as markdown links
 */
export function linkifyTickets(text: string): string {
  // Match PREFIX-N that is NOT already preceded by `[` (already linked)
  // and NOT inside a code span (`...`). Uses negative lookbehind.
  return text.replace(
    /(?<!\[)(?<!`[^`]*)([A-Z][A-Z0-9]+-\d+)(?![^`]*`)/g,
    (match, ticketId: string) => {
      const url = issueUrl(ticketId);
      return `[${ticketId}](${url})`;
    },
  );
}
