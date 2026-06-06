# RFC — TLS-MITM egress: HTTPS body/header secret scanning

> **Status: ✅ IMPLEMENTED (jun-07)** — full in-process TLS-MITM (ephemeral CA,
> per-host leaf mint, decrypt → reuse the existing secret-egress scan → re-encrypt
> upstream) with **no new dependency** (pure `node:crypto` cert-gen). Default-OFF +
> operator-explicit-opt-in. **Runtime caveat (honest):** the server-side TLS
> termination on a `CONNECT`-upgraded socket works on **node:tls**; **Bun 1.3.x**
> cannot yet drive it (it stalls the handshake) — the **fail-closed watchdog turns
> that stall into a hard DENY** so a secret can NEVER leak through a stuck handshake,
> and the positive (secret-caught + forward) proof runs under Node. See §8.
> Phase-2 follow-up to `jun-6-exfil-egress-rails.md` (B).
> Date: 2026-06-07

## 1. Problem — the CONNECT-opaque gap

The shipped secret-aware egress rail (`jun-6-exfil-egress-rails.md` §4.4 (B), ✅
jun-06) scans the outbound BODY + HEADER values for a leaving secret — but ONLY
on the **plaintext-HTTP** egress path. The proxy's HTTPS path is
`CONNECT host:443` → a **raw TLS tunnel** whose bytes the proxy cannot read, so
an HTTPS request body is **NOT content-scanned**. It is recorded with a visible
`connect-tunnel-unscanned` decision-log marker so the gap is explicit — never a
silent claim of coverage — but it is a real hole: most modern webhook / file-share
/ paste / LLM-API exfil sinks are HTTPS, and the agent's own `web_fetch` / MCP-over-
HTTPS request bodies are invisible behind the tunnel.

Closing it requires terminating TLS at the proxy: present a locally-trusted leaf,
decrypt, run the EXISTING scan, then re-originate the connection upstream.

## 2. The MITM architecture

On an **allowed** `CONNECT host:443`, with MITM configured (operator-opt-in only):

```
agent client ──CONNECT host:443──▶ proxy
                                   │  200 Connection Established
   ClientHello (trusts MITM CA) ──▶│  TERMINATE TLS: present a LEAF for `host`
                                   │  minted by the EPHEMERAL per-session CA
   decrypted HTTP request ────────▶│  parse req (method/path/headers/body)
                                   │  ─── decideEgressScan() ───  ← the SAME core
                                   │      the plaintext-HTTP path uses (reused)
                                   │  deny? → 403 over the terminated TLS (closed)
                                   │  redact? → mask declared spans
                                   │  clean? → forward
                                   │
                                   │  OWN upstream TLS to the REAL host:443
                                   │  rejectUnauthorized:true (default trust store)
   re-encrypted response ◀─────────│◀── real server (cert VALIDATED normally)
```

Key properties:

- **Reuse, not rebuild.** The decrypted request is fed to `decideEgressScan(body,
  headerText, cfg)` — the exact deny/redact/clean policy the plaintext path uses.
  The MITM is a new TRANSPORT around the unchanged scan core (hoisted from a
  private proxy method into `secret-egress.ts` so both transports share one
  definition).
