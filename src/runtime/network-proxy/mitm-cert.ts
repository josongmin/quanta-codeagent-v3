/**
 * jun-7 TLS-MITM (Phase-2 of jun-6-exfil-egress-rails (B)) — EPHEMERAL X.509
 * certificate authority + per-host leaf minting, PURE node:crypto (NO new dep).
 *
 * WHAT: mints a self-signed ECDSA-P256 CA and, on demand, a leaf cert for a
 *       given host SIGNED by that CA, so the loopback proxy can TERMINATE TLS for
 *       an allowed `CONNECT host:443` and run the EXISTING secret-egress scan on
 *       the decrypted body/headers. Node's TLS stack cannot GENERATE certs
 *       (`node:crypto` only PARSES X.509), so this module hand-encodes the
 *       minimal X.509 v3 DER (TBSCertificate) and signs it with `crypto.sign`
 *       (ECDSA-with-SHA256). The spike proved Node's own TLS server/client accept
 *       the result in a real handshake; no `node-forge` / `selfsigned` dep.
 *
 * ⚠️ SECURITY — BLAST RADIUS (the make-or-break section, see RFC threat model):
 *   - The CA is EPHEMERAL: minted in-memory per {@link MitmCertAuthority}
 *     instance (one per proxy session), NEVER written to the OS trust store,
 *     NEVER persisted. Its private key lives only in this process's heap and dies
 *     with the proxy.
 *   - It is trusted by EXACTLY ONE consumer: quanta's OWN outbound TLS client for
 *     a MITM'd connection (the proxy passes `caCertPem()` as the `ca:` option of
 *     the upstream-facing termination — i.e. the leaf it presents to the agent's
 *     fetch is validated against THIS ca only, scoped to that one socket). It is
 *     NOT added to `NODE_EXTRA_CA_CERTS`, NOT to the system store, NOT to any
 *     other process.
 *   - The UPSTREAM connection (proxy → real server) still validates the REAL
 *     server cert with the default trust store — the MITM inserts a scan point,
 *     it does NOT weaken upstream verification. (That validation lives in the
 *     proxy, not here.)
 *
 * CLOSED-PORT / DETERMINISM: all non-determinism is INJECTED.
 *   - `keyPairSource`  — supplies ECDSA key material (prod: node:crypto; tests
 *     inject a fixed pair so cert bytes are reproducible).
 *   - `serialSource`   — supplies the cert serial (prod: random; tests inject a
 *     counter so two mints differ deterministically).
 *   - `now`            — the clock for notBefore/notAfter.
 * No `Date.now` / `Math.random` / `process.env` in this module.
 *
 * NO-THROW is NOT claimed here: minting is a pure CPU op that can only fail on a
 * genuinely broken crypto runtime; the CALLER (loopback-proxy) wraps a mint in a
 * try/catch and FAILS CLOSED (deny / opaque-tunnel fallback) on any error.
 */

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto"

// --- minimal DER encoders (just enough for an X.509 v3 leaf/CA) ---

/** DER length octets (short form < 128, else long form). */
const derLen = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let x = n
  while (x > 0) {
    bytes.unshift(x & 0xff)
    x >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** Tag-length-value. */
const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLen(content.length), content])

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const derSet = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
/** Context-specific constructed `[n]`. */
const ctx = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content)

/** Encode a dotted OID string to a DER OBJECT IDENTIFIER. */
const oid = (str: string): Buffer => {
  const p = str.split(".").map(Number)
  const first = (p[0] ?? 0) * 40 + (p[1] ?? 0)
  const body: number[] = [first]
  for (let i = 2; i < p.length; i++) {
    let v = p[i] ?? 0
    const stack: number[] = [v & 0x7f]
    v >>>= 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>>= 7
    }
    body.push(...stack)
  }
  return tlv(0x06, Buffer.from(body))
}

