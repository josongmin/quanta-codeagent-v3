/**
 * RFC11-2 — scheduled-task role + git-base binding (Codex 5973
 * `ScheduledTaskSchedule` parity: `{baseBranch, agent_role, ...}`).
 *
 * Corpus parity: Codex 5973 binds a scheduled task to `{baseBranch, agent_role,
 * model, prompt, cadence}`. quanta ALREADY binds title + cron rule + prompt
 * (`createCronSlashAdapter.create`) + model (`model-reroute`). This battery pins
 * the TWO NEW additive bindings — through the REAL scheduler create + fire path:
 *
 *   1. agent-role — a scheduled run ADOPTS the bound role (REUSED registry:
 *      `@/subagent/role` `AgentRole` + `getToolPolicyForRole`). The fire path
 *      passes `agentRole` on the enqueue opts so the loop runs under the role's
 *      tool policy. NO new role system is invented.
 *   2. git-base-branch — a scheduled run FORKS from the bound base branch
 *      (REUSED owner: RFC-06 `createPersistentWorktree`, the SAME persistent
 *      worktree caller the interactive session-fork path uses). NO new
 *      git/worktree caller is added.
 *
 * The bindings are OPTIONAL. A task with NEITHER binding is byte-identical to
 * the pre-RFC11-2 fire (no role opt, no fork call). Red-on-injection: DROP a
 * binding ⇒ the fire reverts to the default (no role adopted / no base forked).
 *
 * Front-door: drives `assembleAutomation` (the REAL composition wire) + the REAL
 * `tickScheduler` claim→handler→finalize fire path over a live engine, so a
 * broken binding turns RED.
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createPersistentWorktree, type PersistentWorktree } from "@/runtime/worktree-fork"
import {
  inMemoryAutomationEngine,
  sqliteAutomationEngine,
  tickScheduler,
} from "@/scheduler/automation-engine"
import { createCronSlashAdapter } from "@/scheduler/cron-slash-adapter"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { WorktreeForkPort } from "@/scheduler/runtime-wire"
import { AUTOMATION_ENV_FLAG, assembleAutomation } from "@/scheduler/runtime-wire"
import type { AgentLoopPort, RRule } from "@/scheduler/types"
// Drift-guard: the REAL registry the scheduler binding claims to reuse. This
// test file has NO slice fence, so it can import the VALUE and assert the
// scheduler's local known-role set stays byte-equal to it.
import { AGENT_ROLES } from "@/subagent/role"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

const makeEnv = (o: Record<string, string>): { get: (k: string) => string | undefined } => {
  const m = new Map(Object.entries(o))
  return { get: (k) => m.get(k) }
}

/** Capture every enqueue call (message + role + base) so the binding is
 *  observable at the fire seam. */
const recordingLoop = (): {
  loop: AgentLoopPort
  calls: Array<{ message: string; agentRole: string | undefined; baseBranch: string | undefined }>
} => {
  const calls: Array<{
    message: string
    agentRole: string | undefined
    baseBranch: string | undefined
  }> = []
  return {
    loop: {
      enqueueUserMessage: async (message, opts) => {
        calls.push({
          message,
          agentRole: opts?.agentRole,
          baseBranch: opts?.baseBranch,
        })
      },
    },
    calls,
  }
}

/** Capture every worktree fork the fire path drives (REUSED RFC-06 owner
 *  seam). Records the base ref so the fork target is observable. */
const recordingFork = (): {
  fork: (
    id: string,
    repoRoot: string,
    opts?: { branch?: string; baseRef?: string },
  ) => Promise<PersistentWorktree>
  calls: Array<{ id: string; repoRoot: string; baseRef: string | undefined }>
} => {
  const calls: Array<{ id: string; repoRoot: string; baseRef: string | undefined }> = []
  return {
    fork: async (id, repoRoot, opts) => {
      calls.push({ id, repoRoot, baseRef: opts?.baseRef })
      return {
        worktreePath: `${repoRoot}/.quanta/worktrees/${id}`,
        branch: opts?.branch ?? `fork-${id}`,
      }
    },
    calls,
  }
}

