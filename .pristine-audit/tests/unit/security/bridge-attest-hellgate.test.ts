/**
 * Hellgate suite for ADR-0246 bridge-attestation. 17 adversarial cases that
 * lock in the contract:
 *
 *   1.  preflight allow → kind:"allow" + non-empty stsToken
 *   2.  preflight deny → kind:"deny" + non-empty reason
 *   3.  preflight prompt-user → kind:"prompt-user", no token leak
 *   4.  allow preflight + verify valid → roundtrip true
 *   5.  verify expired → false (TTL elapsed via injected clock)
 *   6.  verify tampered → false (flipped byte fails MAC)
 *   7.  revoke → subsequent verify returns false
 *   8.  canonical TTL token expires after its bounded lifetime
 *   9.  scope mismatch → verify("tok", "other-scope") false
 *  10.  9-event stream emitted in correct order across full lifecycle
 *  11.  default-OFF: barrel import alone produces no side effects
 *  12.  AttestResult 3-arm exhaustive (compile-time + runtime branch coverage)
 *  13.  1000 allow preflights at identical time issue distinct tokens
 *  14.  missing/blank/weak signing secret fails closed at construction
 *  15.  preflight-error arm: throwing inner policy table surfaces as deny
 *  16.  stale/future timestamps deny before policy lookup or token mint
 *  17.  canonical scope binds agent + action + resource without delimiter collisions
 */
import { describe, expect, test } from "bun:test"
import {
  AttestError,
  type AttestEvent,
  type AttestResult,
  attestationScopeFor,
  defaultAttestor,
  headlessStubAttestor,
  type PolicyTable,
} from "@/security/bridge-attest"

/** Explicit test-only HMAC key: production construction rejects convenience
 * strings and must always receive caller-owned secret material. */
const TEST_SECRET = "test-only-hmac-secret-material-32bytes"

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

/** Only an allow preflight may issue a token. Keeping test issuance on this
 * public path proves the port has no policy-bypass mint capability. */
const issueAllow = async (
  att: ReturnType<typeof defaultAttestor>,
  resource = "scope/A",
  requestedAt = Date.now(),
) => {
  const result = await att.preflight({
    agentId: "test-agent",
    action: "test.allow",
    resource,
    requestedAt,
  })
  if (result.kind !== "allow") throw new Error("test allow policy did not issue a token")
  return result.stsToken
}

const allowPolicy: PolicyTable = { "test.allow": { kind: "allow" } }

