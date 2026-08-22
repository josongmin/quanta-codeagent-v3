/**
 * ADR-0312 — multi-installation webhook secret resolver.
 *
 * ── THE KEY DESIGN PROBLEM ────────────────────────────────────────────────
 * The HMAC (`X-Hub-Signature-256`) MUST be verified against the RAW request
 * body BEFORE the JSON is parsed — but the installation / app id that would
 * tell us WHICH secret to verify against lives INSIDE that (still-untrusted,
 * unparsed) payload. We cannot parse-then-trust: a forged body could name any
 * installation it likes. So the discriminator MUST come from a channel that is
 * fixed by the operator and available pre-parse.
 *
 * ── DECISION: PATH-based routing (option a) ───────────────────────────────
 * The webhook URL path selects the secret: `/webhook/<appKey>`. The operator
 * configures, in each GitHub App's webhook settings, a distinct delivery URL
 * (e.g. `https://host/webhook/billing-app`), and maps that key → secret here.
 * The key is read from `req.path` — fixed by the operator, present before any
 * body parse, O(1) to resolve, and FAIL-CLOSED (an unknown key resolves to no
 * secret ⇒ 401, the body is never parsed).
 *
 * Why not "try every configured secret until one verifies" (option b)? It is
 * bounded and constant-time per-secret, but: (1) it is O(secrets) HMAC computes
 * per delivery, (2) it loses the audit signal of WHICH installation a delivery
 * was for, and (3) it muddies the security model — a delivery is "from app X"
 * only as an after-the-fact inference. Path routing makes the installation an
 * explicit, operator-controlled, pre-parse fact. We keep option (b) off.
 *
 * ── GITHUB REALITY ────────────────────────────────────────────────────────
 * A single GitHub App's webhook has ONE secret (app-level, not per-install).
 * Multi-secret therefore matters ONLY when ONE host serves MULTIPLE Apps. In
 * exactly that case the operator already controls the delivery URL of each App,
 * so a per-app path is the natural — and the most honest — discriminator.
 *
 * ── BACKWARD COMPAT ───────────────────────────────────────────────────────
 * If no map is configured, we fall back to the single shared
 * `QUANTA_GITHUB_WEBHOOK_SECRET` (mode `single`): the resolver returns that one
 * secret for every accepted path, so the legacy `/webhook` flow is byte
 * identical. If a map IS configured but parses to ZERO usable entries, we
 * DELIBERATELY do NOT silently fall back to the single secret — we return mode
 * `none` so the host refuses to boot and the operator notices the broken map,
 * rather than quietly degrading a multi-app host to one catch-all secret.
 *
 * CREDENTIAL HYGIENE: secret VALUES are never returned in errors or logs. App
 * KEYS (the path segment / map key) are operator-chosen identifiers, not
 * secrets, so they may appear in diagnostics.
 */

import type { SecretResolverPort, WebhookRequest } from "./webhook-server"

/** The fixed path prefix every webhook delivery is posted under. The bare
 *  `/webhook` is the single-secret (legacy) path; `/webhook/<key>` carries an
 *  installation key for multi-secret hosting. */
export const WEBHOOK_PATH_PREFIX = "/webhook"

/**
 * Extract the installation key from a request path.
 *   `/webhook`            → undefined (bare / legacy)
 *   `/webhook/billing`    → "billing"
 *   `/webhook/`           → undefined (empty segment)
 *   `/webhook/a/b`        → undefined (nested — not a single key)
 *   anything else         → undefined
 */
export const extractAppKey = (path: string): string | undefined => {
  if (path === WEBHOOK_PATH_PREFIX) return undefined
  const prefix = `${WEBHOOK_PATH_PREFIX}/`
  if (!path.startsWith(prefix)) return undefined
  const key = path.slice(prefix.length)
  if (key.length === 0) return undefined
  if (key.includes("/")) return undefined
  return key
}

/** Resolution mode, surfaced so the host can decide boot-ability and log a
 *  (credential-free) summary. */
export type WebhookSecretMode = "none" | "single" | "map"

export interface WebhookSecretConfig {
  /** Pre-parse secret resolver threaded into `createWebhookEventSource`. */
  readonly resolver: SecretResolverPort
  readonly mode: WebhookSecretMode
  /** Installation keys in `map` mode (NOT secrets — safe to log). Empty for
   *  `single` / `none`. */
  readonly appKeys: readonly string[]
}

export interface LoadWebhookSecretConfigDeps {
  /** Injected environment (DI — never the global `process.env` directly, so
   *  this stays testable and honors the no-raw-env ratchet). */
  readonly env: NodeJS.ProcessEnv
  /** Reader for the JSON-file map variant. The slice stays fs-free (slice
   *  fence); the HOST injects `readFileSync`. Absent ⇒ the file variant is
   *  unavailable (logged, treated as an empty map). */
  readonly readFile?: (path: string) => string
  /** Diagnostic sink. NEVER receives a secret value — only keys / shapes. */
  readonly onError?: (msg: string) => void
}

