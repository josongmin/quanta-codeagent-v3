/**
 * Git snapshot helpers — pre-image checkout + post-image cumulative diff.
 *
 * Owns: `withGitSnapshot`, `gitStageAndDiffCached`, `GIT_ARGV`, `sourceOnlyDiff`,
 * and the `ENV_POLICY_VERSION` + `gatherSandbox` snapshot probe. Pulled
 * verbatim from runner.ts (T2 prune-at-source pathspec exclusion already wired
 * via `getCachePathspecs`).
 */

import { lstat, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isTestFilePath, type SandboxData } from "@/shared"
import { getCachePathspecs } from "../corpus/cache-pathspecs"
import {
  type ProjectEnvSandboxFs,
  prepareProjectEnvSandbox,
  revertProjectEnvSandbox,
} from "../corpus/project-env"
import { type ExecResult, exec, execArgv, trimOut } from "./exec"
import { isBenchReproArtifactPath } from "./repro-artifacts"
import { stripEnvManifestPins } from "./strip-env-manifest-pins"

/** Real-fs port for P0 build-env materialization (node:fs/promises). The
 *  corpus helper is fs-injected so unit tests use a fake; production wires the
 *  real filesystem here. */
const snapshotFsPort: ProjectEnvSandboxFs = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, c) => writeFile(p, c),
  exists: async (p) => {
    try {
      await readFile(p)
      return true
    } catch {
      return false
    }
  },
  readdir: (p) => readdir(p),
  isDirectory: async (p) => {
    try {
      return (await lstat(p)).isDirectory()
    } catch {
      return false
    }
  },
}

/**
 * Common git argv prefix for bench-internal commits — matches the `${G}`
 * shell-string form used elsewhere but as an array so pathspec args stay
 * intact (no shell word-splitting). The `-c` overrides also bypass any user
 * `commit.gpgsign` config that would prompt for a signing key.
 */
export const GIT_ARGV: readonly string[] = [
  "git",
  "-c",
  "user.email=b@b",
  "-c",
  "user.name=b",
  "-c",
  "commit.gpgsign=false",
]

/** SWE-bench predictions must be SOURCE-only: the official harness applies its
 *  own gold `test_patch`, so any test-file hunk a model emits is at best
 *  discarded and at worst conflicts with / skews grading (observed: agents
 *  editing `tests/` produced large diffs that failed PASS_TO_PASS). Drop the
 *  per-file sections of a unified `git diff` whose path is a test file/dir.
 *
 *  ALSO drops binary-file sections. An agent that downloads an archive into the
 *  worktree (observed 2026-06-19: `setuptools-33.1.1.zip` fetched mid-run) has
 *  it swept by `git add -A` and emitted as a `GIT binary patch` / `Binary files
 *  … differ` blob. That blob is never part of a source fix AND the official
 *  harness's `git apply` REJECTS the ENTIRE prediction ("cannot apply binary
 *  patch … without full index line"), silently turning a correct source edit
 *  into an `unresolved` (masquerades as a model miss — RCA of astropy-7166/7336).
 *  A binary marker anywhere in a file section condemns that whole section.
 *
 *  Pure, order-preserving; non-test, non-binary (source) hunks pass through
 *  verbatim — byte-identical to the prior test-only filter for those inputs. */
/** Structural git-diff binary markers. Anchored at column 0 so they match the
 *  diff's own framing lines, never `+`/`-`/` `-prefixed hunk *content* that
 *  merely mentions the phrase (an added `+GIT binary patch` source line stays). */
const BINARY_MARKER_RE = /^(GIT binary patch|Binary files )/m
const HEADER_RE = /^diff --git a\/\S+ b\/(\S+)/

/** Agent-authored reproduction scaffolding the repro-test pipeline writes into
 *  the sandbox worktree to reproduce/verify the bug (samples=K → `__repro_0_…`
 *  … `__repro_{K-1}_…`, plus the canonical `reproduce_issue.py`) and their
 *  `.pytest-report.json` execution sidecars. These are test harness artifacts the
 *  AGENT/bench created, never part of the source fix. `git add -A`
 *  (gitStageAndDiffCached) stages them and — unlike test-path/binary — they slip
 *  past every other filter (`.py` at repo root, not under `tests/`, not binary),
 *  so the prediction ships with 4-21 stray `__repro_*.py` files. The official
 *  harness then applies the bloated patch and pytest collects the strays →
 *  PASS_TO_PASS breaks → a CORRECT source fix is graded `unresolved`, masquerading
 *  as a model miss. RCA of django gap-fails 11820/12308/12965/13128/14017/14351
 *  (2026-06-20): each had the right one-file fix buried under repro contamination.
 *  Matched on BASENAME so a path anywhere in the tree is condemned. */
const CANONICAL_REPRO_FILE_NAME = "reproduce_issue.py"

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

