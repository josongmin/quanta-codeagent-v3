/**
 * HELLGATE — the `/model` catalog probe is DEADLINED and CANCELLABLE (MR-07).
 *
 * THE MEASURED DEFECT. `LLMPort.listModels` was declared `() => Promise<…>` — no
 * signal, no deadline — and `model-catalog.ts#probeCatalog` simply awaited it.
 * Two of the four adapters passed no signal to their HTTP call at all. Both
 * user-facing consumers BLOCK on that await:
 *   - `apps/cli/slash/model-cmd.ts` (`await model.refresh?.()`) — the `/model`
 *     picker does not open until the probe settles;
 *   - `apps/web-daemon/runtime-factory/readout-sources.ts`
 *     (`await modelSwitch.refresh()`) — the `GET /readout/model` route.
 * The probe's base URL is operator-overridable (`QUANTA_LLM_ENDPOINT` /
 * `baseURL`), so a hung endpoint wedged both FOREVER. A probe confirmed
 * `refresh()` still pending at 500ms against a hung `listModels`.
 *
 * WHAT THIS SUITE REFUSES TO ACCEPT AS PROOF:
 *   - a caller-side race. "The caller stopped waiting" is not "the request was
 *     cancelled" — a race leaves a live socket and, on a guarded endpoint, a live
 *     credentialed request. So every case here drives the REAL
 *     `OpenAIResponsesAdapter` against a stub TRANSPORT and asserts on the
 *     `AbortSignal` THAT TRANSPORT RECEIVED. The stub's hung response never
 *     settles on its own: if the adapter drops the signal, the test HANGS (red),
 *     it cannot pass by accident;
 *   - a hand-rolled catalog. The wire under test is the real
 *     `buildModelCatalogWire`, called through its real `refresh()`.
 *
 * WHY `AbortSignal.timeout` IS PATCHED. The production deadline is 10s
 * (`MODEL_CATALOG_PROBE_TIMEOUT_MS`) and the per-test speed budget is 8,529ms
 * (`tools/dev/unit-speed-budget.json`), so a real-time expiry test is not
 * expressible. Patching the constructor lets the suite BOTH shorten the clock and
 * — in `PROBE-CANCEL-01` — record the ms value the production path actually
 * requested, which is the wiring proof that the shipped default is the constant
 * and not some other number a refactor left behind.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import { buildModelCatalogWire, MODEL_CATALOG_PROBE_TIMEOUT_MS } from "@/llm/model-catalog"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { logger } from "@/shared"

// ─────────────────────────── stub transport ────────────────────────────────

/** What `fetch` rejects with when its `AbortSignal` fires. The adapter funnels it
 *  through `LLMError.fromSdkError`, exactly as a real abort would. */
const abortError = (reason: unknown): unknown =>
  reason instanceof Error ? reason : new DOMException("This operation was aborted", "AbortError")

interface StubTransport {
  /** Shape-compatible with `ResponsesFetchLike`. */
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  /** The signal each request was given — `undefined` when the adapter passed
   *  NONE, which is the defect this suite exists to catch. */
  readonly signals: (AbortSignal | undefined)[]
  /** True once a request's own signal actually fired, i.e. the abort reached the
   *  transport rather than only the awaiting caller. */
  aborted: boolean
  /** How many requests the transport saw. */
  calls: number
}

/** Record the request's signal on `t` and start watching it for an abort. */
const observe = (t: StubTransport, init: RequestInit | undefined): AbortSignal | undefined => {
  t.calls += 1
  const signal = init?.signal ?? undefined
  t.signals.push(signal)
  return signal
}

/**
 * A transport that NEVER answers — the hung endpoint. It settles only when the
 * request's own signal aborts.
 *
 * Deliberately no internal timer: if the adapter forwards no signal, this promise
 * stays pending forever and the test times out. A stub that "gave up" after N ms
 * would let a signal-dropping adapter pass.
 */
