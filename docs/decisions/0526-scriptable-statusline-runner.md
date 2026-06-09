# ADR-0526: Scriptable statusLine runner (Claude Code stdin contract, args-based spawn, ANSI-aware truncated first line)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - ticket-15 (§11.7 part A) — operator-authored scriptable status line, mirroring Claude Code's `statusLine { type:"command", command, padding?, refreshInterval?, hideVimModeIndicator? }` config (CC settings schema:737).
  - Companion to ADR-0297 (`cli-runtime-feature-config`) — the `statusLineConfig` knob is homed in the `@/shared` runtime-config struct (double-gated, default-OFF) and ticket-15's config-parse half lands there; THIS ADR covers the CLI-slice runner that interprets that config.
  - Sibling chrome: `cli-status-bar` (DECSTBM scroll-region pinned row) and `cli-status-pills` (top session row) are FIXED renderers; this runner is the surface-agnostic *scriptable* status line — an operator-authored command that emits the line.
- **참조**:
  - `src/apps/cli/status-command-runner.ts` — `runStatusCommand` (args-based spawn, JSON-on-stdin, first-line/ANSI-aware/width-truncated stdout, silent-degrade, soft-timeout + hard-cap watchdog), `buildStatusPayload` (CC `Status` payload from the host session view, omit-not-null, no-secrets), `formatStatusOutput` / `stripStatusAnsi` / `statusVisibleWidth` (OSC-aware width oracle + reset-correction), `statusChildEnv` (scrubbed-env allowlist), `resolveTimeoutMs` / `resolveRefreshIntervalMs` (clamps), `SessionStatusView` / `StatusPayload` / `StatusLineConfig` types.
  - `src/shared/runtime-config.ts` — `parseStatusLineConfig` (:180) double-gated parse of `QUANTA_STATUS_LINE` (master gate, gateOn vocab) + `QUANTA_STATUS_LINE_CONFIG` (JSON config) into the `statusLineConfig` knob (:1784); the runner's own `StatusLineConfig` is structurally assignable to the `@/shared` shape so `@/shared` stays a leaf.
  - `src/shared/runtime-config-knobs.ts` — knob registry entries for `QUANTA_STATUS_LINE` (:857) and `QUANTA_STATUS_LINE_CONFIG` (:864).
  - Tests: `src/apps/cli/__tests__/status-command-runner.test.ts` (R-1..R-10 / B-1..B-4 / F-1 runner+payload+format hellgate, real-subprocess stdin round-trip) and `tests/unit/statusline-config-knob-hellgate.test.ts` (K-1..K-9 double-gated default-OFF config parse).
  - Feature catalog: `tools/feature-catalog/features/10-app/cli-status-command-runner.yaml` (id `cli-status-command-runner`).

## Context

Claude Code lets an operator script the status line: a `statusLine` command is
invoked on every status tick with a `{"hook_event_name":"Status", …}` JSON
object on **stdin**; the command prints a status string, CC takes the FIRST LINE,
allows ANSI color, and truncates to terminal width. A script written for CC's
status line should work verbatim under quanta.

Doing this naively is hazardous on the prompt hot path. A status command (a) is
arbitrary operator code — running it through a shell would open a shell-injection
surface and could inherit the parent's API keys/tokens; (b) prints arbitrary
bytes — an unbalanced ANSI SGR or an open OSC-8 hyperlink bleeds color/clickable
state into the prompt below, and a naive width-truncate can cut mid-escape or
miscount OSC width; (c) can hang — a slow or wedged child that never closes
stdout / never exits would stall the prompt indefinitely.

The config-parse half of ticket-15 already landed in `@/shared` runtime-config
(`parseStatusLineConfig`, double-gated `QUANTA_STATUS_LINE` +
`QUANTA_STATUS_LINE_CONFIG`, default-OFF, byte-identical when absent). What was
missing was the CLI-slice *runner* that consumes that config and produces the
line.

## Decision

