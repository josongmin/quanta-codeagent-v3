import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import {
  forkSession,
  loadSessionById,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * SERDE hellgate — ToolResultBlock.contentBlocks must survive the save/load
 * round-trip LOSSLESSLY. A tool_result carrying a structured payload
 * `[{type:"text"}, ImageBlock, DocumentBlock]` (produced live by dispatch's
 * composeToolResultContent for read_image / web_fetch) was being stripped on
 * resume because store.ts's toolResultBlockSchema omitted the field and zod
 * z.object() drops unknown keys. This proves the visual payload survives both
 * --resume (loadSessionById) AND forkSession (which re-saves loaded messages).
 *
 * ANTI-THEATER: against the unfixed schema, `loaded.messages` would carry a
 * tool_result with NO contentBlocks key, so the deepEqual below fails.
 */
const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-cb",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

// A user turn whose message carries a tool_result with a multimodal
// contentBlocks payload: text + image + document — exactly the shape
// composeToolResultContent emits at dispatch.ts.
const messagesWithContentBlocks = (): Message[] => [
  {
    role: "assistant",
    content: [
      { type: "text", text: "calling read_image" },
      // The matching `tool_use` for `call-1` MUST be present so the transcript
      // is model-valid (every `tool_result` needs a preceding `tool_use`).
      // forkSession/rewindToMessage now run `reconcileToolPairing` (B4 jun-04),
      // which DROPS orphan tool_results; a valid pair is a no-op (same ref), so
      // the lossless-contentBlocks assertion still holds AND this fixture now
      // also proves the reconcile pass never corrupts a well-formed fork.
      { type: "tool_use", id: "call-1", name: "read_image", input: {} },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "Image attached (preview text)",
        contentBlocks: [
          { type: "text", text: "Image attached (preview text)" },
          { type: "image", data: "AAAA-base64-png", mediaType: "image/png" },
          { type: "document", data: "JVBERi0-base64-pdf", mediaType: "application/pdf" },
        ],
      },
    ],
  },
]

const mkPayload = (messages: Message[]): SavePayload => ({
  reason: "completed",
  turns: 1,
  messages,
})

describe("session store — tool_result contentBlocks lossless round-trip (hellgate)", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-cb-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("save + load preserves tool_result.contentBlocks (text + image + document)", async () => {
    const input = messagesWithContentBlocks()
    await saveSessionById(mkMeta({ id: "cb-1" }), mkPayload(input))
    const loaded = await loadSessionById("cb-1")
    expect(loaded).toBeDefined()
    // Lossless: every block (incl. the structured contentBlocks payload) must
    // come back byte-for-byte identical to what was persisted.
    expect(loaded?.messages).toEqual(input)
  })

  test("contentBlocks survives forkSession (loaded messages re-persisted)", async () => {
    const input = messagesWithContentBlocks()
    await saveSessionById(mkMeta({ id: "cb-src" }), mkPayload(input))
    const forkedId = await forkSession("cb-src")
    const forked = await loadSessionById(forkedId)
    expect(forked).toBeDefined()
    expect(forked?.messages).toEqual(input)
  })

  test("absent contentBlocks stays absent (exactOptional — no synthesized key)", async () => {
    const input: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "plain output" }],
      },
    ]
    await saveSessionById(mkMeta({ id: "cb-plain" }), mkPayload(input))
    const loaded = await loadSessionById("cb-plain")
    const block = loaded?.messages[0]?.content[0]
    expect(block).toBeDefined()
    expect(block && "contentBlocks" in block).toBe(false)
  })
})
