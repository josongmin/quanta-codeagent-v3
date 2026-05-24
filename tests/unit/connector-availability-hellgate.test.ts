/**
 * Connector availability prober — hellgate (ADR-0160 Phase D).
 *
 * Seals 11 adversarial cases for per-host availability probe with LRU cache:
 *   1.  happy: DNS ok + HEAD 200 → "ok"
 *   2.  HEAD 405 (server rejects HEAD) → still "ok" (server reachable)
 *   3.  HEAD 500 → "http-fail"
 *   4.  DNS resolves empty array → "dns-fail"
 *   5.  DNS throws → "dns-fail"
 *   6.  HEAD timeout (signal aborted) → "timeout"
 *   7.  HEAD network error (no abort) → "http-fail"
 *   8.  LRU hit within TTL: second probe skips network
 *   9.  LRU expired: re-probes after TTL
 *   10. concurrent probe for same host coalesces to one network call
 *   11. config validation: lruTtlMs/lruSize/headTimeoutMs <=0 throws
 *   12. LRU eviction: oldest entry evicted when size exceeded
 */

import { describe, expect, test } from "bun:test"
import type { ClockPort, DnsPort, FetchPort, FetchPortResponse } from "@/connectors"
import { createAvailabilityProber } from "@/connectors"

interface FakeFetchState {
  calls: number
  responder: (init: Parameters<FetchPort>[1]) => Promise<FetchPortResponse>
}

const makeFakeFetch = (
  responder: (init: Parameters<FetchPort>[1]) => Promise<FetchPortResponse>,
): { fetchPort: FetchPort; state: FakeFetchState } => {
  const state: FakeFetchState = { calls: 0, responder }
  const fetchPort: FetchPort = async (_url, init) => {
    state.calls += 1
    return state.responder(init)
  }
  return { fetchPort, state }
}

const fakeClock = (start = 0): ClockPort & { advance(ms: number): void } => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const fakeDns = (addresses: ReadonlyArray<string>, throwOn = false): DnsPort => ({
  resolve: async () => {
    if (throwOn) throw new Error("dns down")
    return addresses
  },
})

const okResponse = (status: number): FetchPortResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => "",
})

describe("connector-availability-hellgate", () => {
  test("HELL-1: DNS ok + HEAD 200 → ok", async () => {
    const { fetchPort } = makeFakeFetch(async () => okResponse(200))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("api.github.com")).toBe("ok")
  })

  test("HELL-2: HEAD 405 (method not allowed) → ok (server reachable)", async () => {
    const { fetchPort } = makeFakeFetch(async () => okResponse(405))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("api.github.com")).toBe("ok")
  })

  test("HELL-3: HEAD 500 → http-fail", async () => {
    const { fetchPort } = makeFakeFetch(async () => okResponse(500))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("api.github.com")).toBe("http-fail")
  })

  test("HELL-4: DNS empty array → dns-fail (no HEAD called)", async () => {
    const { fetchPort, state } = makeFakeFetch(async () => okResponse(200))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns([]),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("nowhere.example")).toBe("dns-fail")
    expect(state.calls).toBe(0)
  })

  test("HELL-5: DNS throws → dns-fail", async () => {
    const { fetchPort, state } = makeFakeFetch(async () => okResponse(200))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns([], true),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("any.example")).toBe("dns-fail")
    expect(state.calls).toBe(0)
  })

  test("HELL-6: HEAD timeout (signal aborted) → timeout", async () => {
    const { fetchPort } = makeFakeFetch(async (init) => {
      // Simulate: wait for signal to abort, then throw an abort-shaped error.
      await new Promise<void>((resolve) => {
        if (init?.signal?.aborted === true) return resolve()
        init?.signal?.addEventListener("abort", () => resolve())
      })
      throw new Error("aborted")
    })
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
      headTimeoutMs: 5,
    })
    expect(await prober.probe("slow.example")).toBe("timeout")
  })

  test("HELL-7: HEAD throws but signal NOT aborted → http-fail", async () => {
    const { fetchPort } = makeFakeFetch(async () => {
      throw new Error("conn reset")
    })
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
    })
    expect(await prober.probe("broken.example")).toBe("http-fail")
  })

  test("HELL-8: LRU hit within TTL skips network", async () => {
    const { fetchPort, state } = makeFakeFetch(async () => okResponse(200))
    const clock = fakeClock()
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: clock,
      lruTtlMs: 1000,
    })
    expect(await prober.probe("h")).toBe("ok")
    clock.advance(500)
    expect(await prober.probe("h")).toBe("ok")
    expect(state.calls).toBe(1)
  })

  test("HELL-9: LRU expires after TTL → re-probes", async () => {
    const { fetchPort, state } = makeFakeFetch(async () => okResponse(200))
    const clock = fakeClock()
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: clock,
      lruTtlMs: 1000,
    })
    expect(await prober.probe("h")).toBe("ok")
    clock.advance(1001)
    expect(await prober.probe("h")).toBe("ok")
    expect(state.calls).toBe(2)
  })

  test("HELL-10: concurrent probe same host coalesces", async () => {
    let resolveOnce: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      resolveOnce = r
    })
    const { fetchPort, state } = makeFakeFetch(async () => {
      await gate
      return okResponse(200)
    })
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
    })
    const p1 = prober.probe("h")
    const p2 = prober.probe("h")
    const p3 = prober.probe("h")
    if (resolveOnce === undefined) throw new Error("gate not set")
    resolveOnce()
    const r = await Promise.all([p1, p2, p3])
    expect(r).toEqual(["ok", "ok", "ok"])
    expect(state.calls).toBe(1)
  })

  test("HELL-11: <=0 config knobs throw at construction", () => {
    const { fetchPort } = makeFakeFetch(async () => okResponse(200))
    const ctx = { fetchPort, dnsPort: fakeDns(["x"]), clockPort: fakeClock() }
    expect(() => createAvailabilityProber({ ...ctx, lruTtlMs: 0 })).toThrow(/lruTtlMs/)
    expect(() => createAvailabilityProber({ ...ctx, lruSize: 0 })).toThrow(/lruSize/)
    expect(() => createAvailabilityProber({ ...ctx, headTimeoutMs: -1 })).toThrow(/headTimeoutMs/)
  })

  test("HELL-12: LRU eviction — oldest entry kicked when size exceeded", async () => {
    const { fetchPort, state } = makeFakeFetch(async () => okResponse(200))
    const prober = createAvailabilityProber({
      fetchPort,
      dnsPort: fakeDns(["1.2.3.4"]),
      clockPort: fakeClock(),
      lruSize: 2,
      lruTtlMs: 60_000,
    })
    await prober.probe("a")
    await prober.probe("b")
    await prober.probe("c") // evicts "a"
    await prober.probe("a") // forces re-probe since evicted
    expect(state.calls).toBe(4)
  })
})
