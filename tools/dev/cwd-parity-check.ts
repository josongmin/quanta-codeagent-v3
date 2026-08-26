/**
 * Paired control for cwd dependence: run the same tests from the repo root and
 * from a throwaway working directory, and report only the DIFFERENCE.
 *
 * ## Why a diff and not just "run it in a sandbox"
 *
 * A test failing under a foreign cwd proves nothing on its own. This suite has a
 * documented history of load-induced failures being read as real regressions —
 * two concurrent sessions once turned a full run into 4.7 hours and 232 timeout
 * REDs, none of them regressions. So a single-arm sandbox run produces a list
 * that mixes genuine cwd dependence with whatever the machine was doing.
 *
 * Only the diff is evidence: a file that fails in BOTH arms is broken or loaded,
 * not cwd-dependent, and it cancels.
 *
 * ## Why SEQUENTIAL, and why per-file
 *
 * An earlier plan specified "both arms at the same time, on a quiet tree". Those
 * two conditions are mutually exclusive — running two full suites simultaneously
 * IS the load. So the arms run back-to-back per file, which keeps them close
 * enough in time to share machine conditions without either arm being the other's
 * noise.
 *
 * Per-file rather than per-suite for the same reason the runner batches: a whole-
 * suite verdict tells you something differs and not where.
 *
 * ## The re-run
 *
 * A file that differs is run a SECOND time in both arms before being reported.
 * A difference that does not reproduce is recorded as FLAKY rather than as a
 * finding — that distinction is the whole point of the harness, and dropping it
 * would reintroduce the ambiguity it exists to remove.
 *
 * Usage:
 *   bun run tools/dev/cwd-parity-check.ts tests/unit/_arch
 *   bun run tools/dev/cwd-parity-check.ts --shard 1/8 tests/unit
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { assertPreloadsMatchBunfig, expandTestFiles } from "./sandboxed-test"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const PRELOADS = ["tests/preload-clean-source-js.ts", "tests/setup.ts"] as const

/** Generous — the slowest real file here is ~12s cold — but finite. */
const ARM_TIMEOUT_MS = 120_000

export type ArmResult = { readonly ok: boolean; readonly pass: number; readonly fail: number }

/**
 * Parse bun's tail counters.
 *
 * Deliberately NOT reading the exit code alone: a run that dies before any test
 * executes also exits non-zero, and treating that as "0 pass, 0 fail" would make
 * an aborted arm look like a passing one when compared against another aborted
 * arm. `ok` therefore requires a counter line to have been present at all.
 */
export const parseCounters = (output: string): ArmResult => {
  // The LAST counter line, not the first. `exec` returns the first match, so any
  // earlier counter-shaped line in the body — a test that prints one, an inner
  // `bun test` — masked the real tail. Measured on a hand-built arm whose truth
  // was `0 pass / 1 fail`: the parser returned `{ok:true, pass:1, fail:0}`, and
  // `armsDiffer` then reported no difference. A false NEGATIVE on exactly the
  // class this instrument exists to catch.
  const last = (re: RegExp): string | undefined => [...output.matchAll(re)].at(-1)?.[1]
  const pass = Number(last(/^\s*(\d+)\s+pass\s*$/gm) ?? "-1")
  const fail = Number(last(/^\s*(\d+)\s+fail\s*$/gm) ?? "-1")
  if (pass < 0 && fail < 0) return { ok: false, pass: -1, fail: -1 }
  const p = Math.max(pass, 0)
  const f = Math.max(fail, 0)
  return { ok: f === 0 && p > 0, pass: p, fail: f }
}

/**
 * True when the two arms disagree about the outcome.
 *
 * The pass count is compared through `ran`, not directly. Comparing `ok` and
 * `fail` alone let a file that could not LOAD in one arm pass unnoticed whenever
 * it also had a failing test: bun folds an unhandled module-scope error into
 * `1 fail`, so `{pass:1, fail:1}` and `{pass:0, fail:1}` looked identical.
 * Comparing raw pass counts instead would make every conditionally-skipped test
 * look cwd-dependent, so what is compared is whether ANY test ran at all — which
 * is the load failure, without the skip noise.
 */
const ran = (r: ArmResult): boolean => r.pass > 0
export const armsDiffer = (a: ArmResult, b: ArmResult): boolean =>
  a.ok !== b.ok || a.fail !== b.fail || ran(a) !== ran(b)

/** `1/8` → files whose index mod 8 is 0. Shape mirrors bun's own `--shard`. */
export const shardOf = <T>(xs: readonly T[], spec: string | undefined): readonly T[] => {
  if (spec === undefined) return xs
  const m = /^(\d+)\/(\d+)$/.exec(spec)
  if (!m) throw new Error(`--shard expects N/M (got "${spec}")`)
  const idx = Number(m[1])
  const total = Number(m[2])
  if (idx < 1 || idx > total) throw new Error(`--shard ${spec}: index out of range`)
  return xs.filter((_, i) => i % total === idx - 1)
}

/**
 * Split argv into the shard spec and the roots.
 *
 * Extracted and pinned because the inline version had the bug this repo has now
 * shipped twice: `argv.filter((a, i) => … && i !== shardAt + 1)` with `--shard`
 * ABSENT makes `shardAt` -1, so `shardAt + 1` is 0 and the FIRST root is silently
 * dropped. The harness then fell back to its `tests/unit` default and reported on
 * 3,000 files while claiming to check the handful it was given.
 */
