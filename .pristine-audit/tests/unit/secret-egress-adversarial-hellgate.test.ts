/**
 * ADVERSARIAL HELLGATE — secret-egress rail (jun-6 exfil-rail B), DEEPER LAYER.
 *
 * This file ADDS territory the existing `secret-egress-hellgate.test.ts` does
 * NOT cover. It does not duplicate the declared-hit / redact-mask / deny-reason
 * proofs there; it targets the SECURITY INVARIANT under adversarial encodings
 * and the mode-vs-redactability decision boundary.
 *
 * THE INVARIANT: a declared secret cannot silently leave over plaintext-HTTP.
 *
 * KNOWN, LOAD-BEARING LIMITATION pinned here (honest, not a "pass"):
 *   The declared exact-match path is a VERBATIM substring scan (indexOf). Any
 *   transform of the secret (base64, split across a whitespace/chunk boundary,
 *   Cyrillic homoglyph) is NOT a declared hit. When the composite scanner is the
 *   only remaining signal, a LOW-entropy transformed secret slips. These tests
 *   PIN that boundary so (a) nobody believes the declared path is
 *   encoding-robust, and (b) if someone weakens the entropy scanner, the base64
 *   case flips and this file goes RED — surfacing the silent-exfil regression.
 */

import { describe, expect, test } from "bun:test"
import {
  decideEgressScan,
  EGRESS_REDACTION_MASK,
  redactDeclared,
  type SecretEgressConfig,
  scanEgressText,
} from "@/runtime/network-proxy"
import type { SecretFinding, SecretScanner } from "@/security/secret-detection"
import { compositeSecretScanner } from "@/security/secret-detection"

const DECLARED = "s3cr3t-deploy-token-do-not-leak"
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"

const cfg = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "deny",
  maxBodyBytes: 1_000_000,
  declared: [DECLARED],
  ...over,
})

/** A scanner that NEVER fires — isolates the DECLARED path so we measure it
 *  alone (the zero-FP exact-match signal), without the entropy backstop. */
const nullScanner: SecretScanner = {
  scanText: async (): Promise<SecretFinding[]> => [],
  scanFile: async (): Promise<SecretFinding[]> => [],
}

describe("secret-egress adversarial — declared path is VERBATIM-ONLY (pinned limitation)", () => {
  // Baseline: verbatim IS caught by the declared path with the scanner off — so
  // the negatives below are genuinely the ENCODING evading, not a dead fixture.
  test("verbatim declared secret IS a declared hit even with the scanner disabled", async () => {
    const v = await scanEgressText(`before ${DECLARED} after`, cfg({ scanner: nullScanner }))
    expect(v.hit).toBe(true)
    expect(v.declared.length).toBe(1)
  })

  test("base64(secret) is NOT a declared hit (only entropy could catch it)", async () => {
    const b64 = Buffer.from(DECLARED).toString("base64")
    const v = await scanEgressText(`payload=${b64}`, cfg({ scanner: nullScanner }))
    expect(v.declared.length).toBe(0)
    expect(v.hit).toBe(false)
  })

  test("secret split across a whitespace/chunk boundary is NOT a declared hit", async () => {
    // Drip-exfil via fragmentation: the two halves never form the verbatim span.
    const [a, b] = ["s3cr3t-deploy-token", "-do-not-leak"]
    const v = await scanEgressText(`${a}\n${b}`, cfg({ scanner: nullScanner }))
    expect(v.declared.length).toBe(0)
    expect(v.hit).toBe(false)
  })

  test("Cyrillic-homoglyph secret is NOT a declared hit (visual-equal, byte-different)", async () => {
    const homo = DECLARED.replace(/o/g, "о") // Cyrillic small o
    expect(homo).not.toBe(DECLARED)
    const v = await scanEgressText(homo, cfg({ scanner: nullScanner }))
    expect(v.declared.length).toBe(0)
    expect(v.hit).toBe(false)
  })

  test("case-shifted secret is NOT a declared hit (declared match is case-sensitive)", async () => {
    const v = await scanEgressText(DECLARED.toUpperCase(), cfg({ scanner: nullScanner }))
    expect(v.declared.length).toBe(0)
    expect(v.hit).toBe(false)
  })
})

describe("secret-egress adversarial — entropy is the SOLE backstop for base64 (silent-exfil sentinel)", () => {
  test("with the REAL composite scanner, base64(secret) IS caught — by entropy, not declared", async () => {
    const b64 = Buffer.from(DECLARED).toString("base64")
    const v = await scanEgressText(`payload=${b64}`, cfg())
    // If this flips to false (e.g. entropy scanner weakened / disabled), a
    // base64-obfuscated secret would EGRESS SILENTLY. Sentinel.
    expect(v.hit).toBe(true)
    // Prove the catch is the entropy signal, not the declared path.
    expect(v.declared.length).toBe(0)
    expect(v.findings.some((f) => f.kind === "generic-high-entropy")).toBe(true)
  })
})

