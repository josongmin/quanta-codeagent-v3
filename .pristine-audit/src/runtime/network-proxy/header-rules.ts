/**
 * ticket-13 (§12.2) — outbound HEADER-rewrite rules for the egress proxy.
 *
 * WHAT: a pure, ordered transform over the OUTBOUND request header map applied at
 *       BOTH proxy callsites (plaintext-HTTP `pipeBufferedHttp` and TLS-MITM
 *       `mitmForwardUpstream`). An operator declares a list of {@link HeaderRule}
 *       (`strip` / `set` / `append` / `rewrite`) to mutate the headers the proxy
 *       re-originates upstream. ALSO ships a redirect-hygiene helper
 *       ({@link shouldStripOnRedirect}) that mirrors Claude Code IDE's
 *       cross-origin token-strip (drop `authorization`/`cookie`/`host` when a
 *       redirect crosses origin).
 *
 * DISCIPLINE (load-bearing):
 *   - **DEFAULT-OFF / BYTE-IDENTICAL**: `rules` absent / empty ⇒ the SAME header
 *     object is returned UNCHANGED (referential identity). No rule list ⇒ today's
 *     behavior, byte-for-byte. Honored ONLY when MITM/egress is already gated on
 *     (the rules ride on the gated `MitmConfig`/`SecretEgressConfig`; this module
 *     introduces NO new env knob).
 *   - **REDACTION WINS**: this transform runs AFTER the secret-egress redaction
 *     pass (the caller drops/masks a leaking header BEFORE applying these rules),
 *     so a rule can NEVER revive a header redaction removed. Injected values are
 *     NOT re-scanned (operator-trusted — the operator authored the literal).
 *   - **FORBIDDEN-INJECT GUARD** (competitor-novel): a `set`/`append` targeting a
 *     sensitive credential header ({@link FORBIDDEN_INJECT}) is SILENTLY IGNORED
 *     (+ an audit `fired:false` entry) so an operator misconfig cannot inject an
 *     `authorization`/`cookie`/… value. This is a SEPARATE layer from redaction.
 *   - **FORBIDDEN-FRAMING GUARD** (request-smuggling / domain-fronting defense): a
 *     `set`/`append` targeting a framing/routing header ({@link FORBIDDEN_FRAMING}:
 *     `transfer-encoding`/`content-length`/`host`/`connection`/…) is SILENTLY
 *     IGNORED (+ `fired:false` audit `forbidden-framing`). These rules run BEFORE
 *     the proxy re-frames the request on its own upstream connection, so allowing
 *     them would let a rule re-inject a conflicting length/encoding (smuggling) or
 *     forge the Host (domain-fronting) past that fix. `strip`/`rewrite` of an
 *     already-present framing header stays allowed (mirrors the inject op-policy).
 *   - **CASE-INSENSITIVE**: header names are matched/normalized lowercase (HTTP
 *     header names are case-insensitive; node:http already lowercases).
 *   - **MALFORMED → SILENT-IGNORE**: a value-requiring op (`set`/`append`/
 *     `rewrite`) with no `value` is dropped (audit `fired:false`), never throws.
 *   - **NO-THROW NAME/VALUE VALIDATION (DoS guard)**: an unvalidated header NAME or
 *     VALUE would flow into the caller's `http.request()`/`https.request()` and
 *     throw SYNCHRONOUSLY inside a void-invoked async (`mitmForwardUpstream`),
 *     producing an unhandled rejection + a hung client. So BEFORE a rule mutates
 *     the map we validate the NAME (RFC7230 token / tchar — node's
 *     `validateHeaderName`, applied to EVERY op including `strip`) and the VALUE
 *     (no CR/LF/NUL — node's `validateHeaderValue`). Reusing node's OWN validators
 *     means we refuse EXACTLY what `http.request` would reject (no over/under-
 *     rejection). ANY violation ⇒ the rule is REFUSED as `malformed` (audit
 *     `fired:false`, the value is NEVER recorded), the header map is left UNTOUCHED
 *     + forwardable, and we NEVER throw.
 *
 * PURE / NO-THROW / NO I/O. The audit log is RETURNED to the caller (which appends
 * it to the proxy's existing in-memory log), not emitted here.
 */

