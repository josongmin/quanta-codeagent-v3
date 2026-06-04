/**
 * `@/ipc#parsePortableSession` — nested content-block validation symmetry (hellgate).
 *
 * The import validator MUST be symmetric with the export shape for the two
 * nested surfaces the original validator skipped:
 *
 *   - `tool_use.input` is a REQUIRED field on the exporter side (`input: unknown`).
 *     A `tool_use` MISSING `input` is REJECTED. A present-but-non-object `input`
 *     is ACCEPTED — the store types it `z.unknown`, so the importer must be
 *     SYMMETRIC and re-import whatever the store/exporter legitimately persisted
 *     (self-audit H13: demanding an object here failed valid round-trips).
 *   - `tool_result.contentBlocks` (optional) mirrors the Anthropic Messages API
 *     `tool_result.content`: when present it is an array whose every element is
 *     `{type:"text",text:string}` | a base64 image (`data`+`mediaType`) | a
 *     base64 document (`data`+`mediaType`). A malformed nested image (missing
 *     `data` / `mediaType`) is REJECTED — it cannot ride in on the outer shape.
 *
 * Anti-theater: every reject case was admitted by the PRE-FIX validator (which
 * only checked the OUTER block shape and never descended into `input` or
 * `contentBlocks`); these tests fail against the unfixed code.
 */

import { describe, expect, test } from "bun:test"
import {
  PORTABLE_SESSION_VERSION,
  PortableSessionImportError,
  parsePortableSession,
} from "@/ipc"

const META = {
  id: "src-nest",
  title: "nested",
  cwd: "/tmp/x",
  created_at: 1,
  last_touched: 2,
  archived: false,
} as const

/** Wrap one assistant message's content into a complete, otherwise-valid
 *  portable v1 blob so each test isolates exactly the nested-block defect. */
const blobWithContent = (content: unknown[]): unknown => ({
  schema: "quanta.session.portable",
  version: PORTABLE_SESSION_VERSION,
  meta: META,
  reason: "test",
  turns: 1,
  messages: [{ role: "assistant", content }],
})

const expectMessagesInvalid = (blob: unknown): void => {
  try {
    parsePortableSession(blob)
    throw new Error("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(PortableSessionImportError)
    expect((err as PortableSessionImportError).kind).toBe("messages_invalid")
  }
}

describe("@/ipc import — nested content-block symmetry hellgate", () => {
  /* -------------------- adversarial: rejected -------------------- */

  test("HELL-NEST-1: tool_result with a MALFORMED nested image is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "screenshot",
          // nested image missing both data and mediaType — corrupt round-trip.
          contentBlocks: [{ type: "image" }],
        },
      ]),
    )
  })

  test("HELL-NEST-2: nested image with data but NO mediaType is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "screenshot",
          contentBlocks: [{ type: "image", data: "QUJD" }],
        },
      ]),
    )
  })

  test("HELL-NEST-3: nested document with mediaType but NO data is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "pdf",
          contentBlocks: [{ type: "document", mediaType: "application/pdf" }],
        },
      ]),
    )
  })

  test("HELL-NEST-4: nested text block with non-string text is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "out",
          contentBlocks: [{ type: "text", text: 42 }],
        },
      ]),
    )
  })

  test("HELL-NEST-5: nested block with an UNKNOWN type is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "out",
          contentBlocks: [{ type: "thinking", thinking: "x" }],
        },
      ]),
    )
  })

  test("HELL-NEST-6: contentBlocks present but NOT an array is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "out",
          contentBlocks: { type: "text", text: "not an array" },
        },
      ]),
    )
  })

  test("HELL-NEST-7: tool_use MISSING input is REJECTED", () => {
    expectMessagesInvalid(
      blobWithContent([{ type: "tool_use", id: "tu-1", name: "bash" }]),
    )
  })

  // HELL-NEST-8/9/10 (self-audit H13): the importer is SYMMETRIC with the
  // exporter + store, which type tool_use.input as `unknown` (z.unknown). A
  // present-but-non-object input the store legitimately persisted MUST re-import
  // — rejecting it broke valid round-trips. Only an ABSENT input is rejected
  // (HELL-NEST-7). API-shape strictness is the adapter's concern, not this
  // portable-import validator's.
  test("HELL-NEST-8: tool_use whose input is a non-object (string) is ACCEPTED (store z.unknown symmetry)", () => {
    expect(() =>
      parsePortableSession(
        blobWithContent([{ type: "tool_use", id: "tu-1", name: "bash", input: "ls -la" }]),
      ),
    ).not.toThrow()
  })

  test("HELL-NEST-9: tool_use with a null input is ACCEPTED (present, not absent)", () => {
    expect(() =>
      parsePortableSession(
        blobWithContent([{ type: "tool_use", id: "tu-1", name: "bash", input: null }]),
      ),
    ).not.toThrow()
  })

  test("HELL-NEST-10: tool_use with an array input is ACCEPTED (z.unknown permits it)", () => {
    expect(() =>
      parsePortableSession(
        blobWithContent([{ type: "tool_use", id: "tu-1", name: "bash", input: ["ls"] }]),
      ),
    ).not.toThrow()
  })

  /* ------------------------ valid: accepted ---------------------- */

  test("HELL-NEST-11: WELL-FORMED tool_result with text+image+document PASSES", () => {
    const parsed = parsePortableSession(
      blobWithContent([
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "mixed result",
          contentBlocks: [
            { type: "text", text: "here is what I found" },
            { type: "image", data: "QUJD", mediaType: "image/png" },
            { type: "document", data: "REVG", mediaType: "application/pdf" },
          ],
        },
      ]),
    )
    expect(parsed.messages).toHaveLength(1)
    const block = parsed.messages[0]?.content[0]
    expect(block?.type).toBe("tool_result")
  })

  test("HELL-NEST-12: tool_result WITHOUT contentBlocks (legacy) PASSES", () => {
    const parsed = parsePortableSession(
      blobWithContent([{ type: "tool_result", tool_use_id: "tu-1", content: "plain text" }]),
    )
    expect(parsed.messages[0]?.content[0]?.type).toBe("tool_result")
  })

  test("HELL-NEST-13: WELL-FORMED tool_use with an object input PASSES", () => {
    const parsed = parsePortableSession(
      blobWithContent([
        { type: "tool_use", id: "tu-1", name: "bash", input: { command: "ls -la" } },
      ]),
    )
    expect(parsed.messages[0]?.content[0]?.type).toBe("tool_use")
  })

  test("HELL-NEST-14: tool_use with an EMPTY object input PASSES (no-arg tools)", () => {
    const parsed = parsePortableSession(
      blobWithContent([{ type: "tool_use", id: "tu-1", name: "noop", input: {} }]),
    )
    expect(parsed.messages[0]?.content[0]?.type).toBe("tool_use")
  })
})
