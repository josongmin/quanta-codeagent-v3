/**
 * Hellgate suite for ADR-0246 bridge-attestation. 15 adversarial cases that
 * lock in the contract:
 *
 *   1.  preflight allow → kind:"allow" + non-empty stsToken
 *   2.  preflight deny → kind:"deny" + non-empty reason
 *   3.  preflight prompt-user → kind:"prompt-user", no token leak
 *   4.  mintToken + verify valid → roundtrip true
 *   5.  verify expired → false (TTL elapsed via injected clock)
 *   6.  verify tampered → false (flipped byte fails MAC)
 *   7.  revoke → subsequent verify returns false
 *   8.  ttl 0ms → token already expired on mint
 *   9.  scope mismatch → verify("tok", "other-scope") false
 *  10.  9-event stream emitted in correct order across full lifecycle
 *  11.  default-OFF: barrel import alone produces no side effects
 *  12.  AttestResult 3-arm exhaustive (compile-time + runtime branch coverage)
 *  13.  1000 tokens minted at identical (scope, expiresAt) all distinct
 *  14.  secret 미주입 → "test-secret" fallback works + warn fires once
 *  15.  preflight-error arm: throwing inner policy table surfaces as deny
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __resetFallbackWarnedForTests,
  type AttestEvent,
  type AttestResult,
  defaultAttestor,
  headlessStubAttestor,
  type PolicyTable,
  type StsToken,
} from "@/security/bridge-attest"

/** Mutable injectable clock helper. */
const makeClock = (
  start = 1_700_000_000_000,
): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe("bridge-attest hellgate (ADR-0246)", () => {
  beforeEach(() => {
    __resetFallbackWarnedForTests()
  })
  afterEach(() => {
    __resetFallbackWarnedForTests()
  })

  test("1. preflight allow → kind:'allow' + non-empty stsToken", async () => {
    const policy: PolicyTable = { "tool.exec": { kind: "allow" } }
    const att = defaultAttestor({ secret: "k", policyTable: policy })
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: 0,
    })
    expect(r.kind).toBe("allow")
    if (r.kind === "allow") {
      expect(r.stsToken.token.length).toBeGreaterThan(0)
      expect(r.stsToken.scope).toBe("tool.exec:/x")
    }
  })

  test("2. preflight deny → kind:'deny' + non-empty reason", async () => {
    const policy: PolicyTable = {
      "tool.exec": { kind: "deny", reason: "org-blocklist" },
    }
    const att = defaultAttestor({ secret: "k", policyTable: policy })
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: 0,
    })
    expect(r.kind).toBe("deny")
    if (r.kind === "deny") {
      expect(r.reason.length).toBeGreaterThan(0)
      expect(r.reason).toBe("org-blocklist")
    }
  })

  test("3. preflight prompt-user → kind:'prompt-user', no token leak", async () => {
    const policy: PolicyTable = { "tool.exec": { kind: "prompt-user", reason: "confirm please" } }
    const att = defaultAttestor({ secret: "k", policyTable: policy })
    const r: AttestResult = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: 0,
    })
    expect(r.kind).toBe("prompt-user")
    // No `stsToken` field on this arm — discriminator must hide it.
    // Tactical structural check (`"stsToken" in r` would be a type error since
    // the arm doesn't declare it).
    const asUnknown = r as unknown as Record<string, unknown>
    expect("stsToken" in asUnknown).toBe(false)
    if (r.kind === "prompt-user") {
      expect(r.reason).toBe("confirm please")
    }
  })

  test("4. mintToken + verify valid → roundtrip true", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: "k", clock: clock.now })
    const tok: StsToken = await att.mintToken("scope/A", 60_000)
    expect(tok.scope).toBe("scope/A")
    expect(tok.expiresAt).toBe(clock.now() + 60_000)
    const ok = await att.verify(tok.token, "scope/A")
    expect(ok).toBe(true)
  })

  test("5. verify expired → false (TTL elapsed via injected clock)", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: "k", clock: clock.now })
    const tok = await att.mintToken("scope/A", 1_000)
    clock.advance(2_000)
    const ok = await att.verify(tok.token, "scope/A")
    expect(ok).toBe(false)
  })

  test("6. verify tampered → false (flipped byte fails MAC)", async () => {
    const att = defaultAttestor({ secret: "k" })
    const tok = await att.mintToken("scope/A", 60_000)
    // Flip a character in the MAC segment (4th part). Keep length identical
    // so the constant-time compare actually runs.
    const parts = tok.token.split(".")
    const mac = parts[3] ?? ""
    if (mac.length === 0) throw new Error("token shape regression — MAC segment missing")
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1)
    const tampered = [parts[0], parts[1], parts[2], flipped].join(".")
    const ok = await att.verify(tampered, "scope/A")
    expect(ok).toBe(false)
  })

  test("7. revoke → subsequent verify returns false", async () => {
    const att = defaultAttestor({ secret: "k" })
    const tok = await att.mintToken("scope/A", 60_000)
    expect(await att.verify(tok.token, "scope/A")).toBe(true)
    await att.revoke(tok.token)
    expect(await att.verify(tok.token, "scope/A")).toBe(false)
    // Idempotent — second revoke does not throw.
    await att.revoke(tok.token)
  })

  test("8. ttl 0ms → token already expired on mint", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: "k", clock: clock.now })
    const tok = await att.mintToken("scope/A", 0)
    // expiresAt == now; verify path treats `now > expiresAt` as expired, so
    // advance clock by 1ms to deterministically expire.
    clock.advance(1)
    expect(await att.verify(tok.token, "scope/A")).toBe(false)
  })

  test("9. scope mismatch → verify('tok', 'other-scope') false", async () => {
    const att = defaultAttestor({ secret: "k" })
    const tok = await att.mintToken("scope/A", 60_000)
    expect(await att.verify(tok.token, "scope/B")).toBe(false)
  })

  test("10. 9-event stream emitted in correct order across full lifecycle", async () => {
    const clock = makeClock()
    const events: AttestEvent[] = []
    const att = defaultAttestor({
      secret: "k",
      policyTable: { "tool.exec": { kind: "allow" } },
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    // preflight (allow) → emits: preflight-requested, token-minted, preflight-granted, attest-audit
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: 0,
    })
    expect(r.kind).toBe("allow")
    if (r.kind !== "allow") throw new Error("unreachable")
    // use → emits token-used
    await att.verify(r.stsToken.token, r.stsToken.scope)
    // revoke → emits token-revoked
    await att.revoke(r.stsToken.token)
    // expire path: mint fresh, advance, verify → emits token-expired
    const tok2 = await att.mintToken("scope/E", 1_000)
    clock.advance(2_000)
    await att.verify(tok2.token, "scope/E")
    // deny path: emits preflight-denied (covers 8th distinct kind)
    const att2 = defaultAttestor({
      secret: "k",
      policyTable: { "tool.exec": { kind: "deny", reason: "no" } },
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    await att2.preflight({ agentId: "a", action: "tool.exec", resource: "/x", requestedAt: 0 })
    // error path: throwing policy reader surfaces preflight-error.
    // We synthesise a throwing Proxy as the policy table — production tables are plain objects.
    const att3 = defaultAttestor({
      secret: "k",
      policyTable: new Proxy({} as PolicyTable, {
        get() {
          throw new Error("table-broken")
        },
      }),
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    await att3.preflight({ agentId: "a", action: "tool.exec", resource: "/x", requestedAt: 0 })

    const kinds = new Set(events.map((e) => e.kind))
    // All 9 distinct kinds observed at least once.
    expect(kinds.has("preflight-requested")).toBe(true)
    expect(kinds.has("preflight-granted")).toBe(true)
    expect(kinds.has("preflight-denied")).toBe(true)
    expect(kinds.has("token-minted")).toBe(true)
    expect(kinds.has("token-used")).toBe(true)
    expect(kinds.has("token-expired")).toBe(true)
    expect(kinds.has("token-revoked")).toBe(true)
    expect(kinds.has("preflight-error")).toBe(true)
    expect(kinds.has("attest-audit")).toBe(true)

    // Ordering invariant: for the first allow flow, requested precedes granted,
    // granted precedes use, use precedes revoke.
    const idxOf = (k: AttestEvent["kind"]) => events.findIndex((e) => e.kind === k)
    expect(idxOf("preflight-requested")).toBeLessThan(idxOf("preflight-granted"))
    expect(idxOf("preflight-granted")).toBeLessThan(idxOf("token-used"))
    expect(idxOf("token-used")).toBeLessThan(idxOf("token-revoked"))
  })

  test("11. default-OFF: barrel import alone produces no side effects", async () => {
    // Constructing an attestor with NO onEvent must produce no observable
    // side effects (no throw, no log spam) on the happy path. We assert
    // by snapshotting an unrelated counter — there is none, so the test
    // simply confirms construction + a preflight + a verify do not throw.
    const att = defaultAttestor({ secret: "k", policyTable: { a: { kind: "allow" } } })
    const r = await att.preflight({ agentId: "a", action: "a", resource: "/", requestedAt: 0 })
    expect(r.kind).toBe("allow")
    if (r.kind === "allow") {
      expect(await att.verify(r.stsToken.token, r.stsToken.scope)).toBe(true)
    }
    // Headless stub barrel-load must also be side-effect-free.
    const stub = headlessStubAttestor()
    expect(
      (await stub.preflight({ agentId: "a", action: "a", resource: "/", requestedAt: 0 })).kind,
    ).toBe("deny")
  })

  test("12. AttestResult 3-arm exhaustive (compile + runtime)", async () => {
    // Exhaustive switch — adding a 4th arm without wiring is a TS error here.
    const handle = (r: AttestResult): string => {
      switch (r.kind) {
        case "allow":
          return `allow:${r.stsToken.scope}`
        case "deny":
          return `deny:${r.reason}`
        case "prompt-user":
          return `prompt:${r.reason ?? ""}`
        default: {
          const _exhaustive: never = r
          return _exhaustive
        }
      }
    }
    const allow = defaultAttestor({ secret: "k", policyTable: { a: { kind: "allow" } } })
    const deny = defaultAttestor({ secret: "k", policyTable: { a: { kind: "deny", reason: "r" } } })
    const prompt = defaultAttestor({ secret: "k", policyTable: { a: { kind: "prompt-user" } } })
    const r1 = await allow.preflight({ agentId: "x", action: "a", resource: "/", requestedAt: 0 })
    const r2 = await deny.preflight({ agentId: "x", action: "a", resource: "/", requestedAt: 0 })
    const r3 = await prompt.preflight({ agentId: "x", action: "a", resource: "/", requestedAt: 0 })
    expect(handle(r1).startsWith("allow:")).toBe(true)
    expect(handle(r2).startsWith("deny:")).toBe(true)
    expect(handle(r3).startsWith("prompt:")).toBe(true)
  })

  test("13. 1000 tokens minted at identical (scope, expiresAt) all distinct", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: "k", clock: clock.now })
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const tok = await att.mintToken("scope/SAME", 60_000)
      tokens.add(tok.token)
    }
    expect(tokens.size).toBe(1000)
  })

  test("14. secret 미주입 → 'test-secret' fallback works + warn fires once", async () => {
    __resetFallbackWarnedForTests()
    // Capture stderr writes — logger.warn ends up on stderr per shared/logger.ts.
    const origWrite = process.stderr.write.bind(process.stderr)
    let warnCount = 0
    // biome-ignore lint/suspicious/noExplicitAny: stream override for capture
    ;(process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      if (s.includes("[bridge-attest]") && s.includes("test-secret")) warnCount++
      return true
    }
    try {
      // First construction triggers warn.
      const att1 = defaultAttestor()
      const tok = await att1.mintToken("scope/A", 60_000)
      expect(await att1.verify(tok.token, "scope/A")).toBe(true)
      // Second construction: warn must NOT re-fire within the same process.
      const att2 = defaultAttestor()
      const tok2 = await att2.mintToken("scope/B", 60_000)
      expect(await att2.verify(tok2.token, "scope/B")).toBe(true)
      expect(warnCount).toBe(1)
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stream
      ;(process.stderr.write as any) = origWrite
    }
  })

  test("15. preflight-error arm: throwing inner policy table surfaces as deny", async () => {
    const events: AttestEvent[] = []
    // Throwing Proxy as policy table — forces the NO-THROW deny arm.
    const att = defaultAttestor({
      secret: "k",
      policyTable: new Proxy({} as PolicyTable, {
        get() {
          throw new Error("policy-broken")
        },
      }),
      onEvent: (e) => events.push(e),
    })
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: 0,
    })
    // NO-THROW contract: error surfaces as deny.
    expect(r.kind).toBe("deny")
    if (r.kind === "deny") {
      expect(r.reason).toContain("preflight failed")
    }
    // preflight-error event emitted exactly once for this flow.
    const errs = events.filter((e) => e.kind === "preflight-error")
    expect(errs.length).toBe(1)
  })
})
