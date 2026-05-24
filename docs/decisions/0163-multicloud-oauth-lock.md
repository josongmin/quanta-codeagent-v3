# ADR-0163 — Multi-cloud LLM + OIDC federation + distributed OAuth refresh lock + mid-session GitHub token rotation (W12)

Status: Accepted (2026-05-24)
Supersedes: extends ADR-0139 (provider fork) and ADR-0151 (Bedrock/Vertex real wire). Closes W12 of the absorption roadmap (`0130-extracted-source-absorption-roadmap.md`).

## Context

The extracted-source audit (memo `extracted-source-novel-findings-2026-05-24`, R1 + R5) surfaced four enterprise primitives present in Claude Code 1.x and Cursor 3.x that quanta does not yet model:

1. **Multi-cloud transport fan-out** — Claude CLI ships four parallel transport switches: `CLAUDE_CODE_USE_BEDROCK` (AWS), `CLAUDE_CODE_USE_VERTEX` (GCP), `CLAUDE_CODE_USE_FOUNDRY` (Azure), and `CLAUDE_CODE_USE_MANTLE` (Anthropic internal/enterprise). ADR-0139 + ADR-0151 land three; Mantle is missing and the env-var mirror is absent (we resolve via `ANTHROPIC_*_BASE_URL` only).
2. **OIDC federation** — Claude CLI accepts an `ANTHROPIC_IDENTITY_TOKEN_FILE` (Kubernetes service-account projection / GitHub OIDC / Vault) + `ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID` to exchange a workload-identity token for a short-lived Anthropic access token. No long-lived API key on disk.
3. **Distributed OAuth refresh lock** — Cursor exposes `MCP_O_AUTH_REFRESH_LOCK_REDIS_ERROR / _WOULD_ACQUIRE / _WOULD_WAIT` telemetry, evidence of a Redis-backed lock that prevents two CLI instances on the same machine (or the same user across machines) from racing to refresh an OAuth token. Without it, both refreshes succeed, the loser's token is invalidated mid-stream, and the user sees a spurious 401.
4. **Mid-session GitHub token rotation** — Cursor's `RefreshGithubAccessTokenInBackgroundComposer` rotates the GitHub access token on a timer (well before the 8-hour GH app token expiry) so long-running sessions never hit a 401 during a `gh api` call. The rotation is lock-protected (same lock from §3).

Our existing slice (`src/llm/providers/` 7 files) is hexagonal but partial:

- Only three transports (default / bedrock / vertex); Foundry is a stub; Mantle absent.
- Provider router (`resolveProvider`) consults `ANTHROPIC_*_BASE_URL` env keys, not the `CLAUDE_CODE_USE_*` set the user community standardized on.
- Auth lives in `src/auth/chatgpt-oauth/` — single-process, no cross-instance lock, no OIDC federation, no GitHub token rotation.

The W6–W11 batch has already shipped the smaller primitives (ADRs 0145–0162). W12 closes the cluster.

## Decision

Land **six new modules** behind ports, default-OFF, byte-identical to today when env vars are absent:

```
src/llm/
  provider-types.ts           # NEW — enriched LlmProvider union + ProviderCredentials kind
  provider-router.ts          # NEW — CLAUDE_CODE_USE_* env detection + precedence ladder
  providers/
    mantle-adapter.ts         # NEW — Anthropic Mantle enterprise transport (stub Phase 1)
    foundry-adapter.ts        # EXISTING — graduates from stub to typed wire with MSI auth
  oidc-federation.ts          # NEW — exchangeToken(identityTokenFile, federationRuleId, orgId)
src/auth/
  oauth-refresh-lock.ts       # NEW — OAuthRefreshLockPort + 3 impls
  lock-in-memory.ts           # NEW — single-instance Map-based
  lock-file-based.ts          # NEW — cross-instance same-machine (flock)
  lock-redis-stub.ts          # NEW — Redis SETNX adapter stub (Phase 2 wires real client)
  github-token-rotation.ts    # NEW — GitHubTokenRotatorPort with lock-protected refresh
```

