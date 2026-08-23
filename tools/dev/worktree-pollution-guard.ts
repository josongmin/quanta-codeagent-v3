/**
 * Worktree-pollution guard — a test suite may not leave files behind.
 *
 * WHY THIS EXISTS (aug-23). Five artifacts were sitting in the repo when three
 * unrelated gates went red at once: `rel.txt` ("based"), `a.txt` ("x"),
 * `b.txt` ("y"), `round.txt` ("jailed-ok") and `src/x.ts` ("no edit"). All five
 * were written by unit tests that passed a RELATIVE path to a write API with no
 * base directory, so the path resolved against `process.cwd()` — the repo root.
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
 *     attributed to the run. That is why the failure prints the byte size and a
 *     content preview of every offender: attribution is the reader's, and the
 *     preview is normally enough to tell a fixture from a colleague's edit.
 *   - It says nothing about writes to tracked files, or to `$HOME`, or to
 *     `/tmp`. The `/tmp` variant of this leak has its own history.
 *
 * Usage:
 *   bun run tools/dev/worktree-pollution-guard.ts -- <command> [args...]
 *   bun run test:pollution                       # the unit suite, guarded
 */

import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

const snapshot = (): ReadonlySet<string> => {
  const proc = Bun.spawnSync(["git", "status", "--porcelain=v1", "-uall", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    // Fail CLOSED: without a baseline the guard cannot distinguish "nothing
    // leaked" from "we never looked", and the second must not read as a pass.
    throw new Error(
      `worktree-pollution-guard: \`git status\` failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    )
  }
  return parseUntracked(proc.stdout.toString())
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
  let preview = ""
  try {
    preview = readFileSync(abs, "utf8").slice(0, 80).replace(/\s+/g, " ").trim()
  } catch {
    preview = "<unreadable>"
  }
  return `${rel}  (${size} bytes)  ${preview === "" ? "<empty>" : `"${preview}"`}`
}

// The CLI half. Guarded so the pure predicates above can be imported by their
// paired test without the guard trying to run a command at import time.
if (import.meta.main) {
  const argv = process.argv.slice(2)
  const command = argv[0] === "--" ? argv.slice(1) : argv
  if (command.length === 0) {
    console.error("usage: worktree-pollution-guard.ts -- <command> [args...]")
    process.exit(1)
  }

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as Allowlist
  const before = snapshot()

  const run = Bun.spawnSync(command, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" })

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
