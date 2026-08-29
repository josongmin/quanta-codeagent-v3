/**
 * Ground truth for vacuity: run a guard against a tree whose corpus is EMPTY,
 * and require it to notice.
 *
 * ## Why an oracle and not another detector
 *
 * Three adversarial rounds over 2026-08-26/27 each found defects in the fixes,
 * and the pattern never varied: the static detector under-reported, and the lens
 * written to catch that shipped inert while green. A regex over source cannot
 * settle whether a guard would notice an empty corpus. Running it against one
 * can — provided the run itself is trustworthy, which is what most of this file
 * is about.
 *
 * ## The one design decision that makes it possible
 *
 * `bunfig.toml` preloads `tests/setup.ts`, and that file reaches production
 * modules to call its reset hooks. Measured: its runtime closure is 2,301 files
 * under `src/`, **291 of them under `src/tool`** — which is the corpus several
 * guards scan. So a mirror that empties `src/tool` while keeping the real bunfig
 * cannot start: the preload dies with `Cannot find module '@/tool'`.
 *
 * Two earlier engines tried to work around that and failed the same way. A
 * static import closure restored 281 of the 291; an execution-driven fixpoint
 * (restore whatever bun says is missing, repeat) took 107 seconds to restore
 * 281. In both, the arm stopped being empty for exactly the guards it existed to
 * judge.
 *
 * The mirror therefore does NOT use the repo's bunfig. It writes its own with no
 * preload, so the corpus and the runtime are independent. Emptying `src/tool`
 * then empties `src/tool`, and nothing has to be healed back. `tests/setup.ts`
 * resets process-global state BETWEEN tests; a mirror runs one guard in a fresh
 * process, so there is no accumulated state for it to reset.
 *
 * ## What counts as evidence
 *
 * Four outcomes, kept apart on purpose — collapsing them is the exact defect
 * this tool hunts:
 *
 *   - `red`      the guard ASSERTED and failed. It noticed.
 *   - `green`    the guard asserted and passed over an empty corpus.
 *   - `infra`    the run never produced a verdict (module resolution, timeout,
 *                crash). Proves nothing either way. An earlier version read the
 *                `1 fail` from an unresolved import as "noticed", which inverted
 *                the verdict for four of six arms.
 *   - `no-tests` bun started and executed zero tests. Also not evidence.
 *
 * ## The control
 *
 * Before any guard is judged, the SAME mirror runs a canary that must go RED
 * with the corpus emptied. If it does not, the mirror cannot tell an empty
 * corpus from a full one and every verdict from it is discarded. An oracle that
 * cannot fail is worth nothing, and this one has been wrong three times.
 */

import type { Dirent } from "node:fs"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const MANIFEST = join(REPO_ROOT, "tools", "dev", "anti-vacuity-cases.json")
const LEDGER = join(REPO_ROOT, "tools", "dev", "anti-vacuity-burndown.json")

/** Roots a guard may declare as the corpus its assertions consume. */
export const CORPUS_ROOTS = [
  "src",
  "src/tool",
  "src/runner/knobs/knobs",
  "tests/unit",
  "tools",
  "docs",
] as const
export type CorpusRoot = (typeof CORPUS_ROOTS)[number]

export type Verdict = "red" | "green" | "infra" | "no-tests"

/** The mirror's own bunfig — no preload. See the header for why. */
const MIRROR_BUNFIG = "[test]\ncoverage = false\n"

/** A `.test.ts` is a GUARD and must survive; everything else under a root is corpus. */
const isCorpus = (rel: string): boolean => !rel.endsWith(".test.ts")

