/**
 * Ratchet — a test that reads the repo must anchor on ITSELF, not on the cwd.
 *
 * ## The root cause this exists for
 *
 * 72 test files hand-roll their own repo scan (`readdirSync` over `src/`,
 * `tests/` or `tools/`), and there is no shared scanner. Each one independently
 * decides three things: where the repo root is, which directories to skip, and
 * what an empty result means. Deciding the first of those 72 times is why the
 * same defect kept arriving from different authors — nine separate instances
 * were found and fixed on 2026-08-25/26 alone, in files written by four
 * different people.
 *
 * A bare `readdirSync("src/apps/cli")` or `readFileSync("src/apps/cli/index.ts")`
 * works only because someone happened to launch from the repo root. Launched
 * from anywhere else — a sandboxed working directory, an editor's test runner, a
 * CI step with a different `working-directory` — it resolves somewhere else
 * entirely.
 *
 * ## Why this is worse than an ordinary broken path
 *
 * The failure is not always loud. Measured on the nine:
 *
 *   - Seven failed LOUDLY under a foreign cwd (ENOENT, or a shell-out matching
 *     nothing). Recoverable, if noisy.
 *   - `cli-feature-gates-drift` inverted to VACUOUSLY GREEN in the dangerous
 *     direction: it shells out to `rg … src` and treats "no match" as "this gate
 *     has no consumer". Under a foreign cwd `rg` matched nothing, so every gate
 *     read as unconsumed — a guard whose verdict is derived from a scan cannot
 *     tell "clean" from "I never looked".
 *   - `loadFeaturesStrict(dir = "tools/feature-catalog/features")` had the same
 *     shape one layer down, in a LOADER, so every consumer inherited it and "no
 *     features loaded" read as a clean catalog to all of them.
 *
 * So the rule is enforced structurally rather than left to each author: a repo
 * path in a test must be built from `import.meta.dir` / `__dirname` /
 * `new URL(…, import.meta.url)`, which are properties of the FILE and cannot
 * drift with the process.
 *
 * ## What is pinned, and what is deliberately not
 *
 * Only literal repo-root-relative paths handed to a filesystem or shell call —
 * `readFileSync("src/…")`, `readdirSync("tools/…")`, `Bun.file("tests/…")`,
 * `execSync("rg … src")`. A string that merely CONTAINS `"src/"` (a fixture
 * path inside synthetic input, an `endsWith("src/foo.ts")` predicate over paths
 * the test was handed) is not a filesystem read and is not flagged — that
 * distinction is what a cruder scan gets wrong, and it produced a false positive
 * on `eval-generator-validation.test.ts`, which scans a temp directory it made.
 *
 * The ceiling is a COUNT, not zero-tolerance-by-name, so a genuinely-justified
 * site can be admitted deliberately rather than by weakening the detector.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * Filesystem and shell entry points that take the path as their first argument.
 *
 * An ALLOWLIST, chosen after measuring the alternative. Inverting it — "any call
 * receiving a repo-relative literal, minus a denylist of string predicates" —
 * catches the hand-rolled `walk("src/apps/cli")` shape, but on this tree it
 * reports 147 files of which nearly all are synthetic fixtures
 * (`hit("src/a.ts")`, `diff("src/core.py")`) or local helpers that already
 * anchor internally. Adding an on-disk existence check only narrows that to 94.
 * Neither variant can tell `read("src/x.ts")` — a helper that resolves against
 * `REPO_ROOT` — from one that does not, without following the binding.
 *
 * A ratchet that cries wolf 90 times gets its detector weakened, not its
 * offenders fixed. So this one is precise and states its gap.
 */
