/**
 * Reasoning-effort delivery SSOT.
 *
 * ── The defect this module exists to make structurally impossible ────────────
 *
 * A requested reasoning effort used to be normalized by a function whose return
 * type was `string | undefined`. `undefined` meant BOTH "the caller requested
 * nothing" and "the caller requested something we cannot put on the wire". The
 * two collapsed onto the same body: no `reasoning.effort` key, so the provider
 * applied ITS OWN default. A run configured with `reasoning_effort: max` went
 * out at the provider default while every receipt still said `max`.
 *
 * That is a measurement-integrity defect, not a lint: a benchmark row that
 * misreports its own configuration is worse than one that refuses to run
 * (`docs/plans/aug-21-bench-terminal-2-1/tickets/TB21-02-…md` DoD: "Requested
 * reasoning effort is the effort sent to the provider and reported").
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 *
 *   A reasoning effort that cannot be delivered to the provider is NEVER
 *   silently downgraded. Either it reaches the wire, or the caller learns it
 *   did not.
 *
 * Enforced by making the decision TOTAL: {@link decideReasoningEffort} returns a
 * discriminated {@link ReasoningEffortDecision} with four arms — `absent`,
 * `delivered`, `rejected`, `unsupported`. There is no return value that means
 * "something was asked for and quietly went nowhere". Every consumer must
 * branch, and the two failure arms are routed through
 * {@link assertReasoningEffortDeliverable}, which throws a FATAL
 * (`kind: "bad_request"`, never retried — `src/llm/retry/decorator-policy.ts`)
 * {@link LLMError} before the first model invocation.
 *
 * ── Why the accepted set is what it is (evidence, not guesswork) ─────────────
 *
 * {@link RESPONSES_REASONING_EFFORTS} is NOT an invented vocabulary. It is the
 * vendored OpenAI SDK's own `ReasoningEffort` union, minus `null`:
 *
 *   node_modules/openai/resources/shared.d.ts:194 (openai@6.38.0)
 *     export type ReasoningEffort =
 *       'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
 *
 * {@link _ResponsesReasoningEffortDriftGuard} below pins our union to that type
 * in BOTH directions at compile time, so a bumped SDK that adds or removes a
 * tier is a build error here rather than a silent divergence between what we
 * accept and what the provider accepts.
 *
 * Values callers do supply that are NOT in that union — notably `max` and
 * `default`, which are the SESSION-effort vocabulary (`src/agent/effort.ts`
 * `EffortLevel = "default" | "max" | "high" | "medium" | "low"`, surfaced by
 * `/effort` and by the terminal suite's agent-kwarg) — are `rejected`, loudly.
 * They are deliberately NOT mapped onto a neighbouring tier: inventing a wire
 * value the provider never documented is exactly the failure the closed set was
 * built to prevent, and guessing an equivalence (`max` ≈ `xhigh`?) would put a
 * fabricated number on a leaderboard row.
 *
 * Anthropic has no `reasoning.effort` field at all (`Messages.MessageCreateParams`,
 * @anthropic-ai/sdk@0.40.1 — the extended-thinking channel is
 * `thinking: { budget_tokens }`, fed by the SEPARATE `QUANTA_EFFORT` knob via
 * `src/agent/effort.ts` `effortToTokenBudget`). So on that surface a requested
 * effort is `unsupported` — an explicit, typed arm, not an absence.
 *
 * Slice discipline: pure leaf. Type-only import of the vendored SDK contract, no
 * runtime dependency, and it never reads `process.env` (env derivation stays at
 * the composition root, `src/llm/factory.ts`).
 */

import type { ReasoningEffort as OpenAISdkReasoningEffort } from "openai/resources/shared"
import { LLMError } from "@/shared"

/** The effort tiers the OpenAI Responses wire accepts. Mirrors the vendored SDK
 *  union (see the file header for the citation); `null` is excluded because our
 *  "no effort requested" case is modelled by the `absent` decision arm, not by a
 *  null on the body. */
export type ResponsesReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

/** Ordered, lowest-to-highest. Exported so callers can render the accepted set
 *  in an error/usage message instead of hand-maintaining a second copy. */
export const RESPONSES_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ResponsesReasoningEffort[]

