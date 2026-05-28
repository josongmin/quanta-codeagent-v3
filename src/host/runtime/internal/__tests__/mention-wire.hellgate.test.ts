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
