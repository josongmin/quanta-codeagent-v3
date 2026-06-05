# RFC — Revoke OAuth tokens on logout (server-side, best-effort)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: security hygiene over the OAuth logout lifecycle (chatgpt-oauth + MCP OAuth)
- Pair: **ADR-0094 — ChatGPT OAuth (LANDED)** and **H18 — MCP OAuth (LANDED)**.
- Default-OFF: revoke is opt-in; absent the knob, logout deletes the local token
  exactly as today (byte-identical). When ON, revoke is BEST-EFFORT + NO-THROW —
  the local delete ALWAYS happens even if the network revoke fails.

---

## 1. 요약 (Summary)

`/logout` today deletes ONLY the local token file
(`src/apps/cli/logout-cmd.ts:131` → `deleteToken(pathUsed)` →
`unlink`, `src/auth/chatgpt-oauth/token-store.ts:250-252`). The server-side
**refresh token stays valid** — the IdP can still mint access tokens against it
until it naturally expires. Anyone who captured that refresh token (a leaked
backup, a stale process, a compromised disk before the delete) retains access
*after* the user believed they signed out. The logout docstring even states the
omission as a deliberate Codex-parity choice
(`logout-cmd.ts:4-7`: *"Does NOT call any remote `/revoke` endpoint"*).

This RFC adds an OPTIONAL OAuth token **revocation** (RFC 7009) on logout: before
the local delete, POST the refresh token to the IdP's `/oauth/revoke` (or the
discovered `revocation_endpoint`). It is **best-effort + NO-THROW** — a network
failure, an IdP that lacks a revoke endpoint, or a non-2xx response is logged and
swallowed; **the local delete proceeds unconditionally** so logout never gets
worse than today. The same path also revokes any MCP OAuth tokens (H18) the user
holds, so "log out" means "log out everywhere", not just "forget locally".

ROI: pure security — closes a credential-lifetime hole on the highest-value
secret (a long-lived refresh token) for ~150 lines, default-OFF, zero risk to the
existing logout (local delete is unchanged and unconditional).

---

## 2. 경쟁사 레퍼런스 (verified)

- **RFC 7009 (OAuth 2.0 Token Revocation)** is the standard: a
  `POST {revocation_endpoint}` with `token=<refresh_token>&
  token_type_hint=refresh_token` (+ client auth). A successful revoke
  invalidates the refresh token AND (per §2.1) the associated access tokens.
