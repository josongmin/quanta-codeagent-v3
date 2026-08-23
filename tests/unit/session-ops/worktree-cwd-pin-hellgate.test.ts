/**
 * HELLGATE — RFC06-2 worktree cwd pin, real turn-boundary composition
 * (§17.5 packet W0)
 *
 * The PM Definition-of-Done ratchet fails this feature on the `e2e-hellgate`
 * axis. Existing coverage proves the pure helper (`worktree-cwd-pin.test.ts`)
 * and the happy path at the front door (`session-turn-driver.test.ts`), but
 * three things the plan names are unproven:
 *
 *   - **load failure** — nothing exercises the wire's `catch` at all.
 *   - **chdir failure through a REAL turn** — the unit proves the promise
 *     resolves, NOT that the turn still completes.
 *   - **`active` ownership at the front door** — only `ready` is covered there.
 *
 * The pin is fail-soft BY DESIGN: it must never be able to kill a turn. That
 * is exactly the property no current test asserts, so a regression that made
 * a chdir/load error propagate would ship silently.
 *
 * Everything here drives `driveSessionTurn` — the shipped composition — with
 * the injected `WorktreeCwdPort` and a threaded `env`. No real `process.chdir`,
 * no real worktree.
 *
 * Adversarial invariants:
 *
 *  H1  GATE-OFF byte-identical — absent knob ⇒ zero chdir, timeline unchanged.
 *  H2  `active` ownership pins at the front door (not just `ready`).
 *  H3  Terminal/transient states (`creating`, `closing`, `removed`) never pin.
 *  H4  chdir THROWING does not fail the turn — the body still runs to
 *      completion, and the process cwd is not left half-moved.
 *  H5  A corrupt/unreadable session store does not pin and does not fail the
 *      turn (the fail-soft load path).
 *  H6  A loader that THROWS (the real `catch` branch) does not fail the turn.
 *  H7  PAIRED CONTROL — with everything healthy the pin DOES fire, so none of
 *      the above can pass merely because the pin is globally broken.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { driveSessionTurn } from "@/runner/orchestrate"
import type { WorktreeCwdPort } from "@/runner/orchestrate/worktree-cwd-pin-wire"
import type { RuntimeSession } from "@/sdk/runtime"
import type { SessionMeta, WorkspaceOwnership, WorkspaceOwnershipState } from "@/session"
import { saveSessionById } from "@/session"
import { makeWorkspaceCreateIntent, transitionWorkspaceState } from "@/session/workspace-ownership"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const PIN = "QUANTA_WORKTREE_CWD_PIN"
const REPO = "/repo-root"
const WT = "/repo-root/.worktrees/fork-42"

/** Matches the driver's expected `SessionDispatchResult` shape — `result.turn`
 *  is required (`session-turn-driver.ts:92`), so an outcome-only object makes
 *  the driver throw and would mask the fail-soft property under test. */
const turnPayload = () =>
  ({
    turn: { messages: [], outcome: { reason: "completed", turns: 1, messages: [] } },
  }) as unknown as import("@/sdk/runtime").SessionDispatchResult

/** Records the turn body's own timeline so ordering across chdir/append/run is
 *  provable, and so "the turn completed" is an OBSERVED fact, not an inference
 *  from a resolved promise. */
const timelineSession = (timeline: string[]): RuntimeSession =>
  ({
    input: {
      append: async () => {
        timeline.push("append")
      },
    },
    turn: {
      run: async () => {
        timeline.push("turn.run")
        return turnPayload()
      },
    },
    approval: { respond: async () => undefined },
  }) as unknown as RuntimeSession

const recordingPort = (timeline: string[]): WorktreeCwdPort & { here: string } => {
  const state = { here: REPO }
  return {
    get here() {
      return state.here
    },
    cwd: () => state.here,
    chdir: (t: string) => {
      timeline.push(`chdir:${t}`)
      state.here = t
      return t
    },
  }
}

/** A port whose chdir THROWS — the failure the pin must absorb. */
const throwingPort = (timeline: string[]): WorktreeCwdPort & { here: string } => {
  const state = { here: REPO }
  return {
    get here() {
      return state.here
    },
    cwd: () => state.here,
    chdir: (t: string) => {
      timeline.push(`chdir-attempt:${t}`)
      throw new Error("ENOENT: chdir target vanished")
    },
  }
}

