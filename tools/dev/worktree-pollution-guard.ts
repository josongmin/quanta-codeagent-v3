/**
 * Worktree-pollution guard — a test suite may not leave files behind.
 *
 * WHY THIS EXISTS (aug-23). Five artifacts were sitting in the repo when three
 * unrelated gates went red at once: `rel.txt` ("based"), `a.txt` ("x"),
 * `b.txt` ("y"), `round.txt` ("jailed-ok") and `src/x.ts` ("no edit"). Every one
 * is a test FIXTURE by content — `rel.txt` holds exactly the bytes
 * `storage.test.ts` writes — landed at the repo root, which is where a bare
 * relative path resolves when a write API is given no base directory.
 *
 * The culprit was never identified, and this guard does not need it to be.
 * Measured after the cleanup: a full `bun test tests/unit` (37k tests) and
 * `bun test tests/integration` (3.1k tests) each reproduce NONE of them, so
 * whatever wrote them ran under conditions those two do not cover — a killed
 * run, a different cwd, or an ad-hoc invocation. That is precisely why the
 * check is a live guard rather than a fix to one test: it names whoever does it
 * next, on the run that does it.
 *
 * What made it expensive was that the damage landed nowhere near the tests that
 * caused it:
 *
 *   - `src/x.ts` is not valid TypeScript, so `typecheck:all` failed with
 *     TS1434 and `lint` reported two errors — in a file no commit contains.
 *   - `lint:debt` is a CLOSED universe, so the one unpinned `format` diagnostic
 *     from that file failed the whole gate.
 *   - `storage.test.ts` asserts a relative name does NOT resolve under
 *     `process.cwd()`. A previous run leaking `rel.txt` makes that assertion
 *     fail — the suite POISONS ITSELF, deterministically, with no ordering or
 *     load involved.
 *
 * None of it is visible in `git log`: the files are untracked, so `origin/main`
 * is fine and only the working tree is broken. That is precisely the shape a
 * ratchet has to catch, because code review cannot.
 *
 * ## Why a DELTA and not a tree assertion
 *
 * `_arch/repo-index-hygiene` deliberately reads the git INDEX rather than the
 * filesystem, because a developer's scratch file must never fail CI. That
 * argument is right, and it is exactly why this guard cannot assert "the tree is
 * clean": on this repo the tree is never clean.
 *
 * So it measures a DIFFERENCE instead. It snapshots the untracked set, runs the
 * command, snapshots again, and fails on paths that appeared IN BETWEEN. Scratch
 * files that already existed are invisible to it, and no allowlist has to
 * enumerate them.
 *
 * ## Honest limitations
 *
 *   - A path both created AND deleted inside the run is invisible. That is a
 *     clean test, so it is the correct answer.
 *   - On a shared checkout, another process creating a file during the run is
 *     attributed to the run. This is not theoretical: it happened on BOTH
 *     measurement runs above, each time a concurrent session adding a new
 *     `*-hellgate.test.ts`. It is also why the failure prints the byte size and
 *     a content preview of every offender — both times the preview identified
 *     the file as someone's new test in one line. In CI, where the checkout is
 *     clean and single-writer, the case cannot arise.
 *   - It says nothing about writes to tracked files, or to `$HOME`, or to
 *     `/tmp`. The `/tmp` variant of this leak has its own history.
 *
 * Usage:
 *   bun run tools/dev/worktree-pollution-guard.ts -- <command> [args...]
 *   bun run test:pollution                       # the unit suite, guarded
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runBoundedCapture, runBoundedChild } from "./bounded-child"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const allowlistPath = join(repoRoot, "tools/dev/worktree-pollution-allowlist.json")

type Allowlist = {
  readonly note?: string
  /** Paths a guarded run is PERMITTED to create, each with a reason. */
  readonly allowed: Readonly<Record<string, string>>
}

/**
 * The untracked paths git reports, as a set. `-uall` expands directories to
 * their files so a leaked directory names its contents rather than itself;
 * `-z` keeps paths with spaces or unicode intact (git would otherwise quote and
 * escape them, and the quoted form would not compare equal across snapshots).
 */
export const parseUntracked = (nulSeparated: string): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const entry of nulSeparated.split("\0")) {
    if (entry.length < 4) continue
    // porcelain v1: XY<space>path — untracked is exactly "??".
    if (entry.startsWith("?? ")) out.add(entry.slice(3))
  }
  return out
}

/** Paths present after the run that were not present before it. */
export const appearedDuring = (
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): readonly string[] => [...after].filter((p) => !before.has(p)).sort()

/**
 * How long the baseline `git status` may take.
 *
 * It was unbounded. `git status` is normally milliseconds, but it blocks on
 * `.git/index.lock` while another process holds it, and this repository is
 * routinely worked by concurrent sessions — a contended lock was observed during
 * this campaign. An unbounded sync spawn there wedges the guard, and with it the
 * gate it wraps, with no output at all. Generous enough that a cold status on a
 * large tree is never the reason.
 */
const STATUS_TIMEOUT_MS = 60_000

/**
 * Typed so a HANG is distinguishable from a FAILURE.
 *
 * Both fail closed — without a baseline the guard cannot tell "nothing leaked"
 * from "we never looked" — but they need different messages, because one is
 * "git is broken here" and the other is "something else is holding the lock".
 */
export type StatusFailure =
  | { readonly kind: "exit"; readonly code: number; readonly stderr: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }

export const describeStatusFailure = (failure: StatusFailure): string =>
  failure.kind === "timeout"
    ? `worktree-pollution-guard: \`git status\` did not return within ${failure.timeoutMs}ms. ` +
      "Another process is most likely holding .git/index.lock; the guard cannot take a " +
      "baseline, and no baseline is not the same as no pollution."
    : `worktree-pollution-guard: \`git status\` failed (exit ${failure.code}): ${failure.stderr}`

