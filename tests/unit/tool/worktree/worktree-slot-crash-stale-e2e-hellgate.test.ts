/**
 * H12 — SOTA++ hellgate: crash-stale worktree slot MUST NOT pollute a NEW
 * session's bash cwd.
 *
 * The sibling `worktree-dispatch-e2e.test.ts` only exercises the HAPPY
 * lifecycle (enter → bash(cwd=worktree) → exit → restored) inside ONE session.
 * `worktree-tools.test.ts` covers the on-DISK leftover (a fixed-path worktree
 * survives a crash and `enter_worktree` reconciles it). NEITHER seals the
 * cross-session SLOT contract:
 *
 *   A session calls `enter_worktree` (slot SET, real worktree dir on disk) and
 *   then CRASHES before `exit_worktree`. The in-memory slot dies with the
 *   process; the worktree dir lingers on disk. A fresh session boots and runs
 *   `bash`. If the new session's slot carried the prior session's worktree
 *   value, the dispatch seam would project a STALE `activeWorktree` and `bash`
 *   would spawn INSIDE a worktree the new session never entered — a silent cwd
 *   hijack.
 *
 * The contract under seal: the slot is SESSION-SCOPED and minted EMPTY at every
 * session bootstrap (`mintActiveWorktreeSlot` → `createWorktreeSlot` →
 * `active = undefined`). A crashed session leaves NOTHING in a fresh session's
 * slot, so `slot.current() === undefined` ⇒ the dispatch seam omits
 * `activeWorktree` ⇒ `bash` runs in the SESSION cwd (NOT the stale worktree).
 *
 * RED-ON-INJECTION: if a future "resume" refactor seeded the new session's slot
 * from a persisted/inherited prior value (i.e. minted it NON-empty), the
 * `bash → pwd` assertion below goes RED — `pwd` would print the stale worktree
 * path instead of the session cwd. The `mintEmpty` invariant test fails the same
 * way. This is the single load-bearing lever.
 *
 * Hermetic: real `git` + real tmpdir repo + real `dispatchTool`. NO timing
 * assertions — every assertion is a deterministic path/identity check.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentConfig } from "@/agent"
import { createWorktreeSlot, mintActiveWorktreeSlot } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { ToolRegistry, type WorktreeSlotHandle } from "@/tool"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { worktreeTools } from "@/tool/worktree"

const repos: string[] = []

/** Real git repo with one commit (resolved real path — macOS /tmp is a symlink
 *  to /private/tmp, which would make `pwd`-string containment flaky). */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wt-crash-"))
  const real = execFileSync("bash", ["-lc", "cd " + JSON.stringify(dir) + " && pwd -P"])
    .toString()
    .trim()
  repos.push(real)
  const git = (args: string[]) => execFileSync("git", args, { cwd: real })
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "t@t.t"])
  git(["config", "user.name", "t"])
  execFileSync("bash", ["-lc", "echo seed > seed.txt"], { cwd: real })
  git(["add", "."])
  git(["commit", "-q", "-m", "seed"])
  return real
}

const perm: PermissionContext = { mode: "acceptEdits" }

/** AgentConfig over a repo. `slot` undefined ⇒ no worktree wiring (default-OFF);
 *  the worktree tools are only registered when a slot is wired (same shape as
 *  the real composition root). */
const cfg = (repo: string, slot?: WorktreeSlotHandle): AgentConfig =>
  ({
    registry: new ToolRegistry([
      bashTool,
      editTool,
      ...(slot !== undefined ? worktreeTools : []),
    ]),
    cwd: repo,
    signal: new AbortController().signal,
    permission: perm,
    onConfirm: async () => true,
    ...(slot !== undefined ? { activeWorktreeSlot: slot } : {}),
  }) as unknown as AgentConfig

