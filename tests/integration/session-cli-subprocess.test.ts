import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSessionById, saveSessionById } from "@/session/store"
import type { SavedSession, SavePayload, SessionMeta } from "@/session/types"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { bunEntryArgv } from "../_helpers/repo-root"

/**
 * HARD subprocess-spawn e2e for the session CLI. Public routing canaries use
 * `index.ts`; command-lifecycle cases use the focused production session entry.
 *
 * Spawns `bun src/apps/cli/index.ts <args>` and asserts exit codes, stdout/
 * stderr, and filesystem side-effects. Closes audit-coverage gaps for
 * `main()`-only branches that the in-process dispatcher cannot reach:
 *
 *   - HIGH-4  cwd-honor-on-resume (process.chdir is global; subprocess-only)
 *   - HIGH-5  conflict error printed via stderr + exit 1 path
 *   - MEDIUM-10 top-level `--help` / `-h` routed BEFORE prompt forwarding
 *   - `--resume <missing-id>` clean error
 *   - `session` subcommand routing through the real binary (argv parse)
 *   - missing-cwd error path after `fork --worktree` → `rm -rf worktree`
 *
 * Critical: every test must short-circuit BEFORE the LLM is invoked. The
 * binary is given a dummy `ANTHROPIC_API_KEY=test` so `buildLLM` doesn't
 * throw, but every code path here exits before any LLM call:
 *   - `--help`/`-h` exits in main() before agent setup
 *   - conflict / missing-id exits in resolveResume's caller
 *   - `session …` subcommand returns before the REPL
 *   - missing-cwd exits inside switchToSessionCwd
 *
 * No production code is modified by this suite. The binary is spawned with
 * `cwd` set to a tmpdir so the repo's `.env.dev` (which carries a real
 * OPENAI_API_KEY) is NOT picked up by `loadEnvFiles`.
 */

// Entries are resolved from THIS file's location by walking up to the
// repository marker (tests/_helpers/repo-root.ts), never from a hard-coded
// checkout path: `Bun.spawn(["bun", <missing path>, …])` exits non-zero with a
// message on stderr, which is the same observable shape several cases below
// assert as their PASS. The entries below are repository-RELATIVE; the argv
// is built (and existence-checked) by `bunEntryArgv`, so a moved entrypoint
// fails as a moved entrypoint instead of as a plausible CLI error.
const CLI_ENTRY = "src/apps/cli/index.ts"
const SESSION_ENTRY = "src/apps/cli/session-command-entry.ts"
const TEST_TIMEOUT_MS = 15_000

interface RunResult {
  exit: number
  out: string
  err: string
}

interface RunOpts {
  env?: Record<string, string>
  cwd?: string
}

const runGit = async (
  args: readonly string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runGit(["--version"])
    return r.exitCode === 0
  } catch {
    return false
  }
}

const HAS_GIT = await gitAvailable()

/**
 * Run the CLI binary as a subprocess. Defaults:
 *   - stdin "ignore"     so any accidental REPL prompt sees EOF immediately
 *   - cwd  isolatedTmp   so the repo's `.env.dev` is NOT autoloaded by
 *                        `loadEnvFiles` (which resolves relative to cwd).
 *   - ANTHROPIC_API_KEY=test   dummy key so `buildLLM` doesn't throw before
 *                              we reach the branch under test. NO LLM call is
 *                              actually made by any test in this suite.
 *   - QUANTA_PROVIDER=anthropic   pin provider so the subprocess doesn't try
 *                                 to fall back to OPENAI based on env.
 */
