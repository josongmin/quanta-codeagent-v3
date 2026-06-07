/**
 * HELLGATE — per-project trust store path-pinning + default-untrusted
 * (ADR-0497, jun-7-misc 05, §4.c). Red-on-injection: trust must NOT leak via
 * path aliasing, and a never-seen path must be untrusted.
 */

import { describe, expect, test } from "bun:test"
import {
  type TrustPersistencePort,
  type TrustRecord,
  TrustStore,
  canonicalizeProjectPath,
  canonicalizeTrustedPaths,
} from "@/config"

const emptyPort = (): TrustPersistencePort => {
  let saved: Readonly<Record<string, TrustRecord>> | undefined
  return {
    load: async () => saved,
    save: async (r) => {
      saved = r
    },
  }
}

describe("default UNTRUSTED", () => {
  test("a never-seen path is untrusted", async () => {
    const store = await TrustStore.load(emptyPort())
    expect(store.isTrusted("/never/seen")).toBe(false)
  })
})

describe("trust is path-pinned (no aliasing leak)", () => {
  test("trusting /a does NOT trust /b", async () => {
    const store = await TrustStore.load(emptyPort())
    store.setTrusted("/a", 1)
    expect(store.isTrusted("/a")).toBe(true)
    expect(store.isTrusted("/b")).toBe(false)
  })

  test("trusting /a does NOT trust child /a/sub", async () => {
    const store = await TrustStore.load(emptyPort())
    store.setTrusted("/a", 1)
    // RED-ON-INJECTION: if canonicalization collapsed children into the parent,
    // a child would inherit trust — a hostile sub-repo escalation.
    expect(store.isTrusted("/a/sub")).toBe(false)
  })

  test("aliased spellings canonicalize to ONE key (trailing slash, ./, /./)", async () => {
    const store = await TrustStore.load(emptyPort())
    store.setTrusted("/a/b", 1)
    expect(store.isTrusted("/a/b/")).toBe(true)
    expect(store.isTrusted("/a/./b")).toBe(true)
    expect(store.isTrusted("/a/x/../b")).toBe(true)
    expect(canonicalizeProjectPath("/a/b/")).toBe(canonicalizeProjectPath("/a/./b"))
  })

  test("relative path resolves against cwd; bare relative without cwd throws", async () => {
    const store = await TrustStore.load(emptyPort())
    store.setTrusted("/root/proj", 1)
    expect(store.isTrusted("proj", "/root")).toBe(true)
    expect(() => canonicalizeProjectPath("rel/path")).toThrow()
  })
})

describe("persistence round-trip", () => {
  test("a granted trust survives a reload; flush is a no-op when clean", async () => {
    const port = emptyPort()
    const a = await TrustStore.load(port)
    expect(a.isTrusted("/proj")).toBe(false)
    // clean store: flush writes nothing
    await a.flush()
    a.setTrusted("/proj", 123)
    await a.flush()
    const b = await TrustStore.load(port)
    expect(b.isTrusted("/proj")).toBe(true)
  })
})

describe("static trusted-path allow-list (headless/CI opt-in)", () => {
  test("canonicalizes entries; drops a relative entry without cwd (never silently trusted)", () => {
    const set = canonicalizeTrustedPaths(["/ci/repo", "  ", "rel/only"])
    expect(set.has(canonicalizeProjectPath("/ci/repo"))).toBe(true)
    expect(set.has("rel/only")).toBe(false)
    expect(set.size).toBe(1)
  })
})
