/**
 * ticket-11 (P8) — git-worktree AGENT tools unit hellgate.
 *
 * Seals:
 *   A. cwd-override / edit-fence PURE logic (resolveBashCwd / resolveEditBase)
 *      — incl. the red-on-injection INVARIANT: relative → worktree, ABSOLUTE →
 *      session jail (NEVER re-jailed to the worktree).
 *   B. enter_worktree — sets the slot, branchFrom selection, duplicate-enter
 *      refusal, not-wired degrade.
 *   C. exit_worktree — clean auto-remove + slot clear; DIRTY guard (refuse +
 *      list uncommitted) unless force:true.
 *   D. worktree_status — reports path/branch/persistent/branchFrom + uncommitted
 *      count; "no active worktree" when empty.
 *
 * Real `git` + real tmpdir repos (no mocks for the worktree core — these tools
 * are thin over `@/runtime`).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ActiveWorktree, ToolContext, ToolEvent, ToolResult, WorktreeSlotHandle } from "@/tool"
import {
  enterWorktreeTool,
  exitWorktreeTool,
  makeExitWorktreeTool,
  WORKTREE_TOOL_NAMES,
  worktreeStatusTool,
} from "@/tool/worktree"
import { resolveBashCwd, resolveEditBase } from "@/tool/worktree/cwd-override"

const tmpRepos: string[] = []

/** Create a real git repo with one commit. */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wt-tool-"))
  tmpRepos.push(dir)
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir })
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "t@t.t"])
  git(["config", "user.name", "t"])
  await writeFile(path.join(dir, "seed.txt"), "seed\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "seed"])
  return dir
}

/** In-memory slot mirroring `createWorktreeSlot` (the producer). */
const makeSlot = (repoRoot: string, sessionCwd: string): WorktreeSlotHandle => {
  let active: ActiveWorktree | undefined
  return {
    current: () => active,
    set: (v) => {
      active = v
    },
    clear: () => {
      active = undefined
    },
    repoRoot,
    sessionCwd,
  }
}

const ctx = (slot?: WorktreeSlotHandle): ToolContext => ({
  cwd: slot?.sessionCwd ?? process.cwd(),
  signal: new AbortController().signal,
  ...(slot !== undefined ? { worktreeSlot: slot } : {}),
})

const drain = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

afterAll(async () => {
  for (const d of tmpRepos) await rm(d, { recursive: true, force: true }).catch(() => undefined)
})

/* ------------------------------------------------------------------ */
/* A. cwd-override / edit-fence PURE (the security invariant)          */
/* ------------------------------------------------------------------ */
describe("A. resolveBashCwd — spawn cwd override", () => {
  test("no active worktree ⇒ session cwd (byte-identical)", () => {
    expect(resolveBashCwd("/repo", undefined)).toBe("/repo")
  })
  test("active worktree ⇒ the worktree dir", () => {
    const active: ActiveWorktree = {
      worktreePath: "/repo/.quanta/worktrees/wt",
      branch: "fork-wt",
      isPersistent: true,
      repoRoot: "/repo",
      branchFrom: "head",
    }
    expect(resolveBashCwd("/repo", active)).toBe("/repo/.quanta/worktrees/wt")
  })
})