Three transports already shipped (default/bedrock/vertex) are **untouched**; the existing `ProviderId` union grows by exactly one (`mantle`), and `foundry` keeps its stub-throw posture in Phase 1 (its real wire is a separate cherry).

### Phase A — Provider-router (env mirror)

Mirror the Claude CLI env-var triad (`CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY / MANTLE`) **alongside** the existing `ANTHROPIC_*_BASE_URL` keys. Precedence: explicit > `CLAUDE_CODE_USE_*` truthy > `ANTHROPIC_*_BASE_URL` non-empty > default. Conflict (two `_USE_*` truthy at once) → typed `provider-conflict` error (we do not silently pick one).

### Phase B — Mantle adapter

Anthropic Mantle has no public SDK as of 2026-05-24. We ship a typed stub identical in shape to `FoundryProviderAdapter` (Phase 1 throw-only) so call sites can wire the slot in advance; Phase 2 swaps in the real wire with zero call-site churn.

### Phase C — OIDC federation

`OidcFederationPort.exchangeToken({identityTokenFile, federationRuleId, orgId})` reads the token file (size cap + non-empty + JWT-shaped probe — no parse, no verify), then calls an exchange endpoint (port-injected `HttpClient`, no `fetch` direct). Returns `{accessToken, expiresAt}`. Stub Phase 1: real endpoint URL is a config-injected base + `/v1/identity/exchange`.

### Phase D — Distributed OAuth refresh lock

Single port, three implementations behind it:

```typescript
type LockResult = "would-acquire" | "would-wait" | "acquired" | "redis-error"
interface OAuthRefreshLockPort {
  tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult>
  release(key: string, holderId: string): Promise<void>
}
```

- `InMemoryLock` — Map-based, single-process. Holds + TTL.
- `FileBasedLock` — `~/.quanta/locks/{key}.lock` with PID + holderId + expiry. Cross-process same-machine. Stale-lock reaping by mtime + PID liveness probe (port-injected).
- `RedisStub` — surface only; throws `redis-error` on every call so callers can wire fallback `(redis → file → memory)`. Phase 2 swaps in real `ioredis` SETNX.

`LockResult` names mirror Cursor's `MCP_O_AUTH_REFRESH_LOCK_*` telemetry verbatim so cross-tool observability stays comparable.

### Phase E — Mid-session GitHub token rotation

`GitHubTokenRotatorPort.rotate({currentToken, refreshToken, clockPort, httpPort, lockPort})` acquires the lock (key = `gh-token-{userId}`), checks token age via `clockPort.now()`, and if older than the (port-injected) rotation threshold, posts to `https://github.com/login/oauth/access_token`. Returns the new pair + the lock release callback baked in (try/finally).

### Phase F — Tests + hellgate + feature catalog

Six new hellgate batteries (12+ each), six unit batteries (6+ each), eight feature-catalog yamls under `tools/feature-catalog/features/08-llm/` (new category dir).

## Discipline (closed-port + no-heuristics)

- **SRP** — each adapter and each lock impl is one file. No multi-vendor switch statements.
- **OCP** — adding Mantle is one entry in `ProviderId` union + one entry in `FACTORIES` + one adapter file. No if-chain edits.
- **LSP** — every adapter is a `LlmProvider`; every lock impl is an `OAuthRefreshLockPort`.
- **ISP** — `ProviderCredentials`, `OidcFederationPort`, `OAuthRefreshLockPort`, `GitHubTokenRotatorPort` are four separate ports; no caller pays for the surface it does not consume.
- **DIP** — AWS / GCP / Azure / GitHub SDKs all imported via ports (no direct `import` from adapter constructors). HTTP + file + clock + lock all port-injected, **closed-port** end-to-end.
- **No heuristics** — TTLs and rotation thresholds are port-injected constants documented to vendor spec (GitHub: 8h app token, we rotate at 6h; Anthropic OIDC: federation-rule expiry from response). No "I picked 30s because it felt right" values.