const tu = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}-${Math.random().toString(36).slice(2)}`,
  name,
  input: input as Record<string, unknown>,
})

afterAll(async () => {
  for (const d of repos) await rm(d, { recursive: true, force: true }).catch(() => undefined)
})

/* ------------------------------------------------------------------ */
/* 1. The crash → fresh-session cross-boundary E2E (the core hellgate) */
/* ------------------------------------------------------------------ */
describe("H12 — crashed-session worktree slot does NOT pollute a fresh session's bash cwd", () => {
  test("enter (slot SET, dir on disk) → CRASH (slot dies) → fresh session bash runs in SESSION cwd, not the stale worktree", async () => {
    const repo = await makeRepo()

    /* ── SESSION 1: enter_worktree, then "crash" (no exit_worktree) ────────── */
    const slot1 = createWorktreeSlot({ repoRoot: repo, sessionCwd: repo })
    const config1 = cfg(repo, slot1)
    const enter = await dispatchTool(tu("enter_worktree", {}), config1, perm)
    expect(enter.ok).toBe(true)
    const stalePath = slot1.current()?.worktreePath ?? ""
    expect(stalePath.length).toBeGreaterThan(0)
    // The worktree dir is REALLY on disk (it survives the crash; only the
    // in-memory slot is lost).
    expect(existsSync(stalePath)).toBe(true)
    // Sanity: while session 1 is "inside", bash REALLY does spawn in the worktree
    // (so the assertion below — session 2 NOT in the worktree — has teeth).
    const inWt = await dispatchTool(tu("bash", { command: "pwd -P" }), config1, perm)
    expect(inWt.ok).toBe(true)
    if (inWt.ok) expect(inWt.block.content).toContain(stalePath)
    // CRASH: the process dies. `slot1` (and `config1`) are now unreachable garbage.
    // We DO NOT call exit_worktree — the dir lingers on disk, the slot is gone.

    /* ── SESSION 2: fresh bootstrap (re-mint the slot, gate ON) ────────────── */
    // This is exactly what `runtime-context-compose` does at session start:
    // mintActiveWorktreeSlot(env, bootCwd). It mints an EMPTY slot — the crashed
    // session leaves NOTHING in it.
    const slot2 = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, repo)
    expect(slot2).toBeDefined()
    if (slot2 === undefined) throw new Error("expected a minted slot (gate on)")
    // CONTRACT: the freshly minted slot is EMPTY — no stale worktree carried over.
    expect(slot2.current()).toBeUndefined()

    const config2 = cfg(repo, slot2)
    // The dispatch seam reads slot2.current() (=== undefined) per call ⇒ it omits
    // `activeWorktree` ⇒ bash spawns in the SESSION cwd.
    const fresh = await dispatchTool(tu("bash", { command: "pwd -P" }), config2, perm)
    expect(fresh.ok).toBe(true)
    if (fresh.ok) {
      // THE load-bearing assertion: bash ran in the session cwd, NOT the stale
      // worktree left behind by the crashed session.
      expect(fresh.block.content).toContain(repo)
      expect(fresh.block.content).not.toContain(stalePath)
    }
    // And the slot is STILL empty after a bash turn — nothing re-seeded it.
    expect(slot2.current()).toBeUndefined()
  })

  test("the stale on-disk worktree is irrelevant to the fresh session's cwd (no reconcile needed for a plain bash)", async () => {
    const repo = await makeRepo()
    // Pre-plant a crash-leftover worktree at the fixed agent path WITHOUT any
    // session having entered it this run — mimics a leftover from a *previous*
    // process. The new session NEVER enters, just runs bash.
    const leftover = path.join(repo, ".quanta", "worktrees", "agent-worktree")
    execFileSync(
      "git",
      ["worktree", "add", "--no-track", "-B", "fork-agent-worktree", "--", leftover, "HEAD"],
      { cwd: repo },
    )
    expect(existsSync(leftover)).toBe(true)

    const slot = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, repo)
    if (slot === undefined) throw new Error("expected a minted slot")
    expect(slot.current()).toBeUndefined()

    const r = await dispatchTool(tu("bash", { command: "pwd -P" }), cfg(repo, slot), perm)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.block.content).toContain(repo)
      expect(r.block.content).not.toContain(leftover)
    }
  })
})

/* ------------------------------------------------------------------ */
/* 2. The mint-EMPTY invariant (the red-on-injection lever, isolated)  */
/* ------------------------------------------------------------------ */
describe("H12 — mintActiveWorktreeSlot / createWorktreeSlot produce an EMPTY slot (session-boundary clear contract)", () => {
  test("mintActiveWorktreeSlot starts with current() === undefined (gate ON)", () => {
    const slot = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, "/some/repo")
    expect(slot).toBeDefined()
    // If a "resume" refactor ever seeds the slot from a persisted prior value,
    // this is the first thing to go RED — the new-session slot must be EMPTY.
    expect(slot?.current()).toBeUndefined()
  })

  test("createWorktreeSlot starts EMPTY regardless of repoRoot/sessionCwd", () => {
    const slot = createWorktreeSlot({ repoRoot: "/r", sessionCwd: "/r" })
    expect(slot.current()).toBeUndefined()
  })

  test("each mint is an INDEPENDENT holder — setting one does not leak into the next (no shared module state)", () => {
    const a = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, "/r")
    if (a === undefined) throw new Error("expected slot a")
    a.set({
      worktreePath: "/r/.quanta/worktrees/wt",
      branch: "fork-wt",
      isPersistent: false,
      repoRoot: "/r",
      branchFrom: "head",
    })
    expect(a.current()).toBeDefined()
    // A SECOND mint (a fresh session) must NOT inherit `a`'s value — it is a
    // distinct closure. If mint ever returned a shared/cached holder, this RED's.
    const b = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, "/r")
    expect(b?.current()).toBeUndefined()
  })

  test("gate OFF ⇒ NO slot minted ⇒ default-OFF (no worktree projection possible)", () => {
    expect(mintActiveWorktreeSlot({}, "/r")).toBeUndefined()
    expect(mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "0" }, "/r")).toBeUndefined()
  })
})