describe("A. resolveEditBase — relative→worktree, absolute→session jail", () => {
  const wt = "/repo/.quanta/worktrees/wt"
  const active: ActiveWorktree = {
    worktreePath: wt,
    branch: "fork-wt",
    isPersistent: true,
    repoRoot: "/repo",
    branchFrom: "head",
  }

  test("no active worktree ⇒ {raw, sessionCwd} (byte-identical legacy)", () => {
    expect(resolveEditBase("src/x.ts", "/repo", undefined)).toEqual({
      path: "src/x.ts",
      base: "/repo",
    })
    expect(resolveEditBase("/abs/y.ts", "/repo", undefined)).toEqual({
      path: "/abs/y.ts",
      base: "/repo",
    })
  })

  test("RELATIVE path resolves against the WORKTREE (base stays session)", () => {
    const r = resolveEditBase("rel.txt", "/repo", active)
    // pre-joined into the worktree dir, jail base stays the SESSION root.
    expect(r.path).toBe(path.resolve(wt, "rel.txt"))
    expect(r.path.startsWith(wt)).toBe(true)
    expect(r.base).toBe("/repo")
  })

  // RED-ON-INJECTION: the worktree is a relative-cwd override, NOT a trust-
  // boundary redefinition. An ABSOLUTE path must NOT be re-based onto the
  // worktree and must keep the SESSION jail. If a future refactor "simplifies"
  // the override to `base = worktree` for everything, this assertion goes RED.
  test("ABSOLUTE path is NOT re-jailed to the worktree (session jail invariant)", () => {
    const r = resolveEditBase("/repo/src/x.ts", "/repo", active)
    expect(r.path).toBe("/repo/src/x.ts") // unchanged
    expect(r.base).toBe("/repo") // SESSION jail, never the worktree
    // the absolute path must NOT have been forced under the worktree dir.
    expect(r.path.startsWith(wt)).toBe(false)
  })

  test("ABSOLUTE path outside the worktree still uses the session jail base", () => {
    // A legal absolute write into the session tree but OUTSIDE the worktree
    // must jail to the session root (so the storage port admits it), NOT the
    // worktree (which would wrongly reject it).
    const r = resolveEditBase("/repo/docs/readme.md", "/repo", active)
    expect(r.base).toBe("/repo")
    expect(r.path).toBe("/repo/docs/readme.md")
  })
})

