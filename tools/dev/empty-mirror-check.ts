/**
 * Ground truth for vacuity: run a guard against a tree where the thing it scans
 * is EMPTY, and require it to go red.
 *
 * ## Why this exists rather than another detector
 *
 * Three adversarial rounds over the 2026-08-26/27 campaign each found defects in
 * the fixes, and the pattern never varied: the static detector under-reported,
 * and the lens written to catch that shipped inert while green. A regex over
 * source cannot settle whether a guard would notice an empty corpus. Running it
 * against one can.
 *
 * It also converts a habit into a gate. Every floor added during that campaign
 * was verified by hand against an empty mirror, by someone remembering to. This
 * does it on every run, which is the difference between a practice and a rule.
 *
 * ## The criterion, and why it is two mirrors
 *
 * A guard is vacuous when it reports "no violations" over a corpus it never
 * read. To show that, the tree IT scans has to be the empty one — and which tree
 * that is cannot be read off the source (the whole reason the detector
 * under-reports). So two complementary mirrors are built:
 *
 *   A. real `src/` + `tools/`, EMPTY `tests/` and `docs/`
 *   B. real `tests/` + `tools/`, EMPTY `src/` and `docs/`
 *
 * A guard GREEN in both has been shown a corpus of nothing whichever tree it
 * reads, and passed. A guard RED in either one noticed. This is conservative in
 * the safe direction: it never calls a guard vacuous that isn't, and it can miss
 * one that scans only `tools/` or `docs/` — stated rather than implied, and the
 * reason `tools/` stays real is that both mirrors need the tooling to load.
 *
 * ## What makes the mirrors usable at all
 *
 * The first attempt emptied `tests/` outright and every guard died at preload:
 * `tests/setup.ts` imports `@/…` modules, so an empty tree kills the runner
 * before a verdict exists, and "everything is red" is as useless as "everything
 * is green". Each mirror therefore keeps the preloads, the shared helpers and
 * the directory skeleton, and empties only the FILES the guards scan.
 *
 * Usage:
 *   bun run tools/dev/empty-mirror-check.ts tests/unit/_arch tests/meta
 *   bun run tools/dev/empty-mirror-check.ts --ledger
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const LEDGER = join(REPO_ROOT, "tools", "dev", "anti-vacuity-burndown.json")

/** Preloads and shared helpers a guard needs before it can produce any verdict. */
const KEEP_UNDER_TESTS = [
  "preload-clean-source-js.ts",
  "setup.ts",
  "_shared",
  "_helpers",
  "support",
  "_support",
  "helpers",
] as const

export type MirrorArm = "empty-tests" | "empty-src"
export type GuardVerdict = "red" | "green" | "error"

/** Every directory under `root`, relative to the repo, so a walk finds the shape. */
const dirsUnder = (root: string): readonly string[] => {
  const out: string[] = []
  const walk = (rel: string): void => {
    out.push(rel)
    for (const ent of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "node_modules" || ent.name.startsWith(".")) continue
      walk(join(rel, ent.name))
    }
  }
  if (existsSync(join(REPO_ROOT, root))) walk(root)
  return out
}

/**
 * Build one mirror.
 *
 * Both `src/` and `tests/` are MATERIALISED as real directories — never
 * symlinked — and one of them is left empty. Symlinking was a defect and a
 * serious one: a guard resolves its own location with `import.meta.dir`, which
 * follows the symlink back to the REAL repository, so an anchored guard read the
 * real tree while the mirror reported on nothing. Anchored guards are precisely
 * what this campaign produced, so the instrument was blind to its own subject.
 * Caught by `tool-context-isp-ratchet` passing 3/3 with `src/tool` holding zero
 * files — impossible, since it floors at 200, and the tell that the number came
 * from somewhere else.
 *
 * Everything else at the repo root stays a symlink: `node_modules`, `.git`, the
 * config files. Those are not corpus.
 */
const copyTree = (from: string, to: string, keep: (rel: string) => boolean): void => {
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(from, rel), { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const next = rel === "" ? ent.name : join(rel, ent.name)
      if (ent.isDirectory()) {
        mkdirSync(join(to, next), { recursive: true })
        walk(next)
      } else if (keep(next)) {
        cpSync(join(from, next), join(to, next))
      }
    }
  }
  mkdirSync(to, { recursive: true })
  walk("")
}

