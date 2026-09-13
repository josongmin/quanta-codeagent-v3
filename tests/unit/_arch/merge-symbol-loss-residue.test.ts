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
 *  5. (round 8) the 3-way rule compared against ONE merge base in a criss-cross
 *     history, where git merges against a virtual base — a real loss read as trivial.
 *     (Round 9: requiring a unique base instead over-reported; the rule now asks
 *     `git merge-tree` what the plain merge keeps.)
 *  6. (round 8) rename detection listed a renamed-away file only under its new name,
 *     so the old path was never read and a rename that dropped symbols examined 0 files.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createGitReadPort,
  extractExportedSymbols,
  isExcusedByMessage,
  isGrandfathered,
  messageNamesPath,
  type SymbolLoss,
  scanMerge,
} from "../../../tools/dev/merge-symbol-loss"
import { makeTempDirOwner, withTempDirSync } from "../../_helpers/temp-dir"
import { fakeMergeGitPort } from "../_shared/fake-merge-git-port"

// ---------------------------------------------------------------------------
// A synthetic port (same shape the ratchet test uses).
// ---------------------------------------------------------------------------

const fakePort = fakeMergeGitPort

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
/** OWNED, so the repo is removed even when an assertion throws. It was a bare
 *  `mkdtempSync` that nothing removed — one leaked repo per call, three calls a run. The
 *  tmp-leak ratchet stopped seeing it once other tests in this file bound a `dir` through
 *  `withTempDirSync` (it matches by binding name), and reported the file as improved. */
const nonAsciiRepos = makeTempDirOwner()
afterEach(() => nonAsciiRepos.disposeAll())

