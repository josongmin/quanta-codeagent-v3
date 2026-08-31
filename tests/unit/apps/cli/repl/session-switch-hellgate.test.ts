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
import { describe, expect, spyOn, test } from "bun:test"
import type { Message } from "@/llm"
import { asObjectiveAuthority, createObjectiveStore } from "@/objective"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
  type UsageProvenance,
} from "@/observability/usage-accounting"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"
import type { SessionMeta } from "@/session"
import { logger } from "@/shared"
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

const usageProvenance = (sessionId: string): UsageProvenance => ({
  sessionId,
  agentId: "root",
  agentKind: "root",
  depth: 0,
})

const admitUsage = (accounting: UsageAccountingPort, sessionId: string, inputTokens: number) => {
  const provenance = usageProvenance(sessionId)
  const usage = normalizeUsage({
    model: "claude-sonnet-4-6",
    inputTokens,
    outputTokens: 0,
  })
  return accounting.record({
    callId: accounting.mintCallId(provenance),
    at: 1,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    provenance,
  })
}

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

  test("attach replaces usage books with the target and rebinds future live calls", async () => {
    const live = createUsageAccounting()
    admitUsage(live, "runtime-live", 1_000_000)
    const target = createUsageAccounting()
    admitUsage(target, "target-old-runtime", 2_000_000)

    await performSessionSwitch(
      {
        loadSession: async () => ({
          meta: mkMeta("fork"),
          messages: forkMsgs,
          usageAccounting: target.serialize(),
        }),
        replaceTranscript: async (messages) => messages,
        idMeta: mkMeta("parent"),
        usageAccounting: live,
        runtimeSessionId: "runtime-live",
        commit: () => undefined,
      },
      "fork",
    )

    expect(live.snapshot().calls).toBe(1)
    expect(live.snapshot().freshInputTokens).toBe(2_000_000)
    expect(live.snapshot().boundSessionId).toBe("runtime-live")
    expect(admitUsage(live, "runtime-live", 3_000_000)).toEqual({ admitted: true })
    expect(live.snapshot().freshInputTokens).toBe(5_000_000)
  })

  test("attaching a fresh fork with no durable books resets the parent totals", async () => {
    const live = createUsageAccounting()
    admitUsage(live, "runtime-live", 1_000_000)
    await performSessionSwitch(
      {
        loadSession: async () => ({ meta: mkMeta("fork"), messages: forkMsgs }),
        replaceTranscript: async (messages) => messages,
        idMeta: mkMeta("parent"),
        usageAccounting: live,
        runtimeSessionId: "runtime-live",
        commit: () => undefined,
      },
      "fork",
    )
    expect(live.snapshot()).toMatchObject({ calls: 0, totalUsd: 0, continuityLost: false })
  })

  test("usage restore is fully prepared before transcript and persistence switch", async () => {
    const live = createUsageAccounting()
    const target = createUsageAccounting()
    admitUsage(live, "runtime-live", 1_000_000)
    admitUsage(target, "old-runtime", 2_000_000)
    const blob = target.serialize()
    const idMeta = mkMeta("parent")
    const parse = spyOn(JSON, "parse")
    try {
      await performSessionSwitch(
        {
          loadSession: async () => ({
            meta: mkMeta("fork"),
            messages: forkMsgs,
            usageAccounting: blob,
          }),
          replaceTranscript: async (messages) => {
            expect(parse).toHaveBeenCalledWith(blob)
            expect(live.snapshot().totalUsd).toBe(3)
            expect(idMeta.id).toBe("parent")
            parse.mockImplementation(() => {
              throw new Error("late accounting decode")
            })
            return messages
          },
          idMeta,
          usageAccounting: live,
          runtimeSessionId: "runtime-live",
          commit: () => undefined,
        },
        "fork",
      )
    } finally {
      parse.mockRestore()
    }
    expect(live.snapshot()).toMatchObject({ totalUsd: 6, boundSessionId: "runtime-live" })
  })

  test("corrupt attach warns only after success; refusals preserve books and stay silent", async () => {
    const live = createUsageAccounting()
    admitUsage(live, "runtime-live", 1_000_000)
    const before = live.serialize()
    const idMeta = mkMeta("parent")
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
    const deps = {
      loadSession: async () => ({
        meta: mkMeta("fork"),
        messages: forkMsgs,
        usageAccounting: "{ corrupt",
      }),
      replaceTranscript: async (messages: readonly Message[]) => messages,
      idMeta,
      usageAccounting: live,
      runtimeSessionId: "runtime-live",
      commit: () => undefined,
    }
    try {
      await expect(
        performSessionSwitch(
          {
            ...deps,
            replaceTranscript: async () => {
              throw new Error("transcript_replace_unavailable")
            },
          },
          "fork",
        ),
      ).rejects.toThrow("transcript_replace_unavailable")
      await expect(
        performSessionSwitch({ ...deps, loadSession: async () => undefined }, "ghost"),
      ).rejects.toThrow("session not found")
      expect(live.serialize()).toBe(before)
      expect(idMeta.id).toBe("parent")
      expect(warn).not.toHaveBeenCalled()
      await performSessionSwitch(deps, "fork")
      expect(live.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
      expect(idMeta.id).toBe("fork")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain("usage accounting state was corrupt")
    } finally {
      warn.mockRestore()
    }
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

  test("mid-turn refusal leaves the current usage books unchanged", async () => {
    const live = createUsageAccounting()
    admitUsage(live, "runtime-live", 1_000_000)
    const target = createUsageAccounting()
    admitUsage(target, "target-old-runtime", 2_000_000)
    await expect(
      performSessionSwitch(
        {
          loadSession: async () => ({
            meta: mkMeta("fork"),
            messages: forkMsgs,
            usageAccounting: target.serialize(),
          }),
          replaceTranscript: async () => {
            throw new Error("transcript_replace_unavailable")
          },
          idMeta: mkMeta("parent"),
          usageAccounting: live,
          runtimeSessionId: "runtime-live",
          commit: () => undefined,
        },
        "fork",
      ),
    ).rejects.toThrow("transcript_replace_unavailable")
    expect(live.snapshot().freshInputTokens).toBe(1_000_000)
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