- **Codex** does NOT wire a ChatGPT-path revoke (`logout-cmd.ts:5` cites
  `codex-rs/login/src/auth/revoke.rs` as *"auth-mode-specific and not wired for
  the ChatGPT subscription path"*). This RFC goes ONE step further than Codex —
  honest divergence: quanta gains the option, gated and best-effort, rather than
  copying Codex's local-only logout. The OpenAI issuer
  (`https://auth.openai.com`, `config.ts:10`) exposes the standard OAuth surface;
  the revoke endpoint is discovered or defaulted (§4.2).

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 Logout is local-delete-only (the gap)

- `src/apps/cli/logout-cmd.ts:91-138` — `buildLogoutCmd().run`: resolves the token
  (`readResolvedToken`, `:111`), and on `prior !== null` calls
  `deleteToken(pathUsed)` (`:131`) — nothing else. The docstring (`:4-7`) confirms
  NO remote revoke.
- `src/auth/chatgpt-oauth/token-store.ts:250-255` — `deleteToken(path)` =
  `unlink` (best-effort: a missing file is swallowed). The `TokenRecord` it
  deletes carries `refresh_token` (`:14`, `:60`) — the credential that SHOULD be
  revoked server-side.
- The Codex-managed path is already special-cased (`logout-cmd.ts:120-123`:
  `source === "codex"` ⇒ "managed by Codex", return 2) — revoke must skip that
  branch (we don't own Codex's token), §4.4.

### 3.2 The pieces a revoke needs already exist (verified)

- **Issuer + client id** — `resolveOAuthConfig(env)`
  (`src/auth/chatgpt-oauth/config.ts:64-70`): `issuer`
  (`https://auth.openai.com`, `:10`), `clientId` (`:66`), `originator`/`sku`
  headers (`:53`, `:46`). A revoke POST reuses these verbatim.
- **A fetch seam** — the OAuth flow already POSTs to token endpoints via an
  injected `fetchPort` (H18: `mcp-oauth-provider.ts:188`, `:209`; chatgpt-oauth's
  refresh: `src/auth/chatgpt-oauth/refresh.ts`). The revoke reuses the SAME
  injected-fetch discipline (closed-port — no global `fetch`, no `process.env` in
  the call).
- **MCP OAuth invalidate (local)** — `McpOAuthProviderPort.invalidate(serverName)`
  (`mcp-oauth-provider.ts:298-300` → `rotator.forget` →
  `tokenStore.delete`) forgets the token LOCALLY but does NOT revoke server-side.
  The same gap, on the MCP side.
- **No revoke anywhere** — a repo-wide grep for `revoke|revocation|/revoke` over
  `src/auth`, `src/connectors`, `src/host` returns only the comment at
  `mcp-oauth-provider.ts:266` (*"refresh rejected (revoked … token)"* — a reaction
  to revocation, not an action). Confirmed: no revoke call exists.

---

## 4. 설계 (Design)

### 4.1 `OAuthRevoker` (closed-port, best-effort)

```ts
// src/auth/chatgpt-oauth/revoke.ts
export interface RevokeDeps {
  readonly fetchPort: FetchPort        // injected — same seam as refresh/token POST
  readonly logger?: { warn(msg: string, ctx?: unknown): void }
}

/** RFC 7009 best-effort revoke of a refresh token. NEVER throws: every failure
 *  (no endpoint, network error, non-2xx, missing token) resolves to a typed
 *  outcome so the caller can log + proceed to the LOCAL delete unconditionally. */
export const revokeRefreshToken = async (
  deps: RevokeDeps,
  input: { revocationEndpoint: string; clientId: string; refreshToken: string },
): Promise<{ ok: true } | { ok: false; reason: "no-token" | "network" | "non-2xx" }> => {
  if (input.refreshToken.length === 0) return { ok: false, reason: "no-token" }
  try {
    const res = await deps.fetchPort(input.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.refreshToken,
        token_type_hint: "refresh_token",
        client_id: input.clientId,
      }).toString(),
    })
    // RFC 7009 §2.2: a successful revoke returns 200; an unknown/already-revoked
    // token ALSO returns 200 (idempotent). Treat any 2xx as success.
    return res.ok ? { ok: true } : { ok: false, reason: "non-2xx" }
  } catch (e) {
    deps.logger?.warn("oauth-revoke: network failure (token deleted locally anyway)", {
      error: errMessage(e),   // never the token
    })
    return { ok: false, reason: "network" }
  }
}
```

### 4.2 Resolving the revocation endpoint

Default to `${issuer}/oauth/revoke` (mirrors `browser-flow.ts:80`'s
`${issuer}/oauth/authorize` construction). When the IdP publishes a
`revocation_endpoint` via RFC 8414 discovery (H18 already does discovery for MCP —
`mcp-oauth-provider.ts:16-18`), prefer the discovered value; else the default.
For chatgpt-oauth (single fixed issuer) the default is sufficient; discovery is
the MCP-side path which already has the machinery.

### 4.3 Logout wiring (chatgpt-oauth)

In `buildLogoutCmd().run`, BETWEEN the `prior !== null` check (`logout-cmd.ts:125`)
and `deleteToken` (`:131`), when the knob is ON and `source !== "codex"`:

```ts
if (revokeEnabled && source !== "codex" && prior.refresh_token) {
  const cfg = resolveOAuthConfig(tokenEnv)
  // best-effort; outcome ONLY affects the rendered note, NEVER the delete
  const outcome = await revokeRefreshToken(
    { fetchPort, logger },
    { revocationEndpoint: `${cfg.issuer}/oauth/revoke`,
      clientId: cfg.clientId, refreshToken: prior.refresh_token },
  )
  revokeNote = outcome.ok ? "server session revoked" : "local only (revoke unavailable)"
}
await deleteToken(pathUsed)   // UNCHANGED, UNCONDITIONAL — runs whether revoke ok or not
```

The `renderLoggedOut` box (`:28-47`) gains one optional `kvLine("revoke", …)`
reflecting `revokeNote`. The local delete and ALL existing branches (codex /
already-out / read-error / delete-error) are byte-identical.

### 4.4 MCP OAuth revoke (same shape, H18 side)

Extend `McpOAuthProviderPort` with an OPTIONAL `revoke(serverName)` (or fold into
`invalidate` behind the knob): before `rotator.forget` (the local delete,
`mcp-oauth-provider.ts:299`), read the stored `refreshToken` and call
`revokeRefreshToken` against the discovered/`${issuer}/oauth/revoke` endpoint,
best-effort. A `/mcp logout <server>` (or the existing `invalidate` site) drives
it. NO-THROW: a failed revoke still forgets locally. Skipped when no
`refreshToken` is stored or the knob is off.

### 4.5 Invariants

- **Local delete is unconditional + first-class.** Revoke runs BEFORE
  `deleteToken`, but its outcome NEVER gates the delete (§4.3). A hung/failing
  revoke cannot leave a stale local token.
- **NO-THROW end to end.** `revokeRefreshToken` resolves a typed outcome for
  every failure (§4.1); the caller only reads it to render a note.
- **No token in logs.** The revoke logs only `error.message` and a reason code,
  never the token (mirrors the bearer-redaction discipline, `client.ts:675`).
- **Codex-managed tokens are never revoked.** The `source === "codex"` branch
  (`logout-cmd.ts:120`) returns BEFORE revoke — we don't own that credential.

---

## 5. 통합 (Integration)

- **Knob — `QUANTA_OAUTH_REVOKE_ON_LOGOUT=1`, default-OFF, byte-identical.** Add
  beside the OAuth flags (`src/shared/runtime-config.ts`, near `mcpOAuth`
  `:179-189`). Unset ⇒ `/logout` and MCP `invalidate` do exactly today's
  local-only delete; no network call constructed.
- **No new tool / manifest row** — revoke is a logout-lifecycle action, not an
  agent-callable surface. `src/tool/surface/manifest.ts` untouched.
- **fc entry** — `auth.revoke-on-logout`, `status: planned`,
  `depends_on: [chatgpt-oauth (ADR-0094), mcp-http-oauth (H18)]`,
  `labels: ["security"]`.
- **Fence-clean** — `revoke.ts` lives in `src/auth/chatgpt-oauth/` (already owns
  the OAuth fetch/config vocabulary); the MCP-side call sits at the composition
  root in `src/host/runtime/mcp-oauth-provider.ts` (which already does the OAuth
  fetch). `@/mcp` is untouched.

---

## 6. 테스트 계획 (Tests)

Hellgate (`tests/.../oauth-revoke-on-logout-hellgate.test.ts`), over a FAKE
`fetchPort` + tmp prefs home. Every arm explicit:

1. **happy revoke** — knob ON, refresh token present, fake fetch returns 200 ⇒
   revoke POSTed with `token_type_hint=refresh_token` + `client_id`; local token
   deleted; box shows "server session revoked".
2. **network failure → local delete still happens** — fake fetch THROWS; outcome
   `network`; `deleteToken` STILL called; box shows "local only"; command returns
   0 (logout succeeded). The dominant safety case.
3. **non-2xx → local delete still happens** — fetch returns 401/500; outcome
   `non-2xx`; local delete proceeds; never throws.
4. **no refresh token** — `prior.refresh_token` absent/empty ⇒ revoke skipped
   (`no-token`), local delete proceeds, no POST issued.
5. **knob OFF byte-identical** — `/logout` performs ZERO network calls; output +
   exit code identical to the pre-RFC logout (assert the fake fetch was never
   invoked).
6. **codex-managed skipped** — `source === "codex"` ⇒ returns 2 BEFORE any
   revoke; fake fetch never invoked.
7. **no token in logs / argv** — assert the body carries the token but NO log
   line / no rendered box contains it.
8. **MCP-side revoke best-effort** — H18 `revoke(serverName)`: fetch throws ⇒
   `rotator.forget` STILL runs (local invalidate unconditional); no throw.

E2e (opt-in tier): fake IdP with a revoke endpoint; `/login` then `/logout` ⇒ the
fake IdP records the revoke POST and the local token file is gone; with the knob
off, `/logout` issues no POST.

---

## 7. 단계 (Phases)

- **Phase 1 — chatgpt-oauth revoke** (the high-value secret): `revoke.ts` (§4.1),
  endpoint default (§4.2), logout wiring (§4.3), the knob, hellgate 1-7. Smallest
  shippable; closes the refresh-token-lives-after-logout hole.
- **Phase 2 — MCP OAuth revoke** (§4.4): the `McpOAuthProviderPort.revoke` /
  knob-gated `invalidate` extension, reusing `revokeRefreshToken` + H18 discovery.
  hellgate 8.

---

## 8. 리스크 / 대안 (Risks / Alternatives)

- **SECURITY (the whole point) — but revoke must NEVER worsen logout.** A revoke
  that hung or threw could block/abort the local delete, leaving a token on disk
  — strictly worse than today. Mitigation (§4.5): revoke is best-effort, runs
  BEFORE the delete, and its outcome NEVER gates the unconditional `deleteToken`.
  Hellgate cases 2/3 are the load-bearing proof.
- **Wrong/absent revocation endpoint.** A default `${issuer}/oauth/revoke` may
  404 on some IdPs. Treated as `non-2xx` ⇒ logged + local delete proceeds (§4.2);
  RFC 8414 discovery (already available H18-side) prefers the published endpoint
  when present. Never fatal.
- **Token leakage in the revoke request.** The refresh token rides the POST body
  (required by RFC 7009) but never a URL/argv/log. §4.5 + hellgate 7 pin it.
- **Idempotency / double-logout.** RFC 7009 §2.2 makes revoke idempotent (an
  already-revoked/unknown token returns 200); a second `/logout` is harmless
  (and short-circuits at `prior === null` anyway, `logout-cmd.ts:125`).
- **Alternative — local-delete-only (status quo / Codex parity).** Rejected as
  the default-ON, kept as the default-OFF behavior: the refresh-token-survives
  hole is a real credential-lifetime risk; offering opt-in revoke closes it at
  ~150 lines with zero downside (delete is unchanged).
- **Alternative — revoke synchronously block on the network before delete.**
  Rejected: a slow IdP would stall logout. Best-effort-then-delete keeps logout
  instant and reliable; the revoke is a bonus, not a precondition.

---

## 9. 코드 위치 요약 (Files)

**Create:**
- `src/auth/chatgpt-oauth/revoke.ts` — `revokeRefreshToken` + `RevokeDeps` (§4.1).
- `tests/.../oauth-revoke-on-logout-hellgate.test.ts` (§6).

**Touch:**
- `src/apps/cli/logout-cmd.ts` — call revoke between `prior !== null` (`:125`) and
  `deleteToken` (`:131`), gated + codex-skipped; add the optional `revoke` kvLine
  to `renderLoggedOut` (`:28-47`); inject `fetchPort` via the `LogoutDeps` builder
  (`:23-26`, mirroring the existing `env`/`nowMs` seam). Update the `:4-7`
  docstring (no longer "does NOT call /revoke" when the knob is on).
- `src/auth/chatgpt-oauth/index.ts` — export `revokeRefreshToken`.
- `src/host/runtime/mcp-oauth-provider.ts` — Phase 2: knob-gated server-side
  revoke before `rotator.forget` in `invalidate` (`:298-300`).
- `src/shared/runtime-config.ts` — `QUANTA_OAUTH_REVOKE_ON_LOGOUT` flag.
- `tools/feature-catalog/*` — `auth.revoke-on-logout` entry.

**Read-only (referenced, never modified):**
- `src/apps/cli/logout-cmd.ts:4-7,120-138` — the local-delete-only logout (the gap).
- `src/auth/chatgpt-oauth/token-store.ts:14,60,250-255` — `deleteToken` +
  `refresh_token` field.
- `src/auth/chatgpt-oauth/config.ts:10,64-70` — issuer/clientId/headers (reused).
- `src/auth/chatgpt-oauth/browser-flow.ts:80` — the `${issuer}/oauth/*` URL
  construction pattern.
- `src/host/runtime/mcp-oauth-provider.ts:188,209,298-300` — the injected-fetch
  POST + local `invalidate` (H18 revoke reuses both).
