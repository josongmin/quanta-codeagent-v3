/**
 * `@/apps/headless/types` — public input / output shapes for the headless
 * surface (ADR-0308 / ARCH-07).
 *
 * SLICE INVARIANT: `src/apps/headless/**` is a SECOND surface. It MUST NOT
 * import from `src/apps/cli/**`, `src/apps/bench/**`, or `src/apps/agent/**`.
 * Enforced by biome `noRestrictedImports` (see `biome.json` override) +
 * `tests/unit/apps/headless/headless-second-consumer-hellgate.test.ts`.
 *
 * The headless surface drives the SAME `@/host/bootstrap` + internal
 * `@/runner/*` cores the CLI uses — proving the host layer is reusable
 * without depending on the public runner barrels. Every env / argv /
 * terminal-bound seam is injected by the caller as plain data (no
 * `process.env` / `process.argv` reads in the headless slice itself).
 */

import type { AgentConfig, AgentOutcome } from "@/agent"
import type { SessionTransport } from "@/ipc/session"
import type { Message, StreamEvent } from "@/llm"
import type { RuntimeSession } from "@/sdk/runtime"
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
  /** Optional home dir for host-owned persistent helpers such as
   *  session-memory-auto. Default `"/tmp"`. */
  readonly homeDir?: string
  /** Optional live session transport attach slot. When present, the headless
   *  proof attaches the runtime session to this transport before the first
   *  user command. Default-OFF. */
  readonly transport?: SessionTransport
  /** Optional retained tail window for the attached transport bridge. */
  readonly transportReplayWindow?: number
  /** Optional subagent config so the shared execution-plane helper can
   *  wire real delegation/background slots in the second-consumer surface. */
  readonly subagentConfig?: AgentConfig["subagent"]
}

/** Public proof that the second-consumer surface got the same reusable
 *  execution-plane and memory-auto wires without leaking the internal
 *  runtime-deps bag across the headless public seam. */
export interface HeadlessRuntimeWires {
  readonly executionPlane: {
    readonly conversationCheckpoint: boolean
    readonly responsesContinuation: boolean
    readonly fork: boolean
    readonly forkSession: boolean
    readonly delegation: boolean
    readonly subagentBackground: boolean
    readonly autoBackground: boolean
  }
  readonly memoryAuto: {
    readonly sessionCtx: boolean
    readonly stage1OutputsStore: boolean
    readonly memoryConsolidator: boolean
    readonly memoryConsolidatorEnabled: boolean
  }
}

export type HeadlessSessionSnapshot = Awaited<ReturnType<RuntimeSession["snapshot"]>>

/** Result of {@link runHeadlessOnce}. The public seam exposes SDK-facing
 *  session metadata + the completed-turn proof. Internal bootstrap/runtime
 *  bags stay private to the slice.
 *
 *  Contract:
 *  - stable session metadata: `sessionId`, `cwd`, `model`, `mode`,
 *    `maxTurns`, `provider`
 *  - completed runs expose a snapshot captured from `session.snapshot()`
 *  - already-aborted runs may omit `snapshot`, proving the surface
 *    short-circuited before opening a runtime session */
export interface HeadlessRunResult {
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly maxTurns: number
  readonly cwd: string
  readonly sessionId: string
  /** Per-turn outcome from `@/runner#runOnce`. Carries `reason` (closed enum)
   *  plus the structured stop-category and timing fields the runner emits. */
  readonly outcome: AgentOutcome
  /** Post-turn message history (user prompt + every assistant turn). */
  readonly messages: readonly Message[]
  /** Every `AgentEvent` the runner emitted during the turn — recorded by
   *  the fake stream port. Surface tests assert on this; production
   *  headless callers may ignore the field. */
  readonly events: readonly AgentEvent[]
  /** SDK snapshot captured from the runtime session when a session was
   *  opened. Undefined on pre-bootstrap abort short-circuit. */
  readonly snapshot?: HeadlessSessionSnapshot
  /** Lean proof that reusable execution/memory wires were mounted without
   *  exposing the full internal runtime-deps bag on the headless public API. */
  readonly wires: HeadlessRuntimeWires
}