const ownershipIn = (state: WorkspaceOwnershipState, threadId: string): WorkspaceOwnership => {
  const intent = makeWorkspaceCreateIntent({
    ownershipId: "own-42",
    ownerThreadId: threadId,
    repoRoot: REPO,
    repoId: REPO,
    path: WT,
    branch: "fork-42",
    baseSha: "HEAD",
    now: 1,
  })
  if (state === "creating") return intent
  const ready = transitionWorkspaceState(intent, "ready", 2)
  if (!ready.ok) throw new Error("ready transition failed")
  if (state === "ready") return ready.record
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

describe("RFC06-2 cwd pin — real turn-boundary composition", () => {
  let sessionsDir: string

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wcp-hg-"))
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

  const persist = async (id: string, state: WorkspaceOwnershipState): Promise<void> => {
    const meta: SessionMeta = {
      id,
      title: "t",
      cwd: REPO,
      createdAt: 1,
      lastTouched: 1,
      archived: false,
      workspaceOwnership: ownershipIn(state, id),
    }
    await saveSessionById(meta, { reason: "t", turns: 0, messages: [] })
  }

  const drive = async (args: {
    readonly id: string
    readonly port: WorktreeCwdPort
    readonly timeline: string[]
    readonly gate?: boolean
  }): Promise<void> => {
    if (args.gate === true) process.env[PIN] = "1"
    await driveSessionTurn({
      env: { ...process.env },
      session: timelineSession(args.timeline),
      resolveApproval: async () => "approve",
      text: "go",
      turnSignal: new AbortController().signal,
      sessionId: args.id,
      cwdPin: args.port,
    })
  }

  test("H7 paired control — healthy `ready` + gate ON ⇒ the pin DOES fire", async () => {
    await persist("s-ok", "ready")
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await drive({ id: "s-ok", port, timeline, gate: true })
    expect(timeline).toEqual([`chdir:${WT}`, "append", "turn.run"])
    expect(port.here).toBe(WT)
  })

  test("H1 gate-OFF ⇒ zero chdir, timeline byte-identical to no-pin", async () => {
    await persist("s-off", "ready")
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await drive({ id: "s-off", port, timeline })
    expect(timeline).toEqual(["append", "turn.run"])
    expect(port.here).toBe(REPO)
  })

  test("H2 `active` ownership pins at the front door", async () => {
    await persist("s-active", "active")
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await drive({ id: "s-active", port, timeline, gate: true })
    expect(timeline).toEqual([`chdir:${WT}`, "append", "turn.run"])
  })

  test.each([
    ["creating"],
    ["closing"],
    ["removed"],
  ] as const)("H3 `%s` ownership never pins", async (state) => {
    const id = `s-${state}`
    await persist(id, state as WorkspaceOwnershipState)
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await drive({ id, port, timeline, gate: true })
    expect(timeline).toEqual(["append", "turn.run"])
    expect(port.here).toBe(REPO)
  })

  test("H4 a THROWING chdir does not fail the turn", async () => {
    await persist("s-throw", "ready")
    const timeline: string[] = []
    const port = throwingPort(timeline)
    // The turn must still run to completion — the pin is fail-soft by design.
    await drive({ id: "s-throw", port, timeline, gate: true })
    expect(timeline).toEqual([`chdir-attempt:${WT}`, "append", "turn.run"])
    // and the cwd was not left half-moved
    expect(port.here).toBe(REPO)
  })

  test("H5 a corrupt session store does not pin and does not fail the turn", async () => {
    await persist("s-corrupt", "ready")
    // Corrupt the persisted meta so the loader cannot resolve ownership.
    writeFileSync(join(sessionsDir, "s-corrupt.json"), "{ not json", "utf8")
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await drive({ id: "s-corrupt", port, timeline, gate: true })
    expect(timeline).toEqual(["append", "turn.run"])
    expect(port.here).toBe(REPO)
  })
})

describe("RFC06-2 cwd pin — loader THROWS (the real catch branch)", () => {
  afterEach(() => {
    mock.restore()
    delete process.env[PIN]
    __resetRuntimeConfig()
  })

  test("H6 a throwing loader is absorbed; the turn still completes", async () => {
    // `readSavedSession` swallows read/JSON errors and returns undefined, so a
    // corrupt file (H5) exercises the "no target" branch. To reach the wire's
    // own `catch` the loader itself must throw.
    const real = await import("@/session")
    // A PLAIN COPY taken BEFORE the mock: `real` is a live module namespace, so
    // spreading it after `mock.module` would spread the MOCKED exports and the
    // "restore" would reinstall the thrower.
    const realExports = { ...real }
    // `mock.module` is PROCESS-GLOBAL and `mock.restore()` does not undo it, so
    // this override has to be reverted explicitly — otherwise every later file
    // in the run that loads a session gets "store exploded" (it took out 112
    // tests across the session/rewind/fork/worktree suites before this
    // `finally` existed).
    mock.module("@/session", () => ({
      ...realExports,
      loadSessionById: async () => {
        throw new Error("store exploded")
      },
    }))
    try {
      const { driveSessionTurn: freshDrive } = await import("@/runner/orchestrate")

      process.env[PIN] = "1"
      const timeline: string[] = []
      const port = recordingPort(timeline)
      await freshDrive({
        env: { ...process.env },
        session: timelineSession(timeline),
        resolveApproval: async () => "approve",
        text: "go",
        turnSignal: new AbortController().signal,
        sessionId: "s-boom",
        cwdPin: port,
      })
      expect(timeline).toEqual(["append", "turn.run"])
      expect(port.here).toBe(REPO)
    } finally {
      mock.module("@/session", () => realExports)
    }
  })
})