/* ------------------------------------------------------------------ */
/* B. enter_worktree                                                   */
/* ------------------------------------------------------------------ */
describe("B. enter_worktree", () => {
  let repo = ""
  let slot: WorktreeSlotHandle
  beforeEach(async () => {
    repo = await makeRepo()
    slot = makeSlot(repo, repo)
  })

  test("enter sets the slot to the created worktree (head default)", async () => {
    const r = await drain(enterWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    const cur = slot.current()
    expect(cur).toBeDefined()
    expect(cur?.repoRoot).toBe(repo)
    expect(cur?.branchFrom).toBe("head")
    // §11 — the agent-tool enter creates a THROWAWAY worktree (auto-removed on
    // clean exit), so isPersistent is false.
    expect(cur?.isPersistent).toBe(false)
    expect(existsSync(cur?.worktreePath ?? "")).toBe(true)
  })

  test("branchFrom selection is recorded on the slot (head)", async () => {
    await drain(enterWorktreeTool, { branchFrom: "head" }, ctx(slot))
    expect(slot.current()?.branchFrom).toBe("head")
  })

  test("branchFrom:fresh enters + records 'fresh' (degrades to HEAD with no remote)", async () => {
    // No `origin` remote in the tmp repo ⇒ resolveFreshBaseRef falls back to HEAD
    // deterministically (never errors). The slot records the REQUESTED branchFrom.
    const r = await drain(enterWorktreeTool, { branchFrom: "fresh" }, ctx(slot))
    expect(r.ok).toBe(true)
    expect(slot.current()?.branchFrom).toBe("fresh")
    expect(existsSync(slot.current()?.worktreePath ?? "")).toBe(true)
  })

  // ── ticket-11 finding #6: branchFrom:'fresh' resolves origin/<default> ───────
  // Exercises `resolveFreshBaseRef` end-to-end (dead from the suite before this):
  // with a bare `origin` whose default branch is AHEAD of local HEAD, a
  // branchFrom:'fresh' enter must base the worktree on origin/<default>, NOT the
  // (behind) local HEAD.
  test("branchFrom:fresh bases the worktree on origin/<default>, not local HEAD", async () => {
    const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd }).toString().trim()
    const localHead = git(["rev-parse", "HEAD"])
    // Bare origin from the repo's current state, wired as `origin` + origin/HEAD.
    const origin = await mkdtemp(path.join(tmpdir(), "wt-origin-"))
    tmpRepos.push(origin)
    execFileSync("git", ["clone", "-q", "--bare", repo, origin])
    git(["remote", "add", "origin", origin])
    // Advance origin's default branch ONE commit AHEAD of local HEAD, then point
    // origin/HEAD at it so resolveFreshBaseRef's symbolic-ref lookup resolves.
    await writeFile(path.join(repo, "ahead.txt"), "ahead-of-local\n")
    git(["add", "ahead.txt"])
    git(["commit", "-q", "-m", "ahead"])
    const aheadCommit = git(["rev-parse", "HEAD"])
    git(["push", "-q", "origin", "main"])
    // Move LOCAL HEAD back to the original commit (local is now BEHIND origin).
    git(["reset", "-q", "--hard", localHead])
    git(["fetch", "-q", "origin"])
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: repo,
    })
    expect(git(["rev-parse", "HEAD"])).toBe(localHead) // local really is behind

    const r = await drain(enterWorktreeTool, { branchFrom: "fresh" }, ctx(slot))
    expect(r.ok).toBe(true)
    const wtPath = slot.current()?.worktreePath ?? ""
    const wtTip = git(["rev-parse", "HEAD"], wtPath)
    // The worktree was forked from origin/main (ahead), NOT local HEAD (behind).
    expect(wtTip).toBe(aheadCommit)
    expect(wtTip).not.toBe(localHead)
  })

  test('duplicate enter without exit ⇒ error ("exit first")', async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const r = await drain(enterWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "worktree_already_active" })
    expect(r.output.toLowerCase()).toContain("exit_worktree first")
  })

  test("not-wired (no slot) ⇒ typed not_wired failure", async () => {
    const r = await drain(enterWorktreeTool, {}, ctx(undefined))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "not_wired" })
  })

  // ── ticket-11 finding #2: crash-recovery reconcile ──────────────────────────
  // The fixed-id worktree (`agent-worktree` / branch `fork-agent-worktree`) can
  // be left on disk by a crash (the slot is in-memory only, so the
  // duplicate-guard does NOT see it). A fresh session then collides on
  // `git worktree add` ("already used by worktree"). enter must best-effort
  // reconcile the leftover at the fixed path/branch first, so a crashed session
  // is recoverable WITHOUT manual `git worktree prune`.
  test("recovers from a LEFTOVER worktree at the fixed path/branch (crash reconcile)", async () => {
    const fixedPath = path.join(repo, ".quanta", "worktrees", "agent-worktree")
    // Simulate the post-crash leftover: a real worktree registered at the exact
    // fixed path + branch the agent tool will try to (re)create.
    execFileSync(
      "git",
      ["worktree", "add", "--no-track", "-B", "fork-agent-worktree", "--", fixedPath, "HEAD"],
      { cwd: repo },
    )
    expect(existsSync(fixedPath)).toBe(true)
    // Fresh slot (the crashed session's in-memory slot is gone): the
    // duplicate-guard sees an EMPTY slot, so enter proceeds to createPersistent.
    const r = await drain(enterWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(slot.current()?.worktreePath).toBe(fixedPath)
    expect(existsSync(fixedPath)).toBe(true)
  })

  test("non-git repoRoot ⇒ typed not_a_git_repo failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wt-nogit-"))
    tmpRepos.push(dir)
    const s = makeSlot(dir, dir)
    const r = await drain(enterWorktreeTool, {}, ctx(s))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "not_a_git_repo" })
  })

  // ── ticket-11 R4-5 finding #5: a crash-leftover's uncommitted work is force- ──
  // discarded by the reconcile. The discard still happens (the leftover path is
  // OURS, deterministically), but it must NOT be SILENT — enter surfaces the
  // discarded file list so the operator can see what crash-leftover work was
  // dropped (observability, not a refusal — a fresh enter must still succeed).
  test("reconcile of a DIRTY crash-leftover surfaces the discarded files in the enter result", async () => {
    const fixedPath = path.join(repo, ".quanta", "worktrees", "agent-worktree")
    // Crash leftover: a real worktree at the fixed path with UNCOMMITTED work.
    execFileSync(
      "git",
      ["worktree", "add", "--no-track", "-B", "fork-agent-worktree", "--", fixedPath, "HEAD"],
      { cwd: repo },
    )
    await writeFile(path.join(fixedPath, "crash-leftover.txt"), "uncommitted crash work\n")
    const r = await drain(enterWorktreeTool, {}, ctx(slot))
    // Fresh enter still SUCCEEDS (reconcile + recreate), but the discarded work is
    // now VISIBLE — not silently dropped.
    expect(r.ok).toBe(true)
    expect(r.output).toContain("crash-leftover.txt")
    expect(r.output.toLowerCase()).toContain("discard")
  })
})

