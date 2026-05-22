/**
 * ADR-0038 (L4): Claude Code session translator + end-to-end import.
 *
 * Part 1 — unit-style translator fixtures: user+assistant parse, metadata
 * skip, tool_use+tool_result mapping, empty → [], metadata-only → [].
 * Part 2 — e2e: a fake `~/.claude/projects/<slug>/<id>.jsonl` + `auth.json`
 * in a tmp home, run detector + runImport, assert ok + sessionsImported>0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeCodeTranslator,
  contentSha256,
  detectExternalAgents,
  type ImportEvent,
  runImport,
} from "@/migration"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "migration-translator-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Write `lines` (already-stringified JSON objects) as a .jsonl file. */
const writeJsonl = async (name: string, lines: object[]): Promise<string> => {
  const path = join(home, name)
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8")
  return path
}

describe("claudeCodeTranslator.translateFromFile (ADR-0038 L4)", () => {
  test("user + assistant text lines → two Messages", async () => {
    const path = await writeJsonl("a.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] })
    expect(msgs[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hi there" }] })
  })

  test("string content is normalized to a single TextBlock", async () => {
    const path = await writeJsonl("str.jsonl", [
      { type: "user", message: { role: "user", content: "plain string" } },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "plain string" }] }])
  })

  test("metadata line types are skipped", async () => {
    const path = await writeJsonl("meta.jsonl", [
      { type: "queue-operation", op: "enqueue" },
      { type: "attachment", path: "/tmp/x.png" },
      { type: "file-history-snapshot", files: [] },
      { type: "ai-title", title: "Some Title" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "real" }] } },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content[0]).toEqual({ type: "text", text: "real" })
  })

  test("tool_use + tool_result blocks map correctly", async () => {
    const path = await writeJsonl("tools.jsonl", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "text", text: "file body" }],
              is_error: false,
            },
          ],
        },
      },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a" } },
    ])
    // tool_result content array flattened to a string; is_error:false omitted.
    expect(msgs[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "file body" },
    ])
  })

  test("tool_result is_error:true is preserved; string content passes through", async () => {
    const path = await writeJsonl("toolerr.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_9", content: "boom", is_error: true }],
        },
      },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs[0]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_9",
      content: "boom",
      is_error: true,
    })
  })

  test("empty file → []", async () => {
    const path = join(home, "empty.jsonl")
    await writeFile(path, "", "utf8")
    expect(await claudeCodeTranslator.translateFromFile(path, "claude_code")).toEqual([])
  })

  test("metadata-only file → []", async () => {
    const path = await writeJsonl("metaonly.jsonl", [
      { type: "summary", summary: "x" },
      { type: "ai-title", title: "y" },
    ])
    expect(await claudeCodeTranslator.translateFromFile(path, "claude_code")).toEqual([])
  })

  test("message with empty content array → dropped", async () => {
    const path = await writeJsonl("emptycontent.jsonl", [
      { type: "user", message: { role: "user", content: [] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "keep" }] } },
    ])
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content[0]).toEqual({ type: "text", text: "keep" })
  })

  test("malformed line is skipped, valid lines still translate", async () => {
    const path = join(home, "malformed.jsonl")
    await writeFile(
      path,
      [
        "{ this is not json",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "survived" }] },
        }),
      ].join("\n"),
      "utf8",
    )
    const msgs = await claudeCodeTranslator.translateFromFile(path, "claude_code")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content[0]).toEqual({ type: "text", text: "survived" })
  })
})

describe("contentSha256 (ADR-0038 L4)", () => {
  test("hashes file bytes; identical bytes → identical hash; differs on change", async () => {
    const p1 = join(home, "h1.jsonl")
    const p2 = join(home, "h2.jsonl")
    await writeFile(p1, "same bytes", "utf8")
    await writeFile(p2, "same bytes", "utf8")
    const a = await contentSha256(p1)
    const b = await contentSha256(p2)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    await writeFile(p2, "different", "utf8")
    expect(await contentSha256(p2)).not.toBe(a)
  })
})

describe("e2e: detect + runImport translates real sessions (ADR-0038 L4)", () => {
  test("fake ~/.claude with two jsonl sessions → ok + sessionsImported > 0", async () => {
    await mkdir(join(home, ".claude/projects/-Users-x-repo"), { recursive: true })
    await writeFile(join(home, ".claude/auth.json"), JSON.stringify({ token: "t" }), "utf8")
    await writeFile(
      join(home, ".claude/projects/-Users-x-repo/sess-1.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "one" }] } })}\n`,
      "utf8",
    )
    await writeFile(
      join(home, ".claude/projects/-Users-x-repo/sess-2.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "two" }] } })}\n`,
      "utf8",
    )

    const detected = await detectExternalAgents(home)
    expect(detected.map((d) => d.provider)).toContain("claude_code")

    const events: ImportEvent[] = []
    const result = await runImport("claude_code", { homeDir: home }, (e) => events.push(e))
    expect(result.errors).toEqual([])
    expect(result.provider).toBe("claude_code")
    expect(result.sessionsImported).toBe(2)
    const last = events[events.length - 1]
    expect(last?.stage).toBe("import_finished")
    expect(last?.ok).toBe(true)
  })
})
