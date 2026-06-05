/** jun-06 — MCP OAuth keyring ADAPTER hellgate (write FIRST: red → green).
 *
 *  Seals the macOS Keychain / libsecret adapters + platform selection + the
 *  serialize codec against a FAKE injected `exec`, every arm explicit:
 *    (A) NO secret on argv — a set() NEVER places the secret in any exec arg;
 *        it travels ONLY via stdin (no `ps`-visible secret);
 *    (B) round-trip — set writes via the CLI, get reads it back (trailing
 *        newline stripped), absent ⇒ undefined; a non-zero exit ⇒ undefined;
 *    (C) NO-THROW — every adapter op tolerates a non-zero exit / spawn error;
 *    (D) available() probes the CLI and maps a failure to false;
 *    (E) platform selection — darwin→macos, linux→libsecret, else→null;
 *    (F) parseRecord is TOTAL — corrupt/missing-field blobs ⇒ undefined.
 */

import { describe, expect, it } from "bun:test"
import type { TokenRecord } from "@/connectors"
import {
  createLibsecretKeyring,
  createMacosKeyring,
  createNullKeyring,
  type KeyringExec,
  type KeyringExecInput,
  parseRecord,
  selectKeyring,
  serializeRecord,
} from "@/host/runtime/keyring"

const REC: TokenRecord = {
  accessToken: "ACCESS-SECRET-XYZ",
  refreshToken: "REFRESH-SECRET-ABC",
  expiresAt: 1_700_000_000_000,
  tokenType: "Bearer",
}
const SECRET = serializeRecord(REC)

/** A recording fake exec with a scriptable result. */
const makeExec = (result: (input: KeyringExecInput) => { ok: boolean; stdout: string }) => {
  const calls: KeyringExecInput[] = []
  const exec: KeyringExec = async (input) => {
    calls.push(input)
    return result(input)
  }
  return { exec, calls }
}

// ── (A) NO secret on argv ───────────────────────────────────────────────────

describe("keyring adapters — secret NEVER on argv", () => {
  it("macOS set() feeds the secret on stdin, NOT in any exec arg", async () => {
    const { exec, calls } = makeExec(() => ({ ok: true, stdout: "" }))
    await createMacosKeyring(exec).set("svc", "srv", SECRET)

    const call = calls.at(-1)
    expect(call?.bin).toBe("security")
    expect(call?.stdin).toBe(SECRET) // secret on stdin
    // the secret appears in NO argv element
    for (const arg of call?.args ?? []) {
      expect(arg).not.toContain(REC.accessToken)
      expect(arg).not.toContain(REC.refreshToken)
      expect(arg).not.toBe(SECRET)
    }
  })

  it("libsecret set() feeds the secret on stdin, NOT in any exec arg", async () => {
    const { exec, calls } = makeExec(() => ({ ok: true, stdout: "" }))
    await createLibsecretKeyring(exec).set("svc", "srv", SECRET)

    const call = calls.at(-1)
    expect(call?.bin).toBe("secret-tool")
    expect(call?.stdin).toBe(SECRET)
    for (const arg of call?.args ?? []) {
      expect(arg).not.toContain(REC.accessToken)
      expect(arg).not.toContain(REC.refreshToken)
      expect(arg).not.toBe(SECRET)
    }
  })

  it("neither get nor delete ever carries a secret on stdin or argv", async () => {
    const { exec, calls } = makeExec(() => ({ ok: true, stdout: `${SECRET}\n` }))
    const k = createMacosKeyring(exec)
    await k.get("svc", "srv")
    await k.delete("svc", "srv")
    for (const c of calls) {
      expect(c.stdin).toBeUndefined()
      for (const arg of c.args) expect(arg).not.toBe(SECRET)
    }
  })
})

// ── (B) round-trip / (C) NO-THROW ───────────────────────────────────────────