- **The marker changes.** A MITM'd CONNECT no longer logs `connect-tunnel-
  unscanned`; it logs `denied` / `redacted` / `scanned-clean` (or `body-cap-
  unscanned` past the byte cap) — the body WAS scanned.

## 3. CA blast-radius threat model + containment (the make-or-break section)

The MITM CA is a powerful trust anchor: a bug in the MITM = the agent trusts a
**forged** leaf. Containment:

1. **Ephemeral.** The CA is minted **in-memory per proxy session**
   (`MitmCertAuthority`, one instance per proxy). Its private key lives only in
   this process's heap and dies with the proxy. It is **never written to the OS
   trust store, never persisted** (the operator gets no persistence path in this
   slice — the strongest default).
2. **Scoped to exactly one consumer.** The CA is trusted ONLY by quanta's OWN
   outbound client for a MITM'd connection — the agent's client is configured to
   trust `certAuthority.caCertPem()` for that socket so it accepts the leaf. It is
   **NOT** added to `NODE_EXTRA_CA_CERTS`, **NOT** the system store, **NOT** any
   other process. (The e2e mirrors this exactly: the test client passes
   `ca: [mitmCa.caCertPem()]` to its `tls.connect`, scoped to that one socket.)
3. **Upstream verification is NOT weakened.** The proxy → real-server leg uses
   `rejectUnauthorized: true` against the **default** trust store with SNI — the
   MITM inserts a scan point, it does not lower upstream verification. A forged /
   mismatched upstream cert ⇒ the upstream errors ⇒ the client gets a 502; the
   proxy NEVER blindly accepts a server it could not authenticate. The test-only
   `upstreamTlsExtra` DI seam supplies an EXTRA trust root for a hermetic origin
   and is spread BEFORE the security-critical fields so `rejectUnauthorized` can
   never be flipped off by it.
4. **Threat statement.** If the MITM had a bug (e.g. it trusted its own CA for
   the upstream leg), the agent could be fed a forged response. The containment
   above + the "bad upstream cert ⇒ 502" e2e is the guard against that class.

## 4. Default-OFF + OPERATOR-EXPLICIT-OPT-IN (a stronger gate)

MITM-ing your own traffic is a deliberate security tradeoff, so the gate is
**stronger** than the other egress knobs — a single `=1` is NOT enough:

```
QUANTA_TLS_MITM=1   AND   QUANTA_TLS_MITM_ACK=i-understand-mitm-mints-a-trust-anchor
```

The ack phrase is fixed and self-documenting; the operator must type it verbatim,
so MITM cannot be enabled by a stray `=1` copied from another knob or a templated
CI matrix. Either signal missing / any other value ⇒ OFF ⇒ the `CONNECT` path
stays a raw tunnel + `connect-tunnel-unscanned` marker (**byte-identical** to the
pre-slice path). Resolved purely from injected env in `mitm-gate.ts`
(`tlsMitmAuthorized`), surfaced on `RuntimeConfig.tlsMitm`.

`QUANTA_TLS_MITM_ON_FAILURE` (= `deny` | `opaque-tunnel`) picks the fail-closed
policy (§6); anything else ⇒ `deny` (fail closed by default).

## 5. Closed-port design

All non-determinism is injected; nothing reads `Date.now` / `Math.random` /
`process.env` outside `runtime-config.ts`:

- **`MitmCertAuthority`** (`mitm-cert.ts`) — the cert generator, injected with
  `keyPairSource` (prod: `node:crypto` ECDSA-P256), `serialSource`, `now`, and a
  `validity` window. Pure hand-rolled X.509 v3 DER + `crypto.sign` (ECDSA-SHA256)
  — **no `node-forge` / `selfsigned` dep** (see §7). Caches one leaf per host.
- **`MitmConfig`** (`mitm.ts`) — carries the `certAuthority`, the SAME
  `SecretEgressConfig` the plaintext path uses (reused scanner), `onFailure`, and
  `handshakeTimeoutMs` (the fail-closed watchdog budget — required knob, no magic
  default).
- The scanner is the EXISTING injected one (`compositeSecretScanner`); the proxy
  is the I/O shell. NO-THROW: a mint / handshake / scan error fails closed.

## 6. Fail-closed (never silently pass unscanned)

- **Handshake / mint / context / parse error** ⇒ `mitmFailClosed`:
  `deny` (recommended) = a hard 403/close; `opaque-tunnel` = fall back to the raw
  tunnel + a VISIBLE `connect-tunnel-unscanned` marker (availability for cert-
  pinned hosts, at the cost of not scanning that one connection — but the gap
  stays visible, never silent).
- **Watchdog.** If the decrypted request does not parse within
  `handshakeTimeoutMs`, the proxy DENIES rather than hanging — this is what turns
  the Bun runtime stall (§8) into a hard deny instead of a hung socket. A stuck
  MITM therefore NEVER lets unscanned bytes leave.
- **Scan deny** ⇒ 403 over the terminated TLS; the request never reaches the
  origin. The deny is recorded `denied` regardless of whether a clean 403 could be
  written over a half-open TLS socket (the invariant that matters: nothing leaves
  + the log says `denied`).

## 7. Was a new dep needed? NO.

`node:crypto` PARSES X.509 (`X509Certificate`) but cannot GENERATE certs. Rather
than add `node-forge` / `selfsigned`, the slice hand-encodes the minimal X.509 v3
DER (TBSCertificate: version / serial / sigAlg / issuer / validity / subject /
SPKI / basicConstraints + SAN + EKU) and signs it with `crypto.sign("sha256",
tbs, ecPrivKey)` (which returns the DER ECDSA-Sig-Value X.509 wants). A spike
confirmed Node's own TLS server + client accept the result in a real handshake,
and the unit tests confirm `X509Certificate` parses / verifies / chains it. ~190
lines, zero deps — justified over a dep because it is small, auditable, and keeps
the trust-anchor minting fully in-tree.

(Determinism note: ECDSA signatures embed a random `k` in `node:crypto` (not
RFC-6979), so the SIGNATURE bytes differ run-to-run; that is the only non-
determinism and it lives inside node:crypto. Every INJECTION-CONTROLLED field —
serial, subject, SAN, validity, public key — is byte-stable, which the unit test
pins.)

## 8. Runtime support (honest)

A full TLS-MITM needs the runtime to drive a **server-side** TLS handshake on a
socket obtained from an HTTP `connect` event (a socket upgrade):

- **node:tls** — works. The full positive flow (secret in an HTTPS body → caught
  + denied; legit body → forwarded; redact masks the body; bad upstream cert →
  502) is proven under Node.
- **Bun 1.3.x** — does NOT yet drive it: the ClientHello does not reach the
  wrapped server-side `TLSSocket`, so the handshake stalls. **This is a runtime
  limitation, not a missing dep and not a design flaw** — the same code is correct
  under Node. The **fail-closed watchdog** (§6) converts the stall into a hard
  DENY, so on Bun the rail is *safe but not yet functional* (it denies MITM'd
  HTTPS rather than scanning it). Production runs on Bun today, so the practical
  posture is: **enable MITM only on a node:tls runtime** until Bun supports the
  upgrade; on Bun it fails closed.

## 9. Test plan

- **Unit** (`tests/unit/tls-mitm-cert.test.ts`): cert-gen — CA self-signs, leaf
  chains to CA + carries the host SAN + rejects a different host, per-host cache,
  injection-controlled determinism, validity honors the injected clock.
- **Unit** (`tests/unit/tls-mitm-gate.test.ts`): the operator-opt-in gate — ON
  only with both `=1` AND the verbatim ack; OFF for switch-alone / ack-alone /
  typo'd ack / truthy-not-`1` / empty.
- **Unit** (`tests/unit/tls-mitm-scan-integration.test.ts`): the SHARED
  `decideEgressScan` core — clean / deny (body + header) / redact / scanner-only-
  falls-back-to-deny — proving the MITM transport reuses the plaintext policy.
- **Integration REAL-TLS** (`tests/integration/tls-mitm-egress-e2e.test.ts`):
  a local HTTPS origin + the MITM proxy + a client trusting the MITM CA →
  - `[node]` declared secret in an HTTPS body → 403, never reaches the origin,
    logged `denied` (THE GAP CLOSED);
  - `[node]` legit body → 200, forwarded unchanged, `scanned-clean` (no FP);
  - `[node]` redact mode → the origin sees the MASK;
  - `[node]` bad upstream cert → 502 (upstream STILL validated);
  - `[all runtimes]` a stuck/unsupported handshake → DENY (watchdog), secret
    never reaches origin;
  - `[all runtimes]` MITM OFF → CONNECT stays a raw tunnel + `connect-tunnel-
    unscanned` (default-OFF byte-identity).

## 10. ROI

- **Closes the single biggest hole** in the secret-egress rail: HTTPS bodies were
  100% invisible; with MITM on a supporting runtime they are scanned by the same
  zero-FP declared + composite scanner.
- **Cost:** ~190 LOC cert-gen (no dep) + ~200 LOC proxy transport, all behind a
  double-gated default-OFF knob; zero impact when off (byte-identical).
- **Residual risk:** (a) the Bun runtime gap (mitigated to fail-closed); (b) cert-
  pinned clients break under MITM (use `opaque-tunnel` fail mode for them); (c)
  the CA is a trust anchor — contained to ephemeral / in-process / single-socket
  scope (§3). These are documented, not hidden.
```
