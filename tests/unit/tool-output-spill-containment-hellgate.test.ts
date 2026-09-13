/**
 * HELLGATE NW-2 (sep-14, SEC-ADV-2) — the tool-output spill must stay inside
 * the working directory.
 *
 * `ToolRegistry.run` spills every over-budget tool result to
 * `<cwd>/.quanta/tool-output/<uuid>.txt` and then prunes that directory to the
 * newest `QUANTA_TOOL_OUTPUT_SPILL_KEEP` `*.txt` files. A cloned repo controls
 * `<cwd>/.quanta`, so before this gate a repo that shipped `.quanta/tool-output`
 * (or `.quanta` itself) as a symlink turned the default read-only `read` tool
 * into a write outside the repo plus deletion of every `*.txt` past keep=50 in
 * the symlink's target (measured: 80 files → 49 left, 1 foreign file written).
 *
 * Every arm drives the REAL default `ToolRegistry` and the real `read` tool over
 * a scratch repo. Refused arms assert the victim directory is left at exactly 80
 * files with 0 foreign entries and that the model-facing result names the
 * refused path. Paired controls prove a real directory still spills and prunes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEvictionSpillPort } from "@/agent/tool-result-evict"
import { defaultTools, type ToolContext, ToolRegistry, type ToolResult } from "@/tool"
import {
  capToolOutput,
  DEFAULT_SPILL_KEEP,
  SPILL_DIR_REFUSAL_KINDS,
  SPILL_DIR_REFUSAL_REASON,
} from "@/tool/output-spill"
import { scopedEnv } from "../_support/scoped-env"

const VICTIM_NOTES = 80
// Deliberately NOT DEFAULT_SPILL_KEEP (50): the paired control prunes to KEEP
// only if the registry honours `QUANTA_TOOL_OUTPUT_SPILL_KEEP` via runtimeConfig.
const KEEP = 30
const env = scopedEnv(["QUANTA_TOOL_OUTPUT_MAX", "QUANTA_TOOL_OUTPUT_SPILL_KEEP"], {
  QUANTA_TOOL_OUTPUT_MAX: "200000",
  QUANTA_TOOL_OUTPUT_SPILL_KEEP: String(KEEP),
})

let root: string
let repo: string
beforeEach(() => {
  env.beforeEach()
  root = mkdtempSync(join(tmpdir(), "spill-containment-"))
  repo = join(root, "repo")
  mkdirSync(repo)
  // 2000 lines × ~150 chars ⇒ the rendered read result is ~300k chars, past the
  // pinned 200k budget, so the registry spills.
  const lines = Array.from({ length: 2000 }, (_, i) => `row-${i} ${"x".repeat(140)}`)
  writeFileSync(join(repo, "generated.txt"), `${lines.join("\n")}\n`)
  writeFileSync(join(repo, "small.txt"), "tiny\n")
})
afterEach(() => {
  env.afterEach()
  // The unavailable arms leave the repo at 0o555; restore before removing it.
  chmodSync(repo, 0o755)
  rmSync(root, { recursive: true, force: true })
})

const ctx = (): ToolContext => ({ cwd: repo, signal: new AbortController().signal })
const readThroughRegistry = (file: string): Promise<ToolResult> =>
  new ToolRegistry(defaultTools).run("read", { path: join(repo, file) }, ctx())

/** A directory holding 80 `note-<i>.txt` files, each with distinct content. */
const seedNotes = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < VICTIM_NOTES; i++) writeFileSync(join(dir, `note-${i}.txt`), `precious-${i}`)
}

/** Exact census of a seeded directory: every entry name, and whether each note
 *  still holds the content it was seeded with. */
const census = (dir: string): { entries: string[]; foreign: string[]; intact: number } => {
  const entries = readdirSync(dir).sort()
  const foreign = entries.filter((n) => !/^note-\d+\.txt$/.test(n))
  const intact = entries.filter((n) => {
    const m = /^note-(\d+)\.txt$/.exec(n)
    return m !== null && readFileSync(join(dir, n), "utf8") === `precious-${m[1]}`
  }).length
  return { entries, foreign, intact }
}