describe("keyring adapters — round-trip + NO-THROW", () => {
  it("macOS get() strips the trailing newline; empty/non-zero ⇒ undefined", async () => {
    const ok = makeExec(() => ({ ok: true, stdout: `${SECRET}\n` }))
    expect(await createMacosKeyring(ok.exec).get("svc", "srv")).toBe(SECRET)

    const missing = makeExec(() => ({ ok: false, stdout: "" }))
    expect(await createMacosKeyring(missing.exec).get("svc", "srv")).toBeUndefined()

    const empty = makeExec(() => ({ ok: true, stdout: "\n" }))
    expect(await createMacosKeyring(empty.exec).get("svc", "srv")).toBeUndefined()
  })

  it("libsecret get() returns the secret; non-zero ⇒ undefined", async () => {
    const ok = makeExec(() => ({ ok: true, stdout: SECRET }))
    expect(await createLibsecretKeyring(ok.exec).get("svc", "srv")).toBe(SECRET)

    const missing = makeExec(() => ({ ok: false, stdout: "" }))
    expect(await createLibsecretKeyring(missing.exec).get("svc", "srv")).toBeUndefined()
  })

  it("a spawn-error exec (ok:false) never throws across every op", async () => {
    const fail = makeExec(() => ({ ok: false, stdout: "" }))
    for (const k of [createMacosKeyring(fail.exec), createLibsecretKeyring(fail.exec)]) {
      expect(await k.available()).toBe(false)
      expect(await k.get("svc", "srv")).toBeUndefined()
      await k.set("svc", "srv", SECRET) // no throw
      await k.delete("svc", "srv") // no throw
    }
  })
})

// ── (D) available() probe ───────────────────────────────────────────────────

describe("keyring adapters — available()", () => {
  it("maps a 0-exit probe to true and a non-zero probe to false", async () => {
    const up = makeExec(() => ({ ok: true, stdout: "" }))
    expect(await createMacosKeyring(up.exec).available()).toBe(true)
    expect(await createLibsecretKeyring(up.exec).available()).toBe(true)

    const down = makeExec(() => ({ ok: false, stdout: "" }))
    expect(await createMacosKeyring(down.exec).available()).toBe(false)
    expect(await createLibsecretKeyring(down.exec).available()).toBe(false)
  })

  it("the null keyring is always unavailable", async () => {
    const k = createNullKeyring()
    expect(await k.available()).toBe(false)
    expect(await k.get("svc", "srv")).toBeUndefined()
    await k.set("svc", "srv", SECRET)
    await k.delete("svc", "srv")
  })
})

// ── (E) platform selection ──────────────────────────────────────────────────

describe("selectKeyring — platform routing", () => {
  const exec: KeyringExec = async () => ({ ok: true, stdout: "" })
  it("darwin→macOS (security), linux→libsecret (secret-tool), else→null", async () => {
    const calls: string[] = []
    const probe: KeyringExec = async (input) => {
      calls.push(input.bin)
      return { ok: true, stdout: "" }
    }
    await selectKeyring("darwin", probe).available()
    await selectKeyring("linux", probe).available()
    expect(calls).toContain("security")
    expect(calls).toContain("secret-tool")

    // unsupported ⇒ null (never available, no exec)
    expect(await selectKeyring("win32", exec).available()).toBe(false)
    expect(await selectKeyring("aix", exec).available()).toBe(false)
  })
})

// ── (F) parseRecord total ───────────────────────────────────────────────────

describe("serialize — parseRecord is TOTAL", () => {
  it("round-trips a valid record", () => {
    expect(parseRecord(serializeRecord(REC))).toEqual(REC)
  })
  it("returns undefined for corrupt / empty / missing-field blobs", () => {
    expect(parseRecord(undefined)).toBeUndefined()
    expect(parseRecord("")).toBeUndefined()
    expect(parseRecord("not json{")).toBeUndefined()
    expect(parseRecord("null")).toBeUndefined()
    expect(parseRecord("[]")).toBeUndefined()
    expect(parseRecord("123")).toBeUndefined()
    expect(parseRecord(JSON.stringify({ tokenType: "Bearer" }))).toBeUndefined() // no accessToken
    expect(parseRecord(JSON.stringify({ accessToken: "" }))).toBeUndefined() // empty
    expect(parseRecord(JSON.stringify({ accessToken: "a" }))).toBeUndefined() // no tokenType
  })
  it("drops non-conforming optional fields", () => {
    const blob = JSON.stringify({
      accessToken: "a",
      tokenType: "Bearer",
      refreshToken: 42,
      expiresAt: "soon",
    })
    expect(parseRecord(blob)).toEqual({ accessToken: "a", tokenType: "Bearer" })
  })
})
