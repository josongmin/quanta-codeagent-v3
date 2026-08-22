/**
 * Custom 3P Setup — pure health probe (ADR-0245).
 *
 * `(spec, deps) → Promise<HealthResult>` — no top-level imports of
 * `globalThis.fetch` or `node:dns`. Mirrors the discipline of
 * `src/connectors/availability-prober.ts`: the caller injects every
 * external dep so the probe is exhaustively testable.
 *
 * Verdict ladder (closed `HealthVerdict` arm):
 *
 *   "ok"         — DNS resolved + HEAD/GET returned 2xx
 *   "dns-fail"   — DNS resolution empty or threw (no HTTP attempted)
 *   "auth-fail"  — server returned 401 / 403
 *   "http-fail"  — server returned other non-2xx (or fetch threw without
 *                  abort signal)
 *   "timeout"    — fetch aborted via signal before completing
 *
 * For `kind = "mcp"` with stdio: endpoint we skip the HTTP probe and
 * return `"ok"` if the scheme is well-formed (no remote process is
 * spawned — that's the plugin-isolation slice's job).
 */

import type { ClockPort, DnsPort, FetchPort } from "../types"
import type { HealthProbe } from "./port"
import type { HealthResult, ProviderSpec } from "./types"

export interface HealthProbeDeps {
  readonly fetchPort: FetchPort
  readonly dnsPort: DnsPort
  readonly clockPort: ClockPort
  /** Per-probe timeout in ms. Default 5000. Must be > 0. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Parse the hostname out of an endpoint URL. Returns `undefined` for
 * `stdio:` schemes (which have no host) and for malformed URLs.
 */
const extractHost = (endpoint: string): string | undefined => {
  if (endpoint.startsWith("stdio:")) return undefined
  try {
    return new URL(endpoint).hostname
  } catch {
    return undefined
  }
}

/** Build a `HealthResult` with the elapsed time since `startedAt`. */
const elapsedResult = (
  verdict: HealthResult["verdict"],
  startedAt: number,
  nowMs: number,
): HealthResult => ({ verdict, checkedAt: startedAt, latencyMs: nowMs - startedAt })

/** DNS step → returns a verdict if it short-circuits, else `undefined`. */
const probeDns = async (
  host: string,
  dnsPort: DnsPort,
  clockPort: ClockPort,
  startedAt: number,
): Promise<HealthResult | undefined> => {
  try {
    const addresses = await dnsPort.resolve(host)
    if (addresses.length === 0) return elapsedResult("dns-fail", startedAt, clockPort.now())
    return undefined
  } catch {
    return elapsedResult("dns-fail", startedAt, clockPort.now())
  }
}

/** HTTP step — performs the GET, classifies the response/error. */
const probeHttp = async (
  endpoint: string,
  fetchPort: FetchPort,
  clockPort: ClockPort,
  startedAt: number,
  timeoutMs: number,
): Promise<HealthResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchPort(endpoint, { method: "GET", signal: controller.signal })
    const now = clockPort.now()
    if (res.ok) return elapsedResult("ok", startedAt, now)
    if (res.status === 401 || res.status === 403) {
      return elapsedResult("auth-fail", startedAt, now)
    }
    return elapsedResult("http-fail", startedAt, now)
  } catch {
    if (controller.signal.aborted) return { verdict: "timeout", checkedAt: startedAt }
    return elapsedResult("http-fail", startedAt, clockPort.now())
  } finally {
    clearTimeout(timer)
  }
}

export const createHealthProbe = (deps: HealthProbeDeps): HealthProbe => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (timeoutMs <= 0) throw new Error("timeoutMs must be > 0")

  return async (spec: ProviderSpec): Promise<HealthResult> => {
    const startedAt = deps.clockPort.now()

    // stdio: MCP — no remote probe possible. Scheme well-formed → ok.
    if (spec.kind === "mcp" && spec.endpoint.startsWith("stdio:")) {
      return { verdict: "ok", checkedAt: startedAt, latencyMs: 0 }
    }

    const host = extractHost(spec.endpoint)
    if (host === undefined) {
      return { verdict: "http-fail", checkedAt: startedAt, latencyMs: 0 }
    }

    const dnsVerdict = await probeDns(host, deps.dnsPort, deps.clockPort, startedAt)
    if (dnsVerdict !== undefined) return dnsVerdict

    return probeHttp(spec.endpoint, deps.fetchPort, deps.clockPort, startedAt, timeoutMs)
  }
}
