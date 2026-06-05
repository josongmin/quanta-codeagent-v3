# RFC — MCP OAuth token storage in the OS keyring (+ 401 re-auth status)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: security / secret-at-rest over the MCP OAuth (H18) credential lifecycle
- Pair: **H18 — MCP HTTP-server OAuth (LANDED, grep-verified §3)**.
  This RFC hardens H18's credential STORAGE; it does not touch the flow.
- Default-OFF: keyring is opt-in; absent the knob the existing 0600 file store
  is used unchanged (byte-identical).

---

## 1. 요약 (Summary)

H18 persists MCP OAuth tokens through an injected `TokenStorePort`
(`src/connectors/types.ts:148`) that the composition root backs with a
**0600-permission file store** (`src/host/runtime/mcp-oauth-provider.ts:75-77`,
`:312-313`). A 0600 file is owner-readable plaintext: anyone with the user's UID
(another process, a backup tool, a leaked dotfile, a shared CI volume) can read
the refresh token and mint access tokens indefinitely. This RFC adds an OPTIONAL
`KeyringPort` so MCP OAuth tokens live in the OS secret store — **macOS
Keychain** / **Linux libsecret (Secret Service)** / **Windows Credential
Manager** — with the 0600 file store as the FALLBACK when no keyring is
available (headless Linux without a session keyring, etc.).

The design is a thin `KeyringPort` (closed-port — the keyring binary/exec is
injected, not shelled out via a hard-coded path) that satisfies the SAME
`TokenStorePort` interface H18 already consumes, so the swap is a
composition-root wiring change with ZERO change to the provider, the rotator, or
the flow. A `composeTokenStore(keyring, file)` chooses keyring-when-available and
falls back to file, recording WHICH backend served each read so a migration
(file → keyring on first ON) is one-directional and idempotent.

### Honest scope note — part (b) is already done

The original ask paired this with *"mid-session 401 re-auth (today only
re-auths on reconnect)"*. **That is FALSE for the current tree — mid-session 401
re-auth is LANDED.** `src/mcp/client.ts:609-630` (`request`) transparently
re-authenticates and retries ONCE on a structured mid-session 401, via
`reauthorize()` (`:700`) → `invalidate` + fresh `tokenFor` + carrier rebuild
(`:707-724`), with a shared in-flight guard (`:698-705`) and structured-401
detection that a hostile server cannot spoof (`isUnauthorizedError`, `:106-131`,
keys off `error.data.httpStatus === 401`, NOT substring). See §3.3 for the grep.
**Part (b) is therefore marked SUPERSEDED** below; this RFC delivers part (a)
(keyring) plus one genuine residual the 401 path still lacks: surfacing the
in-session re-auth in the `/mcp` status pill (§4.5, small).

---

## 2. 경쟁사 레퍼런스 (verified)

### Codex — token persistence is a swappable store (verified)

H18's own provider header credits Codex's auth manager
(`config.ts:33-39` references `codex-rs/login/src/auth/manager.rs`). Codex's
`auth.json` is a 0600 file by default, but the broader Codex/desktop credential
posture uses the **OS keychain** for desktop secrets (memory note
`codex-seatbelt-sandbox-profile` and the desktop catalog reference Keychain-backed
storage). **Takeaway:** a file store is the portable baseline; a keyring is the
hardened desktop tier. quanta should offer both behind one port — exactly what
`TokenStorePort` already abstracts.

### quanta's own backlog confirms the gap (verified, in-tree)

The intent to move secrets to the OS keyring is recorded REPEATEDLY in-tree as a
follow-up that was deferred to ship a file first:
- `src/permission/trust-scope-store.ts:7` — *"via OS keyring is a follow-up — the
  file lives under `~/.quanta` by default"*; `:117` — *"the OS keyring; we ship a
  file first (encrypted-at-rest follow-up tracked)"*.
