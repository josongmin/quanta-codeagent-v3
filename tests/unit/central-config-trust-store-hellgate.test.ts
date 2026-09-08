/**
 * HELLGATE — per-project trust store path-pinning + default-untrusted
 * (ADR-0497, jun-7-misc 05, §4.c). Red-on-injection: trust must NOT leak via
 * path aliasing, and a never-seen path must be untrusted.
 */

import { describe, expect, test } from "bun:test"
import {
  canonicalizeProjectPath,
  canonicalizeTrustedPaths,
  type TrustPersistencePort,
  type TrustRecord,
  TrustStore,
} from "@/config"

const emptyPort = (): TrustPersistencePort => {
  let saved: Readonly<Record<string, TrustRecord>> | undefined
  return {
    load: async () => saved,
    commit: async (mutations) => {
      saved = { ...(saved ?? {}), ...mutations }
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

describe("corrupt/forged persisted trust file is fail-soft (never crashes hydration)", () => {
  // RED-ON-INJECTION: TrustStore.load must mirror the slice's fail-soft parse
  // discipline. A persisted trust map that carries an un-canonicalizable key
  // (a relative path, an empty string — corruption, or a forged file trying to
  // DoS the store) must NOT throw out of load() and must NOT discard the valid
  // records that share the file. If the per-key guard is removed, load() throws
  // and the entire trust store (including legitimately-trusted paths) is lost.
  const malicious = (raw: Readonly<Record<string, TrustRecord>>): TrustPersistencePort => ({
    load: async () => raw,
    commit: async () => {},
  })

  test("a relative/empty key does not throw and does not nuke the valid records", async () => {
    const store = await TrustStore.load(
      malicious({
        "relative/key": { trusted: true, grantedAt: 0 },
        "": { trusted: true, grantedAt: 0 },
        "/abs/ok": { trusted: true, grantedAt: 7 },
      } as Readonly<Record<string, TrustRecord>>),
    )
    // the valid absolute record survived the corrupt siblings
    expect(store.isTrusted("/abs/ok")).toBe(true)
    // the relative key was NOT silently trusted under some coerced spelling
    expect(store.isTrusted("relative/key", "/somewhere")).toBe(false)
    expect(store.isTrusted("/somewhere/relative/key")).toBe(false)
  })

  test("a non-canonicalizable LOOKUP path fails CLOSED (untrusted), never throws", async () => {
    // RED-ON-INJECTION (round-3 F4): the security GATE read (`isTrusted`) must
    // be fail-closed, exactly like the store's default-untrusted posture and
    // the loader's fail-soft discipline. A non-canonicalizable lookup path — a
    // relative path or empty string handed in without a cwd base — must resolve
    // to UNTRUSTED (false), NEVER propagate a throw out of the trust gate. A
    // throwing gate is both an availability bug (it crashes the session at the
    // trust check) and a fail-open risk (an upstream catch could mishandle the
    // throw). If the per-lookup guard is removed (direct canonicalize), this
    // call throws and the test goes RED.
    const store = await TrustStore.load(emptyPort())
    store.setTrusted("/abs/ok", 1)
    expect(store.isTrusted("relative/lookup")).toBe(false)
    expect(store.isTrusted("")).toBe(false)
    // the legitimately-trusted absolute path is unaffected by the fail-soft read
    expect(store.isTrusted("/abs/ok")).toBe(true)
    // an explicit untrust read on a relative path also fails closed, not throws
    expect(store.setUntrusted).toBeDefined()
  })

  test("a key whose value is not a record is skipped, valid sibling survives", async () => {
    const store = await TrustStore.load(
      malicious({
        "/abs/ok": { trusted: true, grantedAt: 1 },
        "/abs/bad": null as unknown as TrustRecord,
      }),
    )
    expect(store.isTrusted("/abs/ok")).toBe(true)
    expect(store.isTrusted("/abs/bad")).toBe(false)
  })
})
