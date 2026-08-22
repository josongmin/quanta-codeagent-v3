/**
 * ADR-0430 — Claude Code config translators (MCP / hooks / rules) unit cover.
 *
 * Focused on the defensive contract: absent ⇒ empty, malformed ⇒ empty
 * (never throws), only modeled kinds carried, env/credentials never carried,
 * and the content-hash dedup query is sound.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ImportLog } from "@/migration"
import {
  contentSha256OfText,
  translateHooks,
  translateMcpServers,
  translateRules,
  wasAlreadyImported,
} from "@/migration"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adr0430-cfg-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("translateMcpServers", () => {
  test("absent .mcp.json ⇒ []", async () => {
    expect(await translateMcpServers(root)).toEqual([])
  })

  test("malformed .mcp.json ⇒ [] (no throw)", async () => {
    await writeFile(join(root, ".mcp.json"), "{ not json", "utf8")
    expect(await translateMcpServers(root)).toEqual([])
  })

  test("classifies stdio + http + sse; drops env (no secret carry)", async () => {
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a: { command: "node", args: ["x.js"], env: { TOKEN: "secret" } },
          b: { type: "http", url: "https://h" },
          c: { type: "sse", url: "https://s" },
          d: { url: "https://implicit-http" },
        },
      }),
      "utf8",
    )
    const servers = await translateMcpServers(root)
    expect(servers.length).toBe(4)
    const a = servers.find((s) => s.name === "a")
    expect(a?.transport).toBe("stdio")
    expect(a?.command).toBe("node")
    expect(a?.args).toEqual(["x.js"])
    // env is NOT carried (no secret field on the translated shape).
    expect(JSON.stringify(a)).not.toContain("secret")
    expect(servers.find((s) => s.name === "b")?.transport).toBe("http")
    expect(servers.find((s) => s.name === "c")?.transport).toBe("sse")
    expect(servers.find((s) => s.name === "d")?.transport).toBe("http")
  })
})

describe("translateHooks", () => {
  test("absent settings.json ⇒ []", async () => {
    expect(await translateHooks(root)).toEqual([])
  })

  test("translates command hooks; drops groups with no command hook", async () => {
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo a" }] },
            { matcher: "Edit", hooks: [{ type: "notify" }] }, // no command ⇒ dropped
          ],
          Stop: [{ hooks: [{ type: "command", command: "echo b" }] }],
        },
      }),
      "utf8",
    )
    const hooks = await translateHooks(root)
    expect(hooks.length).toBe(2)
    const pre = hooks.find((h) => h.event === "PreToolUse")
    expect(pre?.matcher).toBe("Bash")
    expect(pre?.commands).toEqual(["echo a"])
    const stop = hooks.find((h) => h.event === "Stop")
    expect(stop?.commands).toEqual(["echo b"])
    expect(stop?.matcher).toBeUndefined()
  })
})

describe("translateRules", () => {
  test("absent CLAUDE.md ⇒ []", async () => {
    expect(await translateRules(root)).toEqual([])
  })

  test("empty/whitespace CLAUDE.md ⇒ [] (no signal)", async () => {
    await writeFile(join(root, "CLAUDE.md"), "   \n\t\n", "utf8")
    expect(await translateRules(root)).toEqual([])
  })

  test("present CLAUDE.md ⇒ one rule with content hash", async () => {
    const text = "# Rules\nBe terse.\n"
    await writeFile(join(root, "CLAUDE.md"), text, "utf8")
    const rules = await translateRules(root)
    expect(rules.length).toBe(1)
    expect(rules[0]?.text).toBe(text)
    expect(rules[0]?.contentHash).toBe(await contentSha256OfText(text))
  })
})

describe("wasAlreadyImported", () => {
  const log = (hash: string): ImportLog => ({
    version: 1,
    entries: [
      {
        timestamp: "t",
        provider: "claude_code",
        stage: "session_completion_finished",
        ok: true,
        detail: "x",
        contentHash: hash,
        itemKind: "session",
      },
    ],
  })

  test("matches same kind + hash + ok", () => {
    expect(wasAlreadyImported(log("abc"), "session", "abc")).toBe(true)
  })
  test("does not match a different hash", () => {
    expect(wasAlreadyImported(log("abc"), "session", "def")).toBe(false)
  })
  test("does not match a different kind", () => {
    expect(wasAlreadyImported(log("abc"), "rule", "abc")).toBe(false)
  })
  test("does not match a non-ok row", () => {
    const l: ImportLog = {
      version: 1,
      entries: [
        {
          timestamp: "t",
          provider: "claude_code",
          stage: "session_completion_finished",
          ok: false,
          detail: "x",
          contentHash: "abc",
          itemKind: "session",
        },
      ],
    }
    expect(wasAlreadyImported(l, "session", "abc")).toBe(false)
  })
})
