/**
 * Custom 3P Setup — type model (ADR-0245).
 *
 * Closed unions per OCP discipline. Adding a `ProviderKind` arm forces a
 * sweep over every switch in the slice. Adding a `LifecycleState` arm or
 * a `HealthVerdict` arm has the same effect.
 *
 * exactOptionalPropertyTypes: omit absent optional fields. Never spread
 * `undefined` explicitly — compose with conditional spreads at the
 * call site.
 *
 * Plane-clean: no imports of `@/agent` / `@/permission` / `@/tool` /
 * `@/llm` / `@/mcp`. The custom-3p slice sits ABOVE `src/mcp/` (which
 * is unchanged) and is additive to the rest of `src/connectors/`.
 */

// ────────────────────────────────────────────────────────────────────────────
// ProviderId — brand to prevent string-mix-up at type-level.
// ────────────────────────────────────────────────────────────────────────────

/** Branded string — prevents accidental cross-id substitution. */
export type ProviderId = string & { readonly __brand: "ProviderId" }

/** Construct a `ProviderId` from a raw string. Idempotent + total. */
export const asProviderId = (raw: string): ProviderId => raw as ProviderId

// ────────────────────────────────────────────────────────────────────────────
// ProviderKind — closed 2-arm union.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Closed kind union. "mcp" = MCP server (stdio / ws endpoint).
 * "llm" = HTTP(s) LLM endpoint. Exhaustive switches MUST cover both.
 */
export type ProviderKind = "mcp" | "llm"

/** Closed auth-scheme union. Exhaustive switches MUST cover all three. */
export type ProviderAuth = "oauth" | "apiKey" | "none"

// ────────────────────────────────────────────────────────────────────────────
// ProviderSpec — what the user declares.
// ────────────────────────────────────────────────────────────────────────────

export interface ProviderSpec {
  readonly id: ProviderId
  readonly displayName: string
  readonly kind: ProviderKind
  /**
   * Endpoint URL. Validated by `kind`:
   *   - kind = "mcp" → ws://, wss://, or stdio: scheme
   *   - kind = "llm" → http:// or https:// scheme
   * Validation lives on the registry boundary so all impls share contract.
   */
  readonly endpoint: string
  readonly auth: ProviderAuth
  /** Optional caller-defined tag list. Frozen by registry on store. */
  readonly tags?: ReadonlyArray<string>
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle — closed 4-arm FSM.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Closed lifecycle union. Transitions:
 *
 *   register()          → draft
 *   update()  from draft → configured
 *   update()  from any other state → unchanged (mutation of spec ≠ state change)
 *   health()  ok        → healthy
 *   health()  any fail  → failing
 *   remove()            → row dropped (no terminal state)
 */
export type LifecycleState = "draft" | "configured" | "healthy" | "failing"

// ────────────────────────────────────────────────────────────────────────────
// HealthResult — closed verdict arm.
// ────────────────────────────────────────────────────────────────────────────

export type HealthVerdict = "ok" | "dns-fail" | "http-fail" | "auth-fail" | "timeout"

export interface HealthResult {
  readonly verdict: HealthVerdict
  /** Wall-clock ms when the probe was performed. */
  readonly checkedAt: number
  /** Probe latency in ms. Present iff the probe completed (verdict !== "timeout"). */
  readonly latencyMs?: number
}

// ────────────────────────────────────────────────────────────────────────────
// Typed errors — stable `code` arm so callers branch without string parse.
// ────────────────────────────────────────────────────────────────────────────

export type Custom3pErrorCode =
  | "duplicate-id"
  | "unknown-id"
  | "invalid-endpoint"
  | "store-write-failed"
  | "unsupported"

export class Custom3pError extends Error {
  readonly code: Custom3pErrorCode
  constructor(code: Custom3pErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "Custom3pError"
    this.code = code
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Exhaustiveness helper — compile-time check on closed unions.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness assertion. Use as the default arm of a
 * `switch` over a closed union. Runtime throw is a safety net; the real
 * value is the `never`-typed parameter — adding a new arm to the union
 * forces a compile error here.
 */
export const assertNever = (x: never): never => {
  throw new Custom3pError("unsupported", `unexpected variant: ${JSON.stringify(x)}`)
}