Ship `status-command-runner.ts` in `src/apps/cli` (the slice that owns the REPL
status tick — no new tsconfig path / slice fence). It mirrors CC's contract with
a layered defensive contract:

- **Args-based spawn, NO `shell:true`.** The command argv is normalized
  (`toArgv`: a string is whitespace-split, an array used verbatim); an empty
  command is inert (`"" + degraded`). No shell ⇒ no injection surface.
- **Scrubbed child env.** The child receives ONLY the `scrubEnv` allowlist
  (`@/runtime` `DEFAULT_ENV_ALLOWLIST` — PATH/HOME/LANG/proxy), routed through
  the typed `spawnScrubbed` boundary, so a parent-secret leak is a tsc error,
  not a runtime hazard — the SAME chokepoint command-hooks use (one SSOT).
- **No-secrets payload.** `buildStatusPayload` copies only cost/model/cwd/
  workspace/context facts from a structurally-declared `SessionStatusView` that
  has NO token/key slot; absent fields are OMITTED (not nulled), and non-finite
  numbers are dropped (so `JSON.stringify` never emits a `null` a CC script
  would read as a real value).
- **ANSI-aware first-line truncation + reset-correction.** Output is the FIRST
  LINE only, ANSI preserved, truncated to `width` VISIBLE columns by an
  OSC-aware width oracle (`stripStatusAnsi` — the shared SGR-only `stripAnsi`
  miscounts OSC). On every return path an SGR reset is appended iff a style is
  left open AND an OSC-8 close iff a hyperlink is left open (idempotent).
- **Soft timeout (500ms, CC default) + ABSOLUTE hard-cap watchdog (5s).** The
  soft timer kills the child; the wall-clock `Promise.race` against `capPromise`
  guarantees the runner settles to the degraded sentinel even if the child never
  closes stdout AND never resolves `exited`, and the orphaned stdout reader is
  cancelled (lock + pending `read()` released).
- **SILENTLY DEGRADES, NEVER THROWS.** Spawn error / non-zero exit / timeout /
  hard-cap all warn-once and return `{text:"", degraded:true}` (non-zero exit
  still surfaces the printed line but flags `degraded`). A status line must
  never break the REPL.

## Consequences

- A CC-authored statusLine script runs verbatim under quanta with the same
  stdin payload, first-line/ANSI/width semantics, and trust tier (operator-
  authored, hook-equivalent) — but with a strictly stronger safety envelope (no
  shell, scrubbed env, no-secret payload, OSC-aware width, hard-cap watchdog).
- **Unwired SEAM (deliberate hold).** The runtime-config knob is homed and
  parsed, and the runner is fully unit-proven, but `runStatusCommand` /
  `buildStatusPayload` are not yet composed at the REPL render root — no live
  (non-test) src file imports them. The line is validated, not yet rendered.
  Promotion is a pure wiring step in the surface-composition root: build a
  `SessionStatusView` from the live session host, call `runStatusCommand` on the
  status tick gated by `runtimeConfig.statusLineConfig`, and render its `text`
  in place of / alongside the fixed `formatContextUsage` line. A sibling
  composition-root lane may land this; until then the catalog reflects the seam
  honestly.

### Alternatives considered

- **Shell-based spawn (`shell:true`) for argv convenience.** Rejected — opens a
  shell-injection surface on operator-authored-but-still-arbitrary input; the
  whitespace-split convenience covers the simple case without it.
- **Reuse the shared SGR-only `stripAnsi` as the width oracle.** Rejected — it
  miscounts a line carrying an OSC hyperlink/title (leaves the URL in the
  "visible" width), cutting the status line mid-sequence. The runner ships an
  OSC-aware `stripStatusAnsi`.
- **Soft timeout only (no hard cap).** Rejected — `kill()` is a no-op against a
  child that ignores the signal / never closes stdout; without the wall-clock
  `Promise.race` the prompt could wedge forever past the soft timeout.
- **Wire the runner into the render root in this slice.** Deferred — the render-
  root composition is owned by a sibling surface lane; landing it here would
  cross lane ownership. The seam is kept default-OFF and validated.
