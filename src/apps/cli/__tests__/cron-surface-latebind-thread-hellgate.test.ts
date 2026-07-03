/**
 * jul-04 CLI `/cron` LIVE-DATA hellgate (B2, HARDEST) — closes the "landed-but-
 * empty" gap for the automation-engine surface command.
 *
 * PRIOR STATE (the gap this pins):
 *   - The `AutomationEnginePort` (schedule/list) is minted LATE, INSIDE
 *     `runSessionLoop` (`liveAutomationSlot`), AFTER the surface wire bundle +
 *     slash-dispatch were built. So the `/cron`/`/schedule`/`/inbox` `automation`
 *     ctx slot was never populated — the commands printed "not wired" even with
 *     `QUANTA_AUTOMATION=on`. There was ALSO no adapter between the engine's
 *     `schedule(ScheduleInput{rule:RRule,nextRunAt})` and the slash's
 *     `create(title, rule:string, prompt)`.
 *
 * THE CONTRACT (LATE-BIND setter, ONE engine):
 *   1. The adapter (`createCronSlashAdapter`) PARSES an RRULE string + computes
 *      the first fire (via `@/scheduler` — no new dep) + calls `engine.schedule`;
 *      `list` re-serializes stored rules; `inbox` reads the engine's inbox.
 *   2. LATE-BIND: the surface dispatch reads the automation slot via a GETTER; a
 *      setter (mirroring `setPlanQueueSendNow`) installs the adapter once the
 *      engine exists. BEFORE install ⇒ `/cron` "not wired"; AFTER install ⇒ live.
 *   3. Single-engine: a `/cron create` lands on the SAME engine `/cron list`
 *      reads — no split-brain.
 *   4. rrule INVALID ⇒ a clean typed error line (never a crash).
 *
 * Boundary: drives the REAL `createCronSlashAdapter` over a live in-memory engine
 * AND the REAL `buildSurfaceDispatch` late-bind getter + a setter closure, so a
 * broken thread turns `/cron` red.
 */

import { describe, expect, test } from "bun:test"
import { createCronSlashAdapter } from "@/scheduler"
import { inMemoryAutomationEngine } from "@/scheduler/automation-engine"
import { buildReplSlashCtx } from "../repl/slash-surface"
import { buildSurfaceDispatch } from "../repl/surface-compose/dispatch"
import { buildDefaultSessionIo } from "../repl/surface-compose/wire-builders"
import type { AutomationSlashState } from "../slash/cron-cmd"
import { runSlashCommand } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

/** A `/cron` ctx over an automation slot (mirrors the surface adapter that the
 *  dispatch closure builds — `automation` present iff installed). */
const cronCtx = (
  automation: AutomationSlashState | undefined,
): { ctx: SlashContext; out: () => string; err: () => string } => {
  let stdout = ""
  let stderr = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    now: () => 1_000_000,
    ...(automation !== undefined ? { automation } : {}),
  }
  return { ctx, out: () => stdout, err: () => stderr }
}

describe("B2 /cron LIVE — adapter over a live automation engine", () => {
  test("create → list round-trips over the SAME engine (single-engine, canonical RRULE)", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({
      engine,
      now: () => 1_000,
      idGen: () => "sched-1",
    })

    // Empty before any create.
    {
      const { ctx, out } = cronCtx(adapter)
      expect(await runSlashCommand("/cron", ctx)).toBe(0)
      expect(out()).toContain("no schedules")
    }

    // Create through the slash (which calls adapter.create → engine.schedule).
    {
      const { ctx, out } = cronCtx(adapter)
      expect(await runSlashCommand("/cron create FREQ=DAILY nightly build", ctx)).toBe(0)
      expect(out()).toContain("created")
      expect(out()).toContain("sched-1")
      expect(out()).toContain("FREQ=DAILY")
    }

    // List now shows the row over the SAME engine — proving one instance.
    {
      const { ctx, out } = cronCtx(adapter)
      expect(await runSlashCommand("/cron", ctx)).toBe(0)
      expect(out()).toContain("Schedules — 1")
      expect(out()).toContain("nightly build")
      expect(out()).toContain("FREQ=DAILY")
    }

    // The engine itself carries exactly one non-cancelled row (fresh readback).
    const listed = await engine.list()
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error("unreachable")
    expect(listed.value.length).toBe(1)
    expect(listed.value[0]?.title).toBe("nightly build")
  })

  test("invalid RRULE ⇒ a clean typed error line, exit 1, NO crash + NO schedule created", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({ engine, now: () => 1_000, idGen: () => "x" })
    const { ctx, err } = cronCtx(adapter)
    // `FREQ=NONSENSE` is not a valid frequency ⇒ parseRRule refuses.
    const code = await runSlashCommand("/cron create FREQ=NONSENSE bad rule", ctx)
    expect(code).toBe(1)
    expect(err().toLowerCase()).toContain("create failed")
    // Nothing was scheduled — the parse refusal short-circuits before schedule().
    const listed = await engine.list()
    if (!listed.ok) throw new Error("unreachable")
    expect(listed.value.length).toBe(0)
  })

  test("/inbox reads the engine's live inbox (empty until a fire records)", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({ engine })
    const { ctx, out } = cronCtx(adapter)
    expect(await runSlashCommand("/inbox", ctx)).toBe(0)
    expect(out()).toContain("/inbox: empty")
  })
})

