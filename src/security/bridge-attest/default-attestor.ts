/**
 * Default in-process attestor (ADR-0246).
 *
 * Implements {@link BridgeAttestor} with:
 *   - policy-table lookup (action → allow|deny|prompt-user; default = prompt-user on miss)
 *   - HMAC-SHA256 token mint over `${scope}|${expiresAt}|${nonce}` with a
 *     16-byte random nonce
 *   - injectable `clock` for test-time TTL determinism
 *   - injectable `onEvent` for the 9-event lifecycle stream (default no-op)
 *   - secret fallback: when no `secret` is supplied, falls back to the literal
 *     `"test-secret"` string with a one-shot `logger.warn` — keeps unit tests
 *     and headless smoke from panicking but makes a real-deployment misconfig
 *     visible in the log.
 *
 * Plane discipline: imports `node:crypto` + `@/shared/logger` ONLY. No
 * `@/agent`, no `@/permission`, no `@/observability`.
 *
 * NO-THROW: `preflight` never throws; internal failures surface as
 * `{ kind: "deny", reason }` + a `preflight-error` audit event.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { errMessage } from "@/shared"
import { logger } from "@/shared/logger"
import type { BridgeAttestor } from "./port"
import type {
  AttestEvent,
  AttestEventSink,
  AttestRequest,
  AttestResult,
  PolicyTable,
  StsToken,
} from "./types"

/**
 * Constructor options. All fields optional with documented defaults — the
 * hellgate suite asserts every default by symbol.
 */
export interface DefaultAttestorOpts {
  /** HMAC-SHA256 signing secret. MISSING → falls back to `"test-secret"` + warn. */
  readonly secret?: string
  /** action → verdict table. Default `{}` (every action → prompt-user). */
  readonly policyTable?: PolicyTable
  /** Injectable clock (epoch-ms). Default `Date.now`. */
  readonly clock?: () => number
  /** 9-event stream subscriber. Default no-op (default-OFF). */
  readonly onEvent?: AttestEventSink
}

/** Fallback secret when none supplied — visibly mis-configured. */
const FALLBACK_SECRET = "test-secret"

// STS token TTL — 5 minutes by default. Matches AWS STS short-lived
// credential convention; long enough for typical preflight→action latency,
// short enough to bound exposure on accidental leak.
const DEFAULT_STS_TOKEN_TTL_MS = 300_000

/** Warn once per process when fallback secret is used. */
let warnedFallback = false

/** Reset the one-shot fallback warning latch — test-only helper. */
export const __resetFallbackWarnedForTests = (): void => {
  warnedFallback = false
}

/** Build the canonical signing payload — kept centralised so mint + verify
 *  hash identical bytes. */
const buildPayload = (scope: string, expiresAt: number, nonce: string): string =>
  `${scope}|${expiresAt}|${nonce}`

/** base64url-encode without padding. Mirrors RFC 4648 §5. */
const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Decode a base64url token into its 3-part envelope. Returns null on any
 *  shape failure — verify treats null as a tamper signal. */
interface TokenEnvelope {
  readonly scope: string
  readonly expiresAt: number
  readonly nonce: string
  readonly mac: string
}

const decodeToken = (token: string): TokenEnvelope | null => {
  if (typeof token !== "string" || token.length === 0) return null
  // Token shape: base64url(scope) "." base64url(expiresAt) "." base64url(nonce) "." base64url(mac)
  const parts = token.split(".")
  if (parts.length !== 4) return null
  const [s, e, n, m] = parts
  if (!s || !e || !n || !m) return null
  try {
    const scope = Buffer.from(s, "base64url").toString("utf8")
    const expiresAt = Number(Buffer.from(e, "base64url").toString("utf8"))
    const nonce = Buffer.from(n, "base64url").toString("utf8")
    if (!Number.isFinite(expiresAt)) return null
    return { scope, expiresAt, nonce, mac: m }
  } catch {
    return null
  }
}

/** Mint the 4-part token. The MAC is computed over the canonical payload so
 *  verify can recompute byte-identical input. */
const encodeToken = (secret: string, scope: string, expiresAt: number, nonce: string): string => {
  const payload = buildPayload(scope, expiresAt, nonce)
  const mac = createHmac("sha256", secret).update(payload).digest()
  return [
    b64url(Buffer.from(scope, "utf8")),
    b64url(Buffer.from(String(expiresAt), "utf8")),
    b64url(Buffer.from(nonce, "utf8")),
    b64url(mac),
  ].join(".")
}

/** Constant-time MAC compare. `timingSafeEqual` requires equal-length buffers
 *  — pad-or-reject pattern returns false on length mismatch. */
const macEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, "base64url")
  const bb = Buffer.from(b, "base64url")
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Monotonic request-id — `att-<ms>-<rand>` is enough for in-process audit. */
const nextRequestId = (clock: () => number): string =>
  `att-${clock()}-${randomBytes(4).toString("hex")}`

/**
 * Construct the default attestor.
 *
 * Returns a fresh instance with its own revoke-set; safe to construct multiple
 * concurrent attestors (e.g. per-session).
 */
