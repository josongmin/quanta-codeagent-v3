/**
 * H7 — ROTATING CLOUD CREDENTIALS (executable CredentialSource port).
 *
 * Two capabilities, both driven by a user-configured SHELL COMMAND:
 *
 *   (a) MINT an API key — `apiKeyHelper`: a shell command that prints a freshly
 *       minted API key to stdout. TTL-cached (mirrors Claude Code's
 *       `apiKeyHelper` + `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). The cache is keyed
 *       by the helper command string; a second mint within the TTL window
 *       returns the cached key WITHOUT re-running the shell.
 *
 *   (b) REFRESH cloud creds before a provider call — `awsAuthRefresh` /
 *       `gcpAuthRefresh`: a shell command (`aws sso login`, `gcloud auth ...`)
 *       run BEFORE a Bedrock / Vertex call so the SDK default credential chain
 *       picks up freshly-rotated short-lived STS/SSO creds. TTL-throttled: at
 *       most one refresh per window per cloud, so a hot loop does not invoke the
 *       shell on every single LLM call.
 *
 * CLOSED-PORT DISCIPLINE (RFC §3.1 slice isolation): `@/llm` may import ONLY
 * `@/shared`. The shell-exec function, the trust predicate, and the clock are
 * therefore ALL dependency-injected — this module never imports `@/runtime`
 * (where `runShell` lives) nor `@/permission` (where the trust-scope registry
 * lives). The composition root (outside this slice) wires the real `runShell`
 * and the real trust check. This mirrors `oidc-federation.ts`, which DI's its
 * file / http / clock ports for the exact same reason.
 *
 * SECURITY:
 *   - TRUST GATE — a shell-command credential helper is sensitive (arbitrary
 *     command execution). It is gated behind the injected `isTrusted` predicate.
 *     When untrusted, the command is NEVER invoked and a typed
 *     `CredentialHelperError({code:"untrusted"})` surfaces.
 *   - NO-LEAK — the minted key / refreshed creds are NEVER echoed into an error
 *     message, the cache key, or any telemetry. A failing helper's stdout/stderr
 *     (which may contain a partially-minted secret) is DROPPED; only the exit
 *     code is surfaced.
 *   - NO-THROW-CRASH — every failure is a typed `CredentialHelperError`. A shell
 *     that throws (spawn EACCES, etc.) is caught and re-wrapped.
 *
 * DEFAULT-OFF: with no `apiKeyHelper` and no `*AuthRefresh` configured, the
 * port is an inert no-op: `mintApiKey()` returns `undefined` and
 * `refreshCloudCreds()` returns without shelling out. Adapters that hold a
 * no-config source behave byte-identically to the pre-H7 path.
 */

/** Result shape of the injected shell-exec fn — a structural subset of
 *  `@/runtime`'s `ShellResult` so the real `runShell` plugs in directly at the
 *  composition root without an adapter shim. */
export interface ShellExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Injected shell-exec port. The composition root passes a thin closure over
 *  `runShell(command, { inheritEnv: true })` (the helper needs the parent env
 *  to find `aws`/`gcloud` + their credential files — this is the operator's
 *  explicit, trust-gated opt-in). MUST resolve, never reject, on a non-zero
 *  exit (we branch on `exitCode`); a thrown rejection is still caught here. */
export type ShellExecFn = (command: string) => Promise<ShellExecResult>

/** Closed failure taxonomy for the credential helper. */
export type CredentialHelperErrorCode =
  /** The configured helper command exited non-zero (or the shell threw). The
   *  command's stdout/stderr are deliberately NOT carried (anti-leak). */
  | "helper-failed"
  /** The workspace is not trusted — a shell-command helper is refused before
   *  it can run. */
  | "untrusted"

/** Typed, no-leak error. Carries the cloud / capability tag and a stable
 *  `code`, but NEVER the helper's output (which may contain a secret). */
export class CredentialHelperError extends Error {
  readonly code: CredentialHelperErrorCode
  /** `"api-key" | "aws" | "gcp"` — which capability failed. Non-secret. */
  readonly capability: string