// Compile-time drift guard, BOTH directions, against the vendored provider
// contract. `satisfies` above only proves every array entry is in our union; the
// asserts below prove (a) our union is exactly the SDK's union minus `null`, and
// (b) every union member is listed in the array. Bump the SDK and add/remove a
// tier without touching this file → build error, not a silent set mismatch.
type _Assert<T extends true> = T
export type _ResponsesReasoningEffortDriftGuard = _Assert<
  [ResponsesReasoningEffort] extends [NonNullable<OpenAISdkReasoningEffort>]
    ? [NonNullable<OpenAISdkReasoningEffort>] extends [ResponsesReasoningEffort]
      ? true
      : false
    : false
>
export type _ResponsesReasoningEffortListDriftGuard = _Assert<
  ResponsesReasoningEffort extends (typeof RESPONSES_REASONING_EFFORTS)[number] ? true : false
>

const RESPONSES_REASONING_EFFORT_SET: ReadonlySet<string> = new Set<string>(
  RESPONSES_REASONING_EFFORTS,
)

/** The surfaces a reasoning effort can be routed to. Mirrors the adapters'
 *  `surfaceId`s; `anthropic-messages` is the arm with NO effort field. */
export type ReasoningEffortSurface = "openai-responses" | "chatgpt-oauth" | "anthropic-messages"

/**
 * The TOTAL outcome of asking "can this reasoning effort reach the provider?".
 *
 * The whole point of this union is that there is no arm meaning "dropped, and
 * you will never know". `absent` is the ONLY silent arm, and it is reachable
 * only when the caller genuinely requested nothing.
 */
export type ReasoningEffortDecision =
  /** No effort was requested (undefined / empty / whitespace-only). The provider
   *  applies its own default and nothing is reported — honestly. */
  | { readonly kind: "absent" }
  /** The effort goes on the wire verbatim as `reasoning.effort`. */
  | { readonly kind: "delivered"; readonly effort: ResponsesReasoningEffort }
  /** An effort was requested on a surface that DOES deliver effort, but the
   *  value is not one the provider accepts. Never downgraded — reported. */
  | {
      readonly kind: "rejected"
      readonly requested: string
      readonly surface: ReasoningEffortSurface
      readonly supported: readonly ResponsesReasoningEffort[]
    }
  /** An effort was requested on a surface with NO reasoning-effort field at all
   *  (Anthropic Messages). Explicit arm, not an absence. */
  | {
      readonly kind: "unsupported"
      readonly requested: string
      readonly surface: ReasoningEffortSurface
    }

/** True iff the decision means "the provider will receive exactly what was
 *  requested, or nothing was requested". The two failure arms are false. */
export const isReasoningEffortHonest = (d: ReasoningEffortDecision): boolean =>
  d.kind === "absent" || d.kind === "delivered"

/** The effort actually placed on the wire, or `undefined` when none is. Use ONLY
 *  after {@link assertReasoningEffortDeliverable} — this narrowing is what the
 *  old normalizer returned, and on its own it re-creates the silent collapse. */
export const deliveredReasoningEffort = (
  d: ReasoningEffortDecision,
): ResponsesReasoningEffort | undefined => (d.kind === "delivered" ? d.effort : undefined)

/**
 * Decide, totally, what happens to `requested` on `surface`.
 *
 * Absent / empty / whitespace-only ⇒ `absent`. This matches the sibling
 * resolvers (`normalizeResponsesServiceTier` treats `""` as "unset", and
 * `src/agent/effort.ts` `parseEffort` trims to `undefined`), so
 * `QUANTA_REASONING_EFFORT=""` keeps meaning "not set" rather than becoming a
 * spurious hard failure.
 *
 * Matching is case-insensitive and the DELIVERED value is the lowercased form —
 * byte-identical to the previous normalizer for every in-set value.
 */
export const decideReasoningEffort = (
  requested: string | undefined,
  surface: ReasoningEffortSurface,
): ReasoningEffortDecision => {
  if (requested === undefined) return { kind: "absent" }
  const trimmed = requested.trim()
  if (trimmed === "") return { kind: "absent" }
  if (surface === "anthropic-messages") {
    return { kind: "unsupported", requested: trimmed, surface }
  }
  const normalized = trimmed.toLowerCase()
  if (RESPONSES_REASONING_EFFORT_SET.has(normalized)) {
    return { kind: "delivered", effort: normalized as ResponsesReasoningEffort }
  }
  return {
    kind: "rejected",
    requested: trimmed,
    surface,
    supported: RESPONSES_REASONING_EFFORTS,
  }
}

