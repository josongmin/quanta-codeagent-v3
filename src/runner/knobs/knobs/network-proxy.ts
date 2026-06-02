/**
 * Knob: `network-proxy` — socket-level egress proxy (ADR-0428).
 *
 * Default-OFF. Closes the SUBPROCESS egress bypass: today quanta gates egress
 * only at the tool-arg layer (`dispatch-guard/network-guard.ts` extracts a host
 * from a tool call). A subprocess that opens its OWN socket (curl / gh / npm /
 * git) bypasses that gate. This knob activates the `LoopbackEgressProxy` (a REAL
 * loopback HTTP proxy) and the child-spawn wiring threads `HTTP_PROXY` /
 * `HTTPS_PROXY` into every shell child, so the subprocess's sockets are funneled
 * through the SAME `isHostAllowed` decision the dispatch guard uses.
 *
 * Apply sets `cfg.networkProxy` (closed `NetworkProxyConfig` in
 * `@/runtime/network-proxy`); the composition root constructs the live proxy
 * from it via `withEgressProxy` and the shell spawn site injects `proxyEnv`.
 *
 * Env `QUANTA_NETWORK_PROXY`:
 *   - `"1"`                     ⇒ proxy ON over the ci-bot default allowlist
 *                                 (`CI_BOT_DEFAULT_ALLOWLIST`).
 *   - `"<host[,host...]>"`      ⇒ proxy ON over an explicit comma-separated
 *                                 allow-set (exact host or `*.suffix`). Entries
 *                                 are trimmed + lowercased; empties dropped.
 *
 * Domain (ACTIVE):
 *   - `"1"` ⇒ default allowlist.
 *   - a non-empty list with ≥1 valid host token.
 *
 * Domain (INACTIVE — `parse` returns `undefined`, byte-identical default-OFF):
 *   - absent / empty / whitespace
 *   - `"0"` (explicit off — caller falls through to the next layer)
 *   - a list that reduces to ZERO valid tokens after trimming (e.g. `","`)
 *
 * NO heuristics: the allow DECISION is delegated entirely to `isHostAllowed` +
 * `classifyHost` inside the proxy; this knob only carries the allow-set. An
 * EMPTY allow-set is a VALID active config ("deny everything except SSRF-clear
 * amendments") — but a SOURCE that parses to zero tokens means the operator
 * gave no signal, so we stay OFF rather than silently deny-all.
 */

import type { AgentConfig } from "@/agent"
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench", "cli", "agent-batch", "agent-interactive", "ide"]

interface NetworkProxyValue {
  readonly allowlist: readonly string[]
}

/** Split a raw `host,host,...` source into trimmed, lowercased, non-empty
 *  tokens. Deterministic — no dedup magic, just structural cleanup. */
const parseHostList = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "")

/**
 * Pure env → {@link NetworkProxyConfig} projection (ADR-0428 jun-02 wire). The
 * composition roots (`apps/cli`, `apps/agent/index.ts`) read `QUANTA_NETWORK_PROXY`
 * DIRECTLY through this helper — mirroring the `resolveMemoryConfigFromEnv`
 * pattern — because those surfaces build their `AgentConfig` base WITHOUT routing
 * through `applyKnobs`. Single source of truth: this delegates to the SAME
 * {@link parseNetworkProxy} the knob's `apply` uses, so the env→config bytes are
 * identical whether the framework or the direct read resolves it. Absent / `"0"`
 * / empty / zero-token ⇒ `undefined` (slot omitted, byte-identical default-OFF).
 */
export const resolveNetworkProxyFromEnv = (
  env: NodeJS.ProcessEnv,
): { readonly enabled: true; readonly allowlist: readonly string[] } | undefined => {
  const value = parseNetworkProxy(env.QUANTA_NETWORK_PROXY)
  if (value === undefined) return undefined
  return { enabled: true, allowlist: value.allowlist }
}

const parseNetworkProxy = (raw: string | undefined): NetworkProxyValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  // Explicit off — fall through to the next layer (do NOT treat as deny-all).
  if (s === "0") return undefined
  // `1` ⇒ the audited ci-bot default allow-set.
  if (s === "1") return { allowlist: CI_BOT_DEFAULT_ALLOWLIST }
  // Otherwise treat the value as an explicit allowlist source.
  const allowlist = parseHostList(s)
  if (allowlist.length === 0) return undefined
  return { allowlist }
}

const applyNetworkProxy = (cfg: AgentConfig, value: NetworkProxyValue): AgentConfig => ({
  ...cfg,
  networkProxy: { enabled: true, allowlist: value.allowlist },
})

export const networkProxyKnob: Knob<NetworkProxyValue> = {
  id: "network-proxy",
  envKey: "QUANTA_NETWORK_PROXY",
  category: "tool",
  surfaces: SURFACES,
  parse: parseNetworkProxy,
  apply: applyNetworkProxy,
  describe:
    "Socket-level egress proxy — gate subprocess sockets through the host allowlist (ADR-0428)",
  source: "ADR-0428 / Codex 0.135 [network_proxy]",
}

registerKnob(networkProxyKnob)
