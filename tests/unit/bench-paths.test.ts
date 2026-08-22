/**
 * Pin the bench artifacts root to a PERSISTENT location.
 *
 * Bug it closes: bench workdirs + outputs defaulted to `os.tmpdir()`, which the
 * OS reaps — earlier triage data (per-run patches + trajectory JSONL) silently
 * vanished between sessions. `benchHome()` now resolves a persistent root with
 * a fixed precedence and NEVER returns a tmp path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import {
  benchHome,
  benchInstanceWorkSlug,
  benchRunDir,
  benchRunsRoot,
  benchWorkRoot,
} from "@/../src/apps/bench/corpus/paths"
import { __resetRuntimeConfig } from "@/shared"

const SAVED = { ...process.env }

beforeEach(() => {
  for (const k of ["QUANTA_BENCH_HOME", "QUANTA_HOME"]) delete process.env[k]
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = { ...SAVED }
  __resetRuntimeConfig()
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

  test("work + runs roots live under benchHome and are not tmp", () => {
    const home = benchHome()
    expect(benchWorkRoot().startsWith(home)).toBe(true)
    expect(benchRunsRoot().startsWith(home)).toBe(true)
    expect(benchWorkRoot().startsWith(tmpdir())).toBe(false)
    expect(benchRunsRoot().startsWith(tmpdir())).toBe(false)
  })

  test("benchRunDir groups under runs/<runId>", () => {
    const dir = benchRunDir("run-xyz")
    expect(dir).toBe(`${benchRunsRoot()}/run-xyz`)
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