const copyTree = (from: string, to: string, keep: (rel: string) => boolean): void => {
  const walk = (rel: string): void => {
    // A directory that vanishes mid-copy is not a corpus finding.
    //
    // This repo has several sessions working at once, and a test that creates a
    // scratch directory under `tests/` can remove it while the mirror is being
    // built. Letting the ENOENT escape killed a full 143-guard sweep partway
    // through — and a gate that dies on a race is a gate that gets disabled.
    // Skipping the entry is right: the mirror is a snapshot, and a path that no
    // longer exists is not part of it.
    let entries: Dirent[]
    try {
      entries = readdirSync(join(from, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const next = rel === "" ? ent.name : join(rel, ent.name)
      if (ent.isDirectory()) {
        mkdirSync(join(to, next), { recursive: true })
        walk(next)
      } else if (keep(next)) {
        try {
          cpSync(join(from, next), join(to, next))
        } catch {
          // Same race, one level down: the file went away between the listing
          // and the copy.
        }
      }
    }
  }
  mkdirSync(to, { recursive: true })
  walk("")
}

/**
 * A mirror of the repo with one corpus root emptied of everything but guards.
 *
 * `src` and `tests` are MATERIALISED, never symlinked: a guard resolves its own
 * location with `import.meta.dir`, which follows a symlink back to the real
 * repository — so an anchored guard would read the real tree while the mirror
 * reported on nothing. That defect returned twice in this file's history, which
 * is why it is stated here rather than left to the reader.
 */
/**
 * The modules ONE guard imports, transitively — kept alive when the corpus is
 * emptied.
 *
 * Several guards both SCAN a root and IMPORT from it: `knobs-import-bundle`
 * imports 68 modules under `src/runner/knobs` and then asserts something about
 * the set it scanned. Emptying `src` wholesale kills those imports, the run
 * produces no verdict, and `infra` is correctly not counted as noticing — but
 * then the guard can never be judged at all.
 *
 * So the blank keeps exactly the guard's own import closure and nothing else.
 * That is a handful of files against a corpus of thousands, and crucially it is
 * per-guard: a file `knobs-import-bundle` imports is not kept for a guard that
 * only scans. Unlike the whole-preload closure this replaces (2,301 files, 291
 * under src/tool), it cannot silently refill the corpus, and if it ever did the
 * canary would fail and the verdicts would be discarded.
 */
export const importClosure = (entry: string): ReadonlySet<string> => {
  const seen = new Set<string>()
  const resolve = (spec: string, from: string): string | undefined => {
    const base = spec.startsWith("@/")
      ? spec.replace(/^@\//, "src/")
      : spec.startsWith(".")
        ? join(dirname(from), spec)
        : undefined
    if (base === undefined) return undefined
    // Any extension, not just `.ts`: this repo imports assets
    // (`import md from "./add-tests/SKILL.md" with { type: "text" }`), and
    // dropping them from the closure left the guard unable to start — an `infra`
    // verdict that looks like a tool limitation and is really a missing file.
    // `${base}.ts` and `index.ts` FIRST: `@/realtime` resolves to a directory,
    // and returning the directory itself made the closure keep a folder instead
    // of the barrel, so the import still failed. `base` last covers asset
    // imports (`./add-tests/SKILL.md`), which have their own extension.
    for (const cand of [`${base}.ts`, join(base, "index.ts"), base]) {
      const abs = join(REPO_ROOT, cand)
      if (!existsSync(abs)) continue
      if (statSync(abs).isDirectory()) continue
      return cand
    }
    return undefined
  }
  const specifiersIn = (raw: string): readonly string[] => {
    // Comments first. This is a text scan, so `// from "@/foo"` counted as an
    // import and the closure kept `@/foo` alive — meaning comment lines could
    // pad a guard's kept-corpus until it crossed the overlap threshold and was
    // excused as UNSUPPORTED. Measured on the nearest live case: 244 comment
    // lines were enough.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
    const out: string[] = []
    // Anchored to a real import STATEMENT, not to the text `from "…"` anywhere.
    // A scanning guard quotes module specifiers inside its own assertions —
    // `expect(text.includes('import type { PermissionMode } from "@/permission"'))`
    // — and treating those as imports resurrected the barrel they name. Measured:
    // that one string kept 102 corpus files alive in the mirror, which is enough
    // to fail the canary and make the guard unjudgeable.
    // `[\s\S]` and not `[^\n]`: a barrel writes its re-exports across several
    // lines, and stopping at the newline missed every one. Measured —
    // `@/agent/observation/metrics` re-exports `./failure-taxonomy` in a
    // multi-line block, so the closure kept the barrel but not what it pointed
    // at, and four guards died with `Cannot find module` before running.
    // Bounded to 400 chars so an unterminated brace cannot swallow the file.
    for (const m of src.matchAll(
      /^[ \t]*(?:import|export)\b(?:(?!\bfrom\b)[\s\S]){0,400}?\bfrom\s*["'`]([^"'`]+)["'`]/gm,
    )) {
      out.push(m[1] ?? "")
    }
    for (const m of src.matchAll(/^\s*(?:import|export)\s+["'`]([^"'`]+)["'`]/gm)) {
      out.push(m[1] ?? "")
    }
    // A dynamic `import("…")` is a real edge wherever it appears.
    for (const m of src.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g)) out.push(m[1] ?? "")
    return out
  }
  const readOrEmpty = (rel: string): string => {
    try {
      return readFileSync(join(REPO_ROOT, rel), "utf8")
    } catch {
      return ""
    }
  }
  const visit = (rel: string): void => {
    if (seen.has(rel)) return
    seen.add(rel)
    const src = readOrEmpty(rel)
    // `from "…"` covers `import`, `export … from` (a barrel's re-exports) and the
    // dynamic form. Missing the re-export shape left `@/runner/knobs`'s 68
    // registrations out of the closure, so the guard could not start and read as
    // `infra` — an unjudgeable guard, not a sound one.
    for (const spec of specifiersIn(src)) {
      const next = resolve(spec, rel)
      if (next !== undefined) visit(next)
    }
  }
  visit(entry)
  return seen
}

/**
 * Delete the corpus from a cloned root, keeping guards and the staged closure.
 *
 * The clone is a byte-identical copy, so blanking happens after the fact. Removal
 * is cheap — the files it deletes are the ones the mirror must not have — and it
 * uses the SAME predicate the per-file walk uses, so the two paths cannot drift.
 */
const pruneCorpus = (
  dir: string,
  root: string,
  blank: CorpusRoot,
  needed: ReadonlySet<string>,
): void => {
  const walk = (rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const next = rel === "" ? e.name : join(rel, e.name)
      // The walk below NEVER copies these, so the clone must not keep them: two
      // mirror-construction paths that disagree about what is in the tree are two
      // different oracles. `src/.env` is the live case — invisible under the walk,
      // corpus under the clone, and surviving a blank that skipped it.
      if (e.name === "node_modules" || e.name.startsWith(".")) {
        rmSync(join(dir, next), { recursive: true, force: true })
        continue
      }
      if (e.isDirectory()) {
        walk(next)
        continue
      }
      const full = join(root, next)
      const inBlank = full === blank || full.startsWith(`${blank}/`)
      if (inBlank && isCorpus(full) && !needed.has(full)) {
        rmSync(join(dir, next), { force: true })
      }
    }
  }
  walk("")
}

export const buildMirror = (blank: CorpusRoot, guard?: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "quanta-empty-mirror-")))
  const materialised = new Set(["src", "tests", blank.split("/")[0] as string])
  const needed = guard === undefined ? new Set<string>() : importClosure(guard)
  for (const name of readdirSync(REPO_ROOT)) {
    if (materialised.has(name) || name === "bunfig.toml") continue
    Bun.spawnSync(["ln", "-sfn", join(REPO_ROOT, name), join(dir, name)])
  }
  // `cp -Rc` first: APFS clonefile copies 3,737 files in ~1.8s by sharing blocks,
  // where the per-file walk below takes tens of seconds. A 136-guard sweep is one
  // mirror per guard, so this is the difference between a gate that finishes and
  // one nobody runs. Falls through to the walk when clonefile is unavailable
  // (a non-APFS volume, another OS) rather than assuming it worked.
  for (const root of materialised) {
    const cloned = Bun.spawnSync(["cp", "-Rc", join(REPO_ROOT, root), join(dir, root)])
    if (cloned.exitCode === 0) {
      pruneCorpus(join(dir, root), root, blank, needed)
      continue
    }
    copyTree(join(REPO_ROOT, root), join(dir, root), (rel) => {
      const full = join(root, rel)
      const inBlank = full === blank || full.startsWith(`${blank}/`)
      return !inBlank || !isCorpus(full) || needed.has(full)
    })
  }
  writeFileSync(join(dir, "bunfig.toml"), MIRROR_BUNFIG)
  return dir
}

/**
 * Classify one run's output.
 *
 * By INSPECTING THE OUTPUT, not the exit code: bun folds an unresolved import, a
 * timeout and a genuine assertion failure into the same non-zero exit and the
 * same `1 fail` counter, and telling them apart is the whole point.
 */
export const classifyOutput = (out: string): Verdict => {
  // bun's own `N error` counter is the authority for "the run died", not the
  // wording of the exception. Matching only `Cannot find module` credited a
  // module-scope `ENOENT: no such file or directory` as RED — the guard "noticed"
  // by crashing before a single assertion ran. Three live manifest cases were
  // certified sound that way, and a fourth with identical structure read INFRA
  // purely because its message differed.
  if (/^\s*[1-9]\d*\s+error\s*$/m.test(out)) return "infra"
  if (/# Unhandled error between tests/.test(out)) return "infra"
  if (/Cannot find module|Failed to resolve/.test(out)) return "infra"
  if (/timed out after/.test(out)) return "infra"
  const ran = /Ran (\d+) tests?/.exec(out)
  if (ran !== null && ran[1] === "0") return "no-tests"
  if (/^\s*[1-9]\d*\s+fail\s*$/m.test(out)) return "red"
  if (/^\s*[1-9]\d*\s+pass\s*$/m.test(out)) return "green"
  return "infra"
}

export const runInMirror = (mirror: string, rel: string): Verdict => {
  const proc = Bun.spawnSync(["bun", "test", rel], {
    cwd: mirror,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", PWD: mirror },
    timeout: 120_000,
  })
  return classifyOutput(`${proc.stdout.toString()}${proc.stderr.toString()}`)
}

/** One guard, bound to the corpus root its assertions actually consume. */
export type GuardCase = { readonly file: string; readonly corpus: CorpusRoot }

/**
 * How many CORPUS files survived in the blanked root.
 *
 * The mirror keeps a guard's own transitive imports so it can start; when the
 * guard imports the very tree it enumerates, that exemption refills the corpus.
 * Measuring it is what turns a silent false negative into a stated limit.
 */
/**
 * Corpus files left in the blanked root — guards EXCLUDED, deliberately.
 *
 * Two wrong answers were tried here. Counting only non-test files hid the 299
 * `src/**\/*.test.ts` that survive the blank, so a mirror holding 300 real `.ts`
 * reported an overlap of 1. Counting every `.ts` overcorrected: guards are kept
 * ON PURPOSE (they are what is being judged), and including them put every
 * `src`-rooted guard over the threshold — measured, the real corpus remainder is
 * 0–102 files while the guard count is a constant 299.
 *
 * What the threshold is about is how much of the CORPUS the guard's own imports
 * resurrected, so guards are excluded and the 299 are reported separately by the
 * canary, which fails if the blanked root is not actually empty.
 */
export const corpusOverlap = (mirror: string, root: CorpusRoot): number => {
  let n = 0
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith(".ts") && isCorpus(p)) n++
    }
  }
  walk(join(mirror, root))
  return n
}

