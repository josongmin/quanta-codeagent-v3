/**
 * ADR-0462 follow-up hellgate — `/sticky-model` SET surface.
 *
 * Pins the SET side that lets a user set the per-mode sticky model the
 * consume side (agent loop, ADR-0462) reads. Each case is one adversarial
 * invariant covering (a) the adapter's validation + typed outcomes, (b) the
 * `/sticky-model` slash command's parse/print/exit behaviour, (c) the
 * default-OFF "not wired" path, and (d) round-trip through a real fs store
 * over a tmp file (the documented file-coupling contract).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fsBackedStickyModelStore,
  inMemoryStickyModelStore,
} from "../../../../src/agent/sticky-model"
import {
  buildStickyModelAdapter,
  STICKY_MODEL_MODES,
} from "../../../../src/apps/cli/repl/ctx-adapters/sticky-model-adapter"
import { SURFACE_SLASH_COMMANDS } from "../../../../src/apps/cli/slash/registry-surface"
import type { SlashContext } from "../../../../src/apps/cli/slash-contract"

const stickyCmd = () => {
  const c = SURFACE_SLASH_COMMANDS.find((x) => x.name === "/sticky-model")
  if (c === undefined) throw new Error("/sticky-model not registered")
  return c
}

/** Minimal SlashContext with captured stdout/stderr. */
const mkCtx = (
  over: Partial<SlashContext>,
): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    cwd: "/tmp",
    ...over,
  } as SlashContext
  return { ctx, out, err }
}

describe("ADR-0462 follow-up — /sticky-model SET surface hellgate", () => {
  // ── adapter ────────────────────────────────────────────────────────────
  test("CASE-1: adapter.set persists a valid mode round-trip (in-memory)", async () => {
    const store = inMemoryStickyModelStore()
    const a = buildStickyModelAdapter({ store })
    expect(await a.set("plan", "opus")).toBe("ok")
    expect(await store.get({ mode: "plan" })).toBe("opus")
    expect(await a.list()).toEqual({ plan: "opus" })
  })

  test("CASE-2: adapter.set rejects an unknown mode with typed invalid-mode (no write)", async () => {
    const store = inMemoryStickyModelStore()
    const a = buildStickyModelAdapter({ store })
    const res = await a.set("turbo", "opus")
    expect(res).toEqual({ kind: "invalid-mode", known: STICKY_MODEL_MODES })
    expect(await store.get({ mode: "plan" })).toBeUndefined()
  })

  test("CASE-3: adapter.set rejects empty modelId (would be a silent no-op for the resolver)", async () => {
    const store = inMemoryStickyModelStore()
    const a = buildStickyModelAdapter({ store })
    const res = await a.set("plan", "   ")
    expect(typeof res === "object" && res.kind).toBe("write-error")
    expect(await store.get({ mode: "plan" })).toBeUndefined()
  })

  test("CASE-4: adapter surfaces store write failure as typed write-error (never throws)", async () => {
    const failing = {
      get: async () => undefined,
      load: async () => ({ ok: true as const, snapshot: {} }),
      set: async () => ({
        ok: false as const,
        error: Object.assign(new Error("disk full"), { name: "StickyModelWriteError" }),
      }),
    }
    const a = buildStickyModelAdapter({ store: failing })
    const res = await a.set("review", "sonnet")
    expect(typeof res === "object" && res.kind).toBe("write-error")
    expect(typeof res === "object" && res.message).toContain("disk full")
  })

  test("CASE-5: STICKY_MODEL_MODES is exactly the 6 prompt modes", () => {
    expect([...STICKY_MODEL_MODES]).toEqual([
      "default",
      "plan",
      "review",
      "audit",
      "architect",
      "editor",
    ])
  })

  // ── slash command ───────────────────────────────────────────────────────
  test("CASE-6: /sticky-model is registered as a surface command", () => {
    expect(SURFACE_SLASH_COMMANDS.some((c) => c.name === "/sticky-model")).toBe(true)
  })

  test("CASE-7: not wired ⇒ prints 'not wired' + exit 0 (default-OFF byte-identical)", async () => {
    const { ctx, out } = mkCtx({})
    const code = await stickyCmd().run([], ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })

  test("CASE-8: no-arg listing prints current entries + usage", async () => {
    const store = inMemoryStickyModelStore()
    await store.set({ mode: "plan", modelId: "opus" })
    const { ctx, out } = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) })
    const code = await stickyCmd().run([], ctx)
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("plan = opus")
    expect(text).toContain("usage")
  })

  test("CASE-9: set verb persists + prints confirmation, exit 0", async () => {
    const store = inMemoryStickyModelStore()
    const { ctx, out } = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) })
    const code = await stickyCmd().run(["audit", "haiku"], ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("audit")
    expect(await store.get({ mode: "audit" })).toBe("haiku")
  })

  test("CASE-10: wrong arity ⇒ usage error + exit 1", async () => {
    const store = inMemoryStickyModelStore()
    const { ctx, err } = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) })
    const code = await stickyCmd().run(["plan"], ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("usage")
  })

  test("CASE-11: unknown mode ⇒ error names the known modes + exit 1", async () => {
    const store = inMemoryStickyModelStore()
    const { ctx, err } = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) })
    const code = await stickyCmd().run(["turbo", "opus"], ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("plan")
  })

  // ── file coupling (the consume-side contract) ─────────────────────────────
  test("CASE-12: two fs-store instances over one file — SET is observed by a fresh reader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sticky-set-"))
    const path = join(dir, "sticky-model.json")
    const setSide = buildStickyModelAdapter({ store: fsBackedStickyModelStore({ path }) })
    const consumeSide = fsBackedStickyModelStore({ path })
    expect(await setSide.set("plan", "opus")).toBe("ok")
    // fresh disk read by an independent instance (mirrors loop.ts per-turn get)
    expect(await consumeSide.get({ mode: "plan" })).toBe("opus")
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plan: "opus" })
  })
})
