/**
 * jun-26 bench full-trajectory recording DEFAULT-ON.
 *
 * Industry-SOTA: SWE-agent / mini-swe / LangSmith all persist the FULL agent
 * conversation by default — recording is opt-OUT, not opt-in. Bench now records
 * the LLM trajectory by default (a CODE default, mirroring `reasoning-summary`,
 * so it rides the rsynced bench source to the full-remote box with NO env
 * forwarding) while staying overridable: an explicit
 * `QUANTA_BENCH_RECORD_TRAJECTORY=0`/off (operator opt-OUT) wins, and replay
 * (`QUANTA_BENCH_REPLAY_TRAJECTORY`) still takes precedence and never spuriously
 * collides with the default-on record path.
 *
 * Seam: `resolveBenchTrajectoryDefault(env)` (pure, env-injected) +
 * `resolveBenchTrajectoryMode()` (process.env-reading wrapper consumed by the
 * bench entry). NON-bench surfaces (CLI/web) never call these, so their
 * trajectory behavior is byte-identical (proven indirectly: only bench imports
 * this module's record path).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type BenchTrajectoryMode,
  resolveBenchTrajectoryDefault,
  resolveBenchTrajectoryMode,
} from "@/apps/bench/trajectory"

const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
const REPLAY_KEY = "QUANTA_BENCH_REPLAY_TRAJECTORY"
const REPLAY_ON_MISS_KEY = "QUANTA_BENCH_REPLAY_ON_MISS"
const DEFAULT_PATH = `${process.cwd()}/bench-trajectory.jsonl`

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {
    [RECORD_KEY]: process.env[RECORD_KEY],
    [REPLAY_KEY]: process.env[REPLAY_KEY],
    [REPLAY_ON_MISS_KEY]: process.env[REPLAY_ON_MISS_KEY],
  }
  delete process.env[RECORD_KEY]
  delete process.env[REPLAY_KEY]
  delete process.env[REPLAY_ON_MISS_KEY]
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("resolveBenchTrajectoryDefault — bench record default-ON, env-overridable", () => {
  test("unset env ⇒ record to the default path (default-ON, opt-OUT not opt-in)", () => {
    expect(resolveBenchTrajectoryDefault({})).toEqual({ path: DEFAULT_PATH, explicit: false })
  })

  test('empty string is NOT an opt-out ⇒ stays default-ON (not "explicit")', () => {
    expect(resolveBenchTrajectoryDefault({ [RECORD_KEY]: "" })).toEqual({
      path: DEFAULT_PATH,
      explicit: false,
    })
  })

  test("explicit OFF (0/off/false/no) ⇒ no recording, explicit=true (operator opt-OUT)", () => {
    for (const off of ["0", "off", "false", "no", "OFF", "False"]) {
      expect(resolveBenchTrajectoryDefault({ [RECORD_KEY]: off })).toEqual({
        path: undefined,
        explicit: true,
      })
    }
  })

  test("explicit truthy (1/on) ⇒ default path, explicit=true", () => {
    expect(resolveBenchTrajectoryDefault({ [RECORD_KEY]: "1" })).toEqual({
      path: DEFAULT_PATH,
      explicit: true,
    })
    expect(resolveBenchTrajectoryDefault({ [RECORD_KEY]: "on" })).toEqual({
      path: DEFAULT_PATH,
      explicit: true,
    })
  })

  test("explicit custom path ⇒ that path, explicit=true", () => {
    expect(resolveBenchTrajectoryDefault({ [RECORD_KEY]: "/x/cassette.jsonl" })).toEqual({
      path: "/x/cassette.jsonl",
      explicit: true,
    })
  })
})

describe("resolveBenchTrajectoryMode — default-ON record, replay precedence preserved", () => {
  test("unset env ⇒ kind=record at the default path (DEFAULT-ON)", () => {
    const mode = resolveBenchTrajectoryMode()
    expect(mode.kind).toBe("record")
    expect((mode as Extract<BenchTrajectoryMode, { kind: "record" }>).path).toBe(DEFAULT_PATH)
  })

  test("record=0 ⇒ kind=off (operator opt-OUT)", () => {
    process.env[RECORD_KEY] = "0"
    expect(resolveBenchTrajectoryMode()).toEqual({ kind: "off" })
  })

  test("record=<path> ⇒ kind=record at that path", () => {
    process.env[RECORD_KEY] = "/tmp/my-cassette.jsonl"
    expect(resolveBenchTrajectoryMode()).toEqual({ kind: "record", path: "/tmp/my-cassette.jsonl" })
  })

  test("replay set (record UNSET) ⇒ kind=replay — default-on record does NOT collide", () => {
    process.env[REPLAY_KEY] = "/tmp/cass.jsonl"
    const mode = resolveBenchTrajectoryMode()
    expect(mode.kind).toBe("replay")
    expect((mode as Extract<BenchTrajectoryMode, { kind: "replay" }>).path).toBe("/tmp/cass.jsonl")
    expect((mode as Extract<BenchTrajectoryMode, { kind: "replay" }>).onMiss).toBe("throw")
  })

  test("replay set + record EXPLICITLY set ⇒ still throws (mutual exclusion preserved)", () => {
    process.env[REPLAY_KEY] = "/tmp/cass.jsonl"
    process.env[RECORD_KEY] = "/tmp/other.jsonl"
    expect(() => resolveBenchTrajectoryMode()).toThrow(/cannot combine/)
  })

  test("replay set + record EXPLICITLY ON (=1) ⇒ still throws (explicit collision)", () => {
    process.env[REPLAY_KEY] = "/tmp/cass.jsonl"
    process.env[RECORD_KEY] = "1"
    expect(() => resolveBenchTrajectoryMode()).toThrow(/cannot combine/)
  })

  test("replay set + record EXPLICITLY OFF (=0) ⇒ replay wins (opt-out is not a collision)", () => {
    process.env[REPLAY_KEY] = "/tmp/cass.jsonl"
    process.env[RECORD_KEY] = "0"
    expect(resolveBenchTrajectoryMode().kind).toBe("replay")
  })
})
