# ADR-0474 — Stale-read guard: block clobbering edits + post-bash re-read reminder

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF feature slice (`@/tool/stale-read-guard`).
**Scope:** new files under `src/tool/stale-read-guard/` (`types.ts`, `markers.ts`,
`state.ts`, `gate.ts`, `reminder.ts`, `index.ts`) + the hellgate
`tests/unit/stale-read-guard-hellgate.test.ts` + this ADR + the feature-catalog
yaml. NO shared files edited (the ToolContext field, read-tool mtime record,
write/edit pre-check, and post-bash diff hook are listed as integration TODOs
for the human to apply serially).
**Default-OFF:** `QUANTA_STALE_READ_GUARD` unset (or any value other than `"1"`)
⇒ the host never records read mtimes, never calls the write-time check, and never
runs the post-bash detector — zero behavior change, byte-identical to today.

## Context

Claude Code and Codex both ship a "stale read" safety: if the agent reads a file,
then the file is changed on disk by something outside the agent (a concurrent
process, a `git checkout`, a formatter the agent itself ran via bash), a
subsequent write/edit against the agent's *remembered* contents silently clobbers
the external change. The convention is to (1) BLOCK the write with a "re-read
first" message, and (2) after a build/format command that rewrites files,
proactively tell the model which previously-read files are now stale.

`@/tool` is a leaf-ish slice; the actual mtime lives in `@/storage`'s
`FileSystemPort`. Per the port-inversion discipline (ARCHITECTURE §1) the guard
does NOT import `@/storage` — the host (read tool / write tool / bash post-hook)
passes the real mtime in as a plain number. The guard is pure over injected
mtimes, exactly like `@/permission`'s `ClassifierPort` injection.

## Decision

Ship `src/tool/stale-read-guard/` importing **only** `@/shared`:

1. **`ReadFileState` (state.ts)** — `Map<path, mtimeMs>`; `record(path, mtimeMs)`
   at read time, `checkFresh(path, currentMtimeMs)` → `fresh | stale | unread`.
   Forward mtime move ⇒ stale; backward move (restore/clock-skew) ⇒ fresh; never
   read ⇒ unread (no baseline, cannot be stale). Strict `>` comparison — no
   tolerance window / magic epsilon.

2. **`guardWrite(state, path, currentMtimeMs)` (state.ts)** — `Result<void,
   StaleReadError>`. `err` on stale (the write/edit tool surfaces
   `STALE_WRITE_MESSAGE` and does NOT write); `ok` on fresh/unread.

3. **`staleAfterBash(state, command, changed[])` (state.ts)** — returns the read
   files now stale, but ONLY when BOTH (a) the command's leading token is a
   `WRITE_COMMAND_MARKERS` member AND (b) the file's mtime advanced past its
   recorded read-time mtime. A read-only command (`git status`, `ls`, `grep`)
   returns `[]` even if some unrelated process changed a file. Deterministically
   sorted.

4. **`WRITE_COMMAND_MARKERS` + `isWriteCommand` (markers.ts)** — a CLOSED,
   documented set of leading command tokens KNOWN to mutate the tree (package
   managers, build/task systems, formatters/linters with `--write`/`--fix`,
   codegen). NOT a guessed heuristic: each entry writes by its documented
   contract. The matcher skips leading env-assignments (`FOO=bar`) and `sudo`,
   reduces `./gradlew` / `dir/biome` to a basename, and only inspects the FIRST
   real token.

5. **`renderStaleReminder(stalePaths)` (reminder.ts)** — `""` for an empty list
   (byte-identical no-op), else a single `<system-reminder>` block listing the
   paths, funneled through `embedUntrusted` so a path carrying a forged
   `</system-reminder>` cannot break out.

6. **`staleReadGuardEnabled(env)` (gate.ts)** — strict `QUANTA_STALE_READ_GUARD
   === "1"` over the INJECTED env record (never `process.env`). The host checks
   this before constructing/calling any guard function.

## Negative invariants

1. Default-OFF: flag unset ⇒ no read mtimes recorded, no write-time check, no
   post-bash detection ⇒ byte-identical to today.
2. Unread file is NEVER stale (a brand-new file the agent is creating has no
   baseline).
3. Backward mtime move is NEVER stale (restore / clock-skew is not an external
   write-after-read).
4. A non-marker command NEVER produces a stale hint, regardless of mtime changes
   (precision: only warn on a known file-mutating command).
5. The guard imports `@/shared` ONLY — real mtimes are injected (FileSystemPort
   at integration); the slice is unit-testable with hand-fed numbers.
6. NO-THROW: every export returns a value (Result / boolean / array / string).
7. `WRITE_COMMAND_MARKERS` is a CLOSED set; additions require an ADR amendment.

## Integration TODOs (shared files — applied serially by the human)

Each is GATED on `staleReadGuardEnabled(ctx env)`; the OFF path is unchanged.

1. **`src/tool/types.ts` — ToolContext field.** Add an optional duck-typed field
   (mirror `gitWriteGuard`): `readFileState?: ReadFileState`. Absent ⇒ guard OFF
   (byte-identical). The dispatch seam builds the single per-run instance when
   the gate is on and threads it onto every ToolContext.

2. **`src/storage/types.ts` — surface mtime.** Add `mtimeMs: number` to
   `FileInfo` and in `src/storage/service.ts statFile` return
   `mtimeMs: s.mtimeMs` (the underlying `stat()` already has it). This is the
   only data the guard needs; no behavior change for existing FileInfo readers.

3. **`src/tool/read/index.ts` — record at read time.** After the successful
   `fs.statFile(...)` (variable `info`), when `ctx.readFileState` is present,
   call `ctx.readFileState.record(info.path, info.mtimeMs)`. (`info.path` is the
   resolved absolute path — the canonical key.)

4. **`src/tool/write/index.ts` + `src/tool/edit/index.ts` — pre-write check.**
   Right where each tool calls `gitWriteGuardDeny(input.path, ctx)`, add (when
   `ctx.readFileState` is present): stat the resolved target via the same
   `FileSystemPort`, then `const g = guardWrite(ctx.readFileState, resolvedPath,
   info.mtimeMs)`; if `!g.ok` yield an `ok:false` ToolResult with
   `failure.mode:"stale_read"` and `output: g.error.message`, and return WITHOUT
   writing. (A target that does not exist yet ⇒ statFile not-found ⇒ skip the
   check; an unread/new file is allowed.)

5. **`src/agent/dispatch.ts` (or the bash post-hook seam) — post-bash detector.**
   After a bash tool result, when `ctx.readFileState` is present: re-stat the set
   of currently-recorded read paths, build `MtimeObservation[]`, call
   `staleAfterBash(ctx.readFileState, bashCommand, changed)`, and if non-empty
   inject `renderStaleReminder(stale)` as a system-reminder into the next prompt.
   (Cheap: only re-stat paths already in the read-state Map.)

6. **`apps/**` env seed** — document `QUANTA_STALE_READ_GUARD=1` in the env-seed
   surface alongside the other tool-axis flags (no code change required to keep
   OFF).