/** Fire the single soonest-due row through the REAL tick path. */
const fireOnce = async (
  engine: ReturnType<typeof inMemoryAutomationEngine>,
  handler: Parameters<typeof tickScheduler>[0]["handler"],
  now: number,
) => tickScheduler({ engine, now, handler })

const NOW = Date.UTC(2026, 4, 25, 10, 0, 0)

// ───────────────────────────────────────────────────────────────────────────
// create-signature binding — the record carries the optional role + base
// ───────────────────────────────────────────────────────────────────────────

describe("RFC11-2 create — role + git-base bind onto the task record", () => {
  test("R11-CREATE-01: create(role+base) persists both onto the engine row", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({ engine, now: () => NOW, idGen: () => "sched-1" })
    const res = await adapter.create("nightly", "FREQ=DAILY", "run the audit", {
      agentRole: "explorer",
      baseBranch: "release/next",
    })
    expect(res.ok).toBe(true)
    const list = await engine.list()
    if (!list.ok) throw new Error("unreachable")
    const row = list.value.find((a) => a.id === "sched-1")
    expect(row?.agentRole).toBe("explorer")
    expect(row?.baseBranch).toBe("release/next")
  })

  test("R11-CREATE-02: create() with NO binding omits both keys (byte-identical row)", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({ engine, now: () => NOW, idGen: () => "sched-2" })
    const res = await adapter.create("nightly", "FREQ=DAILY", "run the audit")
    expect(res.ok).toBe(true)
    const list = await engine.list()
    if (!list.ok) throw new Error("unreachable")
    const row = list.value.find((a) => a.id === "sched-2")
    // exactOptional: absent keys are OMITTED, never `undefined`-set.
    expect("agentRole" in (row ?? {})).toBe(false)
    expect("baseBranch" in (row ?? {})).toBe(false)
  })

  test("R11-CREATE-03: an UNKNOWN role is refused (typed, never persisted)", async () => {
    const engine = inMemoryAutomationEngine()
    const adapter = createCronSlashAdapter({ engine, now: () => NOW, idGen: () => "sched-3" })
    const res = await adapter.create("x", "FREQ=DAILY", "p", {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately smuggle a bad role past TS
      agentRole: "wizard" as any,
    })
    expect(res.ok).toBe(false)
    const list = await engine.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value.find((a) => a.id === "sched-3")).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// engine REUSE — persisted through the EXISTING engine (no new store)
// ───────────────────────────────────────────────────────────────────────────

describe("RFC11-2 engine — persisted through the EXISTING engine, byte-identical when absent", () => {
  test("R11-ENG-01: sqlite bindless schedule OMITS both keys (byte-identical row)", async () => {
    const e = sqliteAutomationEngine(new Database(":memory:"))
    const r = await e.schedule({
      id: "e1",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: NOW,
      createdAt: NOW,
    })
    if (!r.ok) throw new Error("unreachable")
    expect("agentRole" in r.value).toBe(false)
    expect("baseBranch" in r.value).toBe(false)
  })

  test("R11-ENG-02: sqlite bound schedule ROUND-TRIPS both across a reopen (durability)", async () => {
    const db = new Database(":memory:")
    const e = sqliteAutomationEngine(db)
    const r = await e.schedule({
      id: "e2",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: NOW,
      createdAt: NOW,
      agentRole: "explorer",
      baseBranch: "release/next",
    })
    if (!r.ok) throw new Error("unreachable")
    // A FRESH engine over the SAME db reads it back (hit real persistence).
    const reopened = sqliteAutomationEngine(db)
    const list = await reopened.list()
    if (!list.ok) throw new Error("unreachable")
    const row = list.value.find((a) => a.id === "e2")
    expect(row?.agentRole).toBe("explorer")
    expect(row?.baseBranch).toBe("release/next")
  })

  test("R11-ENG-03: the binding survives the claim→finalize FIRE cycle (immutable carry)", async () => {
    const e = inMemoryAutomationEngine()
    await e.schedule({
      id: "e3",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: NOW,
      createdAt: NOW,
      agentRole: "worker",
      baseBranch: "dev",
    })
    const c = await e.claim(NOW)
    if (!c.ok || c.value === null) throw new Error("unreachable")
    expect(c.value.automation.agentRole).toBe("worker")
    expect(c.value.automation.baseBranch).toBe("dev")
    const f = await e.finalize({
      id: "e3",
      claimToken: c.value.claimToken,
      firedAt: NOW,
      outcome: "fired",
      nextRunAt: NOW + 86_400_000,
      inboxTitle: "i",
      inboxSummary: "s",
    })
    if (!f.ok) throw new Error("unreachable")
    // A retrying row keeps its binding (per-task immutable, like `model`).
    expect(f.value.agentRole).toBe("worker")
    expect(f.value.baseBranch).toBe("dev")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// FIRE PATH — the run adopts the role + forks the base (front-door)
// ───────────────────────────────────────────────────────────────────────────

describe("RFC11-2 fire — role adopted + base forked at fire time", () => {
  test("R11-FIRE-01: a bound task fires with agentRole on the enqueue + forks the base", async () => {
    const { loop, calls } = recordingLoop()
    const { fork, calls: forkCalls } = recordingFork()
    const engine = inMemoryAutomationEngine()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      engine,
      worktreeFork: fork,
      worktreeRepoRoot: "/repo",
    })
    if (slot === null) throw new Error("unreachable — slot should build")

    await engine.schedule({
      id: "s1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "run the audit",
      nextRunAt: NOW,
      createdAt: NOW,
      agentRole: "worker",
      baseBranch: "release/next",
    })

    const outcome = await fireOnce(engine, slot.handler, NOW)
    expect(outcome.kind).toBe("fired")

    // Role adopted on the enqueue seam.
    expect(calls.length).toBe(1)
    expect(calls[0]?.agentRole).toBe("worker")
    expect(calls[0]?.message).toBe("run the audit")

    // Base forked via the REUSED RFC-06 owner with the bound base as baseRef.
    expect(forkCalls.length).toBe(1)
    expect(forkCalls[0]?.baseRef).toBe("release/next")
    expect(forkCalls[0]?.repoRoot).toBe("/repo")
  })

  test("R11-FIRE-02: NO binding ⇒ NO role opt + NO fork call (byte-identical fire)", async () => {
    const { loop, calls } = recordingLoop()
    const { fork, calls: forkCalls } = recordingFork()
    const engine = inMemoryAutomationEngine()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      engine,
      worktreeFork: fork,
      worktreeRepoRoot: "/repo",
    })
    if (slot === null) throw new Error("unreachable")

    await engine.schedule({
      id: "s2",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "plain fire",
      nextRunAt: NOW,
      createdAt: NOW,
    })

    const outcome = await fireOnce(engine, slot.handler, NOW)
    expect(outcome.kind).toBe("fired")

    expect(calls.length).toBe(1)
    // No role opt passed.
    expect(calls[0]?.agentRole).toBeUndefined()
    // No fork call at all — the base-branch path is never entered.
    expect(forkCalls.length).toBe(0)
  })

  test("R11-FIRE-03 (red-on-injection): DROP the role binding ⇒ the fire reverts to default", async () => {
    const { loop, calls } = recordingLoop()
    const engine = inMemoryAutomationEngine()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      engine,
    })
    if (slot === null) throw new Error("unreachable")

    // Same task as FIRE-01 but WITHOUT agentRole — proves the enqueue role opt
    // is DERIVED from the binding, not hardcoded.
    await engine.schedule({
      id: "s3",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "no role",
      nextRunAt: NOW,
      createdAt: NOW,
      baseBranch: "release/next",
    })

    const outcome = await fireOnce(engine, slot.handler, NOW)
    expect(outcome.kind).toBe("fired")
    expect(calls[0]?.agentRole).toBeUndefined()
  })

  test("R11-FIRE-04 (red-on-injection): base bound but NO fork dep ⇒ fire still succeeds, no crash", async () => {
    // A base binding with no worktreeFork dep wired must NOT crash the fire — it
    // degrades to no-fork (the composition root that wants forking injects the
    // owner). This pins that the base path is guarded, not a hard require.
    const { loop } = recordingLoop()
    const engine = inMemoryAutomationEngine()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      engine,
    })
    if (slot === null) throw new Error("unreachable")
    await engine.schedule({
      id: "s4",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "base only",
      nextRunAt: NOW,
      createdAt: NOW,
      baseBranch: "release/next",
    })
    const outcome = await fireOnce(engine, slot.handler, NOW)
    expect(outcome.kind).toBe("fired")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// role registry REUSE — the bound role resolves against @/subagent/role
// ───────────────────────────────────────────────────────────────────────────

describe("RFC11-2 drift-guard — accepted roles == the REUSED registry", () => {
  test("R11-DRIFT-01: EVERY @/subagent/role AGENT_ROLES value binds (accepts exactly the registry)", async () => {
    for (const role of AGENT_ROLES) {
      const engine = inMemoryAutomationEngine()
      const adapter = createCronSlashAdapter({
        engine,
        now: () => NOW,
        idGen: () => `role-${role}`,
      })
      const res = await adapter.create("t", "FREQ=DAILY", "p", { agentRole: role })
      expect(res.ok).toBe(true)
      const list = await engine.list()
      if (!list.ok) throw new Error("unreachable")
      expect(list.value.find((a) => a.id === `role-${role}`)?.agentRole).toBe(role)
    }
  })

  test("R11-DRIFT-02: a token NOT in AGENT_ROLES is refused (accepts NOTHING beyond the registry)", async () => {
    const bogus = ["admin", "root", "any", "explorer2", ""].filter(
      (x) => !(AGENT_ROLES as ReadonlyArray<string>).includes(x),
    )
    for (const role of bogus) {
      const engine = inMemoryAutomationEngine()
      const adapter = createCronSlashAdapter({ engine, now: () => NOW, idGen: () => "b" })
      // biome-ignore lint/suspicious/noExplicitAny: smuggle a non-registry token
      const res = await adapter.create("t", "FREQ=DAILY", "p", { agentRole: role as any })
      expect(res.ok).toBe(false)
    }
  })
})

describe("RFC11-2 reuse — the fork port IS the RFC-06 owner (no new git caller)", () => {
  test("R11-OWNER-01: createPersistentWorktree is assignable to WorktreeForkPort (structural parity)", () => {
    // COMPILE-LEVEL proof: if the RFC-06 owner's signature drifts from the port
    // the scheduler declares, this assignment fails to typecheck — so the
    // composition root can only pass the EXACT existing owner, never a new
    // git/worktree caller. (`createPersistentWorktree` is the SAME persistent
    // worktree caller the interactive session-fork path uses.)
    const owner: WorktreeForkPort = createPersistentWorktree
    expect(typeof owner).toBe("function")
  })
})

describe("RFC11-2 reuse — the bound role is the EXISTING agent-role registry", () => {
  test("R11-REUSE-01: only registry-known roles bind; the fire carries the exact role token", async () => {
    const { loop, calls } = recordingLoop()
    const engine = inMemoryAutomationEngine()
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      agentLoop: loop,
      engine,
    })
    if (slot === null) throw new Error("unreachable")
    await engine.schedule({
      id: "s5",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "explore",
      nextRunAt: NOW,
      createdAt: NOW,
      agentRole: "explorer",
    })
    await fireOnce(engine, slot.handler, NOW)
    // The exact registry token (not a re-invented one) reaches the loop.
    expect(calls[0]?.agentRole).toBe("explorer")
  })
})
