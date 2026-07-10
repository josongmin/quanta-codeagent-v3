/**
 * ★ HELLGATE — P1 Phase 2 (jul-11): swap the live session onto an opened thread.
 *
 * The daemon hosts ONE live session. Opening a persisted thread hydrates the
 * live session FROM that thread's lossless SavedSession (Phase 1) via
 * transcript.replace, then repoints future persistence to it (Phase 1's mutable
 * activeThreadId). Reuses the kernel's `transcript_replace_unavailable` guard:
 * a mid-turn swap is REFUSED, leaving live state untouched. Unknown thread ⇒
 * clean no-op (never a crash).
 */
import { describe, expect, test } from "bun:test"
import { hydrateThreadIntoLiveSession } from "@/apps/web-daemon/server/thread-hydrate"
import type { Message } from "@/llm"

const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] } as never]

describe("HELLGATE P1 Phase 2 — swap live session onto a thread", () => {
  test("persisted thread: replaces transcript + repoints the persist id", async () => {
    const replaced: (readonly Message[])[] = []
    let active: string | null = null
    const out = await hydrateThreadIntoLiveSession("t-abc", {
      loadThread: async (id) => (id === "t-abc" ? { messages: msgs } : undefined),
      replaceTranscript: async (m) => void replaced.push(m),
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "hydrated", threadId: "t-abc", count: 1 })
    expect(replaced).toEqual([msgs])
    expect(active).toBe("t-abc")
  })

  test("unknown thread: clean no-op (no replace, no repoint)", async () => {
    const replaced: unknown[] = []
    let active: string | null = null
    const out = await hydrateThreadIntoLiveSession("nope", {
      loadThread: async () => undefined,
      replaceTranscript: async (m) => void replaced.push(m),
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "unknown-thread", threadId: "nope" })
    expect(replaced).toEqual([])
    expect(active).toBeNull()
  })

  test("mid-turn: transcript_replace_unavailable ⇒ REFUSED, live state untouched", async () => {
    let active: string | null = null
    const out = await hydrateThreadIntoLiveSession("t-mid", {
      loadThread: async () => ({ messages: msgs }),
      replaceTranscript: async () => {
        throw new Error("transcript_replace_unavailable")
      },
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "refused-mid-turn", threadId: "t-mid" })
    expect(active).toBeNull() // NOT repointed — parent thread stays live
  })

  test("a non-guard error propagates (never silently swallowed)", async () => {
    await expect(
      hydrateThreadIntoLiveSession("t-x", {
        loadThread: async () => ({ messages: msgs }),
        replaceTranscript: async () => {
          throw new Error("disk exploded")
        },
        setActiveThreadId: () => undefined,
      }),
    ).rejects.toThrow("disk exploded")
  })
})
