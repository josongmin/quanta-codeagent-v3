/**
 * ticket-11 (P8) — git WORKTREE agent tools: `enter_worktree`, `exit_worktree`,
 * `worktree_status`.
 *
 * §SOTA: Claude Code is the only competitor that exposes worktree as an AGENT
 * tool (`EnterWorktree`/`ExitWorktree` + `bgIsolation:"worktree"` edit-fence). We
 * join that camp: a session-scoped {@link WorktreeSlotHandle} + a relative-cwd
 * override on `bash`/`edit` (the edit-fence). SOTA++ delta over the original
 * plan: `worktree_status` (CC `listRegisteredWorktrees` mirror, observability),
 * a dirty-exit guard (CC `force:true` mirror — refuse to discard uncommitted
 * work and LIST it), and `branchFrom:"fresh"|"head"` (CC 116207).
 *
 * DISCIPLINE: default-OFF (`QUANTA_WORKTREE_TOOL`). When the gate is off the
 * tools are NOT registered and the slot is absent, so `bash`/`edit` cwd is
 * byte-identical to today (the override is a single `?? ctx.cwd`).
 *
 * SLICE: `@/tool` MAY reach `@/runtime` (biome fence), so this slice reuses the
 * `withWorktree`/`createPersistentWorktree`/`removeWorktree` CORE directly
 * instead of a duck-typed seam — the same posture the `bash` tool already uses
 * for `runShell`.
 */

import { z } from "zod"
import {
  createPersistentWorktree,
  forceRemoveWorktree,
  isGitRepo,
  runShell,
  WorktreeForkError,
} from "@/runtime"
import { errMessage } from "@/shared"
import type {
  ActiveWorktree,
  Tool,
  ToolContext,
  ToolEvent,
  ToolFailure,
  WorktreeSlotHandle,
} from "../types"

/** Where a new worktree branches from. `head` = current local HEAD (cheap,
 *  deterministic, the default). `fresh` = `origin/<default-branch>` (a clean
 *  slice off the remote default). CC 116207 `worktree.branchFrom`. */
export type BranchFrom = "fresh" | "head"

const enterSchema = z
  .object({
    branchFrom: z
      .enum(["fresh", "head"])
      .optional()
      .describe(
        'Where to branch the worktree from. "head" (default) = the current ' +
          'HEAD commit. "fresh" = origin/<default-branch> (a clean slice off the ' +
          "remote default — use when the local tree has unrelated changes you do " +
          "NOT want in the worktree).",
      ),
  })
  .describe(
    "Enter an isolated git worktree. Subsequent relative bash commands and edits " +
      "run inside the worktree; absolute paths still jail to the session root. " +
      "Call exit_worktree when done.",
  )
type EnterInput = z.infer<typeof enterSchema>

const exitSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe(
        "Discard a DIRTY throwaway worktree (uncommitted changes) instead of " +
          "refusing. Default false: exit refuses + LISTS the uncommitted files so " +
          "work is never silently lost. Ignored for a persistent worktree (never " +
          "auto-removed regardless).",
      ),
  })
  .describe("Exit the active worktree, restoring the session working directory.")
type ExitInput = z.infer<typeof exitSchema>

const statusSchema = z
  .object({})
  .describe(
    "Report the current worktree slot (path / branch / persistent / branchFrom) " +
      "plus the uncommitted-change count. Returns 'no active worktree' when none.",
  )
type StatusInput = z.infer<typeof statusSchema>

/** Stable id slug for a session worktree. Session-scoped (one active worktree at
 *  a time), so a per-session constant suffices; `createPersistentWorktree`
 *  re-sanitizes anyway. */
const WORKTREE_ID = "agent-worktree"

/** The fixed on-disk path + branch the session worktree always uses. The id is a
 *  per-session CONSTANT (see {@link WORKTREE_ID}), so the path/branch are
 *  deterministic — which is what makes the crash-reconcile below safe to do
 *  unconditionally (we only ever touch OUR own fixed slot, never a stranger's). */
const fixedWorktreePath = (repoRoot: string): string =>
  `${repoRoot}/.quanta/worktrees/${WORKTREE_ID}`
const FIXED_WORKTREE_BRANCH = `fork-${WORKTREE_ID}`

