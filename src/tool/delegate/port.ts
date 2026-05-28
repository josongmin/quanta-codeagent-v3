/** Duck-typed mirror of `DelegationPort` from `@/agent/subagent-typed`
 *  (ADR-0218). Kept here so the `@/tool` slice does NOT import `@/agent`
 *  (slice fence, RFC §3.1; biome enforces).
 *
 *  MIRROR INVARIANT — this file mirrors ONLY the tool-exposed subset of the
 *  producer port. The producer's `DelegationPort` exposes `delegate` /
 *  `listModes` / `describeMode`; the SYNCHRONOUS-DELEGATION tool surfaces only
 *  `delegate` + `listModes` (the latter so the tool can fail closed with the
 *  KNOWN mode list when the LLM passes an unknown mode). NOTE: the producer
 *  port has NO `explore` method — `explore` is a MODE VALUE (member of
 *  {@link AgentMode}), not a port method. The tool reaches an explore-mode
 *  child purely by passing `mode:"explore"` to `delegate`.
 *
 *  Reviewers MUST keep the shared request / result / mode shapes in sync with
 *  the producer. `tests/unit/delegate-tool-hellgate.test.ts` seals both the
 *  closed mode union and the minimal tool port against the producer.
 *
 *  Contract preserved here:
 *   - `delegate()` is NO-THROW for operational failures (budget / mode-missing
 *     / cancel / runner-error / timeout) — they surface in
 *     {@link BoomerangResult.errorKind}. It THROWS only for programmer-bug
 *     input (unknown mode bypassed via type assertion).
 *   - `listModes()` is a pure read — never throws. */

/** Closed mode union — mirror of `AgentMode` from `@/agent/subagent-typed`.
 *  Adding a value MUST extend the producer union AND this literal here; the
 *  hellgate cross-checks the two are identical sets. */
export type AgentMode = "architect" | "editor" | "debug" | "tdd" | "explore"

/** Read-only mode list — mirror of `AGENT_MODES`. Used by the tool to validate
 *  the LLM-supplied mode and to render the choice list in the description. */
export const DELEGATE_MODES: readonly AgentMode[] = Object.freeze([
  "architect",
  "editor",
  "debug",
  "tdd",
  "explore",
])

/** Closed error-kind union — mirror of `BoomerangErrorKind`. */
export type BoomerangErrorKind =
  | "cancelled"
  | "budget-overflow"
  | "mode-missing"
  | "runner-error"
  | "timeout"

/** Mirror of `BoomerangResult` — the ONLY shape that crosses the parent/child
 *  boundary. Mirrors the producer field-for-field so the tool can render it
 *  without importing `@/agent`. */
export interface BoomerangResult {
  readonly ok: boolean
  readonly summary: string
  readonly mode: AgentMode
  readonly artifacts?: Readonly<Record<string, string>>
  readonly turns: number
  readonly tokens?: number
  readonly durationMs: number
  readonly errorKind?: BoomerangErrorKind
  readonly errorMessage?: string
}

/** Mirror of `DelegationRequest` — the request the tool hands to the port. */
export interface DelegationRequest {
  readonly mode: AgentMode
  readonly prompt: string
  readonly budget?: {
    readonly maxTurns?: number
    readonly maxTokens?: number
  }
  readonly parentSignal?: AbortSignal
  readonly correlation?: Readonly<Record<string, string>>
}

/** Narrow delegation port the synchronous `delegate` tool consumes. The
 *  producer-side `DelegationPort` is a strict superset (it also carries
 *  `describeMode`). */
export interface DelegationPort {
  delegate(req: DelegationRequest): Promise<BoomerangResult>
  listModes(): readonly AgentMode[]
}