export const defaultAttestor = (opts: DefaultAttestorOpts = {}): BridgeAttestor => {
  let secret = opts.secret ?? ""
  if (secret.length === 0) {
    secret = FALLBACK_SECRET
    if (!warnedFallback) {
      warnedFallback = true
      logger.warn(
        "[bridge-attest] no secret supplied — falling back to test-secret. This is INSECURE for production.",
      )
    }
  }
  const policyTable: PolicyTable = opts.policyTable ?? {}
  const clock = opts.clock ?? Date.now
  const onEvent: AttestEventSink = opts.onEvent ?? (() => {})
  const revoked = new Set<string>()

  const emit = (ev: AttestEvent): void => {
    try {
      onEvent(ev)
    } catch {
      // Subscriber must not break the attestor. Swallow + carry on.
    }
  }

  const mintTokenInternal = async (
    scope: string,
    ttlMs: number,
    requestId: string,
  ): Promise<StsToken> => {
    const now = clock()
    const expiresAt = now + Math.max(0, ttlMs)
    const nonce = randomBytes(16).toString("hex")
    const token = encodeToken(secret, scope, expiresAt, nonce)
    emit({ kind: "token-minted", requestId, at: now, scope, expiresAt })
    return { token, expiresAt, scope }
  }

  /** Handle a `deny` verdict — single emit pair + return shape. Extracted from
   *  `preflight` to keep cognitive complexity under the biome cap. */
  const handleDeny = (requestId: string, reason: string): AttestResult => {
    emit({ kind: "preflight-denied", requestId, at: clock(), reason })
    emit({ kind: "attest-audit", requestId, at: clock(), summary: `deny: ${reason}` })
    return { kind: "deny", reason }
  }

  /** Handle a `prompt-user` verdict. Returns the canonical 2-arm shape that
   *  honours exactOptionalPropertyTypes (omit `reason` when absent). */
  const handlePromptUser = (requestId: string, reason: string | undefined): AttestResult => {
    emit({
      kind: "attest-audit",
      requestId,
      at: clock(),
      summary: `prompt-user${reason ? `: ${reason}` : ""}`,
    })
    return reason !== undefined ? { kind: "prompt-user", reason } : { kind: "prompt-user" }
  }

  /** Handle an `allow` verdict — mints a 5-minute STS token by default; caller
   *  can `mintToken` separately if a different TTL is needed. */
  const handleAllow = async (requestId: string, req: AttestRequest): Promise<AttestResult> => {
    const scope = `${req.action}:${req.resource}`
    const stsToken = await mintTokenInternal(scope, DEFAULT_STS_TOKEN_TTL_MS, requestId)
    emit({ kind: "preflight-granted", requestId, at: clock(), scope })
    emit({ kind: "attest-audit", requestId, at: clock(), summary: `allow: ${scope}` })
    return { kind: "allow", stsToken }
  }

  const preflight = async (req: AttestRequest): Promise<AttestResult> => {
    const requestId = nextRequestId(clock)
    const at = clock()
    emit({ kind: "preflight-requested", requestId, at, action: req.action })
    try {
      const verdict = policyTable[req.action] ?? { kind: "prompt-user" as const }
      if (verdict.kind === "deny") return handleDeny(requestId, verdict.reason)
      if (verdict.kind === "prompt-user") return handlePromptUser(requestId, verdict.reason)
      return await handleAllow(requestId, req)
    } catch (e) {
      const error = errMessage(e)
      emit({ kind: "preflight-error", requestId, at: clock(), error })
      emit({ kind: "attest-audit", requestId, at: clock(), summary: `error: ${error}` })
      return { kind: "deny", reason: `preflight failed: ${error}` }
    }
  }

  const mintToken = async (scope: string, ttlMs: number): Promise<StsToken> => {
    const requestId = nextRequestId(clock)
    return mintTokenInternal(scope, ttlMs, requestId)
  }

  const verify = async (token: string, scope: string): Promise<boolean> => {
    const requestId = nextRequestId(clock)
    const at = clock()
    const env = decodeToken(token)
    if (!env) {
      return false
    }
    if (env.scope !== scope) {
      return false
    }
    if (revoked.has(token)) {
      return false
    }
    if (at > env.expiresAt) {
      emit({ kind: "token-expired", requestId, at, scope: env.scope })
      return false
    }
    // Recompute MAC and constant-time compare.
    const expected = encodeToken(secret, env.scope, env.expiresAt, env.nonce).split(".")[3]
    if (!expected) return false
    if (!macEqual(env.mac, expected)) {
      return false
    }
    emit({ kind: "token-used", requestId, at, scope: env.scope })
    return true
  }

  const revoke = async (token: string): Promise<void> => {
    const requestId = nextRequestId(clock)
    const env = decodeToken(token)
    revoked.add(token)
    if (env) {
      emit({ kind: "token-revoked", requestId, at: clock(), scope: env.scope })
    }
  }

  return { preflight, mintToken, verify, revoke }
}
