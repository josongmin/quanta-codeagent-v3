/**
 * `/doctor` self-check — pure leaf types (RFC jun-6-doctor-selfcheck §4.1–4.2).
 *
 * The check-registry is a PURE leaf: every check is `(probes) => CheckResult`
 * with all subsystem access injected as a duck-typed {@link DoctorProbes}.
 * The leaf imports NOTHING from `@/auth` / `@/mcp` / `@/session` / `@/shared`;
 * the CLI surface (`doctor-cmd.ts`) wires real probes over the existing
 * accessors (closed-port DI — no `Date.now` / `process.env` / network here).
 */

export type CheckStatus = "ok" | "warn" | "fail"

export interface CheckResult {
  /** Stable check id:
   *  `"auth" | "terminal" | "mcp" | "config" | "state-db" | "store-health"`. */
  readonly id: string
  readonly status: CheckStatus
  /** What was found, human-readable (e.g. `no OPENAI_API_KEY`). */
  readonly detail: string
  /** The "왜 안 되지" fix, present on `warn`/`fail` when actionable. */
  readonly remedy?: string
}

/** A single check fn — pure given its probes, deterministic + unit-testable. */
export type CheckFn = (probes: DoctorProbes) => Promise<CheckResult>

/** A registry entry: the check fn bound to its stable `id`. Keeping the id ON
 *  the entry (vs a parallel id array) means a reorder can never mis-attribute a
 *  throw-before-result `fail` — the id travels with the fn. */
export interface Check {
  readonly id: string
  readonly run: CheckFn
}

/** Auth probe shape (redacted — presence/expiry only, never the key value). */
export interface AuthProbeResult {
  readonly provider: string
  readonly keyPresent: boolean
  /** Effective LLM transport id (`legacy` or cloud id). Separate from `provider`. */
  readonly effectiveTransport?: string
  readonly transportReason?: string
  /** `true` if a token exists but is past expiry; omitted when no token. */
  readonly tokenExpired?: boolean
  /** `true` if a token is valid but within the near-expiry window ⇒ warn. */
  readonly tokenExpiringSoon?: boolean
}

export interface TerminalProbeResult {
  readonly isTTY: boolean
  readonly columns: number
  readonly rawModeAvailable: boolean
}

export interface McpServerProbe {
  readonly name: string
  readonly connected: boolean
  readonly toolCount?: number
  readonly error?: string
}

export interface ConfigProbeResult {
  readonly loaded: boolean
  /** Dead-knob / no-op conditions (e.g. `mcpSampling` ON without a handler). */
  readonly warnings: readonly string[]
  /** Validation error when `loaded` is `false`. */
  readonly error?: string
}

export interface StateDbProbeResult {
  readonly sessionsReadable: boolean
  readonly indexValid: boolean
  readonly memoryReadable?: boolean
  readonly error?: string
}

/** UUX-4-05 — aggregate session-store health view. Structural mirror of
 *  `@/session`'s `StoreHealthReport` (the leaf never imports `@/session`;
 *  the surface probe returns the real report, which is assignable to this
 *  view). `guidance` carries the operator recovery steps the store module
 *  composes for non-healthy verdicts. */
export interface StoreHealthProbeResult {
  readonly verdict: "empty" | "healthy" | "degraded" | "corrupt"
  readonly total: number
  readonly ok: number
  readonly corrupt: number
  readonly unreadable: number
  readonly guidance?: string
}

/**
 * Injected, duck-typed subsystem accessors. Each is a thin reader the surface
 * builds over §3.2 of the RFC; a probe that throws is caught by its check and
 * rendered `fail` (graceful, mirroring `/status`'s error tolerance).
 */
export interface DoctorProbes {
  /** Injected clock — the auth-expiry check reads it, never `Date.now`. */
  readonly now: () => number
  readonly auth: () => Promise<AuthProbeResult>
  readonly terminal: () => TerminalProbeResult
  readonly mcp: () => Promise<readonly McpServerProbe[]>
  readonly config: () => ConfigProbeResult
  readonly stateDb: () => Promise<StateDbProbeResult>
  /** UUX-4-05 — aggregate store scan (`checkSessionStoreHealth`). The
   *  `stateDb` probe only proves `listSessions()` returns; this one detects
   *  the "every file refuses to load" / partially-corrupt store the index
   *  read silently masks as an empty list. */
  readonly storeHealth: () => Promise<StoreHealthProbeResult>
}

/** Minimum sane terminal width — below this, box rendering wraps badly.
 *  Named constant justified by a real failure mode (RFC §8 R2), not invented. */
export const MIN_TERMINAL_COLUMNS = 40
