import { describe, expect, test } from "bun:test"
import { stratumTag } from "@/agent/observation/metrics"

describe("stratumTag", () => {
  test("one-file: single gold-patch file", () => {
    expect(stratumTag({ goldPatchFiles: ["a/b.py"] })).toContain("one-file")
  })
  test("multi-file: ≥2 gold-patch files (and not one-file)", () => {
    const tags = stratumTag({ goldPatchFiles: ["a/b.py", "a/c.py"] })
    expect(tags).toContain("multi-file")
    expect(tags).not.toContain("one-file")
  })
  test("ambiguous-owner: ≥2 suggested owners", () => {
    expect(stratumTag({ suggestedOwnerCount: 2 })).toContain("ambiguous-owner")
    expect(stratumTag({ suggestedOwnerCount: 1 })).not.toContain("ambiguous-owner")
  })
  test("misleading-hint: caller flag", () => {
    expect(stratumTag({ hintPointsAwayFromGold: true })).toContain("misleading-hint")
    expect(stratumTag({ hintPointsAwayFromGold: false })).not.toContain("misleading-hint")
  })
  test("dynamic-dispatch: caller flag", () => {
    expect(stratumTag({ requiresDynamicDispatch: true })).toContain("dynamic-dispatch")
  })
  test("lockfile-trap: gold patch touches a lockfile", () => {
    expect(stratumTag({ goldPatchFiles: ["src/a.py", "poetry.lock"] })).toContain("lockfile-trap")
    expect(stratumTag({ goldPatchFiles: ["src/uv.lock"] })).toContain("lockfile-trap")
    expect(stratumTag({ goldPatchFiles: ["src/a.py"] })).not.toContain("lockfile-trap")
  })
  test("co-occurring strata: multi-file lockfile trap + ambiguous", () => {
    const tags = stratumTag({
      goldPatchFiles: ["a.py", "Cargo.lock"],
      suggestedOwnerCount: 3,
    })
    expect(tags).toContain("multi-file")
    expect(tags).toContain("lockfile-trap")
    expect(tags).toContain("ambiguous-owner")
  })
  test("no metadata ⇒ no tags (never guesses)", () => {
    expect(stratumTag({})).toEqual([])
  })
  test("lockfile regex is anchored to the filename, not a substring", () => {
    // a file merely named `...poetry.lock.bak` or `mypackagelock.json` must NOT trip.
    expect(stratumTag({ goldPatchFiles: ["a/poetry.lock.bak"] })).not.toContain("lockfile-trap")
    expect(stratumTag({ goldPatchFiles: ["a/mypackage-lock.json"] })).not.toContain("lockfile-trap")
  })
})
