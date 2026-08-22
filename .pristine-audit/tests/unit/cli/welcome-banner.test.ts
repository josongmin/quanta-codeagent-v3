import { describe, expect, test } from "bun:test"
import pkg from "../../../package.json" with { type: "json" }
import {
  buildWelcomeInfo,
  QUANTA_VERSION,
  renderWelcomeBanner,
} from "../../../src/apps/cli/welcome-banner"

/**
 * Welcome banner (jun-10) — the Claude-Code-style entry box that replaces the
 * bare `[info] quanta ready (...)` wall of JSONL as the interactive surface's
 * first paint. Pure renderer: identity (version), runtime facts (model /
 * provider / mode / effort), workspace (cwd, ~-shortened), session continuity
 * (id + resumed message count), and capability counts (MCP) — plus a footer of
 * the three keybinds a new operator actually needs.
 */

const stripAnsi = (text: string): string =>
  text.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")

const baseInfo = {
  version: "9.9.9",
  provider: "chatgpt-oauth",
  model: "gpt-5",
  mode: "default",
  cwd: "/Users/o/proj",
  home: "/Users/o",
}

describe("renderWelcomeBanner — content", () => {
  test("renders a rounded box with version, model · provider, mode, ~-shortened cwd, and footer hints", () => {
    const out = stripAnsi(renderWelcomeBanner(baseInfo))
    expect(out).toContain("╭")
    expect(out).toContain("╰")
    expect(out).toContain("quanta v9.9.9")
    expect(out).toContain("gpt-5")
    expect(out).toContain("chatgpt-oauth")
    expect(out).toContain("default")
    expect(out).toContain("~/proj")
    expect(out).not.toContain("/Users/o/proj") // shortened, not raw
    expect(out).toContain("/help")
    expect(out).toContain("Esc Esc")
  })

  test("cwd outside home stays absolute (no false ~)", () => {
    const out = stripAnsi(renderWelcomeBanner({ ...baseInfo, cwd: "/tmp/elsewhere" }))
    expect(out).toContain("/tmp/elsewhere")
    expect(out).not.toContain("~/elsewhere")
  })

  test("effort is appended to the model line when provided", () => {
    const out = stripAnsi(renderWelcomeBanner({ ...baseInfo, effort: "xhigh" }))
    expect(out).toContain("effort xhigh")
  })

  test("session line appears only with a sessionId; resumed count shown when > 0", () => {
    const none = stripAnsi(renderWelcomeBanner(baseInfo))
    expect(none).not.toContain("session")

    const fresh = stripAnsi(
      renderWelcomeBanner({ ...baseInfo, sessionId: "q_abc", resumedMessages: 0 }),
    )
    expect(fresh).toContain("q_abc")
    expect(fresh).not.toContain("resumed")

    const resumed = stripAnsi(
      renderWelcomeBanner({ ...baseInfo, sessionId: "q_abc", resumedMessages: 12 }),
    )
    expect(resumed).toContain("q_abc")
    expect(resumed).toContain("12 msgs resumed")
  })

  test("mcp line appears only when servers are connected", () => {
    const off = stripAnsi(renderWelcomeBanner({ ...baseInfo, mcpServers: 0, mcpTools: 0 }))
    expect(off).not.toContain("mcp")

    const on = stripAnsi(renderWelcomeBanner({ ...baseInfo, mcpServers: 2, mcpTools: 17 }))
    expect(on).toContain("2 servers")
    expect(on).toContain("17 tools")
  })

  test("version defaults to the package.json SSOT", () => {
    expect(QUANTA_VERSION).toBe(pkg.version)
    const out = stripAnsi(renderWelcomeBanner({ ...baseInfo, version: undefined }))
    expect(out).toContain(`quanta v${pkg.version}`)
  })
})

describe("buildWelcomeInfo — setup mapper", () => {
  test("maps the live setup fields (effort store read, history/mcp counts)", () => {
    const info = buildWelcomeInfo(
      {
        provider: "openai",
        model: "gpt-5",
        mode: "default",
        cwd: "/Users/o/repo",
        sessionId: "q_77",
        history: [{}, {}, {}] as readonly unknown[],
        mcpClients: [{}] as readonly unknown[],
        mcpTools: [{}, {}] as readonly unknown[],
        effortStore: { get: () => "xhigh" },
      },
      "/Users/o",
    )
    expect(info.provider).toBe("openai")
    expect(info.model).toBe("gpt-5")
    expect(info.mode).toBe("default")
    expect(info.effort).toBe("xhigh")
    expect(info.cwd).toBe("/Users/o/repo")
    expect(info.home).toBe("/Users/o")
    expect(info.sessionId).toBe("q_77")
    expect(info.resumedMessages).toBe(3)
    expect(info.mcpServers).toBe(1)
    expect(info.mcpTools).toBe(2)
  })

  test("a throwing effort store degrades to no effort segment (banner must never block startup)", () => {
    const info = buildWelcomeInfo(
      {
        provider: "openai",
        model: "gpt-5",
        mode: "default",
        cwd: "/r",
        sessionId: undefined,
        history: [],
        mcpClients: [],
        mcpTools: [],
        effortStore: {
          get: () => {
            throw new Error("boom")
          },
        },
      },
      undefined,
    )
    expect(info.effort).toBeUndefined()
  })
})
