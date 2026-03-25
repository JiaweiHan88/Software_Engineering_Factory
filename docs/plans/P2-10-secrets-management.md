# P2-10 — Secrets Management

> **Date:** 2026-03-25
> **Priority:** P2 — Valuable
> **Effort:** Small (<1h)
> **Status:** Planned

## Summary

Add secrets CRUD to `PaperclipClient` and migrate the setup script to store sensitive keys as Paperclip secrets with `secret_ref` in adapter configs instead of inline plaintext env vars.

## Steps

### Phase A: Client & Types

1. Create `src/types/secrets.ts` with:
   - `CompanySecret` (id, name, provider, latestVersion, createdAt)
   - `CreateSecretPayload` (name, value, description?)
   - `RotateSecretPayload` (value)

2. Add 4 methods to `src/adapter/paperclip-client.ts`:
   - `listSecrets()` → `GET /companies/{companyId}/secrets`
   - `createSecret(payload)` → `POST /companies/{companyId}/secrets`
   - `rotateSecret(secretId, payload)` → `POST /secrets/{secretId}/rotate`
   - `deleteSecret(secretId)` → `DELETE /secrets/{secretId}`

### Phase B: Setup Migration (depends on A)

3. In `scripts/setup-paperclip-company.ts`, after company creation:
   - Call `listSecrets()` to check for existing secrets (idempotency guard)
   - Call `createSecret()` for each sensitive key:
     - `COPILOT_API_KEY` (or equivalent Copilot SDK auth)
     - `GITHUB_TOKEN` (if used)
     - Any other secrets currently in plaintext env
   - Update agent adapter config `env` block to use `secret_ref`:
     ```typescript
     env: {
       COPILOT_API_KEY: { type: "secret_ref", secretId: "<uuid>", version: "latest" },
       OTEL_ENABLED: { type: "plain", value: "true" }  // non-sensitive stays plain
     }
     ```

4. Add `--rotate-secrets` flag to rotate existing secrets on re-run.

## Relevant Files

| File | Change |
|------|--------|
| `src/adapter/paperclip-client.ts` | Add 4 methods following existing patterns |
| `src/types/secrets.ts` | New file — secret type definitions |
| `scripts/setup-paperclip-company.ts` | Refactor adapter config env injection (~L140, L591-668) |

**No changes to `src/heartbeat-entrypoint.ts`** — Paperclip's process adapter resolves `secret_ref` transparently at runtime (decrypts and injects into subprocess env vars).

## Paperclip API Reference

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/companies/{companyId}/secrets` | List all secrets |
| GET | `/api/companies/{companyId}/secret-providers` | List available providers |
| POST | `/api/companies/{companyId}/secrets` | Create secret |
| POST | `/api/secrets/{id}/rotate` | Rotate to new version |
| PATCH | `/api/secrets/{id}` | Update metadata (name/description) |
| DELETE | `/api/secrets/{id}` | Remove secret and all versions |

### How `secret_ref` Works

1. Adapter config declares env bindings as objects:
   ```json
   {
     "env": {
       "API_KEY": { "type": "secret_ref", "secretId": "uuid", "version": "latest" },
       "DEBUG": { "type": "plain", "value": "false" }
     }
   }
   ```
2. At heartbeat execution time, `secretsSvc.resolveAdapterConfigForRuntime()` decrypts all refs
3. Process adapter receives resolved config with plaintext values
4. Subprocess gets env vars injected normally — agent code unchanged

### Security

- AES-256-GCM authenticated encryption (local provider)
- Master key from `PAPERCLIP_SECRETS_MASTER_KEY` env or auto-created at `data/secrets/master.key`
- Company-scoped access enforcement
- SHA256 hashing of plaintext for audit
- Version immutability (rotate to new version, old versions preserved)
- Actor tracking (who created/rotated each version)

## Verification

1. `pnpm typecheck` passes
2. Unit test: mock secrets CRUD methods
3. Integration: create secret → create agent with `secret_ref` in env → invoke heartbeat → verify subprocess receives decrypted value
4. Verify `--reset` setup flow handles existing secrets (no duplicate creation errors)

## Decisions

- Secrets API is board-only; agents consume transparently via process adapter env injection
- Provider: `local_encrypted` (Paperclip default AES-256-GCM) — no external providers initially
- Secret naming convention: `BMAD_{KEY_NAME}` (e.g., `BMAD_COPILOT_API_KEY`)
- Only setup script creates secrets — no runtime secret management needed