import { validateHeaderName, validateHeaderValue } from "node:http"

/** A header map as the proxy carries it (node:http `IncomingHttpHeaders` shape):
 *  lowercase names → a single value or a multi-value array. */
export type MutableHeaders = Record<string, string | string[]>

/** One operator-authored header mutation. Applied in list order.
 *   - `strip`   — remove the header (no `value` needed).
 *   - `set`     — overwrite/create with `value` (single value).
 *   - `append`  — ADD `value` as an additional value (multi-value; distinct from
 *                 `set` — keeps any existing values).
 *   - `rewrite` — replace with `value` ONLY IF the header is already present
 *                 (no-op when absent — does NOT create).
 *  `value` is REQUIRED for `set`/`append`/`rewrite`; a missing value ⇒ the rule is
 *  malformed and silently ignored. */
export interface HeaderRule {
  readonly name: string
  readonly op: "strip" | "set" | "append" | "rewrite"
  readonly value?: string
}

/**
 * One audit-log entry: which rule fired (or was refused) against which header.
 * The header VALUE is NEVER recorded (it could carry a secret / token) — only the
 * rule index, the (lowercased) header name, the op, and whether it FIRED. A
 * `fired:false` entry with a `refused` reason makes a forbidden-inject / malformed
 * / no-op-rewrite VISIBLE without leaking the value (mirrors Cursor's
 * `logging.decision_log_path`).
 */
export interface HeaderRuleAudit {
  /** Index of the rule in the operator's list (stable rule id). */
  readonly index: number
  /** The lowercased header name the rule targeted. */
  readonly headerName: string
  readonly op: HeaderRule["op"]
  /** True iff the rule actually mutated the header map. */
  readonly fired: boolean
  /** Why a rule did NOT fire (only present when `fired` is false). */
  readonly refused?: "malformed" | "forbidden-inject" | "forbidden-framing" | "absent"
}

/** The result of applying a rule list: the (possibly new) header map + the audit
 *  trail. When `rules` is absent/empty `headers` is the INPUT object by reference
 *  (byte-identical) and `audit` is empty. */
export interface ApplyHeaderRulesResult {
  readonly headers: MutableHeaders
  readonly audit: readonly HeaderRuleAudit[]
}

/**
 * SSOT — credential/sensitive headers a `set`/`append` rule may NEVER INJECT.
 * Distinct from the secret-egress redaction layer: this defends against an
 * operator MISCONFIG that would forge an auth/session header on outbound traffic.
 * `strip`/`rewrite` are NOT forbidden (removing or rewriting an already-present
 * sensitive header is a legitimate hardening move; only *injecting* a new value
 * is refused). Lowercase, the canonical match form.
 */
export const FORBIDDEN_INJECT: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
])

/**
 * SSOT — FRAMING / ROUTING headers a `set`/`append` rule may NEVER INJECT.
 *
 * SECURITY RATIONALE (request-smuggling + domain-fronting): the proxy
 * re-originates the buffered request over its OWN upstream connection and applies
 * a framing-fix (recompute `content-length`, force `connection: close`, drop
 * hop-by-hop headers) AFTER these rules run. If an operator rule could `set` or
 * `append` one of these headers it would land on the wire AFTER that fix:
 *   - re-injecting a conflicting `transfer-encoding` / `content-length` desyncs the
 *     proxy↔upstream framing → CL.TE / TE.TE REQUEST SMUGGLING.
 *   - forging/overwriting `host` (or the `connection`/`keep-alive`/`proxy-
 *     connection`/`te`/`upgrade` hop-by-hop set) re-routes the request to a
 *     different vhost behind the same TLS SNI → DOMAIN-FRONTING, or smuggles a
 *     protocol-upgrade past the framing-fix.
 * The {@link FORBIDDEN_INJECT} credential guard does NOT cover these, so a
 * misconfig (or a hostile rule list) could otherwise slip them through.
 *
 * Op-policy MIRRORS {@link FORBIDDEN_INJECT}: only `set`/`append` (INJECTION) are
 * refused — `strip` / `rewrite` of an ALREADY-PRESENT framing header is a
 * legitimate hardening move (e.g. rewrite `connection: keep-alive` → `close`) and
 * stays allowed. Lowercase, the canonical match form.
 */