/** Crash recovery: the slot is in-memory only, so a crash can leave OUR fixed
 *  worktree (path + branch) registered on disk. A fresh session's
 *  `git worktree add` then collides ("already used by worktree"). Because the id
 *  is a per-session constant, the leftover is unambiguously OURS — best-effort
 *  tear it down + prune git's stale registrations BEFORE creating, so a crashed
 *  session is recoverable without a manual `git worktree prune`. Idempotent +
 *  never throws: when nothing was left this is a pair of no-op git calls.
 *
 *  R4-5 finding #5: the leftover may carry UNCOMMITTED crash work that this
 *  `--force` reconcile silently discards. We CAPTURE that file list (best-effort,
 *  before the remove) and RETURN it so `enter` can SURFACE what was dropped — the
 *  discard still happens (the path is deterministically ours), but it is no longer
 *  silent. `uncommittedList` already degrades to `[]` when no leftover exists (the
 *  common no-op case) or its dir is gone, so this adds ZERO behavior on the happy
 *  path. */
const reconcileLeftoverWorktree = async (repoRoot: string): Promise<readonly string[]> => {
  const discarded = await uncommittedList(fixedWorktreePath(repoRoot))
  await forceRemoveWorktree(fixedWorktreePath(repoRoot), repoRoot, {
    branch: FIXED_WORKTREE_BRANCH,
  })
  await runShell("git worktree prune", { cwd: repoRoot })
  return discarded
}

/** Resolve the repo's default branch ref for `branchFrom:"fresh"`. Prefers the
 *  remote HEAD symbolic ref (`origin/HEAD` → `origin/main`); falls back to
 *  `origin/main` then `origin/master`. Returns the FIRST ref that exists so a
 *  repo without `origin/HEAD` set still resolves deterministically. */
const resolveFreshBaseRef = async (repoRoot: string): Promise<string> => {
  const head = await runShell("git symbolic-ref --quiet --short refs/remotes/origin/HEAD", {
    cwd: repoRoot,
  })
  const ref = head.stdout.trim()
  if (head.exitCode === 0 && ref.length > 0) return ref
  for (const candidate of ["origin/main", "origin/master"]) {
    const r = await runShell(`git rev-parse --verify --quiet ${candidate}`, { cwd: repoRoot })
    if (r.exitCode === 0 && r.stdout.trim().length > 0) return candidate
  }
  // Last resort: HEAD. Keeps enter deterministic even on a repo with no remote
  // (the "fresh" intent degrades to "head" rather than erroring).
  return "HEAD"
}

/** Count uncommitted entries (tracked diff + untracked) in a worktree via
 *  `git status --porcelain`. A non-zero exit (not a git tree) ⇒ `undefined` so
 *  the caller can surface "unknown" rather than a misleading 0.
 *
 *  R4-5 finding #1: `runShell` (Bun.spawn) THROWS — not just non-zero-exits —
 *  when the worktree cwd has VANISHED (external rm / crash that removed the dir
 *  but not the in-memory slot). Catch the throw and degrade to `undefined`
 *  (honoring the "unknown" contract above) so the throw cannot escape
 *  `execute()` and wedge the slot. The dirty-exit guard then treats a
 *  missing-dir as not-dirty and lets exit proceed to the idempotent
 *  `removeWorktree` (which clears the slot). */
const uncommittedCount = async (worktreePath: string): Promise<number | undefined> => {
  try {
    const r = await runShell("git status --porcelain", { cwd: worktreePath })
    if (r.exitCode !== 0) return undefined
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0)
    return lines.length
  } catch {
    // Worktree cwd is gone (spawn ENOENT) — "unknown", never a wedge.
    return undefined
  }
}

/** The uncommitted file list (porcelain lines) for the dirty-exit guard's
 *  listing. Capped so a pathological tree cannot balloon the tool result. A
 *  vanished worktree dir (runShell throw) ⇒ `[]` — same R4-5 finding #1 rule as
 *  {@link uncommittedCount}: never let the throw escape and wedge the slot. */
const UNCOMMITTED_LIST_CAP = 50
const uncommittedList = async (worktreePath: string): Promise<readonly string[]> => {
  try {
    const r = await runShell("git status --porcelain", { cwd: worktreePath })
    if (r.exitCode !== 0) return []
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, UNCOMMITTED_LIST_CAP)
  } catch {
    return []
  }
}

