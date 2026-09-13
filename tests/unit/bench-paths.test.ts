/**
 * Pin the bench artifacts root to a PERSISTENT location.
 *
 * Bug it closes: bench workdirs + outputs defaulted to `os.tmpdir()`, which the
 * OS reaps — earlier triage data (per-run patches + trajectory JSONL) silently
 * vanished between sessions. `benchHome()` now resolves a persistent root with
 * a fixed precedence and NEVER returns a tmp path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  benchHome,
  benchInstanceWorkSlug,
  benchRunDir,
  benchRunsRoot,
  benchWorkRoot,
} from "@/../src/apps/bench/corpus/paths"
import { __resetRuntimeConfig } from "@/shared"
import { makeTempDirOwner } from "../_helpers/temp-dir"

const SAVED = { ...process.env }
const scratch = makeTempDirOwner()

beforeEach(() => {
  for (const k of ["QUANTA_BENCH_HOME", "QUANTA_HOME"]) delete process.env[k]
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = { ...SAVED }
  __resetRuntimeConfig()
  scratch.disposeAll()
})

describe("benchHome — persistent root precedence", () => {
  test("QUANTA_BENCH_HOME wins outright", () => {
    process.env.QUANTA_BENCH_HOME = "/custom/bench/root"
    __resetRuntimeConfig()
    expect(benchHome()).toBe("/custom/bench/root")
  })

  test("QUANTA_HOME ⇒ <home>/bench when no bench override", () => {
    process.env.QUANTA_HOME = "/srv/quanta"
    __resetRuntimeConfig()
    expect(benchHome()).toBe("/srv/quanta/bench")
  })

  test("no override ⇒ a persistent home, NEVER tmpdir()", () => {
    const home = benchHome()
    expect(home.startsWith(tmpdir())).toBe(false)
    expect(home).toContain("bench")
  })

  /**
   * These three resolvers CREATE their directory, so they run against a scratch bench
   * home. Against the default they made `work/`, `runs/` and `runs/run-xyz/` in the
   * developer's real bench root on every run (measured). What they owe is exact
   * composition under `benchHome()`; that the default `benchHome()` is not tmp is the
   * pure test above, and exact composition under it carries that property down.
   */
  test("work + runs roots are exactly <benchHome>/work and /runs, and exist", () => {
    process.env.QUANTA_BENCH_HOME = scratch.create("bench-paths-")
    __resetRuntimeConfig()
    const home = benchHome()
    expect(benchWorkRoot()).toBe(join(home, "work"))
    expect(benchRunsRoot()).toBe(join(home, "runs"))
    expect(existsSync(join(home, "work"))).toBe(true)
    expect(existsSync(join(home, "runs"))).toBe(true)
  })

  test("benchRunDir groups under runs/<runId>", () => {
    process.env.QUANTA_BENCH_HOME = scratch.create("bench-paths-")
    __resetRuntimeConfig()
    const dir = benchRunDir("run-xyz")
    expect(dir).toBe(`${benchRunsRoot()}/run-xyz`)
    expect(existsSync(dir)).toBe(true)
  })

  test("agent-visible work slug is stable and does not expose the instance id", () => {
    const id = "instance_owner__repo-deadbeefcafebabefeedface0123456789abcdef"
    const slug = benchInstanceWorkSlug(id)
    expect(slug).toMatch(/^[0-9a-f]{20}$/)
    expect(slug).toBe(benchInstanceWorkSlug(id))
    expect(slug).not.toContain("deadbeef")
    expect(slug).not.toContain(id)
  })
})