/* ------------------------------------------------------------------ */
/* C. exit_worktree                                                    */
/* ------------------------------------------------------------------ */
describe("C. exit_worktree", () => {
  let repo = ""
  let slot: WorktreeSlotHandle
  beforeEach(async () => {
    repo = await makeRepo()
    slot = makeSlot(repo, repo)
  })

  test("clean exit removes the worktree + clears the slot", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    expect(existsSync(wtPath)).toBe(true)
    const r = await drain(exitWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(slot.current()).toBeUndefined()
    expect(existsSync(wtPath)).toBe(false)
  })

  test("DIRTY exit refuses by default and LISTS uncommitted files", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    await writeFile(path.join(wtPath, "dirty.txt"), "uncommitted\n")
    const r = await drain(exitWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "worktree_dirty" })
    expect(r.output).toContain("dirty.txt") // the uncommitted file is listed
    // GUARD: the slot is NOT cleared and the worktree is NOT removed on refuse.
    expect(slot.current()).toBeDefined()
    expect(existsSync(wtPath)).toBe(true)
  })

  test("DIRTY exit with force:true discards + clears the slot", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    await writeFile(path.join(wtPath, "dirty.txt"), "uncommitted\n")
    const r = await drain(exitWorktreeTool, { force: true }, ctx(slot))
    expect(r.ok).toBe(true)
    expect(slot.current()).toBeUndefined()
    expect(existsSync(wtPath)).toBe(false)
  })

  test("PERSISTENT worktree is KEPT on exit (only the slot is cleared)", async () => {
    // A persistent worktree (host-orchestrated fork) is never removed by exit —
    // even when clean. Set the slot directly to a persistent value over a real
    // worktree dir, then exit: the dir must survive and the slot must clear.
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    const cur = slot.current()
    if (cur === undefined) throw new Error("expected active")
    slot.set({ ...cur, isPersistent: true }) // mark persistent
    const r = await drain(exitWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(r.output.toLowerCase()).toContain("kept")
    expect(slot.current()).toBeUndefined() // slot cleared
    expect(existsSync(wtPath)).toBe(true) // worktree KEPT
  })

  test("exit with no active worktree ⇒ typed no_active_worktree failure", async () => {
    const r = await drain(exitWorktreeTool, {}, ctx(slot))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "no_active_worktree" })
  })

  test("not-wired (no slot) ⇒ typed not_wired failure", async () => {
    const r = await drain(exitWorktreeTool, {}, ctx(undefined))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "not_wired" })
  })

  // ── ticket-11 finding #4: removeWorktree failure must surface a TYPED failure ──
  // Pre-fix, exit cleared the slot + reported ok:true even when removeWorktree
  // returned false — leaving the EXACT wedging state (a registered worktree on
  // disk + a fresh session that collides). The remove FAILURE must yield ok:false
  // {mode:'rejected', reason:'worktree_cleanup_failed'} and NOT silently clear+ok.
  test("removeWorktree FAILURE ⇒ ok:false typed worktree_cleanup_failed (no silent clear)", async () => {
    // Inject a clean (CLEAN-exit path) worktree but force the remover to fail.
    const failingExit = makeExitWorktreeTool({
      removeWorktree: async () => false,
    })
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    const r = await drain(failingExit, {}, ctx(slot))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "worktree_cleanup_failed" })
    // The slot is NOT cleared (the session is still "inside" the worktree, so it
    // can retry) and the on-disk worktree still exists (injected remover no-op'd).
    expect(slot.current()).toBeDefined()
    expect(existsSync(wtPath)).toBe(true)
  })

  test("default exit tool uses the real removeWorktree (factory default is the CORE)", async () => {
    // The exported `exitWorktreeTool` must equal a factory build with no override
    // — i.e. the default remover IS the real `@/runtime` removeWorktree, so the
    // clean-exit path still removes the worktree for real.
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    const r = await drain(makeExitWorktreeTool(), {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(existsSync(wtPath)).toBe(false)
  })

  // ── ticket-11 R4-5 finding #1: a VANISHED worktree dir must not wedge the slot ──
  // `runShell` (Bun.spawn) THROWS when cwd does not exist. uncommittedCount /
  // uncommittedList only degrade on a non-zero exit, never on a throw → the throw
  // escapes execute(), the slot is never cleared, and the session is PERMANENTLY
  // wedged "inside" a worktree that no longer exists (the R1-3 cleanup-failed
  // branch is unreachable — the throw precedes removeWorktree). After the fix the
  // missing dir reads as "not dirty" and exit proceeds to the idempotent
  // removeWorktree + clears the slot.
  test("exit_worktree with the worktree DIR VANISHED ⇒ no throw, slot cleared (ok:true)", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    expect(wtPath.length).toBeGreaterThan(0)
    // The active worktree dir disappears out from under us (external rm / a crash
    // that removed the dir but not the in-memory slot).
    rmSync(wtPath, { recursive: true, force: true })
    expect(existsSync(wtPath)).toBe(false)
    const r = await drain(exitWorktreeTool, {}, ctx(slot)) // must NOT throw
    expect(r.ok).toBe(true)
    expect(slot.current()).toBeUndefined() // slot cleared — session not wedged
  })
})