- `src/plugin-isolation/dxt-user-config.ts:2,10,24` — already models a
  **keychain port** concept for DXT secrets (*"keychain port so plaintext secrets
  never land in the spawn spec"*) — a port shape this RFC can align with.
- `src/host/runtime/mcp-oauth-provider.ts:75` — the `tokenStore` field comment
  itself says *"file store with 0600, **or a keyring**"* — the seam was designed
  for it; the keyring adapter just was never written.

So this is not a speculative absorption — it is closing a self-documented
follow-up on the security-most-sensitive store (long-lived OAuth refresh tokens).

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 The store seam — `TokenStorePort`, file-backed at the root

- `src/connectors/types.ts:148-152` — `TokenStorePort { read(connectorId),
  write(connectorId, record), delete(connectorId) }` over `TokenRecord`
  (`:140-146`: `accessToken`, optional `refreshToken`, optional `expiresAt`,
  `tokenType`).
- `src/host/runtime/mcp-oauth-provider.ts:77` — the H18 provider config
  (`ConnectorsMcpOAuthConfig`) takes `readonly tokenStore: TokenStorePort`; `:75`
  documents it as *"file store with 0600, or a keyring"*.
- `:145` — `createTokenRotator({ tokenStore: cfg.tokenStore, clockPort })`: the
  rotator (`src/connectors/token-rotation.ts:35`) is the ONLY component that
  reads/writes/forgets through the store (`read` `:39`, `write` `:60`, `forget`/
  `delete` `:77`). So swapping the store backend is invisible above this line.
- `:312-313` — the wiring docstring: *"`tokenStore` from the file-backed store
  (0600)"*. The concrete file impl is injected at the composition root (the
  provider never constructs it), confirming the port is a clean DI seam.

**Verified: no keyring adapter exists anywhere.** A repo-wide grep for
`keyring|keychain|libsecret|secret-tool|security find-generic|wincred` over
`src/` returns ONLY documentation comments (the backlog notes above) and the
unrelated `sensitivity-classifier` (which CLASSIFIES `keychain` command lines as
secret-bearing, `src/security/sensitivity-classifier.ts:256`) — NO concrete
secret-store implementation.

### 3.2 The current secret-at-rest baseline (what we are hardening)

The file token store (the analogue of which H18 reuses) writes 0600 atomically:
`src/auth/chatgpt-oauth/token-store.ts:237-248` (`writeToken`: temp file →
`chmod 0o600` `:244` → atomic `rename`), and warns on loose permissions
(`:39-44`). This is the BASELINE — good for portability, but plaintext-readable
by the user's UID. The MCP OAuth file store follows the same posture. The keyring
moves the secret OUT of the filesystem into the OS-protected store.

### 3.3 Part (b) — mid-session 401 re-auth is ALREADY LANDED (SUPERSEDED)

The ask claimed re-auth happens "only on reconnect". Grep refutes it:

- `src/mcp/client.ts:609-615` — `request`'s docstring: *"transparently
  re-authenticating + retrying ONCE on a mid-session 401 when OAuth is active"*.
- `:616-630` — the impl: `try { requestRpc } catch { if (oauthActive &&
  isUnauthorizedError(err)) { reauthorize(); retry once } }`. Bounded to ONE
  retry (a second 401 propagates, never loops, `:614`).
- `:685-705` — `reauthorize()`: shared in-flight (`reauthInFlight ??=`, `:701`)
  so concurrent 401s rebuild the carrier exactly once; `doReauthorize` (`:707`)
  does `invalidate(serverName)` (`:713`) → `tokenFor` (`:714`) → rebuild the
  transport carrier with the fresh bearer (`:716-724`).
- `:106-131` — `isUnauthorizedError`: keys off the STRUCTURED
  `error.data.httpStatus === 401` (`:131`), NOT a substring — a hostile server
  cannot smuggle a non-401 into the re-auth path, and a `403`/`500` never
  triggers it.

