import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSessionById,
  saveSessionById,
  sessionFilePath,
  type SessionMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * §8.2 (jun-08) — the SessionMeta provenance fields must survive the snapshot
 * store round-trip (zod strips unknown keys, so a missing mirror in
 * `sessionMetaSchema` would silently LOSE them on load). Plus the default-OFF
 * byte-identity: a meta that sets none of them serializes identically to the
 * pre-ticket shape.
 */

const base = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: over.id ?? "s1",
  title: over.title ?? "T",
  cwd: over.cwd ?? "/tmp/work",
  createdAt: over.createdAt ?? 1_000,
  lastTouched: over.lastTouched ?? 1_000,
  archived: over.archived ?? false,
  ...over,
})

const payload = {
  reason: "completed",
  turns: 1,
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
}

describe("§8.2 SessionMeta longtail fields — store round-trip", () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    env = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "meta-longtail-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
    Object.assign(process.env, env)
    __resetRuntimeConfig()
  })

  test("all 5 provenance fields survive save→load (no zod strip)", async () => {
    await saveSessionById(
      base({
        agentNickname: "Refactor Bot",
        dynamicTools: ["mcp__db__query", "skill__fmt"],
        originator: "cli",
        threadSource: "resumed",
        modelProvider: "anthropic",
      }),
      payload,
    )
    const loaded = await loadSessionById("s1")
    expect(loaded?.meta.agentNickname).toBe("Refactor Bot")
    expect(loaded?.meta.dynamicTools).toEqual(["mcp__db__query", "skill__fmt"])
    expect(loaded?.meta.originator).toBe("cli")
    expect(loaded?.meta.threadSource).toBe("resumed")
    expect(loaded?.meta.modelProvider).toBe("anthropic")
  })

  test("BYTE-IDENTITY: a meta with none of the new fields serializes the legacy shape", async () => {
    await saveSessionById(base(), payload)
    const raw = readFileSync(sessionFilePath("s1"), "utf8")
    for (const f of [
      "agentNickname",
      "dynamicTools",
      "originator",
      "threadSource",
      "modelProvider",
      "interruptedTurn",
    ]) {
      expect(raw.includes(`"${f}"`)).toBe(false)
    }
  })
})
