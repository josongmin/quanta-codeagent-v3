// Fourth lens: judge a TEST, not a file.
//
// The oracle runs `bun test <file>` and reads one verdict for the whole file. A
// file with one test that throws on a blanked tree and one that passes over an
// empty listing reads RED, and the vacuous test inside it is invisible — which is
// how `cross-slice-cycle` survived every earlier lens. This runs each
// scan-bearing test on its own with `-t`, so a pass is attributable.

import type { Dirent } from "node:fs"
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { stripComments } from "../../src/shared/source-text"
import { buildMirror, classifyOutput, importClosure } from "./empty-mirror-check"

const REPO = join(import.meta.dir, "..", "..")
const ROOTS = ["src", "tests", "tools", "docs"]
export const SCAN =
  /\breaddirSync\s*\(|\breaddir\s*\(|\bBun\.Glob\b|\bnew Glob\b|ls-files|\bglobSync\s*\(|\bopendirSync\s*\(|\bexecSync\s*\(\s*["'`][^"'`]*\b(?:find|git|rg|grep)\b/

export const namesOf = (raw: string): { name: string; body: string }[] => {
  const src = stripComments(raw)
  const out: { name: string; body: string }[] = []
  const re = /^\s*(?:it|test)(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/gm
  const starts: { name: string; at: number }[] = []
  for (const m of src.matchAll(re)) starts.push({ name: m[2] ?? "", at: m.index ?? 0 })
  const preamble = src.slice(0, starts[0]?.at ?? src.length)
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i] as { name: string; at: number }
    const end = starts[i + 1]?.at ?? src.length
    out.push({ name: s.name, body: `${preamble}\n${src.slice(s.at, end)}` })
  }
  return out
}

const blankRoot = (mirror: string, root: string, keep: ReadonlySet<string>): void => {
  const top = join(mirror, root)
  if (existsSync(top) && lstatSync(top).isSymbolicLink()) {
    unlinkSync(top)
    mkdirSync(top, { recursive: true })
    return
  }
  /** What to do with one entry: descend, unlink the link, drop it, or keep it. */
  const verdictFor = (
    e: Dirent,
    rel: string,
  ): "skip" | "descend" | "unlink" | "remove" | "keep" => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return "skip"
    if (e.isSymbolicLink()) return "unlink"
    if (e.isDirectory()) return "descend"
    return keep.has(join(root, rel)) ? "keep" : "remove"
  }
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(mirror, root, rel), { withFileTypes: true })) {
      const next = rel === "" ? e.name : join(rel, e.name)
      const what = verdictFor(e, next)
      if (what === "descend") walk(next)
      else if (what === "unlink") unlinkSync(join(mirror, root, next))
      else if (what === "remove") rmSync(join(mirror, root, next), { force: true })
    }
  }
  walk("")
}

/** Every corpus file the blank would have removed, so the control can hold it. */
const walkAll = (): string[] => {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const next = join(rel, e.name)
      if (e.isDirectory()) walk(next)
      else if (!e.name.endsWith(".test.ts")) out.push(next)
    }
  }
  for (const r of ROOTS) walk(r)
  return out
}

// ONE control for the whole shard. Nothing is blanked in it, so it does not
// depend on which guard is being judged — rebuilding it per guard copied ~7,000
// files back into a tree they had just been removed from.
const CONTROL = (() => {
  const dir = buildMirror("src")
  for (const rel of walkAll()) {
    const d = join(dir, rel)
    if (!existsSync(d)) {
      mkdirSync(dirname(d), { recursive: true })
      try {
        cpSync(join(REPO, rel), d)
      } catch {
        /* gone */
      }
    }
  }
  return dir
})()

const judge = (dir: string, file: string, name: string): { verdict: string; calls: number } => {
  const run = Bun.spawnSync(["bun", "test", file, "-t", name], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  const m = /(\d+)\s+expect\(\) calls/.exec(out)
  return { verdict: classifyOutput(out), calls: m === null ? 0 : Number(m[1]) }
}

/**
 * The rule the whole lens reduces to.
 *
 * A test that PASSES over a blanked tree while making strictly FEWER assertions
 * than it makes over the intact one asserted less because there was less to
 * assert — the loop body ran fewer times, or not at all. Equal counts mean the
 * test never depended on the corpus, which is most of them: over the whole
 * population 378 tests passed the blanked arm and 377 asserted identically in
 * both. Stating it as a comparison rather than as a reading of the source is
 * what makes the one that mattered separable from the 377 that did not.
 */
// biome-ignore lint/suspicious/noConsole: the CLI form of this file IS its output
const say = (line: string): void => console.log(line)

export const isVacuous = (blank: Arm, full: Arm): boolean =>
  blank.verdict === "green" && full.verdict === "green" && blank.calls < full.calls

export type Arm = { readonly verdict: string; readonly calls: number }

if (!import.meta.main) {
  // Imported for its pure parts; the sweep below is the CLI form.
} else
  for (const c of JSON.parse(await Bun.file(Bun.argv[2] as string).text()) as { file: string }[]) {
    const raw = await Bun.file(join(REPO, c.file)).text()
    const tests = namesOf(raw).filter((t) => SCAN.test(t.body))
    if (tests.length === 0) continue
    const keep = new Set([...importClosure(c.file), c.file])
    const mirror = buildMirror("src", c.file)
    // The CONTROL arm: the same mirror construction, nothing blanked. Comparing
    // against the real repo instead would compare two different bunfigs.
    const control = CONTROL
    try {
      for (const r of ROOTS) blankRoot(mirror, r, keep)
      for (const rel of keep) {
        const d = join(mirror, rel)
        if (!existsSync(d)) {
          mkdirSync(dirname(d), { recursive: true })
          cpSync(join(REPO, rel), d)
        }
      }
      for (const t of tests) {
        const blank = judge(mirror, c.file, t.name)
        if (blank.verdict !== "green") continue
        const full = judge(control, c.file, t.name)
        if (!isVacuous(blank, full)) continue
        // A test that PASSES over an emptied tree while making strictly fewer
        // assertions than it makes over the real one asserted less because there
        // was less to assert — the loop body ran fewer times, or not at all. That
        // is the defect stated as a measurement rather than as a reading of the
        // source. Equal counts mean the test never depended on the corpus.
        say(
          JSON.stringify({
            file: c.file,
            test: t.name,
            blank: blank.calls,
            full: full.calls,
            fullVerdict: full.verdict,
          }),
        )
      }
    } finally {
      rmSync(mirror, { recursive: true, force: true })
    }
  }