**Conclusion: (b) is done. This RFC does NOT re-implement it.** The single
genuine residual on the 401 path is observability — the re-auth is silent (only
the bearer-never-logged warning path emits anything). §4.5 adds a status-pill
surface for it; that is the entire (b)-side deliverable.

### 3.4 Slice fence + closed-port discipline (placement)

- The keyring adapter touches OS APIs, so it lives at the **runtime** layer
  (`src/host/runtime/` — where `createConnectorsMcpOAuthProvider` and the file
  store are already wired, `mcp-oauth-provider.ts:142`, `buildMcpOAuthWiring`
  `:332`). `@/mcp` stays pure (`@/mcp` → `@/shared` only); it never learns the
  store is a keyring — it only ever sees `McpOAuthProviderPort`.
- **Closed-port:** the keyring is reached through an injected `exec`/native
  binding seam, NOT a hard-coded `child_process.exec("security …")`. Tests inject
  a fake keyring; no real keychain, no `process.env`, no `Date.now` in the
  adapter (the rotator already owns expiry via the injected `clockPort`,
  `mcp-oauth-provider.ts:145`).

---

## 4. 설계 (Design)

### 4.1 `KeyringPort` (closed-port secret backend)

```ts
// src/host/runtime/keyring/port.ts
export interface KeyringPort {
  /** Available IFF the OS secret service is reachable in THIS session
   *  (e.g. a Linux box with no D-Bus session keyring ⇒ false ⇒ fall back). */
  available(): Promise<boolean>
  get(service: string, account: string): Promise<string | undefined>
  set(service: string, account: string, secret: string): Promise<void>
  delete(service: string, account: string): Promise<void>
}
```

`service` is a fixed namespace constant (e.g. `"quanta.mcp-oauth"`); `account`
is the MCP `serverName` (the `connectorId` the rotator already passes). The
secret is the JSON-serialized `TokenRecord`. The adapter is constructed with an
injected platform seam (`{ exec, platform }` or a native binding factory) — never
reading `process.platform`/`process.env` directly; the composition root supplies
the real values.

Three concrete adapters behind it (selected by injected `platform`):
- **macOS** — `security add-generic-password` / `find-generic-password` /
  `delete-generic-password` via the injected `exec` (the classic Keychain CLI).
- **Linux** — libsecret via `secret-tool store/lookup/clear` (Secret Service),
  injected `exec`. `available()` probes that `secret-tool` + a session bus exist.
- **Windows** — Credential Manager (native binding or `cmdkey`/PowerShell shim),
  injected.

A `createNullKeyring()` (always `available()===false`) is the headless/test
default so nothing is constructed eagerly.

### 4.2 `composeTokenStore` — keyring-first, file-fallback, with migration

```ts
// src/host/runtime/keyring/compose.ts
export const composeTokenStore = (
  keyring: KeyringPort,
  file: TokenStorePort,        // the existing 0600 file store
  service = "quanta.mcp-oauth",
): TokenStorePort => ({
  async read(id) {
    if (await keyring.available()) {
      const fromKeyring = await keyring.get(service, id)
      if (fromKeyring !== undefined) return parseRecord(fromKeyring)
      // MIGRATION: a token still only in the file → move it into the keyring
      // ONCE, then delete the file copy (one-directional, idempotent).
      const fromFile = await file.read(id)
      if (fromFile !== undefined) {
        await keyring.set(service, id, serializeRecord(fromFile))
        await file.delete(id)        // best-effort; NO-THROW (see §4.4)
        return fromFile
      }
      return undefined
    }
    return file.read(id)             // keyring unavailable ⇒ pure file behavior
  },
  async write(id, rec) {
    if (await keyring.available()) return keyring.set(service, id, serializeRecord(rec))
    return file.write(id, rec)
  },
  async delete(id) {
    // Delete from BOTH so a logout/invalidate leaves no residue in either store
    // (matters during/after a migration window). NO-THROW on the absent side.
    if (await keyring.available()) await keyring.delete(service, id).catch(() => undefined)
    await file.delete(id).catch(() => undefined)
  },
})
```

