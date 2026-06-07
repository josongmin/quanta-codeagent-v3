/**
 * HELLGATE — inline-trigger watcher boundary hardening (audit L3 C-13/C-14,
 * ticket T09).
 *
 *  C-13 (brace-expansion DoS):
 *   HELL-PB-01  combinatorial `{a,b}×N` glob is BOUNDED (no exponential blowup)
 *   HELL-PB-02  nested braces are bounded too
 *   HELL-PB-03  pathological glob completes fast + falls back to literal
 *   HELL-PB-04  ordinary globs still expand correctly (no regression)
 *   HELL-PB-05  matchesGlobSubset stays correct under the bound
 *
 *  C-14 (fire-and-forget unhandled rejection):
 *   HELL-PB-06  a throwing onFire callback does NOT surface as an unhandled
 *               rejection (dispatchScan swallows the detached error)
 *   HELL-PB-07  a normal onFire still fires for a matching marker
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchScan, expandBraces, matchesGlobSubset } from "@/skill/playbook"

describe("inline-trigger brace-expansion DoS bound (L3 C-13)", () => {
  test("HELL-PB-01: combinatorial {a,b} repeated 20× is bounded (≤ 256)", () => {
    const glob = "x" + "{a,b}".repeat(20) // 2^20 ≈ 1M if unbounded
    const start = performance.now()
    const out = expandBraces(glob)
    const ms = performance.now() - start
    expect(out.length).toBeLessThanOrEqual(256)
    expect(ms).toBeLessThan(100) // would be seconds+ if exponential
  })

  test("HELL-PB-02: nested braces are bounded", () => {
    const glob = "{a,b,c,d}".repeat(8) // 4^8 = 65536 unbounded
    const out = expandBraces(glob)
    expect(out.length).toBeLessThanOrEqual(256)
  })

  test("HELL-PB-03: overflow falls back to the literal glob (fail-safe)", () => {
    const glob = "p" + "{a,b}".repeat(20) + "q"
    const out = expandBraces(glob)
    // On overflow we return exactly the original literal.
    expect(out).toEqual([glob])
  })

  test("HELL-PB-04: ordinary globs expand correctly", () => {
    expect(expandBraces("src/*.{ts,tsx}").sort()).toEqual(["src/*.ts", "src/*.tsx"].sort())
    expect(expandBraces("noglob.ts")).toEqual(["noglob.ts"])
  })

  test("HELL-PB-05: matchesGlobSubset stays correct under the bound", () => {
    expect(matchesGlobSubset("src/a.ts", "src/*.{ts,tsx}")).toBe(true)
    expect(matchesGlobSubset("src/a.js", "src/*.{ts,tsx}")).toBe(false)
    // pathological glob disables only itself — never matches a real path,
    // never throws.
    expect(matchesGlobSubset("src/a.ts", "{a,b}".repeat(20))).toBe(false)
  })
})

describe("inline-trigger fire-and-forget routing (L3 C-14)", () => {
  let dir: string
  let unhandled: unknown[]
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-pb-"))
    unhandled = []
    process.on("unhandledRejection", onUnhandled)
  })
  afterEach(async () => {
    process.removeListener("unhandledRejection", onUnhandled)
    await rm(dir, { recursive: true, force: true })
  })

  test("HELL-PB-06: throwing onFire produces NO unhandled rejection", async () => {
    const file = join(dir, "code.ts")
    await writeFile(file, "// fix this AI!\nconst x = 1\n", "utf8")
    // dispatchScan is detached fire-and-forget; a throwing callback must be
    // swallowed, never escape as an unhandled rejection.
    dispatchScan(
      file,
      "AI!",
      () => {
        throw new Error("boom from callback")
      },
      Date.now(),
    )
    // give the detached scan + the microtask queue time to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(unhandled.length).toBe(0)
  })

  test("HELL-PB-07: normal onFire fires for a matching marker", async () => {
    const file = join(dir, "ok.ts")
    await writeFile(file, "line1\n// do this AI!\n", "utf8")
    const captured: { fired: { line: number; marker: string } | null } = { fired: null }
    dispatchScan(
      file,
      "AI!",
      (f) => {
        captured.fired = { line: f.line, marker: f.marker }
      },
      123,
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(captured.fired).not.toBeNull()
    if (captured.fired === null) throw new Error("expected onFire to have fired")
    expect(captured.fired.line).toBe(2)
    expect(unhandled.length).toBe(0)
  })
})
