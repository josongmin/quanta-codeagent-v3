# ADR-0305: CLI-05 — Remove `session-commands.ts` shim, wire two adapters at call site

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0038 (`@/runner` slice isolation forbids `@/migration`), RFC may-22 unified-agent-runtime §3 (surface decomposition)

## Context

`src/apps/cli/session-commands.ts` was the Phase-3 shim introduced when the
`session` subcommand dispatcher moved into the surface-agnostic
`@/runner/session-ops` slice (RFC may-22). The shim wrapped
`runSessionCommand` from `@/runner/session-ops` with two CLI-specific
injections so existing callers (`repl.ts`, the unit + integration test
suites) kept working unchanged:

1. `cliImportHandler` — the migration translator. `@/runner/session-ops`
   is forbidden from importing `@/migration` (biome rule per ADR-0038), so
   the CLI surface had to inject the handler through
   `SessionCommandDeps#importHandler`.
2. `resolveCliListEnv()` — the rich-TUI default-format resolver. The
   runner slice never reads `process.env` / `process.stdout.isTTY`; the
   CLI surface resolves those signals into `SessionCommandDeps#listEnv`.

The shim served its purpose during the move. Keeping it longer hides the
real wiring at the call site, costs ~164 LOC of indirection, and presents
two source-of-truth points for the same `SessionCommandDeps` shape (the
re-exported types vs. the runner's authoritative types).

## Decision

Delete the shim. Extract the two injections into single-purpose surface
adapters, and wire them at the one CLI call site (`repl.ts::runSessionMain`)
plus the four test files that previously relied on the shim's defaults.

### Slice geometry

```
@/runner/session-ops               ← Layer 2 surface-agnostic dispatcher
   ├─ runSessionCommand(args, deps)   (already exported)
   ├─ SessionCommandDeps              (already exported — SSOT)
   └─ SessionListEnv                  (already exported)

src/apps/cli/session-import-handler.ts   ← NEW surface adapter (110 LOC)
   └─ createCliImportHandler(): ImportHandlerFn
        (verbatim move of cliImportHandler + IMPORT_PROVIDERS + hasFlag/errLine)

src/apps/cli/session-list-env.ts         ← NEW surface adapter (45 LOC)
   └─ resolveCliSessionListEnv(): SessionListEnv | undefined
        (verbatim move of resolveCliListEnv)

src/apps/cli/repl.ts::runSessionMain     ← CALL SITE — explicit wiring
   await runSessionCommandInner(argv, {
     out, err, confirm,
     importHandler: createCliImportHandler(),
     ...(listEnv !== undefined ? { listEnv } : {}),
   })
```

### What changes at call sites

Previously:

```ts
import { runSessionCommand } from "./session-commands"
await runSessionCommand(argv, { out, err, confirm })
// shim auto-injected importHandler + listEnv
```

Now:

```ts
import { runSessionCommand as runSessionCommandInner } from "@/runner/session-ops"
import { createCliImportHandler } from "./session-import-handler"
import { resolveCliSessionListEnv } from "./session-list-env"

const listEnv = resolveCliSessionListEnv()
await runSessionCommandInner(argv, {
  out, err, confirm,
  importHandler: createCliImportHandler(),
  ...(listEnv !== undefined ? { listEnv } : {}),
})
```

The two-line cost is acceptable — surfaces should EXPLICITLY wire their
adapters; hidden defaults are a smell when the slice has two distinct
surface concerns.

## Invariants

- **Byte-identical default-OFF** — `session ls` and `session import`
  produce identical bytes before and after the change (verified by the
  existing test suites which keep their assertions unchanged).
- **No re-export shim** — the file `src/apps/cli/session-commands.ts` is
  DELETED. Re-introducing it would be a regression; the hellgate suite
  (HELL-01) fails if it ever reappears.
- **No dead import path** — no `src/**` file imports
  `./session-commands` or `@/apps/cli/session-commands` (HELL-04).
- **Runner slice untouched** — `@/runner/session-ops/index.ts` was not
  modified. The two stale doc comments referencing
  `apps/cli/session-commands.ts` inside that file are intentional
  historical context (kept to satisfy the "do not touch runner slice"
  ticket constraint); the audit rule was updated to point at
  `@/runner/session-ops` instead.
- **Factory typing fence** — `createCliImportHandler()` returns the
  concrete callable type (not `SessionCommandDeps["importHandler"]`),
  because the runner's optional alias resolves to `… | undefined` under
  `exactOptionalPropertyTypes: true`. Callers assign without
  `| undefined` leakage.

## Consequences

Positive:
- Two clean single-purpose adapters replace one 164-LOC multi-purpose
  shim. Both are easier to find, read, and test.
- The call site at `repl.ts::runSessionMain` now reads as the
  canonical "how a surface wires `SessionCommandDeps`" example — a
  future `apps/web` or `apps/tauri` surface follows the same shape.
- One source-of-truth for `SessionCommandDeps` (the runner slice);
  the shim's re-export is gone.

Trade-offs:
- Test files now wire `importHandler: createCliImportHandler()` +
  `listEnv` explicitly in their `captureDeps` helpers (one-line edit
  per file × 4 files). This makes the test fixture honest about what
  the runner actually requires.
- Two stale historical doc comments in `@/runner/session-ops/index.ts`
  mention the now-deleted file path. They are NOT updated by this ADR
  because the ticket explicitly forbids modifying the runner slice;
  the next ticket that legitimately touches that file should refresh
  them.

## Validation

22 hellgate cases under
`tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts`:

- HELL-01…03: file existence (shim absent, two new files present).
- HELL-04: source-grep proves no `src/**` TS file imports the dead path.
- HELL-05…09: source-grep proves `repl.ts` wires the runner + both
  adapters by NAME at the call site.
- HELL-10…15: `createCliImportHandler()` factory — callable, missing
  provider, unknown provider, unexpected extra arg, success summary,
  `--no-skills` parsing.
- HELL-16…22: `resolveCliSessionListEnv()` — TTY=true→rich, TTY=false
  →plain, env override plain wins over TTY=true, env override rich
  wins over TTY=false, `QUANTA_SESSION_LIST_MAX` propagation, omitted
  `defaultMaxN` key under `exactOptionalPropertyTypes`, runtimeConfig
  snapshot semantics.

The existing functional contract is preserved by the four
already-existing test files (`tests/unit/cli-session-commands.test.ts`,
`tests/integration/session-ux-e2e.test.ts`,
`tests/integration/session-stress-and-concurrent.test.ts`,
`tests/integration/session-chaos-and-attack.test.ts`) — every assertion
is unchanged; only the import path + `captureDeps` helper bodies were
updated to construct deps with the explicit adapter injection.
