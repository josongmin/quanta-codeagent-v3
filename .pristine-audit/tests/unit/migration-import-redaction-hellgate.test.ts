/**
 * Hellgate — competitor-import content redaction + symlink hardening
 * (adversarial-review fix, ADR-0430).
 *
 * The N10 ban (RT-3 in migration-import-roundtrip) blocks credential
 * FILENAMES. This battery seals the two gaps review found:
 *   R-1  in-CONTENT secrets (API key in message text / tool_result) are
 *        REDACTED at the import trust boundary (`redactImportedMessages`,
 *        via the real `redactSecrets`) before they reach the persisted v3
 *        session — they do NOT leak verbatim.
 *   R-2  clean content round-trips byte-identical (redaction is a no-op).
 *   R-3  a symlinked transcript is REFUSED with a typed error (O_NOFOLLOW)
 *        so the basename-only ban can't be bypassed by a symlink.
 *
 * Deterministic: fixed AWS-key-shaped fixture (`redactSecrets` pattern
 * `aws_access_key_id`), real temp dir, no network, no heuristic.
 *
 * Redaction is tested at `@/apps/cli` (the trust boundary that owns it — the
 * `@/migration` slice fence forbids importing `@/security`); the symlink
 * refusal is tested through the `@/migration` translator (the read primitive).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactImportedMessages } from "@/apps/cli/session-import-handler"
import type { Message, TextBlock, ToolResultBlock } from "@/llm"
import { CredentialReadBannedError } from "@/migration"
import { claudeCodeTranslator } from "@/migration/translators/claude-code"

// AWS access key id shape: AKIA + 16 base32 → caught by redactSecrets.
const SECRET = "AKIAIOSFODNN7EXAMPLE"
const PLACEHOLDER = "[REDACTED:aws_access_key_id]"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "quanta-import-redaction-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const allText = (messages: readonly Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .map((b) =>
      b.type === "text"
        ? (b as TextBlock).text
        : b.type === "tool_result"
          ? String((b as ToolResultBlock).content)
          : "",
    )
    .join("\n")

describe("import content redaction at the trust boundary (R-1)", () => {
  test("secret in message TEXT is redacted, not persisted verbatim", () => {
    const out = redactImportedMessages([
      { role: "user", content: [{ type: "text", text: `my key is ${SECRET} ok` }] },
    ])
    const text = allText(out)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })

  test("secret in a TOOL_RESULT is redacted", () => {
    const out = redactImportedMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "running cat .env" },
          { type: "tool_result", tool_use_id: "t1", content: `AWS_KEY=${SECRET}` },
        ],
      },
    ])
    const text = allText(out)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })

  test("a tool_use block (non-text/result) is passed through untouched", () => {
    const input: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "bash", input: { a: 1 } }],
      },
    ]
    const out = redactImportedMessages(input)
    expect(out[0]?.content[0]).toEqual(input[0]?.content[0] as never)
  })
})

describe("clean content round-trips byte-identical (R-2)", () => {
  test("no secret ⇒ content unchanged (redaction is a no-op)", () => {
    const clean = "just a normal message about refactoring the parser"
    const out = redactImportedMessages([{ role: "user", content: [{ type: "text", text: clean }] }])
    const block = out[0]?.content[0] as TextBlock
    expect(block.text).toBe(clean)
    expect(block.text).not.toContain("REDACTED")
  })
})

describe("symlink hardening (R-3, O_NOFOLLOW)", () => {
  const writeJsonl = async (name: string, lines: object[]): Promise<string> => {
    const p = join(dir, name)
    await writeFile(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8")
    return p
  }

  test("a symlinked transcript (→ credential) is refused before any read", async () => {
    const realTarget = join(dir, "real-auth.json")
    await writeFile(realTarget, JSON.stringify({ token: SECRET }), "utf8")
    const link = join(dir, "innocent-name.jsonl")
    await symlink(realTarget, link)
    await expect(
      claudeCodeTranslator.translateFromFile(link, "claude_code"),
    ).rejects.toBeInstanceOf(CredentialReadBannedError)
  })

  test("a symlink to an ordinary transcript is ALSO refused (no-follow is unconditional)", async () => {
    const realTarget = await writeJsonl("real-transcript.jsonl", [
      { type: "user", message: { role: "user", content: "hi" } },
    ])
    const link = join(dir, "link-to-transcript.jsonl")
    await symlink(realTarget, link)
    await expect(
      claudeCodeTranslator.translateFromFile(link, "claude_code"),
    ).rejects.toBeInstanceOf(CredentialReadBannedError)
  })
})