  constructor(code: CredentialHelperErrorCode, capability: string, message: string) {
    super(message)
    this.name = "CredentialHelperError"
    this.code = code
    this.capability = capability
  }
}

/** Which cloud's refresh command to run. */
export type CloudKind = "aws" | "gcp"

export interface CredentialSourceOptions {
  /** apiKeyHelper — shell command that mints an API key on stdout. Absent ⇒
   *  `mintApiKey()` is a no-op (returns undefined). */
  readonly apiKeyHelper?: string
  /** TTL for BOTH the minted-key cache AND the refresh throttle, in ms. Mirrors
   *  Claude's `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` semantic. Absent ⇒
   *  {@link DEFAULT_HELPER_TTL_MS}. */
  readonly apiKeyHelperTtlMs?: number
  /** awsAuthRefresh — shell command run before a Bedrock call. Absent ⇒
   *  `refreshCloudCreds("aws")` is a no-op. */
  readonly awsAuthRefresh?: string
  /** gcpAuthRefresh — shell command run before a Vertex call. Absent ⇒
   *  `refreshCloudCreds("gcp")` is a no-op. */
  readonly gcpAuthRefresh?: string
  /** Injected shell-exec port (the composition root wires `runShell`). */
  readonly shellExec: ShellExecFn
  /** Injected trust predicate. Returns true when the workspace is trusted to
   *  run an arbitrary helper command. A shell helper is BLOCKED when false. */
  readonly isTrusted: () => boolean
  /** Injected clock for the TTL cache (no `Date.now()` in this module — keeps
   *  it deterministically testable, matching oidc-federation). Absent ⇒
   *  `Date.now`. */
  readonly now?: () => number
}

/** The executable credential-source port. */
export interface CredentialSource {
  /** Mint (or return a TTL-cached) API key via `apiKeyHelper`. Returns
   *  `undefined` when no helper is configured (no-op). Throws a typed
   *  `CredentialHelperError` on failure / untrusted. */
  mintApiKey(): Promise<string | undefined>
  /** Run the configured cloud refresh command (TTL-throttled) before a provider
   *  call. No-op when the matching `*AuthRefresh` is unset. Throws a typed
   *  `CredentialHelperError` on failure / untrusted. */
  refreshCloudCreds(cloud: CloudKind): Promise<void>
}

/** Mirror of Claude Code's `apiKeyHelper` default TTL (5 minutes). Justified:
 *  short-lived STS/SSO creds typically live 15min–1h, and a 5-minute mint cache
 *  amortizes the shell cost while staying well inside the shortest window.
 *  ONLY used when the operator does not pin `apiKeyHelperTtlMs`. */
export const DEFAULT_HELPER_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  readonly value: string
  readonly mintedAt: number
}

/**
 * Construct an executable CredentialSource. Pure factory — no I/O, no env read
 * (all I/O is the injected `shellExec`; all config arrives via options).
 */
