import { isTruthyToken } from "./env-flag"

/**
 * SEC-1 (2026-09-13) — quarantine untrusted egress-redirect env at the load
 * boundary. Sibling of the ADR-0555 memory-embedder gate: a cloned repo's
 * `.env*` that supplies an endpoint override silently redirects every
 * credential-bearing LLM request to an attacker host, carrying the victim's
 * REAL-ENV `*_API_KEY` in the `Authorization` header (proven end-to-end on both
 * the source run and the installed binary). Unlike the embedder, this leak is on
 * the main LLM path, so the guard runs at each app entrypoint immediately after
 * `loadEnvFiles`, scrubbing the poisoned keys before ANY consumer (factory,
 * provider-router, embedder) reads them — a single choke point at the trust
 * boundary keeps `src/llm/*` env-pure and covers every downstream reader at once.
 */

/** Env keys that REDIRECT where a credential-bearing request is sent. Raw base
 *  URLs only — `QUANTA_LLM_ENDPOINT` is a disk-config selector (different threat
 *  model), not a raw URL, so it is deliberately excluded. */
export const EGRESS_REDIRECT_KEYS = [
  "OPENAI_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  // Round-1 audit: an alt selector for the SAME foundry endpoint (Azure resource
  // name → base URL); redirects egress just like `ANTHROPIC_FOUNDRY_BASE_URL`.
  "ANTHROPIC_FOUNDRY_RESOURCE",
] as const

/** Opt-in for a legit local-proxy dev setup (LM Studio, a corporate gateway) that
 *  keeps its endpoint in `.env`. Consent is a REAL-ENV truthy token ONLY — a repo
 *  `.env` that sets this cannot self-arm (mirrors ADR-0555: presence is not
 *  consent). */
export const DOTENV_ENDPOINT_OPT_IN = "QUANTA_ALLOW_DOTENV_ENDPOINT"

export interface QuarantinedKey {
  readonly key: string
  /** Absolute path of the `.env*` file that supplied the key. Path only — never
   *  the value — so it is safe to log. */
  readonly file: string
}

/**
 * PURE decision. `sourceOf(key)` → the dotenv file path that supplied `key`, or
 * `undefined` when the value came from the real environment (or was never set).
 * Returns the egress-redirect keys that came from a `.env*` file and are NOT
 * covered by a real-env opt-in. A real-env base URL (the developer exported it in
 * their shell) is trusted and never returned — byte-identical to before.
 */
export const dotenvEgressRedirectsToQuarantine = (
  sourceOf: (key: string) => string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[] = EGRESS_REDIRECT_KEYS,
): QuarantinedKey[] => {
  // Consent counts ONLY from the real env: if the opt-in itself was supplied by a
  // dotenv file, it is not consent (a poisoned repo could otherwise set both the
  // opt-in and the endpoint in the same `.env`).
  const optedIn =
    sourceOf(DOTENV_ENDPOINT_OPT_IN) === undefined && isTruthyToken(env[DOTENV_ENDPOINT_OPT_IN])
  if (optedIn) return []
  const out: QuarantinedKey[] = []
  for (const key of keys) {
    const file = sourceOf(key)
    if (file !== undefined) out.push({ key, file })
  }
  return out
}

/**
 * Delete dotenv-sourced egress-redirect keys from `env` in place (SEC-1) and
 * return what was scrubbed so the caller can emit one attributed warning per key.
 * `sourceOf` is injected (defaulting supplied by the caller wiring
 * `envFileSourceOf`) so this stays unit-testable without touching process state.
 */
export const scrubUntrustedEgressRedirects = (
  env: Record<string, string | undefined>,
  sourceOf: (key: string) => string | undefined,
): QuarantinedKey[] => {
  const quarantined = dotenvEgressRedirectsToQuarantine(sourceOf, env)
  for (const { key } of quarantined) delete env[key]
  return quarantined
}

/** The one-line operator warning for a quarantined key. Names the file (never the
 *  value) and the exact opt-in to allow it. */
export const egressQuarantineWarning = (q: QuarantinedKey): string =>
  `egress guard: ignoring ${q.key} from ${q.file} — a repo .env may not redirect API egress ` +
  `(your real-env credential would be sent there). Set ${DOTENV_ENDPOINT_OPT_IN}=1 in your real ` +
  `environment to allow a dotenv endpoint.`

/**
 * Entrypoint one-liner: scrub + emit one attributed warning per quarantined key
 * via the injected `warn` (so this module stays logger-free / pure-importable).
 * Call once, immediately after `loadEnvFiles`, at every app entrypoint.
 */
export const scrubUntrustedEgressRedirectsWithWarn = (
  env: Record<string, string | undefined>,
  sourceOf: (key: string) => string | undefined,
  warn: (msg: string) => void,
): QuarantinedKey[] => {
  const quarantined = scrubUntrustedEgressRedirects(env, sourceOf)
  for (const q of quarantined) warn(egressQuarantineWarning(q))
  return quarantined
}
