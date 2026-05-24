/**
 * ADR-0163 — Foundry SDK availability watcher.
 *
 * Pairs with {@link FoundryProviderAdapter}: that file scaffolds the typed
 * not-yet-shipped adapter for the (currently unpublished)
 * `@anthropic-ai/foundry-sdk`; THIS file answers the operational question
 * "has it shipped yet?" without forcing the caller to manually
 * `curl registry.npmjs.org`.
 *
 * Two signals, returned as a single struct:
 *
 *   1. `installed`     — true when the adapter's lazy-import succeeds AND the
 *                        expected `AnthropicFoundry` constructor is exported.
 *                        Sourced from {@link isFoundryAdapterReady} so this
 *                        helper and the adapter agree on the readiness rule.
 *   2. `npmPublished`  — true when the npm registry returns a 200 for the
 *                        package metadata URL. A 404 (the production state
 *                        today) ⇒ false. Any other status (5xx, network
 *                        failure, malformed JSON, timeout) ALSO ⇒ false; we
 *                        deliberately fail-graceful rather than throw — the
 *                        caller's intent is "tell me what you know", not
 *                        "raise if you cannot reach npm".
 *   3. `npmVersion?`   — populated only when the registry response includes
 *                        a `dist-tags.latest` field. Absent on 404, on
 *                        network failure, and when the response shape was
 *                        unexpected. Callers MUST treat absence as "I do
 *                        not know" rather than "version unknown".
 *
 * Plane-clean: imports the sibling adapter helper only. No `@/agent`, no
 * `process.env`, no global `fetch` shadowing — the `fetcher` parameter is the
 * single seam used by tests to substitute a synthetic fetch.
 */

import { FOUNDRY_SDK_NPM_URL, FOUNDRY_SDK_PACKAGE, isFoundryAdapterReady } from "./foundry-adapter"

/** Public coordinates re-exported so a single import gives the caller both
 *  the watch surface AND the canonical URL it watches against. Same SSOT
 *  discipline as `PROVIDER_ENV_KEYS` in the registry. */
export { FOUNDRY_SDK_NPM_URL, FOUNDRY_SDK_PACKAGE }

/**
 * Result of an availability check. Optional `npmVersion` follows
 * exactOptional discipline — never assign `undefined` explicitly; OMIT the
 * key when the version is unknown so a `key in result` check works as a
 * presence test.
 */
export interface FoundrySdkAvailability {
  /** Lazy-import of `@anthropic-ai/foundry-sdk` succeeded AND the expected
   *  `AnthropicFoundry` constructor is exported. */
  readonly installed: boolean
  /** `GET ${FOUNDRY_SDK_NPM_URL}` returned a 200 response. Catches every
   *  failure mode (network error, non-200, malformed JSON, JSON without the
   *  expected shape) into `false` — see file header. */
  readonly npmPublished: boolean
  /** `dist-tags.latest` from the npm metadata response, when present.
   *  Absent on 404, on network failure, and on unexpected response shape. */
  readonly npmVersion?: string
}

/**
 * Minimal structural view of the npm registry response shape we depend on.
 * Pinned to the single field we read so the helper survives the registry
 * adding new top-level keys (which they do every few quarters).
 */
interface NpmRegistryResponse {
  readonly "dist-tags"?: { readonly latest?: string }
}

/**
 * Optional fetcher seam — tests inject a synthetic fetch (no network). When
 * omitted in production, the global `fetch` is used; when global fetch is
 * also unavailable (Node < 18 without polyfill), the helper degrades
 * gracefully to `{npmPublished:false}` rather than throwing.
 */
export interface FoundrySdkAvailabilityOptions {
  readonly fetcher?: typeof fetch
}

/**
 * Probe both the local install and the npm registry. Never throws — the
 * worst case is `{installed:false, npmPublished:false}` (omitting
 * `npmVersion` per the exactOptional discipline above).
 *
 * Sequence:
 *   1. Local install check via {@link isFoundryAdapterReady} — same predicate
 *      the adapter itself uses, so the two cannot diverge.
 *   2. Resolve the fetcher: caller-supplied seam wins; otherwise fall back
 *      to the global `fetch` if available; otherwise skip the network probe
 *      entirely.
 *   3. `GET ${FOUNDRY_SDK_NPM_URL}` — full GET (not HEAD) because the npm
 *      registry serves a 200 with metadata on GET and a 405 on HEAD for some
 *      mirrors; GET is universally supported.
 *   4. Parse JSON. Pull `dist-tags.latest` if present.
 *   5. Catch EVERYTHING into the failure-graceful default — the watch helper
 *      must not crash the status UI just because npm is rate-limiting us.
 */
export const checkFoundrySdkAvailability = async (
  opts?: FoundrySdkAvailabilityOptions,
): Promise<FoundrySdkAvailability> => {
  // Step 1: local install probe. `isFoundryAdapterReady` already swallows
  // every dynamic-import error into `false`, so we can call it bare.
  const installed = await isFoundryAdapterReady()

  // Step 2: resolve the fetcher. Caller wins over global; absent global ⇒
  // skip the network probe entirely (no synthetic 0/false; the contract is
  // the same — we do not know whether it is published).
  const fetcher =
    opts?.fetcher ?? (typeof fetch === "function" ? (fetch as typeof globalThis.fetch) : undefined)
  if (fetcher === undefined) {
    return { installed, npmPublished: false }
  }

  // Step 3-5: probe the registry. Every failure mode collapses into the
  // graceful default. Note we do NOT use Promise.race with a timeout here —
  // the caller's `fetcher` is responsible for its own timing policy
  // (production callers can wrap a `fetch` in their own AbortSignal.timeout).
  try {
    const res = await fetcher(FOUNDRY_SDK_NPM_URL, { method: "GET" })
    if (!res.ok) {
      // 404 (the production state today) lands here; so does 5xx / 429. All
      // collapse to "not published as far as we can tell" — the caller's
      // recovery is identical in each case (try again later).
      return { installed, npmPublished: false }
    }
    const raw: unknown = await res.json()
    const body = raw as NpmRegistryResponse
    const latest = body["dist-tags"]?.latest
    // Spread-when-present preserves exactOptional honesty — we never write
    // `npmVersion: undefined` into the returned struct.
    return {
      installed,
      npmPublished: true,
      ...(typeof latest === "string" && latest.length > 0 ? { npmVersion: latest } : {}),
    }
  } catch {
    // Network error, malformed JSON, AbortError, … — caller does not care
    // about the cause, only the answer.
    return { installed, npmPublished: false }
  }
}
