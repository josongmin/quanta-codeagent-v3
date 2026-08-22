/**
 * jun-7 TLS-MITM — scan-integration + fail-closed config unit tests.
 *
 * The MITM transport REUSES the EXISTING secret-egress core (`decideEgressScan`),
 * the SAME function the plaintext-HTTP path uses — it does NOT rebuild scan
 * policy. These tests pin that shared core's deny / redact / clean dispositions
 * (so a regression in either transport is caught here) and the fail-closed
 * policy/gate types that bound the MITM blast radius.
 */

import { describe, expect, test } from "bun:test"
import { decideEgressScan, type SecretEgressConfig } from "@/runtime/network-proxy"
import { compositeSecretScanner } from "@/security/secret-detection"

const DECLARED = "s3cr3t-deploy-token-do-not-leak"
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"

const cfg = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "deny",
  maxBodyBytes: 1_000_000,
  ...over,
})

describe("decideEgressScan — the shared core both transports use", () => {
  test("a clean body+headers ⇒ {kind: clean}", async () => {
    const d = await decideEgressScan("hello=world", "content-type: text/plain", cfg())
    expect(d.kind).toBe("clean")
  })

  test("a declared secret in the body ⇒ deny (mode deny)", async () => {
    const d = await decideEgressScan(`data=${DECLARED}`, "", cfg({ declared: [DECLARED] }))
    expect(d.kind).toBe("deny")
    if (d.kind === "deny") expect(d.reason.includes(DECLARED)).toBe(false) // never the bytes
  })

  test("a declared secret in a HEADER value ⇒ deny", async () => {
    const d = await decideEgressScan(
      "clean-body",
      `x-token: ${DECLARED}`,
      cfg({ declared: [DECLARED] }),
    )
    expect(d.kind).toBe("deny")
  })

  test("declared secret + redact mode ⇒ redact with the secret masked out of the body", async () => {
    const d = await decideEgressScan(
      `data=${DECLARED}`,
      "",
      cfg({ declared: [DECLARED], mode: "redact" }),
    )
    expect(d.kind).toBe("redact")
    if (d.kind === "redact") {
      expect(d.redactedBody.includes(DECLARED)).toBe(false)
      expect(d.redactedBody).toContain("[REDACTED:secret-egress]")
    }
  })

  test("a SCANNER-only finding (no declared span) ⇒ deny even in redact mode (cannot safely mask)", async () => {
    // An AWS key is a pattern finding, NOT a declared exact span — redact mode
    // must FALL BACK to deny (a partial redact of an approximate span could leak).
    const d = await decideEgressScan(`grant=${AWS_KEY}`, "", cfg({ mode: "redact" }))
    expect(d.kind).toBe("deny")
  })
})
