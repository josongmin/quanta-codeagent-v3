# ADR-0246: Bridge Attestation — remote permission preflight + STS token

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0245. Per `adr-collision-policy-2026-05-25` next-free 0246 (latest landed in main is 0241; 0242-0245 reserved for parallel tracks observed in the cluster window).
- **Related ADRs**: ADR-0158 (conversation-checkpoint LRU — provides local rollback surface that pairs with remote attestation), ADR-0166 (subagent conversation seed replay — establishes the `kind/result-shape` envelope contract this slice mirrors for STS scope), ADR-0050 (trust-scope registry — local-grant cousin to the remote-grant `prompt-user` arm), ADR-0078 (security module barrel — sibling slice plane).
- **References**:
  - `src/security/bridge-attest/types.ts` (closed AttestRequest / AttestResult / StsToken / AttestError shapes + 9-event union)
  - `src/security/bridge-attest/port.ts` (BridgeAttestor port — preflight / mintToken / verify / revoke)
  - `src/security/bridge-attest/default-attestor.ts` (local-policy-table HMAC-SHA256 adapter)
  - `src/security/bridge-attest/headless-stub.ts` (deny-all stub for headless / CI)
  - `src/security/bridge-attest/index.ts` (barrel — opt-in re-exports only)
  - `tests/unit/security/bridge-attest-hellgate.test.ts` (15 adversarial cases — see Hellgate section)
  - `tools/feature-catalog/features/03-permission-safety/bridge-attestation.yaml`

## Context

Claude Desktop's `onBridgePermissionPreflight` ships a single round-trip the host calls **before** wiring a remote-tool invocation: the bridge replies with `allow | deny | prompt-user`, and on `allow` mints a short-lived STS token scoping the subsequent call. The 9 lifecycle events (preflight-requested / -granted / -denied / token-minted / -used / -expired / -revoked / preflight-error / attest-audit) make the entire decision auditable end-to-end.

quanta today ships ADR-0050 trust-scope (local grant memory) and ADR-0158/0166 checkpoints (local rollback), but has **no remote-side preflight + token surface**. Tools that need to consult a remote policy (org allowlist API, Tauri bridge, MCP server with its own RBAC) currently must invent their own ad-hoc envelope, with no event-stream contract for observers.

## Decision

A leaf slice under `src/security/bridge-attest/` with:

### A. Closed-port surface (`port.ts`)

```ts
interface BridgeAttestor {
  preflight(req: AttestRequest): Promise<AttestResult>
  mintToken(scope: string, ttlMs: number): Promise<StsToken>
  verify(token: string, scope: string): Promise<boolean>
  revoke(token: string): Promise<void>
}
```

3-arm `AttestResult` discriminated union: `{ kind: "allow", stsToken }` | `{ kind: "deny", reason }` | `{ kind: "prompt-user", reason? }`. Adding a 4th arm without exhaustive-switch wiring is a TS error at compile time.

### B. Token format

`base64url(HMAC-SHA256(secret, "${scope}|${expiresAt}|${nonce}"))`

- `secret` is read from constructor opt; absent → falls back to a literal `"test-secret"` string with a `logger.warn` so unit tests and headless smoke do not panic but a real deployment is visibly mis-configured.
- `expiresAt` is absolute epoch-ms; verify rejects when `Date.now() > expiresAt` (clock injected for testability via `clock?: () => number`).
- `nonce` is 16 bytes of `randomBytes` — guarantees collision-free tokens even at identical (scope, expiresAt).
- Scope is opaque string (caller convention: `"tool:<name>:action:<id>"`).

### C. 9-event stream

`AttestEvent` closed union — `preflight-requested | preflight-granted | preflight-denied | token-minted | token-used | token-expired | token-revoked | preflight-error | attest-audit`. Each event carries `{ requestId, at }` minimum, plus arm-specific payload (e.g. `granted` carries `stsToken.scope`, `denied` carries `reason`). `attest-audit` is the catch-all envelope for downstream sinks (jsonl recorder / OTel) that want one stream per attestation lifecycle.

### D. Default-attestor adapter

Pure in-process implementation: policy-table `Record<action, "allow" | "deny" | "prompt-user">` (default `"prompt-user"` on miss) + HMAC-SHA256 via `node:crypto`. Plane-discipline: imports `node:crypto` ONLY — no `@/agent`, no `@/permission`, no `@/observability`.

### E. Headless stub

`headlessStubAttestor()` returns `{ kind: "deny", reason: "headless: no remote attestor" }` from `preflight`, `mintToken` throws `AttestError("headless")`. Lets CI / batch modes load the barrel without a real bridge configured.

## Hellgate

`tests/unit/security/bridge-attest-hellgate.test.ts` — 15 adversarial cases:

1. `preflight allow` → returns `kind:"allow"` + non-empty stsToken
2. `preflight deny` → returns `kind:"deny"` + non-empty reason
3. `preflight prompt-user` → returns `kind:"prompt-user"`, no token leak
4. `mintToken + verify valid` → roundtrip true
5. `verify expired` → false (ttl elapsed via injected clock)
6. `verify tampered` → flipped byte fails MAC
7. `revoke` → subsequent verify returns false
8. `ttl 0ms` → token already expired on mint
9. `scope mismatch` → verify("tok", "other-scope") false
10. 9-event stream emitted in correct order across full preflight→mint→use→expire→revoke flow
11. default-OFF: barrel import alone produces no side effects (byte-identical state)
12. AttestResult 3-arm exhaustive: removing one arm in test fixture is a TS error
13. 1000 tokens minted at identical (scope, expiresAt) all distinct (nonce collision-free)
14. secret 미주입 → `"test-secret"` fallback works + logger.warn fired exactly once
15. `preflight-error` arm: throwing inner policy table surfaces as `{kind:"deny", reason}` + emits `preflight-error` event (NO-THROW public surface)

## Configurable knobs

- `defaultAttestor({ secret?, policyTable?, clock?, onEvent? })` — all optional with documented defaults.
- `secret` default `"test-secret"` + warn (NEVER silently empty).
- `policyTable` default `{}` (every action → `"prompt-user"`).
- `clock` default `Date.now`.
- `onEvent` default no-op (default-OFF — no consumer wired in dispatch/loop).

## Default-OFF invariants

- Nothing under `src/agent/`, `src/permission/`, `src/scheduler/`, `src/runtime/` imports this slice. Confirmed by absence from those slice barrels.
- `import { defaultAttestor } from "@/security/bridge-attest"` alone produces no `onEvent` calls, no token mints, no policy lookups.
- Headless mode loads the barrel via `headlessStubAttestor` which deny-all's `preflight` and throws on `mintToken` — fail-closed by construction.

## Consequences

- A remote-tool slice (future MCP `bridge_attest_preflight`, Tauri sidecar `onBridgePermissionPreflight` wrapper) now has a single typed seam to consume.
- The 9-event stream gives jsonl-recorder / OTel a closed enum to subscribe to without per-call instrumentation.
- HMAC-SHA256 + nonce is the floor; the deliberate-hold list calls out future migration paths.

## Deliberate hold (NOT in this ADR)

- Network protocol (gRPC / WebSocket / Tauri IPC channel) — out of scope. This slice produces tokens; transport is the caller's choice.
- JWT / JWKS / asymmetric signing — current HMAC is symmetric for round-trip simplicity. Migration to asymmetric is a future ADR.
- OS-keyring secret backend — `secret` is currently a constructor opt. Keyring integration mirrors ADR-0050's deferred OS-keyring path.
- Cross-process token cache — single-process only; multi-process replay protection is future work.
