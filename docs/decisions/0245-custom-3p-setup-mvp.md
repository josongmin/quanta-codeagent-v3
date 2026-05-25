# ADR-0245 — Custom 3P Setup MVP (5 core method + lifecycle)

Status: Accepted (2026-05-25)
Renumbered from 0244 → 0245 (next-free; per `adr-collision-policy-2026-05-25`
memory entry, our slice defers to any sibling track that lands at the same
integer first).

## Context

Claude Desktop 1.7196 ships a 24-method `Custom3pSetup` IPC namespace that
lets users wire third-party providers (custom MCP servers, alternate LLM
endpoints, BYO-key adapters) into the app without a code change. The full
namespace is intentionally large — it bundles OAuth discovery, dynamic
client registration, refresh-token rotation, per-host health, telemetry
opt-in, and a typed lifecycle. Memory entries
`claude-desktop-1-7196-catalog` and `claude-desktop-tier0-absorption-r2`
both flagged the 24-method surface as Tier-0 but explicitly held the
**full** absorption on the grounds that 19 of those methods reduce to a
combination of slices we already shipped:

| Existing slice | Claude method covered |
|---|---|
| ADR-0151 OAuth discovery (RFC 8414) | `discoverOAuth`, `validateIssuer`, `probeOAuthMetadata` |
| ADR-0151 Dynamic OAuth registration (RFC 7591) | `registerOAuthClient`, `rotateClientSecret` |
| ADR-0160 REST connector catalog + 24h cache | `listCatalog`, `refreshCatalog`, `getCatalogEntry` |
| ADR-0160 Token rotation + refresh lock | `rotateToken`, `revokeToken`, `getTokenExpiry` |
| ADR-0163 Multi-cloud + OIDC federation | `setProviderEndpoint`, `validateFederation` |
| ADR-0162 Plugin isolated spawn | (out of scope — connector is not a process host) |

That leaves **five** methods that have no equivalent in the current code
base. They are the methods that actually let a user say "I have a
provider; remember it, let me update it, drop it, check if it is healthy,
list what I told you about" — i.e. the **registry of user-declared 3p
providers** itself.

Until those five exist the absorbed OAuth + REST registry + token
rotation surfaces have no user-facing entry point: the catalog flows
top-down from the server and the OAuth flow flows top-down from the
issuer. Nothing in the slice can be authored bottom-up by a person who
just installed a new provider.

## Decision

Ship the **5 MVP methods** + a typed lifecycle, behind a closed port,
default-OFF, additive to `src/connectors/`. The 19 methods covered by
existing slices are explicitly **not re-implemented** — the surface is
the missing 5.

```text
src/connectors/custom-3p/
  types.ts              # ProviderId, ProviderKind, ProviderSpec, HealthResult, LifecycleState
  port.ts               # Custom3pRegistry surface (5 method + lifecycle accessor)
  in-memory-registry.ts # canonical impl (Map + 4-state lifecycle FSM)
  jsonl-store.ts        # ~/.quanta/connectors/custom-3p.jsonl (0600, dir 0700)
  headless-stub.ts      # no-op impl for surfaces that opt out (default-OFF)
  health-probe.ts       # pure: spec → HealthResult (no I/O — caller injects)
  index.ts              # public barrel
```

### Port

```typescript
export type ProviderId = string & { readonly __brand: "ProviderId" }
export type ProviderKind = "mcp" | "llm"           // closed — exhaustive switches forced

export type LifecycleState =
  | "draft"        // register() called, never probed
  | "configured"   // update() called after first probe
  | "healthy"      // last probe returned ok
  | "failing"      // last probe returned a typed failure

export interface ProviderSpec {
  readonly id: ProviderId
  readonly displayName: string
  readonly kind: ProviderKind
  readonly endpoint: string          // URL — http(s) for llm, ws/stdio for mcp (validated by kind)
  readonly auth: "oauth" | "apiKey" | "none"
  readonly tags?: ReadonlyArray<string>
}

export interface HealthResult {
  readonly verdict: "ok" | "dns-fail" | "http-fail" | "auth-fail" | "timeout"
  readonly checkedAt: number         // wall-clock ms
  readonly latencyMs?: number
}

export interface Custom3pRegistry {
  register(spec: ProviderSpec): Promise<void>     // throws on duplicate id
  update(id: ProviderId, patch: Partial<ProviderSpec>): Promise<void>  // throws on unknown id
  remove(id: ProviderId): Promise<void>           // throws on unknown id
  health(id: ProviderId): Promise<HealthResult>   // throws on unknown id
  list(): Promise<ReadonlyArray<ProviderSpec>>
  /** Inspect last-known lifecycle state — exhaustive on `LifecycleState` arm. */
  lifecycle(id: ProviderId): Promise<LifecycleState | undefined>
}
```

### Lifecycle FSM

