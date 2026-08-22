/**
 * `@/sdk/errors` — public error taxonomy for the embed SDK (Phase 7).
 *
 * Every class pins a stable `name` and is `instanceof`-safe so a consumer's
 * `try/catch` can branch on the failure cause without string-matching.
 */

/** No LLM could be constructed: `opts.llm` absent AND no provider credential
 *  resolved from `opts.apiKey` / `opts.env`. Thrown from `createAnalysisAgent`
 *  BEFORE any run starts. */
export class NoCredentialError extends Error {
  override readonly name = "NoCredentialError"
  constructor(message = "no LLM provided and no provider credential resolved") {
    super(message)
    // Restore prototype chain under transpile-to-ES5 targets (instanceof-safe).
    Object.setPrototypeOf(this, NoCredentialError.prototype)
  }
}

// NOTE: cancellation is NOT an exception — `agent.abort()` surfaces as
// `outcome.reason === "aborted"`, so there is no `AgentAbortedError` (a
// documented-but-never-thrown class would be a false `catch` affordance).

/** Tool registry assembly failed — e.g. two tools share a `name`. Thrown from
 *  `createAnalysisAgent` while building the `ToolRegistry`. */
export class ToolRegistrationError extends Error {
  override readonly name = "ToolRegistrationError"
  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, ToolRegistrationError.prototype)
  }
}