describe("NW-2 refused arms — a symlinked spill location is never written or pruned", () => {
  test("`.quanta/tool-output` → out-of-repo dir: victim stays at 80 files, 0 foreign", async () => {
    const victim = join(root, "victim")
    seedNotes(victim)
    mkdirSync(join(repo, ".quanta"))
    symlinkSync("../../victim", join(repo, ".quanta", "tool-output"))

    const result = await readThroughRegistry("generated.txt")

    const after = census(victim)
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(after.intact).toBe(VICTIM_NOTES)
    // The model sees why the output is only an excerpt, naming the refused path.
    expect(result.ok).toBe(true)
    expect(result.output.startsWith("<truncated-output>\n")).toBe(true)
    expect(result.output).toContain(
      `was NOT persisted to disk: ${join(repo, ".quanta", "tool-output")} is a symbolic link;`,
    )
    expect(result.output).not.toContain("<persisted-output>")
    expect(result.output).toContain("row-0 ")
    expect(result.output).toContain("row-1999 ")
    expect(result.evidence?.fullLogPath).toBeUndefined()
  })

  test("`.quanta` itself → out-of-repo dir: its tool-output stays at 80 files, 0 foreign", async () => {
    const outside = join(root, "outside")
    seedNotes(join(outside, "tool-output"))
    symlinkSync("../outside", join(repo, ".quanta"))

    const result = await readThroughRegistry("generated.txt")

    const after = census(join(outside, "tool-output"))
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(after.intact).toBe(VICTIM_NOTES)
    expect(readdirSync(outside)).toEqual(["tool-output"])
    expect(result.output).toContain(
      `was NOT persisted to disk: ${join(repo, ".quanta")} is a symbolic link;`,
    )
    expect(result.evidence?.fullLogPath).toBeUndefined()
  })

  test("`.quanta` → EMPTY out-of-repo dir: no `tool-output` is created through the link", async () => {
    // Nothing is seeded in `outside`, so a `tool-output` created through the
    // `.quanta` link (a recursive pre-create, or a walk that makes `tool-output`
    // before it has checked `.quanta`) shows up as an entry here.
    const outside = join(root, "outside")
    mkdirSync(outside)
    symlinkSync("../outside", join(repo, ".quanta"))

    const result = await readThroughRegistry("generated.txt")

    expect(readdirSync(outside)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.output.startsWith("<truncated-output>\n")).toBe(true)
    expect(result.output).toContain(
      `was NOT persisted to disk: ${join(repo, ".quanta")} is a symbolic link;`,
    )
    expect(result.evidence?.fullLogPath).toBeUndefined()
  })

  test("dangling `.quanta/tool-output` symlink: nothing is created at its target", async () => {
    const victim = join(root, "victim")
    seedNotes(victim)
    mkdirSync(join(repo, ".quanta"))
    symlinkSync("../../victim/fresh", join(repo, ".quanta", "tool-output"))

    const result = await readThroughRegistry("generated.txt")

    expect(existsSync(join(victim, "fresh"))).toBe(false)
    const after = census(victim)
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(result.output).toContain(
      `was NOT persisted to disk: ${join(repo, ".quanta", "tool-output")} is a symbolic link;`,
    )
  })

  test("sub-budget output in a symlinked repo is byte-identical and touches nothing", async () => {
    const victim = join(root, "victim")
    seedNotes(victim)
    const link = join(repo, ".quanta", "tool-output")
    mkdirSync(join(repo, ".quanta"))
    symlinkSync("../../victim", link)
    // Paired control: the same read in a scratch repo with no `.quanta` at all.
    const control = join(root, "control")
    mkdirSync(control)
    writeFileSync(join(control, "small.txt"), "tiny\n")

    const result = await readThroughRegistry("small.txt")
    const controlResult = await new ToolRegistry(defaultTools).run(
      "read",
      { path: join(control, "small.txt") },
      { cwd: control, signal: new AbortController().signal },
    )

    expect(result.output).toBe("1\ttiny\n2\t")
    expect(result.output).toBe(controlResult.output)
    expect(result.ok).toBe(true)
    expect(result.evidence?.fullLogPath).toBeUndefined()
    const after = census(victim)
    expect(after.entries).toHaveLength(VICTIM_NOTES)
    expect(after.foreign).toEqual([])
    expect(after.intact).toBe(VICTIM_NOTES)
    // The link itself was neither replaced nor removed.
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(repo, ".quanta"))).toEqual(["tool-output"])
    expect(existsSync(join(control, ".quanta"))).toBe(false)
  })
})

