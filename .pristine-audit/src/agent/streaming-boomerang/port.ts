/**
 * Streaming boomerang port (ADR-0251).
 *
 * Sibling of ADR-0218 (`DelegationPort.delegate` — single typed result).
 * This port adds the PROGRESSIVE consumption surface Roo Boomerang ships:
 * the parent observes the child as it produces text, with the option to
 * break the iterator (cancellation) at any point.
 *
 * Plane-clean: types-only. NO imports from `@/agent/loop`, `@/agent/dispatch`,
 * `@/llm`, `@/tool`, OR `@/agent/subagent-typed`. The chunk shape mirrors
 * (but does not import) ADR-0218's `BoomerangResult` so the two slices can
 * be wired together by the host without coupling at the type layer.
 *
 * Default-OFF: the loop never constructs a `StreamingBoomerang`. Callers
 * (apps / tier1 builders / future CLI command) opt in by wiring one
 * through AgentConfig. When the slot is absent, the ADR-0218 result-only
 * path is byte-identical to before this slice landed.
 *
 * Contracts (5 HARD invariants — sealed by hellgate):
 *   1. `spawn()` never throws for OPERATIONAL failure. Invalid spec
 *      surfaces as a single `error` chunk with `errorKind:"invalid-spec"`
 *      (then iterator done). Throws ONLY for programmer-bug arms (e.g.
 *      a non-string prompt forced past the type system).
 *   2. AsyncIterable cleanup is observable: `break` / `return()` /
 *      AbortSignal.abort triggers the producer's `abort()` hook exactly
 *      once + iterator finishes (`done:true`).
 *   3. Single-pass — calling `Symbol.asyncIterator` on the returned
 *      iterable yields ONE iterator; multi-consumer requires multiple
 *      spawn calls.
 *   4. Backpressure-safe — producer `enqueue` waits for consumer
 *      consumption (bounded buffer; no unbounded memory).
 *   5. exactOptionalPropertyTypes — absent fields OMITTED.
 */

import type { BoomerangChunk } from "./types"

/** Spec the host passes to `spawn`. The shape mirrors the ADR-0218
 *  `DelegationRequest` so the two slices feel familiar, but is NOT
 *  imported from there (this slice is independently consumable). */
export interface StreamingBoomerangSpec {
  /** Free-form mode label — pure passthrough, the streamer does NOT
   *  enforce a closed enum here (that's ADR-0218's job). When the
   *  streamer wraps an ADR-0218 router, the mode string is fed into
   *  the typed delegate. */
  readonly mode: string
  /** Free-form prompt the producer feeds to the child agent. Empty
   *  string ⇒ surfaces as a single `error` chunk with
   *  `errorKind:"invalid-spec"`. */
  readonly prompt: string
  /** Optional per-call budget cap — pure passthrough to the producer. */
  readonly budget?: {
    readonly maxTurns?: number
    readonly maxTokens?: number
  }
  /** Optional parent-side cancellation. When the signal fires, the
   *  iterator finishes (terminal `error` chunk with `errorKind:
   *  "cancelled"` THEN iterator done) and the producer's `abort()`
   *  hook is invoked. */
  readonly parentSignal?: AbortSignal
  /** Optional opaque metadata the host can use to correlate child to
   *  parent (e.g. a parent turn id). Pure passthrough — never inspected. */
  readonly correlation?: Readonly<Record<string, string>>
}

/** Closed port: parent ↔ child progressive consumption.
 *
 *  Returns a single-pass AsyncIterable; the host iterates with
 *  `for await (const chunk of port.spawn(spec)) { ... }`.
 *
 *  Cleanup semantics: when the consumer `break`s, `return`s, or
 *  `throw`s out of the loop, OR `spec.parentSignal` aborts, the
 *  iterator's `return()` is invoked and the producer's `abort()` hook
 *  fires exactly once. After cleanup, the iterator is `done:true`. */
export interface StreamingBoomerang {
  spawn(spec: StreamingBoomerangSpec): AsyncIterable<BoomerangChunk>
}