describe("secret-egress adversarial — split-across-scan-units (header vs body isolation)", () => {
  // decideEgressScan scans body and header text as SEPARATE blobs. A secret can
  // never be reassembled across the body/header split — but a declared secret in
  // EITHER independently must still fire. Pins that a header-only secret denies.
  test("declared secret in a HEADER value alone (empty body) still denies", async () => {
    const d = await decideEgressScan("", `authorization: Bearer ${DECLARED}`, cfg())
    expect(d.kind).toBe("deny")
  })

  test("half in body + half in header is NOT reassembled (each blob scanned alone)", async () => {
    const d = await decideEgressScan(
      "s3cr3t-deploy-token",
      `x-note: -do-not-leak`,
      cfg({ scanner: nullScanner }),
    )
    expect(d.kind).toBe("clean")
  })

  test("declared secret split within the SAME body across a raw \\r\\n chunk boundary is not caught", async () => {
    const d = await decideEgressScan(
      "s3cr3t-deploy-token\r\n-do-not-leak",
      "",
      cfg({ scanner: nullScanner }),
    )
    expect(d.kind).toBe("clean")
  })
})

describe("secret-egress adversarial — MODE (deny vs redact) correctness at the disposition boundary", () => {
  test("redact mode with ONLY a declared hit → redact + masked body + no secret bytes", async () => {
    const d = await decideEgressScan(
      `send ${DECLARED} now`,
      "",
      cfg({ mode: "redact", scanner: nullScanner }),
    )
    expect(d.kind).toBe("redact")
    if (d.kind !== "redact") throw new Error("unreachable")
    expect(d.redactedBody).toBe(`send ${EGRESS_REDACTION_MASK} now`)
    expect(d.redactedBody.includes(DECLARED)).toBe(false)
    expect(d.reason.includes(DECLARED)).toBe(false)
  })

  test("redact mode FALLS BACK to deny when a scanner-only finding fires (approximate span)", async () => {
    // A pattern/entropy finding has no exact byte span → an in-place redact could
    // leak. Fail closed to deny. This is the load-bearing safety fallback.
    const d = await decideEgressScan(`grant=${AWS_KEY}`, "", cfg({ mode: "redact" }))
    expect(d.kind).toBe("deny")
    if (d.kind !== "deny") throw new Error("unreachable")
    expect(d.reason.includes(AWS_KEY)).toBe(false)
  })

  test("redact mode with declared AND scanner findings mixed → deny (not partial redact)", async () => {
    // Mixed: the presence of ANY scanner finding taints redactability of the
    // whole disposition → deny beats a partial redact that leaves the AWS key.
    const d = await decideEgressScan(`a=${DECLARED} b=${AWS_KEY}`, "", cfg({ mode: "redact" }))
    expect(d.kind).toBe("deny")
  })

  test("deny mode denies even a purely-declared (fully-redactable) hit", async () => {
    const d = await decideEgressScan(
      `x ${DECLARED}`,
      "",
      cfg({ mode: "deny", scanner: nullScanner }),
    )
    expect(d.kind).toBe("deny")
  })
})

describe("secret-egress adversarial — redactDeclared cannot leak a repeated or overlapping secret", () => {
  test("every occurrence masked, including adjacent repeats (no surviving copy)", () => {
    const text = `${DECLARED}${DECLARED} tail ${DECLARED}`
    const out = redactDeclared(text, [{ value: DECLARED, index: 0 }])
    expect(out.includes(DECLARED)).toBe(false)
    expect(out).toBe(
      `${EGRESS_REDACTION_MASK}${EGRESS_REDACTION_MASK} tail ${EGRESS_REDACTION_MASK}`,
    )
  })

  test("redaction of one declared value does not resurrect a second declared value", () => {
    // Two distinct declared secrets; masking the first must not create a spelling
    // of the second, and both must be gone after a full decideEgressScan redact.
    const D2 = "another-declared-xyzzy-42"
    const text = `${DECLARED}-${D2}`
    const out = redactDeclared(text, [
      { value: DECLARED, index: 0 },
      { value: D2, index: DECLARED.length + 1 },
    ])
    expect(out.includes(DECLARED)).toBe(false)
    expect(out.includes(D2)).toBe(false)
  })
})

describe("secret-egress adversarial — empty/whitespace declared entries cannot poison the scan", () => {
  test("an empty-string declared entry never produces a hit (would match everywhere)", async () => {
    const v = await scanEgressText("any body at all", cfg({ scanner: nullScanner, declared: [""] }))
    expect(v.hit).toBe(false)
    expect(v.declared.length).toBe(0)
  })

  test("duplicate declared entries produce exactly one hit (deduped)", async () => {
    const v = await scanEgressText(
      `x ${DECLARED} y`,
      cfg({ scanner: nullScanner, declared: [DECLARED, DECLARED, DECLARED] }),
    )
    expect(v.declared.length).toBe(1)
  })
})