export const FORBIDDEN_FRAMING: ReadonlySet<string> = new Set([
  "transfer-encoding",
  "content-length",
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "upgrade",
])

/** Headers stripped when a redirect crosses ORIGIN (scheme+host+port). Mirrors
 *  Claude Code IDE's cross-origin token-strip — a redirect that leaves the origin
 *  must NOT carry the originating credentials/host onward (token-leak defense). */
export const CROSS_ORIGIN_STRIP_HEADERS: readonly string[] = ["authorization", "cookie", "host"]

/** Normalize a header name to its canonical lowercase match form. */
const norm = (name: string): string => name.trim().toLowerCase()

/** A value-requiring op with a usable (non-undefined) value? */
const hasValue = (rule: HeaderRule): rule is HeaderRule & { value: string } =>
  typeof rule.value === "string"

/**
 * Is `name` a header name `http.request` would ACCEPT (RFC7230 token / tchar)?
 * Delegates to node's OWN `validateHeaderName` (wrapped — it THROWS on a bad
 * name) so we refuse EXACTLY what the downstream request would reject. An empty
 * string (e.g. an all-whitespace name after `norm`) is rejected too. NO-THROW.
 */
const isLegalHeaderName = (name: string): boolean => {
  if (name.length === 0) return false
  try {
    validateHeaderName(name)
    return true
  } catch {
    return false
  }
}

/**
 * Is `value` a header value `http.request` would ACCEPT (no CR/LF/NUL)? Delegates
 * to node's OWN `validateHeaderValue` (wrapped — it THROWS on an illegal value).
 * Reusing node's validator means no over/under-rejection vs the real request.
 * NO-THROW.
 */
const isLegalHeaderValue = (name: string, value: string): boolean => {
  try {
    validateHeaderValue(name, value)
    return true
  } catch {
    return false
  }
}

/** Merge `value` as an ADDITIONAL value onto whatever `existing` holds (append
 *  semantics — keep prior values, build a multi-value array). PURE. */
const appendValue = (existing: string | string[] | undefined, value: string): string | string[] => {
  if (existing === undefined) return value
  return Array.isArray(existing) ? [...existing, value] : [existing, value]
}

/**
 * Apply ONE rule to the (in-progress) header map, returning the value-free audit
 * entry. Mutates `out` in place ONLY on a firing rule. Hoisted out of
 * {@link applyHeaderRules} so the list driver stays flat (low complexity) and the
 * op semantics live in one switch. PURE aside from the local `out` mutation.
 */
const applyOneRule = (out: MutableHeaders, rule: HeaderRule, index: number): HeaderRuleAudit => {
  const headerName = norm(rule.name)
  const present = Object.hasOwn(out, headerName)
  const fired = (): HeaderRuleAudit => ({ index, headerName, op: rule.op, fired: true })
  const refused = (why: NonNullable<HeaderRuleAudit["refused"]>): HeaderRuleAudit => ({
    index,
    headerName,
    op: rule.op,
    fired: false,
    refused: why,
  })

  // NO-THROW NAME validation (DoS guard) — applies to EVERY op, INCLUDING strip:
  // an illegal name (tab/space/parens/colon/NUL, or an all-whitespace → empty
  // name) would make the caller's http.request() throw synchronously. We refuse
  // it as malformed BEFORE touching the map. `headerName` is the trimmed +
  // lowercased form we would actually write/delete, so it is what we validate.
  if (!isLegalHeaderName(headerName)) return refused("malformed")

  if (rule.op === "strip") {
    if (!present) return refused("absent")
    delete out[headerName]
    return fired()
  }
  // set / append / rewrite all REQUIRE a value.
  if (!hasValue(rule)) return refused("malformed")
  // NO-THROW VALUE validation (DoS / header-injection guard): a CR/LF/NUL in the
  // value would let an operator literal smuggle an extra header (or crash the
  // request). Refuse as malformed — the value is NEVER recorded in the audit.
  if (!isLegalHeaderValue(headerName, rule.value)) return refused("malformed")
  // FORBIDDEN-INJECT GUARD: set/append must not FORGE a credential header.
  if ((rule.op === "set" || rule.op === "append") && FORBIDDEN_INJECT.has(headerName)) {
    return refused("forbidden-inject")
  }
  // FORBIDDEN-FRAMING GUARD: set/append must not RE-INJECT a framing/routing header
  // AFTER the proxy's framing-fix (request-smuggling + domain-fronting defense).
  // strip/rewrite of an already-present framing header stays allowed (see SSOT).
  if ((rule.op === "set" || rule.op === "append") && FORBIDDEN_FRAMING.has(headerName)) {
    return refused("forbidden-framing")
  }
  // rewrite: replace ONLY when already present; never create.
  if (rule.op === "rewrite" && !present) return refused("absent")

  out[headerName] = rule.op === "append" ? appendValue(out[headerName], rule.value) : rule.value
  return fired()
}

