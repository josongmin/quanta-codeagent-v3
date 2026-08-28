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
 * Build one mirror. Everything at the repo root is symlinked EXCEPT the roots
 * being emptied, which become bare directory skeletons.
 */
const buildMirror = (empty: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-empty-mirror-"))
  for (const name of readdirSync(REPO_ROOT)) {
    if (empty.includes(name)) continue
    Bun.spawnSync(["ln", "-sfn", join(REPO_ROOT, name), join(dir, name)])
  }
  for (const root of empty) {
    for (const rel of dirsUnder(root)) mkdirSync(join(dir, rel), { recursive: true })
  }
  // The preloads and shared helpers, without which nothing runs at all.
  if (empty.includes("tests")) {
    for (const keep of KEEP_UNDER_TESTS) {
      const from = join(REPO_ROOT, "tests", keep)
      if (existsSync(from)) cpSync(from, join(dir, "tests", keep), { recursive: true })
    }
  }
  // `src/**/*.test.ts` are guards, not corpus: emptying src must not delete the
  // guard being judged.
  if (empty.includes("src")) {
    for (const rel of srcTestFiles()) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      cpSync(join(REPO_ROOT, rel), join(dir, rel))
    }
  }
  return dir
}

const srcTestFiles = (): readonly string[] => {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const next = join(rel, ent.name)
      if (ent.isDirectory()) walk(next)
      else if (next.endsWith(".test.ts")) out.push(next)
    }
  }
  walk("src")
  return out
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
  if (/^\s*[1-9]\d*\s+fail\s*$/m.test(out)) return "red"
  if (/^\s*\d+\s+pass\s*$/m.test(out)) return "green"
  return "error"
}

/**
 * Green in BOTH arms — shown an empty corpus whichever tree it reads, and it
 * still reported no violations.
 */
export const isVacuous = (a: GuardVerdict, b: GuardVerdict): boolean =>
  a === "green" && b === "green"

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

const ledgerEntries = (): readonly string[] =>
  (JSON.parse(readFileSync(LEDGER, "utf8")) as { burndown?: readonly string[] }).burndown ?? []

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const useLedger = argv.includes("--ledger")
  const roots = argv.filter((a) => !a.startsWith("--"))
  const guards = useLedger
    ? ledgerEntries()
    : guardsUnder(roots.length > 0 ? roots : ["tests/unit/_arch"])

  if (guards.length === 0) {
    console.error("empty-mirror: no guards selected — refusing to report over nothing.")
    process.exit(1)
  }
  const known = new Set(ledgerEntries())
  console.error(`empty-mirror: ${guards.length} guard(s), two arms each`)

  const arms: readonly [MirrorArm, string][] = [
    ["empty-tests", buildMirror(["tests", "docs"])],
    ["empty-src", buildMirror(["src", "docs"])],
  ]
  const vacuous: string[] = []
  const errored: string[] = []
  try {
    for (const [i, rel] of guards.entries()) {
      const a = runInMirror(arms[0][1], rel)
      const b = runInMirror(arms[1][1], rel)
      if (a === "error" && b === "error") {
        errored.push(rel)
        continue
      }
      if (!isVacuous(a, b)) continue
      vacuous.push(rel)
      console.error(`  [${i + 1}/${guards.length}] VACUOUS ${rel} (green with an empty corpus)`)
    }
  } finally {
    for (const [, dir] of arms) rmSync(dir, { recursive: true, force: true })
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
