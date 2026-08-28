/**
 * merge-symbol-loss residue — four defects an adversarial audit measured in the
 * detector itself. Each one is a way the guard silently fails OPEN.
 *
 *  1. `messageNamesPath` matched by SUBSTRING on the basename, so a merge
 *     message saying "reconciled the two index.ts barrels" excused every
 *     dropped export in every `index.ts` the merge touched.
 *  2. `isGrandfathered("")` returned true (`known.startsWith("")`), so an empty
 *     sha waved the baseline check through.
 *  3. `export default function m() {}` recorded `"m"` while `export default
 *     expr` recorded `"default"`, so converting between the two equivalent
 *     forms read as losing a symbol.
 *  4. `git diff --name-only` quotes non-ASCII paths (`core.quotePath` defaults
 *     ON), and the quoted spec then misses on `cat-file --batch` for BOTH
 *     sides — zero exports before, zero after, a silent blind spot.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createGitReadPort,
  extractExportedSymbols,
  type GitReadPort,
  isExcusedByMessage,
  isGrandfathered,
  messageNamesPath,
  type SymbolLoss,
  scanMerge,
} from "../../../tools/dev/merge-symbol-loss"

// ---------------------------------------------------------------------------
// A synthetic port (same shape the ratchet test uses).
// ---------------------------------------------------------------------------

interface FakeCommit {
  readonly parents: readonly string[]
  readonly message: string
  readonly files: Readonly<Record<string, string>>
}

const fakePort = (commits: Readonly<Record<string, FakeCommit>>): GitReadPort => {
  const at = (sha: string): FakeCommit => {
    const c = commits[sha]
    if (c === undefined) throw new Error(`fake port: unknown sha ${sha}`)
    return c
  }
  return {
    parents: (sha) => at(sha).parents,
    message: (sha) => at(sha).message,
    changedFiles: (from, to) => {
      const a = at(from).files
      const b = at(to).files
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((p) => a[p] !== b[p])
        .sort()
    },
    readFiles: (sha, paths) => new Map(paths.map((p) => [p, at(sha).files[p] ?? null])),
    listMerges: () => Object.keys(commits).filter((sha) => at(sha).parents.length >= 2),
  }
}

// ---------------------------------------------------------------------------
// 1. The basename blanket-excuse
// ---------------------------------------------------------------------------

describe("residue 1 — the escape hatch must not blanket-excuse by basename", () => {
  /** Two barrels, each dropping a DISTINCT symbol, in one merge. */
  const twoBarrelMerge = (message: string) =>
    scanMerge(
      "M",
      fakePort({
        BASE: { parents: [], message: "base", files: {} },
        P1: {
          parents: ["BASE"],
          message: "lane a",
          files: {
            "src/a/index.ts": "export const alpha = 1\nexport const keptA = 1\n",
            "src/b/index.ts": "export const beta = 2\nexport const keptB = 2\n",
          },
        },
        P2: { parents: ["BASE"], message: "lane b", files: {} },
        M: {
          parents: ["P1", "P2"],
          message,
          files: {
            "src/a/index.ts": "export const keptA = 1\n",
            "src/b/index.ts": "export const keptB = 2\n",
          },
        },
      }),
    )

  test("RED: a bare `index.ts` mention does NOT excuse every index.ts in the merge", () => {
    const scan = twoBarrelMerge("merge: reconciled the two index.ts barrels")
    // Neither `alpha` nor `beta` is named. Both must remain live failures.
    expect(scan.losses.map((l) => l.symbol).sort()).toEqual(["alpha", "beta"])
    expect(scan.excused).toEqual([])
  })

  test("PAIRED CONTROL: naming a FULL path still excuses exactly that file", () => {
    const scan = twoBarrelMerge("merge: drops src/a/index.ts on purpose")
    expect(scan.excused.map((l) => l.symbol)).toEqual(["alpha"])
    expect(scan.losses.map((l) => l.symbol)).toEqual(["beta"])
  })

  test("PAIRED CONTROL: an UNAMBIGUOUS basename still excuses (the hatch is not gutted)", () => {
    const scan = scanMerge(
      "M",
      fakePort({
        BASE: { parents: [], message: "base", files: {} },
        P1: {
          parents: ["BASE"],
          message: "lane a",
          files: { "src/objective/budget-limits.ts": "export const clampBudgetLimit = 1\n" },
        },
        P2: { parents: ["BASE"], message: "lane b", files: {} },
        M: {
          parents: ["P1", "P2"],
          message: "merge: drops budget-limits.ts, superseded",
          files: {},
        },
      }),
    )
    expect(scan.losses).toEqual([])
    expect(scan.excused.map((l) => l.symbol)).toEqual(["clampBudgetLimit"])
  })

  test("RED: path matching is by whole token, not substring", () => {
    // "reindex.ts" contains "index.ts" as a substring.
    expect(messageNamesPath("merge: rebuilt reindex.ts", "src/a/index.ts")).toBe(false)
    // "budget-limits.ts.bak" must not excuse "budget-limits.ts".
    expect(
      messageNamesPath(
        "touched src/objective/budget-limits.ts.bak",
        "src/objective/budget-limits.ts",
      ),
    ).toBe(false)
    // A real mention still matches.
    expect(messageNamesPath("drops src/a/index.ts", "src/a/index.ts")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. isGrandfathered fail-open
// ---------------------------------------------------------------------------

describe("residue 2 — isGrandfathered must not fail open", () => {
  test("RED: the empty string is not a grandfathered sha", () => {
    expect(isGrandfathered("")).toBe(false)
  })

  test("RED: a 1-char prefix is not a sha (git itself will not abbreviate below 4)", () => {
    expect(isGrandfathered("9")).toBe(false)
    expect(isGrandfathered("9b")).toBe(false)
  })

  test("PAIRED CONTROL: real abbreviations and the full sha still match", () => {
    expect(isGrandfathered("9b21d2fd2")).toBe(true)
    expect(isGrandfathered("9b21d2fd295097009487d9b37b477fd1f5be2388")).toBe(true)
    // An unrelated sha must NOT match — otherwise "true" is worthless.
    expect(isGrandfathered("deadbeefdeadbeef")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. `export default` form conversion
// ---------------------------------------------------------------------------

describe("residue 3 — `export default` has ONE name, whatever form it takes", () => {
  test("RED: a named default-exported function is recorded as `default`", () => {
    const names = extractExportedSymbols("export default function m() {}")
    expect([...names]).toEqual(["default"])
  })

  test("every default form agrees", () => {
    for (const source of [
      "export default function m() {}",
      "export default function () {}",
      "export default class C {}",
      "export default class {}",
      "const x = 1\nexport default x",
      "export default { a: 1 }",
    ]) {
      expect([...extractExportedSymbols(source)]).toEqual(["default"])
    }
  })

  test("RED: converting `export default function m` to `export default expr` is NOT a loss", () => {
    const scan = scanMerge(
      "M",
      fakePort({
        BASE: { parents: [], message: "base", files: {} },
        P1: {
          parents: ["BASE"],
          message: "lane a",
          files: { "src/a/thing.ts": "export default function m() {}\n" },
        },
        P2: { parents: ["BASE"], message: "lane b", files: {} },
        M: {
          parents: ["P1", "P2"],
          message: "merge: inline the default export",
          files: { "src/a/thing.ts": "const m = () => {}\nexport default m\n" },
        },
      }),
    )
    expect(scan.losses).toEqual([])
    expect(scan.filesExamined).toBeGreaterThan(0)
  })

  test("PAIRED CONTROL: actually deleting the default export IS a loss", () => {
    const scan = scanMerge(
      "M",
      fakePort({
        BASE: { parents: [], message: "base", files: {} },
        P1: {
          parents: ["BASE"],
          message: "lane a",
          files: { "src/a/thing.ts": "export default function m() {}\n" },
        },
        P2: { parents: ["BASE"], message: "lane b", files: {} },
        M: {
          parents: ["P1", "P2"],
          message: "merge",
          files: { "src/a/thing.ts": "export const notDefault = 1\n" },
        },
      }),
    )
    expect(scan.losses.map((l) => l.symbol)).toEqual(["default"])
  })

  test("a named export sitting NEXT TO a default is still tracked by its own name", () => {
    const names = extractExportedSymbols("export default function m() {}\nexport const helper = 1")
    expect([...names].sort()).toEqual(["default", "helper"])
  })
})

// ---------------------------------------------------------------------------
// 4. Non-ASCII paths through the REAL git port
// ---------------------------------------------------------------------------

const runGit = (cwd: string, args: readonly string[]): string => {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
  return res.stdout
}

/**
 * A real repository with a real merge commit that drops a real export from a
 * NON-ASCII path. Nothing is faked: this drives `createGitReadPort` against
 * actual git plumbing, which is the only way the `core.quotePath` blind spot
 * shows up at all.
 */
const buildNonAsciiMergeRepo = (): { dir: string; merge: string } => {
  const dir = mkdtempSync(join(tmpdir(), "merge-symbol-loss-nonascii-"))
  const g = (...args: string[]): string => runGit(dir, args)
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@example.com")
  g("config", "user.name", "test")
  // core.quotePath is left at its DEFAULT (on) on purpose — that is the defect.
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "café.ts"), "export const accented = 1\nexport const kept = 2\n")
  writeFileSync(join(dir, "src", "plain.ts"), "export const plain = 1\n")
  g("add", "-A")
  g("commit", "-qm", "base")
  g("checkout", "-q", "-b", "lane")
  writeFileSync(join(dir, "src", "lane.ts"), "export const lane = 1\n")
  g("add", "-A")
  g("commit", "-qm", "lane adds a file")
  g("checkout", "-q", "main")
  writeFileSync(join(dir, "src", "plain.ts"), "export const plain = 1\nexport const mainSide = 2\n")
  g("add", "-A")
  g("commit", "-qm", "main side")
  g("merge", "-q", "--no-commit", "--no-ff", "lane")
  // The silent drop: the accented file loses an export in the merge result.
  writeFileSync(join(dir, "src", "café.ts"), "export const kept = 2\n")
  g("add", "-A")
  g("commit", "-qm", "merge: reconcile lanes")
  return { dir, merge: g("rev-parse", "HEAD").trim() }
}

describe("residue 4 — non-ASCII paths are not a blind spot", () => {
  test("RED: a symbol dropped from a non-ASCII path IS detected", () => {
    const { dir, merge } = buildNonAsciiMergeRepo()
    const port = createGitReadPort(dir)

    // Ground truth first: git really does quote this path by default.
    expect(runGit(dir, ["diff", "--name-only", "HEAD^", "HEAD"])).toContain("\\303\\251")

    const scan = scanMerge(merge, port)
    // `accented` survived in BOTH parents, so it is lost relative to each of
    // them — one SymbolLoss per parent, which is what the `parent` field is for.
    expect([...new Set(scan.losses.map((l) => `${l.file}#${l.symbol}`))]).toEqual([
      "src/café.ts#accented",
    ])
    expect(new Set(scan.losses.map((l) => l.parent)).size).toBe(2)
    // `kept` is still exported, so it must NOT be reported.
    expect(scan.losses.some((l) => l.symbol === "kept")).toBe(false)
  })

  test("ANTI-VACUITY: the port really read the accented file (non-empty on both sides)", () => {
    const { dir, merge } = buildNonAsciiMergeRepo()
    const port = createGitReadPort(dir)
    const parent = port.parents(merge)[0] as string

    const changed = port.changedFiles(parent, merge)
    expect(changed).toContain("src/café.ts")

    const atMerge = port.readFiles(merge, ["src/café.ts"])
    expect(atMerge.get("src/café.ts")).toContain("export const kept = 2")

    const atParent = port.readFiles(parent, ["src/café.ts"])
    expect(atParent.get("src/café.ts")).toContain("export const accented = 1")
  })

  test("PAIRED CONTROL: an ASCII sibling in the SAME merge behaves identically", () => {
    const { dir, merge } = buildNonAsciiMergeRepo()
    const port = createGitReadPort(dir)
    // `src/plain.ts` lost nothing, so it must not appear as a loss.
    const scan = scanMerge(merge, port)
    expect(scan.losses.some((l) => l.file === "src/plain.ts")).toBe(false)
    expect(scan.filesExamined).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The excuse hatch keeps its existing symbol behaviour
// ---------------------------------------------------------------------------

describe("residue — symbol matching is unchanged", () => {
  test("whole-identifier symbol matching still holds", () => {
    const loss: SymbolLoss = { file: "src/a.ts", symbol: "cap", parent: "P" }
    expect(isExcusedByMessage("drop cap", loss)).toBe(true)
    expect(isExcusedByMessage("feeder checkpoint capture", loss)).toBe(false)
  })
})