// ── LATE-BIND wire (red-on-injection) ────────────────────────────────────────
//
// The surface builds the `/cron` slot as a GETTER over a mutable holder the loop
// SETS once the engine is minted. This reproduces that exact late-bind: a setter
// installs the adapter, and a getter-backed ctx reflects the install LIVE.

/** Reproduce the surface late-bind EXACTLY: a mutable slot + setter, read by a
 *  getter (the dispatch closure resolves `args.automation?.()` per invocation). */
const makeLateBind = () => {
  let slot: AutomationSlashState | undefined
  return {
    set: (a: AutomationSlashState | undefined) => {
      slot = a
    },
    get: () => slot,
  }
}

describe("B2 /cron LATE-BIND — the loop installs the slot after the engine mints", () => {
  test("BEFORE install ⇒ /cron 'not wired'; AFTER install ⇒ live (red-on-injection)", async () => {
    const bind = makeLateBind()

    // BEFORE the loop installs the adapter (engine not yet minted at compose time).
    {
      const { ctx, out } = cronCtx(bind.get())
      expect(await runSlashCommand("/cron", ctx)).toBe(0)
      expect(out().toLowerCase()).toContain("not wired")
    }

    // The loop mints the engine + installs the adapter (the late-bind setter).
    const engine = inMemoryAutomationEngine()
    bind.set(createCronSlashAdapter({ engine, now: () => 1_000, idGen: () => "late-1" }))

    // AFTER install ⇒ the SAME getter now resolves the live adapter ⇒ live render.
    {
      const { ctx, out } = cronCtx(bind.get())
      expect(await runSlashCommand("/cron create FREQ=WEEKLY weekly report", ctx)).toBe(0)
      expect(out()).toContain("created")
    }
    {
      const { ctx, out } = cronCtx(bind.get())
      expect(await runSlashCommand("/cron", ctx)).toBe(0)
      expect(out()).toContain("weekly report")
    }
  })

  test("UNINSTALL (set undefined) ⇒ /cron degrades back to 'not wired' (no stale deref)", async () => {
    const bind = makeLateBind()
    const engine = inMemoryAutomationEngine()
    bind.set(createCronSlashAdapter({ engine }))
    bind.set(undefined) // e.g. engine torn down
    const { ctx, out } = cronCtx(bind.get())
    expect(await runSlashCommand("/cron", ctx)).toBe(0)
    expect(out().toLowerCase()).toContain("not wired")
  })
})

// ── REAL buildSurfaceDispatch getter (surface wire red-on-injection) ──────────
//
// Pins the ACTUAL `buildSurfaceDispatch` `automation: () => …` getter path — the
// exact seam `surface-compose` wires the late-bound slot through. Capturing
// `process.stdout.write` (the dispatch closure writes there directly) proves the
// getter is resolved LIVE per dispatch: flipping the mutable slot AFTER building
// the dispatch changes the render, so a broken getter thread turns `/cron` red.

/** Run one slash input through the REAL dispatch, capturing stdout. */
const runThroughDispatch = async (
  dispatch: (input: string) => Promise<boolean>,
  input: string,
): Promise<string> => {
  const orig = process.stdout.write.bind(process.stdout)
  let captured = ""
  // Narrow monkeypatch for the duration of one dispatch (the dispatch closure
  // writes to process.stdout directly). Cast covers the overloaded write sig.
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write
  try {
    await dispatch(input)
  } finally {
    process.stdout.write = orig
  }
  return captured
}

describe("B2 /cron — REAL buildSurfaceDispatch late-bind getter (red-on-injection)", () => {
  test("dispatch resolves the automation getter LIVE — install flips /cron from not-wired to live", async () => {
    let slot: AutomationSlashState | undefined
    const slashCtx = buildReplSlashCtx({
      ...({} as Parameters<typeof buildReplSlashCtx>[0]),
    } as Parameters<typeof buildReplSlashCtx>[0])
    const dispatch = buildSurfaceDispatch({
      slashCtx,
      convCheckpointSlot: undefined,
      sessionIo: buildDefaultSessionIo(),
      inboundMode: { current: "queue" },
      // The SURFACE seam under test — a getter over the mutable slot the loop sets.
      automation: () => slot,
    })

    // BEFORE the loop installs ⇒ the getter yields undefined ⇒ "not wired".
    const before = await runThroughDispatch(dispatch, "/cron")
    expect(before.toLowerCase()).toContain("not wired")

    // The loop mints the engine + installs the adapter (late-bind).
    const engine = inMemoryAutomationEngine()
    slot = createCronSlashAdapter({ engine, now: () => 1_000, idGen: () => "d-1" })

    // AFTER install ⇒ the SAME dispatch now renders live (getter resolved fresh).
    const created = await runThroughDispatch(dispatch, "/cron create FREQ=DAILY d job")
    expect(created).toContain("created")
    const listed = await runThroughDispatch(dispatch, "/cron")
    expect(listed).toContain("d job")
    expect(listed).toContain("FREQ=DAILY")
  })
})
