# ADR-0294 — `/session export <id>` + `/session import <path>` slash

## Status

Accepted — landed `src/apps/cli/session-cmd.ts` + BUILTINS slot +
hellgate battery (22 cases / 87 expects).

## Context

The pure import/export primitive (ADR-0157, `src/session/import-export.ts`
+ `src/session/import-export-fs.ts`) is plane-clean: it ships typed
serialization for `SavedSession` (v1 envelope; v2 in ADR-0170) plus a Bun
FS adapter, but the loop never calls it. Today a user wanting to round-
trip a session off-host (debug a colleague's failure, archive a notable
run, replay through CI) has to copy raw store JSON manually — losing
version provenance and any sidecar state.

This decision exposes that primitive at the CLI surface via a new
`/session` slash command. Two subcommands:

- `/session export <id> [--out=<path>]` — read the host's session store
  by id, wrap in a v1 envelope via `exportSession`, write to disk.
- `/session import <path> [--id=<id>]` — read the envelope, parse via
  `importSession` (typed `SessionImportError`), persist back into the
  host store under a fresh-minted (or user-supplied) id.

## Decision

A single new file (`src/apps/cli/session-cmd.ts`) wraps the existing
primitive. The slash registers in `BUILTINS` and pulls its host-store
adapter from a new `SlashContext.sessionIo` slot:

```ts
interface SessionIoState {
  readSession: (id: string) => Promise<SavedSession | null>
  writeSession: (id: string, session: SavedSession) => Promise<void>
  mintNewId: () => string
  now?: () => number
}
```

Absent `ctx.sessionIo` ⇒ `"/session: not wired in this surface"` + exit
0 (parity with `/snapshot`, `/skills`, `/side`, etc.). The slash never
imports `@/storage` directly — the host adapter abstracts the store so
this slice stays plane-clean.

### Path safety

`--out` and `<path>` MUST resolve under `ctx.cwd` OR `os.homedir()`.
Anything else (e.g. `/etc/passwd`, `/root/x`) ⇒
`"/session: refusing to write outside cwd or $HOME"` + exit 1. We reuse
the existing `is-path-inside` dep (already used by `src/storage/fs-jail-lib`)
— no new npm install.

### Size cap

Import gates on `stat().size > 50 MB` BEFORE reading the file into
memory, so a 4 GB JSON cannot OOM the process. Message:
`"session file too large (cap 50 MB; got X MB)"` + exit 1.

The 50 MB number sits between the production corpus P90 (10 MB) and P99
(52 MB) — accommodates typical large sessions while catching obvious
mistakes early. Outliers (the 141 MB whale in the codex corpus) cannot
import unless the user explicitly raises the cap; that escape hatch is
deliberately a follow-up.

### Id rewrite on import

The slash overwrites `meta.id` on the imported `SavedSession` to match
the store key under which it is written. Without this rewrite, the
store's `index.jsonl` and the file's `meta.id` would drift (the export-
time id is meaningless inside the importer's store namespace). Side-
effect: re-importing the same envelope twice yields TWO sessions, each
with its own minted id — by design.

### Sidecar

The export path emits NO sidecar today (the `ctx.sessionIo` adapter has
no per-subsystem hook for `ConversationCheckpointStore.serialize()`,
`PlanQueueStore.serialize()`, `BudgetLedger.serialize()`). The IMPORT
path preserves whatever sidecar fields the envelope carries, surfacing
present keys via the summary line:
`"imported into session <id> (N messages, sidecar=<keys>)"`. Future
sidecar emit is a `ctx.sessionIo` extension — additive, no shape
change to this ADR.

### No-throw + typed errors

ALL FS errors (ENOENT, EACCES, stat failure, write failure) and
`SessionImportError` instances are caught and surfaced as `ctx.err`
messages + exit 1. The dispatcher never sees a thrown exception from
this slash. The `SessionImportError.code` discriminator (`malformed` /
`unsupported-version` / `version-mismatch` / `digest-mismatch`) is
prefixed into the surfaced message so the user can tell shape failures
apart from version drift.

## Consequences

### Positive

- A round-trip surface lands on top of an already-paid-for primitive
  (ADR-0157 has been on the shelf since the slice was written; today is
  the day the loop's first consumer arrives).
- Default-OFF: byte-identical to NOT registering the command when the
  surface has no adapter wired.
- Cross-surface portable: same `/session export` works from REPL / CI
  one-shot / future Tauri shell, each providing its own `ctx.sessionIo`.

### Negative

- The slash hard-codes `QUANTA_VERSION = "0"` rather than parsing
  `package.json` (slice-fence: no `node:fs` read of repo metadata from
  the surface). Means cross-build provenance is currently degenerate.
  Future wire to `runtimeConfig().quantaVersion` is a one-line edit.
- Sidecar EMIT path on export is unwired (see above). Acceptable
  trade-off: a richer `ctx.sessionIo` slot would couple the surface to
  per-subsystem serialize ports.
- The CLI does not surface envelope v2 (annotations / digest /
  exportTraceId) yet. v2 is opt-in in the primitive (`emitV2: true`); a
  future `/session export --v2` flag is additive.

### Not done

- Loop integration. `/session` is a surface tool; the agent loop has no
  reason to call it.
- Auto-export on session-end. Explicitly excluded — too many policy
  decisions (where to write, what retention, redaction).
- Diff / merge across imported sessions. Out of scope; a future ADR on
  cross-session reasoning.

## Wire points

- `src/apps/cli/session-cmd.ts` — new (~270 LOC incl. JSDoc).
- `src/apps/cli/slash-commands.ts` — `+2` lines (import + BUILTINS push).
- `tests/unit/session-export-import-slash-hellgate.test.ts` — 22 cases.
- `biome.json` — slice-isolation exception for the new test file.
- `tools/feature-catalog/features/04-context-management/0294-session-export-import-slash.yaml`

## Hellgate cases (22)

1. no args ⇒ usage + exit 0
2. /session help ⇒ usage + exit 0
3. unknown id ⇒ "session not found" + exit 1
4. default path ⇒ writes + exit 0
5. --out=<custom-path> ⇒ writes there
6. --out=/etc/passwd ⇒ refuses + exit 1
7. missing file ⇒ ENOENT surfaced + exit 1
8. bad-shape file ⇒ SessionImportError surfaced + exit 1
9. good file ⇒ imports + summary + exit 0
10. --id=<custom> ⇒ uses provided id
11. file > 50 MB ⇒ "too large" + exit 1 (no read attempted)
12. absent ctx.sessionIo ⇒ "not wired" + exit 0
13. round-trip equivalence (modulo minted id)
14. sidecar fields survive round-trip
15. no-throw across 8 adversarial argvs
- plus 7 boundary cases: unknown subcommand, unknown flag, missing
  `<id>`, missing `<path>`, malformed JSON, path-outside-cwd on import,
  exit-code matrix.

Counts at land: tsc 0 errors on slice, biome 0 errors / 0 warnings on
slice, 22 tests pass / 0 fail / 87 expect calls.