Key properties:
- **Drop-in `TokenStorePort`** — the H18 provider/rotator are unchanged
  (`mcp-oauth-provider.ts:145` keeps `createTokenRotator({ tokenStore })`); only
  the composition root swaps which `TokenStorePort` it injects.
- **One-directional migration** — on the first ON with a keyring available, an
  existing 0600 token is moved into the keyring and the file copy deleted; reads
  thereafter hit the keyring. Idempotent (a second read finds the keyring copy
  and skips the file).
- **Delete spans both** — `invalidate`/logout removes the secret from keyring AND
  file (defense against a stale file lingering through the migration window).

### 4.3 Wiring (composition root only)

`buildMcpOAuthWiring(enabled, deps)` (`mcp-oauth-provider.ts:332`) already gates
the whole H18 provider. The ONLY new wiring: when `QUANTA_MCP_OAUTH_KEYRING=1`,
the root constructs `deps.tokenStore = composeTokenStore(realKeyring, fileStore)`;
otherwise `deps.tokenStore = fileStore` (today's behavior, byte-identical). The
`enabled` gate, provider construction, and `McpOAuthProviderPort` surface are
untouched.

### 4.4 NO-THROW + no-leak invariants

- **Keyring errors degrade, never crash the load.** `KeyringPort` methods that
  fail (locked keychain, denied prompt, missing bus) are caught in
  `composeTokenStore` and treated as "secret absent" → the provider's `tokenFor`
  re-runs the OAuth flow (the port is TOTAL — `mcp-oauth-provider.ts:28-31`
  guarantees a failed store degrades to unauthenticated, never throws into the
  MCP load). A keyring outage thus degrades to "re-login", not a crash.
- **No secret in logs / process args where avoidable.** The macOS/libsecret CLIs
  can leak the secret via argv; the adapter passes the secret over STDIN (`-w`
  prompt / `secret-tool store` reads stdin) rather than as a positional arg, and
  the secret is never logged (mirrors the bearer-never-logged discipline,
  `client.ts:675`).
- **Migration is best-effort** — if the file `delete` after a keyring `set`
  fails, the read still returns the record; a later read re-attempts the move.
  Never throws.

### 4.5 (b)-residual — surface the in-session 401 re-auth (small)

The landed `reauthorize()` (§3.3) is silent. Add ONE observation hook: when
`doReauthorize` succeeds, emit an existing-shape status event so the `/mcp`
status pill shows "re-authenticated <server>" (and on `false`, "auth expired —
run /mcp login"). This reuses the supervisor/status-pill plumbing; it does NOT
change the re-auth control flow (which is already correct). Pure observability;
gated by the same `QUANTA_MCP_OAUTH` knob.

---

## 5. 통합 (Integration)

- **Knob — `QUANTA_MCP_OAUTH_KEYRING=1`, default-OFF, byte-identical.** Add
  beside `mcpOAuth` (`src/shared/runtime-config.ts:179-189`). Unset ⇒ the root
  injects the file store exactly as today; no keyring constructed, no migration,
  no behavior change. The keyring path is reachable ONLY when BOTH
  `QUANTA_MCP_OAUTH=1` AND `QUANTA_MCP_OAUTH_KEYRING=1` AND the OS keyring
  `available()`.
- **No new tool, no manifest change** — this is a storage backend, not an
  agent-callable surface. `src/tool/surface/manifest.ts` untouched.
- **fc entry** — add `mcp.oauth-keyring` under the MCP/security axis,
  `status: planned`, `depends_on: [mcp-http-oauth (H18)]`,
  `labels: ["security", "secret-at-rest"]`.
- **Fence-clean placement** (§3.4): new `src/host/runtime/keyring/` slice
  (`@/host/runtime` is the composition root — it may reach `@/connectors` types
  for `TokenStorePort`/`TokenRecord` and the platform `exec`). `@/mcp` is
  untouched and stays `@/shared`-only.

---

## 6. 테스트 계획 (Tests)

Hellgate (`tests/.../mcp-oauth-keyring-hellgate.test.ts`), over a FAKE
`KeyringPort` + the existing in-memory `TokenStorePort` as the file fallback.
Every arm explicit:

1. **keyring available — round-trip** — `write` → `read` hits the keyring;
   `delete` removes it. The file store is never touched.
2. **keyring unavailable — pure file fallback** — `available()===false` ⇒ every
   op delegates to the file store; output byte-identical to today's H18.
3. **migration (file → keyring)** — a token pre-seeded ONLY in the file; first
   `read` with keyring available moves it into the keyring AND deletes the file
   copy; a second `read` hits the keyring and does NOT re-touch the file.
4. **migration idempotent under failure** — the post-`set` file `delete` throws;
   `read` still returns the record; a re-read re-attempts the move; no throw.
5. **keyring error degrades to re-login** — `get`/`set` throws (locked keychain);
   `composeTokenStore` swallows it, `read` returns `undefined` ⇒ the provider's
   total `tokenFor` re-runs the flow (assert via the H18 provider's existing
   total-contract test harness), never crashes the load.
6. **delete spans both stores** — a record present in BOTH (mid-migration window)
   is removed from BOTH on `delete`; neither lingers.
7. **secret never in argv / logs** — assert the fake `exec` is invoked with the
   secret on STDIN, not as a positional arg; assert no log line contains the
   token (mirrors the bearer-redaction test).
8. **default-OFF byte-identical** — knob unset ⇒ the root injects the file store
   ⇒ the H18 store-path output equals the pre-RFC output.

(b)-residual unit: `doReauthorize` success/failure each emits the expected
status event once (and exactly once under the in-flight-coalesced concurrent-401
case, reusing the existing `reauthInFlight` test).

E2e (`tests/smoke/`, opt-in tier): a fake MCP OAuth server + fake keyring;
login writes to the keyring, a forced mid-session 401 re-auths in place and the
status pill updates, logout clears the keyring entry.

---

## 7. 단계 (Phases)

- **Phase 1 — `KeyringPort` + `composeTokenStore` + macOS/Linux adapters +
  root wiring** (the security core): the port (§4.1), the compose+migration
  (§4.2), the macOS Keychain and Linux libsecret adapters, `createNullKeyring`,
  and the `QUANTA_MCP_OAUTH_KEYRING` gate at the root (§4.3). hellgate cases 1-8.
  Windows adapter can ship as a follow-up (the null keyring keeps it correct in
  the meantime).
- **Phase 2 — (b)-residual status pill** (§4.5): the one re-auth observation
  hook. Tiny; can ship with Phase 1 or just after.
- **Phase 3 (optional) — generalize the keyring** to back the chatgpt-oauth token
  store (`src/auth/chatgpt-oauth/token-store.ts`) and the trust-scope store
  (`src/permission/trust-scope-store.ts:7,117`, which already names the keyring as
  its follow-up) through the SAME `KeyringPort`. Pure reuse; closes three
  self-documented follow-ups with one adapter.

---

## 8. 리스크 / 대안 (Risks / Alternatives)

- **SECURITY — keyring outage must not lock the user out.** A locked/denied
  keychain returning an error could otherwise crash the MCP load. Mitigation
  (§4.4): all `KeyringPort` errors degrade to "secret absent" inside
  `composeTokenStore`, and the H18 provider is TOTAL — a missing secret re-runs
  the OAuth flow rather than throwing. So the worst case is "log in again", never
  a crash. Hellgate case 5 pins it.
- **Migration data-loss window.** Moving file → keyring then deleting the file
  risks losing the token if the process dies between `set` and `delete`.
  Mitigation: `set` precedes `delete`; a crash mid-move leaves the token in BOTH
  stores (read prefers keyring, file still readable); the move is idempotent
  (§4.2). NEVER delete the file before the keyring `set` resolves.
- **Secret leakage via CLI argv.** `security`/`secret-tool` can expose the secret
  in process args. Mitigation (§4.4): secret over STDIN, never positional; never
  logged. Hellgate case 7.
- **Headless Linux without a session keyring.** `available()` returns false and
  the file store is used unchanged — no regression for CI/servers. This is why
  the file store stays the FALLBACK, not removed.
- **Part (b) re-implementation risk.** Re-implementing mid-session 401 re-auth
  would DUPLICATE the landed `reauthorize()` and risk diverging the structured-401
  contract. AVOIDED: §3.3 marks (b) SUPERSEDED; only the silent-observability
  residual (§4.5) is added, leaving the proven control flow untouched.
- **Alternative — encrypt the file at rest instead of a keyring.** Rejected as
  the primary: file encryption needs a key, which itself needs the OS keyring (or
  a passphrase prompt) to protect — circular. The keyring IS the OS-managed key
  custody. Encrypted-file is the fallback for platforms with no keyring (tracked,
  not in this RFC).
- **Alternative — bake the platform branch into one adapter.** Rejected: three
  thin platform adapters behind `KeyringPort` keep each OS path independently
  testable (inject a fake `exec`) and let `available()` probe per-platform without
  a `process.platform` switch inside business logic.

---

## 9. 코드 위치 요약 (Files)

**Create** (new keyring slice at the composition root):
- `src/host/runtime/keyring/port.ts` — `KeyringPort` (§4.1).
- `src/host/runtime/keyring/macos.ts` — Keychain adapter (injected `exec`).
- `src/host/runtime/keyring/libsecret.ts` — Linux Secret Service adapter.
- `src/host/runtime/keyring/null.ts` — `createNullKeyring` (headless/test default).
- `src/host/runtime/keyring/compose.ts` — `composeTokenStore` + migration (§4.2).
- `src/host/runtime/keyring/serialize.ts` — `TokenRecord` ↔ string codec.
- `tests/.../mcp-oauth-keyring-hellgate.test.ts` (§6).

**Touch** (wiring + observability + config):
- `src/host/runtime/mcp-oauth-provider.ts` — at the root build site, inject
  `composeTokenStore(keyring, fileStore)` when `QUANTA_MCP_OAUTH_KEYRING=1`
  (the `tokenStore` field at `:77`/`:145` is unchanged in TYPE — only the
  concrete value differs).
- `src/host/runtime/index.ts` — export the keyring barrel.
- `src/shared/runtime-config.ts` — `QUANTA_MCP_OAUTH_KEYRING` flag beside
  `mcpOAuth` (`:179-189`, `:606-611`).
- `src/mcp/client.ts` — (b)-residual ONLY: emit a status event on
  `doReauthorize` outcome (`:707`); NO control-flow change.
- `tools/feature-catalog/*` — `mcp.oauth-keyring` entry.

**Read-only (referenced, never modified):**
- `src/connectors/types.ts:148` — `TokenStorePort` / `TokenRecord` (the seam).
- `src/connectors/token-rotation.ts:35,39,60,77` — the sole store consumer.
- `src/host/runtime/mcp-oauth-provider.ts:28-31,142,332` — H18 provider +
  total-contract + `buildMcpOAuthWiring`.
- `src/mcp/client.ts:106-131,609-630,685-724` — the LANDED structured-401
  mid-session re-auth (part (b) — SUPERSEDED, not re-implemented).
- `src/auth/chatgpt-oauth/token-store.ts:237-248` — the 0600 file-store baseline
  (the fallback's reference impl).
- `src/permission/trust-scope-store.ts:7,117`,
  `src/plugin-isolation/dxt-user-config.ts:2,10,24` — the self-documented keyring
  follow-ups this port can later generalize to (Phase 3).
