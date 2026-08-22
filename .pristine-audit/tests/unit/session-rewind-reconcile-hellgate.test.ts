/**
 * B4 follow-up (jun-04) — WRITE-path tool-pair reconciliation, store-level
 * adversarial cases.
 *
 * Complements the e2e battery (`session-rewind-reconcile-e2e-hellgate`) with
 * the edge / no-op / propagation cases at the store boundary:
 *   - rewind truncation that creates an orphan → repaired on disk
 *   - no-orphan truncation → unchanged (no spurious placeholder)
 *   - fork of a dangling tail → repaired; fork of a clean tail → unchanged
 *   - edge cases (empty transcript, idx at the LAST message, unknown id,
 *     missing session) → never throw, removed:0 where applicable
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import {
  forkSession,
  loadSessionById,
  rewindToMessage,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig, RECONCILE_PLACEHOLDER_TEXT } from "@/shared"

const meta = (id: string, archived = false): SessionMeta => ({
  id,
  title: "T",
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived,
})

const payload = (messages: Message[]): SavePayload => ({
  reason: "completed",
  turns: 1,
  messages,
})

const lastBlock = (m: Message | undefined): Message["content"][number] | undefined =>
  Array.isArray(m?.content) ? m?.content.at(-1) : undefined

/** Count placeholder stub messages (synthesized tool_result with the marker). */
const countStubs = (messages: readonly Message[]): number =>
  messages.filter(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result" && b.content === RECONCILE_PLACEHOLDER_TEXT),
  ).length

describe("B4 store-level — rewind/fork apply reconcileToolPairing", () => {
  let dir: string
  let snap: NodeJS.ProcessEnv

  beforeEach(() => {
    snap = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "rewind-reconcile-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in snap)) delete process.env[k]
    Object.assign(process.env, snap)
    __resetRuntimeConfig()
  })

  test("rewind truncating a result block out → exactly one placeholder appended", async () => {
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
      },
      {
        id: "b",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }],
      },
    ]
    await saveSessionById(meta("rw"), payload(messages))
    const { removed } = await rewindToMessage("rw", "a")
    expect(removed).toBe(1)
    const loaded = await loadSessionById("rw")
    expect(countStubs(loaded?.messages ?? [])).toBe(1)
    const tail = lastBlock(loaded?.messages.at(-1))
    expect(tail?.type).toBe("tool_result")
  })

  test("rewind that does not split any pair → zero placeholders, prefix preserved", async () => {
    const messages: Message[] = [
      { id: "m0", role: "user", content: [{ type: "text", text: "x" }] },
      { id: "m1", role: "assistant", content: [{ type: "text", text: "y" }] },
      { id: "m2", role: "user", content: [{ type: "text", text: "z" }] },
    ]
    await saveSessionById(meta("rw-clean"), payload(messages))
    const { removed } = await rewindToMessage("rw-clean", "m0")
    expect(removed).toBe(2)
    const loaded = await loadSessionById("rw-clean")
    expect(countStubs(loaded?.messages ?? [])).toBe(0)
    expect(loaded?.messages).toEqual(messages.slice(0, 1))
  })

  test("rewind to the LAST message → removed:0, file untouched (no reconcile pass needed)", async () => {
    const messages: Message[] = [
      { id: "m0", role: "user", content: [{ type: "text", text: "x" }] },
      {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "c9", name: "n", input: {} }],
      },
    ]
    await saveSessionById(meta("rw-last"), payload(messages))
    // Rewinding to the last id removes nothing → early return, no rewrite.
    const { removed } = await rewindToMessage("rw-last", "m1")
    expect(removed).toBe(0)
    const loaded = await loadSessionById("rw-last")
    expect(loaded?.messages).toEqual(messages)
  })

  test("rewind unknown id / missing session / empty transcript → removed:0, no throw", async () => {
    await saveSessionById(meta("rw-e"), payload([]))
    expect((await rewindToMessage("rw-e", "nope")).removed).toBe(0)
    expect((await rewindToMessage("does-not-exist", "x")).removed).toBe(0)
    const nonEmpty: Message[] = [{ id: "z", role: "user", content: [{ type: "text", text: "q" }] }]
    await saveSessionById(meta("rw-u"), payload(nonEmpty))
    expect((await rewindToMessage("rw-u", "missing-id")).removed).toBe(0)
  })

  test("fork propagating a dangling tail → forked file repaired (one placeholder)", async () => {
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: [{ type: "tool_use", id: "cx", name: "n", input: {} }],
      },
    ]
    await saveSessionById(meta("fk"), payload(messages))
    const newId = await forkSession("fk")
    const forked = await loadSessionById(newId)
    expect(countStubs(forked?.messages ?? [])).toBe(1)
  })

  test("fork of a clean source → zero placeholders, messages identical to source", async () => {
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: [{ type: "tool_use", id: "cy", name: "n", input: {} }],
      },
      {
        id: "b",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "cy", content: "ok" }],
      },
    ]
    await saveSessionById(meta("fk-clean"), payload(messages))
    const newId = await forkSession("fk-clean")
    const forked = await loadSessionById(newId)
    expect(countStubs(forked?.messages ?? [])).toBe(0)
    expect(forked?.messages).toEqual(messages)
  })

  test("fork of an empty source → no throw, empty messages preserved", async () => {
    await saveSessionById(meta("fk-empty"), payload([]))
    const newId = await forkSession("fk-empty")
    const forked = await loadSessionById(newId)
    expect(forked?.messages).toEqual([])
  })

  test("orphan tool_result already on disk → rewind drops it (write-path also cleans pre-existing rot)", async () => {
    // A result with NO preceding use is itself a 400; it should be dropped when
    // the surviving prefix is reconciled on write.
    const messages: Message[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "q" }] },
      {
        id: "u1",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "ghost", content: "stale" }],
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "tail" }] },
    ]
    await saveSessionById(meta("rw-orphan"), payload(messages))
    // Rewind to u1 → prefix [u0, u1]; u1's orphan result is dropped, and the
    // now-empty u1 message is dropped too → only [u0] survives.
    const { removed } = await rewindToMessage("rw-orphan", "u1")
    expect(removed).toBe(1)
    const loaded = await loadSessionById("rw-orphan")
    const hasOrphan = (loaded?.messages ?? []).some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "ghost"),
    )
    expect(hasOrphan).toBe(false)
  })
})