const notWired = (tool: string): ToolEvent => ({
  type: "result",
  result: {
    ok: false,
    output: `${tool}: worktree tools are not enabled for this session (set QUANTA_WORKTREE_TOOL=1).`,
    failure: { mode: "rejected", reason: "not_wired" } satisfies ToolFailure,
  },
})

const result = (ok: boolean, output: string, failure?: ToolFailure): ToolEvent => ({
  type: "result",
  result: { ok, output, ...(failure !== undefined ? { failure } : {}) },
})

/** `enter_worktree` — create/enter a worktree and set the session slot. */
export const enterWorktreeTool: Tool<EnterInput> = {
  name: "enter_worktree",
  description:
    "Enter an isolated git worktree for the session. After this, RELATIVE bash " +
    "commands and edits run inside the worktree (absolute paths STILL jail to the " +
    "session root). Use branchFrom:'head' (default, branch from current HEAD) or " +
    "'fresh' (branch from origin/<default>). Refuses if a worktree is already " +
    "active — exit_worktree first. Call exit_worktree when finished.",
  inputSchema: enterSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // Mutating-but-bounded: creating a worktree is reversible (exit removes it).
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
  async *execute(input: EnterInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const slot = ctx.worktreeSlot
    if (slot === undefined) {
      yield notWired("enter_worktree")
      return
    }
    if (slot.current() !== undefined) {
      const cur = slot.current() as ActiveWorktree
      yield result(
        false,
        `enter_worktree: a worktree is already active (${cur.worktreePath} on ${cur.branch}). ` +
          "Call exit_worktree first.",
        { mode: "rejected", reason: "worktree_already_active" },
      )
      return
    }
    const repoRoot = slot.repoRoot
    if (!(await isGitRepo(repoRoot))) {
      yield result(false, `enter_worktree: not a git repository: ${repoRoot}`, {
        mode: "rejected",
        reason: "not_a_git_repo",
      })
      return
    }
    const branchFrom: BranchFrom = input.branchFrom ?? "head"
    const baseRef = branchFrom === "fresh" ? await resolveFreshBaseRef(repoRoot) : "HEAD"
    // Crash recovery: the slot is in-memory only, so a prior crash can leave OUR
    // fixed worktree on disk; the duplicate-guard above only checks the live
    // slot. Best-effort reconcile the deterministic leftover (path + branch are a
    // per-session constant, so it is unambiguously ours) before creating, so a
    // collision ("already used by worktree") cannot wedge a fresh session. R4-5
    // finding #5: capture any UNCOMMITTED crash-leftover work the `--force`
    // reconcile discards so it can be surfaced (not silently dropped).
    const discarded = await reconcileLeftoverWorktree(repoRoot)
    try {
      const wt = await createPersistentWorktree(WORKTREE_ID, repoRoot, { baseRef })
      const active: ActiveWorktree = {
        worktreePath: wt.worktreePath,
        branch: wt.branch,
        // §11 exit semantics: `enter_worktree` creates a THROWAWAY worktree —
        // exit_worktree auto-removes it on a CLEAN tree, and on a DIRTY tree
        // refuses (lists uncommitted) unless force:true. A `persistent` worktree
        // (KEPT on exit) is the host-orchestrated `session fork --worktree` path,
        // not this agent-tool path; the slot still carries the flag so a future
        // persistent-enter variant can surface "kept on exit" in status/exit.
        isPersistent: false,
        repoRoot,
        branchFrom,
      }
      slot.set(active)
      // R4-5 finding #5: if the crash-leftover reconcile force-discarded
      // uncommitted work, SURFACE it (a non-fatal notice — enter still succeeds)
      // so the dropped work is visible rather than silently lost. Empty on the
      // common path (no leftover) ⇒ byte-identical message.
      const discardedNotice =
        discarded.length > 0
          ? `\nNOTE: a crash-leftover worktree at the fixed path was reconciled — ${discarded.length} ` +
            "uncommitted change(s) in it were DISCARDED:\n" +
            discarded.map((f) => `  ${f}`).join("\n")
          : ""
      yield result(
        true,
        `entered worktree ${wt.worktreePath} on branch ${wt.branch} (branchFrom=${branchFrom}, base=${baseRef}). ` +
          "Relative bash/edit now run inside the worktree; absolute paths still jail to the session root." +
          discardedNotice,
      )
    } catch (e) {
      const detail = e instanceof WorktreeForkError ? (e.detail ?? e.message) : errMessage(e)
      yield result(false, `enter_worktree: failed to create worktree — ${detail}`, {
        mode: "error",
        modelVisibleError: detail,
      })
    }
  },
}

