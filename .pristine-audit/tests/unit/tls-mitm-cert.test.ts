/**
 * jun-7 TLS-MITM — cert-gen unit tests.
 *
 * Proves: (1) the hand-rolled X.509 cert-gen produces certs Node's own crypto
 * stack PARSES + VERIFIES (CA self-signs; leaf chains to CA); (2) determinism
 * under an injected key/serial/clock source (same inputs ⇒ byte-identical PEM);
 * (3) the leaf carries the host SAN so a TLS client's hostname check passes.
 */

import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, X509Certificate } from "node:crypto"
import {
  type KeyPair,
  type KeyPairSource,
  MitmCertAuthority,
  nodeKeyPairSource,
  type SerialSource,
} from "@/runtime/network-proxy/mitm-cert"

const FIXED_VALIDITY = { notBeforeMs: -86_400_000, notAfterMs: 86_400_000 }
const FIXED_NOW = (): number => 1_700_000_000_000

/** A SHARED fixed pool of pre-generated pairs (generated ONCE), so two separate
 *  authorities fed the same pool mint identical cert identities. */
const SHARED_PAIRS: KeyPair[] = [
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
]

/** A deterministic key source over the SHARED pool: yields the same pairs in a
 *  fixed order (CA first, then each leaf) so the cert identity is reproducible. */
const fixedKeySource = (): KeyPairSource => {
  let i = 0
  return () => SHARED_PAIRS[i++ % SHARED_PAIRS.length] as KeyPair
}

const counterSerial = (): SerialSource => {
  let n = 0
  return () => ++n
}

describe("MitmCertAuthority cert-gen", () => {
  test("CA cert is a valid, self-signed CA", () => {
    const ca = new MitmCertAuthority({
      keyPairSource: nodeKeyPairSource,
      serialSource: counterSerial(),
      now: FIXED_NOW,
      validity: FIXED_VALIDITY,
    })
    const x = new X509Certificate(ca.caCertPem())
    expect(x.ca).toBe(true)
    // Self-signed: verifies against its own public key.
    expect(x.verify(x.publicKey)).toBe(true)
    expect(x.subject).toContain("quanta-ephemeral-mitm-ca")
  })

  test("leaf cert chains to the CA and carries the host SAN", () => {
    const ca = new MitmCertAuthority({
      keyPairSource: nodeKeyPairSource,
      serialSource: counterSerial(),
      now: FIXED_NOW,
      validity: FIXED_VALIDITY,
    })
    const leaf = ca.leafFor("example.com")
    const leafX = new X509Certificate(leaf.certPem)
    const caX = new X509Certificate(ca.caCertPem())
    // checkIssued returns the issuer cert (truthy) when the chain holds.
    expect(leafX.checkIssued(caX)).toBeTruthy()
    expect(leafX.verify(caX.publicKey)).toBe(true)
    expect(leafX.ca).toBe(false)
    expect(leafX.subjectAltName).toContain("example.com")
    expect(leafX.checkHost("example.com")).toBe("example.com")
    // A DIFFERENT host must NOT match this leaf (no wildcard smuggling).
    expect(leafX.checkHost("evil.com")).toBeUndefined()
  })

  test("leaf is cached per host (same object on re-request)", () => {
    const ca = new MitmCertAuthority({
      keyPairSource: nodeKeyPairSource,
      serialSource: counterSerial(),
      now: FIXED_NOW,
      validity: FIXED_VALIDITY,
    })
    expect(ca.leafFor("a.com")).toBe(ca.leafFor("a.com"))
    expect(ca.leafFor("a.com")).not.toBe(ca.leafFor("b.com"))
  })

  test("determinism: injected key/serial/clock fully determine the cert IDENTITY", () => {
    // NOTE: ECDSA signatures embed a random `k` (not RFC-6979 in node:crypto), so
    // the SIGNATURE bytes differ run-to-run even with a fixed key — that is the
    // ONLY non-determinism, and it lives inside node:crypto, not our encoder. We
    // assert the INJECTION-CONTROLLED identity (serial, subject, public key,
    // validity, SAN) is byte-stable, proving cert-gen is deterministic in every
    // field the DI seam owns.
    const build = (): MitmCertAuthority =>
      new MitmCertAuthority({
        keyPairSource: fixedKeySource(),
        serialSource: counterSerial(),
        now: FIXED_NOW,
        validity: FIXED_VALIDITY,
      })
    const a = new X509Certificate(build().leafFor("host.test").certPem)
    const b = new X509Certificate(build().leafFor("host.test").certPem)
    expect(a.serialNumber).toBe(b.serialNumber)
    expect(a.subject).toBe(b.subject)
    expect(a.subjectAltName).toBe(b.subjectAltName)
    expect(a.validFrom).toBe(b.validFrom)
    expect(a.validTo).toBe(b.validTo)
    expect(a.publicKey.export({ type: "spki", format: "pem" })).toEqual(
      b.publicKey.export({ type: "spki", format: "pem" }),
    )
  })

  test("validity window honors the injected clock", () => {
    const ca = new MitmCertAuthority({
      keyPairSource: nodeKeyPairSource,
      serialSource: counterSerial(),
      now: FIXED_NOW,
      validity: { notBeforeMs: -1000, notAfterMs: 2000 },
    })
    const x = new X509Certificate(ca.caCertPem())
    expect(new Date(x.validFrom).getTime()).toBe(FIXED_NOW() - 1000)
    expect(new Date(x.validTo).getTime()).toBe(FIXED_NOW() + 2000)
  })
})
