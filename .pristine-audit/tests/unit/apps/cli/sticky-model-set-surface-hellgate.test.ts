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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fsBackedStickyModelStore,
  inMemoryStickyModelStore,
  StickyModelWriteError,
} from "../../../../src/agent/sticky-model"
import type { StickyModelStore } from "../../../../src/agent/sticky-model/port"
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
    const failing: StickyModelStore = {
      get: async () => undefined,
      load: async () => ({ ok: true as const, snapshot: {} }),
      set: async () => ({
        ok: false as const,
        error: new StickyModelWriteError("/tmp/sticky.json", "disk full"),
      }),
    }
    const a = buildStickyModelAdapter({ store: failing })
    const res = await a.set("review", "sonnet")
    expect(typeof res === "object" && res.kind).toBe("write-error")
    if (typeof res !== "object" || res.kind !== "write-error")
      throw new Error("expected write-error result")
    expect(res.message).toContain("disk full")
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

  // ── tab-completion (A) ────────────────────────────────────────────────────
  test("CASE-13: complete arg0 suggests modes matching the partial", () => {
    const store = inMemoryStickyModelStore()
    const ctx = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) }).ctx
    const hints = stickyCmd().complete?.([], "a", ctx) ?? []
    expect(hints.map((h) => h.value)).toEqual(["audit", "architect"])
    expect(hints.every((h) => h.kind === "argument")).toBe(true)
  })

  test("CASE-14: complete arg1 suggests candidate modelIds matching the partial", () => {
    const store = inMemoryStickyModelStore()
    const adapter = buildStickyModelAdapter({
      store,
      candidateIds: ["opus-4", "sonnet-4", "haiku-4"],
    })
    const ctx = mkCtx({ stickyModel: adapter }).ctx
    const hints = stickyCmd().complete?.(["plan"], "s", ctx) ?? []
    expect(hints.map((h) => h.value)).toEqual(["sonnet-4"])
  })

  test("CASE-15: complete is inert when not wired / past arg1", () => {
    const noCtx = mkCtx({}).ctx
    expect(stickyCmd().complete?.([], "", noCtx) ?? []).toEqual([])
    const store = inMemoryStickyModelStore()
    const ctx = mkCtx({ stickyModel: buildStickyModelAdapter({ store }) }).ctx
    expect(stickyCmd().complete?.(["plan", "opus"], "x", ctx) ?? []).toEqual([])
  })

  test("CASE-16: candidates() defaults to empty when none wired", () => {
    const a = buildStickyModelAdapter({ store: inMemoryStickyModelStore() })
    expect(a.candidates()).toEqual([])
  })

  // ── corrupt-file backup (B) ───────────────────────────────────────────────
  test("CASE-17: set on a CORRUPT file preserves the bytes to .corrupt.bak before overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sticky-corrupt-"))
    const path = join(dir, "sticky-model.json")
    writeFileSync(path, "{ this is not json ::::")
    const a = buildStickyModelAdapter({ store: fsBackedStickyModelStore({ path }) })
    expect(await a.set("plan", "opus")).toBe("ok")
    // the new entry landed...
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plan: "opus" })
    // ...and the corrupt bytes were preserved, not silently destroyed
    expect(readFileSync(`${path}.corrupt.bak`, "utf8")).toBe("{ this is not json ::::")
  })

  test("CASE-18: set on a VALID file does NOT spawn a .corrupt.bak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sticky-valid-"))
    const path = join(dir, "sticky-model.json")
    const a = buildStickyModelAdapter({ store: fsBackedStickyModelStore({ path }) })
    await a.set("plan", "opus")
    await a.set("review", "sonnet")
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plan: "opus", review: "sonnet" })
    expect(existsSync(`${path}.corrupt.bak`)).toBe(false)
  })
})