const hungTransport = (): StubTransport => {
  const t: StubTransport = {
    fetchImpl: async (_url, init) => {
      const signal = observe(t, init)
      return await new Promise<Response>((_resolve, reject) => {
        if (signal === undefined) return // hangs forever — the pre-MR-07 behaviour
        const fire = (): void => {
          t.aborted = true
          reject(abortError(signal.reason))
        }
        if (signal.aborted) fire()
        else signal.addEventListener("abort", fire, { once: true })
      })
    },
    signals: [],
    aborted: false,
    calls: 0,
  }
  return t
}

/** The PAIRED CONTROL transport: same seam, same deadline, answers immediately. */
const fastTransport = (ids: readonly string[]): StubTransport => {
  const t: StubTransport = {
    fetchImpl: async (_url, init) => {
      const signal = observe(t, init)
      signal?.addEventListener(
        "abort",
        () => {
          t.aborted = true
        },
        { once: true },
      )
      return new Response(
        JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
    signals: [],
    aborted: false,
    calls: 0,
  }
  return t
}

// ───────────────────────── deadline clock control ──────────────────────────

const realTimeout = AbortSignal.timeout.bind(AbortSignal)
type TimeoutHost = { timeout: (ms: number) => AbortSignal }

/** Every ms value the production path handed to `AbortSignal.timeout`. */
let requestedMs: number[] = []
/** When set, the deadline actually installed (so the suite fits the budget). */
let clampMs: number | undefined

beforeEach(() => {
  requestedMs = []
  clampMs = undefined
  ;(AbortSignal as unknown as TimeoutHost).timeout = (ms: number): AbortSignal => {
    requestedMs.push(ms)
    return realTimeout(clampMs ?? ms)
  }
})

afterEach(() => {
  ;(AbortSignal as unknown as TimeoutHost).timeout = realTimeout
})

// ───────────────────────────── wire under test ──────────────────────────────

const ADAPTER_CFG = { apiKey: "sk-test-key", model: "boot-model" }

/** The real catalog wire over the real adapter. `buildPort` returns `null` for
 *  every id — this suite is about the PROBE, not port minting, and a null build
 *  keeps `candidates` empty so `ids()` reflects exactly the seed. */
const wireOver = (
  llm: LLMPort,
  extra?: { readonly signal?: AbortSignal },
): ReturnType<typeof buildModelCatalogWire> =>
  buildModelCatalogWire({
    provider: "openai",
    bootModel: "boot-model",
    llm,
    seeded: [],
    buildPort: () => stubPort("built"),
    ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
    env: {} as NodeJS.ProcessEnv,
  })

const stubPort = (model: string): LLMPort => ({
  model,
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

/** Resolve to `"settled"` if `p` finishes inside `ms`, else `"pending"`. Used to
 *  assert the CALLER is released, independently of what it resolved to. */
const settlesWithin = async (p: Promise<unknown>, ms: number): Promise<"settled" | "pending"> => {
  let done = false
  void p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
    if (done) return "settled"
  }
  return done ? "settled" : "pending"
}

describe("model-catalog probe — deadline + cancellation (MR-07)", () => {
  test("PROBE-CANCEL-01 — the shipped deadline IS the named constant (wiring proof)", async () => {
    // A probe that answers instantly: the only thing under test is WHICH ms value
    // the production path asked `AbortSignal.timeout` for. Deriving the
    // expectation from the exported constant AND pinning the constant's literal
    // value means neither a silent constant edit nor a hardcoded ms in
    // `probeCatalog` can pass.
    expect(MODEL_CATALOG_PROBE_TIMEOUT_MS).toBe(10_000)
    const probe: LLMPort = { ...stubPort("boot-model"), listModels: async () => ["a", "b"] }
    const wire = wireOver(probe)
    await wire.refresh()

    expect(requestedMs).toEqual([MODEL_CATALOG_PROBE_TIMEOUT_MS])
    expect(wire.probeSucceeded()).toBe(true)
  })

  test("PROBE-CANCEL-02 — a hung endpoint ABORTS THE REAL REQUEST and degrades fail-open", async () => {
    clampMs = 60 // stand-in for the 10s production deadline (speed budget)
    const t = hungTransport()
    const adapter = new OpenAIResponsesAdapter({ ...ADAPTER_CFG, fetchImpl: t.fetchImpl })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const wire = wireOver(adapter)

      // 1. THE CALLER IS RELEASED. Pre-MR-07 this stayed pending forever.
      expect(await settlesWithin(wire.refresh(), 3_000)).toBe("settled")
      // 2. AND THE REQUEST ITSELF WAS CANCELLED — not merely abandoned. This is
      //    the half a caller-side race cannot satisfy.
      expect(t.calls).toBe(1)
      expect(t.signals[0], "the adapter forwarded NO signal to fetch").toBeDefined()
      expect(t.aborted, "the transport's own signal never fired").toBe(true)
      // 3. FAIL-OPEN, byte-identical to a rejected probe: seeded set stands,
      //    `probeSucceeded` false, exactly ONE warn.
      expect(wire.ids()).toEqual(["boot-model"])
      expect(wire.probeSucceeded()).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("model catalog probe failed")
    } finally {
      warn.mockRestore()
    }
  })

  test("PROBE-CANCEL-03 — PAIRED CONTROL: a fast probe under the same deadline is untouched", async () => {
    // Identical wire, identical (short) deadline, identical adapter — the ONLY
    // difference is that the endpoint answers. Without this, PROBE-CANCEL-02
    // would also pass if the deadline were broken to "abort immediately".
    clampMs = 60
    const t = fastTransport(["gpt-4o", "o3"])
    const adapter = new OpenAIResponsesAdapter({ ...ADAPTER_CFG, fetchImpl: t.fetchImpl })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const wire = wireOver(adapter)
      await wire.refresh()

      expect(wire.probeSucceeded()).toBe(true)
      expect(wire.ids()).toEqual(["boot-model", "gpt-4o", "o3"])
      expect(t.aborted, "a fast probe must not be aborted").toBe(false)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("PROBE-CANCEL-04 — a CALLER signal cancels the probe (composed, not replaced)", async () => {
    // The deadline is far away; only the caller's own signal can end this probe.
    // If the implementation REPLACED the caller signal with its own timeout, the
    // request would never be aborted and this hangs.
    clampMs = 30_000
    const t = hungTransport()
    const adapter = new OpenAIResponsesAdapter({ ...ADAPTER_CFG, fetchImpl: t.fetchImpl })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const ac = new AbortController()
      const wire = wireOver(adapter, { signal: ac.signal })
      const pending = wire.refresh()
      // Let the request reach the transport, then tear the session down.
      await new Promise((r) => setTimeout(r, 30))
      ac.abort()

      expect(await settlesWithin(pending, 3_000)).toBe("settled")
      expect(t.aborted, "the caller's abort never reached the request").toBe(true)
      expect(wire.probeSucceeded()).toBe(false)
      expect(wire.ids()).toEqual(["boot-model"])
    } finally {
      warn.mockRestore()
    }
  })

  test("PROBE-CANCEL-05 — with a caller signal present the DEADLINE still fires (the other half of 'composed')", async () => {
    // Mirror of -04: a caller signal that NEVER aborts must not disarm the
    // deadline. If the implementation used the caller signal INSTEAD of the
    // timeout, this hangs.
    clampMs = 60
    const t = hungTransport()
    const adapter = new OpenAIResponsesAdapter({ ...ADAPTER_CFG, fetchImpl: t.fetchImpl })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const neverAborts = new AbortController()
      const wire = wireOver(adapter, { signal: neverAborts.signal })

      expect(await settlesWithin(wire.refresh(), 3_000)).toBe("settled")
      expect(t.aborted).toBe(true)
      expect(neverAborts.signal.aborted).toBe(false)
      expect(requestedMs).toEqual([MODEL_CATALOG_PROBE_TIMEOUT_MS])
      expect(wire.probeSucceeded()).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test("PROBE-CANCEL-06 — an ALREADY-aborted caller signal short-circuits the probe (no wedge)", async () => {
    clampMs = 30_000
    const t = hungTransport()
    const adapter = new OpenAIResponsesAdapter({ ...ADAPTER_CFG, fetchImpl: t.fetchImpl })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const wire = wireOver(adapter, { signal: AbortSignal.abort() })

      expect(await settlesWithin(wire.refresh(), 3_000)).toBe("settled")
      expect(t.aborted).toBe(true)
      expect(wire.probeSucceeded()).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
