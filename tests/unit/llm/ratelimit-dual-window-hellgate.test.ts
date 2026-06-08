/**
 * §9.3 — account DUAL-WINDOW ratelimit (Codex `RateLimitWindow` parity) hellgate.
 *
 * Codex emits, on EVERY response, per-account dual-window quota headers:
 *   x-codex-primary-used-percent / x-codex-primary-window-minutes / x-codex-primary-reset-at
 *   x-codex-secondary-used-percent / ... (the secondary, slower window)
 * Each maps to a `RateLimitWindow { usedPercent, windowMinutes, resetsAt }`,
 * and the snapshot is ACCUMULATED per-account across requests (last-write-wins
 * per window, but the store is keyed by account so a 2nd request on the same
 * account refines the SAME bucket rather than starting fresh).
 *
 * This is the PROACTIVE half complementing the existing single-window
 * remaining/reset parser (`parse.ts`): used_percent/window_minutes is the
 * Codex shape, distinct from Anthropic/OpenAI remaining/reset.
 *
 * Hellgate cases:
 *   DW-01: parse primary+secondary from a full Codex header set
 *   DW-02: partial (primary only) — secondary stays absent
 *   DW-03: garbage used_percent / window_minutes ⇒ field absent (no NaN)
 *   DW-04: no recognized header ⇒ undefined (byte-identity: no clobber)
 *   DW-05: hostile getter throws ⇒ undefined (no-throw)
 *   DW-06: e2e — 2nd request on the SAME account ACCUMULATES into one bucket
 *   DW-07: e2e — two accounts keep SEPARATE buckets
 *   DW-08: reset-at HTTP-date is resolved to relative ms (clock-injected)
 *   DW-09: used_percent clamped to [0,100]; out-of-range ⇒ absent
 */

import { describe, expect, test } from "bun:test"
import {
  type AccountRateLimitStore,
  createAccountRateLimitStore,
  type DualWindowSnapshot,
  parseDualWindowSnapshot,
} from "@/llm/ratelimit-snapshot"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"

const getter = (h: Record<string, string>) => (name: string): string | null =>
  h[name.toLowerCase()] ?? null

const FIXED_NOW = 1_000_000_000_000 // ms-epoch

describe("§9.3 dual-window parse", () => {
  test("DW-01: parses primary+secondary windows", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "42.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "10",
        "x-codex-secondary-window-minutes": "10080",
      }),
      () => FIXED_NOW,
    )
    expect(snap).toBeDefined()
    expect(snap?.primary?.usedPercent).toBe(42.5)
    expect(snap?.primary?.windowMinutes).toBe(300)
    expect(snap?.secondary?.usedPercent).toBe(10)
    expect(snap?.secondary?.windowMinutes).toBe(10080)
    expect(snap?.observedAt).toBe(FIXED_NOW)
  })

  test("DW-02: primary only — secondary absent", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(snap?.primary).toBeDefined()
    expect(snap?.secondary).toBeUndefined()
  })

  test("DW-03: garbage used_percent / window_minutes ⇒ field absent (no NaN)", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "not-a-number",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    // window_minutes is valid → window exists, but usedPercent must be absent.
    expect(snap?.primary).toBeDefined()
    expect(snap?.primary?.usedPercent).toBeUndefined()
    expect(snap?.primary?.windowMinutes).toBe(300)
  })

  test("DW-04: no recognized header ⇒ undefined (no clobber)", () => {
    const snap = parseDualWindowSnapshot(
      getter({ "x-some-other-header": "1" }),
      () => FIXED_NOW,
    )
    expect(snap).toBeUndefined()
  })

  test("DW-05: hostile getter throws ⇒ undefined (no-throw)", () => {
    const hostile = (): string | null => {
      throw new Error("boom")
    }
    expect(() => parseDualWindowSnapshot(hostile, () => FIXED_NOW)).not.toThrow()
    expect(parseDualWindowSnapshot(hostile, () => FIXED_NOW)).toBeUndefined()
  })

  test("DW-08: reset-at HTTP-date resolved to relative ms", () => {
    const resetAt = new Date(FIXED_NOW + 5 * 60_000).toUTCString()
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": resetAt,
      }),
      () => FIXED_NOW,
    )
    expect(snap?.primary?.resetMs).toBeGreaterThanOrEqual(4 * 60_000)
    expect(snap?.primary?.resetMs).toBeLessThanOrEqual(5 * 60_000)
  })

  test("DW-09: used_percent out of [0,100] ⇒ absent", () => {
    const over = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "150",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(over?.primary?.usedPercent).toBeUndefined()
    const neg = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "-1",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(neg?.primary?.usedPercent).toBeUndefined()
  })
})