/** Inline map env: `key1=secret1,key2=secret2`. */
const INLINE_ENV = "QUANTA_GITHUB_WEBHOOK_SECRETS"
/** JSON-file map env: a path to `{"key1":"secret1",...}`. */
const FILE_ENV = "QUANTA_GITHUB_WEBHOOK_SECRETS_FILE"
/** Legacy single shared secret. */
const SINGLE_ENV = "QUANTA_GITHUB_WEBHOOK_SECRET"

/**
 * Parse the inline `key=secret,key=secret` form.
 *
 * Edge cases (all FAIL-CLOSED — a bad entry is dropped, never guessed):
 *   - empty / whitespace entry → skipped silently,
 *   - no `=` or leading `=` (empty key) → dropped + logged (no value leak),
 *   - empty secret → dropped + logged,
 *   - duplicate key → BOTH occurrences refused (ambiguous; the key is poisoned
 *     so it resolves to no secret ⇒ 401 — safer than picking one).
 *   - the FIRST `=` splits key/value, so a base64 secret with `=` padding (e.g.
 *     `k=YWJj==`) keeps its full value.
 */
const parseInlineSecretMap = (
  raw: string,
  onError?: (msg: string) => void,
): Map<string, string> => {
  const map = new Map<string, string>()
  const poisoned = new Set<string>()
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) {
      onError?.(`webhook secrets: malformed entry (expected key=secret)`)
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key.length === 0) {
      onError?.(`webhook secrets: empty app key`)
      continue
    }
    if (value.length === 0) {
      onError?.(`webhook secrets: empty secret for key '${key}'`)
      continue
    }
    if (poisoned.has(key)) continue
    if (map.has(key)) {
      onError?.(`webhook secrets: duplicate key '${key}' — refusing both (ambiguous)`)
      map.delete(key)
      poisoned.add(key)
      continue
    }
    map.set(key, value)
  }
  return map
}

/** Parse the JSON-file `{ "key": "secret" }` form. Hostile / wrong-shape JSON
 *  collapses to an empty map (logged), never throws. */
const parseJsonSecretMap = (text: string, onError?: (msg: string) => void): Map<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    onError?.(`webhook secrets file: invalid JSON`)
    return new Map()
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    onError?.(`webhook secrets file: expected a JSON object of key→secret`)
    return new Map()
  }
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || value.length === 0) {
      onError?.(`webhook secrets file: invalid/empty secret for key '${key}'`)
      continue
    }
    map.set(key, value)
  }
  return map
}

/**
 * Resolve the webhook secret configuration from the (injected) environment.
 *
 * Precedence: a non-empty inline map wins over the file map; either, if it
 * yields ≥1 usable entry, selects `map` mode. A configured-but-empty map is
 * FAIL-CLOSED to `none` (host refuses boot) rather than degrading to the single
 * secret. With no map at all, a non-empty single secret selects `single` mode;
 * otherwise `none`.
 *
 * In `map` mode the single secret is intentionally NOT a catch-all: every
 * delivery must arrive on a keyed `/webhook/<key>` path, so a bare `/webhook`
 * or an unknown key fails closed (401, no parse).
 */
/** Read the JSON-file map variant via the injected reader (slice stays
 *  fs-free). Returns an empty map on any read/parse fault (all logged). */
const loadFileSecretMap = (
  filePath: string,
  readFile: ((path: string) => string) | undefined,
  onError?: (msg: string) => void,
): Map<string, string> => {
  if (readFile === undefined) {
    onError?.(`webhook secrets file configured but no file reader available`)
    return new Map()
  }
  let text: string
  try {
    text = readFile(filePath.trim())
  } catch {
    onError?.(`webhook secrets file: cannot read`)
    return new Map()
  }
  return parseJsonSecretMap(text, onError)
}

export const loadWebhookSecretConfig = (deps: LoadWebhookSecretConfigDeps): WebhookSecretConfig => {
  const { env, onError } = deps
  const inline = env[INLINE_ENV]
  const filePath = env[FILE_ENV]
  const inlineConfigured = typeof inline === "string" && inline.trim().length > 0
  const fileConfigured = typeof filePath === "string" && filePath.trim().length > 0

  // Inline map wins over the file map; either configures `map` mode.
  let map = new Map<string, string>()
  if (inlineConfigured) {
    map = parseInlineSecretMap(inline as string, onError)
  } else if (fileConfigured) {
    map = loadFileSecretMap(filePath as string, deps.readFile, onError)
  }

  if (map.size > 0) {
    const frozen = new Map(map)
    return {
      mode: "map",
      appKeys: [...frozen.keys()],
      resolver: (req: WebhookRequest): string | undefined => {
        const key = extractAppKey(req.path)
        if (key === undefined) return undefined
        return frozen.get(key)
      },
    }
  }

  // A map was configured but produced nothing usable → fail closed. Do NOT
  // silently fall back to the single secret (that would degrade a multi-app
  // host to one catch-all and hide the misconfiguration).
  if (inlineConfigured || fileConfigured) {
    onError?.(`webhook secrets: map configured but no usable entries — refusing to boot`)
    return { mode: "none", appKeys: [], resolver: () => undefined }
  }

  const single = env[SINGLE_ENV]
  if (typeof single === "string" && single.length > 0) {
    return { mode: "single", appKeys: [], resolver: () => single }
  }

  return { mode: "none", appKeys: [], resolver: () => undefined }
}