/** Injectable dependencies for {@link makeExitWorktreeTool}. The default is the
 *  real `@/runtime` `forceRemoveWorktree` (the THROWAWAY/eval lifecycle remover —
 *  NOT the hardened user-session `removeWorktree`); tests inject a stub that
 *  returns `false` to exercise the cleanup-FAILURE branch deterministically (a
 *  genuine `git worktree remove` failure is hard to force, and "already gone" is
 *  treated as success by the CORE). */
export interface ExitWorktreeDeps {
  readonly removeWorktree: typeof forceRemoveWorktree
}

const DEFAULT_EXIT_DEPS: ExitWorktreeDeps = { removeWorktree: forceRemoveWorktree }

/** The dirty-exit guard (CC force:true mirror): when a throwaway worktree has
 *  uncommitted changes and `force` is not set, refuse to discard and LIST the
 *  files so the model can commit/inspect rather than lose work silently. Returns
 *  the typed refusal {@link ToolEvent}, or `null` when exit may proceed (clean,
 *  or `force:true`). Extracted so the `execute` generator stays under the lint
 *  cognitive-complexity gate. */
const buildDirtyExitGuard = async (
  worktreePath: string,
  force: boolean,
): Promise<ToolEvent | null> => {
  const count = await uncommittedCount(worktreePath)
  const dirty = count !== undefined && count > 0
  if (!dirty || force) return null
  const files = await uncommittedList(worktreePath)
  const more =
    count !== undefined && count > files.length ? `\n…and ${count - files.length} more` : ""
  return result(
    false,
    `exit_worktree: ${count} uncommitted change(s) in the worktree — refusing to discard. ` +
      "Commit them, or pass force:true to discard:\n" +
      files.map((f) => `  ${f}`).join("\n") +
      more,
    { mode: "rejected", reason: "worktree_dirty" },
  )
}

/** Build `exit_worktree` over injectable cleanup deps. The exported
 *  {@link exitWorktreeTool} is `makeExitWorktreeTool()` with the real remover, so
 *  it is byte-identical to the pre-factory version. */