describe("§9.3 dual-window per-account accumulation (e2e)", () => {
  test("DW-06: 2nd request on the SAME account accumulates into one bucket", () => {
    const store: AccountRateLimitStore = createAccountRateLimitStore()
    let now = FIXED_NOW

    // Request 1: primary at 40% reported.
    store.observe(
      "acct-A",
      parseDualWindowSnapshot(
        getter({
          "x-codex-primary-used-percent": "40",
          "x-codex-primary-window-minutes": "300",
        }),
        () => now,
      ),
    )
    let cur = store.current("acct-A")
    expect(cur?.primary?.usedPercent).toBe(40)
    expect(cur?.secondary).toBeUndefined()

    // Request 2 (later): primary climbs to 55%, secondary now appears at 5%.
    now = FIXED_NOW + 10_000
    store.observe(
      "acct-A",
      parseDualWindowSnapshot(
        getter({
          "x-codex-primary-used-percent": "55",
          "x-codex-primary-window-minutes": "300",
          "x-codex-secondary-used-percent": "5",
          "x-codex-secondary-window-minutes": "10080",
        }),
        () => now,
      ),
    )
    cur = store.current("acct-A")
    // Same bucket, refined: primary updated, secondary now present.
    expect(cur?.primary?.usedPercent).toBe(55)
    expect(cur?.secondary?.usedPercent).toBe(5)
    expect(cur?.observedAt).toBe(now)
  })

  test("DW-06b: an undefined observation does NOT clobber the prior bucket", () => {
    const store = createAccountRateLimitStore()
    store.observe(
      "acct-A",
      parseDualWindowSnapshot(
        getter({
          "x-codex-primary-used-percent": "40",
          "x-codex-primary-window-minutes": "300",
        }),
        () => FIXED_NOW,
      ),
    )
    // A non-Codex response → parser returns undefined → must be a no-op.
    store.observe("acct-A", undefined)
    expect(store.current("acct-A")?.primary?.usedPercent).toBe(40)
  })

  test("DW-07: two accounts keep SEPARATE buckets", () => {
    const store = createAccountRateLimitStore()
    store.observe("acct-A", { primary: { usedPercent: 40 }, observedAt: FIXED_NOW })
    store.observe("acct-B", { primary: { usedPercent: 90 }, observedAt: FIXED_NOW })
    expect(store.current("acct-A")?.primary?.usedPercent).toBe(40)
    expect(store.current("acct-B")?.primary?.usedPercent).toBe(90)
  })

  test("DW-07b: current() for an unseen account ⇒ undefined", () => {
    const store = createAccountRateLimitStore()
    expect(store.current("never-seen")).toBeUndefined()
  })
})

/**
 * Fake adapter that drives the REAL `StreamInput.onResponseHeaders` seam — the
 * same hook the live Anthropic adapter invokes via `.withResponse()`. The
 * composition-root behaviour (parse headers → observe into the account store)
 * is wired exactly as the loop would wire it, so this exercises the dual-window
 * accumulation end-to-end through the LLMPort contract, not just the parser.
 */
const makeDualWindowAdapter = (
  headersPerCall: ReadonlyArray<Record<string, string>>,
): LLMPort => {
  let call = 0
  return {
    model: "codex-test",
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      const headers = headersPerCall[call] ?? {}
      call += 1
      // Real adapter contract: invoke onResponseHeaders ONCE with a
      // case-insensitive accessor BEFORE yielding the parsed stream.
      if (input.onResponseHeaders !== undefined) {
        const get = (name: string): string | null => headers[name.toLowerCase()] ?? null
        try {
          input.onResponseHeaders(get)
        } catch {
          // best-effort, mirrors the adapter
        }
      }
      const ev: StreamEvent = { type: "text_delta", delta: "ok" }
      yield ev
    },
  }
}

describe("§9.3 dual-window e2e (real LLMPort onResponseHeaders seam)", () => {
  test("DW-E2E: 2nd request accumulates the dual-window through the real hook", async () => {
    const store = createAccountRateLimitStore()
    let now = FIXED_NOW
    const account = "acct-live"
    const adapter = makeDualWindowAdapter(
      [
        // request 1: primary 30%, no secondary yet
        {
          "x-codex-primary-used-percent": "30",
          "x-codex-primary-window-minutes": "300",
        },
        // request 2: primary 70%, secondary appears at 12%
        {
          "x-codex-primary-used-percent": "70",
          "x-codex-primary-window-minutes": "300",
          "x-codex-secondary-used-percent": "12",
          "x-codex-secondary-window-minutes": "10080",
        },
      ],
    )

    // The composition-root hook: parse → observe (default-OFF when unset).
    const onResponseHeaders = (get: (name: string) => string | null): void => {
      store.observe(account, parseDualWindowSnapshot(get, () => now))
    }

    // Drive request 1 through the real stream contract.
    const drain = async (): Promise<void> => {
      for await (const _ of adapter.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        system: "",
        tools: [],
        onResponseHeaders,
      })) {
        // consume
      }
    }
    await drain()
    expect(store.current(account)?.primary?.usedPercent).toBe(30)
    expect(store.current(account)?.secondary).toBeUndefined()

    // 2nd request on the SAME account accumulates into the SAME bucket.
    now = FIXED_NOW + 60_000
    await drain()
    const cur = store.current(account)
    expect(cur?.primary?.usedPercent).toBe(70)
    expect(cur?.secondary?.usedPercent).toBe(12)
    expect(cur?.observedAt).toBe(now)
  })

  test("DW-E2E byte-identity: adapter with NO hook never touches the store", async () => {
    const store = createAccountRateLimitStore()
    const adapter = makeDualWindowAdapter([
      { "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300" },
    ])
    // Default-OFF: no onResponseHeaders passed ⇒ store stays empty.
    for await (const _ of adapter.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "",
      tools: [],
    })) {
      // consume
    }
    expect(store.current("acct-x")).toBeUndefined()
  })
})

// Type-only assertions to lock the exported shape.
describe("§9.3 type surface", () => {
  test("DualWindowSnapshot shape", () => {
    const s: DualWindowSnapshot = {
      primary: { usedPercent: 1, windowMinutes: 2, resetMs: 3 },
      secondary: { usedPercent: 4 },
      observedAt: 5,
    }
    expect(s.primary?.usedPercent).toBe(1)
  })
})
