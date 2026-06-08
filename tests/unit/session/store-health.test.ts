import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRecoveryGuidance,
  checkSessionStoreHealth,
  saveSessionById,
  type SessionMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * §13.1 (jun-08 long-tail) — store-level AGGREGATE corruption detection +
 * operator recovery guidance.
 *
 * The per-file degrade (one bad file ⇒ undefined+warn) was already there; this
 * pins the missing aggregate signal: when the WHOLE store is unreadable, the
 * health check returns `verdict:"corrupt"` + actionable `guidance`, instead of
 * an empty list indistinguishable from "no sessions".
 */

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

describe("§13.1 session store health — aggregate corruption", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "store-health-"))
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

  test("empty store ⇒ verdict empty, no guidance", async () => {
    const r = await checkSessionStoreHealth()
    expect(r.verdict).toBe("empty")
    expect(r.total).toBe(0)
    expect(r.guidance).toBeUndefined()
  })

  test("all-valid store ⇒ verdict healthy, no guidance", async () => {
    await saveSessionById(mkMeta("a"), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    await saveSessionById(mkMeta("b"), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "yo" }] }],
    })
    const r = await checkSessionStoreHealth()
    expect(r.verdict).toBe("healthy")
    expect(r.ok).toBe(2)
    expect(r.corrupt).toBe(0)
    expect(r.guidance).toBeUndefined()
  })

  test("some corrupt + some ok ⇒ verdict degraded WITH guidance", async () => {
    await saveSessionById(mkMeta("good"), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    writeFileSync(join(dir, "broken.json"), "{ this is not json")
    const r = await checkSessionStoreHealth()
    expect(r.verdict).toBe("degraded")
    expect(r.ok).toBe(1)
    expect(r.corrupt).toBe(1)
    expect(r.guidance).toBeDefined()
    expect(r.guidance).toContain("DEGRADED")
    expect(r.guidance).toContain(dir)
  })

  test("AGGREGATE: every file unreadable ⇒ verdict corrupt WITH recovery guidance", async () => {
    writeFileSync(join(dir, "x.json"), "garbage 1")
    writeFileSync(join(dir, "y.json"), "{ broken")
    writeFileSync(join(dir, "z.json"), '{"meta":{"id":"z"}}') // missing messages array ⇒ corrupt
    const r = await checkSessionStoreHealth()
    expect(r.verdict).toBe("corrupt")
    expect(r.ok).toBe(0)
    expect(r.total).toBe(3)
    expect(r.guidance).toBeDefined()
    expect(r.guidance).toContain("AGGREGATELY corrupt")
    expect(r.guidance).toContain("index.jsonl")
    expect(r.guidance).toContain("Back up")
  })

  test("archived corrupt files are counted too", async () => {
    const archivedDir = join(dir, "archived")
    mkdirSync(archivedDir, { recursive: true })
    writeFileSync(join(archivedDir, "old.json"), "not json")
    const r = await checkSessionStoreHealth()
    expect(r.total).toBe(1)
    expect(r.corrupt).toBe(1)
    expect(r.files[0]?.archived).toBe(true)
    expect(r.verdict).toBe("corrupt")
  })

  test("buildRecoveryGuidance is pure and names concrete next steps", () => {
    const g = buildRecoveryGuidance({
      root: "/r",
      verdict: "corrupt",
      total: 5,
      ok: 0,
      corrupt: 5,
      unreadable: 0,
    })
    expect(g).toContain("5/5")
    expect(g).toContain("/r")
    expect(g).toContain("Back up")
    expect(g).toContain("index.jsonl")
  })
})
