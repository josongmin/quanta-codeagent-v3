import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ConflictBlock, parseConflicts } from "@/git"
import { BASE_SEED } from "./conflict-parser-fuzz-cases"

export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0
    return (value ^ (value >>> 15)) >>> 0
  }

  int(n: number): number {
    return this.next() % n
  }

  between(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1)
  }

  bool(): boolean {
    return (this.next() & 1) === 1
  }

  pick<T>(values: ReadonlyArray<T>): T {
    const value = values[this.int(values.length)]
    if (value === undefined) throw new Error("pick from empty array")
    return value
  }
}

export const rngFor = (index: number): Rng =>
  new Rng((BASE_SEED ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0)

const WORD_POOL = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "x",
  "value",
  "return foo;",
  "  indented",
  "tab\there",
  "<half open",
  "=== heading",
  "||| table",
  "café",
  "→ arrow",
  "",
]

export const contentLine = (rng: Rng): string => {
  const value = rng.pick(WORD_POOL)
  if (/^(<{6,}|>{6,}|={6,}|\|{6,})/.test(value)) return `safe ${value}`
  return value
}

export const UNICODE_LABELS = [
  "HEAD",
  "feature/foo",
  "branch with spaces",
  "café-branch",
  "ветка",
  "分支",
  "label\ttrailing-tab",
  "trailing-space ",
  "",
]

interface GitCase {
  readonly conflicted: string
  readonly diff3: boolean
  readonly oursLabel: string
}

const GIT = "/usr/bin/git"
const gitUsable = spawnSync(GIT, ["--version"], { encoding: "utf8" }).status === 0
const tmpRoots: string[] = []

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup must not hide the parser verdict.
    }
  }
})

const makeGitConflict = (rng: Rng): GitCase | null => {
  if (!gitUsable) return null
  const dir = mkdtempSync(join(tmpdir(), "qcp-fuzz-"))
  tmpRoots.push(dir)
  const diff3 = rng.bool()
  const eol = rng.bool() ? "\r\n" : "\n"
  const total = rng.between(3, 10)
  const baseLines = Array.from({ length: total }, (_, index) => `base-${index}-${contentLine(rng)}`)
  const lo = rng.between(0, total - 1)
  const hi = rng.between(lo, total - 1)
  const theirsLines = baseLines.slice()
  const oursLines = baseLines.slice()
  for (let index = lo; index <= hi; index++) {
    theirsLines[index] = `THEIRS-${index}-${contentLine(rng)}`
    oursLines[index] = `OURS-${index}-${contentLine(rng)}`
  }

  const basePath = join(dir, "base.txt")
  const oursPath = join(dir, "ours.txt")
  const theirsPath = join(dir, "theirs.txt")
  writeFileSync(basePath, baseLines.join(eol) + eol)
  writeFileSync(oursPath, oursLines.join(eol) + eol)
  writeFileSync(theirsPath, theirsLines.join(eol) + eol)
  const merged = spawnSync(
    GIT,
    [
      "merge-file",
      "-p",
      ...(diff3 ? ["--diff3"] : []),
      "-L",
      "HEAD",
      "-L",
      "base",
      "-L",
      "theirs",
      oursPath,
      basePath,
      theirsPath,
    ],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  )
  if (merged.status !== 1 || !merged.stdout.includes("<<<<<<<")) return null
  return { conflicted: merged.stdout, diff3, oursLabel: "HEAD" }
}

export const registerRealGitConflictTests = (
  suiteName: string,
  indices: readonly number[],
  minimumProduced: number,
): void => {
  describe(suiteName, () => {
    if (!gitUsable) test.skip("git unavailable — skipping real-git differential", () => {})

    let produced = 0
    let twoWay = 0
    let threeWay = 0
    for (const index of indices) {
      test(`G${index}: parseConflicts matches real git output`, () => {
        const gitCase = makeGitConflict(rngFor(index))
        if (!gitCase) return
        produced += 1
        const parsed = parseConflicts(gitCase.conflicted)
        expect(parsed.diagnostics).toEqual([])
        expect(parsed.blocks.length).toBe(1)
        const block = parsed.blocks[0] as ConflictBlock
        if (gitCase.diff3) {
          expect(block.style).toBe("three-way")
          expect("base" in block).toBe(true)
          expect("baseLabel" in block).toBe(true)
          threeWay += 1
        } else {
          expect(block.style).toBe("two-way")
          expect("base" in block).toBe(false)
          expect("baseLabel" in block).toBe(false)
          twoWay += 1
        }
        expect(block.oursLabel).toBe(gitCase.oursLabel)
        expect(block.theirsLabel.length).toBeGreaterThan(0)
        const reproduced = gitCase.conflicted.slice(block.startOffset, block.endOffset)
        expect(reproduced.startsWith("<<<<<<<")).toBe(true)
        expect(reproduced.includes(">>>>>>>")).toBe(true)
        const afterEnd = gitCase.conflicted.charAt(block.endOffset)
        expect(afterEnd === "\n" || afterEnd === "\r" || afterEnd === "").toBe(true)
        expect(gitCase.conflicted.indexOf("\n", block.startOffset)).toBeGreaterThan(
          block.startOffset,
        )
        if (gitCase.diff3) {
          expect(typeof block.base).toBe("string")
          expect(typeof block.baseLabel).toBe("string")
        }
      })
    }

    test("real-git corpus actually produced conflicts of both styles", () => {
      if (!gitUsable) return
      expect(produced).toBeGreaterThanOrEqual(minimumProduced)
      expect(twoWay).toBeGreaterThanOrEqual(1)
      expect(threeWay).toBeGreaterThanOrEqual(1)
    })
  })
}
