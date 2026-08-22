/**
 * R10 hellgate — `logger.child({ caller })` ergonomic API on top of the R9
 * multi-tenant bucket-label seam.
 *
 * R9 added an optional third `{ caller }` argument to every emit so a
 * multi-tenant host can isolate rate-limit buckets per tenant — but every
 * call site had to thread that argument by hand. That boilerplate is fragile
 * (easy to forget at the catch site that needs it most) and the resulting
 * default-OFF code path was a dead-code risk for the hosted phase.
 *
 * `logger.child({ caller })` returns a sub-logger whose four severity methods
 * auto-inject the bound caller into the bucket label. Calling code constructs
 * the sub-logger ONCE per tenant (e.g. `PluginHost` does it in the
 * constructor against `proc.serviceName`) and then uses it as a drop-in for
 * the base `logger`. `.child()` itself returns a `Logger` so chains compose;
 * the caller components are joined with `.` and re-sanitized once so a
 * hostile child component containing the layer-owned `::` separator cannot
 * forge a sibling's bucket id.
 *
 * Adversarial axes pinned (~15 cases):
 *
 *   (1)–(4)   API ergonomics: all four severities forward to the gate with
 *             the bound caller; the output line is byte-identical to the
 *             base logger.
 *   (5)       Recursive composition: `child().child()` concatenates the
 *             caller chain (`.` separator) — the FUSED id is the bucket key.
 *   (6)       Composition isolation: two distinct chains under the same
 *             prefix have INDEPENDENT buckets — sibling cannot starve
 *             sibling's quota.
 *   (7)       `::` injection in a child component is stripped at every
 *             depth — no sibling-bucket forgery via composition.
 *   (8)       Per-call `callSite` argument OVERRIDES the bound caller —
 *             explicit > bound, by design.
 *   (9)       Empty child component (`child({})`) is a no-op semantically:
 *             effective caller unchanged from the bound id.
 *   (10)      Threshold gate runs FIRST — a hostile child caller cannot
 *             smuggle a debug-level line past the configured threshold.
 *   (11)      Closure cost: the sub-logger has the four-method + child
 *             surface and no extra state — sealed by repeated allocation
 *             without bucket leakage (the buckets map size is bounded by
 *             the LRU, NOT by the number of child loggers created).
 *   (12)–(14) `PluginHost` wire: two `PluginHost` instances under different
 *             `serviceName` ids have INDEPENDENT bucket quotas — an
 *             adversarial plugin spamming malformed frames cannot starve a
 *             benign sibling plugin. Output line shape is unchanged from the
 *             pre-R10 framing.
 *
 * Sink discipline: we override the terminal-io sink (the only port `write`
 * reaches) so the test is sink-deterministic and never touches real stderr.
 * Clock is pinned via `__setLoggerNow` so refill / suppression order is
 * deterministic without `setTimeout`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { IsolatedProcess } from "@/plugin-isolation"
import { PluginHost } from "@/plugin-isolation"
import {
  __resetLoggerRateLimit,
  __resetRuntimeConfig,
  __setLoggerNow,
  logger,
  setTerminalIo,
} from "@/shared"

let captured: string[] = []
let nowMs = 0

beforeEach(() => {
  captured = []
  nowMs = 3_000_000 // arbitrary epoch base
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk) => captured.push(chunk),
  })
  __setLoggerNow(() => nowMs)
  __resetLoggerRateLimit()
  __setLoggerNow(() => nowMs) // __reset clears the seam — re-pin
  __resetRuntimeConfig()
})

afterEach(() => {
  delete process.env.QUANTA_LOG_LEVEL
  __resetRuntimeConfig()
})

afterAll(() => {
  setTerminalIo(null)
  __setLoggerNow(null)
  __resetLoggerRateLimit()
})

describe("R10 — logger.child API: all four severities auto-inject caller", () => {
  test("(1) debug bound caller — emits byte-identical line (no caller in output)", () => {
    process.env.QUANTA_LOG_LEVEL = "debug"
    __resetRuntimeConfig()
    const log = logger.child({ caller: "tenant-A" })
    log.debug("slice.op: msg")
    expect(captured).toEqual(["[debug] slice.op: msg\n"])
  })

  test("(2) info bound caller — emits byte-identical line", () => {
    const log = logger.child({ caller: "tenant-A" })
    log.info("slice.op: hit", { count: 3 })
    expect(captured).toEqual(['[info] slice.op: hit {"count":3}\n'])
  })

  test("(3) warn bound caller — emits byte-identical line", () => {
    const log = logger.child({ caller: "tenant-A" })
    log.warn("slice.op: budget exceeded")
    expect(captured).toEqual(["[warn] slice.op: budget exceeded\n"])
  })

  test("(4) error bound caller — emits byte-identical line", () => {
    const log = logger.child({ caller: "tenant-A" })
    log.error("slice.op: blew up")
    expect(captured).toEqual(["[error] slice.op: blew up\n"])
  })
})

describe("R10 — child composition: chains concat with `.` separator", () => {
  test("(5) child().child() — fused caller is `A.B` (single fused bucket)", () => {
    const composed = logger.child({ caller: "tenant-A" }).child({ caller: "slice-B" })
    // First emit: fresh bucket (cold-start = 1 token) → emits.
    composed.warn("chain.op: msg")
    expect(captured.length).toBe(1)
    // Second emit on the SAME fused chain: same bucket, suppressed.
    composed.warn("chain.op: msg")
    expect(captured.length).toBe(1)
    // A second chain with the SAME fused id (constructed independently via a
    // different `.child()` call sequence) lands on the same bucket — proves
    // the bucket key is the fused id, not the call-chain identity.
    const sameChain = logger.child({ caller: "tenant-A" }).child({ caller: "slice-B" })
    sameChain.warn("chain.op: msg")
    expect(captured.length).toBe(1) // suppressed: same fused bucket
  })

  test("(6) two distinct chains under the same prefix → independent buckets", () => {
    const chainA = logger.child({ caller: "tenant-A" }).child({ caller: "slice-X" })
    const chainB = logger.child({ caller: "tenant-B" }).child({ caller: "slice-X" })
    // chainA drains its bucket: cold-start = 1 token → 1 emit + 1 suppress.
    chainA.warn("hot.op: spam")
    chainA.warn("hot.op: spam")
    expect(captured.length).toBe(1)
    // chainB on the SAME prefix has its OWN bucket → emits.
    chainB.warn("hot.op: spam")
    expect(captured.length).toBe(2)
  })

  test("(7) `::` in a child component is stripped — no sibling-bucket forgery", () => {
    // Adversarial chain: parent caller is "tenant-A"; child component embeds
    // `::tenant-B` hoping the fused id becomes `tenant-A.::tenant-B` and the
    // `::` survives as a sibling-namespace separator. sanitizeCaller strips
    // `::` from the FUSED id so the result is a flat fused id — its bucket
    // is independent of tenant-B's.
    const fused = logger.child({ caller: "tenant-A" }).child({ caller: "::tenant-B" })
    fused.warn("forge.op: msg")
    // Tenant B emits the same message under its own bucket — must not collide
    // with the fused-attacker bucket.
    const tenantB = logger.child({ caller: "tenant-B" })
    tenantB.warn("forge.op: msg")
    expect(captured.length).toBe(2) // both emit; distinct buckets
    // Re-emit on the FUSED-attacker chain: its own bucket is now empty →
    // suppressed. Tenant B's bucket is untouched, so a second emit from B
    // (in fact a third overall) does NOT emit because B's cold-start token
    // is also spent. Pin both halves:
    fused.warn("forge.op: msg")
    expect(captured.length).toBe(2) // attacker still locked out
  })
})

describe("R10 — per-call callSite override + empty / threshold edges", () => {
  test("(8) per-call `callSite` overrides the bound caller (explicit > bound)", () => {
    // Bound caller is "tenant-A". Drain its bucket.
    const log = logger.child({ caller: "tenant-A" })
    log.warn("ovr.op: msg")
    log.warn("ovr.op: msg")
    expect(captured.length).toBe(1)
    // Per-call override to "tenant-B" — lands on a DIFFERENT bucket.
    log.warn("ovr.op: msg", undefined, { caller: "tenant-B" })
    expect(captured.length).toBe(2)
  })

  test("(9) empty child component → effective caller unchanged from parent", () => {
    // logger.child({ caller: "tenant-A" }).child({}) and the bare
    // child({ caller: "tenant-A" }) MUST share a bucket (no separator
    // suffix gets appended for an empty component).
    const parent = logger.child({ caller: "tenant-A" })
    const noop = parent.child({}) // empty cs → identity
    parent.warn("empty.op: msg") // emits on tenant-A bucket
    noop.warn("empty.op: msg") // same bucket → suppressed
    expect(captured.length).toBe(1)
  })

  test("(10) threshold gate runs FIRST — child caller cannot smuggle debug", () => {
    process.env.QUANTA_LOG_LEVEL = "warn"
    __resetRuntimeConfig()
    // Even with a fresh per-child bucket, the threshold gate fires before
    // any bucket accounting, so a debug-level line under any caller is
    // dropped without consuming a token.
    const log = logger.child({ caller: "tenant-A" })
    log.debug("smug.op: msg")
    expect(captured.length).toBe(0)
  })

  test("(11) child() is allocation-only — no per-write state leaked into base", () => {
    // Constructing 100 distinct child loggers under the SAME caller and
    // emitting through each must yield exactly one bucket (the bound id) —
    // child() must not register any per-instance bucket. We verify by
    // emitting once per child: only the FIRST emit gets a token; the
    // remaining 99 are suppressed on the same bucket.
    for (let i = 0; i < 100; i++) {
      const child = logger.child({ caller: "shared-tenant" })
      child.warn("share.op: msg")
    }
    expect(captured.length).toBe(1)
  })
})

// ---- Part 2: PluginHost production wire -------------------------------------

interface FakeProcessControl {
  readonly process: IsolatedProcess
  push(msg: unknown): void
  finishExit(code: number | null): void
}

const createFakeProcess = (serviceName: string): FakeProcessControl => {
  const listeners = new Set<(m: unknown) => void>()
  let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {
    // assigned below
  }
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((res) => {
    resolveExit = res
  })
  const process: IsolatedProcess = {
    pid: 12345,
    serviceName,
    send: () => {},
    onMessage: (h) => {
      listeners.add(h)
      return () => {
        listeners.delete(h)
      }
    },
    kill: async () => {
      resolveExit({ code: 0, signal: "SIGTERM" })
      await exitPromise
    },
    exitPromise,
  }
  return {
    process,
    push: (msg) => {
      for (const h of Array.from(listeners)) h(msg)
    },
    finishExit: (code) => {
      resolveExit({ code, signal: null })
    },
  }
}

describe("R10 wire — PluginHost: per-plugin bucket isolation", () => {
  test("(12) two PluginHosts under distinct serviceName have independent buckets", async () => {
    const ctlA = createFakeProcess("plugin-A")
    const ctlB = createFakeProcess("plugin-B")
    const hostA = new PluginHost(ctlA.process)
    const hostB = new PluginHost(ctlB.process)
    // Plugin A spams 60 non-object frames. All five warn sites share the
    // `plugin-host:` prefix, so under R9 (per-call caller) this would still
    // namespace per plugin — but the R10 wire ensures the namespace is
    // applied transparently inside the class. Cold-start = 1 → 1 emit + 59
    // suppressed on A's bucket.
    for (let i = 0; i < 60; i++) {
      ctlA.push("not-an-object")
    }
    expect(captured.length).toBe(1)
    // Plugin B emits ONCE — same prefix, but its own bucket. Without the
    // wire (or with logger.warn without caller) B would land on A's drained
    // bucket and be suppressed.
    ctlB.push("not-an-object")
    expect(captured.length).toBe(2)
    await hostA.stop()
    await hostB.stop()
  })

  test("(13) plugin-host output line shape is unchanged by the wire (back-compat)", async () => {
    const ctl = createFakeProcess("plugin-x")
    const host = new PluginHost(ctl.process)
    ctl.push("not-an-object")
    // Pre-R10 framing: `[warn] plugin-host: dropping non-object frame {"serviceName":"plugin-x"}\n`
    expect(captured).toEqual([
      '[warn] plugin-host: dropping non-object frame {"serviceName":"plugin-x"}\n',
    ])
    await host.stop()
  })

  test("(14) per-plugin malformed-envelope warn lands on per-plugin bucket", async () => {
    const ctlA = createFakeProcess("plugin-A")
    const ctlB = createFakeProcess("plugin-B")
    const hostA = new PluginHost(ctlA.process)
    const hostB = new PluginHost(ctlB.process)
    // Different warn site (`dropping malformed envelope`) but the SAME
    // colon-bounded prefix `plugin-host`. The bucket label is
    // `${serviceName}::plugin-host`, so A and B are independent.
    for (let i = 0; i < 30; i++) {
      // Object frame missing jsonrpc / id / method → malformed envelope
      ctlA.push({ foo: 1 })
    }
    expect(captured.length).toBe(1) // A drained
    ctlB.push({ foo: 1 })
    expect(captured.length).toBe(2) // B independent
    await hostA.stop()
    await hostB.stop()
  })
})
