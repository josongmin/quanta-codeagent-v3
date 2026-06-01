# ADR-0430: Competitor-import persistence (real session import + MCP/hooks/rules + dedup)

- Status: Accepted
- Date: 2026-06-02
- Supersedes the translate-only posture of ADR-0038 (external-agent import)

## Context

ADR-0038 shipped the external-agent import slice (`src/migration/`), wired via
`src/apps/cli/repl.ts` → `session import <claude_code|cursor|aider>`. But it was
PROVE-only:

- It DETECTED sessions + skills and reported `persisted_sessions=0` — translated
  transcripts were thrown away, never persisted, never resumable.
- It covered only sessions + a skill COUNT — no MCP server config, no hooks, no
  repo rules.
- `src/migration/dedup.ts` exposed only `contentSha256` and deliberately did NOT
  expose a per-item dedup query, so a re-import re-did all work.

Competitor reference: Codex `external-agent-import` covers sessions + MCP +
skills + plugins + hooks + rules with content-hash dedup; Cursor reads
`.claude-plugin/plugin.json` + `~/.claude/plugins`.

## Decision

Make competitor import REAL, opt-in via the existing `session import` CLI path.

1. **Persist translated sessions.** The migration slice now carries the
   translated payload back (`ImportResult.sessions: TranslatedSession[]` with
   `{ sourcePath, contentHash, messages }`). The CLI surface adapter
   (`src/apps/cli/session-import-handler.ts`) persists each one via
   `saveSessionById` into the v3 session store, so an imported transcript
   becomes a real, listable, resumable quanta session (`import-<provider>-<hash>`
   id). The summary row now reports `persisted_sessions=N`.

2. **MCP + hooks + rules translation.** A new pure translator
   (`src/migration/translators/claude-code-config.ts`) reads the kinds quanta
   models:
   - MCP: `<root>/.mcp.json#mcpServers` → `{ name, transport, command?, args? }`.
     `env` is dropped (never carry secrets). http/sse are reported with their
     transport so the caller can skip what quanta does not model.
   - Hooks: `<root>/settings.json#hooks` → `{ event, matcher?, commands[] }`.
   - Rules: `CLAUDE.md` memory files → `{ sourcePath, contentHash, text }`.
   `runImport` populates `ImportResult.{mcpServers,hooks,rules}`.

3. **Content-hash dedup.** The import log entry gained `{ itemKind, contentHash }`.
   `wasAlreadyImported(log, kind, hash)` is now exported; the CLI persists a
   per-session dedup row after each persist, so a second import skips
   already-imported sessions (and duplicate transcripts within one run).

4. **N10 credential-read ban (HARD invariant).** The importer reads transcripts /
   configs / rules off a competitor install — but MUST NEVER read a credential
   file (`auth.json`). Detection uses `access(2)` existence checks only. Every
   byte-read in the slice routes through `readImportFile`, which throws
   `CredentialReadBannedError` for a banned basename (`auth.json`,
   `credentials.json`, `.credentials.json`) BEFORE any read syscall. Asserted in
   tests.

### Slice geometry

`@/migration` may import only `@/shared` + `@/llm` (it CANNOT import `@/session` —
ADR-0038 fence). So the slice TRANSLATES (pure) and the CLI surface
(`src/apps/cli`, which is allowed to import `@/session`) PERSISTS. The handler
factory grew an optional `SessionRootProvider` injection seam
(`createCliImportHandlerWithRoot`) so tests target a tmp session root without
mutating global runtime config. Production `createCliImportHandler()` is
unchanged (no provider → default `~/.quanta/sessions`).

## Opt-in / byte-identical

The `session import` path stays opt-in (a user must run the command). Absent the
command, nothing changes — no new on-disk artifacts, byte-identical behavior.
Provider stub translators (cursor/aider) still return `[]`; only `claude_code`
config translation is implemented (others are a documented follow-up).

## What we deliberately skip

- Plugins (`.claude-plugin/plugin.json`, `~/.claude/plugins`): quanta has no
  1:1 plugin-install equivalent yet — follow-up.
- MCP `env` / credentials: never carried (N10 spirit).
- cursor/aider MCP/hooks/rules: stubbed until their on-disk formats are absorbed.

## Tests (TDD-first)

- `tests/unit/migration-import-persistence-e2e-hellgate.test.ts` (8 cases):
  sessions persisted + resumable; MCP detected+translated; hooks+rules; second
  import dedups; N10 credential-read refused (guard + full-import sentinel-secret
  never surfaced); malformed jsonl skipped not crashed; absent source ⇒ no-op
  byte-identical (store untouched).
- `tests/unit/migration-config-translators.test.ts` (15 cases): MCP/hooks/rules
  defensive contract + `wasAlreadyImported` soundness.
- Updated stale assertions in `tests/unit/cli-session-commands.test.ts`,
  `tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts`,
  `tests/integration/migration-claude-code-fixture.test.ts`,
  `tests/unit/migration-persistence.test.ts` (the prior "no dedup query exported"
  invariant is reversed by this ADR).