/**
 * Apply an ordered {@link HeaderRule} list to a header map.
 *
 * BYTE-IDENTICAL when `rules` is absent or empty: the INPUT object is returned BY
 * REFERENCE and the audit is empty (the proxy's existing path is untouched). When
 * rules are present a SHALLOW COPY is mutated (the input is never mutated in
 * place, so a caller holding the original sees no surprise mutation).
 *
 * Order matters: a later rule can undo an earlier one (e.g. `set X` then `strip
 * X`). Each rule's audit entry records whether it fired. PURE / NO-THROW.
 */
export const applyHeaderRules = (
  headers: MutableHeaders,
  rules?: readonly HeaderRule[],
): ApplyHeaderRulesResult => {
  // DEFAULT-OFF: no rules ⇒ the SAME object, byte-identical, zero audit.
  if (rules === undefined || rules.length === 0) {
    return { headers, audit: [] }
  }

  const out: MutableHeaders = { ...headers }
  const audit = rules.map((rule, index) => applyOneRule(out, rule, index))
  return { headers: out, audit }
}

/**
 * True when a redirect from `fromUrl` to `toUrl` crosses ORIGIN — i.e. the scheme,
 * host, OR port differ. When true the caller drops the cross-origin-sensitive
 * headers ({@link CROSS_ORIGIN_STRIP_HEADERS}: `authorization`/`cookie`/`host`) so
 * a redirect that leaves the origin cannot leak the originating credentials.
 *
 * Default scheme ports are normalized (http→80, https→443) so `http://h` vs
 * `http://h:80` is the SAME origin (no spurious strip). An UNPARSEABLE url is
 * treated as cross-origin (fail-closed — strip rather than risk a leak). PURE /
 * NO-THROW.
 */
export const shouldStripOnRedirect = (fromUrl: string, toUrl: string): boolean => {
  const from = parseOrigin(fromUrl)
  const to = parseOrigin(toUrl)
  // A url we cannot parse ⇒ fail-closed: treat as cross-origin (strip).
  if (from === null || to === null) return true
  return from.scheme !== to.scheme || from.host !== to.host || from.port !== to.port
}

/** The canonical origin tuple (scheme + lowercased host + effective port). */
interface Origin {
  readonly scheme: string
  readonly host: string
  readonly port: number
}

/** Default port for the well-known schemes (so `:80`/`:443` is not a spurious
 *  origin difference). Unknown scheme ⇒ `0` (only matches another `0`-port). */
const defaultPortFor = (scheme: string): number =>
  scheme === "https:"
    ? 443
    : scheme === "http:"
      ? 80
      : scheme === "ws:"
        ? 80
        : scheme === "wss:"
          ? 443
          : 0

const parseOrigin = (raw: string): Origin | null => {
  try {
    const u = new URL(raw)
    const scheme = u.protocol.toLowerCase()
    const port = u.port !== "" ? Number(u.port) : defaultPortFor(scheme)
    return { scheme, host: u.hostname.toLowerCase(), port }
  } catch {
    return null
  }
}