export /**
 * ONE mirror, and the corpus roots are the only thing emptied.
 *
 * Two earlier designs failed against measurement and are recorded so the next
 * attempt does not repeat them:
 *
 *  1. Symlink every root except the emptied one. A guard resolves its own
 *     location with `import.meta.dir`, which follows the symlink back to the
 *     REAL repository — so an anchored guard read the real tree while the mirror
 *     reported on nothing. Anchored guards are what this campaign produced, so
 *     the instrument was blind to its own subject.
 *  2. Empty `src/` outright. `tests/setup.ts` is a bunfig preload that imports
 *     `@/agent`, `@/observability`, `@/shared`; following that closure to keep
 *     the runner alive drags in 2,745 files including 311 under `src/tool`, so
 *     the arm stops being empty for exactly the guards that scan there.
 *
 * What works is narrower and honest about it: materialise the whole repo, then
 * empty ONLY the leaf directories a guard actually scans, leaving every module
 * the preload needs in place. The guard sees an empty corpus; the runtime does
 * not.
 */
/**
 * One arm per root a guard might scan, coarse to fine.
 *
 * `src` and `tests` whole are here because several guards walk an entire root —
 * `self-skip-reports-as-pass` walks both — and blanking only `tests/unit` left
 * enough of `tests/` behind to clear its floor, so the arm reported green over a
 * corpus that was mostly intact. The finer roots are here because a guard
 * scanning only `src/tool` is unaffected by blanking `tests`, and would look
 * sound in a coarse-only sweep.
 */
// `tests` whole is NOT an arm: the bunfig preload lives there, so blanking it
// kills the runner and every guard errors — an arm where nothing runs measures
// nothing. `tests/unit` is the largest slice that can be blanked while the
// preload survives.
const CORPUS_ROOTS = [
  "src",
  "src/tool",
  "src/agent",
  "src/apps",
  "src/runner",
  "tests/unit",
] as const

/**
 * Modules restored into a blanked root so the runner can start, discovered by
 * RUNNING rather than by following imports.
 *
 * Static closure was tried and does not work here: `tests/setup.ts` imports
 * `@/agent`, `@/observability` and `@/shared`, and those barrels transitively
 * re-export essentially all of `src/tool` — 300 of the 311 files under it. The
 * arm meant to blank `src/tool` kept 300 of its files, so it measured nothing.
 *
 * So the closure is found by fixpoint instead: blank the root, run, and if bun
 * says `Cannot find module 'X'`, restore X and try again. Whatever the preload
 * genuinely needs is a handful of files; everything else stays blank. Bounded
 * at 40 rounds so a resolution loop cannot hang the gate.
 */
const RESTORE_ROUNDS = 400

const moduleToRel = (spec: string): string | undefined => {
  const base = spec.replace(/^@\//, "src/").replace(/\.js$/, "")
  for (const cand of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (cand.endsWith(".ts") && existsSync(join(REPO_ROOT, cand))) return cand
  }
  return undefined
}

/** Restore just enough of a blanked root that `bun test` can start at all. */
export const healMirror = (dir: string, probe: string): void => {
  for (let round = 0; round < RESTORE_ROUNDS; round++) {
    const proc = Bun.spawnSync(["bun", "test", probe], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0", PWD: dir },
      timeout: 60_000,
    })
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
    // The importer matters: bun reports `Cannot find module './apply-patch' from
    // '<mirror>/src/tool/index.ts'`, and a relative specifier can only be
    // resolved against THAT file. Resolving it against a guessed root failed on
    // the first relative import and stalled the loop one module in.
    const m = /Cannot find module ['"]([^'"]+)['"](?: from ['"]([^'"]+)['"])?/.exec(out)
    const missing = m?.[1]
    if (missing === undefined) return
    const importer = m?.[2]
    const rel = missing.startsWith(".")
      ? importer === undefined
        ? undefined
        : moduleToRel(join(dirname(importer.replace(`${dir}/`, "")), missing))
      : moduleToRel(missing)
    if (rel === undefined) return
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    cpSync(join(REPO_ROOT, rel), join(dir, rel))
  }
}