const buildNonAsciiMergeRepo = (): { dir: string; merge: string } => {
  const dir = nonAsciiRepos.create("merge-symbol-loss-nonascii-")
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

// ---------------------------------------------------------------------------
// 5 and 6. Criss-cross bases and renames, through the REAL git port
// ---------------------------------------------------------------------------

const commitAll = (dir: string, message: string): string => {
  runGit(dir, ["add", "-A"])
  runGit(dir, ["commit", "-qm", message])
  return runGit(dir, ["rev-parse", "HEAD"]).trim()
}

const initRepo = (dir: string): void => {
  runGit(dir, ["init", "-q", "-b", "main"])
  runGit(dir, ["config", "user.email", "t@example.com"])
  runGit(dir, ["config", "user.name", "test"])
  runGit(dir, ["config", "commit.gpgsign", "false"])
  mkdirSync(join(dir, "src"), { recursive: true })
}

describe("residue 5 — a criss-cross merge is judged against git's own merge, not one base", () => {
  /**
   * X1 removes S; Y1 is unrelated. MX = merge(X1, Y1). MY = merge(Y1, X1) with
   * `-s ours`, so MY KEEPS S. MX and MY now have two best common ancestors (X1, Y1).
   * FINAL = merge(MX, MY) taking MX's file — dropping S, which git's own recursive
   * merge keeps. Picking one base (Y1, whose file equals MY's) made that look trivial.
   */
  const build = (dir: string): { mx: string; my: string; final: string } => {
    initRepo(dir)
    const f = join(dir, "src", "f.ts")
    writeFileSync(f, "export const keepMe = 1\nexport const S = 2\nexport const pad = 3\n")
    const b0 = commitAll(dir, "base")
    runGit(dir, ["checkout", "-q", "-b", "x"])
    writeFileSync(f, "export const keepMe = 1\nexport const pad = 3\n")
    const x1 = commitAll(dir, "X1 removes S")
    runGit(dir, ["checkout", "-q", "-b", "y", b0])
    writeFileSync(join(dir, "src", "y.ts"), "export const y = 1\n")
    const y1 = commitAll(dir, "Y1 unrelated")
    runGit(dir, ["checkout", "-q", "-b", "mx", x1])
    runGit(dir, ["merge", "-q", "--no-ff", "-m", "MX", y1])
    const mx = runGit(dir, ["rev-parse", "HEAD"]).trim()
    runGit(dir, ["checkout", "-q", "-b", "my", y1])
    runGit(dir, ["merge", "-q", "--no-ff", "-s", "ours", "-m", "MY keeps S", x1])
    const my = runGit(dir, ["rev-parse", "HEAD"]).trim()
    runGit(dir, ["checkout", "-q", "-b", "final", mx])
    spawnSync("git", ["merge", "-q", "--no-ff", "--no-commit", my], { cwd: dir })
    writeFileSync(f, runGit(dir, ["show", `${mx}:src/f.ts`]))
    // The message must not name the file or the symbol: the escape hatch would excuse
    // the loss by message, and this test is about the 3-way rule.
    const final = commitAll(dir, "final")
    return { mx, my, final }
  }

  test("RED: the dropped symbol is a LOSS, not trivial", () => {
    withTempDirSync("msl-crisscross-", (dir) => {
      const { mx, my, final } = build(dir)
      // Ground truth: two best common ancestors, and git's own merge KEEPS S.
      expect(runGit(dir, ["merge-base", "--all", mx, my]).trim().split("\n")).toHaveLength(2)
      const port = createGitReadPort(dir)
      const auto = port.autoMerge([mx, my])
      expect(auto?.conflicted.size).toBe(0)
      expect(port.readFiles(auto?.tree ?? "", ["src/f.ts"]).get("src/f.ts")).toContain(
        "export const S",
      )
      const scan = scanMerge(final, port)
      expect(scan.trivial.some((l) => l.symbol === "S")).toBe(false)
      expect(scan.excused).toEqual([])
      expect(scan.losses.some((l) => l.file === "src/f.ts" && l.symbol === "S")).toBe(true)
    })
  })

  test("PAIRED CONTROL: MX itself — one base, one side removed S — is still trivial", () => {
    withTempDirSync("msl-crisscross-ctl-", (dir) => {
      const { mx } = build(dir)
      const scan = scanMerge(mx, createGitReadPort(dir))
      expect(scan.trivial.some((l) => l.symbol === "S")).toBe(true)
      expect(scan.losses).toEqual([])
    })
  })
})

describe("residue 6 — a renamed-away path is still compared", () => {
  const build = (dir: string, dropInMerge: boolean): string => {
    initRepo(dir)
    // Eight exports, two dropped: similar enough that git's rename detection (50%
    // threshold) pairs the files. A smaller file reads as delete+add either way and
    // cannot tell the two diff modes apart (measured: with three exports this passed
    // with rename detection ON).
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
    writeFileSync(
      join(dir, "src", "big.ts"),
      `${names.map((n, i) => `export const ${n} = ${i}`).join("\n")}\n`,
    )
    const r0 = commitAll(dir, "add big")
    runGit(dir, ["checkout", "-q", "-b", "a"])
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1\n")
    commitAll(dir, "A unrelated")
    runGit(dir, ["checkout", "-q", "-b", "b", r0])
    writeFileSync(
      join(dir, "src", "big.ts"),
      `${runGit(dir, ["show", "HEAD:src/big.ts"])}export const addedOnB = 1\n`,
    )
    const rb = commitAll(dir, "B adds addedOnB")
    runGit(dir, ["checkout", "-q", "a"])
    spawnSync("git", ["merge", "-q", "--no-ff", "--no-commit", rb], { cwd: dir })
    runGit(dir, ["mv", "src/big.ts", "src/moved.ts"])
    if (dropInMerge) {
      const kept = runGit(dir, ["show", ":src/moved.ts"])
        .split("\n")
        .filter((l) => !l.includes("addedOnB") && !l.includes("theta"))
        .join("\n")
      writeFileSync(join(dir, "src", "moved.ts"), kept)
    }
    return commitAll(dir, "merge b (reorganise)")
  }

  test("PAIRED CONTROL: a rename on one side with an EDIT on the other is not a loss (round 9)", () => {
    // The shape the unique-base rule reported as nine losses: `side` renames f.ts, `main`
    // edits one export and adds one; git merges cleanly and every export survives in g.ts.
    withTempDirSync("msl-rename-edit-", (dir) => {
      initRepo(dir)
      const names = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]
      writeFileSync(
        join(dir, "src", "f.ts"),
        `${names.map((n, i) => `export const ${n} = ${i}`).join("\n")}\n`,
      )
      const base = commitAll(dir, "base")
      runGit(dir, ["checkout", "-q", "-b", "side"])
      runGit(dir, ["mv", "src/f.ts", "src/g.ts"])
      commitAll(dir, "rename")
      runGit(dir, ["checkout", "-q", "main"])
      runGit(dir, ["reset", "-q", "--hard", base])
      const edited = `${names.map((n, i) => `export const ${n} = ${n === "s8" ? 80 : i}`).join("\n")}\nexport const s9 = 9\n`
      writeFileSync(join(dir, "src", "f.ts"), edited)
      commitAll(dir, "edit")
      runGit(dir, ["merge", "-q", "--no-ff", "-m", "merge side", "side"])
      const merge = runGit(dir, ["rev-parse", "HEAD"]).trim()
      expect(runGit(dir, ["show", `${merge}:src/g.ts`])).toContain("export const s9")
      const scan = scanMerge(merge, createGitReadPort(dir))
      expect(scan.losses).toEqual([])
      expect(scan.trivial.length).toBeGreaterThan(0)
    })
  })

  test("PAIRED CONTROL: a rename one branch made in an ordinary commit is not a loss", () => {
    withTempDirSync("msl-rename-ctl-", (dir) => {
      initRepo(dir)
      writeFileSync(join(dir, "src", "big.ts"), "export const alpha = 1\nexport const beta = 2\n")
      const r0 = commitAll(dir, "add big")
      runGit(dir, ["checkout", "-q", "-b", "renamer"])
      runGit(dir, ["mv", "src/big.ts", "src/moved.ts"])
      commitAll(dir, "rename")
      runGit(dir, ["checkout", "-q", "-b", "other", r0])
      writeFileSync(join(dir, "src", "o.ts"), "export const o = 1\n")
      commitAll(dir, "unrelated")
      runGit(dir, ["merge", "-q", "--no-ff", "-m", "merge renamer", "renamer"])
      const merge = runGit(dir, ["rev-parse", "HEAD"]).trim()
      const scan = scanMerge(merge, createGitReadPort(dir))
      // The old path IS compared now, and the 3-way rule excuses it: the base and the
      // keeping parent agree, and the merge took the renaming parent's side.
      expect(scan.losses).toEqual([])
      expect(scan.trivial.map((l) => l.symbol).sort()).toEqual(["alpha", "beta"])
    })
  })

  test("RED: a merge that renames a file and drops exports reports the drop", () => {
    withTempDirSync("msl-rename-", (dir) => {
      const merge = build(dir, true)
      // Ground truth: with rename detection, git lists only the NEW path.
      const parent = runGit(dir, ["rev-parse", `${merge}^1`]).trim()
      expect(runGit(dir, ["diff", "--name-only", parent, merge]).trim()).toBe("src/moved.ts")
      const scan = scanMerge(merge, createGitReadPort(dir))
      expect(scan.filesExamined).toBeGreaterThan(0)
      const lost = new Set(scan.losses.map((l) => l.symbol))
      expect(lost.has("addedOnB")).toBe(true)
      expect(lost.has("theta")).toBe(true)
    })
  })
})
