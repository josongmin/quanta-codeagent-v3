/**
 * Hellgate — the memory-store DOCS are derived from the runtime, not copied
 * from it.
 *
 * WHY THIS EXISTS. ADR-0557 (2026-08-25) flipped the default store from the
 * volatile `InMemoryStore` to a durable sqlite file at
 * `~/.quanta/memory/memory.sqlite`. The runtime flipped and its own hellgates
 * (`durable-store-default-hellgate`) were updated. The DOCS were not:
 *
 *   - `README.md` said `QUANTA_MEMORY` 미설정 시 OFF and **전부 기본 OFF**, and
 *     listed the default path as the pre-0557 cwd-relative `.quanta/memory.sqlite`.
 *   - `src/apps/cli/memory-compose.ts` said unset ⇒ the VOLATILE store and
 *     `=sqlite` was "the ONLY persistent opt-in".
 *
 * So the shipped instruction was the exact inverse of the shipped behaviour: a
 * reader who followed the README launched with an empty env expecting a
 * byte-identical loop and got a sqlite file on disk. Nothing measured this,
 * because every existing guard checks the runtime against the runtime.
 *
 * The guard therefore takes its expectations FROM the code — `defaultDurableStorePath`
 * and `legacyCwdStorePath` are the same pure helpers the resolver uses — so
 * moving the path again moves this assertion with it, and only a doc that
 * contradicts the code can fail.
 *
 * Pure: string reads + two pure path helpers. No store, no disk, no env mutation.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KNOB_INVENTORY } from "../../../src/config/knob-inventory"
import { defaultDurableStorePath, legacyCwdStorePath } from "../../../src/memory/store-path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8")

/** The home-default path with the home prefix stripped — the fragment any doc
 *  has to name to be describing the CURRENT default. Derived, never typed. */
const DEFAULT_PATH_FRAGMENT = defaultDurableStorePath("/H").slice("/H/".length)
/** The PRE-0557 cwd-relative default, likewise derived. Docs may still mention
 *  it (the legacy file is honored) but must not present it as THE default. */
const LEGACY_PATH_FRAGMENT = legacyCwdStorePath("/C").slice("/C/".length)

/**
 * The DECLARED default for `QUANTA_MEMORY`, from the registry the runtime resolves
 * against. This is the posture axis's source of truth.
 *
 * The first version of this file had no such source: it asserted
 * `section.toContain("기본 ON")` and forbade two old sentences. Measured — the
 * phrase occurs FIVE times in that section and four of them are unrelated rows
 * (`QUANTA_MEMORY_EMBED`, `_DISTILL`, `_CONSOLIDATE`, `_SELF_EDIT`), so rewriting
 * the store posture back to `기본 OFF` left all six tests GREEN. The guard passed
 * the exact inversion it was written to catch.
 */
const DECLARED_MEMORY_DEFAULT: string = (() => {
  const row = KNOB_INVENTORY.find((k) => k.envKey === "QUANTA_MEMORY")
  if (row === undefined) throw new Error("QUANTA_MEMORY is not declared — re-anchor this guard")
  return String(row.default)
})()

/** Whether the declared default means a store is built when the knob is unset. */
const DECLARED_DEFAULT_IS_ON: boolean =
  DECLARED_MEMORY_DEFAULT !== "" &&
  !["off", "0", "false", "no", "undefined"].includes(DECLARED_MEMORY_DEFAULT.toLowerCase())

/** The README's memory section, sliced so an unrelated mention elsewhere in a
 *  1k-line document cannot satisfy or break these assertions. */
const readmeMemorySection = (): string => {
  const md = read("README.md")
  const start = md.indexOf("## 메모리")
  expect(start, "README lost its `## 메모리` section — re-anchor this guard").toBeGreaterThan(-1)
  const rest = md.slice(start + 1)
  const end = rest.indexOf("\n## ")
  return end === -1 ? rest : rest.slice(0, end)
}

