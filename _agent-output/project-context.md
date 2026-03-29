---
project_name: 'BMAD_Copilot_RT'
user_name: 'Jay'
date: '2026-03-26T20:29:48.180Z'
sections_completed:
  ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
status: 'complete'
rule_count: 42
optimized_for_llm: true
---

# Project Context for AI Agents

_Critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 20.0.0 |
| Language | TypeScript | ^5.7.0 |
| Module System | ESM (`"type": "module"`) | — |
| AI SDK | `@github/copilot-sdk` | ^0.1.32 (Technical Preview) |
| MCP | `@modelcontextprotocol/sdk` | ^1.27.1 |
| Schema Validation | `zod` | ^4.3.6 |
| Config/Env | `dotenv` | ^17.3.1 |
| YAML parsing | `js-yaml` | ^4.1.1 |
| TS Execution (dev) | `tsx` | ^4.0.0 |
| Testing | `vitest` | ^3.0.0 |
| Observability | OpenTelemetry (OTLP) | ^1.30.0 |
| Linting | ESLint + typescript-eslint | ^9.0.0 / ^8.57.1 |
| Orchestration | Paperclip | `http://localhost:3100` |

---

## Critical Implementation Rules

### Language-Specific Rules

- **ESM `.js` extensions are mandatory.** Import `.ts` source files using `.js` extension in all `import` statements (e.g., `import { foo } from './foo.js'`). The TypeScript compiler resolves these correctly with `moduleResolution: bundler`.
- **`import type` for all type-only imports.** ESLint rule `@typescript-eslint/consistent-type-imports` is set to `error`. Use `import type { Foo }` whenever the import is only used as a type.
- **No `any` without justification.** `@typescript-eslint/no-explicit-any` is set to `warn`. Add an inline comment explaining why `any` is needed when unavoidable.
- **`prefer-const` everywhere.** Never use `let` when the variable is not reassigned.
- **Strict `===` equality.** `eqeqeq: ["error", "always"]` — never use `==`.
- **Unused variables must use `_` prefix.** Unused args/vars with `_` prefix are ignored; all others are errors.
- **TypeScript target is ES2022** — use native optional chaining, nullish coalescing, `Array.at()`, etc.
- **All exported functions/types must have JSDoc.** Include `@module` tag in each file's module-level doc comment, and `@param`/`@returns` on functions.
- **Path aliases are available** — prefer `@agents/*`, `@tools/*`, `@adapter/*`, `@config/*`, `@mcp/*` over deep relative imports. Aliases are configured in both `tsconfig.json` and `vitest.config.ts`.

### Framework-Specific Rules (Copilot SDK)

- **Always use `defineTool()` from `@github/copilot-sdk`** to define tools — never create raw tool objects. Import via `src/tools/types.ts` re-export: `import { defineTool } from './types.js'`.
- **Tool parameters must use Zod schemas** — use `z.object({...})` for all `parameters` fields. All fields should have `.describe()` for agent comprehension.
- **Agent personas implement `BmadAgent` interface** from `src/agents/types.ts`. Do not add fields beyond `name`, `displayName`, `description`, `prompt`.
- **Tool context is optional** — access with `tryGetToolContext()`, never `getToolContext()`. Tools must work even without context set.
- **Session creation via `SessionManager`** — never instantiate `CopilotClient` directly in tools or agents. Use `SessionManager.createSession()`.
- **`loadConfig()` for all configuration** — never read `process.env` directly in business logic. Call `loadConfig()` from `src/config/config.ts`.
- **`buildClientEnv(config)` for GHE environments** — pass the result to `CopilotClient` constructor when GHE host is configured.
- **Agent files are auto-generated** from `bmad_res/bmm/agents/` via `scripts/convert-bmad-agents.ts`. Never edit `src/agents/*.ts` manually for persona prompts; edit the source YAML instead.

### Paperclip Integration Rules

- **Always include `X-Paperclip-Run-Id` header on all mutating API calls** (POST/PATCH/PUT/DELETE). Omitting it violates audit trail requirements.
- **API prefix is `/api` — no version prefix.** Correct: `POST /api/issues/:id/comments`. Wrong: `POST /v1/issues/:id/comments`.
- **Use `companyId`, not `orgId`.** The data model is company-scoped. The field is `companyId` everywhere.
- **Issues, not tickets.** The entity is `PaperclipIssue`. All variables, types, and comments should say "issue" not "ticket".
- **Report results via issue comments** — `POST /api/issues/:id/comments`. There is no `/reports` endpoint.
- **Never retry a 409 checkout conflict.** A 409 means another agent owns the issue. Log and exit.
- **Checkout before working** — `POST /api/issues/{id}/checkout` must be called before modifying any issue.
- **Agent status values:** `active | paused | terminated | idle`. There is no `working`, `stalled`, or `offline` status.
- **Issue identifiers are human-readable** (e.g., `BMA-3`) and live in `issue.identifier`. The `id` field is a UUID. When referencing issues in markdown output, use `[BMA-3](/issues/BMA-3)` format.

