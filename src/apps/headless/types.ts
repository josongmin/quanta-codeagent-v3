/**
 * `@/apps/headless/types` — public input / output shapes for the headless
 * surface (ADR-0308 / ARCH-07).
 *
 * SLICE INVARIANT: `src/apps/headless/**` is a SECOND surface. It MUST NOT
 * import from `src/apps/cli/**`, `src/apps/bench/**`, or `src/apps/agent/**`.
 * Enforced by biome `noRestrictedImports` (see `biome.json` override) +
 * `tests/unit/apps/headless/headless-second-consumer-hellgate.test.ts`.
 *
 * The headless surface drives the SAME `@/host/bootstrap` + `@/runner` cores
 * the CLI uses — proving the host layer is reusable. Every env / argv /
 * terminal-bound seam is injected by the caller as plain data (no
 * `process.env` / `process.argv` reads in the headless slice itself).
 */

import type { AgentOutcome } from "@/agent"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { Message, StreamEvent } from "@/llm"
import type { AgentEvent } from "@/stream"

/** A pre-programmed assistant turn the fake LLM will replay. Either supply
 *  the canonical {@link text} (which is widened into a single `text_delta` +
 *  `message_stop("end_turn")` script — the byte-identical "model said pong"
 *  shape every text-only completion uses), OR supply a full {@link events}
 *  script for advanced cases (tool-call rounds, multi-text, refusals). */
export type FakeCompletion = { readonly text: string } | { readonly events: readonly StreamEvent[] }

/** Input to {@link runHeadlessOnce}. Every field is plain data — the
 *  headless surface NEVER reads `process.env` / `process.argv`. */
export interface HeadlessRunInput {
  /** The user prompt for the single turn (mirrors the CLI argv-prompt branch). */
  readonly prompt: string
  /** The fake LLM's reply. The next assistant turn returns this verbatim.
   *  For a multi-turn (tool-call) test, supply {@link fakeCompletions} as an
   *  ordered list instead. */
  readonly fakeCompletion?: FakeCompletion
  /** Multi-turn ordered scripts (each entry replayed on the matching turn).
   *  Mutually exclusive with {@link fakeCompletion}; if both are present the
   *  list takes precedence. */
  readonly fakeCompletions?: readonly FakeCompletion[]
  /** Caller-supplied abort signal. Already-aborted ⇒ the run returns
   *  immediately with `outcome.reason === "aborted"`. Default: never abort. */
  readonly signal?: AbortSignal
  /** Bounded turn cap forwarded into the assembled `AgentConfig.maxTurns`.
   *  Default 5 — same as the CLI bootstrap. */
  readonly maxTurns?: number
  /** Working directory the headless run operates from. Default `"/tmp/headless"`
   *  — the slice itself NEVER reads `process.cwd()`. */
  readonly cwd?: string
  /** Optional environment record. The headless slice does NOT read
   *  `process.env`; only the values passed here reach the bootstrap (and
   *  even then only `QUANTA_EFFORT` is consumed). Default `{}`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Result of {@link runHeadlessOnce}. The shape is intentionally LEANER
 *  than the CLI's `SessionSetupResult` — every TTY/UI chrome field
 *  (`statusBar`, `turnIndicator`, `costPanel`, `branchProgress`,
 *  `lifecyclePills`, `pills`, `debugHandle`, `timelinePanel`, `turnSummary`)
 *  is INTENTIONALLY ABSENT. The headless surface exposes only the
 *  bootstrap result + per-turn outcome.
 *
 *  Field-count contract: `runHeadlessOnce` returns the FULL
 *  {@link SessionBootstrapResult} shape PLUS `outcome` + `messages`, so the
 *  count is bootstrap-fields + 2 — strictly greater than the bootstrap
 *  result's own field count. This is the CASE-5 invariant the hellgate
 *  pins (any future bootstrap field gets carried through automatically). */
export interface HeadlessRunResult extends SessionBootstrapResult {
  /** Per-turn outcome from `@/runner#runOnce`. Carries `reason` (closed enum)
   *  plus the structured stop-category and timing fields the runner emits. */
  readonly outcome: AgentOutcome
  /** Post-turn message history (user prompt + every assistant turn). */
  readonly messages: readonly Message[]
  /** Every `AgentEvent` the runner emitted during the turn — recorded by
   *  the fake stream port. Surface tests assert on this; production
   *  headless callers may ignore the field. */
  readonly events: readonly AgentEvent[]
}