const FS_ENTRY_POINTS =
  /\b(readFileSync|readdirSync|existsSync|statSync|lstatSync|readFile|readdir|stat|createReadStream|Bun\.file|Glob)\s*\(\s*(?:\[\s*)?["'`]([^"'`\n]+)["'`]/g

/** Shell-outs hide the path inside the command string rather than as the argument. */
const SHELL_ENTRY_POINTS = /\b(execSync|spawnSync|Bun\.spawnSync|Bun\.spawn)\s*\(\s*[`"']([^`"']*)/g

const REPO_RELATIVE_ARG = /^(src|tests|tools|docs|scripts)(\/|$)/
const REPO_RELATIVE_IN_COMMAND = /(^|\s)(src|tests|tools|docs|scripts)(\/|\s|$)/

/**
 * Sites where a repo-root-relative literal reaches the filesystem or a shell.
 *
 * ## The gap, stated rather than implied
 *
 * A literal that reaches disk through a BINDING is not followed:
 * `const D = "src/runner/knobs"; readdirSync(D)`, and equally a hand-rolled
 * `walk("src/apps/cli")` whose `readdirSync` sits in another function. Those are
 * covered by the complement rather than by this regex — the arch tests run from
 * a foreign working directory in `tools/dev/sandboxed-test.ts`, where a
 * cwd-resolved path fails on ground truth instead of on a proxy for it.
 *
 * This is why the assertion below is a ceiling with an explicit admit-list and
 * not a claim of totality.
 */
export const cwdRelativeRepoReads = (source: string): readonly string[] => {
  const out: string[] = []
  for (const m of source.matchAll(FS_ENTRY_POINTS)) {
    const arg = m[2] ?? ""
    if (REPO_RELATIVE_ARG.test(arg)) out.push(`${m[1]}("${arg}")`)
  }
  for (const m of source.matchAll(SHELL_ENTRY_POINTS)) {
    const cmd = m[2] ?? ""
    if (!REPO_RELATIVE_IN_COMMAND.test(cmd)) continue
    // An explicit `cwd:` IS an anchor — `execSync("rg … src", {cwd: REPO_ROOT})`
    // is the fixed form of this very defect, and flagging it would ask the author
    // to undo the fix. Scoped to the 200 characters after the call so a `cwd:`
    // belonging to some later spawn cannot vouch for this one.
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 200)
    if (/\bcwd\s*:/.test(after)) continue
    out.push(`${m[1]}(\`${cmd.slice(0, 60)}…\`)`)
  }
  return [...new Set(out)]
}

/** Every `*.test.ts` under `tests/`. */
const testFiles = (): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (abs.endsWith(".test.ts")) out.push(abs)
    }
  }
  walk(join(REPO_ROOT, "tests"))
  return out.sort()
}

/**
 * Sites admitted deliberately. Empty today — the nine found on 2026-08-25/26
 * were all fixed rather than admitted, because every one of them had a
 * one-line `import.meta.dir` answer.
 *
 * An entry here is a claim that the ambient cwd is genuinely the right anchor
 * for that read, which is true only for a test ABOUT cwd behaviour.
 */
const ADMITTED: ReadonlySet<string> = new Set<string>()