const snapshot = (): ReadonlySet<string> => {
  // Through the shared primitive rather than a hand-written `timeout:`. This
  // call was already bounded; the guard over these rails now bans the raw form
  // outright, because the same rails carried FIVE unbounded siblings that each
  // looked fine on their own line.
  const proc = runBoundedCapture({
    command: ["git", "status", "--porcelain=v1", "-uall", "-z"],
    cwd: repoRoot,
    timeoutMs: STATUS_TIMEOUT_MS,
  })
  // A timed-out capture reports `exitCode: null` with a signal, which the old
  // `!== 0` check would have blamed on git.
  if (proc.exitCode === null) {
    throw new Error(describeStatusFailure({ kind: "timeout", timeoutMs: STATUS_TIMEOUT_MS }))
  }
  if (proc.exitCode !== 0) {
    throw new Error(
      describeStatusFailure({ kind: "exit", code: proc.exitCode, stderr: proc.stderr.trim() }),
    )
  }
  return parseUntracked(proc.stdout)
}

/** A short, safe preview so a reader can tell a test fixture from real work. */
const describePath = (rel: string): string => {
  const abs = join(repoRoot, rel)
  let size: number
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return `${rel}  (directory)`
    size = st.size
  } catch {
    return `${rel}  (vanished before it could be read)`
  }
  // Read a PREFIX, not the file: a leak is by definition something nobody
  // expected, so its size is unknown and `readFileSync` would pull all of it
  // into memory to show 80 characters. Binary bytes are tolerated — the decoded
  // mojibake still tells a reader "this is not a text fixture".
  let preview = "<unreadable>"
  try {
    const fd = openSync(abs, "r")
    try {
      const buf = Buffer.alloc(Math.min(size, 512))
      const read = readSync(fd, buf, 0, buf.length, 0)
      preview = buf.subarray(0, read).toString("utf8").slice(0, 80).replace(/\s+/g, " ").trim()
    } finally {
      closeSync(fd)
    }
  } catch {
    preview = "<unreadable>"
  }
  return `${rel}  (${size} bytes)  ${preview === "" ? "<empty>" : `"${preview}"`}`
}

// The CLI half. Guarded so the pure predicates above can be imported by their
// paired test without the guard trying to run a command at import time.
if (import.meta.main) {
  const argv = process.argv.slice(2)

  /**
   * Same two liveness bounds as `gate.ts`, and for the same reason: this wrapper
   * is what the gate spawns, so a looser bound here would be the one that
   * actually decides. 12-minute inactivity is the shard runner's measured
   * watchdog; the 4-hour total is a backstop above every legitimate campaign
   * observed here and below the 4.7-hour pathology it exists to end.
   */
  const GUARD_INACTIVITY_MS = 12 * 60_000
  const GUARD_TOTAL_MS = 4 * 60 * 60_000

  const command = argv[0] === "--" ? argv.slice(1) : argv
  if (command.length === 0) {
    console.error("usage: worktree-pollution-guard.ts -- <command> [args...]")
    process.exit(1)
  }

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as Allowlist
  const before = snapshot()

  // Bounded, and through the SAME primitive as the gate runner. This wrapper
  // sits between `gate.ts` and `test:full:ci`, so an unbounded spawn here
  // reinstated exactly the hang the gate's own deadline was added to end — the
  // wrapper would wait forever on a child the gate could no longer see.
  const run = await runBoundedChild({
    cmd: command,
    cwd: repoRoot,
    env: process.env,
    limits: { totalMs: GUARD_TOTAL_MS, inactivityMs: GUARD_INACTIVITY_MS },
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  })
  if (run.status === "timed-out") {
    process.stderr.write(
      `worktree-pollution-guard: child killed on the ${run.deadline ?? "unknown"} deadline ` +
        `after ${Math.round(run.elapsedMs / 1_000)}s\n`,
    )
  }

  const after = snapshot()
  const appeared = appearedDuring(before, after)
  const leaked = appeared.filter((p) => allowlist.allowed[p] === undefined)
  const staleAllowlist = Object.keys(allowlist.allowed).filter((p) => !appeared.includes(p))

  if (leaked.length > 0) {
    console.error(
      `\nWORKTREE POLLUTION — the command created ${leaked.length} untracked path(s) and did not clean them up:\n` +
        leaked.map((p) => `  ${describePath(p)}`).join("\n") +
        "\n\nA test must write under a temp directory it removes, or pass an explicit base\n" +
        "directory to the write API — a bare relative path resolves against the REPO ROOT.\n" +
        "A leaked artifact breaks gates far from the test that wrote it, and a test that\n" +
        "asserts the absence of its own fixture will start failing on the NEXT run.\n" +
        "If a path is genuinely expected, add it to tools/dev/worktree-pollution-allowlist.json\n" +
        "with the reason it must survive the run.",
    )
  }
  if (staleAllowlist.length > 0) {
    console.error(
      `\nSTALE ALLOWLIST — these paths are permitted but were not created by this run:\n` +
        staleAllowlist.map((p) => `  ${p}  — ${allowlist.allowed[p]}`).join("\n") +
        "\nRemove them; the allowlist only goes DOWN.",
    )
  }

  if (leaked.length === 0 && staleAllowlist.length === 0) {
    console.log(
      `worktree-pollution-guard: clean — ${before.size} untracked path(s) before, ${after.size} after, 0 created by the run.`,
    )
  }

  process.exit(leaked.length > 0 || staleAllowlist.length > 0 ? 1 : (run.exitCode ?? 1))
}
