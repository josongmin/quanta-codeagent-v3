/**
 * UUX-4-07 hellgate — the session-switch seam internals.
 *
 * Two leaves under test:
 *
 *   1. `performSessionSwitch` (session-loop side): load fork → swap the live
 *      kernel transcript → commit surface state → repoint the ALIASED
 *      `SessionMeta` the runtime facade persists through. Ordering is the
 *      crown invariant: a rejecting swap must leave surface state AND the
 *      persist identity untouched (disk-vs-live honesty).
 *
 *   2. `createSessionSwitchWire` (surface side): the late-install slot the
 *      loop registers into (mirrors registerReplaceMessages), exposing a live
 *      `sessionId()` so `/rewind`/`/fork` keep addressing the CURRENT session
 *      after a switch.
 *
 *   3. `repointSessionMeta`: in-place mirror (same object identity — the
 *      aliasing IS the mechanism; a new object would silently detach the
 *      facade's persist target).
 */
import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { asObjectiveAuthority, createObjectiveStore } from "@/objective"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"
import type { SessionMeta } from "@/session"
import {
  performSessionSwitch,
  repointSessionMeta,
} from "../../../../../src/apps/cli/repl/session-loop/session-switch"
import { createSessionSwitchWire } from "../../../../../src/apps/cli/repl/session-switch-wire"

const mkMeta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `title-${id}`,
  cwd: "/tmp/w",
  createdAt: 1,
  lastTouched: 2,
  archived: false,
  ...extra,
})

const mkMsg = (id: string): Message => ({
  role: "user",
  content: [{ type: "text", text: id }],
  id,
})

/* ------------------------------------------------------------------ */
/* repointSessionMeta                                                  */
/* ------------------------------------------------------------------ */