/* ------------------------------------------------------------------ */
/* D. worktree_status                                                  */
/* ------------------------------------------------------------------ */
describe("D. worktree_status", () => {
  let repo = ""
  let slot: WorktreeSlotHandle
  beforeEach(async () => {
    repo = await makeRepo()
    slot = makeSlot(repo, repo)
  })

  test("no active worktree ⇒ 'no active worktree'", async () => {
    const r = await drain(worktreeStatusTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(r.output.toLowerCase()).toContain("no active worktree")
  })

  test("reports path / branch / persistent / branchFrom + uncommitted count", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const cur = slot.current()
    const r = await drain(worktreeStatusTool, {}, ctx(slot))
    expect(r.ok).toBe(true)
    expect(r.output).toContain(cur?.worktreePath ?? "")
    expect(r.output).toContain(cur?.branch ?? "")
    expect(r.output).toContain("persistent: false")
    expect(r.output).toContain("branchFrom: head")
    expect(r.output).toContain("uncommitted changes: 0")
  })

  test("uncommitted count reflects a dirty worktree", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    await writeFile(path.join(wtPath, "a.txt"), "x\n")
    await writeFile(path.join(wtPath, "b.txt"), "y\n")
    const r = await drain(worktreeStatusTool, {}, ctx(slot))
    expect(r.output).toContain("uncommitted changes: 2")
  })

  test("status is read-only / concurrency-safe", () => {
    expect(worktreeStatusTool.isReadOnly()).toBe(true)
    expect(worktreeStatusTool.isConcurrencySafe({} as never)).toBe(true)
  })

  test("WORKTREE_TOOL_NAMES is the 3 tool names in stable order", () => {
    expect(WORKTREE_TOOL_NAMES).toEqual(["enter_worktree", "exit_worktree", "worktree_status"])
  })

  // ── ticket-11 R4-5 finding #1: status over a VANISHED worktree dir ───────────
  // Same root cause as the exit case: `git status --porcelain` via runShell THROWS
  // when the worktree cwd is gone. status must degrade to the existing
  // count===undefined ⇒ "unknown" branch instead of letting the throw escape.
  test("worktree_status with the worktree DIR VANISHED ⇒ no throw, 'unknown' count", async () => {
    await drain(enterWorktreeTool, {}, ctx(slot))
    const wtPath = slot.current()?.worktreePath ?? ""
    rmSync(wtPath, { recursive: true, force: true })
    expect(existsSync(wtPath)).toBe(false)
    const r = await drain(worktreeStatusTool, {}, ctx(slot)) // must NOT throw
    expect(r.ok).toBe(true)
    expect(r.output).toContain("uncommitted changes: unknown")
  })
})
