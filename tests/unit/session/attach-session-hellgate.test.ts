/**
 * ★ HELLGATE — WS-1 (jul-11): the UNIFIED session-attach SSOT.
 *
 * CLI `performSessionSwitch` and web `hydrateThreadIntoLiveSession` were two
 * copies of the SAME crown-ordered op (load saved → guarded transcript.replace →
 * ordered surface/persist effects). This pins the shared core so BOTH surfaces
 * inherit ONE guard + ONE ordering. The surface-specific presentation (CLI
 * receipt / persistNote, web ws-response) stays surface-side — the core carries
 * the OPERATION, not the presentation (answering the leaky-abstraction critique).
 *
 * Crown invariant (must hold for every caller):
 *   load → (absent ⇒ unknown-session, nothing touched)
 *        → replace (transcript_replace_unavailable ⇒ refused-mid-turn, NOTHING
 *          repointed — the live turn keeps running on the parent)
 *        → onReplaced(history)  [before persist repoint]
 *        → setPersistTarget({id, meta})
 *        → attached
 */
import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import type { SessionMeta } from "@/session"
import { attachSessionToLive } from "@/session"

const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  cwd: "/repo",
  createdAt: 0,
  lastTouched: 0,
  archived: false,
})
const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] } as never]

describe("HELLGATE WS-1 — attachSessionToLive shared crown op", () => {
  test("attached: load → replace → onReplaced (BEFORE) → setPersistTarget; returns count", async () => {
    const order: string[] = []
    const persistTarget = { value: undefined as { id: string; meta: SessionMeta } | undefined }
    const out = await attachSessionToLive("s-1", {
      loadSession: async (id) => (id === "s-1" ? { meta: meta("s-1"), messages: msgs } : undefined),
      replaceTranscript: async (m) => {
        order.push("replace")
        return m
      },
      onReplaced: ({ history }) => {
        order.push(`onReplaced:${history.length}`)
      },
      setPersistTarget: (t) => {
        order.push("setPersistTarget")
        persistTarget.value = t
      },
    })
    expect(out).toEqual({ kind: "attached", sessionId: "s-1", messageCount: 1 })
    // ordering is load-bearing: onReplaced (surface commit) BEFORE persist repoint.
    expect(order).toEqual(["replace", "onReplaced:1", "setPersistTarget"])
    const repointed = persistTarget.value
    if (repointed === undefined) throw new Error("persist target was not repointed")
    expect(repointed).toEqual({ id: "s-1", meta: meta("s-1") })
  })

  test("unknown-session: absent load ⇒ NO replace, NO repoint, NO commit", async () => {
    const touched: string[] = []
    const out = await attachSessionToLive("ghost", {
      loadSession: async () => undefined,
      replaceTranscript: async (m) => {
        touched.push("replace")
        return m
      },
      onReplaced: () => touched.push("onReplaced"),
      setPersistTarget: () => touched.push("setPersistTarget"),
    })
    expect(out).toEqual({ kind: "unknown-session", sessionId: "ghost" })
    expect(touched).toEqual([])
  })

  test("refused-mid-turn: transcript_replace_unavailable ⇒ NOTHING repointed/committed", async () => {
    const touched: string[] = []
    const out = await attachSessionToLive("s-mid", {
      loadSession: async () => ({ meta: meta("s-mid"), messages: msgs }),
      replaceTranscript: async () => {
        throw new Error("transcript_replace_unavailable")
      },
      onReplaced: () => touched.push("onReplaced"),
      setPersistTarget: () => touched.push("setPersistTarget"),
    })
    expect(out).toEqual({ kind: "refused-mid-turn", sessionId: "s-mid" })
    expect(touched).toEqual([]) // live turn keeps running on the parent
  })

  test("a non-guard error propagates (never swallowed)", async () => {
    await expect(
      attachSessionToLive("s-x", {
        loadSession: async () => ({ meta: meta("s-x"), messages: msgs }),
        replaceTranscript: async () => {
          throw new Error("disk exploded")
        },
        setPersistTarget: () => undefined,
      }),
    ).rejects.toThrow("disk exploded")
  })

  test("onReplaced is OPTIONAL (web has no surface commit) — still repoints + attaches", async () => {
    const persistTarget = { id: undefined as string | undefined }
    const out = await attachSessionToLive("s-web", {
      loadSession: async () => ({ meta: meta("s-web"), messages: msgs }),
      replaceTranscript: async (m) => m,
      setPersistTarget: (t) => {
        persistTarget.id = t.id
      },
    })
    expect(out).toEqual({ kind: "attached", sessionId: "s-web", messageCount: 1 })
    if (persistTarget.id === undefined) throw new Error("persist target was not repointed")
    expect(persistTarget.id).toBe("s-web")
  })

  test("GOAL-07 rail 13 — the wake cancel edge (onAttachStart) fires BEFORE the transcript is replaced, and onAttachSettled after every owner moved", async () => {
    const order: string[] = []
    const outcome = await attachSessionToLive("B", {
      loadSession: async (id) => ({ meta: meta(id), messages: msgs }),
      onAttachStart: () => order.push("wake-cancel"),
      replaceTranscript: async (m) => {
        order.push("transcript")
        return m
      },
      onReplaced: () => order.push("replaced"),
      setPersistTarget: () => order.push("persist-target"),
      onAttached: () => order.push("attached"),
      onAttachSettled: () => order.push("settled"),
    })
    expect(outcome.kind).toBe("attached")
    expect(order).toEqual([
      "wake-cancel",
      "transcript",
      "replaced",
      "persist-target",
      "attached",
      "settled",
    ])
  })
})
