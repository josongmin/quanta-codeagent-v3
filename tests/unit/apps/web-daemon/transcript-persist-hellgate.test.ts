/**
 * ★ HELLGATE — P1 Phase 1 (jul-11): the daemon persists a LOSSLESS transcript.
 *
 * The daemon already archives SessionEvent[] to sqlite (UI history, tool
 * args/results truncated to ~256 chars). For a later live thread SWAP it also
 * needs the FULL Message[] — persisted to the @/session SavedSession store the
 * CLI uses, so `loadSessionById` round-trips it with zero truncation. This
 * subscribes to `turn.completed` and saves the live transcript
 * (session.transcript.messages() — the Phase 0 read seam).
 *
 * Gate-symmetric with QUANTA_WEB_DB: OFF ⇒ no SavedSession writes (byte-ident).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attachTranscriptPersistence } from "@/apps/web-daemon/server/transcript-persist"
import type { Message } from "@/llm"
import type { SessionEvent } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { loadSessionById } from "@/session"

const provider = (root: string) => ({ resolve: async () => root })

const msgs: Message[] = [
  { role: "user", content: [{ type: "text", text: "run the big bash" }] } as never,
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "x".repeat(500) } }],
  } as never,
]

/** A fake RuntimeSession exposing just what the persistence wire needs: an
 *  event subscribe + the Phase-0 lossless transcript read. `transcriptRef` lets
 *  a swap test flip what `transcript.messages()` returns (mimicking a
 *  `transcript.replace` on the live session). */
const fakeSession = (
  id: string,
  transcriptRef: { messages: Message[] } = { messages: msgs },
): RuntimeSession & { emit: (e: SessionEvent) => void } => {
  const subs: ((e: SessionEvent) => void)[] = []
  return {
    sessionId: id,
    subscribe: (cb: (e: SessionEvent) => void) => {
      subs.push(cb)
      return () => undefined
    },
    transcript: { messages: () => transcriptRef.messages, replace: async () => ({}) as never },
    emit: (e: SessionEvent) => {
      for (const s of subs) s(e)
    },
  } as never
}

const turnCompleted = (): SessionEvent =>
  ({ type: "turn.completed", eventId: "e1", seq: 1, revision: 1, emittedAt: 0 }) as never

let root: string | null = null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-transcript-"))
})
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

describe("HELLGATE P1 Phase 1 — daemon lossless transcript persistence", () => {
  test("a completed turn writes a SavedSession that round-trips messages LOSSLESSLY", async () => {
    const session = fakeSession("web-1")
    const wire = attachTranscriptPersistence(session, {
      enabled: true,
      rootProvider: provider(root ?? ""),
      cwd: "/repo",
    })
    session.emit(turnCompleted())
    await wire.flush()
    const saved = await loadSessionById("web-1", provider(root ?? ""))
    expect(saved).toBeDefined()
    // The 500-char tool arg survives — NOT truncated like the SessionEvent archive.
    const toolUse = saved?.messages[1]?.content[0] as { input: { cmd: string } }
    expect(toolUse.input.cmd.length).toBe(500)
    expect(saved?.messages).toEqual(msgs)
    wire.unsub()
  })

  test("gate OFF ⇒ NO SavedSession write (byte-identical)", async () => {
    const session = fakeSession("web-2")
    const wire = attachTranscriptPersistence(session, {
      enabled: false,
      rootProvider: provider(root ?? ""),
      cwd: "/repo",
    })
    session.emit(turnCompleted())
    await wire.flush()
    expect(await loadSessionById("web-2", provider(root ?? ""))).toBeUndefined()
    wire.unsub()
  })

  // ★ THE RISKIEST SEAM (plan §Riskiest step): the Phase-2 swap repoints the
  // append id via setActiveThreadId. This pins that a repoint actually MOVES
  // future writes to the new thread AND leaves the parent thread on disk intact
  // — a no-op setActiveThreadId (or a save that ignored the cell) would silently
  // corrupt history under the original id. Both isolated-unit tests miss this.
  test("setActiveThreadId REPOINTS future writes; the parent thread stays intact", async () => {
    const parentMsgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "parent turn" }] } as never,
    ]
    const swappedMsgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "swapped-in thread body" }] } as never,
    ]
    const ref = { messages: parentMsgs }
    const session = fakeSession("parent-1", ref)
    const wire = attachTranscriptPersistence(session, {
      enabled: true,
      rootProvider: provider(root ?? ""),
      cwd: "/repo",
    })

    // Turn under the ORIGINAL (parent) id.
    session.emit(turnCompleted())
    await wire.flush()

    // Phase-2 swap: replace live transcript + repoint the append id.
    ref.messages = swappedMsgs
    wire.setActiveThreadId("thread-B")
    expect(wire.activeThreadId()).toBe("thread-B")

    // Next completed turn must land under thread-B, NOT parent-1.
    session.emit(turnCompleted())
    await wire.flush()

    const swapped = await loadSessionById("thread-B", provider(root ?? ""))
    expect(swapped?.messages).toEqual(swappedMsgs)

    // The parent thread on disk is UNTOUCHED by the swapped turn (no clobber).
    const parent = await loadSessionById("parent-1", provider(root ?? ""))
    expect(parent?.messages).toEqual(parentMsgs)
    wire.unsub()
  })

  test("non-turn.completed events do not write", async () => {
    const session = fakeSession("web-3")
    const wire = attachTranscriptPersistence(session, {
      enabled: true,
      rootProvider: provider(root ?? ""),
      cwd: "/repo",
    })
    session.emit({
      type: "turn.started",
      prompt: "hi",
      eventId: "e",
      seq: 1,
      revision: 1,
      emittedAt: 0,
    } as never)
    await wire.flush()
    expect(await loadSessionById("web-3", provider(root ?? ""))).toBeUndefined()
    wire.unsub()
  })
})
