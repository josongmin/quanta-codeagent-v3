# CODE-AUDIT-3 — Sec 08/09/10 source code-quality findings

Scope: 376 src/*.ts files referenced by yamls under `tools/feature-catalog/features/{08-observability,09-integration,09-security,10-app}/*`. Method: literal grep / line-cite only — NO heuristics. Excludes `tests/**`, `tools/**`, generated.

## Severity tally

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 4 |
| Informational (clean signals) | 6 |

## Findings

### Medium

**M1 — `process.env.*` reads scattered across 14 files outside `runtime-config.ts`.**
60+ distinct env var names accessed across `src/apps/bench/index.ts:10`, `src/apps/bench/eval/driver.ts:8`, `src/apps/cli/internal.ts:41`, `src/apps/cli/diff-preview.ts:56-64`, `src/apps/cli/mcp-cmd.ts:112`, `src/apps/cli/repl.ts:179`, `src/apps/cli/repl.ts:778`, `src/observability/metrics/health-snapshot.ts:107`, `src/storage/shadow-odb/default.ts:109`, `src/ui/ui-helpers.ts:58-62`, `src/mcp/client.ts:77`. `src/shared/runtime-config.ts` declares itself "single owner of env" yet ~50 `QUANTA_*` vars are read elsewhere. `src/apps/agent/index.ts:9` even has an explicit invariant comment ("NO scattered process.env.X reads here") — and `internal.ts`/`bench/*` violate that. Risk: validation drift (silent garbage acceptance per `runtime-config.ts:7`).

**M2 — `src/apps/bench/eval/exec.ts:26,55` spawns `bash -c <cmd>` with caller-supplied `cmd`.**
Two `Bun.spawn(["bash", "-c", cmd], …)` sites. Comment at `exec.ts:4` claims children inherit the parent's sandbox, but the string concat through `bash -c` re-opens a shell-injection surface that the corpus-loader (`dataset.ts:52`) and python-swebench (`python-swebench.ts:55`) deliberately avoid (latter uses argv-array form). If `cmd` ever flows from instance data, an unquoted special char escalates. Adjacent code (`src/git/cloud-branch-snapshot.ts:24`) explicitly documents the argv-only rule for the same threat model.

**M3 — `src/llm/adapters/chatgpt-oauth.ts:498,547` swallow JSON.parse errors in SSE stream with bare `continue` / `input = {}`.**
Two parses inside `parseSSE` discard malformed frames without surfacing structured diagnostics. Other adapters (`src/llm/adapters/anthropic.ts:336`, `src/llm/adapters/openai.ts:367`) route through `LLMError.fromSdkError` with provider tag; ChatGPT-OAuth path is silently lossy. A corrupt frame becomes invisible — no metric, no log — versus anthropic/openai parity.

### Low

**L1 — `src/apps/eval/index.ts` has 25+ `console.log`/`console.error` calls (lines 91-343).**
This is a top-level CLI subcommand entrypoint so direct console is plausible, but other CLI entrypoints (`src/apps/cli/index.ts`, `src/apps/bench/index.ts`) route through structured logger sinks. `eval/index.ts` mixes raw markdown-to-stdout with diagnostics-to-stderr without explicit sink injection — testability friction.

**L2 — `src/apps/bench/index.ts` has 12 `process.exit(...)` call sites (lines 336-620).**
Other subcommand mains parameterize exit via `deps.exit ?? ((c) => process.exit(c))` (`src/apps/agent/index.ts:211`). Bench has hardcoded `process.exit(0/1)` inlined — blocks programmatic re-entry / harness reuse.

**L3 — `src/observability/work-metrics.ts:13` / `src/agent/session-resources.ts:157` / `src/agent/admissibility-gate.ts:88` carry `TODO(absorb #N)` seams.**
Three TODOs are explicitly "feature-flagged off until later wiring." Not a defect, but the catalog yamls reference these files as feature code — partial-implementation status should be visible in catalog notes.

**L4 — `src/ipc/transports/websocket.ts:103` `createWebSocketServerTransport` throws skeleton-only.**
Throws `"websocket server transport: skeleton-only in this PR"`. Yaml catalog references this file as integration surface. Comment says "intentionally throws so a caller that wires this prematurely fails loud" — fine, but catalog status should reflect not-shipped.

### Informational (clean — no defect; documented for thoroughness)

- I1 — Zero `as any` / `@ts-ignore` / `@ts-expect-error` in the 376-file scope. Only matches are in comments (e.g. `src/observability/attrs.ts:13,120` documenting `as any` defenses).
- I2 — Zero empty `catch {}` blocks. The only file naming it is `src/apps/cli/repl-silent-catch.ts:5` which is a deliberate, named seam.
- I3 — All `Bun.spawn` MCP/plugin/LSP sites pair with `stop()`/`kill()`/`stopped` idempotency (`src/mcp/client.ts:156-174`, `src/plugin-isolation/lifecycle.ts:135-183`).
- I4 — `JSON.parse` callsites (40+) all wrap in try/catch with explicit fallback or `LLMError`/`McpError` mapping. `src/ipc/transports/stdio.ts:54`, `src/ipc/transports/websocket.ts:53`, `src/lsp/adapters/jsonrpc.ts:165`, `src/apps/probe/parse.ts:79,131`, `src/auth/chatgpt-oauth/token-store.ts:48`, `src/auth/lock-file-based.ts:57` all clean.
- I5 — Token file write uses `chmod 0o600` after atomic rename (`src/auth/chatgpt-oauth/token-store.ts:79`).
- I6 — Logger documents centralized env-validation contract at `src/observability/logger.ts:5-9` and stderr-only invariant.

## Top 5 critical-priority items (sorted)

1. **M1** — env-read drift across 14 files (mass config-source pollution; the invariant in `apps/agent/index.ts:9` is locally enforced but globally violated).
2. **M2** — two `bash -c <cmd>` spawn sites in bench eval exec (shell injection if `cmd` becomes attacker-influenced).
3. **M3** — silent JSON.parse swallow in ChatGPT-OAuth SSE parser (lossy vs anthropic/openai parity).
4. **L2** — hardcoded `process.exit` in bench mains (12 sites) breaks harness reuse.
5. **L4** — `createWebSocketServerTransport` throw-skeleton — catalog should mark as not-shipped.

## Method notes

- Source list: 436 yaml-referenced paths → 376 `.ts` after excluding `tests/`, `tools/`, `.test.ts`, non-ts.
- Signal grep: `as any` / `@ts-*` / `TODO|FIXME|HACK|XXX` / `console.(log|error|warn)` (outside CLI/logger/sink) / empty `catch {}` / `process.env.*` (outside `runtime-config`) / `Math.random` / `setTimeout|setInterval` / `Bun.spawn` / `JSON.parse` / `process.exit` / `.catch(` / `void` Promises / `fetch(` / `throw new Error` (in IPC/LLM/MCP).
- Each finding cites file:line. No severity assigned by guess — only where literal pattern + adjacent invariant comment contradict (e.g. `agent/index.ts:9` vs `internal.ts:41`).
