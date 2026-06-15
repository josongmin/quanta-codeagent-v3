/**
 * Hellgate — C1 artifact registry (PURE core). Plan: backlog §7 / Cursor Canvas.
 *
 * Pins the pure `createArtifactRegistry` + `previewUrl`:
 *  - register mints ids via the INJECTED idFactory (deterministic, no RNG);
 *  - createdAt comes from the INJECTED clock (no Date.now);
 *  - get/list/destroy round-trip; destroy unknown ⇒ false;
 *  - list is a deterministic (createdAt → id) immutable snapshot;
 *  - previewUrl is the stable `quanta-artifact://<id>` scheme;
 *  - exactOptional: `label` omitted (not undefined) when absent.
 */

import { describe, expect, test } from "bun:test"
import {
  ARTIFACT_KINDS,
  ARTIFACT_URL_SCHEME,
  type ArtifactSpec,
  createArtifactRegistry,
  DEFAULT_ARTIFACT_REGISTRY_MAX,
  monotonicIdFactory,
  previewUrl,
} from "@/artifact"

const spec = (over: Partial<ArtifactSpec> = {}): ArtifactSpec => ({
  kind: "image",
  path: "/jail/out/hero.png",
  mediaType: "image/png",
  ...over,
})

/** A registry with a deterministic clock + id factory (no Date.now / RNG). */
const fixedRegistry = (start = 1000) => {
  let t = start
  return createArtifactRegistry({
    now: () => {
      t += 1
      return t
    },
    idFactory: monotonicIdFactory("art"),
  })
}

describe("artifact registry — register / mint", () => {
  test("register mints monotonic ids + stamps createdAt from the injected clock", () => {
    const reg = fixedRegistry(1000)
    const a = reg.register(spec())
    const b = reg.register(spec({ path: "/jail/out/two.png" }))
    expect(a.id).toBe("art-1")
    expect(b.id).toBe("art-2")
    expect(a.createdAt).toBe(1001)
    expect(b.createdAt).toBe(1002)
    expect(a.kind).toBe("image")
    expect(a.mediaType).toBe("image/png")
    expect(a.path).toBe("/jail/out/hero.png")
  })

  test("label is OMITTED when absent (exactOptional), present when given", () => {
    const reg = fixedRegistry()
    const noLabel = reg.register(spec())
    expect("label" in noLabel).toBe(false)
    const labelled = reg.register(spec({ label: "Q3 chart" }))
    expect(labelled.label).toBe("Q3 chart")
  })

  test("every ArtifactKind round-trips", () => {
    const reg = fixedRegistry()
    for (const kind of ARTIFACT_KINDS) {
      const a = reg.register(spec({ kind }))
      expect(reg.get(a.id)?.kind).toBe(kind)
    }
  })
})

describe("artifact registry — get / list / destroy", () => {
  test("get returns the artifact; unknown id ⇒ undefined", () => {
    const reg = fixedRegistry()
    const a = reg.register(spec())
    expect(reg.get(a.id)?.id).toBe(a.id)
    expect(reg.get("nope")).toBeUndefined()
  })

  test("list is deterministic (createdAt then id) + an immutable snapshot", () => {
    const reg = fixedRegistry()
    const a = reg.register(spec())
    const b = reg.register(spec({ path: "/x" }))
    const list = reg.list()
    expect(list.map((x) => x.id)).toEqual([a.id, b.id])
    // Snapshot: mutating the returned array does not affect the registry.
    ;(list as unknown[]).push({})
    expect(reg.list()).toHaveLength(2)
  })

  test("destroy removes (true) and is false for an unknown id", () => {
    const reg = fixedRegistry()
    const a = reg.register(spec())
    expect(reg.destroy(a.id)).toBe(true)
    expect(reg.get(a.id)).toBeUndefined()
    expect(reg.list()).toHaveLength(0)
    expect(reg.destroy(a.id)).toBe(false)
    expect(reg.destroy("never")).toBe(false)
  })
})

describe("artifact registry — previewUrl scheme", () => {
  test("previewUrl is the stable quanta-artifact://<id> reference", () => {
    const reg = fixedRegistry()
    const a = reg.register(spec())
    expect(previewUrl(a)).toBe(`${ARTIFACT_URL_SCHEME}${a.id}`)
    expect(previewUrl(a)).toBe("quanta-artifact://art-1")
  })

  test("monotonicIdFactory honors the prefix + never repeats", () => {
    const f = monotonicIdFactory("img")
    expect([f(), f(), f()]).toEqual(["img-1", "img-2", "img-3"])
  })
})