const runCli = async (
  args: string[],
  opts: RunOpts = {},
  isolatedCwd?: string,
  entry = CLI_ENTRY,
): Promise<RunResult> => {
  const cwd = opts.cwd ?? isolatedCwd ?? mkdtempSync(join(tmpdir(), "cli-sub-cwd-"))
  // Build a clean env: PATH + HOME + the test-controlled keys. Explicitly
  // drop the parent process's real ANTHROPIC_API_KEY / OPENAI_API_KEY so a
  // dev machine with live keys can't accidentally let the binary reach an
  // LLM client construction path that succeeds + then hangs awaiting input.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    // The child CLI resolves its memory store and stage1 WAL under the Quanta home. This
    // clean env rebuilt everything but HOME, so the child wrote the developer's real
    // `~/.quanta/memory` (measured: 35 entries, including a git repo). Carry the fenced
    // roots the preload set.
    ...(process.env.QUANTA_HOME !== undefined ? { QUANTA_HOME: process.env.QUANTA_HOME } : {}),
    ...(process.env.QUANTA_PREFS_HOME !== undefined
      ? { QUANTA_PREFS_HOME: process.env.QUANTA_PREFS_HOME }
      : {}),
    QUANTA_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test",
    ...opts.env,
  }
  const proc = Bun.spawn({
    cmd: [...bunEntryArgv(entry, args)],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, out, err }
}

const runFocusedSessionCli = (
  args: string[],
  opts: RunOpts = {},
  isolatedCwd?: string,
): Promise<RunResult> => runCli(args, opts, isolatedCwd, SESSION_ENTRY)

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "cli-sub-repo-"))
  await runGit(["init", "-q"], dir)
  await writeFile(join(dir, "README.md"), "hello\n")
  await runGit(["add", "-A"], dir)
  await runGit(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init"], dir)
  return dir
}

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = Date.now()
  return {
    id: overrides.id ?? "sub-1",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
  }
}

const mkPayload = (): SavePayload => ({
  reason: "completed",
  turns: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
})