/**
 * The arm is unjudgeable when the guard's own imports kept too much of the corpus.
 *
 * A FRACTION, measured. The first version used an absolute count of 20, which
 * marked five sound guards unsupported including three just verified red. The
 * second used 0.9, which an audit showed was far too loose: four manifest cases
 * are judged with **76% of `src/` still present**, kept alive by their own import
 * closures. A guard passing over a three-quarters-full tree is what a SOUND guard
 * does — reading that as "it noticed" is the same collapse of two states this
 * whole tool exists to prevent.
 *
 * Measured across the manifest today: 0.0% for four cases, 75.9–76.2% for four,
 * 98.5% for the one already reported UNSUPPORTED. There is no threshold between
 * 76% and 98% that is principled, so the bar is set where an arm is still mostly
 * empty. Everything above it is reported UNSUPPORTED with its number, which is a
 * statement of what the instrument cannot see rather than a verdict.
 */
export const OVERLAP_FRACTION = 0.25

/** The same count against the REAL tree, so the ratio has a denominator. */
export const realCorpusSize = (root: CorpusRoot): number => corpusOverlap(REPO_ROOT, root)

export const manifest = (): readonly GuardCase[] =>
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases?: readonly GuardCase[] }).cases ?? []

export const ledgerEntries = (): readonly string[] =>
  (JSON.parse(readFileSync(LEDGER, "utf8")) as { burndown?: readonly string[] }).burndown ?? []