const copyRepo = (to: string, blank: readonly string[]): void => {
  for (const name of readdirSync(REPO_ROOT)) {
    // `src` and `tests` are ALWAYS materialised, whichever root is being blanked.
    // Symlinking either one sends a guard's `import.meta.dir` back to the real
    // repository, so it reads the real corpus and the arm measures nothing. This
    // is the third time that defect has come back in this file — the first two
    // through a symlink-everything design, this one through a condition that let
    // the un-blanked root stay a link.
    if (name === "src" || name === "tests") continue
    Bun.spawnSync(["ln", "-sfn", join(REPO_ROOT, name), join(to, name)])
  }
  for (const root of ["src", "tests"]) {
    copyTree(join(REPO_ROOT, root), join(to, root), (rel) => {
      const full = join(root, rel)
      // Three things survive a blanked root:
      //   - a `.test.ts`, which is a GUARD and must be there to be judged;
      //   - anything the bunfig preload imports, transitively, without which the
      //     runner cannot start and the arm measures nothing. Blanking
      //     `src/tool` broke `@/tool` for `tests/setup.ts` and killed four of six
      //     arms outright.
      // The preload closure is a few dozen files against a corpus of thousands,
      // so the arm is still empty for every guard that scans the blanked tree —
      // and where it is not, the guard's own floor is what settles it.
      if (!blank.some((b) => full === b || full.startsWith(`${b}/`))) return true
      // Only guards survive the blank; whatever the runtime needs is restored
      // afterwards by `healMirror`, one measured module at a time.
      return full.endsWith(".test.ts")
    })
  }
}

export const buildMirror = (blank: readonly string[], probe?: string): string => {
  // `realpathSync`, because on macOS `mkdtempSync` returns `/tmp/…` while every
  // path bun prints is `/private/tmp/…`. Stripping the mirror prefix from an
  // importer path silently did nothing, so a relative specifier resolved against
  // the wrong directory and the heal loop stalled one module in — with no error,
  // because `moduleToRel` then found the file in the REAL repo and reported it
  // as already present.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "quanta-empty-mirror-")))
  copyRepo(dir, blank)
  if (probe !== undefined) healMirror(dir, probe)
  return dir
}

/** Run one guard inside one mirror. */
export const runInMirror = (mirror: string, rel: string): GuardVerdict => {
  const target = join(mirror, rel)
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(REPO_ROOT, rel), target)
  }
  const proc = Bun.spawnSync(["bun", "test", rel], {
    cwd: mirror,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", PWD: mirror },
    timeout: 120_000,
  })
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
  // A module-resolution failure is NOT the guard noticing an empty corpus. Bun
  // folds an unresolved import into the same `1 fail` a real assertion failure
  // produces, and reading that as "noticed" is the defect this whole tool exists
  // to find, committed by the tool: blanking `src/tool` makes `tests/setup.ts`
  // fail to import `@/tool`, so EVERY guard went red for a reason that has
  // nothing to do with what it scanned. Four of six arms were doing this.
  if (/Cannot find module/.test(out)) return "error"
  if (/^\s*[1-9]\d*\s+fail\s*$/m.test(out)) return "red"
  if (/^\s*\d+\s+pass\s*$/m.test(out)) return "green"
  return "error"
}

/**
 * A filesystem-scanning guard must go RED in at least one arm.
 *
 * The first rule here was "green in BOTH arms", which sounded conservative and
 * was simply wrong: a guard that reads only `src/` is legitimately green in the
 * empty-TESTS arm, so requiring both made it unfalsifiable. A probe with no floor
 * at all — `readdirSync(join(REPO_ROOT, "src"))` then `toEqual([])` — was green /
 * red and therefore "not vacuous", which is the opposite of the truth.
 *
 * The right question is whether the guard NOTICED an empty corpus, and it can
 * only notice in the arm where its own tree was emptied. So: red in at least one
 * arm means it noticed; green in both means it never did. Both are computed the
 * same way; only the reading changed.
 *
 * The false-positive risk moves to guards whose corpus is neither `src/` nor
 * `tests/` — a `tools/`-only scanner is green in both while being perfectly
 * sound. `ts-exports-ssot` is exactly that (it globs `tools/**` for its
 * consumers), and it is why the ledger has an admit list rather than the rule
 * being absolute.
 */
export const noticedEmptyCorpus = (a: GuardVerdict, b: GuardVerdict): boolean =>
  a === "red" || b === "red"

const guardsUnder = (roots: readonly string[]): readonly string[] => {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const next = join(rel, ent.name)
      if (ent.isDirectory()) walk(next)
      else if (next.endsWith(".test.ts")) out.push(next)
    }
  }
  for (const r of roots) if (existsSync(join(REPO_ROOT, r))) walk(r)
  return out.sort()
}