/** DER INTEGER from a big-endian magnitude buffer (positive, minimal). */
const intFromBytes = (buf: Buffer): Buffer => {
  let b = buf.length === 0 ? Buffer.from([0]) : Buffer.from(buf)
  // Trim leading zeros down to one.
  let start = 0
  while (start < b.length - 1 && b[start] === 0) start++
  b = b.subarray(start)
  // Prepend a 0 if the high bit is set (keep it positive).
  if (((b[0] ?? 0) & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

const intSmall = (n: number): Buffer => {
  const hex = n.toString(16)
  return intFromBytes(Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex"))
}

const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"))
const bitStr = (buf: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
const boolDer = (b: boolean): Buffer => tlv(0x01, Buffer.from([b ? 0xff : 0x00]))
const octet = (buf: Buffer): Buffer => tlv(0x04, buf)

/** GeneralizedTime `YYYYMMDDHHMMSSZ` (UTC). */
const genTime = (d: Date): Buffer => {
  const z = (n: number, l = 2): string => String(n).padStart(l, "0")
  const s = `${z(d.getUTCFullYear(), 4)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(
    d.getUTCHours(),
  )}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`
  return tlv(0x18, Buffer.from(s, "ascii"))
}

const OID_CN = "2.5.4.3"
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
const OID_SAN = "2.5.29.17"
const OID_BASIC_CONSTRAINTS = "2.5.29.19"
const OID_EKU = "2.5.29.37"
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

/** RDNSequence with a single CN. */
const distinguishedName = (cn: string): Buffer => seq(derSet(seq(oid(OID_CN), utf8(cn))))
/** AlgorithmIdentifier for ecdsa-with-SHA256 (no params). */
const sigAlgId = (): Buffer => seq(oid(OID_ECDSA_SHA256))

/** subjectAltName: a sequence of dNSName `[2]` (and IP `[7]` for literals). */
const sanExtension = (sans: readonly string[]): Buffer => {
  const items = sans.map((h) => tlv(0x82, Buffer.from(h, "ascii")))
  return seq(oid(OID_SAN), octet(seq(...items)))
}
/** basicConstraints (critical), cA flag. */
const basicConstraintsExtension = (isCa: boolean): Buffer =>
  seq(oid(OID_BASIC_CONSTRAINTS), boolDer(true), octet(seq(boolDer(isCa))))
/** extendedKeyUsage: serverAuth (leaf only). */
const ekuExtension = (): Buffer => seq(oid(OID_EKU), octet(seq(oid(OID_SERVER_AUTH))))

const toPem = (der: Buffer, label: string): string =>
  `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join(
    "\n",
  )}\n-----END ${label}-----\n`

interface MintCertInput {
  readonly subjectCN: string
  readonly issuerCN: string
  readonly subjectPubKey: KeyObject
  readonly issuerPrivKey: KeyObject
  readonly isCa: boolean
  readonly sans: readonly string[]
  readonly serial: number
  readonly notBefore: Date
  readonly notAfter: Date
}

/** Hand-encode + sign one X.509 v3 cert, returning the PEM. */
const mintCertPem = (input: MintCertInput): string => {
  const spki = input.subjectPubKey.export({ type: "spki", format: "der" }) as Buffer
  const exts: Buffer[] = [basicConstraintsExtension(input.isCa)]
  if (input.sans.length > 0) exts.push(sanExtension(input.sans))
  if (!input.isCa) exts.push(ekuExtension())
  const tbs = seq(
    ctx(0, intSmall(2)), // version v3 (value 2)
    intSmall(input.serial),
    sigAlgId(),
    distinguishedName(input.issuerCN),
    seq(genTime(input.notBefore), genTime(input.notAfter)),
    distinguishedName(input.subjectCN),
    spki,
    ctx(3, seq(...exts)), // extensions [3]
  )
  // ECDSA `crypto.sign` returns a DER-encoded ECDSA-Sig-Value (what X.509 wants).
  const sigDer = sign("sha256", tbs, input.issuerPrivKey)
  const cert = seq(tbs, sigAlgId(), bitStr(sigDer))
  return toPem(cert, "CERTIFICATE")
}

/** An ECDSA key pair (DI seam). */
export interface KeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

/** Injected key-material source. Prod: node:crypto P-256. Tests inject a fixed
 *  pair so cert bytes are reproducible. */
export type KeyPairSource = () => KeyPair

/** Production key source — a fresh ECDSA P-256 pair each call. */
export const nodeKeyPairSource: KeyPairSource = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })

/** Injected serial source. Prod: a random-ish monotonically-unique value; tests
 *  inject a counter. MUST yield a positive integer < 2^31 (fits `intSmall`). */
export type SerialSource = () => number

/** A minted leaf: the cert chain (leaf only — the client trusts the CA) + its
 *  private key, both PEM, ready for `tls.createSecureContext`. */
export interface LeafCert {
  readonly certPem: string
  readonly keyPem: string
}

/** Per-instance validity window (years before/after `now`). Injected — no magic
 *  default baked into the minting code. */
export interface MitmCertValidity {
  readonly notBeforeMs: number
  readonly notAfterMs: number
}

/**
 * The closed-port the proxy depends on: an ephemeral CA that mints per-host leaf
 * certs. One instance per proxy session.
 */
export interface CertAuthority {
  /** PEM of the CA cert — the ONLY thing the agent's MITM'd client trusts. */
  caCertPem(): string
  /** Mint (or return a cached) leaf cert for `host`, signed by the CA. */
  leafFor(host: string): LeafCert
}

/**
 * The ephemeral in-memory MITM CA. Generates a self-signed CA at construction
 * and lazily mints + caches per-host leaves. All randomness/clock injected.
 */
export class MitmCertAuthority implements CertAuthority {
  private readonly caKey: KeyPair
  private readonly caPem: string
  private readonly leaves = new Map<string, LeafCert>()

  constructor(
    private readonly deps: {
      readonly keyPairSource: KeyPairSource
      readonly serialSource: SerialSource
      readonly now: () => number
      readonly validity: MitmCertValidity
    },
  ) {
    this.caKey = deps.keyPairSource()
    const base = deps.now()
    this.caPem = mintCertPem({
      subjectCN: "quanta-ephemeral-mitm-ca",
      issuerCN: "quanta-ephemeral-mitm-ca",
      subjectPubKey: this.caKey.publicKey,
      issuerPrivKey: this.caKey.privateKey,
      isCa: true,
      sans: [],
      serial: deps.serialSource(),
      notBefore: new Date(base + deps.validity.notBeforeMs),
      notAfter: new Date(base + deps.validity.notAfterMs),
    })
  }

  caCertPem(): string {
    return this.caPem
  }

  leafFor(host: string): LeafCert {
    const cached = this.leaves.get(host)
    if (cached !== undefined) return cached
    const leafKey = this.deps.keyPairSource()
    const base = this.deps.now()
    const certPem = mintCertPem({
      subjectCN: host,
      issuerCN: "quanta-ephemeral-mitm-ca",
      subjectPubKey: leafKey.publicKey,
      issuerPrivKey: this.caKey.privateKey,
      isCa: false,
      sans: [host],
      serial: this.deps.serialSource(),
      notBefore: new Date(base + this.deps.validity.notBeforeMs),
      notAfter: new Date(base + this.deps.validity.notAfterMs),
    })
    const keyPem = leafKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string
    const leaf: LeafCert = { certPem, keyPem }
    this.leaves.set(host, leaf)
    return leaf
  }
}
