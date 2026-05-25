# ADR-0225 — CLI `/edit-plan` + `/edit-message` (mid-execution external editor)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Slice**: `src/apps/cli`
- **Sources**: Claude Code `tengu_external_editor` event family
  (transcript opens current plan / pending composer in `$EDITOR`)
- **Sibling ADRs**: 0224 (web/paste text-inbox), 0145 (plan-queue
  follow-ups), 0095 (structured plan store)

## Context

Claude Desktop's `tengu_external_editor.{plan,message}` event pair is
one of the few low-cost, high-leverage primitives that survives every
absorption round. The UX:

1. User notices the plan has drifted from intent (or wants to refine
   a multi-paragraph message before send).
2. `/edit-plan` or `/edit-message` opens `$EDITOR` on a temp file
   pre-populated with the current value.
3. User edits in vim/nano/code, saves, exits.
4. The edited bytes are pushed back through a typed port; if unchanged,
   the slash exits 0 with no side-effect.

Neither command requires LLM access. Both unblock workflows that would
otherwise force the user to retype a long composer or write a
side-channel "actually do X instead" follow-up.

## Decision

Add `editPlanCmd` (`src/apps/cli/edit-plan-cmd.ts`) and `editMessageCmd`
(`src/apps/cli/edit-message-cmd.ts`) to the BUILTINS registry. Each
declares a duck-typed `SlashContext` extension (`PlanEditPort` /
`ComposerEditPort`) — the SURFACE wires the concrete impl; the slash
NEVER imports `@/agent` or the REPL surface.

### Shared `editInTemp` driver
Lives in `edit-plan-cmd.ts`, re-imported by `edit-message-cmd.ts`. One
function:
1. `mkdtemp(tmpdir(), "quanta-edit-")` ⇒ fresh dir per invocation.
2. Write the seed body (`plan.md` or `msg.md` suffix).
3. Spawn `$EDITOR <path>` with `stdio: "inherit"` so the user's TTY is
   handed to the editor.
4. Read back; compare bytes; return a typed `EditInTempResult`
   discriminated union (`ok` / `spawn_failed` / `editor_failed` /
   `fs_failed`).

### Editor discovery priority
1. `ctx.editorOverride` (test seam — pin the binary verbatim).
2. `$VISUAL` (Aider + classic Unix convention).
3. `$EDITOR`.
4. `vi` (last-resort POSIX default).

`parseEditorCommand` splits on whitespace so `code --wait` ⇒
`{cmd: "code", args: ["--wait"]}`; the file path is appended last.

### Empty-edit semantics
If the read-back text is byte-identical to the seed, print "unchanged"
and exit 0 WITHOUT calling `setPlan` / `setPending`. Treat editor-cancel
as user-intentional no-op (don't trigger plan-mutation or composer-
overwrite from an aborted edit).

### Default-OFF posture
- `ctx.planEdit` absent ⇒ `/edit-plan: not wired in this surface` +
  exit 0 (parity with `/snapshot`, `/side`, etc.).
- `ctx.composerEdit` absent ⇒ same for `/edit-message`.
- Surfaces that don't wire either port still get the commands in
  `/help` discovery; their "not wired" output is the documented contract.

### Port shapes
```ts
interface PlanEditPort {
  getPlan(): Promise<string> | string
  setPlan(body: string): Promise<void> | void
}
interface ComposerEditPort {
  getPending(): Promise<string> | string
  setPending(body: string): Promise<void> | void
}
```
Both methods are sync-or-async (`T | Promise<T>`) so a CLI surface can
return the raw buffer synchronously while a future Tauri surface can
await an IPC round-trip.

### Slice posture
- `edit-plan-cmd.ts` imports `node:fs/promises`, `node:os`,
  `node:path`, `node:child_process` + `./slash-commands`. NO `@/agent`
  imports.
- `edit-message-cmd.ts` imports from sibling `./edit-plan-cmd`
  (`editInTemp`, `resolveEditor`, `renderEditResult`,
  `defaultEditorSpawn`) — single source of truth for the edit driver.

## Consequences

- **+** Mid-execution course-correction without an LLM round trip.
- **+** Composer drafting parity with Claude Desktop / Cursor (long
  prompts no longer need a separate text editor + manual paste).
- **+** The `PlanEditPort` is intentionally generic — implementations
  may either parse the markdown back to structured todos
  (`update_plan` mutations) OR simply enqueue the edited text as an
  `external_editor` follow-up the next turn reads. Surface chooses.
- **−** Shells out to `$EDITOR` — surfaces with no controlling TTY
  (CI, headless) get `spawn_failed` (exit 1). Documented; safe.
- **−** Temp files live in `os.tmpdir()` and are NOT auto-cleaned. The
  OS sweeper handles them; we could `rm -rf dir` post-read but
  introducing failure paths there for a 0-byte savings is not worth it.

## Test plan

- `tests/unit/cli/edit-plan-cmd-hellgate.test.ts` — 10 cases: extra
  argument / unwired / editor priority / spawn-failed / editor-failed /
  unchanged / changed / getPlan-throws / setPlan-throws / parseEditorCommand.
- `tests/unit/cli/edit-message-cmd-hellgate.test.ts` — 9 cases: extra
  argument / unwired / spawn-failed / editor-failed / unchanged /
  changed / getPending-throws / setPending-throws / empty-start.

All 19 cases green. tsc 0 / biome 0 on the slice.

## Negative invariants

- The slash MUST NOT auto-send the edited message. `/edit-message`
  prints "press Enter to send" — the user retains the final commit.
- The slash MUST NOT modify the structured plan store directly. It
  goes through `PlanEditPort.setPlan(string)` so a future parser can
  decide whether to mutate `update_plan` or enqueue a follow-up.
- An empty-edit MUST NOT call `setPlan` / `setPending`. Byte-identical
  comparison; not a hash.
- The temp file path MUST be a fresh `mkdtemp` per invocation. NEVER
  reuse a path (concurrent invocations would race).
