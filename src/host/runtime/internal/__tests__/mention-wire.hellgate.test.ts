/**
 * ADR-0422 — host-runtime CLI mention wire hellgate.
 *
 *   A. injector attached when knobs default-ON                       (1)
 *   B. caller-override precedence — pre-set injector untouched        (1)
 *   C. mention-free input ⇒ injector returns [] (byte-identical)      (2)
 *   D. @file mention ⇒ injector injects the file body                 (2)
 *   E. all knobs off ⇒ mention input still injects nothing            (2)
 *   F. NO-THROW — injector swallows a hostile input                   (1)
 *
 * Total = 9 cases. A minimal AgentConfig is faked (only `cwd` / `sessionId`
 * / `mentionInjector` matter for the wire); no real LSP / loop is started.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { NamedAgentRegistry } from "@/agent/named-agent-registry"
import type { MentionLiveSources } from "../mention-source-deps"
import { installCliMentionInjector } from "../mention-wire"

const SYMBOL = "QUANTA_MENTION_SYMBOL"
const FILE = "QUANTA_MENTION_FILE"
const SKILL = "QUANTA_MENTION_SKILL"

const makeCfg = (cwd: string, sessionId?: string): AgentConfig =>
  ({ cwd, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as AgentConfig

describe("installCliMentionInjector — ADR-0422 hellgate", () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-wire-"))
    for (const k of [FILE, SYMBOL, SKILL]) saved[k] = process.env[k]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of [FILE, SYMBOL, SKILL]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  // -------- A. attached ----------------------------------------------
  test("A1 — mentionInjector attached (knobs default-ON)", () => {
    delete process.env[FILE]
    delete process.env[SYMBOL]
    delete process.env[SKILL]
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(typeof cfg.mentionInjector).toBe("function")
  })

  // -------- B. caller-override precedence ----------------------------
  test("B1 — pre-set injector is left untouched", () => {
    const sentinel: AgentConfig["mentionInjector"] = async () => []
    const cfg = makeCfg(dir, "s1")
    cfg.mentionInjector = sentinel
    installCliMentionInjector(cfg)
    expect(cfg.mentionInjector).toBe(sentinel)
  })

  // -------- C. mention-free input ⇒ [] -------------------------------
  test("C1 — plain text (no mention) ⇒ []", async () => {
    delete process.env[FILE]
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("just some plain text")).toEqual([])
  })

  test("C2 — empty string ⇒ []", async () => {
    delete process.env[FILE]
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("")).toEqual([])
  })

  // -------- D. @file mention injects ---------------------------------
  test("D1 — @file mention injects the file body", async () => {
    delete process.env[FILE]
    writeFileSync(join(dir, "note.txt"), "secret contents here", "utf8")
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    const msgs = await cfg.mentionInjector?.("see @./note.txt please")
    expect(Array.isArray(msgs)).toBe(true)
    expect(JSON.stringify(msgs)).toContain("secret contents here")
  })

  test("D2 — @file to a missing file ⇒ [] (NO-THROW)", async () => {
    delete process.env[FILE]
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("see @./nope.txt")).toEqual([])
  })

  // -------- E. all knobs off ⇒ inject nothing ------------------------
  test("E1 — FILE=off ⇒ @file mention injects nothing", async () => {
    process.env[FILE] = "off"
    process.env[SYMBOL] = "off"
    process.env[SKILL] = "off"
    writeFileSync(join(dir, "note.txt"), "should not appear", "utf8")
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("see @./note.txt")).toEqual([])
  })

  test("E2 — all knobs off ⇒ @Symbol mention injects nothing", async () => {
    process.env[FILE] = "off"
    process.env[SYMBOL] = "off"
    process.env[SKILL] = "off"
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("look at @SomeSymbol")).toEqual([])
  })

  // -------- F. NO-THROW ----------------------------------------------
  test("F1 — hostile non-string input ⇒ [] (no throw)", async () => {
    delete process.env[FILE]
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast
    expect(await cfg.mentionInjector?.(null as any)).toEqual([])
  })
})

// -------- RFC-12-2 WIRING front door: mcp / subagent / thread ---------------
//
// Drives the REAL production seam — `installCliMentionInjector(cfg, sources)` —
// end to end: the injected owners (mcp snapshot + session thunk) + the config's
// `namedAgentResolver` make `@mcp:` / `@subagent:` / `@thread:` inject the right
// context through `cfg.mentionInjector`. Pins gate-off byte-identical + no
// foreign-lineage leak + red-on-injection (drop one owner ⇒ its kind dark).

const MCP = "QUANTA_MENTION_MCP"
const SUBAGENT = "QUANTA_MENTION_SUBAGENT"
const THREAD = "QUANTA_MENTION_THREAD"

const cfgWithSubagents = (cwd: string): AgentConfig =>
  ({
    cwd,
    namedAgentResolver: new NamedAgentRegistry([
      {
        agentType: "explorer",
        system: "Read-only explorer role\nnext line",
        sourcePath: "/repo/.quanta/agents/explorer.md",
      },
    ]),
  }) as unknown as AgentConfig

const liveSources = (): MentionLiveSources => ({
  mcpServers: [{ name: "github", tools: [{ name: "create_pr", description: "Open a PR" }] }],
  sessions: async () => [{ id: "abc-1", title: "Prior thread", cwd: "/w", gitBranch: "feat/x" }],
})

describe("installCliMentionInjector — RFC-12-2 wiring front door", () => {
  const KNOBS = [FILE, SYMBOL, SKILL, MCP, SUBAGENT, THREAD]
  let dir: string
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-wire-rfc122-"))
    for (const k of KNOBS) saved[k] = process.env[k]
    // Keep file/symbol/skill OFF so the assertions isolate the 3 new kinds.
    process.env[FILE] = "off"
    process.env[SYMBOL] = "off"
    process.env[SKILL] = "off"
    delete process.env[MCP]
    delete process.env[SUBAGENT]
    delete process.env[THREAD]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test("G1 — all owners wired ⇒ mcp/subagent/thread all inject context", async () => {
    const cfg = installCliMentionInjector(cfgWithSubagents(dir), liveSources())
    const out = JSON.stringify(
      await cfg.mentionInjector?.("@mcp:github @subagent:explorer @thread:abc-1"),
    )
    expect(out).toContain("mcp: github")
    expect(out).toContain("create_pr")
    expect(out).toContain("subagent: explorer")
    expect(out).toContain("thread: Prior thread")
  })

  test("G2 — RED: NO sources + no namedAgentResolver ⇒ all three dark (byte-identical)", async () => {
    const cfg = installCliMentionInjector(makeCfg(dir, "s1"))
    expect(await cfg.mentionInjector?.("@mcp:github @subagent:explorer @thread:abc-1")).toEqual([])
  })

  test("G3 — subagent rides cfg.namedAgentResolver even with NO sources bundle", async () => {
    const cfg = installCliMentionInjector(cfgWithSubagents(dir))
    const out = JSON.stringify(await cfg.mentionInjector?.("@subagent:explorer @mcp:github"))
    expect(out).toContain("subagent: explorer")
    // mcp is dark (no source bundle)
    expect(out).not.toContain("mcp: github")
  })

  test("G4 — red-on-injection: drop the MCP source ⇒ ONLY mcp dark", async () => {
    const src: MentionLiveSources = {
      sessions: async () => [{ id: "abc-1", title: "Prior thread" }],
    }
    const cfg = installCliMentionInjector(cfgWithSubagents(dir), src)
    const out = JSON.stringify(
      await cfg.mentionInjector?.("@mcp:github @subagent:explorer @thread:abc-1"),
    )
    expect(out).not.toContain("mcp: github")
    expect(out).toContain("subagent: explorer")
    expect(out).toContain("thread: Prior thread")
  })

  test("G5 — kill-switch: QUANTA_MENTION_SUBAGENT=off ⇒ subagent dark, others live", async () => {
    process.env[SUBAGENT] = "off"
    const cfg = installCliMentionInjector(cfgWithSubagents(dir), liveSources())
    const out = JSON.stringify(
      await cfg.mentionInjector?.("@mcp:github @subagent:explorer @thread:abc-1"),
    )
    expect(out).not.toContain("subagent: explorer")
    expect(out).toContain("mcp: github")
    expect(out).toContain("thread: Prior thread")
  })

  test("G6 — foreign-lineage: @subagent: can only surface a role THIS registry declares", async () => {
    // The registry holds ONLY `explorer`; a request for a role it never declared
    // (a would-be cross-task child handle) resolves to nothing — no leak.
    const cfg = installCliMentionInjector(cfgWithSubagents(dir), liveSources())
    const out = JSON.stringify(await cfg.mentionInjector?.("@subagent:other-tasks-child"))
    expect(out === "[]" || out === undefined).toBe(true)
  })
})