export const createCredentialSource = (opts: CredentialSourceOptions): CredentialSource => {
  const ttlMs = opts.apiKeyHelperTtlMs ?? DEFAULT_HELPER_TTL_MS
  const now = opts.now ?? Date.now

  // Minted-key cache, keyed by the helper COMMAND (not by the secret). A new
  // command string ⇒ a fresh mint.
  const keyCache = new Map<string, CacheEntry>()
  // Per-cloud last-refresh timestamps for the throttle.
  const refreshAt = new Map<CloudKind, number>()

  // COALESCING (single-flight) — N concurrent callers that all observe a cache
  // MISS / throttle-elapsed must NOT each spawn a redundant shell. Without this,
  // a fallback stack or parallel adapters that share ONE source would fire
  // `aws sso login` / the mint helper once PER caller (arbitrary command
  // execution × N + cloud-auth-endpoint rate-limiting). We pin the in-flight
  // promise keyed by the helper command; concurrent callers AWAIT the same
  // promise and the shell runs exactly once. The entry is cleared in a `finally`
  // so a later (post-TTL) call re-shells, and a FAILED attempt is NOT pinned
  // (the next caller retries rather than inheriting a thrown rejection forever).
  const mintInflight = new Map<string, Promise<string>>()
  const refreshInflight = new Map<CloudKind, Promise<void>>()

  /** Run a helper command through the injected shell, gated by trust and with
   *  full no-throw / no-leak handling. Returns trimmed stdout on success. */
  const runHelper = async (command: string, capability: string): Promise<string> => {
    if (!opts.isTrusted()) {
      throw new CredentialHelperError(
        "untrusted",
        capability,
        `credential helper for "${capability}" refused: workspace is not trusted`,
      )
    }
    let result: ShellExecResult
    try {
      result = await opts.shellExec(command)
    } catch (cause) {
      // A thrown shell (spawn EACCES, etc.) — re-wrap as typed, DROP the cause's
      // message (it may echo the command/args; keep it out of the typed error).
      void cause
      throw new CredentialHelperError(
        "helper-failed",
        capability,
        `credential helper for "${capability}" failed to execute`,
      )
    }
    if (result.exitCode !== 0) {
      // NO-LEAK: never interpolate stdout/stderr (may carry a partial secret).
      throw new CredentialHelperError(
        "helper-failed",
        capability,
        `credential helper for "${capability}" exited with code ${result.exitCode}`,
      )
    }
    // NOTE: empty/whitespace stdout is NOT rejected here — a `*AuthRefresh`
    // command (`aws sso login`) legitimately prints nothing and the adapters
    // only care that it ran without error. The MINT path enforces non-empty at
    // its own call site (where stdout IS the key).
    return result.stdout.trim()
  }

  return {
    async mintApiKey(): Promise<string | undefined> {
      const command = opts.apiKeyHelper
      if (command === undefined || command.length === 0) return undefined

      const cached = keyCache.get(command)
      if (cached !== undefined && now() - cached.mintedAt < ttlMs) {
        return cached.value
      }
      // Single-flight: a concurrent mint for the same command shares ONE shell.
      const inflight = mintInflight.get(command)
      if (inflight !== undefined) return inflight

      const run = (async (): Promise<string> => {
        const value = await runHelper(command, "api-key")
        if (value.length === 0) {
          // A helper that exits 0 yet prints nothing (or only whitespace) did NOT
          // mint a key. Caching/returning "" would pin a broken credential for the
          // whole TTL window AND let a `mint ?? envKey` consumer silently override
          // a working env key with an empty string. Treat as a typed failure — we
          // throw BEFORE writing the cache, so the empty value is never pinned.
          // NO-LEAK preserved (no stdout interpolated).
          throw new CredentialHelperError(
            "helper-failed",
            "api-key",
            `credential helper for "api-key" produced no output (empty key)`,
          )
        }
        keyCache.set(command, { value, mintedAt: now() })
        return value
      })()
      mintInflight.set(command, run)
      try {
        return await run
      } finally {
        // Clear so the NEXT (post-TTL) mint re-runs, and a failed attempt is not
        // pinned (a later caller retries instead of inheriting the rejection).
        mintInflight.delete(command)
      }
    },

    async refreshCloudCreds(cloud: CloudKind): Promise<void> {
      const command = cloud === "aws" ? opts.awsAuthRefresh : opts.gcpAuthRefresh
      if (command === undefined || command.length === 0) return

      const last = refreshAt.get(cloud)
      if (last !== undefined && now() - last < ttlMs) {
        // Throttled — a refresh already ran within this window.
        return
      }
      // Single-flight: concurrent refreshes for the same cloud share ONE shell.
      const inflight = refreshInflight.get(cloud)
      if (inflight !== undefined) return inflight

      const run = (async (): Promise<void> => {
        // Run (trust-gated). On success, stamp the throttle. The minted stdout of
        // a refresh command is irrelevant (the SDK re-reads its own cred files);
        // we only care that it ran without error.
        await runHelper(command, cloud)
        refreshAt.set(cloud, now())
      })()
      refreshInflight.set(cloud, run)
      try {
        await run
      } finally {
        refreshInflight.delete(cloud)
      }
    },
  }
}