### Testing Rules

- **Test files live in `test/`** — NOT colocated with source. Pattern: `test/**/*.test.ts`.
- **Vitest globals are enabled** — `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi` are available without imports.
- **Path aliases work in tests** — `@agents/*`, `@tools/*`, etc. are resolved via `vitest.config.ts`.
- **Test timeout is 10,000ms** — mock external calls; never make real HTTP requests in unit tests.
- **Mock Paperclip client and Copilot SDK** — use `vi.mock()` or `vi.spyOn()`. Tests must not require a running Paperclip server.
- **Coverage provider is v8** — run `vitest run --coverage` to check. `src/sandbox/**` is excluded from coverage.
- **Test file naming convention:** `<module-name>.test.ts` mirroring the source filename.

### Code Quality & Style Rules

- **File naming is kebab-case.** Both source files and test files use kebab-case (e.g., `heartbeat-handler.ts`, `session-manager.test.ts`). Never PascalCase for filenames.
- **Class names are PascalCase** (e.g., `SessionManager`, `AgentDispatcher`). **Functions and variables are camelCase.** **Constants are SCREAMING_SNAKE_CASE** when they are truly constant module-level values.
- **Logger pattern — not `console.log`.** Use `Logger.child('module-name')` from `src/observability/logger.ts`. Create a module-level `const log = Logger.child('...')` and use `log.info()`, `log.warn()`, `log.error()`. `console.log` is only permitted in CLI entry points and sandbox scripts.
- **All async operations must have error boundaries.** Wrap in try/catch; never let Promise rejections propagate silently.
- **`src/sandbox/` is for exploration only** — code here is not covered by tests and not part of the build. Do not import sandbox code from other modules.
- **No circular imports** — adapter → agents/tools/config; never the reverse. Quality-gates only imports from observability and config.

### Development Workflow Rules

- **Commit messages must include Co-authored-by trailer:**
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```
- **`pnpm` is the package manager** — never use `npm install`. Lock file is `pnpm-lock.yaml`.
- **Build with `pnpm build`** (`tsc`), output to `dist/`. **Lint with `pnpm lint`** (`eslint src/`). **Type-check with `pnpm typecheck`** (`tsc --noEmit`).
- **Run Paperclip locally with `pnpm paperclip:start`** before integration testing. Use `pnpm paperclip:setup` to seed the company structure.
- **`TARGET_PROJECT_ROOT` / `PAPERCLIP_WORKSPACE_CWD`** — set these env vars to the target workspace so agents don't explore the factory source files.
- **BMAD story lifecycle:** `backlog → ready-for-dev → in-progress → review → done`. Use `lifecycle.ts` functions (`completePhase`, `passReview`, `failReview`, `escalateReview`) to transition states; never update issue status directly.

### Critical Don't-Miss Rules

- **DO NOT use `sprint-status.yaml` for state tracking.** It is deprecated. Use Paperclip issues and `issue_status` tool via the Paperclip API.
- **Quality gate severity levels are:** `LOW | MEDIUM | HIGH | CRITICAL`. Only `HIGH` and `CRITICAL` block merge. Maximum 3 review passes — escalate to CEO after that.
- **`defineTool()` second argument is an object with `description`, `parameters`, `handler`** — not a function. Check SDK docs if unsure.
- **Zod v4 syntax** — `zod` ^4.3.6 is installed. Use `z.object`, `z.string`, `z.enum`, etc. Some v3 patterns changed (e.g., `z.ZodError` → `z.ZodError`, but `.parse()` throws directly).
- **`moduleResolution: bundler`** — wildcard path imports (e.g., `import * as mod from './module'`) may not resolve correctly; prefer named imports.
- **OpenTelemetry is opt-in via `OTEL_ENABLED=true`.** Do not add unconditional OTel instrumentation — always check the config flag.
- **Stall detector is configured via env** — `STALL_CHECK_INTERVAL_MS` and `STALL_AUTO_ESCALATE`. Do not hardcode stall thresholds.
- **`approveAll` from Copilot SDK** must be passed as the tool approval callback in session configs — agents run autonomously and should not pause for tool approval.

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code in this project.
- Follow ALL rules exactly as documented.
- When in doubt, prefer the more restrictive option.
- Use `Logger.child()` not `console.log` in all `src/` code.
- Always add `.js` extensions to relative imports from `.ts` files.
- Update this file if new patterns emerge that would catch future agents off guard.

**For Humans:**
- Keep this file lean and focused on agent needs.
- Update when the technology stack changes (especially SDK version bumps).
- Review after major architectural changes.
- Remove rules that become obvious over time.

_Last Updated: 2026-03-26_
