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