export const makeExitWorktreeTool = (
  deps: ExitWorktreeDeps = DEFAULT_EXIT_DEPS,
): Tool<ExitInput> => ({
  name: "exit_worktree",
  description:
    "Exit the active worktree and restore the session working directory. If the " +
    "worktree has uncommitted changes it is DISCARDED only with force:true — " +
    "otherwise exit refuses and lists the uncommitted files so work is never " +
    "silently lost.",
  inputSchema: exitSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
  async *execute(input: ExitInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const slot = ctx.worktreeSlot
    if (slot === undefined) {
      yield notWired("exit_worktree")
      return
    }
    const active = slot.current()
    if (active === undefined) {
      yield result(false, "exit_worktree: no active worktree to exit.", {
        mode: "rejected",
        reason: "no_active_worktree",
      })
      return
    }
    // Persistent worktree (host-orchestrated `session fork --worktree` path): the
    // operator owns its lifecycle, so exit NEVER removes it (clean or dirty) — it
    // just clears the slot so relative bash/edit return to the session cwd. The
    // dirty-guard does NOT apply (nothing is being discarded). force is ignored.
    if (active.isPersistent) {
      slot.clear()
      yield result(
        true,
        `exited persistent worktree (was on ${active.branch}; KEPT on disk — operator owns its lifecycle). ` +
          "Relative bash/edit now run in the session working directory again.",
      )
      return
    }
    const dirtyGuard = await buildDirtyExitGuard(active.worktreePath, input.force ?? false)
    if (dirtyGuard !== null) {
      yield dirtyGuard
      return
    }
    // Tear down the worktree + branch (force:true discards a dirty tree).
    // NO-THROW (§2): `removeWorktree` is an injected git-op port returning a bare
    // boolean — a THROW (git error / FS perm) must not escape the iterator. Guard
    // it and fold a throw into the SAME typed-failure + keep-slot posture as a
    // false return (finding #4), so the model can retry/inspect.
    let removed: boolean
    try {
      removed = await deps.removeWorktree(active.worktreePath, active.repoRoot, {
        branch: active.branch,
      })
    } catch (e) {
      await runShell("git worktree prune", { cwd: active.repoRoot }).catch(() => undefined)
      yield result(
        false,
        `exit_worktree: worktree cleanup threw (${errMessage(e)}) — ${active.worktreePath} may still be registered. ` +
          "The worktree is still active; retry exit_worktree, or remove it manually " +
          `(git worktree remove --force ${active.worktreePath}).`,
        { mode: "rejected", reason: "worktree_cleanup_failed" },
      )
      return
    }
    // ticket-11 finding #4: a FAILED removal must NOT report ok:true + clear the
    // slot — that leaves the EXACT wedging state (a registered worktree on disk +
    // a session that thinks it exited). Surface a TYPED failure and KEEP the slot
    // so the model can retry/inspect. Best-effort prune git's stale registrations
    // first so the next enter's reconcile has a cleaner slate.
    if (!removed) {
      await runShell("git worktree prune", { cwd: active.repoRoot }).catch(() => undefined)
      yield result(
        false,
        `exit_worktree: worktree cleanup FAILED — ${active.worktreePath} may still be registered. ` +
          "The worktree is still active; retry exit_worktree, or remove it manually " +
          `(git worktree remove --force ${active.worktreePath}).`,
        { mode: "rejected", reason: "worktree_cleanup_failed" },
      )
      return
    }
    // Clean teardown: clear the slot so the session is never wedged "inside" a
    // worktree that no longer exists.
    slot.clear()
    yield result(
      true,
      `exited worktree (was on ${active.branch}). removed worktree ${active.worktreePath}. ` +
        "Relative bash/edit now run in the session working directory again.",
    )
  },
})

/** `exit_worktree` — clear the slot + tear down (clean) or guard (dirty). The
 *  default build uses the real `@/runtime` remover. */
export const exitWorktreeTool: Tool<ExitInput> = makeExitWorktreeTool()

/** `worktree_status` — report the current slot + uncommitted count. */
export const worktreeStatusTool: Tool<StatusInput> = {
  name: "worktree_status",
  description:
    "Report the active worktree (path, branch, persistent, branchFrom) and its " +
    "uncommitted-change count. Returns 'no active worktree' when none is entered. " +
    "Use this to confirm where relative bash/edit operations are landing.",
  inputSchema: statusSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(_input: StatusInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const slot = ctx.worktreeSlot
    if (slot === undefined) {
      yield notWired("worktree_status")
      return
    }
    const active = slot.current()
    if (active === undefined) {
      yield result(
        true,
        "no active worktree (relative bash/edit run in the session working directory).",
      )
      return
    }
    const count = await uncommittedCount(active.worktreePath)
    const countText = count === undefined ? "unknown (not a git tree?)" : String(count)
    yield result(
      true,
      [
        `active worktree: ${active.worktreePath}`,
        `branch: ${active.branch}`,
        `persistent: ${active.isPersistent}`,
        `branchFrom: ${active.branchFrom}`,
        `repoRoot: ${active.repoRoot}`,
        `uncommitted changes: ${countText}`,
      ].join("\n"),
    )
  },
}

/** All three worktree tools, in stable order. The composition root registers
 *  this list ONLY when `QUANTA_WORKTREE_TOOL` is on AND a session slot is wired
 *  (default-OFF: not registered ⇒ the LLM cannot call them). */
export const worktreeTools: readonly Tool[] = [
  enterWorktreeTool as Tool,
  exitWorktreeTool as Tool,
  worktreeStatusTool as Tool,
]

/** The names the worktree slice contributes — used by the manifest drift-guard
 *  and the composition wire so neither hand-maintains the list. */
export const WORKTREE_TOOL_NAMES: readonly string[] = worktreeTools.map((t) => t.name)

export type { ActiveWorktree, WorktreeSlotHandle }
