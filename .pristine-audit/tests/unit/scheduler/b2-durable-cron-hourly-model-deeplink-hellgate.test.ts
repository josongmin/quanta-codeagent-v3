/**
 * B2 hellgate — durable-store engine-select + per-task model round-trip +
 * HOURLY/MINUTELY freq advance + cross-surface deeplink build/parse.
 *
 * RED-FIRST battery. Four independent seams, each with a wiring proof + a
 * red-on-injection anchor:
 *
 *   Engine-select (LIVE wire, ADR-0279 assembleAutomation)
 *     B2-ES-01  QUANTA_AUTOMATION_STORE=sqlite ⇒ slot.engine is the sqlite
 *               adapter (wiring: schedule persists to the injected Database).
 *     B2-ES-02  QUANTA_AUTOMATION_STORE unset ⇒ in-memory (default-OFF
 *               byte-identical; the injected sqlite factory is NEVER called).
 *     B2-ES-03  QUANTA_AUTOMATION_STORE=garbage ⇒ in-memory (only the exact
 *               canonical value flips the store; red-on-injection guard).
 *
 *   Per-task model round-trip (port.ScheduleInput → persist → read)
 *     B2-MD-01  in-memory: schedule with model+fallbacks ⇒ list echoes them.
 *     B2-MD-02  sqlite: schedule with model+fallbacks ⇒ list echoes them
 *               (survives the row→engine mapper, proving the columns persist).
 *     B2-MD-03  omit model ⇒ key OMITTED (no `model: undefined` leak) on BOTH.
 *
 *   HOURLY / MINUTELY frequency
 *     B2-FR-01  parseRRule accepts FREQ=HOURLY / FREQ=MINUTELY.
 *     B2-FR-02  computeNextFire advances +1h for HOURLY, +1m for MINUTELY.
 *     B2-FR-03  INTERVAL honored (FREQ=HOURLY;INTERVAL=3 ⇒ +3h).
 *     B2-FR-04  UNTIL exhaustion still returns "never".
 *
 *   Deeplink (pure, no I/O)
 *     B2-DL-01  build(threadId) ⇒ quanta://threads/{threadId}.
 *     B2-DL-02  parse(build(x)) round-trips to x (incl. url-unsafe chars).
 *     B2-DL-03  parse of a foreign/garbage uri ⇒ null (no throw).
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type AutomationEnginePort,
  inMemoryAutomationEngine,
  sqliteAutomationEngine,
} from "@/scheduler/automation-engine"
import { buildThreadDeeplink, parseThreadDeeplink } from "@/scheduler/deeplink"
import { computeNextFire } from "@/scheduler/next-fire"
import { parseRRule } from "@/scheduler/rrule-parser"
import {
  AUTOMATION_ENV_FLAG,
  AUTOMATION_STORE_ENV,
  assembleAutomation,
} from "@/scheduler/runtime-wire"
import type { AgentLoopPort, RRule } from "@/scheduler/types"
import { buildDefaultTools } from "@/tool"
import { threadsHandoffTool } from "@/tool/threads_handoff"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, 0)

const makeEnv = (o: Record<string, string>): { get: (k: string) => string | undefined } => {
  const m = new Map(Object.entries(o))
  return { get: (k) => m.get(k) }
}

const noopLoop: AgentLoopPort = { enqueueUserMessage: async () => {} }

// ───────────────────────────────────────────────────────────────────────────
// Engine-select on the LIVE wire
// ───────────────────────────────────────────────────────────────────────────

describe("B2 engine-select (assembleAutomation live wire)", () => {
  test("B2-ES-01: STORE=sqlite ⇒ sqlite adapter (persists to injected db)", async () => {
    const db = new Database(":memory:")
    let calls = 0
    const slot = assembleAutomation(
      makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_STORE_ENV]: "sqlite" }),
      {
        agentLoop: noopLoop,
        sqliteEngineFactory: () => {
          calls += 1
          return sqliteAutomationEngine(db)
        },
      },
    )
    if (slot === null) throw new Error("unreachable")
    expect(calls).toBe(1)
    const r = await slot.engine.schedule({
      id: "s1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    expect(r.ok).toBe(true)
    // Wiring proof: the row actually landed in THIS Database handle.
    const rows = db.query("SELECT id FROM automations").all() as Array<{ id: string }>
    expect(rows.map((x) => x.id)).toEqual(["s1"])
  })

  test("B2-ES-02: STORE unset ⇒ in-memory (factory never called; default-OFF)", async () => {
    let calls = 0
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: noopLoop,
      sqliteEngineFactory: () => {
        calls += 1
        return sqliteAutomationEngine(new Database(":memory:"))
      },
    })
    if (slot === null) throw new Error("unreachable")
    expect(calls).toBe(0)
    // The in-memory adapter exposes `runs`/`inbox` inspection seams; sqlite does not.
    expect((slot.engine as { runs?: unknown }).runs).toBeDefined()
  })

  test("B2-ES-03: STORE=garbage ⇒ in-memory (only canonical 'sqlite' flips)", () => {
    let calls = 0
    const slot = assembleAutomation(
      makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_STORE_ENV]: "postgres" }),
      {
        agentLoop: noopLoop,
        sqliteEngineFactory: () => {
          calls += 1
          return sqliteAutomationEngine(new Database(":memory:"))
        },
      },
    )
    if (slot === null) throw new Error("unreachable")
    expect(calls).toBe(0)
    expect((slot.engine as { runs?: unknown }).runs).toBeDefined()
  })

  test("B2-ES-04: explicit deps.engine WINS over STORE=sqlite (precedence; factory never called)", async () => {
    // The docstring contract: an explicit `deps.engine` "takes precedence over
    // the env-driven store selector … the engine-select branch is bypassed
    // entirely." Without this, a host that pre-builds an engine while
    // QUANTA_AUTOMATION_STORE=sqlite lives in the ambient env would silently be
    // swapped onto the disk DB (and open a Database it never asked for). RED
    // when the deps.engine short-circuit is checked AFTER the store branch.
    let factoryCalls = 0
    const injected = inMemoryAutomationEngine()
    const slot = assembleAutomation(
      makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_STORE_ENV]: "sqlite" }),
      {
        agentLoop: noopLoop,
        engine: injected,
        sqliteEngineFactory: () => {
          factoryCalls += 1
          return sqliteAutomationEngine(new Database(":memory:"))
        },
      },
    )
    if (slot === null) throw new Error("unreachable")
    // The sqlite factory must NOT have been consulted at all.
    expect(factoryCalls).toBe(0)
    // The slot carries the EXACT injected engine instance (identity), not a
    // wrapper and not the sqlite adapter.
    expect(slot.engine).toBe(injected)
    // And it is the in-memory adapter (exposes the `runs` inspection seam that
    // the sqlite adapter lacks) — a second, adapter-shape witness.
    expect((slot.engine as { runs?: unknown }).runs).toBeDefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Per-task model round-trip
// ───────────────────────────────────────────────────────────────────────────

const bothEngines = (): Array<{ name: string; eng: AutomationEnginePort }> => [
  { name: "in-memory", eng: inMemoryAutomationEngine() },
  { name: "sqlite", eng: sqliteAutomationEngine(new Database(":memory:")) },
]

describe("B2 per-task model round-trip", () => {
  for (const { name, eng } of bothEngines()) {
    test(`B2-MD-01/02: ${name} persists+returns model+modelFallbacks`, async () => {
      const r = await eng.schedule({
        id: "m1",
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: utc(2026, 5, 25, 10),
        createdAt: utc(2026, 5, 25),
        model: "gpt-5.5",
        modelFallbacks: ["gpt-5.4", "gpt-5"],
      })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value.model).toBe("gpt-5.5")
      expect(r.value.modelFallbacks).toEqual(["gpt-5.4", "gpt-5"])
      // Fresh read-back through list() (proves it survives persistence, not
      // just the schedule() echo).
      const list = await eng.list()
      if (!list.ok) throw new Error("unreachable")
      const got = list.value.find((a) => a.id === "m1")
      expect(got?.model).toBe("gpt-5.5")
      expect(got?.modelFallbacks).toEqual(["gpt-5.4", "gpt-5"])
    })
  }

  for (const { name, eng } of bothEngines()) {
    test(`B2-MD-04: ${name} model survives a claim→finalize fire cycle`, async () => {
      const now = utc(2026, 5, 25, 12)
      await eng.schedule({
        id: "mf1",
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: now - 1000,
        createdAt: now - 10_000,
        model: "gpt-5.5",
        modelFallbacks: ["gpt-5.4"],
      })
      const claimed = await eng.claim(now)
      if (!claimed.ok || claimed.value === null) throw new Error("claim failed")
      // The claimed (running) row must still carry the model.
      expect(claimed.value.automation.model).toBe("gpt-5.5")
      const fin = await eng.finalize({
        id: "mf1",
        claimToken: claimed.value.claimToken,
        firedAt: now,
        outcome: "fired",
        nextRunAt: now + 86_400_000,
        inboxTitle: "t",
        inboxSummary: "s",
      })
      if (!fin.ok) throw new Error("finalize failed")
      expect(fin.value.model).toBe("gpt-5.5")
      expect(fin.value.modelFallbacks).toEqual(["gpt-5.4"])
      // And on a fresh read-back.
      const list = await eng.list()
      if (!list.ok) throw new Error("unreachable")
      expect(list.value.find((a) => a.id === "mf1")?.model).toBe("gpt-5.5")
    })
  }

  for (const { name, eng } of bothEngines()) {
    test(`B2-MD-03: ${name} omits model key when absent (no undefined leak)`, async () => {
      await eng.schedule({
        id: "m2",
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: utc(2026, 5, 25, 10),
        createdAt: utc(2026, 5, 25),
      })
      const list = await eng.list()
      if (!list.ok) throw new Error("unreachable")
      const got = list.value.find((a) => a.id === "m2")
      if (got === undefined) throw new Error("unreachable")
      expect("model" in got).toBe(false)
      expect("modelFallbacks" in got).toBe(false)
    })
  }

  for (const { name, eng } of bothEngines()) {
    test(`B2-MD-05: ${name} preserves an EMPTY modelFallbacks array (distinct from absent)`, async () => {
      // An explicit empty list `[]` is semantically distinct from an absent
      // list: it means "this task has NO fallbacks" (host must not fall through
      // to a global default chain). On sqlite it round-trips as the JSON string
      // "[]" — a naive `if (fallbacks.length)` persist/read guard would collapse
      // it to absent, and an over-eager parser would drop it. Pin the distinction.
      await eng.schedule({
        id: "me1",
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: utc(2026, 5, 25, 10),
        createdAt: utc(2026, 5, 25),
        model: "gpt-5.5",
        modelFallbacks: [],
      })
      const list = await eng.list()
      if (!list.ok) throw new Error("unreachable")
      const got = list.value.find((a) => a.id === "me1")
      if (got === undefined) throw new Error("unreachable")
      expect(got.model).toBe("gpt-5.5")
      // The key is PRESENT and its value is the empty array — NOT dropped.
      expect("modelFallbacks" in got).toBe(true)
      expect(got.modelFallbacks).toEqual([])
    })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// HOURLY / MINUTELY
// ───────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const MINUTE = 60_000

describe("B2 HOURLY/MINUTELY frequency", () => {
  test("B2-FR-01: parseRRule accepts HOURLY + MINUTELY", () => {
    const h = parseRRule("FREQ=HOURLY")
    expect(h.ok).toBe(true)
    if (h.ok) expect(h.freq).toBe("HOURLY")
    const m = parseRRule("FREQ=MINUTELY")
    expect(m.ok).toBe(true)
    if (m.ok) expect(m.freq).toBe("MINUTELY")
  })

  test("B2-FR-02: computeNextFire advances +1h / +1m", () => {
    const from = utc(2026, 5, 25, 10, 30)
    expect(computeNextFire(ruleOf("FREQ=HOURLY"), from, 0)).toBe(from + HOUR)
    expect(computeNextFire(ruleOf("FREQ=MINUTELY"), from, 0)).toBe(from + MINUTE)
  })

  test("B2-FR-03: INTERVAL honored (HOURLY;INTERVAL=3 ⇒ +3h)", () => {
    const from = utc(2026, 5, 25, 10, 0)
    expect(computeNextFire(ruleOf("FREQ=HOURLY;INTERVAL=3"), from, 0)).toBe(from + 3 * HOUR)
    expect(computeNextFire(ruleOf("FREQ=MINUTELY;INTERVAL=15"), from, 0)).toBe(from + 15 * MINUTE)
  })

  test("B2-FR-04: UNTIL exhaustion ⇒ never", () => {
    const from = utc(2026, 5, 25, 10, 0)
    // UNTIL is 30 min out; next HOURLY fire (+1h) exceeds it ⇒ never.
    const rule = ruleOf("FREQ=HOURLY;UNTIL=20260525T103000Z")
    expect(computeNextFire(rule, from, 0)).toBe("never")
  })

  test("B2-FR-05: COUNT exhaustion ⇒ never (fireCount-based)", () => {
    const from = utc(2026, 5, 25, 10, 0)
    const rule = ruleOf("FREQ=HOURLY;COUNT=3")
    // fireCount already at the cap ⇒ never; below ⇒ advances.
    expect(computeNextFire(rule, from, 3)).toBe("never")
    expect(computeNextFire(rule, from, 2)).toBe(from + HOUR)
  })

  test("B2-FR-06: strict-boundary — from exactly on an instant ⇒ next step", () => {
    // Two consecutive HOURLY fires never collapse to the same instant.
    const from = utc(2026, 5, 25, 10, 0)
    const first = computeNextFire(ruleOf("FREQ=HOURLY"), from, 0)
    expect(first).toBe(from + HOUR)
    if (first === "never") throw new Error("unreachable")
    const second = computeNextFire(ruleOf("FREQ=HOURLY"), first, 1)
    expect(second).toBe(from + 2 * HOUR)
    expect(second).not.toBe(first)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Deeplink
// ───────────────────────────────────────────────────────────────────────────

describe("B2 thread deeplink build/parse", () => {
  test("B2-DL-01: build ⇒ quanta://threads/{id}", () => {
    expect(buildThreadDeeplink("abc123")).toBe("quanta://threads/abc123")
  })

  test("B2-DL-02: parse(build(x)) round-trips (incl. url-unsafe chars)", () => {
    for (const id of ["abc123", "a/b c?d#e", "한글-id", "with%20pct"]) {
      const link = buildThreadDeeplink(id)
      expect(parseThreadDeeplink(link)).toBe(id)
    }
  })

  test("B2-DL-03: foreign/garbage uri ⇒ null (no throw)", () => {
    expect(parseThreadDeeplink("https://threads/abc")).toBeNull()
    expect(parseThreadDeeplink("quanta://inbox/abc")).toBeNull()
    expect(parseThreadDeeplink("quanta://threads/")).toBeNull()
    expect(parseThreadDeeplink("not a uri")).toBeNull()
    expect(parseThreadDeeplink("")).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// threads_handoff tool
// ───────────────────────────────────────────────────────────────────────────

const makeCtx = (): ToolContext =>
  ({ cwd: "/tmp/b2", signal: new AbortController().signal }) as unknown as ToolContext

const drain = async (
  iter: AsyncIterable<ToolEvent>,
): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> => {
  for await (const e of iter) {
    if (e.type === "result") {
      const r = e.result
      const structured = (r as { structured?: Record<string, unknown> }).structured
      return {
        ok: r.ok,
        output: r.output ?? "",
        ...(structured !== undefined ? { structured } : {}),
      }
    }
  }
  throw new Error("no result")
}

describe("B2 threads_handoff tool", () => {
  test("B2-TH-01: registration gated on automationEngine (off ⇒ absent)", () => {
    const off = buildDefaultTools()
    expect(off.find((t) => t.name === "threads_handoff")).toBeUndefined()
    const on = buildDefaultTools({ automationEngine: inMemoryAutomationEngine() })
    expect(on.find((t) => t.name === "threads_handoff")).toBeDefined()
  })

  test("B2-TH-02: emits a parseable deeplink for the target thread", async () => {
    const res = await drain(threadsHandoffTool().execute({ threadId: "t-42" }, makeCtx()))
    expect(res.ok).toBe(true)
    const link = res.structured?.deeplink as string
    expect(link).toBe(buildThreadDeeplink("t-42"))
    expect(parseThreadDeeplink(link)).toBe("t-42")
  })
})
