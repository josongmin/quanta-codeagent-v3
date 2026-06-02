# ADR-0446 — external `$EDITOR` composition via ctrl-x ctrl-e

**Status:** Accepted (2026-06-02)
**Type:** UX/DX slice — RFC-11 (`docs/plans/jun-2-misc/11-external-editor-and-keybindings.md`), feature A.
**Scope:** new leaf `src/apps/cli/raw-line-reader-editor.ts` (the
`ExternalEditorPort`) + a chord state machine + `runExternalEdit` closure in
`raw-line-reader.ts`, threaded through `prompt-pipeline.ts` → `session-loop.ts`
→ `surface-compose.ts` (`buildPromptUx`) → `repl.ts`. Default-OFF (no
`openEditor` injected ⇒ ctrl-x ctrl-e inert, byte-identical).

## Context

The REPL prompt reader (`raw-line-reader.ts`) is a raw-mode keypress reader.
The only way to compose a multi-line / large prompt in `$EDITOR` today is the
`/edit-message` slash (ADR-0225), which is friction for power users. The
readline convention `ctrl-x ctrl-e` (bash/zsh `edit-and-execute-command`) is
muscle memory: one chord opens the current draft in `$EDITOR`, save+exit folds
the text back, and the user presses Enter to submit.

The editor spawn infrastructure ALREADY exists and is safe: `edit-plan-cmd.ts`
exports `resolveEditor` (`$VISUAL` → `$EDITOR` → `vi`), `defaultEditorSpawn`
(stdio inherit, no-throw, exit-code resolve), and `editInTemp` (tmpdir-isolated
write → spawn → readback, every failure a typed result). The RFC's prior
hypothesis that a NEW spawn path was needed is false.

## Decision

A closed `ExternalEditorPort { openDraft(text) -> {text, changed} }` REUSES the
`editInTemp` driver verbatim — NO new spawn code. `buildExternalEditor` wraps it
and degrades EVERY failure (spawn-not-found / nonzero-exit / fs error) to a
no-op: it returns the original draft with `changed:false` and reports the reason
through an `onWarn` callback. `openDraft` therefore never throws.

The reader gains a two-key chord machine (`pendingCtrlX` latch) that runs ONLY
when `opts.openEditor` is wired, placed BELOW the ctrl-c abort guard and ABOVE
the search / `@`-routing so a pending chord cannot be swallowed by another mode.
`ctrl-x ctrl-e` invokes `runExternalEdit`.

`runExternalEdit` is the load-bearing safety design (the RFC's #1 risk):

1. detach the keypress listener, erase the prompt band, drop raw mode, pause
   stdin — the editor owns the TTY (`stdio: "inherit"`);
2. `await openEditor.openDraft(buf)` inside an INNER try/catch (so a misbehaving
   port can never escape as an unhandled rejection);
3. a `finally` that — regardless of how the editor returned (success, nonzero
   exit, throw, crash) — restores raw mode (`setRawMode(true)`), resumes stdin,
   re-attaches the keypress listener, and redraws. A `settled` guard prevents a
   concurrent ctrl-c from being fought.

The editor result folds into `state.buf` only; the line is NOT auto-submitted
(parity with `/edit-message` and Codex/Claude — the user presses Enter).

## Consequences

- Power users get the readline chord with zero new spawn surface.
- The raw-mode-restore-on-crash invariant is proven by a hellgate where the port
  THROWS and the test asserts the last `setRawMode` call is `true` + the listener
  is re-attached + the draft is preserved.
- Default-OFF: absent `openEditor`, ctrl-x / ctrl-e remain the control chars the
  printable-insert path already drops — byte-identical, sealed by a regression
  anchor.
- Gated by `QUANTA_EXTERNAL_EDITOR=1` in `buildPromptUx`.

## Non-goals

Modal vim editor, bracketed-paste burst detection, in-editor LSP — all out of
scope (deferred to follow-up RFCs).