```
draft ──update()──▶ configured ──health() ok──▶ healthy
   │                    │                          │
   │                    └──health() fail──▶ failing┘ (re-entry on any health() call)
   └──health() ok──▶ healthy                     │
   └──health() fail──▶ failing ◀─────────────────┘
```

`register()` always lands at `draft`. `update()` advances draft → configured.
`health()` advances → healthy | failing based on probe verdict. `remove()`
drops the row entirely (no terminal state).

### Persistence

`jsonl-store.ts` — `~/.quanta/connectors/custom-3p.jsonl`, one
`ProviderSpec` per line + a trailing `\n`. Parent dir created with mode
`0700`; file written with mode `0600`. The store is a wrapper around an
`InMemoryCustom3pRegistry`: it loads on first call, applies every
mutation through the in-memory impl, then writes the full snapshot back
(append-only would leak stale rows on update/remove — explicit
write-snapshot is the honest contract). Concurrency: single-process,
single-flight — no inter-process lock (caller's contract).

### Headless stub

`headless-stub.ts` returns `[]` from `list()`, `undefined` from
`lifecycle()`, and **throws `unsupported`** from every mutator. Surfaces
that have no user concept of "wire your own provider" (bench / ci-bot
/ replay) use this default to make the absent capability load-bearing
rather than silently silent.

### Health probe

`health-probe.ts` is **pure**: `(spec, deps) → Promise<HealthResult>`
where `deps = { fetchPort, dnsPort, clockPort }`. No top-level imports
of `globalThis.fetch` or `node:dns`. Mirrors the
`availability-prober.ts` discipline.

## What is NOT in scope (deliberate hold)

- OAuth authorization-code flow with browser redirect (Phase 2;
  hooks into existing `src/auth/chatgpt-oauth/` once the surface ships)
- The 19 methods reachable via composition of existing slices
- Server-driven push catalog merge (`src/connectors/rest-registry.ts`
  already covers this — the custom-3p registry stays separate so a
  user-declared provider can override a server-supplied one)
- Concurrent multi-process write coordination (single-flight contract)
- Telemetry opt-in metadata (separate ADR; observability slice owns the
  emit surface)

## Constraints (architecture)

- `exactOptionalPropertyTypes`: omit absent optionals, never set
  `undefined` explicitly.
- closed-port: every dependency (fs / clock / fetch / dns) is injected.
- default-OFF: byte-identical to today when no caller constructs a
  `Custom3pRegistry`. `src/connectors/index.ts` does **not** re-export
  custom-3p — callers import `@/connectors/custom-3p` directly so the
  bundle stays unchanged for surfaces that don't opt in.
- Slice fence: lives under `src/connectors/custom-3p/`. Touches
  `src/agent/`, `src/memory/`, `src/scheduler/`, `src/observability/`,
  `src/tool/`, `src/runtime/`, `src/realtime/`, `src/radar/`, `src/mcp/`,
  `src/media/`: **NONE**.

## Tests (hellgate — 15 cases)

`tests/unit/connectors/custom-3p-hellgate.test.ts`:

1. `register` → `list` round-trip
2. `register` → `update` → `list` round-trip
3. `register` → `remove` → `list` round-trip
4. `health` returns `ok` for healthy spec (fake probe)
5. duplicate `register(id)` throws typed error
6. `update(unknownId)` throws typed error
7. `remove(unknownId)` throws typed error
8. `health(unknownId)` throws typed error
9. jsonl-store: persistence round-trip across two registry instances
10. jsonl-store: file mode is `0600` (dir mode is `0700`)
11. 4-state lifecycle exhaustive — draft → configured → healthy → failing
    reachable
12. in-memory vs jsonl parity — same op sequence produces same `list()`
13. `ProviderSpec` returned from `list()` is structurally frozen
    (mutation does not leak)
14. default-OFF: not constructing any registry leaves
    `src/connectors/index.ts` byte-identical export shape
15. 100-provider perf: register + list completes in under 50ms (bound
    is generous; the only point is no accidental O(n²))

Plus a 16th secondary battery: `ProviderKind` 2-arm exhaustive (the
typed switch helper rejects unknown kinds at type-level).

## Catalog

- `tools/feature-catalog/features/09-integration/custom-3p-setup-mvp.yaml`
- `adrs: [245, 151, 163]` — 0151 is the OAuth slice this slot composes
  with; 0163 is the multi-cloud + GitHub rotation slice that supplies
  the `auth = "oauth"` rotation primitive.
- `deliberate_hold`: OAuth full flow + 19 additional methods.

## Wire-up

Out of scope this ADR. Wire-up is a separate slice that:

1. Adds `custom3pRegistry?: Custom3pRegistry` to `AgentConfig`
   (`src/agent/types.ts`).
2. Composes with `discoverOAuthEndpoints` + `registerOAuthClient` at the
   surface (CLI command `/connector add` and Web settings panel).
3. Subscribes to `health()` result in the observability emit channel.

The MVP ships the closed port + canonical impl + persistence + hellgate;
the rest is downstream.
