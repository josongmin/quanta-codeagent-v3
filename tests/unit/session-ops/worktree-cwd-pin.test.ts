import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pinTurnBoundaryCwd, type WorktreeCwdPort } from "@/runner/orchestrate"
import {
  makeWorkspaceCreateIntent,
  type SessionMeta,
  saveSessionById,
  transitionWorkspaceState,
  type WorkspaceOwnership,
  type WorkspaceOwnershipState,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/* RFC-06 §RFC06-2 — the turn-boundary cwd pin FOLLOWER. Real session store; a
 * fake chdir/getcwd port records the swap without touching process.cwd(). */

const PIN = "QUANTA_WORKTREE_CWD_PIN"
const START_CWD = "/repo/root"
const WT_PATH = "/repo/root/.quanta/worktrees/wt-1"

/** A minimal valid save payload (the store schema requires a string `reason`
 *  and a numeric `turns`). */
const PAYLOAD = { reason: "t", turns: 0, messages: [] }

const mkMeta = (id: string, ownership?: WorkspaceOwnership): SessionMeta => ({
  id,
  title: "t",
  cwd: START_CWD,
  createdAt: 1,
  lastTouched: 1,
  archived: false,
  ...(ownership !== undefined ? { workspaceOwnership: ownership } : {}),
})

/** Build an ownership record in a target state by walking the lifecycle. */
const ownershipInState = (path: string, state: WorkspaceOwnershipState): WorkspaceOwnership => {
  const intent = makeWorkspaceCreateIntent({
    ownershipId: "own-1",
    ownerThreadId: "s1",
    repoRoot: START_CWD,
    repoId: START_CWD,
    path,
    branch: "fork-1",
    baseSha: "HEAD",
    now: 1,
  })
  if (state === "creating") return intent
  const ready = transitionWorkspaceState(intent, "ready", 2)
  if (!ready.ok) throw new Error("ready transition failed")
  if (state === "ready") return ready.record
  // `removed` is reachable only via `ready → closing → removed` (the closed
  // lifecycle forbids a direct ready→removed jump).
  if (state === "removed") {
    const closing = transitionWorkspaceState(ready.record, "closing", 3)
    if (!closing.ok) throw new Error("closing transition failed")
    const removed = transitionWorkspaceState(closing.record, "removed", 4)
    if (!removed.ok) throw new Error("removed transition failed")
    return removed.record
  }
  const next = transitionWorkspaceState(ready.record, state, 3)
  if (!next.ok) throw new Error(`transition to ${state} failed`)
  return next.record
}

/** A fake working-directory port: records chdir targets, no process mutation. */
const makePort = (): WorktreeCwdPort & { swaps: string[]; here: string } => {
  const state = { here: START_CWD }
  const swaps: string[] = []
  return {
    swaps,
    get here() {
      return state.here
    },
    cwd: () => state.here,
    chdir: (target: string) => {
      swaps.push(target)
      state.here = target
      return state.here
    },
  }
}

describe("pinTurnBoundaryCwd (RFC06-2 turn-boundary follower)", () => {
  let sessionsDir: string
  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wcp-sess-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
    delete process.env[PIN]
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    delete process.env.QUANTA_SESSIONS_DIR
    delete process.env[PIN]
    __resetRuntimeConfig()
  })

  const env = (): Record<string, string | undefined> => ({ ...process.env })

  test("gate ON + ready ownership ⇒ cwd pinned to the owned worktree at the boundary", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "ready")), PAYLOAD)
    const port = makePort()
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    // The follower CONSUMES the persisted worktree path — the swap happened.
    expect(port.swaps).toEqual([WT_PATH])
    expect(port.here).toBe(WT_PATH)
  })

  test("gate OFF ⇒ NO consumer: cwd unchanged, no session load (byte-identical)", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "ready")), PAYLOAD)
    const port = makePort()
    // gate unset (default-OFF)
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(port.swaps).toEqual([])
    expect(port.here).toBe(START_CWD)
  })

  test("gate ON but NO ownership ⇒ cwd stays (nothing to pin)", async () => {
    await saveSessionById(mkMeta("s1"), PAYLOAD)
    const port = makePort()
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(port.swaps).toEqual([])
    expect(port.here).toBe(START_CWD)
  })

  test("gate ON but ownership still `creating` (intent, no effect) ⇒ cwd stays", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "creating")), PAYLOAD)
    const port = makePort()
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(port.swaps).toEqual([])
    expect(port.here).toBe(START_CWD)
  })

  test("gate ON, `active` ownership ⇒ pinned (a live worktree, not just ready)", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "active")), PAYLOAD)
    const port = makePort()
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(port.swaps).toEqual([WT_PATH])
  })

  test("gate ON, terminal `removed` ownership ⇒ cwd stays (torn-down path may be gone)", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "removed")), PAYLOAD)
    const port = makePort()
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(port.swaps).toEqual([])
  })

  test("idempotent: already at the owned path ⇒ no redundant chdir", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "ready")), PAYLOAD)
    // Port already sitting in the worktree.
    const state = { here: WT_PATH }
    const swaps: string[] = []
    const port: WorktreeCwdPort = {
      cwd: () => state.here,
      chdir: (t) => {
        swaps.push(t)
        state.here = t
        return t
      },
    }
    process.env[PIN] = "1"
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    expect(swaps).toEqual([])
  })

  test("boundary-order: the pin runs BEFORE the turn body (never mid-turn)", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "ready")), PAYLOAD)
    const events: string[] = []
    const port: WorktreeCwdPort = {
      cwd: () => START_CWD,
      chdir: (t) => {
        events.push(`pin:${t}`)
        return t
      },
    }
    process.env[PIN] = "1"
    // Simulate the turn chokepoint: pin THEN body.
    await pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })
    events.push("turn-body")
    // The chdir landed strictly before the body — the pin is a boundary op.
    expect(events).toEqual([`pin:${WT_PATH}`, "turn-body"])
  })

  test("best-effort: a throwing chdir port does NOT break the turn", async () => {
    await saveSessionById(mkMeta("s1", ownershipInState(WT_PATH, "ready")), PAYLOAD)
    const port: WorktreeCwdPort = {
      cwd: () => START_CWD,
      chdir: () => {
        throw new Error("chdir boom")
      },
    }
    process.env[PIN] = "1"
    // Resolves (does not throw) — a follower must never break a turn.
    await expect(pinTurnBoundaryCwd({ sessionId: "s1", env: env(), port })).resolves.toBeUndefined()
  })
})
