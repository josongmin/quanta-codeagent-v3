/** Advisor consult port — ADR-0257.
 *
 *  The narrow, DUCK-TYPED surface the agent-callable `advisor` tool consumes to
 *  get a SECOND OPINION from a STRONGER / DIFFERENT model mid-loop. The tool
 *  hands a question (+ optional context + optional explicit model) to
 *  {@link AdvisorPort.consult}; the port runs a ONE-SHOT model completion and
 *  returns the analysis in-band.
 *
 *  WHY A PORT (and not a direct `@/llm` call in the tool): the tool stays a pure
 *  consult that knows NOTHING about HOW the second opinion is produced (which
 *  provider, role resolution via ADR-0256 'advisor' role, allowlist
 *  enforcement, system framing). All of that lives in the composition root in
 *  `@/agent/tier1/advisor`, which adapts a concrete `LLMPort` + model allowlist
 *  + role resolver into this narrow port at wire time. The `@/tool` slice
 *  therefore neither imports `@/agent` nor depends on the concrete LLM wiring.
 *
 *  CONTRACT — NO-THROW for operational failures. `consult()` MUST surface every
 *  operational failure (advisor model error, timeout, cancellation, an
 *  upstream-rejected model) as an `ok:false` {@link AdvisorConsultResult} with a
 *  typed {@link AdvisorErrorKind}, never as a throw. The tool additionally
 *  guards against a port that breaks this contract by throwing (a
 *  programmer-bug path) and collapses it to a graceful `ok:false`. `listModels`
 *  is a pure read — never throws. */

/** Closed error-kind union surfaced on an `ok:false` consult result. Adding a
 *  value MUST extend this union AND every exhaustive switch (compile error).
 *   - `model-not-allowlisted` — an explicit `model` was not in the allowlist
 *     (the tool rejects this BEFORE reaching the port; the port may also emit
 *     it if its own resolution rejects).
 *   - `advisor-error`         — the advisor model call failed (provider error).
 *   - `timeout`               — the consult exceeded its deadline.
 *   - `cancelled`             — the parent signal aborted the consult.
 *   - `empty-analysis`        — the advisor returned no usable text. */
export type AdvisorErrorKind =
  | "model-not-allowlisted"
  | "advisor-error"
  | "timeout"
  | "cancelled"
  | "empty-analysis"

/** The request the tool hands to the port. `model` is OPTIONAL — when omitted
 *  the port resolves the advisor model itself (ADR-0256 'advisor' role →
 *  configured default). When present it has ALREADY been validated against the
 *  allowlist by the tool, so the port can trust it. `signal` chains the
 *  parent's cancellation so an abort on the parent unwinds the consult. */
export interface AdvisorConsultRequest {
  readonly question: string
  readonly context?: string
  readonly model?: string
  readonly signal?: AbortSignal
}

/** The ONLY shape that crosses back from the port. `ok:true` carries the
 *  advisor's analysis + the model that produced it; `ok:false` carries the
 *  typed {@link AdvisorErrorKind} + a human message. */
export type AdvisorConsultResult =
  | { readonly ok: true; readonly analysis: string; readonly modelUsed: string }
  | { readonly ok: false; readonly errorKind: AdvisorErrorKind; readonly errorMessage: string }

/** Narrow advisor port the `advisor` tool consumes. Two methods: a no-throw
 *  one-shot consult + a pure allowlist enumeration the tool uses to validate an
 *  explicit `model` (fail-closed) and to render the choice list in the
 *  description. */
export interface AdvisorPort {
  consult(req: AdvisorConsultRequest): Promise<AdvisorConsultResult>
  /** The set of model ids an explicit `model` argument may name. An EMPTY list
   *  means "no explicit model is accepted" — every explicit `model` is rejected
   *  and the caller must omit it (the port then resolves the default). */
  listModels(): readonly string[]
}