describe("NW-2 paired controls — a real directory still spills and prunes", () => {
  test("static pin: KEEP differs from DEFAULT_SPILL_KEEP, so the control below discriminates the knob wire", () => {
    expect(KEEP).not.toBe(DEFAULT_SPILL_KEEP)
    expect(VICTIM_NOTES).toBeGreaterThan(DEFAULT_SPILL_KEEP)
  })

  test("pre-existing real `.quanta/tool-output` with 80 files: spill written, pruned to the knob's keep=30", async () => {
    const spillDir = join(repo, ".quanta", "tool-output")
    seedNotes(spillDir)

    const result = await readThroughRegistry("generated.txt")

    const fullLogPath = result.evidence?.fullLogPath
    expect(typeof fullLogPath).toBe("string")
    const spillName = (fullLogPath as string).slice(spillDir.length + 1)
    expect(fullLogPath).toBe(join(spillDir, spillName))
    const after = census(spillDir)
    expect(after.entries).toHaveLength(KEEP)
    expect(after.foreign).toEqual([spillName])
    expect(after.intact).toBe(KEEP - 1)
    const spilled = readFileSync(fullLogPath as string, "utf8")
    expect(spilled.length).toBeGreaterThan(200_000)
    expect(spilled).toContain("row-0 ")
    expect(spilled).toContain("row-1999 ")
    expect(result.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(result.output).toContain(`The full output is at: ${fullLogPath}`)
  })

  test("fresh repo (no `.quanta`): both components are created as real directories", async () => {
    const result = await readThroughRegistry("generated.txt")

    const spillDir = join(repo, ".quanta", "tool-output")
    expect(lstatSync(join(repo, ".quanta")).isDirectory()).toBe(true)
    expect(lstatSync(spillDir).isDirectory()).toBe(true)
    const files = readdirSync(spillDir)
    expect(files).toHaveLength(1)
    expect(result.evidence?.fullLogPath).toBe(join(spillDir, files[0] as string))
  })
})

describe("NW-2 capToolOutput refusal kinds (structured)", () => {
  const big = "B".repeat(1_000)

  test("a spill dir that is not <root>/.quanta/tool-output is refused and never created", async () => {
    const elsewhere = join(root, "elsewhere", "tool-output")

    const r = await capToolOutput(big, { maxChars: 10, spillDir: elsewhere })

    expect(r.spillRefusal).toEqual({ kind: "not-spill-location", path: elsewhere })
    expect(existsSync(join(root, "elsewhere"))).toBe(false)
    expect(r.spillPath).toBeUndefined()
    expect(r.output.startsWith("<truncated-output>\n")).toBe(true)
  })

  test("`.quanta` as a regular file is refused as not-a-directory, file untouched", async () => {
    writeFileSync(join(repo, ".quanta"), "repo file")

    const r = await capToolOutput(big, {
      maxChars: 10,
      spillDir: join(repo, ".quanta", "tool-output"),
    })

    expect(r.spillRefusal).toEqual({ kind: "not-a-directory", path: join(repo, ".quanta") })
    expect(readFileSync(join(repo, ".quanta"), "utf8")).toBe("repo file")
    expect(r.output).toContain(`${join(repo, ".quanta")} is not a directory`)
  })

  test("drift guard: every refusal kind has exactly one rendered reason", () => {
    expect(Object.keys(SPILL_DIR_REFUSAL_REASON).sort()).toEqual(
      [...SPILL_DIR_REFUSAL_KINDS].sort(),
    )
  })
})

// Root ignores directory mode bits, so an unwritable working directory cannot be
// staged under uid 0 (visible skip, not a silent pass).
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0

describe.skipIf(IS_ROOT)(
  "NW-2 unavailable — an unwritable working directory refuses the spill, never throws",
  () => {
    const spillDirOf = (): string => join(repo, ".quanta", "tool-output")

    test("registry `read`: the result is an excerpt naming the uncreatable `.quanta`", async () => {
      chmodSync(repo, 0o555)

      const result = await readThroughRegistry("generated.txt")

      expect(result.ok).toBe(true)
      expect(result.output.startsWith("<truncated-output>\n")).toBe(true)
      expect(result.output).toContain(
        `was NOT persisted to disk: ${join(repo, ".quanta")} could not be created or inspected (`,
      )
      expect(result.output).toContain("row-0 ")
      expect(result.output).toContain("row-1999 ")
      expect(result.evidence?.fullLogPath).toBeUndefined()
      expect(existsSync(join(repo, ".quanta"))).toBe(false)
    })

    test("capToolOutput: structured `unavailable` refusal at `<repo>/.quanta` with the IO cause", async () => {
      chmodSync(repo, 0o555)

      const r = await capToolOutput("B".repeat(1_000), { maxChars: 10, spillDir: spillDirOf() })

      expect(r.spillRefusal?.kind).toBe("unavailable")
      expect(r.spillRefusal?.path).toBe(join(repo, ".quanta"))
      expect(r.spillRefusal?.cause).toContain("EACCES")
      expect(r.spillPath).toBeUndefined()
    })

    test("eviction spill port: returns the unpersisted block instead of throwing", () => {
      chmodSync(repo, 0o555)

      const block = createEvictionSpillPort({ spillDir: spillDirOf() }).persist("hello", "u1")

      expect(block).toStartWith('<unpersisted-output chars="5">')
      expect(block).toContain(`${join(repo, ".quanta")} could not be created or inspected (`)
      expect(block).not.toContain("<persisted-output")
    })
  },
)
