/**
 * Sticky model-per-mode hellgate (ADR-0212).
 *
 * Adversarial battery locking the sticky-model store + resolver contract.
 *
 * Wire order:
 *   HELL-SM-01 — set/get round-trip on in-memory store
 *   HELL-SM-02 — get returns undefined for unset mode (no preference)
 *   HELL-SM-03 — fs-backed: set then get via a NEW instance reads back same value
 *   HELL-SM-04 — fs-backed: corrupt file → load returns ok:false + empty snapshot
 *   HELL-SM-05 — fs-backed: corrupt file → get returns undefined, no throw
 *   HELL-SM-06 — fs-backed: atomic write — set never produces a torn file
 *   HELL-SM-07 — fs-backed: missing parent dir is created on set
 *   HELL-SM-08 — multi-mode independent — setting plan does not affect editor
 *   HELL-SM-09 — set is idempotent (writing same value twice)
 *   HELL-SM-10 — resolver: explicitOverride wins over sticky + global default
 *   HELL-SM-11 — resolver: sticky wins over global default
 *   HELL-SM-12 — resolver: globalDefault returned when no sticky entry
 *   HELL-SM-13 — resolver: empty-string override falls through to sticky/default
 *   HELL-SM-14 — fs-backed: ENOENT on read is treated as empty (not corruption)
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fsBackedStickyModelStore,
  inMemoryStickyModelStore,
  StickyModelLoadCorruptionError,
  stickyModelResolver,
} from "@/agent/sticky-model"

const tempDir = (): string => mkdtempSync(join(tmpdir(), "quanta-sticky-hellgate-"))

describe("sticky-model store hellgate (ADR-0212)", () => {
  test("HELL-SM-01 — in-memory set/get round-trip", async () => {
    const store = inMemoryStickyModelStore()
    await store.set({ mode: "plan", modelId: "gpt-5-thinking" })
    const got = await store.get({ mode: "plan" })
    expect(got).toBe("gpt-5-thinking")
  })

  test("HELL-SM-02 — get returns undefined for unset mode (no preference)", async () => {
    const store = inMemoryStickyModelStore()
    const got = await store.get({ mode: "audit" })
    expect(got).toBeUndefined()
  })

  test("HELL-SM-03 — fs-backed: write then read via a fresh instance", async () => {
    const dir = tempDir()
    try {
      const path = join(dir, "sticky.json")
      const w = fsBackedStickyModelStore({ path })
      const result = await w.set({ mode: "audit", modelId: "claude-haiku-3.5" })
      expect(result.ok).toBe(true)
      const r = fsBackedStickyModelStore({ path })
      const got = await r.get({ mode: "audit" })
      expect(got).toBe("claude-haiku-3.5")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-SM-04 — fs-backed: corrupt file → load returns ok:false + empty snapshot", async () => {
    const dir = tempDir()
    try {
      const path = join(dir, "sticky.json")
      writeFileSync(path, "{ this is not valid json", "utf8")
      const store = fsBackedStickyModelStore({ path })
      const result = await store.load()
      expect(result.ok).toBe(false)
      expect(result.snapshot).toEqual({})
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(StickyModelLoadCorruptionError)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-SM-05 — fs-backed: corrupt file → get returns undefined (no throw)", async () => {
    const dir = tempDir()
    try {
      const path = join(dir, "sticky.json")
      writeFileSync(path, "[]", "utf8") // array, not object — shape mismatch
      const store = fsBackedStickyModelStore({ path })
      // No throw, just empty.
      const got = await store.get({ mode: "plan" })
      expect(got).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-SM-06 — fs-backed: atomic write — set never produces torn file", async () => {
    const dir = tempDir()
    try {
      const path = join(dir, "sticky.json")
      const store = fsBackedStickyModelStore({ path })
      // Concurrent set's to different keys; load must return either
      // pre-state OR post-state, never a mid-write torn JSON.
      const ops = [
        store.set({ mode: "plan", modelId: "model-a" }),
        store.set({ mode: "audit", modelId: "model-b" }),
        store.set({ mode: "review", modelId: "model-c" }),
      ]
      const results = await Promise.all(ops)
      for (const r of results) {
        expect(r.ok).toBe(true)
      }
      const load = await store.load()
      expect(load.ok).toBe(true)
      // At least one key must have landed (write-file-atomic guarantees
      // last-write-wins on rename, not that all 3 land — concurrent rmw
      // is racy by design, and we test that point in the read path NOT
      // crashing rather than that all 3 land).
      const keys = Object.keys(load.snapshot)
      expect(keys.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-SM-07 — fs-backed: missing parent dir is created on set", async () => {
    const dir = tempDir()
    try {
      // Nested path the store has to mkdir-p
      const path = join(dir, "a", "b", "c", "sticky.json")
      const store = fsBackedStickyModelStore({ path })
      const result = await store.set({ mode: "plan", modelId: "gpt-5" })
      expect(result.ok).toBe(true)
      const got = await store.get({ mode: "plan" })
      expect(got).toBe("gpt-5")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("HELL-SM-08 — multi-mode independent: setting plan does not affect editor", async () => {
    const store = inMemoryStickyModelStore()
    await store.set({ mode: "plan", modelId: "model-plan" })
    await store.set({ mode: "audit", modelId: "model-editor" })
    expect(await store.get({ mode: "plan" })).toBe("model-plan")
    expect(await store.get({ mode: "audit" })).toBe("model-editor")
    expect(await store.get({ mode: "review" })).toBeUndefined()
  })

  test("HELL-SM-09 — set is idempotent (same value twice = no semantic change)", async () => {
    const store = inMemoryStickyModelStore()
    const r1 = await store.set({ mode: "plan", modelId: "X" })
    const r2 = await store.set({ mode: "plan", modelId: "X" })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(await store.get({ mode: "plan" })).toBe("X")
  })

  test("HELL-SM-10 — resolver: explicitOverride wins over sticky AND global default", async () => {
    const store = inMemoryStickyModelStore({ plan: "sticky-pick" })
    const r = stickyModelResolver(store)
    const got = await r.resolve({
      mode: "plan",
      globalDefault: "global",
      explicitOverride: "explicit-pick",
    })
    expect(got).toBe("explicit-pick")
  })

  test("HELL-SM-11 — resolver: sticky wins over global default when no override", async () => {
    const store = inMemoryStickyModelStore({ plan: "sticky-pick" })
    const r = stickyModelResolver(store)
    const got = await r.resolve({ mode: "plan", globalDefault: "global" })
    expect(got).toBe("sticky-pick")
  })

  test("HELL-SM-12 — resolver: globalDefault returned when no sticky entry", async () => {
    const store = inMemoryStickyModelStore()
    const r = stickyModelResolver(store)
    const got = await r.resolve({ mode: "audit", globalDefault: "global-fallback" })
    expect(got).toBe("global-fallback")
  })

  test("HELL-SM-13 — resolver: empty-string override falls through (treated as no override)", async () => {
    const store = inMemoryStickyModelStore({ plan: "sticky" })
    const r = stickyModelResolver(store)
    const got = await r.resolve({
      mode: "plan",
      globalDefault: "global",
      explicitOverride: "",
    })
    // Empty string is NOT a valid override — fall through to sticky.
    expect(got).toBe("sticky")
  })

  test("HELL-SM-14 — fs-backed: ENOENT on first read is treated as empty (not corruption)", async () => {
    const dir = tempDir()
    try {
      const path = join(dir, "never-existed.json")
      const store = fsBackedStickyModelStore({ path })
      const load = await store.load()
      expect(load.ok).toBe(true)
      expect(load.snapshot).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
