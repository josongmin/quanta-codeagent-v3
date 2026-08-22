/**
 * Hellgate — session-creation git-fingerprint WIRE (ADR-0106/0110 dangling seam).
 *
 * GROUND TRUTH the wiring closes: `SessionMeta` carries `gitSha` / `gitBranch`
 * / `gitOriginUrl` with REAL readers (session-list git badge, session export,
 * rewind confirm). The CAPTURE primitive (`captureGitFingerprint`) and the
 * best-effort wrapper (`wireSessionGitFingerprint`) already exist + are
 * hellgated — but nothing called them at session creation, so in every normal
 * (non-import) session `SessionMeta.gitSha` was ALWAYS `undefined` and those
 * readers showed nothing.
 *
 * `resolveResume` is the surface-agnostic session-mint state machine
 * (`--new-session` and the default auto-mint both allocate a fresh
 * `SessionMeta` here and persist it via `saveSessionById`). This suite asserts
 * that BOTH mint paths populate the fingerprint against a REAL git repo AND
 * persist it to disk (so the store-backed readers see it), and that a NON-git
 * cwd leaves the fields absent without throwing (best-effort preserved).
 *
 * Uses the real `defaultGitRunner` against a tmpdir-init'd repo (mirrors
 * tests/integration/git-observability-composite.test.ts) so the wire is proven
 * end-to-end, not against a stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StructuredLogger } from "@/observability"
import { resolveResume } from "@/runner/orchestrate"
import { loadSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { defaultGitRunner } from "@/tool/git"

const runner = defaultGitRunner

const git = async (args: string[], cwd: string): Promise<void> => {
  const r = await runner.run(args, cwd)
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`)
  }
}

const slog = (): StructuredLogger => new StructuredLogger({ level: "info", sink: () => {} })

describe("resolveResume — session-creation git fingerprint wire (hellgate)", () => {
  let repo: string
  let sessionsDir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(async () => {
    envSnapshot = { ...process.env }
    repo = await mkdtemp(join(tmpdir(), "quanta-resume-git-"))
    sessionsDir = await mkdtemp(join(tmpdir(), "quanta-resume-sessions-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
    // Real git repo with one commit + an origin remote so all three fields
    // are capturable.
    await git(["init", "--quiet", "--initial-branch=main"], repo)
    await git(["config", "user.email", "quanta@test.local"], repo)
    await git(["config", "user.name", "Quanta Test"], repo)
    await git(["config", "commit.gpgsign", "false"], repo)
    await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo)
    await writeFile(join(repo, "README.md"), "init\n")
    await git(["add", "README.md"], repo)
    await git(["commit", "-q", "-m", "init"], repo)
  })

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
    await rm(repo, { recursive: true, force: true })
    await rm(sessionsDir, { recursive: true, force: true })
  })

  test("--new-session in a git repo ⇒ idMeta.gitSha/gitBranch/gitOriginUrl populated", async () => {
    const r = await resolveResume({
      resume: undefined,
      newSession: true,
      title: "T",
      cwd: repo,
      initialSessionId: "init-id",
      slog: slog(),
    })
    expect(r.idMeta).toBeDefined()
    expect(r.idMeta?.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(r.idMeta?.gitBranch).toBe("main")
    expect(r.idMeta?.gitOriginUrl).toBe("git@github.com:org/repo.git")
  })

  test("--new-session persists the fingerprint to disk (store-backed readers see it)", async () => {
    const r = await resolveResume({
      resume: undefined,
      newSession: true,
      title: "T",
      cwd: repo,
      initialSessionId: "init-id",
      slog: slog(),
    })
    const saved = await loadSessionById(r.sessionId)
    expect(saved).toBeDefined()
    // The persisted meta — NOT just the returned object — must carry it, since
    // the list-badge / export / rewind readers load from disk.
    expect(saved?.meta.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(saved?.meta.gitBranch).toBe("main")
    expect(saved?.meta.gitOriginUrl).toBe("git@github.com:org/repo.git")
  })

  test("default auto-mint (no --resume / --new-session) in a git repo ⇒ fingerprint populated", async () => {
    const r = await resolveResume({
      resume: undefined,
      newSession: false,
      title: undefined,
      cwd: repo,
      initialSessionId: "init-id",
      slog: slog(),
    })
    expect(r.idMeta).toBeDefined()
    expect(r.idMeta?.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(r.idMeta?.gitBranch).toBe("main")
    // And it is durable on disk.
    const saved = await loadSessionById(r.sessionId)
    expect(saved?.meta.gitSha).toBe(r.idMeta?.gitSha)
  })

  test("non-git cwd ⇒ fingerprint absent, no throw (best-effort preserved)", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "quanta-resume-nogit-"))
    try {
      const r = await resolveResume({
        resume: undefined,
        newSession: true,
        title: "T",
        cwd: nonRepo,
        initialSessionId: "init-id",
        slog: slog(),
      })
      expect(r.idMeta).toBeDefined()
      expect(r.idMeta?.gitSha).toBeUndefined()
      expect(r.idMeta?.gitBranch).toBeUndefined()
      expect(r.idMeta?.gitOriginUrl).toBeUndefined()
    } finally {
      await rm(nonRepo, { recursive: true, force: true })
    }
  })
})