describe("artifact registry — UNBOUNDED-GROWTH cap (FIFO eviction)", () => {
  /** A capped registry with a deterministic clock + id factory. */
  const capped = (maxEntries: number) =>
    createArtifactRegistry({
      now: () => 1,
      idFactory: monotonicIdFactory("art"),
      maxEntries,
    })

  test("ATTACK: 5000 registrations into a cap-3 store never grows past 3 (no leak)", () => {
    const reg = capped(3)
    for (let i = 0; i < 5000; i++) reg.register(spec({ path: `/jail/out/${i}.png` }))
    // Only the 3 most-recently registered survive; the store is bounded.
    expect(reg.list()).toHaveLength(3)
    expect(reg.list().map((a) => a.id)).toEqual(["art-4998", "art-4999", "art-5000"])
  })

  test("an EVICTED artifact's get returns a clean not-found (undefined), never a crash", () => {
    const reg = capped(2)
    const a = reg.register(spec())
    reg.register(spec({ path: "/b" }))
    reg.register(spec({ path: "/c" })) // evicts `a` (oldest)
    expect(reg.get(a.id)).toBeUndefined() // clean not-found
    expect(reg.list()).toHaveLength(2)
    expect(reg.list().some((x) => x.id === a.id)).toBe(false)
  })

  test("FIFO order: the OLDEST-inserted is evicted first (not the newest)", () => {
    const reg = capped(2)
    const a = reg.register(spec({ path: "/a" }))
    const b = reg.register(spec({ path: "/b" }))
    const c = reg.register(spec({ path: "/c" })) // a evicted
    expect(reg.get(a.id)).toBeUndefined()
    expect(reg.get(b.id)?.id).toBe(b.id)
    expect(reg.get(c.id)?.id).toBe(c.id)
  })

  test("destroy frees a slot so it does NOT count toward the cap", () => {
    const reg = capped(2)
    const a = reg.register(spec({ path: "/a" }))
    const b = reg.register(spec({ path: "/b" }))
    expect(reg.destroy(a.id)).toBe(true)
    // With a freed, a 3rd register fits without evicting b.
    const c = reg.register(spec({ path: "/c" }))
    expect(reg.get(b.id)?.id).toBe(b.id) // survived
    expect(reg.get(c.id)?.id).toBe(c.id)
    expect(reg.list()).toHaveLength(2)
  })

  test("finite <1 cap (0, negative) clamps to 1 (always holds most-recent, never empty)", () => {
    for (const bad of [0, -5]) {
      const reg = capped(bad)
      reg.register(spec({ path: "/a" }))
      const b = reg.register(spec({ path: "/b" }))
      expect(reg.list()).toHaveLength(1) // clamped to 1
      expect(reg.list()[0]?.id).toBe(b.id) // most-recent retained
    }
  })

  test("INFINITY cap falls back to the finite documented default (not unbounded)", () => {
    const reg = createArtifactRegistry({
      now: () => 1,
      idFactory: monotonicIdFactory("art"),
      maxEntries: Number.POSITIVE_INFINITY,
    })
    // Register exactly DEFAULT+1 and assert it bounded to DEFAULT.
    for (let i = 0; i < DEFAULT_ARTIFACT_REGISTRY_MAX + 1; i++) {
      reg.register(spec({ path: `/p/${i}` }))
    }
    expect(reg.list()).toHaveLength(DEFAULT_ARTIFACT_REGISTRY_MAX)
  })

  test("default cap (no maxEntries) is the documented finite bound", () => {
    const reg = createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory("art") })
    for (let i = 0; i < DEFAULT_ARTIFACT_REGISTRY_MAX + 5; i++) {
      reg.register(spec({ path: `/p/${i}` }))
    }
    expect(reg.list()).toHaveLength(DEFAULT_ARTIFACT_REGISTRY_MAX)
  })

  test("a duplicate/forged id OVERWRITES (Map.set) — no double-count, store stays bounded", () => {
    // A pathological idFactory that always mints the same id: the store must not
    // count it twice nor grow; it overwrites the single slot.
    const reg = createArtifactRegistry({
      now: () => 1,
      idFactory: () => "art-DUP",
      maxEntries: 3,
    })
    reg.register(spec({ path: "/a" }))
    reg.register(spec({ path: "/b" }))
    reg.register(spec({ path: "/c" }))
    expect(reg.list()).toHaveLength(1)
    expect(reg.get("art-DUP")?.path).toBe("/c") // last write wins
  })
})
