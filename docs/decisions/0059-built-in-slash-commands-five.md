# ADR-0059 — Five built-in slash commands (CLI surface)

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0024 (CLI export-gap closure + `src/apps/cli/internal.ts`), [[claude-desktop-1-7196-catalog]] §built-in-slash-5, [[surface-model]] memory, [[cc-v2-sota-absorption]] (Tier-2 absorption #2-1)

## Context

Claude Desktop 1.7196.3 ships five built-in slash commands wired at the surface
layer (no LLM call): `/context`, `/usage`, `/color`, `/navigate`, `/wait`.
quanta-v3 had `quanta session …` subcommands but no slash-command channel —
operators wanting "show me my token usage" had to inspect log files manually.

The 12-invariant `surface-model` rule ([[surface-model]] memory) requires
absorption ROI to be assessed on a surface-agnostic basis; quanta has no
REPL today, but a future Tauri / web surface will consume the SAME slash
registry, so the dispatch contract has to be surface-portable.

## Decision

### D1. Surface-agnostic dispatch registry

`src/apps/cli/slash-commands.ts` exports:
- `SlashContext` — writers + `cwd` + optional `now / sleep` (test seams) + optional `prefsPath` (preferences-file override).
- `SlashCommand` — `{ name, describe, run(args, ctx): Promise<number> }`. Run returns an exit code; a future surface decides how to surface it.
- `BUILTINS: readonly SlashCommand[]` — exactly five entries in documented order.
- `BUILTINS_BY_NAME: ReadonlyMap` — O(1) lookup.
- `isSlashCommand(s)` — accepts `/<letter>...` ONLY. `/path/to/file` returns false so legacy path-mode resume arguments fall through unchanged.
- `runSlashCommand(line, ctx)` — tokenize, dispatch, return exit code.

### D2. CLI early-gate

`src/apps/cli/index.ts` `main()` adds ONE block AFTER the `session` subcommand
route but BEFORE `--help` and LLM construction. The gate fires only when
`process.argv[2]` is a slash token. The dispatch is extracted into a small
helper (`runSlashMain`) so `main()`'s cognitive complexity stays inside the
biome budget.

### D3. Preferences persistence

`/color` and `/navigate` persist to `<home>/.quanta/preferences.json`
where `<home>` is `QUANTA_PREFS_HOME` (test seam) ?? `os.homedir()`. The file
is JSON with a `Preferences` schema (theme, preferredCwd). Reads are tolerant
(missing file ⇒ `{}`); writes `mkdir -p` the directory.

### D4. `/wait` cap

`/wait <seconds>` rejects negative, zero, NaN, and values above 3600 (1 hour).
`ctx.sleep` is injectable so tests can drive `/wait 0.1` synchronously.

## Consequences

**Positive**
- A surface-portable slash registry exists. The Tauri / web surface gets it for free.
- `BUILTINS` is data-driven — new commands land by appending an entry, not by editing dispatch.
- `isSlashCommand` precisely distinguishes slash from filesystem path, so legacy CLI invocations stay byte-identical.

**Trade-offs**
- `/context` and `/usage` are placeholders today (the loop does not yet export per-turn usage to a shared sink). The shape is correct; the data isn't wired. Documented in the command body.
- `console.warn` is NOT used; the slash layer is a leaf surface that owns its writers via `SlashContext.out` / `err`.

## Negative invariants

- `quanta /<word>` MUST short-circuit before any LLM / session plumbing fires. Tested via the CLI integration suite (not in this PR; structural via the early-gate placement).
- `quanta session …` and `quanta "<prompt>"` MUST remain byte-identical when no slash is on argv[2]. Verified by the gate condition.
- Slash dispatch MUST NOT invoke the LLM. The slice rule (`src/apps/cli/slash-commands.ts` imports `node:*` only) enforces this.

## Files touched

- `src/apps/cli/slash-commands.ts` — NEW.
- `src/apps/cli/index.ts` — early gate + `runSlashMain` helper.
- `biome.json` — added `tests/unit/slash-commands.test.ts` to the cli-internals allowlist.
- `tests/unit/slash-commands.test.ts` — NEW (19 cases incl. mkdir -p edge).