describe("session CLI — subprocess e2e", () => {
  let sessionsDir: string
  let workCwd: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), "cli-sub-sessions-"))
    workCwd = mkdtempSync(join(tmpdir(), "cli-sub-cwd-"))
    // The in-process pre-seeding code path (saveSessionById) reads this env
    // var the same way the subprocess does — so we set it in BOTH places.
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(workCwd, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test(
    "T1 — `--help` exits 0 with usage text on stdout",
    async () => {
      const r = await runCli(["--help"], { env: { QUANTA_SESSIONS_DIR: sessionsDir } }, workCwd)
      expect(r.exit).toBe(0)
      expect(r.out).toContain("Usage:")
      expect(r.out).toContain("quanta session")
      expect(r.out).toContain("--new-session")
      expect(r.out).toContain("--resume")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T2 — `-h` produces the canonical usage block",
    async () => {
      // T1 already proves the `--help` process boundary. Re-spawning it here
      // doubled cold CLI startup without increasing alias coverage.
      const r = await runCli(["-h"], { env: { QUANTA_SESSIONS_DIR: sessionsDir } }, workCwd)
      expect(r.exit).toBe(0)
      expect(r.out).toContain("Usage:")
      expect(r.out).toContain("quanta session")
      expect(r.out).toContain("--new-session")
      expect(r.out).toContain("--resume")
      expect(r.err).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T3 — `--new-session --resume <id>` prints conflict error + exit 1",
    async () => {
      const r = await runCli(
        ["--new-session", "--resume", "abc-xyz"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(1)
      expect(r.err).toContain("cannot combine --new-session with --resume")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T4 — `--resume <missing-id>` prints a clean not-found error + exit 1",
    async () => {
      const missingId = "definitely-not-a-real-session-id-xyz"
      const r = await runCli(
        ["--resume", missingId],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(1)
      expect(r.err).toContain("not found")
      expect(r.err).toContain(missingId)
      // The "quanta ready" line is deliberately NOT emitted on the id-mode
      // path until the session loads, so it must not appear here. (Note:
      // logger.* writes to stderr in this codebase — we still assert stdout
      // is clean because the task contract said so, and because no human-
      // readable "ready" goes to stdout regardless.)
      expect(r.out).not.toContain("quanta ready")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T5 — `session ls` on empty store exits 0 with `(no sessions)`",
    async () => {
      const r = await runCli(
        ["session", "ls"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain("(no sessions)")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T6 — `session ls --ids` on empty store exits 0 with empty stdout",
    async () => {
      const r = await runFocusedSessionCli(
        ["ls", "--ids"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(0)
      expect(r.out.trim()).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T7 — pre-seed via library + spawn `session ls --json` reads the SAME store",
    async () => {
      // Pre-seed an id via the in-process API. Because we set
      // process.env.QUANTA_SESSIONS_DIR in beforeEach AND pass the same env
      // to the subprocess, both halves read/write the same disk rail. This
      // is the round-trip that proves the binary's argv parsing matches the
      // in-process dispatcher byte-for-byte.
      const id = "rt-1"
      await saveSessionById(mkMeta({ id, title: "RoundTrip" }), mkPayload())

      const r = await runCli(
        ["session", "ls", "--json"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(0)
      const arr = JSON.parse(r.out) as SessionMeta[]
      expect(arr.map((m) => m.id)).toContain(id)
      expect(arr.find((m) => m.id === id)?.title).toBe("RoundTrip")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T8 — `session show <id> --json` round-trip via subprocess",
    async () => {
      const id = "rt-show"
      await saveSessionById(mkMeta({ id, title: "ShowMe" }), mkPayload())
      const r = await runFocusedSessionCli(
        ["show", id, "--json"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(0)
      const parsed = JSON.parse(r.out) as SavedSession
      expect(parsed.version).toBe(2)
      expect(parsed.meta.id).toBe(id)
      expect(parsed.meta.title).toBe("ShowMe")
      expect(parsed.messages.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!HAS_GIT)(
    "T9 — `--resume <id>` after worktree dir removed exits 1 with `Session cwd missing`",
    async () => {
      const repoDir = await makeRepo()
      try {
        // 1. Pre-seed a source session pointing at the repo.
        const srcId = "wt-src-resume"
        await saveSessionById(mkMeta({ id: srcId, title: "WTSrc", cwd: repoDir }), mkPayload())

        // 2. Create a worktree-backed fork through the focused production
        //    dispatcher entry. Public session routing is pinned by T5/T7.
        const fork = await runFocusedSessionCli(
          ["fork", srcId, "--worktree"],
          { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
          workCwd,
        )
        expect(fork.exit).toBe(0)
        const m = fork.out.match(/forked \S+ → (\S+)/)
        const forkId = m?.[1] ?? ""
        expect(forkId).not.toBe("")

        // 3. Locate the worktree path (via the library — same disk rail) and
        //    remove it.
        const forked = await loadSessionById(forkId)
        const wtPath = forked?.meta.cwd ?? ""
        expect(wtPath.startsWith(`${repoDir}/.quanta/worktrees/`)).toBe(true)
        expect(existsSync(wtPath)).toBe(true)
        rmSync(wtPath, { recursive: true, force: true })
        expect(existsSync(wtPath)).toBe(false)

        // 4. `quanta --resume <forkId>` must detect the missing cwd and exit 1.
        const r = await runCli(
          ["--resume", forkId],
          { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
          workCwd,
        )
        expect(r.exit).toBe(1)
        expect(r.err).toContain("Session cwd missing")
        expect(r.err).toContain(wtPath)
        // Defense: the binary must NOT have continued past the cwd-missing
        // check into the agent loop. The id-mode "quanta ready" log includes
        // the session id and is emitted AFTER the chdir — its absence proves
        // we exited at the guard.
        expect(r.err).not.toContain(`session=${forkId}`)
      } finally {
        rmSync(repoDir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "T10 — `session delete <forkId> --force` via subprocess removes worktree + branch",
    async () => {
      const repoDir = await makeRepo()
      try {
        const srcId = "wt-src-del"
        await saveSessionById(mkMeta({ id: srcId, title: "WTSrcDel", cwd: repoDir }), mkPayload())
        const fork = await runFocusedSessionCli(
          ["fork", srcId, "--worktree"],
          { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
          workCwd,
        )
        expect(fork.exit).toBe(0)
        const m = fork.out.match(/forked \S+ → (\S+)/)
        const forkId = m?.[1] ?? ""
        expect(forkId).not.toBe("")

        const forked = await loadSessionById(forkId)
        const wtPath = forked?.meta.cwd ?? ""
        expect(existsSync(wtPath)).toBe(true)
        const safeSeg = wtPath.split("/").pop() ?? ""

        // Now: subprocess delete --force.
        const r = await runFocusedSessionCli(
          ["delete", forkId, "--force"],
          { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
          workCwd,
        )
        expect(r.exit).toBe(0)
        expect(r.out).toContain("removed worktree:")
        expect(r.out).toContain(`deleted ${forkId}`)
        // Worktree dir + branch should be gone.
        expect(existsSync(wtPath)).toBe(false)
        const branches = await runGit(["branch", "-a"], repoDir)
        expect(branches.stdout).not.toContain(`fork-${safeSeg}`)
      } finally {
        rmSync(repoDir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test(
    "T11 — `--help` wins even when extra positional junk follows (no LLM prompt assembly)",
    async () => {
      const r = await runCli(
        ["--help", "unrelated", "extra", "junk"],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain("Usage:")
      // The junk MUST NOT leak anywhere observable. The help routing is
      // unconditional ahead of argvPrompt() so no prompt is ever built.
      expect(r.out).not.toContain("unrelated extra junk")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T13 — (D3) `--resume <corrupt.json>` exits 1 with the named `fatal: session state file <path>:` message",
    async () => {
      // jun-10 audit D3 — a corrupt EXISTING path-mode resume file must NOT
      // silently reset the transcript (and then let the next save destroy it).
      // `loadSession` throws a typed `SessionStateLoadError` naming the file; it
      // propagates RAW (not a SessionBootstrapError) to the CLI's top-level
      // `main().catch`, which prints `fatal: <message>` via the shared logger
      // (stderr) and exits 1. This is the end-to-end exit CONTRACT — the highest
      // reachable seam (the real binary), not an in-process assertion.
      const corrupt = join(workCwd, "corrupt-resume.json")
      await writeFile(corrupt, "{this is not valid json")
      // Path-like token (ends in `.json` AND absolute) ⇒ PATH MODE ⇒ loadSession.
      const r = await runCli(
        ["--resume", corrupt],
        { env: { QUANTA_SESSIONS_DIR: sessionsDir } },
        workCwd,
      )
      expect(r.exit).toBe(1)
      // The named, file-identifying message — the whole point of throwing loudly
      // instead of returning null. `errMessage` preserves the Error's message,
      // which always starts `session state file <path>: …`.
      expect(r.err).toContain(`session state file ${corrupt}:`)
      // It is a FATAL load failure (printed via the generic `fatal:` branch), and
      // the agent loop is never reached (no "quanta ready" on stdout).
      expect(r.err).toContain("fatal:")
      expect(r.out).not.toContain("quanta ready")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T12 — `quanta` with stdin closed (no args) exits cleanly without invoking LLM",
    async () => {
      // The REPL's `rl.question` reads from process.stdin. With stdin=ignore
      // the readline interface receives EOF on the input stream; Node's
      // promises-flavored `rl.question` rejects with a `Closed`/`AbortError`
      // when the underlying stream ends. The binary's top-level
      // `main().catch(...)` then prints `fatal: …` and exits 1.
      //
      // We accept either outcome (0 from a clean break, or 1 from the EOF
      // rejection) — both prove the binary did NOT reach the LLM (which
      // would hang). The hard requirement is: the process MUST exit within
      // the test timeout AND must not have invoked any LLM.
      const r = await runCli([], { env: { QUANTA_SESSIONS_DIR: sessionsDir } }, workCwd)
      expect([0, 1]).toContain(r.exit)
      // No agent-stream output (no tool calls, no model text). The only
      // possible stdout in this branch is empty.
      expect(r.out).toBe("")
    },
    TEST_TIMEOUT_MS,
  )
})
