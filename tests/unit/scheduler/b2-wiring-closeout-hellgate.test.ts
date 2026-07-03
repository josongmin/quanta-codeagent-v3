/**
 * B2 wiring closeout — the two DEFERRED gaps from the 949a286fb audit, closed
 * RED-first with mutation proofs:
 *
 *   GAP 1 — real on-disk sqlite factory (`defaultSqliteEngineFactory`).
 *     The prior battery injected a `:memory:` factory, so the REAL disk path
 *     (mkdirSync + `new Database(path)` under the resolved Quanta home) was
 *     NEVER exercised. These tests drive `assembleAutomation` with
 *     STORE=sqlite and NO injected factory, pointing the Quanta home at a temp
 *     dir, and prove: the .db file is created, a schedule persists, and a FRESH
 *     engine reopened over the SAME path reads it back (durability across a
 *     "restart"). Temp dir is removed after.
 *
 *   GAP 2 — per-task model actually REROUTES the live fire.
 *     Before this closeout the stored `model`/`modelFallbacks` were persisted +
 *     returned but NO consumer used them at fire time: the handler dispatched
 *     `enqueueUserMessage(a.prompt)` with no `modelOverride`. Now the handler
 *     runs `chooseModel` over `[model, ...fallbacks]` and passes the winner as
 *     `modelOverride`. Proven through the REAL `tickScheduler` fire path:
 *       - configured model ⇒ fired with that model (mutation: drop the override
 *         ⇒ RED).
 *       - injected availability drives the fallback chain (preference down ⇒
 *         first-available fallback wins).
 *       - all candidates down ⇒ the fire is recorded `errored` (never silently
 *         runs on the host default).
 *       - NO per-task model ⇒ NO override (byte-identical to the pre-B2 path).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import {
  type AutomationEnginePort,
  type AutomationHandler,
  ensureAutomationEngineSchema,
  sqliteAutomationEngine,
  tickScheduler,
  type TickOutcome,
} from "@/scheduler/automation-engine"
import { computeNextFire } from "@/scheduler/next-fire"
import { parseRRule } from "@/scheduler/rrule-parser"
import {
  AUTOMATION_ENV_FLAG,
  AUTOMATION_STORE_ENV,
  assembleAutomation,
  defaultAutomationDbPath,
} from "@/scheduler/runtime-wire"
import type { AgentLoopPort, ModelAvailabilityPort, RRule } from "@/scheduler/types"
import { __resetRuntimeConfig } from "@/shared"

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

/** Capture every enqueue call (message + opts) so the reroute is observable. */
const recordingLoop = (): {
  loop: AgentLoopPort
  calls: Array<{ message: string; modelOverride: string | undefined }>
} => {
  const calls: Array<{ message: string; modelOverride: string | undefined }> = []
  return {
    loop: {
      enqueueUserMessage: async (message, opts) => {
        calls.push({ message, modelOverride: opts?.modelOverride })
      },
    },
    calls,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// GAP 1 — real on-disk sqlite factory
// ───────────────────────────────────────────────────────────────────────────

describe("B2 GAP1 — real disk sqlite factory (defaultSqliteEngineFactory)", () => {
  const savedConfigDir = process.env.QUANTA_CONFIG_DIR
  const savedHome = process.env.QUANTA_HOME
  let tmp: string | undefined

  const useTempHome = (): string => {
    tmp = mkdtempSync(join(tmpdir(), "b2-disk-"))
    process.env.QUANTA_CONFIG_DIR = tmp
    // Ensure the stale HOME alias never wins over the temp root.
    delete process.env.QUANTA_HOME
    __resetRuntimeConfig()
    return tmp
  }

  afterEach(() => {
    // Restore env + runtime-config singleton and remove the temp dir.
    if (savedConfigDir === undefined) delete process.env.QUANTA_CONFIG_DIR
    else process.env.QUANTA_CONFIG_DIR = savedConfigDir
    if (savedHome === undefined) delete process.env.QUANTA_HOME
    else process.env.QUANTA_HOME = savedHome
    __resetRuntimeConfig()
    if (tmp !== undefined) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = undefined
    }
  })

  test("B2-DISK-01: STORE=sqlite w/ NO factory ⇒ real .db created + persists + reopen reads back", async () => {
    const home = useTempHome()
    // Sanity: the default path resolves UNDER the temp home (creates nothing).
    const dbPath = defaultAutomationDbPath()
    expect(dbPath.startsWith(home)).toBe(true)
    expect(existsSync(dbPath)).toBe(false)

    // Assemble WITHOUT a sqliteEngineFactory ⇒ the REAL defaultSqliteEngineFactory
    // runs: mkdirSync(parent) + new Database(dbPath).
    const slot = assembleAutomation(
      makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_STORE_ENV]: "sqlite" }),
      { agentLoop: noopLoop },
    )
    if (slot === null) throw new Error("unreachable — slot should be built")

    // The on-disk file now exists (the factory opened it, creating the parent dir).
    expect(existsSync(dbPath)).toBe(true)

    const r = await slot.engine.schedule({
      id: "disk1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
      model: "gpt-5.5",
      modelFallbacks: ["gpt-5.4"],
    })
    expect(r.ok).toBe(true)

    // DURABILITY: a FRESH engine opened over the SAME on-disk path reads the row
    // back — proving it hit real disk, not an ephemeral :memory: handle.
    const reopened = sqliteAutomationEngine(new Database(dbPath))
    const list = await reopened.list()
    if (!list.ok) throw new Error("unreachable")
    const got = list.value.find((a) => a.id === "disk1")
    expect(got).toBeDefined()
    expect(got?.model).toBe("gpt-5.5")
    expect(got?.modelFallbacks).toEqual(["gpt-5.4"])
  })

  test("B2-DISK-02: default path is a real absolute file under the Quanta home", () => {
    const home = useTempHome()
    const p = defaultAutomationDbPath()
    expect(p).toBe(join(home, "sqlite", "automations.db"))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// B2 sqlite migration idempotency (audit item: additive model columns)
// ───────────────────────────────────────────────────────────────────────────

const columnNames = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe("B2 sqlite migration idempotency", () => {
  test("B2-MIG-01: re-running ensureAutomationEngineSchema is a no-op (no duplicate-column throw)", () => {
    const db = new Database(":memory:")
    ensureAutomationEngineSchema(db)
    const first = columnNames(db, "automations")
    // The additive B2 columns landed on the first pass.
    expect(first).toContain("model")
    expect(first).toContain("model_fallbacks")
    // Re-running must NOT throw (ALTER TABLE ADD COLUMN is guarded by the pragma
    // probe) and must not change the column set.
    expect(() => ensureAutomationEngineSchema(db)).not.toThrow()
    expect(columnNames(db, "automations")).toEqual(first)
    db.close()
  })

  test("B2-MIG-02: a pre-B2 DB (no model columns) is migrated additively on open", async () => {
    const db = new Database(":memory:")
    // Simulate a legacy DB created BEFORE the B2 columns existed: the old
    // pre-T10/pre-B2 automations table with data already present.
    db.exec(`
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, rule_json TEXT NOT NULL,
        prompt TEXT NOT NULL, next_run_at INTEGER NOT NULL, last_run_at INTEGER,
        status TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
        fire_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.exec(`
      INSERT INTO automations (id, title, rule_json, prompt, next_run_at, status, created_at, fire_count)
      VALUES ('legacy1', 'L', '{"freq":"DAILY"}', 'p', ${utc(2026, 5, 25, 10)}, 'scheduled', ${utc(2026, 5, 25)}, 0)
    `)
    const before = columnNames(db, "automations")
    expect(before).not.toContain("model")

    // Opening the engine runs the additive migration — must not throw, must add
    // the columns, and the legacy row must survive + read back with model absent.
    const eng = sqliteAutomationEngine(db)
    const after = columnNames(db, "automations")
    expect(after).toContain("model")
    expect(after).toContain("model_fallbacks")
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    const legacy = list.value.find((a) => a.id === "legacy1")
    if (legacy === undefined) throw new Error("legacy row vanished after migration")
    // Sanity: the migrated legacy row is fully readable (rule survived the mapper).
    expect(legacy.prompt).toBe("p")
    expect(legacy.rule.freq).toBe("DAILY")
    // A migrated legacy row has NULL model columns ⇒ the mapper OMITS the keys.
    expect("model" in legacy).toBe(false)
    expect("modelFallbacks" in legacy).toBe(false)
    db.close()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// B2 rrule UNTIL boundary — candidate landing EXACTLY on UNTIL fires
// ───────────────────────────────────────────────────────────────────────────

describe("B2 HOURLY UNTIL boundary (inclusive)", () => {
  test("B2-FR-07: next fire landing EXACTLY on UNTIL still fires (inclusive bound)", () => {
    // from 10:00, HOURLY, UNTIL exactly 11:00 ⇒ the +1h candidate == UNTIL ⇒
    // `candidate > until` is FALSE ⇒ it fires. One more step (12:00 > 11:00) ⇒ never.
    const from = utc(2026, 5, 25, 10, 0)
    const rule = ruleOf("FREQ=HOURLY;UNTIL=20260525T110000Z")
    const first = computeNextFire(rule, from, 0)
    expect(first).toBe(utc(2026, 5, 25, 11, 0))
    if (first === "never") throw new Error("unreachable")
    // The instant AFTER the inclusive bound is exhausted.
    expect(computeNextFire(rule, first, 1)).toBe("never")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GAP 2 — per-task model reroutes the live fire (through real tickScheduler)
// ───────────────────────────────────────────────────────────────────────────

/** Schedule a due automation on the slot's engine, then fire ONE real tick
 *  through the slot's handler. Returns the tick outcome. */
const scheduleAndFire = async (
  slot: { engine: AutomationEnginePort; handler: AutomationHandler },
  over: Partial<{ model: string; modelFallbacks: ReadonlyArray<string> }>,
): Promise<TickOutcome> => {
  const now = utc(2026, 5, 25, 12)
  const r = await slot.engine.schedule({
    id: "fire1",
    title: "T",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "do-the-thing",
    nextRunAt: now - 1000,
    createdAt: now - 10_000,
    ...(over.model !== undefined ? { model: over.model } : {}),
    ...(over.modelFallbacks !== undefined ? { modelFallbacks: over.modelFallbacks } : {}),
  })
  if (!r.ok) throw new Error("schedule failed")
  return tickScheduler({ engine: slot.engine, now, handler: slot.handler })
}

const availabilityOf = (up: ReadonlySet<string>): ModelAvailabilityPort => ({
  isAvailable: (m) => Promise.resolve(up.has(m)),
})

describe("B2 GAP2 — per-task model reroutes the live fire", () => {
  test("B2-RR-01: configured model ⇒ enqueued with modelOverride = that model", async () => {
    const { loop, calls } = recordingLoop()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), { agentLoop: loop })
    if (slot === null) throw new Error("unreachable")
    const outcome = await scheduleAndFire(slot, { model: "gpt-5.5" })
    expect(outcome.kind).toBe("fired")
    // WIRING PROOF + mutation anchor: dropping the override (reverting to
    // enqueueUserMessage(a.prompt)) makes modelOverride undefined ⇒ RED.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.message).toBe("do-the-thing")
    expect(calls[0]?.modelOverride).toBe("gpt-5.5")
  })

  test("B2-RR-02: NO per-task model ⇒ NO override (byte-identical pre-B2 fire)", async () => {
    const { loop, calls } = recordingLoop()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), { agentLoop: loop })
    if (slot === null) throw new Error("unreachable")
    const outcome = await scheduleAndFire(slot, {})
    expect(outcome.kind).toBe("fired")
    expect(calls).toHaveLength(1)
    // No model set ⇒ the handler must pass NO modelOverride (host default wins).
    expect(calls[0]?.modelOverride).toBeUndefined()
  })

  test("B2-RR-03: injected availability drives the fallback chain (preference down ⇒ fallback wins)", async () => {
    const { loop, calls } = recordingLoop()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      // preference "gpt-5.5" is DOWN; first fallback "gpt-5.4" is UP.
      modelAvailability: availabilityOf(new Set(["gpt-5.4"])),
    })
    if (slot === null) throw new Error("unreachable")
    const outcome = await scheduleAndFire(slot, {
      model: "gpt-5.5",
      modelFallbacks: ["gpt-5.4", "gpt-5"],
    })
    expect(outcome.kind).toBe("fired")
    expect(calls[0]?.modelOverride).toBe("gpt-5.4")
  })

  test("B2-RR-04: ALL candidates unavailable ⇒ fire recorded ERRORED (never silent host-default)", async () => {
    const { loop, calls } = recordingLoop()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      modelAvailability: availabilityOf(new Set()), // nothing is up
    })
    if (slot === null) throw new Error("unreachable")
    const outcome = await scheduleAndFire(slot, {
      model: "gpt-5.5",
      modelFallbacks: ["gpt-5.4"],
    })
    // The handler THREW ⇒ tickScheduler records errored; the prompt was NEVER
    // enqueued (no silent fire on a wrong/host-default model).
    expect(outcome.kind).toBe("errored")
    expect(calls).toHaveLength(0)
    if (outcome.kind === "errored") {
      expect(outcome.errorMessage).toContain("no available model")
    }
  })

  test("B2-RR-05: reroute is invoked lazily at FIRE time, not assemble time", async () => {
    // A probe that would THROW if called at assemble must not be touched until a
    // fire actually happens. Assembling a slot with NO due row and never ticking
    // ⇒ zero probe calls. This pins that the availability seam is fire-scoped.
    let probes = 0
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: noopLoop,
      modelAvailability: {
        isAvailable: (m) => {
          probes += 1
          return Promise.resolve(m === "gpt-5.5")
        },
      },
    })
    if (slot === null) throw new Error("unreachable")
    expect(probes).toBe(0)
    // A tick with an empty engine ⇒ idle ⇒ still no probe.
    const idle = await tickScheduler({
      engine: slot.engine,
      now: utc(2026, 5, 25, 12),
      handler: slot.handler,
    })
    expect(idle.kind).toBe("idle")
    expect(probes).toBe(0)
  })
})