/**
 * The canary, written INTO the mirror rather than kept in the tree.
 *
 * It cannot drift with the repo and cannot be silenced by an allowlist. Its only
 * job is to prove the mirror distinguishes an empty corpus from a full one; if
 * it comes back anything but red, every verdict from that mirror is discarded.
 */
const CANARY = "tests/unit/_arch/zz-empty-mirror-canary.test.ts"

/**
 * The canary's floor is RELATIVE to the real corpus, not a fixed 5.
 *
 * A guard's own imports are kept so the runtime can start, and for a guard that
 * imports from the tree it scans those files ARE corpus. At an absolute floor of
 * 5, forty surviving files out of thirty-four hundred read as "the corpus is
 * present" and the guard became unjudgeable — measured, that alone took a sample
 * of 30 from 10 unsupported to 14 as the closure got better at resolving imports.
 *
 * What matters is whether the remainder could still satisfy a scan-derived
 * verdict, which is a share of the whole and not a count. A tenth of the corpus
 * cannot: every floor in this repo is set near its full population.
 */
const canaryFloor = (root: CorpusRoot): number =>
  Math.max(5, Math.floor(corpusOverlap(REPO_ROOT, root) * 0.1))

const canarySource = (root: string, floor: number): string =>
  [
    `import { describe, expect, test } from "bun:test"`,
    `import { readdirSync } from "node:fs"`,
    `import { join } from "node:path"`,
    `const REPO_ROOT = join(import.meta.dir, "..", "..", "..")`,
    `const walk = (d: string): string[] => {`,
    `  const out: string[] = []`,
    `  for (const e of readdirSync(d, { withFileTypes: true })) {`,
    `    if (e.name.startsWith(".") || e.name === "node_modules") continue`,
    `    const p = join(d, e.name)`,
    `    if (e.isDirectory()) out.push(...walk(p))`,
    `    else if (!p.endsWith(".test.ts")) out.push(p)`,
    `  }`,
    `  return out`,
    `}`,
    `describe("canary", () => {`,
    `  test("the corpus is present", () => {`,
    `    expect(walk(join(REPO_ROOT, "${root}")).length).toBeGreaterThan(${floor})`,
    `  })`,
    `})`,
    ``,
  ].join("\n")

