/**
 * Shared helpers for the retrieval real-API smoke eval — ADR-0275.
 *
 * These helpers live in `tests/eval/` (NOT `tests/unit/`) per ADR-0003:
 * eval-tier suites are NON-BLOCKING, may hit real network, and only run
 * when the relevant env var (API key / local endpoint) is present.
 *
 * Two responsibilities:
 *   1. `describeOnEnv(envVar, label, fn)` — polite skip wrapper. When the
 *      env var is unset or empty, the entire describe block is skipped.
 *      `bun test` reports "skipped" — never "failed" — when keys are absent.
 *   2. `assertCostCap(name, items, perItemTokensCap)` — input budget guard
 *      enforcing the per-smoke spend ceiling (max ~$0.05). Each smoke caps
 *      total input at ~100 tokens (≈ 400 utf-8 bytes), 2 inputs max.
 *
 * Default-OFF posture: no module here imports `@/agent`, `@/loop`, etc.
 * Hitting real APIs is opt-in (env present) and bounded (token cap).
 */
import { describe } from "bun:test"

/** Polite-skip describe block: runs only when `envVar` is present + non-empty. */
export const describeOnEnv = (envVar: string, label: string, fn: () => void): void => {
  const v = process.env[envVar]
  const present = typeof v === "string" && v.length > 0
  if (present) {
    describe(label, fn)
  } else {
    describe.skip(`${label} (skipped — ${envVar} unset)`, fn)
  }
}

/**
 * Polite-skip describe block gated on TWO env vars (one must be present —
 * useful for Cohere where the same key powers both embedder + reranker
 * eval files but they need to share a single key).
 */
export const describeOnAnyEnv = (
  envVars: readonly string[],
  label: string,
  fn: () => void,
): void => {
  const anyPresent = envVars.some((v) => {
    const x = process.env[v]
    return typeof x === "string" && x.length > 0
  })
  if (anyPresent) {
    describe(label, fn)
  } else {
    describe.skip(`${label} (skipped — none of ${envVars.join("/")} set)`, fn)
  }
}

/**
 * Approximate utf-8 byte length → ~tokens heuristic. We use 4 bytes/token
 * (industry default for English). The cap is a defensive upper bound on
 * spend, not an exact tokenizer.
 */
export const approxTokens = (s: string): number => Math.ceil(Buffer.byteLength(s, "utf8") / 4)

/** Sum of approx tokens across an array of inputs. */
export const totalApproxTokens = (items: readonly string[]): number =>
  items.reduce((sum, s) => sum + approxTokens(s), 0)

/**
 * Throw if the total approximate token count exceeds the cap. This is the
 * SECOND line of cost defence; the FIRST is the small SMOKE_INPUTS literal.
 * Each smoke is bounded to 2 short inputs ≈ 16 tokens total.
 *
 * At voyage/cohere/openai-3-small pricing (~$0.02–$0.13 per 1M tokens),
 * 100 tokens per smoke caps each run at well under $0.001. Even at the
 * 20×-rerun threshold, total spend stays below the $0.05/smoke ceiling.
 */
export const assertCostCap = (label: string, items: readonly string[], tokenCap: number): void => {
  const total = totalApproxTokens(items)
  if (total > tokenCap) {
    throw new Error(
      `[eval-cost-cap] ${label}: input ≈${total} tokens exceeds cap ${tokenCap}. ` +
        "Shrink the SMOKE_INPUTS literal to stay under the per-smoke $0.05 ceiling.",
    )
  }
}

/** Per-smoke max approximate tokens. Hard cap — every eval respects this. */
export const SMOKE_TOKEN_CAP = 100

/** Per-smoke latency ceiling (ms). Real APIs that take >5s on tiny input are drifting. */
export const SMOKE_LATENCY_CAP_MS = 5000

/**
 * Canonical 2-input smoke set. Two short, semantically related sentences —
 * enough to exercise batch input + (optionally) a relevance query without
 * spending real money.
 */
export const SMOKE_INPUTS: readonly string[] = [
  "The quick brown fox jumps over the lazy dog.",
  "A fast auburn fox leaps above the sleepy hound.",
] as const

/** Canonical smoke query for rerank evals — semantically near SMOKE_INPUTS[0]. */
export const SMOKE_QUERY = "Tell me about a fox jumping over a dog."

/**
 * Compute L2-norm of a vector. Used to assert vectors are normalised within
 * an expected band — most embedders return unit-norm (~1.0) by default.
 */
export const l2Norm = (v: readonly number[]): number => {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum)
}

/**
 * Tier-1 connectivity check for Ollama. The local daemon may not be running
 * even when the test machine is online — we issue a fast no-op `GET /` and
 * treat any network error (ECONNREFUSED / TimeoutError) as "skip".
 *
 * Returns `true` if the daemon answered (any HTTP status), `false` on a
 * thrown fetch — i.e. connect refused or DNS failure.
 */
export const ollamaAvailable = async (baseURL: string, timeoutMs = 500): Promise<boolean> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await fetch(baseURL, { signal: ctrl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
