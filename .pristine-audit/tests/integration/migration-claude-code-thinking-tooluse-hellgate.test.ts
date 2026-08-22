/**
 * Hellgate (ADR-0038 L4): adversarial round-trip of the Claude Code translator
 * for thinking blocks + tool_use input validity.
 *
 * Findings sealed here:
 *   (7) translateBlock used to DROP thinking blocks entirely, losing the
 *       reasoning trail and silently discarding pure-thinking messages (which
 *       shifts every downstream turn index). Now a `thinking` block round-trips
 *       to a v3 ThinkingBlock preserving `thinking` + `signature`, a
 *       `redacted_thinking` block maps to `redacted: true` carrying the
 *       ciphertext verbatim, and a message containing ONLY thinking survives.
 *   (11) a tool_use block with a missing / non-object `input` used to round-trip
 *        as an API-invalid block (`input: undefined`) that 400s on the next
 *        turn after resume. NO FALLBACK: the translator must NOT default to
 *        `{}` (fabricating arguments). A real object input is preserved
 *        verbatim; a missing / non-object input is surfaced by being skipped,
 *        never silently defaulted.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeCodeTranslator } from "@/migration"

const writeJsonl = async (lines: object[]): Promise<{ path: string; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "cc-thinking-hellgate-"))
  const path = join(dir, "sess.jsonl")
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8")
  return { path, dir }
}

describe("claudeCodeTranslator thinking + tool_use hellgate", () => {
  test("plaintext thinking block round-trips preserving thinking + signature", async () => {
    const { path, dir } = await writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me reason about this", signature: "sig-abc-123" },
            { type: "text", text: "the answer is 42" },
          ],
        },
      },
    ])
    try {
      const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
      expect(msgs).toHaveLength(1)
      expect(msgs[0]?.content).toEqual([
        { type: "thinking", thinking: "let me reason about this", signature: "sig-abc-123" },
        { type: "text", text: "the answer is 42" },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("redacted_thinking maps to ThinkingBlock with redacted:true + verbatim ciphertext", async () => {
    const { path, dir } = await writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "redacted_thinking", data: "OPAQUE_CIPHERTEXT_xyz" }],
        },
      },
    ])
    try {
      const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
      // A message with ONLY a thinking block is a real assistant turn — it must
      // NOT be dropped (dropping would shift every downstream turn index).
      expect(msgs).toHaveLength(1)
      expect(msgs[0]?.content).toEqual([
        { type: "thinking", thinking: "OPAQUE_CIPHERTEXT_xyz", redacted: true },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("thinking with no signature round-trips without inventing a signature field", async () => {
    const { path, dir } = await writeJsonl([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "no sig here" }] },
      },
    ])
    try {
      const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
      expect(msgs).toHaveLength(1)
      const block = msgs[0]?.content[0]
      expect(block).toEqual({ type: "thinking", thinking: "no sig here" })
      // No fabricated signature key.
      expect(block && "signature" in block).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("tool_use with a real object input is preserved verbatim", async () => {
    const { path, dir } = await writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a", lines: 5 } },
          ],
        },
      },
    ])
    try {
      const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
      expect(msgs[0]?.content).toEqual([
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a", lines: 5 } },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("tool_use with MISSING input is surfaced (skipped), NOT defaulted to {}", async () => {
    const { path, dir } = await writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            // No `input` field at all — malformed source row.
            { type: "tool_use", id: "tu_bad", name: "read_file" },
            { type: "text", text: "trailing text" },
          ],
        },
      },
    ])
    try {
      const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
      // The malformed tool_use is dropped; it must NOT appear with input:{} or
      // input:undefined (which would 400 the Messages API on resume).
      expect(msgs).toHaveLength(1)
      expect(msgs[0]?.content).toEqual([{ type: "text", text: "trailing text" }])
      expect(msgs[0]?.content.some((b) => b.type === "tool_use")).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("tool_use with NON-object input (string / number / null / array) is surfaced (skipped)", async () => {
    const bad: unknown[] = ["a string", 7, null, ["arr"]]
    for (const input of bad) {
      const { path, dir } = await writeJsonl([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_x", name: "t", input }],
          },
        },
      ])
      try {
        const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
        // Whole message dropped because its only block was the invalid tool_use.
        expect(msgs).toHaveLength(0)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })
})