export const canaryHolds = (mirror: string, root: CorpusRoot): boolean => {
  const path = join(mirror, CANARY)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, canarySource(root, canaryFloor(root)))
  const verdict = runInMirror(mirror, CANARY)
  rmSync(path, { force: true })
  return verdict === "red"
}

/** This is a CLI: its findings ARE its output. One seam, one suppression. */
// biome-ignore lint/suspicious/noConsole: the tool reports to the operator
const say = (line: string): void => console.error(line)

if (import.meta.main) {
  const cases = manifest()
  if (cases.length === 0) {
    say("empty-mirror: the manifest is empty — refusing to report over nothing.")
    process.exit(1)
  }
  const byRoot = new Map<CorpusRoot, GuardCase[]>()
  for (const c of cases) byRoot.set(c.corpus, [...(byRoot.get(c.corpus) ?? []), c])

  const known = new Set(ledgerEntries())
  const vacuous: string[] = []
  const unusable: string[] = []
  const unsupported: string[] = []
  let checked = 0

  for (const [root, group] of byRoot) {
    // One mirror PER GUARD: the kept import closure is that guard's, so sharing a
    // mirror across guards would refill the corpus with another guard's imports.
    const canaryMirror = buildMirror(root)
    try {
      if (!canaryHolds(canaryMirror, root)) {
        say(
          `empty-mirror: the ${root} mirror FAILED its canary — it cannot tell an empty ` +
            `corpus from a full one, so its ${group.length} verdict(s) are worthless.`,
        )
        process.exit(1)
      }
      rmSync(canaryMirror, { recursive: true, force: true })
      for (const c of group) {
        checked++
        const mirror = buildMirror(root, c.file)
        // A guard that IMPORTS most of the corpus it scans cannot be judged this
        // way: its own import closure refills the tree. `knobs-import-bundle`
        // imports 68 per-knob modules and then asserts about the 68 files it
        // enumerated, so the mirror keeps 67 of them and the arm is not empty.
        // Saying "not vacuous" there would be a lie — the oracle simply has no
        // verdict, and an overlap it cannot see through must be reported, never
        // silently counted as a pass.
        // The canary belongs on THIS mirror, not on a guard-less one built
        // earlier. The per-guard mirror keeps that guard's import closure, so it
        // can be far fuller than the one the canary was run against — measured:
        // the canary REJECTS the mirror used for `voice-session-hellgate`, and
        // the oracle never asked.
        if (!canaryHolds(mirror, root)) {
          unsupported.push(`${c.file} (its mirror failed the canary — corpus not empty enough)`)
          rmSync(mirror, { recursive: true, force: true })
          continue
        }
        const overlap = corpusOverlap(mirror, root)
        if (overlap > realCorpusSize(root) * OVERLAP_FRACTION) {
          unsupported.push(`${c.file} (${overlap} corpus files kept by its own imports)`)
          rmSync(mirror, { recursive: true, force: true })
          continue
        }
        const v = runInMirror(mirror, c.file)
        rmSync(mirror, { recursive: true, force: true })
        if (v === "red") continue
        if (v === "green") {
          vacuous.push(c.file)
          say(`  VACUOUS ${c.file} — green with ${root} emptied`)
        } else {
          unusable.push(`${c.file} (${v})`)
        }
      }
    } finally {
      rmSync(canaryMirror, { recursive: true, force: true })
    }
  }

  const unlisted = vacuous.filter((v) => !known.has(v))
  for (const u of unsupported) say(`  UNSUPPORTED ${u}`)
  say(
    `empty-mirror: ${checked} checked across ${byRoot.size} corpus root(s); ` +
      `${vacuous.length} vacuous (${unlisted.length} unlisted), ` +
      `${unusable.length} without a verdict, ${unsupported.length} unsupported.`,
  )
  for (const u of unlisted) say(`  UNLISTED ${u}`)
  for (const u of unusable) say(`  NO VERDICT ${u}`)
  // UNSUPPORTED is not a pass. It says the instrument could not look, and a run
  // where most cases are unjudgeable must not read as a clean sweep — that
  // collapse of "clean" and "I never looked" is the defect this tool exists to
  // find. It is a CEILING rather than zero-tolerance because the overlap is a
  // property of the guard's imports, not something a single commit can fix: the
  // number may go down, never up.
  // A FRACTION of what was checked, not a fixed count. An absolute ceiling
  // punishes the only thing that matters here — widening the manifest — because
  // every guard added that the oracle cannot judge pushes the total up. What
  // must not drift is the SHARE of the corpus the instrument is blind to.
  const UNSUPPORTED_CEILING = Math.max(3, Math.floor(checked * 0.4))
  if (unsupported.length > UNSUPPORTED_CEILING) {
    say(
      `empty-mirror: ${unsupported.length} guards are unjudgeable (ceiling ` +
        `${UNSUPPORTED_CEILING}). Their own imports refill the corpus, so this run ` +
        `proves nothing about them — decouple the guard from the tree it enumerates.`,
    )
  }
  const clean =
    unlisted.length === 0 && unusable.length === 0 && unsupported.length <= UNSUPPORTED_CEILING
  process.exit(clean ? 0 : 1)
}