describe("bridge-attest hellgate (ADR-0246)", () => {
  test("1. preflight allow → kind:'allow' + non-empty stsToken", async () => {
    const policy: PolicyTable = { "tool.exec": { kind: "allow" } }
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: policy })
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: Date.now(),
    })
    expect(r.kind).toBe("allow")
    if (r.kind === "allow") {
      expect(r.stsToken.token.length).toBeGreaterThan(0)
      expect(r.stsToken.scope).toBe(
        attestationScopeFor({
          agentId: "a",
          action: "tool.exec",
          resource: "/x",
          requestedAt: 0,
        }),
      )
    }
  })

  test("2. preflight deny → kind:'deny' + non-empty reason", async () => {
    const policy: PolicyTable = {
      "tool.exec": { kind: "deny", reason: "org-blocklist" },
    }
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: policy })
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: Date.now(),
    })
    expect(r.kind).toBe("deny")
    if (r.kind === "deny") {
      expect(r.reason.length).toBeGreaterThan(0)
      expect(r.reason).toBe("org-blocklist")
    }
  })

  test("3. preflight prompt-user → kind:'prompt-user', no token leak", async () => {
    const policy: PolicyTable = { "tool.exec": { kind: "prompt-user", reason: "confirm please" } }
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: policy })
    const r: AttestResult = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: Date.now(),
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

  test("4. allow preflight + verify valid → roundtrip true (no public mint bypass)", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: TEST_SECRET, clock: clock.now, policyTable: allowPolicy })
    const tok = await issueAllow(att, "scope/A", clock.now())
    expect(tok.scope).toBe(
      attestationScopeFor({
        agentId: "test-agent",
        action: "test.allow",
        resource: "scope/A",
        requestedAt: clock.now(),
      }),
    )
    expect(tok.expiresAt).toBe(clock.now() + 300_000)
    expect("mintToken" in att).toBe(false)
    const ok = await att.verify(tok.token, tok.scope)
    expect(ok).toBe(true)
  })

  test("5. verify expired → false (TTL elapsed via injected clock)", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: TEST_SECRET, clock: clock.now, policyTable: allowPolicy })
    const tok = await issueAllow(att, "scope/A", clock.now())
    clock.advance(300_001)
    const ok = await att.verify(tok.token, tok.scope)
    expect(ok).toBe(false)
  })

  test("6. verify tampered → false (flipped byte fails MAC)", async () => {
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: allowPolicy })
    const tok = await issueAllow(att)
    // Flip a character in the MAC segment (4th part). Keep length identical
    // so the constant-time compare actually runs.
    const parts = tok.token.split(".")
    const mac = parts[3] ?? ""
    if (mac.length === 0) throw new Error("token shape regression — MAC segment missing")
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1)
    const tampered = [parts[0], parts[1], parts[2], flipped].join(".")
    const ok = await att.verify(tampered, tok.scope)
    expect(ok).toBe(false)
  })

  test("7. revoke → subsequent verify returns false", async () => {
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: allowPolicy })
    const tok = await issueAllow(att)
    expect(await att.verify(tok.token, tok.scope)).toBe(true)
    await att.revoke(tok.token)
    expect(await att.verify(tok.token, tok.scope)).toBe(false)
    // Idempotent — second revoke does not throw.
    await att.revoke(tok.token)
  })

  test("8. canonical TTL token expires after its bounded lifetime", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: TEST_SECRET, clock: clock.now, policyTable: allowPolicy })
    const tok = await issueAllow(att, "scope/A", clock.now())
    clock.advance(300_001)
    expect(await att.verify(tok.token, tok.scope)).toBe(false)
  })

  test("9. scope mismatch → verify('tok', 'other-scope') false", async () => {
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: allowPolicy })
    const tok = await issueAllow(att)
    expect(await att.verify(tok.token, `${tok.scope}:other`)).toBe(false)
  })

  test("10. 9-event stream emitted in correct order across full lifecycle", async () => {
    const clock = makeClock()
    const events: AttestEvent[] = []
    const att = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: { "tool.exec": { kind: "allow" } },
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    // preflight (allow) → emits: preflight-requested, token-minted, preflight-granted, attest-audit
    const r = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: clock.now(),
    })
    expect(r.kind).toBe("allow")
    if (r.kind !== "allow") throw new Error("unreachable")
    // use → emits token-used
    await att.verify(r.stsToken.token, r.stsToken.scope)
    // revoke → emits token-revoked
    await att.revoke(r.stsToken.token)
    // expire path: a second policy-approved token, then clock advance → token-expired.
    const r2 = await att.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/expire",
      requestedAt: clock.now(),
    })
    if (r2.kind !== "allow") throw new Error("unreachable")
    clock.advance(300_001)
    await att.verify(r2.stsToken.token, r2.stsToken.scope)
    // deny path: emits preflight-denied (covers 8th distinct kind)
    const att2 = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: { "tool.exec": { kind: "deny", reason: "no" } },
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    await att2.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: clock.now(),
    })
    // error path: throwing policy reader surfaces preflight-error.
    // We synthesise a throwing Proxy as the policy table — production tables are plain objects.
    const att3 = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: new Proxy({} as PolicyTable, {
        get() {
          throw new Error("table-broken")
        },
      }),
      clock: clock.now,
      onEvent: (e) => events.push(e),
    })
    await att3.preflight({
      agentId: "a",
      action: "tool.exec",
      resource: "/x",
      requestedAt: clock.now(),
    })

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
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: { a: { kind: "allow" } } })
    const r = await att.preflight({
      agentId: "a",
      action: "a",
      resource: "/",
      requestedAt: Date.now(),
    })
    expect(r.kind).toBe("allow")
    if (r.kind === "allow") {
      expect(await att.verify(r.stsToken.token, r.stsToken.scope)).toBe(true)
    }
    // Headless stub barrel-load must also be side-effect-free.
    const stub = headlessStubAttestor()
    expect(
      (await stub.preflight({ agentId: "a", action: "a", resource: "/", requestedAt: Date.now() }))
        .kind,
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
    const allow = defaultAttestor({ secret: TEST_SECRET, policyTable: { a: { kind: "allow" } } })
    const deny = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: { a: { kind: "deny", reason: "r" } },
    })
    const prompt = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: { a: { kind: "prompt-user" } },
    })
    const r1 = await allow.preflight({
      agentId: "x",
      action: "a",
      resource: "/",
      requestedAt: Date.now(),
    })
    const r2 = await deny.preflight({
      agentId: "x",
      action: "a",
      resource: "/",
      requestedAt: Date.now(),
    })
    const r3 = await prompt.preflight({
      agentId: "x",
      action: "a",
      resource: "/",
      requestedAt: Date.now(),
    })
    expect(handle(r1).startsWith("allow:")).toBe(true)
    expect(handle(r2).startsWith("deny:")).toBe(true)
    expect(handle(r3).startsWith("prompt:")).toBe(true)
  })

  test("13. 1000 allow preflights at identical time issue distinct tokens", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: TEST_SECRET, clock: clock.now, policyTable: allowPolicy })
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const tok = await issueAllow(att, "scope/SAME", clock.now())
      tokens.add(tok.token)
    }
    expect(tokens.size).toBe(1000)
  })

  test("14. missing, blank, and weak secrets fail closed before token mint", () => {
    for (const secret of [undefined, "", "   ", "test-secret", "x".repeat(31)]) {
      try {
        defaultAttestor(secret === undefined ? {} : { secret })
        throw new Error("expected invalid secret to reject construction")
      } catch (error) {
        expect(error).toBeInstanceOf(AttestError)
        expect((error as AttestError).code).toBe("misconfigured")
      }
    }
    expect(() => defaultAttestor({ secret: TEST_SECRET })).not.toThrow()
  })

  test("15. preflight-error arm: throwing inner policy table surfaces as deny", async () => {
    const events: AttestEvent[] = []
    // Throwing Proxy as policy table — forces the NO-THROW deny arm.
    const att = defaultAttestor({
      secret: TEST_SECRET,
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
      requestedAt: Date.now(),
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

  test("16. stale and future requests deny before policy lookup or token mint", async () => {
    const clock = makeClock(1_000_000)
    const att = defaultAttestor({
      secret: TEST_SECRET,
      policyTable: allowPolicy,
      clock: clock.now,
      maxRequestAgeMs: 100,
      maxFutureSkewMs: 20,
    })
    for (const requestedAt of [clock.now() - 101, clock.now() + 21, Number.NaN]) {
      const result = await att.preflight({
        agentId: "test-agent",
        action: "test.allow",
        resource: "scope/A",
        requestedAt,
      })
      expect(result).toEqual({
        kind: "deny",
        reason: "preflight request timestamp outside allowed freshness window",
      })
    }
    expect((await issueAllow(att, "scope/A", clock.now())).scope).toContain("test-agent")
  })

  test("17. canonical scope binds agent/action/resource without delimiter collisions", async () => {
    const clock = makeClock()
    const att = defaultAttestor({ secret: TEST_SECRET, policyTable: allowPolicy, clock: clock.now })
    const token = await issueAllow(att, "a|b", clock.now())
    const expected = attestationScopeFor({
      agentId: "test-agent",
      action: "test.allow",
      resource: "a|b",
      requestedAt: clock.now(),
    })
    const otherAgent = attestationScopeFor({
      agentId: "test-agent|test",
      action: "allow",
      resource: "a|b",
      requestedAt: clock.now(),
    })
    expect(token.scope).toBe(expected)
    expect(otherAgent).not.toBe(expected)
    expect(await att.verify(token.token, otherAgent)).toBe(false)
  })
})