## Backward compatibility

- All seven existing modules in `src/llm/providers/` untouched (zero diff).
- `src/llm/factory.ts` untouched (`Provider` union still 3 entries; Mantle is opt-in via the new router).
- `src/auth/chatgpt-oauth/*` untouched (the new lock is composed AROUND it, not into it).
- Byte-identical wire payload when none of `CLAUDE_CODE_USE_*` / `ANTHROPIC_IDENTITY_TOKEN_FILE` / `QUANTA_OAUTH_LOCK` / `QUANTA_GH_ROTATE` env vars are set.

## Default

OFF. Every new module opts in via explicit env or explicit caller wiring. Absent env ⇒ legacy paths exclusively.

## Negative invariants

1. No silent fallback between cloud transports. `BEDROCK` + `VERTEX` simultaneously set → `provider-conflict` error, **not** "pick bedrock because alphabetical".
2. No long-lived API key generation by the OIDC exchanger — the exchanged token's TTL is the vendor's TTL, not a quanta-side amplifier.
3. Lock impls never `setTimeout` the release. Release is explicit; staleness reaping is mtime-based at acquire time (no daemon, no timer).
4. GitHub token rotation never reads the lock state directly — it goes through `lockPort.tryAcquire`. No "is locked?" sneaky read.
5. No catch-all `Error` in any adapter — every throw is a typed `ProviderError` (codes: `provider-unsupported`, `provider-misconfigured`, `provider-missing-dependency`, `provider-conflict`) or `LLMError` (wire layer).
6. Provider router has no global state — it is a pure `(env) → ResolvedProvider` function; tests inject env directly.

## V2 deferred

- Real AWS Bedrock network call (`BedrockProviderAdapter` already wires the SDK lazy-load; V2 = ship signed integration tests against a real bedrock endpoint).
- Real GCP Vertex network call (same — lazy-load done, integration tests deferred).
- Real Azure Foundry adapter (no SDK yet — Phase 2 when Anthropic ships `@anthropic-ai/foundry-sdk` or equivalent).
- Real Mantle adapter (no public spec — Phase 2 when Anthropic publishes).
- Real `ioredis` adapter behind `RedisStub` (Phase 2 wires `SETNX key value EX ttl NX` + Lua release script).
- Real OIDC exchange endpoint URL (Phase 2 wires `https://api.anthropic.com/v1/identity/federation/exchange` once Anthropic publishes; until then, port-injected `exchangeEndpointBase` lets bench harnesses point at a mock).

## Feature-catalog wiring

New category: `tools/feature-catalog/features/08-llm/` with eight L4 yamls:

1. `llm-multicloud-provider-router.yaml`
2. `llm-adapter-bedrock.yaml`
3. `llm-adapter-vertex.yaml`
4. `llm-adapter-foundry.yaml`
5. `llm-adapter-mantle.yaml`
6. `oidc-federation.yaml`
7. `oauth-refresh-lock.yaml`
8. `github-token-rotation.yaml`

Each yaml carries `evidence.code` to the new modules, `evidence.tests.unit` to the new hellgate batteries, and `monitoring: deliberate_hold` for the V2-deferred wire calls.

## Sequence

1. Phase 0 — this ADR.
2. Phase A — provider-types + provider-router.
3. Phase B — mantle-adapter + foundry-adapter graduation.
4. Phase C — oidc-federation.
5. Phase D — oauth-refresh-lock (port + 3 impls).
6. Phase E — github-token-rotation.
7. Phase F — feature catalog + final tsc/biome gate.

Each phase = one atomic commit. `bun test` + `biome check` between phases; `bun tsc` at the end.