describe("memory store docs match the runtime default (P1-2)", () => {
  // Anti-vacuity: the derivations must actually have produced something, or
  // every `toContain` below would be trivially satisfiable by an empty string.
  test("the derived path fragments are non-empty and distinct", () => {
    expect(DEFAULT_PATH_FRAGMENT).toBe(".quanta/memory/memory.sqlite")
    expect(LEGACY_PATH_FRAGMENT).toBe(".quanta/memory.sqlite")
    expect(DEFAULT_PATH_FRAGMENT).not.toBe(LEGACY_PATH_FRAGMENT)
  })

  test("the derived posture is non-trivial (anti-vacuity)", () => {
    expect(DECLARED_MEMORY_DEFAULT).toBe("sqlite")
    expect(DECLARED_DEFAULT_IS_ON).toBe(true)
  })

  /**
   * The posture sentence is matched on a UNIQUE anchor, and which anchor is
   * required comes from the declared default rather than from this file.
   *
   * `toContain("기본 ON")` was satisfiable by four unrelated knob rows in the same
   * section, which is why the inversion passed. `**store는 기본 ON**` occurs once
   * and is the sentence that actually describes the store.
   */
  test("README states the STORE posture that the registry declares", () => {
    const section = readmeMemorySection()
    const onAnchor = "**store는 기본 ON**"
    const offAnchor = "**store는 기본 OFF**"
    const required = DECLARED_DEFAULT_IS_ON ? onAnchor : offAnchor
    const forbidden = DECLARED_DEFAULT_IS_ON ? offAnchor : onAnchor
    expect(
      section.includes(required),
      `the registry declares QUANTA_MEMORY default=${DECLARED_MEMORY_DEFAULT}, so the memory section must carry ${required}`,
    ).toBe(true)
    expect(
      section.includes(forbidden),
      `${forbidden} contradicts the declared default — this is the inversion that shipped for two and a half weeks`,
    ).toBe(false)
    // The two pre-fix sentences, kept as explicit regression pins.
    expect(section).not.toContain("전부 기본 OFF")
    expect(section).not.toMatch(/QUANTA_MEMORY` 미설정 시 루프는 byte-for-byte 불변/)
  })

  test("README names the CURRENT default path, derived from the resolver", () => {
    const section = readmeMemorySection()
    expect(section).toContain(DEFAULT_PATH_FRAGMENT)
  })

  /**
   * The `QUANTA_MEMORY_PATH` row must name the CURRENT default. Forbidding one
   * spelling was evadable: the first version only rejected the exact string
   * "기본 `<legacy>`", so writing "기본 `<cwd>/<legacy>`" passed while saying the
   * wrong thing. Assert the row's own content instead.
   */
  test("the QUANTA_MEMORY_PATH row names the current default, not the pre-0557 one", () => {
    const section = readmeMemorySection()
    const row = section.split("\n").find((l) => l.includes("`QUANTA_MEMORY_PATH`"))
    expect(row, "README lost its QUANTA_MEMORY_PATH row — re-anchor this guard").toBeDefined()
    const text = row ?? ""
    expect(text, "the row must state the home-scoped default").toContain(DEFAULT_PATH_FRAGMENT)
    // The legacy path may be MENTIONED (it is still honored), but not as the default.
    expect(text).not.toMatch(
      new RegExp(`기본\\s*\`[^\`]*${LEGACY_PATH_FRAGMENT.replace(/[.]/g, "\\.")}\``),
    )
  })

  test("the top-level env list agrees with the memory section", () => {
    const md = read("README.md")
    const line = md.split("\n").find((l) => l.startsWith("- `QUANTA_MEMORY` ("))
    expect(line, "README lost its top-level QUANTA_MEMORY bullet").toBeDefined()
    expect(line ?? "").not.toContain("미설정 시 OFF")
  })

  test("the memory-compose docstring does not describe the pre-0557 contract", () => {
    const src = read("src/apps/cli/memory-compose.ts")
    // The inverted claim, verbatim from the pre-fix docstring.
    expect(src).not.toContain("⇒ the VOLATILE `InMemoryStore`")
    expect(src).not.toContain("the ONLY persistent opt-in")
    expect(src).toContain(DEFAULT_PATH_FRAGMENT)
  })
})
