/**
 * Connectors — availability prober LRU semantics unit (ADR-0160 Phase D).
 *
 * Focused on cache shape rather than network. Confirms LRU eviction order,
 * recency touch behavior, TTL boundary timing, and default knob values.
 */

import { describe, expect, test } from "bun:test"
import type { ClockPort, DnsPort, FetchPort, FetchPortResponse } from "@/connectors"
import { createAvailabilityProber } from "@/connectors"

const okResp = (): FetchPortResponse => ({ status: 200, ok: true, text: async () => "" })

const fakeFetch = (): { fetchPort: FetchPort; calls: number } => {
  const state = { calls: 0 }
  const fp: FetchPort = async () => {
    state.calls += 1
    return okResp()
  }
  return {
    fetchPort: fp,
    get calls() {
      return state.calls
    },
  } as { fetchPort: FetchPort; calls: number }
}

const dns = (addrs: ReadonlyArray<string>): DnsPort => ({ resolve: async () => addrs })

const clockOf = (): ClockPort & { advance(ms: number): void } => {
  let now = 0
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

describe("connectors / availability LRU", () => {
  test("UNIT-1: first probe → cache miss → network call", async () => {
    const f = fakeFetch()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clockOf(),
    })
    await p.probe("h")
    expect(f.calls).toBe(1)
  })

  test("UNIT-2: subsequent probe within TTL hits cache", async () => {
    const f = fakeFetch()
    const clk = clockOf()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clk,
      lruTtlMs: 1_000,
    })
    await p.probe("h")
    clk.advance(999)
    await p.probe("h")
    expect(f.calls).toBe(1)
  })

  test("UNIT-3: probe at exact TTL → re-probes (TTL is exclusive)", async () => {
    const f = fakeFetch()
    const clk = clockOf()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clk,
      lruTtlMs: 1_000,
    })
    await p.probe("h")
    clk.advance(1_000)
    await p.probe("h")
    expect(f.calls).toBe(2)
  })

  test("UNIT-4: distinct hosts cached independently", async () => {
    const f = fakeFetch()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clockOf(),
    })
    await p.probe("a")
    await p.probe("b")
    await p.probe("a") // cached
    await p.probe("b") // cached
    expect(f.calls).toBe(2)
  })

  test("UNIT-5: LRU recency touch — accessed entry survives eviction", async () => {
    const f = fakeFetch()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clockOf(),
      lruSize: 2,
      lruTtlMs: 60_000,
    })
    await p.probe("a")
    await p.probe("b")
    await p.probe("a") // touch "a" — now b is LRU
    await p.probe("c") // evicts "b"
    await p.probe("a") // still cached
    await p.probe("b") // re-probed
    expect(f.calls).toBe(4) // a,b,c, then b again
  })

  test("UNIT-6: default lruSize=128 supports many hosts", async () => {
    const f = fakeFetch()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clockOf(),
    })
    for (let i = 0; i < 100; i++) await p.probe(`h${i}.example`)
    expect(f.calls).toBe(100)
    // All 100 still cached (under default 128 cap).
    for (let i = 0; i < 100; i++) await p.probe(`h${i}.example`)
    expect(f.calls).toBe(100)
  })

  test("UNIT-7: default lruTtlMs=5min holds across short advance", async () => {
    const f = fakeFetch()
    const clk = clockOf()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clk,
    })
    await p.probe("h")
    clk.advance(4 * 60_000) // 4 min
    await p.probe("h")
    expect(f.calls).toBe(1)
  })

  test("UNIT-8: default lruTtlMs=5min expires after 5min", async () => {
    const f = fakeFetch()
    const clk = clockOf()
    const p = createAvailabilityProber({
      fetchPort: f.fetchPort,
      dnsPort: dns(["1"]),
      clockPort: clk,
    })
    await p.probe("h")
    clk.advance(5 * 60_000)
    await p.probe("h")
    expect(f.calls).toBe(2)
  })
})
