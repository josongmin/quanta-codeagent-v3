/**
 * B4 follow-up (jun-04) — WRITE-path tool-pair reconciliation, END-TO-END.
 *
 * Proves the ON-DISK session file written by `rewindToMessage` / `forkSession`
 * is model-valid (no dangling `tool_use`↔`tool_result` pair) by driving the
 * real store against a tmp `QUANTA_SESSIONS_DIR`, then RELOADING the persisted
 * file from disk and asserting the transcript is paired.
 *
 * This is the defense-in-depth half of B4: the resume-READ path already cleans
 * on the way out, but rewind truncates EXACTLY where a pair gets split, and
 * fork propagates a dangling tail — so the stored file must be valid the
 * instant it is written (a crash/external read between write and resume must
 * not surface an Anthropic/OpenAI 400).
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

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "s1",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

const payload = (messages: Message[], turns = 1): SavePayload => ({
  reason: "completed",
  turns,
  messages,
})

/** True iff every `tool_use` id has a downstream `tool_result` AND every
 *  `tool_result` references a preceding `tool_use` — the exact model-validity
 *  predicate both Anthropic and OpenAI enforce (a 400 otherwise). */
const isModelValid = (messages: readonly Message[]): boolean => {
  const seen = new Set<string>()
  const satisfied = new Set<string>()
  const allUseIds: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "tool_use") {
        seen.add(b.id)
        allUseIds.push(b.id)
      } else if (b.type === "tool_result") {
        if (!seen.has(b.tool_use_id)) return false // orphan result
        satisfied.add(b.tool_use_id)
      }
    }
  }
  return allUseIds.every((id) => satisfied.has(id)) // every use satisfied
}

describe("B4 e2e — WRITE-path tool-pair reconciliation persists a valid file", () => {
  let dir: string
  let snap: NodeJS.ProcessEnv

  beforeEach(() => {
    snap = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "rewind-reconcile-e2e-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in snap)) delete process.env[k]
    Object.assign(process.env, snap)
    __resetRuntimeConfig()
  })

  test("rewind that SPLITS a pair → persisted file has a placeholder result, NOT a dangling tool_use", async () => {
    // assistant calls a tool (msg id "a"); the result arrives in the NEXT
    // message ("b"). Rewinding TO "a" truncates "b" away → orphan tool_use.
    const messages: Message[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "do it" }] },
      {
        id: "a",
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call-1", name: "read", input: {} },
        ],
      },
      {
        id: "b",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
      },
    ]
    await saveSessionById(meta({ id: "rw1" }), payload(messages))

    const { removed } = await rewindToMessage("rw1", "a")
    expect(removed).toBe(1) // "b" truncated

    const reloaded = await loadSessionById("rw1")
    if (!reloaded) throw new Error("session vanished after rewind")
    // The dangling tool_use got a synthesized placeholder result ON DISK.
    expect(isModelValid(reloaded.messages)).toBe(true)
    const stub = reloaded.messages.at(-1)
    const block = Array.isArray(stub?.content) ? stub?.content[0] : undefined
    expect(block?.type).toBe("tool_result")
    if (block?.type === "tool_result") {
      expect(block.tool_use_id).toBe("call-1")
      expect(block.content).toBe(RECONCILE_PLACEHOLDER_TEXT)
    }
  })

  test("rewind that does NOT split a pair → persisted messages byte-identical to truncation (no spurious placeholder)", async () => {
    const messages: Message[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "q1" }] },
      { id: "a0", role: "assistant", content: [{ type: "text", text: "a1" }] },
      { id: "u1", role: "user", content: [{ type: "text", text: "q2" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "a2" }] },
    ]
    await saveSessionById(meta({ id: "rw2" }), payload(messages))

    const { removed } = await rewindToMessage("rw2", "a0")
    expect(removed).toBe(2)

    const reloaded = await loadSessionById("rw2")
    if (!reloaded) throw new Error("session vanished after rewind")
    // Exactly the truncation prefix — no synthesized message appended.
    expect(reloaded.messages).toEqual(messages.slice(0, 2))
    expect(isModelValid(reloaded.messages)).toBe(true)
  })

  test("fork of a session whose tail dangles → forked file on disk is model-valid", async () => {
    // Source persisted with a dangling tool_use (no following result).
    const dangling: Message[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "go" }] },
      {
        id: "a0",
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "call-x", name: "exec", input: {} },
        ],
      },
    ]
    await saveSessionById(meta({ id: "fk-src" }), payload(dangling))

    const newId = await forkSession("fk-src")
    const forked = await loadSessionById(newId)
    if (!forked) throw new Error("fork did not produce a loadable session")
    expect(isModelValid(forked.messages)).toBe(true)
    const stub = forked.messages.at(-1)
    const block = Array.isArray(stub?.content) ? stub?.content[0] : undefined
    expect(block?.type).toBe("tool_result")
    if (block?.type === "tool_result") expect(block.tool_use_id).toBe("call-x")
  })

  test("fork of a VALID session → forked messages byte-identical (no spurious placeholder)", async () => {
    const valid: Message[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "go" }] },
      {
        id: "a0",
        role: "assistant",
        content: [{ type: "tool_use", id: "call-y", name: "exec", input: {} }],
      },
      {
        id: "u1",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-y", content: "done" }],
      },
    ]
    await saveSessionById(meta({ id: "fk-valid" }), payload(valid))

    const newId = await forkSession("fk-valid")
    const forked = await loadSessionById(newId)
    if (!forked) throw new Error("fork did not produce a loadable session")
    expect(forked.messages).toEqual(valid)
    expect(isModelValid(forked.messages)).toBe(true)
  })
})
