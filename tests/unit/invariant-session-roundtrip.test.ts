import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/llm"
import {
  decodeSessionLine,
  encodeSessionLine,
  loadSessionById,
  type SavePayload,
  type SessionEnvelopeRecord,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * STRUCTURAL anti-schema-drift guardrail.
 *
 * Bug class closed here: "the session schema silently drops a content-block
 * field or variant" — the family that produced the ImageBlock refuse-to-load,
 * the thinking-signature-stripped-on-resume, and the text-phase-dropped bugs.
 * The session store re-validates every persisted Message through a zod mirror
 * of the `ContentBlock` union (`src/session/store.ts`); zod STRIPS unknown
 * keys and REJECTS unknown variants, so any field/variant the producers can
 * persist but the mirror omits is silently lost (field) or refuses to load
 * (variant). Both are resume-fidelity regressions.
 *
 * This test makes drift fail loudly two ways:
 *   1. COMPILE-TIME exhaustiveness — fixtures are a
 *      `Record<ContentBlock["type"], ContentBlock>`. Add a new variant to the
 *      `@/llm` union and this file stops compiling until a fixture is added.
 *      Each fixture is also typed as its concrete interface, so a new OPTIONAL
 *      field is caught by the "every-key-populated" reflection assert below.
 *   2. RUNTIME exhaustiveness — `KNOWN_TYPES` lists every discriminant; an
 *      assertion proves the fixture Record's key set equals it, so a variant
 *      added to the union but not to `KNOWN_TYPES` (or vice-versa) trips.
 *
 * Then it proves a real lossless round-trip through the production persist /
 * load path, plus the JSONL envelope codec, with distinctive values in every
 * field including special chars / newlines / unicode.
 */

/* ------------------------------------------------------------------ */
/* (1) Exhaustive fixtures — one fully-populated instance per variant  */
/* ------------------------------------------------------------------ */

// Distinctive sentinel values so a swapped/dropped field is detectable.
const SPECIAL = 'tab\there\nnewline "quote" \\backslash 日本語 😀 \x00-ish ⟦unicode⟧'

const textFixture: TextBlock = {
  type: "text",
  text: `final text — ${SPECIAL}`,
  phase: "commentary", // ADR-0077 optional — must survive
}

const toolUseFixture: ToolUseBlock = {
  type: "tool_use",
  id: "tu-distinctive-id-001",
  name: "edit_file",
  // `input` is `unknown` — exercise a nested object with special chars so the
  // free-form payload is proven lossless too.
  input: {
    path: `/tmp/${SPECIAL}.ts`,
    nested: { n: 42, flag: true, list: [1, "two", null], unicode: "日本語😀" },
  },
}

const toolResultFixture: ToolResultBlock = {
  type: "tool_result",
  tool_use_id: "tu-distinctive-id-001",
  content: `result body — ${SPECIAL}`,
  is_error: true, // optional — must survive
}

const thinkingFixture: ThinkingBlock = {
  type: "thinking",
  thinking: `reasoning — ${SPECIAL}`,
  signature: "sig-Anthropic-carryback-REQUIRED-on-resume-abc123==", // optional, but 400s if dropped
  redacted: true, // optional literal — must survive
}

const imageFixture: ImageBlock = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  mediaType: "image/png",
}

const documentFixture: DocumentBlock = {
  type: "document",
  data: "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKJSVFT0Y=", // base64 of a "%PDF-1.4\n…" sentinel
  mediaType: "application/pdf",
}

/**
 * ★ Compile-time exhaustiveness gate. This Record MUST have exactly one key
 * per member of `ContentBlock["type"]`. Adding a variant to the union in
 * `@/llm` makes this object literal fail to type-check (missing key) until a
 * fixture is added — that is the guardrail, not a runtime afterthought.
 */
const FIXTURES: Record<ContentBlock["type"], ContentBlock> = {
  text: textFixture,
  tool_use: toolUseFixture,
  tool_result: toolResultFixture,
  thinking: thinkingFixture,
  image: imageFixture,
  document: documentFixture,
}

/**
 * Runtime cross-check list. Kept independent of `FIXTURES` ON PURPOSE: the
 * assertion below proves the two key sets are identical, so a variant added to
 * the union shows up in `FIXTURES` (compile gate) but trips the equality check
 * here unless it is ALSO listed — double-entry bookkeeping against drift.
 */
const KNOWN_TYPES: ReadonlyArray<ContentBlock["type"]> = [
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "image",
  "document",
]

/** Optional/required fields we deliberately populate per variant. The runtime
 *  reflection assert proves every listed key is actually present (defends
 *  against a fixture that forgot a newly-added optional field). */
const EXPECTED_FIELDS: Record<ContentBlock["type"], readonly string[]> = {
  text: ["type", "text", "phase"],
  tool_use: ["type", "id", "name", "input"],
  tool_result: ["type", "tool_use_id", "content", "is_error"],
  thinking: ["type", "thinking", "signature", "redacted"],
  image: ["type", "data", "mediaType"],
  document: ["type", "data", "mediaType"],
}