/**
 * Only a guard that reads the FILESYSTEM under `tests/` or `src/` can be judged
 * by these mirrors, and saying so is what keeps the gate honest.
 *
 * Two populations are green in both arms without being vacuous, and lumping them
 * in would make this a 12-false-positive gate that gets switched off:
 *
 *   - a pure unit test (`cwd-parity-check`, `expect-present-helper`,
 *     `sandboxed-test-runner`) never reads the corpus, so an empty one changes
 *     nothing. It has no scan to be vacuous about.
 *   - a `git ls-files`-backed guard (`repo-index-hygiene`,
 *     `no-leftover-backup-files`) reads the real index through the symlinked
 *     `.git`, which NEITHER mirror empties. Its corpus is untouched here, so this
 *     instrument cannot speak to it — a stated limit, not a pass. Those two carry
 *     derived floors (12,695 and 7,804 against 14,106 and 8,672) verified by hand.
 */
const FS_SCAN =
  /\breaddirSync\s*\(|\breaddir\s*\(|\bBun\.Glob\b|\bnew Glob\b|\bglobSync\s*\(|\bopendirSync\s*\(/

export const scansFilesystem = (rel: string): boolean => {
  try {
    return FS_SCAN.test(readFileSync(join(REPO_ROOT, rel), "utf8"))
  } catch {
    return false
  }
}

const ledgerEntries = (): readonly string[] =>
  (JSON.parse(readFileSync(LEDGER, "utf8")) as { burndown?: readonly string[] }).burndown ?? []

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const useLedger = argv.includes("--ledger")
  const roots = argv.filter((a) => !a.startsWith("--"))
  const selected = useLedger
    ? ledgerEntries()
    : guardsUnder(roots.length > 0 ? roots : ["tests/unit/_arch"])
  const guards = selected.filter(scansFilesystem)
  const skipped = selected.length - guards.length

  if (guards.length === 0) {
    console.error("empty-mirror: no guards selected — refusing to report over nothing.")
    process.exit(1)
  }
  const known = new Set(ledgerEntries())
  console.error(
    `empty-mirror: ${guards.length} filesystem-scanning guard(s), two arms each ` +
      `(${skipped} of ${selected.length} skipped: no filesystem scan, or git-index backed)`,
  )

  // One arm per corpus root: the guard must notice at least one of them being
  // emptied. Which root it reads cannot be told from the source — that is the
  // whole reason the static census under-reports — so every root is tried.
  const arms = CORPUS_ROOTS.map((root) => ({ root, dir: buildMirror([root]) }))
  const vacuous: string[] = []
  const errored: string[] = []
  try {
    for (const [i, rel] of guards.entries()) {
      // Heal each arm FOR THIS GUARD before judging it: the modules the runtime
      // needs differ per guard, and an arm that cannot start is not evidence.
      const verdicts = arms.map((a) => {
        healMirror(a.dir, rel)
        return runInMirror(a.dir, rel)
      })
      const usable = verdicts.filter((v) => v !== "error")
      // An arm whose runtime could not start proves nothing in either direction,
      // so it is discarded rather than counted as a pass or a failure.
      if (usable.length === 0) {
        errored.push(rel)
        continue
      }
      if (usable.some((v) => v === "red")) continue
      vacuous.push(rel)
      console.error(
        `  [${i + 1}/${guards.length}] VACUOUS ${rel} — green with every corpus root emptied`,
      )
    }
  } finally {
    for (const a of arms) rmSync(a.dir, { recursive: true, force: true })
  }

  // A guard that could not run in EITHER arm proved nothing; that is a broken
  // probe, not a clean guard, and it must not read as success.
  if (errored.length > 0) {
    console.error(`empty-mirror: ${errored.length} guard(s) failed to run in both arms:`)
    for (const e of errored) console.error(`  ${e}`)
  }
  const unlisted = vacuous.filter((v) => !known.has(v))
  console.error(
    `empty-mirror: ${guards.length} checked; ${vacuous.length} vacuous ` +
      `(${unlisted.length} not in the burn-down ledger), ${errored.length} unrunnable.`,
  )
  for (const u of unlisted) console.error(`  UNLISTED ${u}`)
  process.exit(unlisted.length === 0 && errored.length === 0 ? 0 : 1)
}
