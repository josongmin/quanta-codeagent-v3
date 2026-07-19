/** RuntimeConfig live-wire proof.
 *
 * These assertions drive the same injected env path used by host composition.
 * They fail if a parsed security value is no longer projected into the actual
 * network proxy config, or if an injected host env drifts from RuntimeConfig.
 */

import { describe, expect, test } from "bun:test"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import { TLS_MITM_ACK_PHRASE } from "@/runtime/network-proxy"
import { runtimeConfigFromEnv } from "@/shared"

describe("RuntimeConfig injected-env projection", () => {
  test("uses one parser for duplicate host gates", () => {
    const config = runtimeConfigFromEnv({
      QUANTA_CAPABILITY_LAYER: "1",
      QUANTA_SIDE_AGENT: "1",
      QUANTA_SIDE_AGENT_PROCESS: "1",
      QUANTA_SUBAGENT_RESUME: "1",
      QUANTA_WRITE_BUDGET: "1",
      QUANTA_WRITE_BUDGET_MAX: "3",
      QUANTA_UNTRUSTED_ENVELOPE: "1",
    })

    expect(config.capabilityLayer).toBe(true)
    expect(config.sideAgent).toBe(true)
    expect(config.sideAgentProcess).toBe(true)
    expect(config.subagentResume).toBe(true)
    expect(config.writeBudget).toBe(true)
    expect(config.writeBudgetMax).toBe(3)
    expect(config.untrustedEnvelope).toBe(true)
  })
})

describe("RuntimeConfig → NetworkProxyConfig security projection", () => {
  test("secret egress and scouting values activate only with their required config", () => {
    const proxy = resolveNetworkProxyFromEnv({
      QUANTA_NETWORK_PROXY: "allowed.test",
      QUANTA_SECRET_EGRESS: "redact",
      QUANTA_SECRET_EGRESS_MAX_BODY: "4096",
      QUANTA_EXFIL_SCOUTING: "1",
      QUANTA_EXFIL_SCOUTING_K: "3",
    })

    expect(proxy?.secretEgress?.mode).toBe("redact")
    expect(proxy?.secretEgress?.maxBodyBytes).toBe(4096)
    expect(proxy?.exfilScoutingThreshold).toBe(3)
    expect(proxy?.mitm).toBeUndefined()
  })

  test("TLS MITM is constructed only after explicit acknowledgement and reuses egress policy", () => {
    const base = {
      QUANTA_NETWORK_PROXY: "allowed.test",
      QUANTA_SECRET_EGRESS: "deny",
      QUANTA_SECRET_EGRESS_MAX_BODY: "8192",
      QUANTA_TLS_MITM: "1",
      QUANTA_TLS_MITM_ON_FAILURE: "opaque-tunnel",
    }
    expect(resolveNetworkProxyFromEnv(base)?.mitm).toBeUndefined()

    const proxy = resolveNetworkProxyFromEnv({
      ...base,
      QUANTA_TLS_MITM_ACK: TLS_MITM_ACK_PHRASE,
    })
    expect(proxy?.mitm?.onFailure).toBe("opaque-tunnel")
    expect(proxy?.mitm?.secretEgress).toBe(proxy?.secretEgress)
    expect(proxy?.mitm?.certAuthority.caCertPem()).toContain("BEGIN CERTIFICATE")
  })
})