describe("repointSessionMeta", () => {
  test("mutates IN PLACE (same identity), mirrors fields, drops stale keys", () => {
    const target = mkMeta("parent", { gitSha: "stale-sha", forkedFromId: "grandparent" })
    const next = mkMeta("fork", { forkedFromId: "parent" })
    const before = target
    repointSessionMeta(target, next)
    expect(target).toBe(before) // identity preserved — the aliasing contract
    expect(target.id).toBe("fork")
    expect(target.title).toBe("title-fork")
    expect(target.forkedFromId).toBe("parent")
    // stale optional key not present on `next` is REMOVED (full mirror)
    expect("gitSha" in target).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* performSessionSwitch                                                */
/* ------------------------------------------------------------------ */

describe("performSessionSwitch", () => {
  const forkMsgs = [mkMsg("m0"), mkMsg("m1")]

  test("happy path: load → swap → commit → repoint; receipt says fork-id", async () => {
    const idMeta = mkMeta("parent")
    const commits: Array<{ sessionId: string; history: readonly Message[] }> = []
    const swapped: Array<readonly Message[]> = []
    const receipt = await performSessionSwitch(
      {
        loadSession: async (id) =>
          id === "fork" ? { meta: mkMeta("fork"), messages: forkMsgs } : undefined,
        replaceTranscript: async (msgs) => {
          swapped.push(msgs)
          return msgs
        },
        idMeta,
        commit: (next) => commits.push(next),
      },
      "fork",
    )
    expect(swapped.length).toBe(1)
    expect(commits).toEqual([{ sessionId: "fork", history: forkMsgs }])
    expect(idMeta.id).toBe("fork") // persist identity repointed in place
    expect(receipt.persistTarget).toBe("fork-id")
    expect(receipt.persistNote).toContain("fork")
  })

  test("swap REJECTS ⇒ propagates; commit NOT called; idMeta untouched", async () => {
    const idMeta = mkMeta("parent")
    const commits: unknown[] = []
    await expect(
      performSessionSwitch(
        {
          loadSession: async () => ({ meta: mkMeta("fork"), messages: forkMsgs }),
          replaceTranscript: async () => {
            throw new Error("transcript_replace_unavailable")
          },
          idMeta,
          commit: (n) => commits.push(n),
        },
        "fork",
      ),
    ).rejects.toThrow("transcript_replace_unavailable")
    expect(commits.length).toBe(0)
    expect(idMeta.id).toBe("parent")
  })

  test("fork session missing on disk ⇒ throws; swap never attempted", async () => {
    const swapped: unknown[] = []
    await expect(
      performSessionSwitch(
        {
          loadSession: async () => undefined,
          replaceTranscript: async (msgs) => {
            swapped.push(msgs)
            return msgs
          },
          idMeta: undefined,
          commit: () => {},
        },
        "ghost",
      ),
    ).rejects.toThrow("ghost")
    expect(swapped.length).toBe(0)
  })

  test("idMeta absent (non-id-mode surface) ⇒ receipt is honest about persistence", async () => {
    const receipt = await performSessionSwitch(
      {
        loadSession: async () => ({ meta: mkMeta("fork"), messages: forkMsgs }),
        replaceTranscript: async (msgs) => msgs,
        idMeta: undefined,
        commit: () => {},
      },
      "fork",
    )
    expect(receipt.persistTarget).toBe("unchanged")
    expect(receipt.persistNote).toContain("--resume")
  })

  test("attach replaces objective generation and cancels/rearms wake around the crown", async () => {
    const store = createObjectiveStore()
    const authority = asObjectiveAuthority(store)
    store.create("parent", { goal: "parent goal" })
    const disk = createObjectiveStore()
    disk.create("fork", { goal: "fork goal" })
    const events: string[] = []
    const goalWakeSlot = {
      current: {
        onActivity: () => events.push("cancel"),
        onGoalMutation: () => events.push("rearm-parent"),
        onLocalInputSettled: () => {},
        onTurnSettled: () => {},
        onAttach: (id: string) => events.push(`attach:${id}`),
      },
    }
    await performSessionSwitch(
      {
        loadSession: async () => ({
          meta: mkMeta("fork"),
          messages: forkMsgs,
          objective: encodeObjectiveSnapshot(disk),
        }),
        replaceTranscript: async (msgs) => msgs,
        idMeta: mkMeta("parent"),
        currentSessionId: () => "parent",
        objectiveStore: store,
        goalWakeSlot,
        commit: () => {},
      },
      "fork",
    )
    expect(authority.readDomain("parent").state).toBeNull()
    expect(authority.readDomain("fork").state?.objective.goal).toBe("fork goal")
    expect(events).toEqual(["cancel", "attach:fork"])
  })

  test("mid-turn refusal leaves transcript-owned objective and persistence identity unchanged", async () => {
    const store = createObjectiveStore()
    store.create("parent", { goal: "parent goal" })
    const idMeta = mkMeta("parent")
    const commits: unknown[] = []
    await expect(
      performSessionSwitch(
        {
          loadSession: async () => ({ meta: mkMeta("fork"), messages: forkMsgs }),
          replaceTranscript: async () => {
            throw new Error("transcript_replace_unavailable")
          },
          idMeta,
          currentSessionId: () => "parent",
          objectiveStore: store,
          commit: (value) => commits.push(value),
        },
        "fork",
      ),
    ).rejects.toThrow("transcript_replace_unavailable")
    expect(store.get("parent")?.goal).toBe("parent goal")
    expect(store.get("fork")).toBeNull()
    expect(idMeta.id).toBe("parent")
    expect(commits).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* createSessionSwitchWire                                             */
/* ------------------------------------------------------------------ */

describe("createSessionSwitchWire", () => {
  test("not installed ⇒ switch throws honestly; sessionId stays initial", async () => {
    const wire = createSessionSwitchWire("parent")
    await expect(wire.switchSession("fork")).rejects.toThrow(/not installed|not available/i)
    expect(wire.sessionId()).toBe("parent")
  })

  test("installed ⇒ delegates; sessionId updates ONLY after a resolved switch", async () => {
    const wire = createSessionSwitchWire("parent")
    let observedDuring: string | undefined
    wire.setSwitchSession(async (id) => {
      observedDuring = wire.sessionId()
      return { sessionId: id, persistTarget: "fork-id", persistNote: "n" }
    })
    const receipt = await wire.switchSession("fork")
    expect(observedDuring).toBe("parent") // not yet swapped mid-flight
    expect(receipt.sessionId).toBe("fork")
    expect(wire.sessionId()).toBe("fork")
  })

  test("rejection propagates and sessionId is NOT advanced", async () => {
    const wire = createSessionSwitchWire("parent")
    wire.setSwitchSession(async () => {
      throw new Error("mid-turn")
    })
    await expect(wire.switchSession("fork")).rejects.toThrow("mid-turn")
    expect(wire.sessionId()).toBe("parent")
  })
})