describe("repo-path anchoring", () => {
  const files = testFiles()

  test("anti-vacuity: the scan sees the real test tree", () => {
    // Without this the ceiling below passes for free the moment the walk breaks
    // — which is precisely the failure mode this whole ratchet is about.
    expect(files.length).toBeGreaterThan(2000)
  })

  /**
   * This file is the one place that must CONTAIN the forbidden shape — its
   * doc-comment and its own fixtures are worked examples of it. Excluded by
   * name, and the exclusion is turned into evidence below: the detector must
   * still flag it, which proves the scan fires against the real tree and not
   * only against the synthetic strings in the cases further down.
   */
  const SELF = "tests/unit/_arch/repo-path-anchor-ratchet.test.ts"

  const scanned = files
    .map((f) => ({
      file: f.slice(REPO_ROOT.length + 1),
      sites: cwdRelativeRepoReads(readFileSync(f, "utf8")),
    }))
    .filter((r) => r.sites.length > 0)

  test("anti-vacuity: the detector fires on the real tree, not just on fixtures", () => {
    // Without this, a detector that silently stopped matching anything would
    // make the ceiling below pass forever — the exact "clean vs I never looked"
    // confusion this ratchet exists to prevent.
    expect(scanned.map((r) => r.file)).toContain(SELF)
  })

  test("no test resolves a repo path from the ambient working directory", () => {
    const offenders = scanned
      .filter((r) => r.file !== SELF)
      .filter((r) => !ADMITTED.has(r.file))
      .sort((a, b) => a.file.localeCompare(b.file))
    expect(
      offenders.map((o) => `${o.file}: ${o.sites.join(", ")}`),
      offenders.length === 0
        ? ""
        : "these read the repo through the ambient cwd — build the path from " +
            "`import.meta.dir` instead (or pass `{cwd: REPO_ROOT}` to a shell-out). " +
            "Launched from anywhere but the repo root they resolve elsewhere, and a " +
            "guard whose verdict comes from a scan cannot tell 'clean' from 'I never " +
            "looked'.",
    ).toEqual([])
  })

  describe("the detector itself", () => {
    test("🔴 catches every shape that was actually found in the wild", () => {
      // Each of these is a real site fixed on 2026-08-25/26, reduced to one line.
      const wild = [
        'const src = readFileSync("src/apps/cli/index.ts", "utf8")',
        'const asm = await Bun.file("src/host/runtime/agent-config-assembler.ts").text()',
        'const server = readFileSync("src/apps/web-daemon/server/fetch-handler.ts", "utf8")',
        "execSync(`rg -l --fixed-strings ${knob} src --type ts`)",
      ]
      expect(wild.map((w) => cwdRelativeRepoReads(w).length > 0)).toEqual([true, true, true, true])
    })

    test("the two shapes the detector does NOT follow, recorded as a known gap", () => {
      // Not aspiration — a binding and a hand-rolled walker are invisible to any
      // regex that does not resolve names, and pretending otherwise would let a
      // future reader believe a green here means the tree is clean. Ground truth
      // for these is the foreign-cwd run, not this file.
      expect(cwdRelativeRepoReads('const D = "src/runner/knobs"\nreaddirSync(D)')).toEqual([])
      expect(cwdRelativeRepoReads('for (const f of walk("src/apps/cli")) {}')).toEqual([])
    })

    test("INNOCENT — an anchored read is not flagged", () => {
      expect(
        cwdRelativeRepoReads('readFileSync(join(import.meta.dir, "..", "src/x.ts"), "utf8")'),
      ).toEqual([])
      expect(cwdRelativeRepoReads('readFileSync(ABS_PATH, "utf8")')).toEqual([])
    })

    test("INNOCENT — a repo-looking string that is not a read", () => {
      // The false positive a cruder scan produced: a fixture path inside
      // synthetic input, and a predicate over paths the test already holds.
      expect(cwdRelativeRepoReads('files: [{ path: "src/big.ts", content: huge }]')).toEqual([])
      expect(cwdRelativeRepoReads('path.endsWith("src/shared/runtime-config.ts")')).toEqual([])
      expect(cwdRelativeRepoReads('path.includes("src/config/knob-inventory")')).toEqual([])
    })

    test("INNOCENT — a shell-out anchored with an explicit cwd", () => {
      // The FIXED form of the vacuous-green case: `rg … src` under
      // `{cwd: REPO_ROOT}` resolves correctly from anywhere. Flagging it would
      // ask the author to revert the fix.
      expect(
        cwdRelativeRepoReads(
          'execSync(`rg -l ${k} src --type ts`, { encoding: "utf8", cwd: REPO_ROOT })',
        ),
      ).toEqual([])
      // …but a DISTANT `cwd:` belonging to some other call does not vouch for it.
      expect(
        cwdRelativeRepoReads(
          "execSync(`rg -l x src`)\n" + "// pad\n".repeat(40) + "spawnSync(a, { cwd: R })",
        ),
      ).toHaveLength(1)
    })

    test("INNOCENT — a temp directory scan", () => {
      expect(cwdRelativeRepoReads("expect(readdirSync(out).length).toBe(0)")).toEqual([])
    })
  })
})