/** Convenience alias for the Responses wire, which is only ever asked about its
 *  own surface. Kept so wire-level call sites read as one argument. */
export const decideResponsesReasoningEffort = (
  requested: string | undefined,
): ReasoningEffortDecision => decideReasoningEffort(requested, "openai-responses")

/** Human-readable explanation of a non-honest decision. Exhaustive over the
 *  union so a new arm is a compile error rather than a missing message. */
export const describeReasoningEffortDecision = (d: ReasoningEffortDecision): string => {
  switch (d.kind) {
    case "absent":
      return "no reasoning effort requested"
    case "delivered":
      return `reasoning effort "${d.effort}" is sent to the provider`
    case "rejected":
      return (
        `reasoning effort "${d.requested}" is not accepted by the ${d.surface} surface ` +
        `(accepted: ${d.supported.join(", ")}). Refusing to send the request: silently ` +
        `falling back to the provider default would report an effort the provider never received.`
      )
    case "unsupported":
      return (
        `reasoning effort "${d.requested}" cannot be delivered — the ${d.surface} surface has no ` +
        `reasoning-effort field. Unset QUANTA_REASONING_EFFORT for this provider, or use ` +
        `QUANTA_EFFORT (the session thinking-budget knob) instead. Refusing to run: reporting ` +
        `an effort the provider never received would be a false receipt.`
      )
  }
}

/**
 * Fail loud on the two non-honest arms. This is the choke point that converts
 * "silently dropped" into "did not start".
 *
 * `kind: "bad_request"` is a FATAL kind (never retried — `src/llm/retry/
 * decorator-policy.ts` FATAL set), which is correct: no amount of retrying fixes
 * a misconfigured effort.
 */
export const assertReasoningEffortDeliverable = (d: ReasoningEffortDecision): void => {
  if (isReasoningEffortHonest(d)) return
  throw new LLMError(describeReasoningEffortDecision(d), { kind: "bad_request" })
}

/**
 * The CONSTRUCTION-time assert: fatal on `rejected` only.
 *
 * Why this is narrower than {@link assertReasoningEffortDeliverable} — the harm
 * being prevented is MISREPORTING, and misreporting only happens where there is
 * a report. The two failure arms are not equally harmful at adapter build time:
 *
 *  - `rejected` — the surface DOES carry `reasoning.effort` and the caller named
 *    a value it will not accept. Sending it 400s and dropping it silently
 *    changes the effort actually used. Fatal everywhere: no report needed for
 *    this to be wrong.
 *  - `unsupported` — the surface has NO effort field at all (Anthropic
 *    Messages). Nothing is misreported by merely constructing an adapter; the
 *    lie would only appear if a RECEIPT later claimed the requested effort. So
 *    the receipt path — not adapter construction — is the right choke point.
 *
 * Making `unsupported` fatal here regressed the default interactive provider:
 * `resolveProvider` falls back to `anthropic` (factory.ts — `ANTHROPIC_API_KEY`
 * present, or no key at all), the Tauri daemon forwards
 * `QUANTA_REASONING_EFFORT`, and the web `/effort` slash writes it — so one
 * `/effort medium` bricked every subsequent turn of a working session over a
 * benign misconfiguration.
 *
 * The invariant is unchanged, because the decision stays TOTAL and observable:
 * anything that builds a receipt MUST gate on {@link isReasoningEffortHonest}
 * and report {@link deliveredReasoningEffort} — never the requested string — and
 * bench composition roots call {@link assertReasoningEffortDeliverable} so a
 * benchmark still refuses to start rather than misreport.
 */
export const assertReasoningEffortAcceptedByWire = (d: ReasoningEffortDecision): void => {
  if (d.kind !== "rejected") return
  throw new LLMError(describeReasoningEffortDecision(d), { kind: "bad_request" })
}

/**
 * Decide + assert in one step, returning the wire value (or `undefined` when
 * nothing was requested). The ONLY sanctioned way to go from a caller-supplied
 * string to a wire value: it is impossible to reach the `undefined` return with
 * a non-empty out-of-set input, because that path throws.
 */
export const resolveDeliverableReasoningEffort = (
  requested: string | undefined,
  surface: ReasoningEffortSurface,
): ResponsesReasoningEffort | undefined => {
  const decision = decideReasoningEffort(requested, surface)
  assertReasoningEffortDeliverable(decision)
  return deliveredReasoningEffort(decision)
}
