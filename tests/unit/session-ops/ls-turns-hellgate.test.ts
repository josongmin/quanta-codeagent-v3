import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { runSessionCommand, type SessionCommandDeps } from "@/runner/session-ops"
import { type SavePayload, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * UUX-4-10 hellgate — the rich `session ls` view must actually show turn
 * counts. `list-tui.ts` renders `N turns` (and supports `--sort size`)
 * whenever `turnsById` is supplied — but `cmdLs` never passed it, so the
 * column silently vanished for every real invocation and `--sort size`
 * degraded to a stable no-op (every entry `?? 0`).
 *
 * Real-effect discipline: sessions are seeded through the REAL store into a
 * temp `QUANTA_SESSIONS_DIR`, and the dispatcher is driven end-to-end.
 */

const mkMeta = (id: string, lastTouched: number): SessionMeta => ({
  id,
  title: `title-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched,
  archived: false,
})

const msgs = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `m${i}` }],
  }))

const seed = async (id: string, turns: number, lastTouched: number): Promise<void> => {
  const payload: SavePayload = { reason: "ok", turns, messages: msgs(2) }
  await saveSessionById(mkMeta(id, lastTouched), payload)
}

interface Captured {
  readonly deps: SessionCommandDeps
  readonly out: () => string
  readonly err: () => string
}

const buildDeps = (): Captured => {
  const cap = { out: "", err: "" }
  const deps: SessionCommandDeps = {
    out: (s) => {
      cap.out += s
    },
    err: (s) => {
      cap.err += s
    },
    confirm: async () => false,
    listEnv: { defaultFormat: "plain", defaultMaxN: 10 },
  }
  return { deps, out: () => cap.out, err: () => cap.err }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-turns-"))
  process.env.QUANTA_SESSIONS_DIR = dir
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
  rmSync(dir, { recursive: true, force: true })
})

describe("session ls rich turn counts (UUX-4-10)", () => {
  test("RED-CORE: rich format includes per-session turn counts", async () => {
    await seed("sess-small", 3, 2_000)
    await seed("sess-big", 7, 1_000)
    const c = buildDeps()
    const code = await runSessionCommand(["ls", "--format", "rich"], c.deps)
    expect(code).toBe(0)
    expect(c.out()).toContain("3 turns")
    expect(c.out()).toContain("7 turns")
  })

  test("RED-CORE: --sort size actually orders by turns (largest first)", async () => {
    // The SMALL session wins BOTH tie-breakers a broken (turns-less) sort
    // could fall back to: it is more recent AND lexicographically first —
    // so only a real turns-descending sort puts the big one first.
    await seed("a-small", 2, 9_000)
    await seed("z-big", 9, 1_000)
    const c = buildDeps()
    const code = await runSessionCommand(["ls", "--format", "rich", "--sort", "size"], c.deps)
    expect(code).toBe(0)
    // rich rows render a 6-char short id
    const iBig = c.out().indexOf("z-big")
    const iSmall = c.out().indexOf("a-smal")
    expect(iBig).toBeGreaterThanOrEqual(0)
    expect(iSmall).toBeGreaterThanOrEqual(0)
    expect(iBig).toBeLessThan(iSmall)
  })

  test("paired control: plain format stays byte-stable (no turns column)", async () => {
    await seed("sess-small", 3, 2_000)
    const c = buildDeps()
    const code = await runSessionCommand(["ls", "--format", "plain"], c.deps)
    expect(code).toBe(0)
    expect(c.out()).toContain("sess-small")
    expect(c.out()).not.toContain("turns")
  })

  test("adversarial: a session file that vanishes mid-list degrades to no column, not a crash", async () => {
    await seed("sess-ok", 4, 2_000)
    // A meta whose snapshot cannot be loaded: fabricate by seeding then
    // deleting the file behind the index? loadSessionById tolerates missing
    // files by returning undefined — here we just assert the good row still
    // renders when a sibling is unreadable.
    await seed("sess-gone", 5, 1_500)
    rmSync(join(dir, "sess-gone.json"), { force: true })
    const c = buildDeps()
    const code = await runSessionCommand(["ls", "--format", "rich"], c.deps)
    expect(code).toBe(0)
    expect(c.out()).toContain("4 turns")
  })
})