export const parseParityArgs = (
  argv: readonly string[],
): { readonly shardSpec: string | undefined; readonly roots: readonly string[] } => {
  // `--shard=1/8` as well as `--shard 1/8`. The equals form is what `bun test
  // --help` documents, and matching only the exact token meant it was dropped as
  // an unknown flag and the run silently went UNSHARDED — the same
  // silently-broadens-scope class as the off-by-one this function exists to fix.
  const inline = argv.find((a) => a.startsWith("--shard="))
  const shardAt = argv.indexOf("--shard")
  const valueAt = shardAt === -1 ? -1 : shardAt + 1
  return {
    shardSpec: inline?.slice("--shard=".length) ?? (shardAt === -1 ? undefined : argv[shardAt + 1]),
    roots: argv.filter((a, i) => !a.startsWith("--") && i !== valueAt),
  }
}

const runArm = (file: string, cwd: string): ArmResult => {
  const preloads = PRELOADS.flatMap((p) => ["--preload", join(REPO_ROOT, p)])
  const proc = Bun.spawnSync(["bun", "test", ...preloads, file], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // PWD is overridden, not inherited: bun's per-test timeout does not cover a
    // module-scope hang, and a stale PWD pointing at the repo root is a second
    // way for the sandbox arm to resolve as if it were the root arm.
    env: { ...process.env, FORCE_COLOR: "0", PWD: cwd },
    // A cwd-dependent HANG is the most severe form of what this measures and was
    // the one form it could not report: with no timeout the harness waited
    // forever, produced no verdict, and the interrupt skipped the `finally` that
    // removes the sandbox.
    timeout: ARM_TIMEOUT_MS,
  })
  return parseCounters(`${proc.stdout.toString()}${proc.stderr.toString()}`)
}

type Verdict = "cwd-dependent" | "flaky" | "broken-both"

/**
 * Which arm failed, or neither.
 *
 * The verdict needs the SIDE, not just the fact of a difference. Without it an
 * alternating fixture — failing on invocations 0 and 3, with zero cwd
 * involvement — reproduces "a difference" in both pairs and was reported
 * cwd-dependent while the failing arm SWITCHED SIDES between them. Measured on a
 * coinflip fixture over 20 runs: 15% cwd-dependent, 30% flaky, 55% clean, where
 * the arithmetic says 25/25/50 — i.e. a quarter of pure coincidences were being
 * reported as findings.
 */
const failingSide = (root: ArmResult, sbx: ArmResult): "root" | "sandbox" | "both" | "neither" => {
  if (!root.ok && !sbx.ok) return "both"
  if (!root.ok) return "root"
  if (!sbx.ok) return "sandbox"
  return "neither"
}

export const classify = (
  root: ArmResult,
  sbx: ArmResult,
  root2: ArmResult,
  sbx2: ArmResult,
): Verdict | null => {
  const first = armsDiffer(root, sbx)
  const second = armsDiffer(root2, sbx2)
  if (!first && !second) return null
  if (first !== second) return "flaky"
  if (!first && !second) return null
  // Both pairs differ. It only reproduces if the SAME side failed both times —
  // otherwise the two differences are unrelated events.
  const a = failingSide(root, sbx)
  const b = failingSide(root2, sbx2)
  if (a !== b) return "flaky"
  if (a === "both") return "broken-both"
  return "cwd-dependent"
}

if (import.meta.main) {
  assertPreloadsMatchBunfig(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8"))

  const { shardSpec, roots } = parseParityArgs(process.argv.slice(2))
  // Absolute, because the sandbox arm runs with a DIFFERENT cwd: a relative path
  // resolves for the root arm and not for the sandbox one, so every file's sandbox
  // arm dies before a counter line is printed and the harness reports the entire
  // suite as cwd-dependent. It did exactly that on its first run — 507 "findings",
  // all of them the harness failing to hand bun a path it could open.
  const files = shardOf(
    expandTestFiles((roots.length > 0 ? roots : ["tests/unit"]).map((r) => resolve(REPO_ROOT, r))),
    shardSpec,
  )

  if (files.length === 0) {
    console.error("cwd-parity: no test files matched — refusing to report parity over nothing.")
    process.exit(1)
  }
  console.error(`cwd-parity: ${files.length} file(s)${shardSpec ? ` (shard ${shardSpec})` : ""}`)

  const sandbox = mkdtempSync(join(tmpdir(), "quanta-parity-"))
  const findings: Array<{ file: string; verdict: Verdict; detail: string }> = []
  try {
    for (const [i, file] of files.entries()) {
      const root = runArm(file, REPO_ROOT)
      const sbx = runArm(file, sandbox)
      if (!armsDiffer(root, sbx)) continue
      // Differs — settle it with a second pair before believing it.
      const root2 = runArm(file, REPO_ROOT)
      const sbx2 = runArm(file, sandbox)
      const verdict = classify(root, sbx, root2, sbx2)
      if (verdict === null) continue
      const rel = file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file
      findings.push({
        file: rel,
        verdict,
        detail: `root ${root.pass}p/${root.fail}f, sandbox ${sbx.pass}p/${sbx.fail}f`,
      })
      console.error(`  [${i + 1}/${files.length}] ${verdict}: ${rel} — ${findings.at(-1)?.detail}`)
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  const cwdDependent = findings.filter((f) => f.verdict === "cwd-dependent")
  console.error(
    `cwd-parity: ${files.length} checked; ${cwdDependent.length} cwd-dependent, ` +
      `${findings.filter((f) => f.verdict === "flaky").length} flaky, ` +
      `${findings.filter((f) => f.verdict === "broken-both").length} failing in both arms.`,
  )
  for (const f of cwdDependent) console.error(`  ${f.file}: ${f.detail}`)
  process.exit(cwdDependent.length === 0 ? 0 : 1)
}
