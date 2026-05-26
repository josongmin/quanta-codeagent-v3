/**
 * ADR-0311 hellgate R2 — payload fuzz battery for parseGhEventFile +
 * normalizeGhEvent. Targets non-obvious shapes R1 didn't seal: byte-exact
 * boundary at the 10MB cap, deep nesting (no stack overflow), prototype
 * pollution attempts, unicode anomalies, BOM + leading garbage, duplicate
 * top-level keys, and oversized strings.
 *
 * Invariant: every hostile input collapses to `undefined` from
 * parseGhEventFile OR (when normalize sees a partial payload) the output
 * is well-defined — never throws.
 */

import { describe, expect, test } from "bun:test"

import { normalizeGhEvent, parseGhEventFile } from "@/integrations/github"

import { fakeFs } from "./_helpers"

const readFromBuf = async (buf: Buffer | string) =>
  parseGhEventFile({
    fsPort: fakeFs({ "/e.json": buf }),
    path: "/e.json",
  })

describe("ADR-0311 hellgate R2 — payload fuzz", () => {
  test("10MB exact boundary (10485760 bytes valid JSON object) ⇒ parsed", async () => {
    // Build a JSON object whose UTF-8 byte length is EXACTLY 10485760.
    // `{"a":"...padding..."}` — outer 8 chars + N pad chars; choose N so total = 10485760.
    const overhead = `{"a":""}`.length // 8
    const pad = 10 * 1024 * 1024 - overhead
    const json = `{"a":"${"x".repeat(pad)}"}`
    expect(Buffer.byteLength(json, "utf8")).toBe(10 * 1024 * 1024)
    const out = await readFromBuf(json)
    expect(out).toBeDefined()
  })

  test("10MB+1 byte (10485761) ⇒ undefined (one byte over cap)", async () => {
    const overhead = `{"a":""}`.length
    const pad = 10 * 1024 * 1024 + 1 - overhead
    const json = `{"a":"${"x".repeat(pad)}"}`
    expect(Buffer.byteLength(json, "utf8")).toBe(10 * 1024 * 1024 + 1)
    const out = await readFromBuf(json)
    expect(out).toBeUndefined()
  })

  test("100-deep nested object does NOT stack overflow", async () => {
    let core = "0"
    for (let i = 0; i < 100; i++) core = `{"n":${core}}`
    const json = `{"repository":{"owner":{"login":"o"},"name":"r"},"deep":${core}}`
    const raw = await readFromBuf(json)
    expect(raw).toBeDefined()
    // normalize also must not throw on a deep `raw` field
    expect(() => normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })).not.toThrow()
  })

  test("sender.login = null ⇒ normalized to 'unknown' fallback", async () => {
    const json = JSON.stringify({
      action: "x",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: null, type: "User" },
    })
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev).toBeDefined()
    expect(ev?.sender.login).toBe("unknown")
  })

  test("__proto__ pollution attempt cannot escape to Object.prototype", async () => {
    const polluted = `{"__proto__":{"polluted":"yes"},"repository":{"owner":{"login":"o"},"name":"r"}}`
    const raw = await readFromBuf(polluted)
    expect(raw).toBeDefined()
    // Prototype must NOT be polluted on the global Object.
    const probe: Record<string, unknown> = {}
    expect(probe.polluted).toBeUndefined()
    // Normalize must still produce a well-formed event (no leak of polluted key).
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev).toBeDefined()
  })

  test("RTL override in sender.login is surfaced verbatim (caller sanitizes)", async () => {
    // The slice does NOT silently strip control chars; it surfaces them so
    // downstream redact/display layers can decide. We only assert no-throw +
    // deterministic surface.
    const malicious = "alice‮"
    const json = JSON.stringify({
      action: "x",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: malicious, type: "User" },
    })
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev?.sender.login).toBe(malicious)
  })

  test("1MB repo.name string is accepted (under file cap) without truncation", async () => {
    const giantName = "n".repeat(1024 * 1024)
    const json = JSON.stringify({
      action: "x",
      repository: { owner: { login: "o" }, name: giantName },
    })
    // The whole file is still under 10MB.
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev?.repo.name.length).toBe(giantName.length)
  })

  test("PR number as string instead of number ⇒ NOT coerced ⇒ prNumber absent", async () => {
    const json = JSON.stringify({
      action: "opened",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: "a", type: "User" },
      // pull_request.number is a STRING — must not coerce.
      pull_request: { number: "5", body: "hi" },
    })
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "pull_request", deliveryId: "d" })
    expect(ev?.prNumber).toBeUndefined()
  })

  test("sender as array instead of object ⇒ fallback to defaults (login='unknown')", async () => {
    const json = `{
      "action":"x",
      "repository":{"owner":{"login":"o"},"name":"r"},
      "sender":[1,2,3]
    }`
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev).toBeDefined()
    expect(ev?.sender.login).toBe("unknown")
    expect(ev?.sender.type).toBe("User")
  })

  test("duplicate top-level keys ⇒ JSON parser uses last (object override semantics)", async () => {
    // JSON.parse keeps the LAST value for duplicate keys.
    const json = `{"action":"first","action":"second","repository":{"owner":{"login":"o"},"name":"r"}}`
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "issues", deliveryId: "d" })
    expect(ev?.action).toBe("second")
  })

  test("BOM-only file (no JSON after) ⇒ undefined", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    expect(await readFromBuf(bom)).toBeUndefined()
  })

  test("BOM + leading whitespace + valid JSON ⇒ parsed", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const ws = Buffer.from("   \n\t  ", "utf8")
    const body = Buffer.from(
      JSON.stringify({ repository: { owner: { login: "o" }, name: "r" } }),
      "utf8",
    )
    const out = await readFromBuf(Buffer.concat([bom, ws, body]))
    expect(out).toBeDefined()
  })

  test("invalid UTF-8 byte sequence (lone high byte) does not throw", async () => {
    // 0xC0 is an invalid UTF-8 leading byte on its own. Buffer.toString("utf8")
    // replaces it with U+FFFD; JSON.parse rejects the surrounding context.
    const corrupted = Buffer.concat([
      Buffer.from('{"action":"', "utf8"),
      Buffer.from([0xc0]),
      Buffer.from('"}', "utf8"),
    ])
    // No throw. Outcome may be undefined OR an object — both are acceptable.
    const out = await readFromBuf(corrupted)
    if (out !== undefined) {
      expect(typeof out).toBe("object")
    }
  })

  test("circular-shaped raw passed directly to normalize does NOT throw", () => {
    // Simulate a host that hands us a structurally circular object (e.g. a
    // proxy or reused parent ref). JSON.parse can't build this directly, but
    // a buggy upstream might.
    type Cyclic = { repository: { owner: { login: string }; name: string }; self?: unknown }
    const cyclic: Cyclic = {
      repository: { owner: { login: "o" }, name: "r" },
    }
    cyclic.self = cyclic
    expect(() => normalizeGhEvent({ raw: cyclic, kind: "issues", deliveryId: "d" })).not.toThrow()
  })

  test("PR number = 0 ⇒ rejected (not a valid PR number)", async () => {
    const json = JSON.stringify({
      action: "opened",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: "a", type: "User" },
      pull_request: { number: 0 },
    })
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "pull_request", deliveryId: "d" })
    expect(ev?.prNumber).toBeUndefined()
  })

  test("PR number negative ⇒ rejected", async () => {
    const json = JSON.stringify({
      action: "opened",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: "a", type: "User" },
      pull_request: { number: -3 },
    })
    const raw = await readFromBuf(json)
    const ev = normalizeGhEvent({ raw, kind: "pull_request", deliveryId: "d" })
    expect(ev?.prNumber).toBeUndefined()
  })
})