const appendGitExcludeLine = async (
  sandbox: string,
  timeoutMs: number,
  line: string,
): Promise<void> => {
  const gitPath = await execArgv(
    [...GIT_ARGV, "rev-parse", "--git-path", "info/exclude"],
    sandbox,
    timeoutMs,
  )
  if (gitPath.code !== 0) return
  const rawPath = trimOut(gitPath)
  if (rawPath === "") return
  const excludePath = rawPath.startsWith("/") ? rawPath : join(sandbox, rawPath)
  const current = (await readOptionalText(excludePath)) ?? ""
  if (current.split(/\r?\n/).includes(line)) return
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`
  await writeFile(excludePath, `${prefix}${line}\n`)
}

const restoreCanonicalReproScaffold = async (
  sandbox: string,
  timeoutMs: number,
  content: string | undefined,
): Promise<void> => {
  if (content === undefined) return
  // The canonical repro is a bench-owned execution scaffold, not submitted
  // source. Keep it available to the agent while excluding it from git capture
  // so rawDirty/lost-edits diagnostics are not poisoned by our own scaffold.
  await appendGitExcludeLine(sandbox, timeoutMs, `/${CANONICAL_REPRO_FILE_NAME}`)
  await writeFile(join(sandbox, CANONICAL_REPRO_FILE_NAME), content)
}

export const sourceOnlyDiff = (diff: string): string => {
  if (diff.trim() === "") return diff
  // Split into per-file SECTIONS on the `diff --git` header WITHOUT consuming it
  // (lookahead), so each section retains its exact bytes — including the trailing
  // newline that terminates its final hunk line. A naive line-split + join("\n")
  // would strip that terminator from a kept section whenever the following
  // section is dropped, yielding a "corrupt patch" the grader's `git apply`
  // rejects. Any text before the first header (rare preamble) is its own leading
  // section and is always kept. Concatenation of all sections is byte-identical
  // to the input when nothing is dropped.
  const sections = diff.split(/(?=^diff --git )/m)
  const kept = sections.filter((sec) => {
    const m = sec.match(HEADER_RE)
    if (m) {
      const p = m[1] ?? ""
      // SSOT: same test-path classifier the dispatch test-scope guard uses.
      if (isTestFilePath(p)) return false
      // Agent/bench reproduction artifacts — never part of the source fix. See
      // isBenchReproArtifactPath for the full RCA (django gap-fails, 2026-06-20).
      if (isBenchReproArtifactPath(p)) return false
    }
    // A structural binary marker anywhere in the section condemns the whole
    // section (header + index + blob) — see the doc comment above for why.
    if (BINARY_MARKER_RE.test(sec)) return false
    return true
  })
  return kept.join("")
}

/**
 * Stage everything in the worktree and capture the unified index diff with
 * cache-shaped paths pruned AT SOURCE (T2 — patch sanitizer prune-at-source).
 * Two steps because `git add -A` cannot share the same argv invocation as
 * `git diff --cached` without a shell `&&`, and a shell would re-process the
 * pathspec magic chars; here both steps run via argv-form `execArgv` so the
 * pathspecs reach git verbatim.
 *
 * Returns "" on any git failure (opportunistic, matches surrounding policy).
 */
export const gitStageAndDiffCached = async (cwd: string, timeoutMs: number): Promise<string> => {
  const add = await execArgv([...GIT_ARGV, "add", "-A"], cwd, timeoutMs)
  if (add.code !== 0) return ""
  const diff = await execArgv(
    [...GIT_ARGV, "diff", "--cached", "--no-color", "--", ".", ...getCachePathspecs()],
    cwd,
    timeoutMs,
  )
  // jun-28: strip env-applied dependency-pin contamination (e.g. setup.py
  // `install_requires` caps the box/swebench install adds to make an old repo
  // resolvable) so it never reaches the grader as a false "Patch Apply Failed".
  // No-op unless a manifest section is a pure same-package constraint rewording.
  return diff.code === 0 ? stripEnvManifestPins(sourceOnlyDiff(diff.stdout)) : ""
}

/**
 * T5 — does the worktree carry ANY staged change at all (before the
 * `sourceOnlyDiff` strip removes test/repro/binary sections)? Call AFTER a
 * `gitStageAndDiffCached` (which already ran `git add -A`) so the index reflects
 * the full tree. `git diff --cached --quiet` exits 1 when staged changes exist,
 * 0 when clean. A git failure ⇒ `false` (conservative: never invent a
 * capture-failure from an unknown tree state). This is the `rawDirty` fact that
 * separates a legitimate test-only edit (`stripped-only`) from a real
 * fork-worktree capture desync (`lost-edits`) in {@link classifyDoneTimeCapture}.
 */
export const gitWorktreeHasStagedChanges = async (
  cwd: string,
  timeoutMs: number,
): Promise<boolean> => {
  const r = await execArgv([...GIT_ARGV, "diff", "--cached", "--quiet"], cwd, timeoutMs).catch(
    () => null,
  )
  return r !== null && r.code === 1
}

/**
 * Snapshot helper: take a pre-image, run the agent, then diff.
 *
 * If the sandbox already contains a `.git` (real swebench cache repos do) and
 * `baseCommit` is supplied, we hard-checkout that commit FIRST so the agent
 * starts from the canonical buggy tree, then commit it as the pristine base.
 * Otherwise we `git init` a fresh repo over the copied files. After the agent
 * runs, `git add -A && git diff --cached` yields a proper unified
 * `diff --git a/… b/…` patch — exactly the SWE-bench prediction format. `git`
 * is opportunistic; absence/failure ⇒ "" rather than throwing.
 */
export const withGitSnapshot = async (
  sandbox: string,
  timeoutMs: number,
  baseCommit: string | undefined,
  body: () => Promise<void>,
  /** SWE-bench `owner/name` slug. When set, P0 build-env materialization runs
   *  AFTER the base checkout (so a repo whose build backend imports a dep at
   *  build time — e.g. astropy's `import extension_helpers` — can actually build
   *  under uv) and is surgically REVERTED before the candidate diff is captured,
   *  so this env-only `pyproject.toml` mutation NEVER leaks into the submitted
   *  patch. Undefined ⇒ byte-identical to the pre-P0 path (no-op). */
  repo?: string,
): Promise<string> => {
  const G = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false"
  const hasGit = (await exec("git rev-parse --git-dir", sandbox, timeoutMs)).code === 0
  const canonicalReproScaffold =
    hasGit && baseCommit !== undefined
      ? await readOptionalText(join(sandbox, CANONICAL_REPRO_FILE_NAME))
      : undefined
  const prep =
    hasGit && baseCommit
      ? `${G} checkout -q -f ${baseCommit} && ${G} reset -q --hard ${baseCommit} && ${G} clean -qfdx`
      : `git init -q . && ${G} add -A && ${G} commit -q -m base --allow-empty`
  const init = await exec(prep, sandbox, timeoutMs)
  if (init.code === 0) {
    await restoreCanonicalReproScaffold(sandbox, timeoutMs, canonicalReproScaffold)
  }
  // P0: materialize build-env deps into the checked-out tree BEFORE the agent
  // (and its repro/test exec) runs. The base checkout above would wipe a
  // pre-checkout materialization (`reset --hard`), so it MUST happen here.
  if (repo !== undefined) await prepareProjectEnvSandbox(sandbox, repo, snapshotFsPort)
  await body()
  if (init.code !== 0) return ""
  // P0: strip the env-only block back out BEFORE capture so it never leaks into
  // the submitted diff (a genuine agent edit to pyproject.toml survives — the
  // revert is surgical to the sentinel-fenced block).
  if (repo !== undefined) await revertProjectEnvSandbox(sandbox, repo, snapshotFsPort)
  // T2: exclude cache/build paths at the git layer via pathspec — pruning at
  // source is structural, where the prior post-hoc filter let mixed
  // source+cache patches (django leak, 2026-05-21) through.
  return gitStageAndDiffCached(sandbox, timeoutMs)
}

/**
 * Env-scrub policy version tied to the sandbox allowlist. Bumped only when the
 * scrub allowlist changes; stamped into every `sandbox` event so a trajectory
 * records which policy governed the run. `sandbox.v2` (Group A coordinated):
 * the allowlist no longer carries NODE_OPTIONS/NODE_EXTRA_CA_CERTS, and bench
 * `exec()` now spawns children with `scrubEnv()` — so the stamp is truthful.
 */
const ENV_POLICY_VERSION = "sandbox.v2"

/** Best-effort `<bin> --version` → first line, or undefined. */
const probeVersion = async (bin: string, sandbox: string, timeoutMs: number): Promise<string> => {
  const r = await exec(`${bin} --version 2>&1 | head -n1`, sandbox, timeoutMs)
  return trimOut(r)
}

/**
 * One-shot sandbox snapshot (RFC §5.2 `sandbox`). Gathered AFTER the repo is
 * copied + base-checked-out and BEFORE the agent runs, so `repoCommit` is the
 * pristine pre-agent HEAD. `git` is opportunistic — absence ⇒ empty commits,
 * never throws. `python` is best-effort/optional.
 */
export const gatherSandbox = async (
  sandbox: string,
  baseCommit: string | undefined,
  timeoutMs: number,
): Promise<SandboxData> => {
  const head: ExecResult = await exec("git rev-parse HEAD", sandbox, timeoutMs)
  const status: ExecResult = await exec("git status --porcelain", sandbox, timeoutMs)
  const [bun, node, python] = await Promise.all([
    probeVersion("bun", sandbox, timeoutMs),
    probeVersion("node", sandbox, timeoutMs),
    probeVersion("python3", sandbox, timeoutMs),
  ])
  const runtime: { bun?: string; node?: string; python?: string } = {
    ...(bun !== "" ? { bun } : {}),
    ...(node !== "" ? { node } : {}),
    ...(python !== "" ? { python } : {}),
  }
  return {
    repoCommit: trimOut(head),
    baseCommit: baseCommit ?? trimOut(head),
    worktreeDirty: status.code === 0 && status.stdout.trim() !== "",
    runtime,
    envPolicyVersion: ENV_POLICY_VERSION,
  }
}
