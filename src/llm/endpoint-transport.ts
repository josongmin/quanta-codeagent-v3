/**
 * RFC05-2 — the shared data-plane endpoint contract that BOTH OpenAI wire
 * surfaces (Chat completions + Responses) consume.
 *
 * SOLID boundary: central config owns endpoint SYNTAX/provenance/merge
 * (`@/config`), the shared net owner owns network ADMISSION (`@/shared/net/ssrf`
 * `fetchWithSsrfGuard`), `createLLM` owns SELECTION/composition, and the two
 * existing adapters own wire SERIALIZATION. This module is the thin composition
 * seam in the middle: it turns a resolved endpoint (base URL + network policy +
 * ALREADY-RESOLVED headers/query values) into ONE guarded `fetch` that both
 * adapters share, so a profile can never get a different trust/scheme decision
 * on one wire vs the other.
 *
 * SECRET DISCIPLINE: `ResolvedEndpoint.headers`/`query` carry VALUES that the
 * HOST resolved from the config's symbolic refs at composition time. They live
 * ONLY on this in-memory record and on the outgoing request — never in a config
 * record, a diagnostic, a log, or hash material. {@link redactEndpointForDiagnostics}
 * is the ONLY shape allowed into diagnostics.
 *
 * NO new SSRF classifier, NO new retry loop, NO URL-shape wire inference.
 */

import { fetchWithSsrfGuard, type HostResolver, type NetworkPolicy } from "@/shared/net/ssrf"

/** The resolved (secret-materialized) endpoint contract. `wireApi` selects the
 *  adapter; `networkPolicy` governs the shared guarded fetch. `headers`/`query`
 *  are ALREADY-RESOLVED values (host mapped the symbolic refs) — this record is
 *  never serialized to disk. */
export interface ResolvedEndpoint {
  readonly id: string
  readonly baseUrl: string
  readonly wireApi: "chat" | "responses"
  readonly model: string
  readonly networkPolicy: NetworkPolicy
  /** Resolved header name → value (secret VALUES). Empty when none. */
  readonly headers: Readonly<Record<string, string>>
  /** Resolved static query params (non-secret). Empty when none. */
  readonly query: Readonly<Record<string, string>>
}

/** A `fetch`-shaped function (SDK `Fetch` / Responses `fetchImpl` compatible).
 *  Accepts a string/URL/Request first arg so it drops straight into the OpenAI
 *  SDK's `fetch` option and the Responses adapter's `fetchImpl`. */
export type EndpointFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Extract the request URL string from the `fetch` first-arg union. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

/**
 * Build the ONE guarded fetch both wires share for a resolved endpoint. Wraps
 * the injected `inner` fetcher with {@link fetchWithSsrfGuard} pinned to the
 * endpoint's {@link NetworkPolicy} (applied to the initial URL and EVERY
 * redirect hop), and attaches the resolved headers.
 *
 * `inner` defaults to the global `fetch` — a test injects a scripted fetcher.
 * `resolveHost` is forwarded to the guard's DNS-rebinding layer (default node
 * DNS). No retry logic is added here — retry stays with the SDK / RecoveryRouter
 * owners (RFC-05 no-new-retry rule).
 */
export const buildEndpointFetch = (
  endpoint: ResolvedEndpoint,
  opts: { inner?: typeof fetch; resolveHost?: HostResolver } = {},
): EndpointFetch => {
  const inner = opts.inner ?? fetch
  return async (input, init) => {
    // Merge the endpoint's resolved headers UNDER any per-request headers (the
    // adapter's content-type/auth win only if it sets them; normally it does not
    // set the endpoint auth, so the resolved header applies).
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(endpoint.headers)) {
      if (!headers.has(k)) headers.set(k, v)
    }
    // Ensure a signal exists — the guard requires one to abort the raw fetch.
    const signal = init?.signal ?? new AbortController().signal
    return fetchWithSsrfGuard(
      inner,
      urlOf(input),
      { ...init, headers, signal },
      {
        networkPolicy: endpoint.networkPolicy,
        ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
      },
    )
  }
}

/** The ONLY endpoint shape allowed into diagnostics / receipts / logs: profile
 *  id, wire, model, policy, and the host (NOT the full URL with a query secret).
 *  Resolved header/query VALUES are dropped — only the presence-count is kept
 *  so an operator can see "2 headers configured" without their values. */
export interface EndpointDiagnostic {
  readonly id: string
  readonly wireApi: "chat" | "responses"
  readonly model: string
  readonly networkPolicy: NetworkPolicy
  readonly host: string
  readonly headerCount: number
  readonly queryCount: number
}

/** Project a {@link ResolvedEndpoint} to its redacted diagnostic shape. */
export const redactEndpointForDiagnostics = (endpoint: ResolvedEndpoint): EndpointDiagnostic => {
  let host = endpoint.baseUrl
  try {
    host = new URL(endpoint.baseUrl).host
  } catch {
    // malformed base URL — keep the raw string (it carries no resolved secret)
  }
  return {
    id: endpoint.id,
    wireApi: endpoint.wireApi,
    model: endpoint.model,
    networkPolicy: endpoint.networkPolicy,
    host,
    headerCount: Object.keys(endpoint.headers).length,
    queryCount: Object.keys(endpoint.query).length,
  }
}
