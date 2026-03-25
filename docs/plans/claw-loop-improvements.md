# Claw Loop Analysis — Potential Improvements for BMAD Copilot RT

**Date:** 2025-03-25
**Source:** Comparison of Claw Loop v2.3.1 (tmux/cron orchestrator for Claude Code) against BMAD Copilot RT (Paperclip push-model + Copilot SDK)

**Context:** The Claw Loop is a single-worker, cron-driven orchestrator that scrapes tmux output to drive Claude Code through BMAD stories. Our architecture is fundamentally more sophisticated (multi-agent, event-driven, SDK-native), but the Claw Loop has stronger operational resilience patterns worth adopting.

---

## HIGH VALUE

### 1. Smart-Skip / Expected-Duration Metadata

**Claw Loop pattern:** Different minimum wait per step type (create: 5min, dev: 10min, review: 8min). Skips full evaluation if step just started.

**Our gap:** Heartbeats have no awareness of expected step duration. An agent woken 30 seconds into a 60-minute dev-story wastes a heartbeat cycle.

**Where to implement:**
- Add `expectedDurationMs` to `PHASE_TRANSITIONS` in `src/adapter/lifecycle.ts`
- `src/heartbeat-entrypoint.ts` short-circuits with "still working" response if elapsed < minimum

---

### 2. Semantic Stall Fingerprinting

**Claw Loop pattern:** Hashes meaningful output lines (strips spinners/noise), detects identical output across 3+ cycles even if process is "alive."

**Our gap:** `src/observability/stall-detector.ts` only uses wall-clock thresholds. An agent in an infinite LLM retry loop won't be caught if within the time window.

**Where to implement:**
- Track last N meaningful lines from Copilot SDK streaming output
- If fingerprint unchanged across 3+ heartbeats AND time threshold exceeded → escalate
- Extend `stall-detector.ts` with output-change tracking

---

### 3. Tiered Stall Escalation (Graduated Recovery)

**Claw Loop pattern:** 4 tiers — soft nudge → context clear → hard restart → human escalation. Each tier has specific recovery actions.

**Our gap:** Binary stall detection (stalled or not) with optional auto-escalation. No graduated response.

**Where to implement:** Extend `src/observability/stall-detector.ts`:
- Tier 1: Re-send heartbeat with "status check" context
- Tier 2: Force new SDK session (clear context)
- Tier 3: Kill and restart agent process
- Tier 4: Pause + alert human via Paperclip comment

---

### 4. Per-Story Model Tier Overrides

**Claw Loop pattern:** `claw-loop-model-strategy.yaml` allows story-level granularity (e.g., story 1-3 → `highest` even if epic defaults to `standard`).

**Our gap:** `src/config/model-strategy.ts` classifies by phase + complexity heuristics but has no explicit per-story override path.

**Where to implement:**
- Add optional `modelTier` field to Paperclip issue metadata
- If set, override the computed tier in `model-strategy.ts`
- CEO or human can set during delegation

---

### 5. Daily Sprint Summary Roll-Up

**Claw Loop pattern:** Dedicated daily cron aggregating completed stories, stall counts, interventions, cumulative progress.

**Our gap:** Reporting is per-issue-comment only. No automated roll-up across the sprint.

**Where to implement:**
- Add a scheduled summary agent (or Paperclip cron) that queries company issues
- Aggregate metrics (stories done, stalls, review pass counts, cost)
- Post company-level summary comment

---

## MEDIUM VALUE

### 6. Watchdog for Orchestrator Health

**Claw Loop pattern:** Two-layer watchdog (heartbeat timestamp in state + external check). Auto-recreates cron if stale.

**Our gap:** Relies on Paperclip being healthy. No self-healing if Paperclip stops invoking heartbeats.

**Where:** Enhance `src/health.ts` to verify Paperclip connectivity + last successful heartbeat timestamp.

---

### 7. Immutable Rules Preamble

**Claw Loop pattern:** 12 "never violate" rules at TOP of every cron execution — ensures LLM never violates core invariants regardless of context pressure.

**Our gap:** Rules distributed across AGENTS.md, lifecycle.ts, copilot-instructions.md. No single authoritative "never violate these" block.

**Where:** Create `INVARIANTS.md` loaded into every agent persona. Key rules: never advance with failing tests, never skip quality gates, always report.

---

### 8. Explicit Artifact Path Passing

**Claw Loop pattern:** Always passes story file path as argument to slash commands to prevent "which story?" confusion.

**Our gap:** Context-driven prompts include issue description but may not always include explicit file paths for artifacts.

**Where:** Ensure `HeartbeatContext` in `src/adapter/heartbeat-handler.ts` always includes resolved artifact paths in prompt templates.

---

### 9. Sprint-Scoped Activity Log

**Claw Loop pattern:** Machine-parseable `EVENT | DETAILS` format — single append-only audit trail for the sprint.

**Our gap:** Structured JSON logging exists via logger, but no single sprint-level audit trail that's easy to query.

**Where:** Add a sprint-scoped log complementing OTel traces, useful for daily summaries and human debugging.

---

## NOT APPLICABLE

These Claw Loop patterns are workarounds for CLI/tmux limitations our architecture doesn't have:
- tmux pane scraping (we have SDK sessions)
- Cron-based polling (we have push model)
- Local JSON state file (we have Paperclip DB)
- Manual model strategy YAML generation (we have code-based classification)
- Fixed cron intervals (we're event-driven)
- `/clear` between steps (we create fresh SDK sessions per heartbeat)
