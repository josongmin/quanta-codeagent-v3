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
 *  event subscribe + the Phase-0 lossless transcript read. */
const fakeSession = (id: string): RuntimeSession & { emit: (e: SessionEvent) => void } => {
  const subs: ((e: SessionEvent) => void)[] = []
  return {
    sessionId: id,
    subscribe: (cb: (e: SessionEvent) => void) => {
      subs.push(cb)
      return () => undefined
    },
    transcript: { messages: () => msgs, replace: async () => ({}) as never },
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