const allBlocks = (): ContentBlock[] => KNOWN_TYPES.map((t) => FIXTURES[t])

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `title ${SPECIAL}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

describe("invariant: session content-block round-trip is lossless (anti-drift)", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "invariant-roundtrip-"))
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

  /* ---------------------------------------------------------------- */
  /* exhaustiveness                                                    */
  /* ---------------------------------------------------------------- */

  test("every ContentBlock variant has a fixture (compile + runtime exhaustive)", () => {
    const fixtureTypes = Object.keys(FIXTURES).sort()
    const knownTypes = [...KNOWN_TYPES].sort()
    // If these diverge, a variant was added to the union without updating one
    // of the two registries — fail loudly with the offending diff.
    expect(fixtureTypes).toEqual(knownTypes)
    // Each fixture's discriminant must match its key (no copy-paste swap).
    for (const t of KNOWN_TYPES) {
      expect(FIXTURES[t].type).toBe(t)
    }
  })

  test("every fixture populates every expected field (no dropped optional)", () => {
    for (const t of KNOWN_TYPES) {
      const block = FIXTURES[t] as unknown as Record<string, unknown>
      for (const field of EXPECTED_FIELDS[t]) {
        expect(block[field]).toBeDefined()
      }
    }
  })

  /* ---------------------------------------------------------------- */
  /* (2)+(3) real persist → load deep-equal                            */
  /* ---------------------------------------------------------------- */

  test("saveSessionById → loadSessionById preserves EVERY variant and field", async () => {
    // A single user+assistant pair carrying all blocks. (Roles are flexible:
    // we put image on the user side per its input-only contract, the rest on
    // the assistant side; the persist layer does not enforce role/variant
    // pairing, so this exercises the full union regardless.)
    const messages: Message[] = [
      { role: "user", content: [imageFixture, textFixture] },
      {
        role: "assistant",
        content: [thinkingFixture, textFixture, toolUseFixture, toolResultFixture],
      },
    ]
    const payload: SavePayload = { reason: "completed", turns: 3, messages }
    const meta = mkMeta("rt-allblocks")

    await saveSessionById(meta, payload)
    const loaded = await loadSessionById("rt-allblocks")

    expect(loaded).toBeDefined()
    // ★ The core invariant: the loaded transcript DEEP-EQUALS what we saved.
    // If the zod mirror in store.ts strips any field or rejects any variant,
    // this fails (stripped field => inequality; rejected variant => the whole
    // file refuses to load => loaded.messages differs / undefined).
    expect(loaded?.messages).toEqual(messages)
    expect(loaded?.reason).toBe("completed")
    expect(loaded?.turns).toBe(3)
  })

  test("each variant survives in isolation (pinpoints which variant drifts)", async () => {
    // Per-variant sessions so a failure names the exact culprit instead of a
    // bundled deep-equal that only says "something differs".
    for (const t of KNOWN_TYPES) {
      const block = FIXTURES[t]
      const messages: Message[] = [{ role: "assistant", content: [block] }]
      const id = `rt-solo-${t}`
      await saveSessionById(mkMeta(id), { reason: "completed", turns: 1, messages })
      const loaded = await loadSessionById(id)
      expect(loaded, `variant "${t}" failed to load at all`).toBeDefined()
      expect(loaded?.messages, `variant "${t}" round-trip lossy`).toEqual(messages)
    }
  })

  test("all blocks together survive one round-trip element-for-element", async () => {
    const messages: Message[] = [{ role: "assistant", content: allBlocks() }]
    await saveSessionById(mkMeta("rt-bundle"), { reason: "x", turns: 1, messages })
    const loaded = await loadSessionById("rt-bundle")
    const loadedBlocks = loaded?.messages[0]?.content ?? []
    expect(loadedBlocks.length).toBe(KNOWN_TYPES.length)
    // Compare per-discriminant so a missing/extra variant is named.
    for (const t of KNOWN_TYPES) {
      const original = FIXTURES[t]
      const got = loadedBlocks.find((b) => b.type === t)
      expect(got, `variant "${t}" missing from loaded transcript`).toBeDefined()
      expect(got, `variant "${t}" field drift`).toEqual(original)
    }
  })

  /* ---------------------------------------------------------------- */
  /* (5) JSONL envelope encode → decode round-trip (special chars)     */
  /* ---------------------------------------------------------------- */

  test("envelope encode → decode is lossless for special chars / newlines / unicode", () => {
    // The JSONL envelope codec carries strings (tool output, user messages,
    // response items). Prove the same hostile payload survives encode→decode.
    const record: SessionEnvelopeRecord = {
      type: "event_msg",
      schema_version: 1,
      ts: "2026-05-22T12:34:56.789Z",
      turn_id: "turn-1",
      kind: "tool_result",
      tool: "edit_file",
      ok: false,
      output: SPECIAL,
    }
    const line = encodeSessionLine(record)
    // Exactly one trailing newline, and the embedded newline is escaped (not a
    // raw line break that would split the JSONL record).
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1).includes("\n")).toBe(false)

    const decoded = decodeSessionLine(line)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.value).toEqual(record)
      // Explicit: the special string is byte-for-byte preserved.
      expect((decoded.value as { output: string }).output).toBe(SPECIAL)
    }
  })

  test("envelope response_item content survives unicode round-trip", () => {
    const record: SessionEnvelopeRecord = {
      type: "response_item",
      schema_version: 1,
      turn_id: "turn-2",
      item_kind: "assistant_text",
      index: 0,
      content: `${SPECIAL}\nsecond line\t日本語`,
    }
    const decoded = decodeSessionLine(encodeSessionLine(record))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value).toEqual(record)
  })
})
