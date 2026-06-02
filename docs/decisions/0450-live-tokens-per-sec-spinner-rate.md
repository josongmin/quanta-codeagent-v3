# ADR-0450 — live tokens/sec throughput on the streaming spinner

**Status:** Accepted (2026-06-02)
**Type:** UX/DX TUI-polish slice.
**Scope:** `src/apps/cli/turn-indicator.ts` (one named const + one pure
`computeRate` + one pure `pushRateSample` + `RenderState.rateSamples` +
`updateUsage` sampling + one additive `renderLine` segment) and its hellgate
`tests/unit/cli/turn-indicator.test.ts`. No other files touched. Additive,
no env gate.

ADR-number note: 0447 was the highest existing decision; 0448/0449 are left for
two concurrently-active sibling sessions (diff-preview etc.). This slice took the
next clearly-free number, 0450.

## Context

quanta's turn indicator already shows cumulative streaming stats —
`streaming · 3.2s · ttft 0.1s · 1.2k in · 3.4k out` — but no live throughput.
Claude Code and Codex CLIs both surface a live `tok/s` flow rate so the user can
tell "still flowing fast" from "stalling" at a glance, which cumulative counts
cannot convey (a frozen `3.4k out` looks identical whether output is racing or
dead). This is the gold-standard streaming-TUI polish; we absorb the fixed-format
subset.

## Decision

Output throughput (`tok/s`) is rendered as an additive segment appended after
the `out` count on the streaming line, e.g.
`streaming · 3.2s · ttft 0.1s · 1.2k in · 3.4k out · 1,200 tok/s`.

**Measurement, not heuristic.** The rate is the exact slope
`Δoutput-tokens / Δtime × 1000` taken between the OLDEST and NEWEST sample
currently held in a fixed-size trailing ring (`RATE_WINDOW_SAMPLES = 8`). It is
a literal measured rate-of-change over an explicit, observable set of recorded
points — there is no decay factor, no threshold, no smoothing fudge, no
fallback constant. The single tunable is the *window length* (how many recent
samples define "now"), documented with its rationale in the source.

**Why a sample ring, not an EWMA.** An EWMA needs an alpha/decay constant whose
choice is genuinely arbitrary (that would be the banned kind of heuristic). A
fixed sample window has an exact definition ("slope over the last N readings")
and a burst naturally ages out of the ring, so a burst-then-stall visibly drops
toward the recent slow rate instead of being flattened into a session-long mean.
Window = 8 because `usage` events arrive roughly per provider chunk/flush, so
~8 samples spans the last fraction of a second to a couple seconds of real flow:
recent enough to read as "right now", long enough that one jittery inter-arrival
gap can't dominate the slope.

**Sampled on token-arrival, not on the frame tick.** `updateUsage` (the
token-delta boundary) records `(outputTokens, now())` into the ring using the
SAME injected `now` clock the spinner already uses — no second wall-clock
source. The 80 ms frame tick still drives REPAINT, but it does NOT feed the
rate value. This decoupling is the whole point: a frame-tick-counted rate feels
laggy and is contaminated by repaint cadence.

**Clock injection.** Already present — `createTurnIndicator` takes
`now?: () => number` defaulting to `Date.now` (used for `startedAt`/`firstChunkAt`/
ttft). We reuse it verbatim; nothing new was threaded.

## Edge handling (no NaN / no zero-noise)

`computeRate` returns `undefined` (NOT `0`, never `NaN`/`Infinity`) when:
- fewer than 2 samples exist (a single point has no slope),
- `Δtime <= 0` (two samples at the same clock instant — divide-by-zero guard),
- `Δtokens <= 0` (no forward flow).

`renderLine` appends the segment only when `computeRate` returns a number, so
pre-first-chunk, the thinking phase, and the single-sample case render no
`tok/s` text at all. `pushRateSample` additionally drops any `usage` emit that
doesn't advance the cumulative output count, so a repeated/idle emit can't inject
a zero-Δtoken sample that would read as a momentary `0 tok/s`.

## Consequences (additive byte-identical)

Existing callers and the 17 pre-existing hellgate cases are byte-identical: the
rate segment is purely additive and appears ONLY once ≥2 forward-flowing samples
exist. Every existing test drives at most one `updateUsage` (or zero) before its
assertion, so none crosses the ≥2-sample threshold and none gains a `tok/s`
segment. Thinking-phase output is unchanged (no samples). `ttft`/elapsed/`in`/
`out`/cost rendering and ordering are untouched (cost still trails the rate).
No env knob added — the rate is strictly more information on a line that's
already shown, not a mode.

## Adversarial-review notes (2026-06-02)

- **Trailing window vs session average — proven, not asserted.** A dedicated
  test drives an injected-clock burst (3 samples at ~20,000 tok/s) followed by a
  full window of slow samples (~1 tok/s); the rendered value rounds to a small
  number (<10), confirming the fast burst ages out of the 8-sample ring rather
  than dragging a session mean up. A session average would render in the
  thousands.
- **Divide-by-zero / Infinity.** Two `updateUsage` calls at the same clock
  instant produce `Δtime === 0`; `computeRate` returns `undefined` and the test
  asserts neither `tok/s` nor `Infinity`/`NaN` appears.
- **Single-sample & non-advancing emits.** Covered: one sample ⇒ no segment;
  a same-count emit over real time ⇒ still one sample ⇒ no segment, no
  `0 tok/s`.
- **Ring boundedness.** A test runs `RATE_WINDOW_SAMPLES × 3` steady samples and
  confirms the slope stays at the steady rate (the ring caps; memory is O(window)).

## Non-goals (deferred)

- INPUT tok/s — input is one-shot at request time, so it has no meaningful
  instantaneous rate; only output throughput is shown.
- A configurable window length / EWMA mode — v1 is a single fixed sample count.
  If providers emit at radically different cadences, the const is the one knob to
  revisit (with a measurement, per the no-unjustified-heuristics rule).
- A peak/min rate or sparkline history — v1 shows the current windowed slope
  only.
- Smoothing the displayed integer between paints — the value updates only when a
  new token sample arrives, by design (no synthetic interpolation).
