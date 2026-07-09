/**
 * jun-11 — CLI default-ON intent for absorbed-but-dark UX feature gates.
 *
 * R3-hardened worklist #1/#2/#3/#9: four CLI-UX features were fully built AND
 * wired but shipped DEFAULT-OFF behind env gates that the CLI host never seeded,
 * so the out-of-box `quanta` REPL never showed them despite the machinery
 * existing. This hellgate pins that they are now CLI-default-ON — i.e. members
 * of `CLI_FEATURE_GATES`, which the index.ts seed loop (`process.env[g] ??= "1"`)
 * turns on by default — AND that the seed value "1" actually activates the
 * canonical `gateOn` SSOT, while an explicit `=0` still wins (opt-out preserved).
 *
 * Pairs with `cli-feature-gates-drift-hellgate` (pins every seeded gate has a
 * real src/ consumer) → together: these features are now default-ON AND wired.
 *
 * RED before the index.ts edit (gates absent from the list); GREEN after.
 * WS-E jul-10: the gate list moved out of side-effecting index.ts into the
 * pure data leaf `cli-feature-gates.ts` (so `/help` can derive from it) — this
 * gate now imports the list directly instead of source-regex-scanning; the
 * seed loop's consumption of that module is pinned by
 * `help-env-seeded-gates-parity.hellgate`.
 */
import { describe, expect, test } from "bun:test"
import { CLI_FEATURE_GATE_NAMES } from "@/apps/cli/cli-feature-gates"
import { gateOn } from "@/shared"

const cliFeatureGates = (): readonly string[] => CLI_FEATURE_GATE_NAMES

// The jun-11 default-ON additions — each R3-verdict SOLID / high-confidence /
// enable-chain YES, with a real consumer pinned by the drift hellgate:
//   #1  @-file/@-symbol mention dropdown    (consumer: at-autocomplete/env.ts)
//   #2  ctrl+x ctrl+e → external $EDITOR     (consumer: surface-compose.ts)
//   #3  ~/.quanta/keybindings.json remap     (consumer: surface-compose.ts)
//   #9  rate-limit-reached status notice     (consumer: ratelimit-notice.ts)
//   #14 shift+tab permission-mode cycle      (consumer: mode-cycle.ts)
// NOTE on #14: the operator EXPLICITLY chose the full 4-rung cycle including the
// `bypass` rung (default → acceptEdits → plan → bypass), so shift+tab can reach
// the no-confirm "runs without asking" posture by keystroke. That is a deliberate
// accepted trade-off (the red [BYPASS] pill is the only guard); it is NOT an
// oversight. bypass also stays reachable via `--mode`/`QUANTA_PERMISSION`.
const DEFAULT_ON = [
  "QUANTA_AT_AUTOCOMPLETE",
  "QUANTA_EXTERNAL_EDITOR",
  "QUANTA_KEYBINDINGS",
  "QUANTA_RATELIMIT_NOTICE",
  "QUANTA_MODE_CYCLE",
  // #5/#6 — type-while-the-agent-runs: mid-turn keystroke CAPTURE + the VISIBLE
  // bottom input lane. Paired (capture without visible ⇒ blind typing). e2e-
  // validated (tests/e2e-pty/cli-turn-layer-e2e.test.ts): a follow-up typed
  // during a sustained replay turn is captured + echoed in the `» ` lane while
  // the turn streams underneath. consumers: session-loop.ts (runtimeConfig
  // .midTurnCapture / .midTurnVisible).
  "QUANTA_MIDTURN_CAPTURE",
  "QUANTA_MIDTURN_VISIBLE",
  // #19 — approval-time applicability pre-flight: warns in the confirm prompt
  // when a mutating edit/apply_patch would NOT cleanly apply. consumer:
  // repl/runtime-context-compose.ts via preflight.ts#preflightCheckEnabled.
  "QUANTA_PREFLIGHT_CHECK",
  // #10 — bracketed-paste: a multi-line paste accumulates into one buffer instead
  // of early-submitting at the first embedded newline. CLI correctness fix,
  // default-ON. consumer: repl/surface-compose.ts (gateOn → ReadLineOptions
  // .bracketedPaste → raw-line-reader DECSET 2004 + paste accumulation).
  "QUANTA_BRACKETED_PASTE",
] as const

describe("jun-11 CLI default-ON UX feature gates", () => {
  const GATES = cliFeatureGates()

  for (const gate of DEFAULT_ON) {
    test(`${gate} is CLI-default-ON (seeded via CLI_FEATURE_GATES)`, () => {
      expect(GATES).toContain(gate)
    })
  }

  test('the index.ts seed value "1" activates the canonical gate SSOT', () => {
    // Mirror the seed loop (index.ts: unset → "1"), then assert gateOn honors it.
    for (const gate of DEFAULT_ON) {
      expect(gateOn({ [gate]: "1" }, gate)).toBe(true)
    }
  })

  test("an explicit =0 still disables (opt-out preserved; seed only when unset)", () => {
    for (const gate of DEFAULT_ON) {
      expect(gateOn({ [gate]: "0" }, gate)).toBe(false)
    }
  })
})
