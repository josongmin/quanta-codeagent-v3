# ADR-0172: Foundry transport — Phase 2 (real stream via published SDK)

- Status: Accepted (closes [ADR-0163](./0163-foundry-future-ready.md) — premise was vendor-deferred; the SDK landed 2025-11-18)
- Date: 2026-05-25
- Related: [ADR-0139](./0139-llm-provider-fork.md) (Phase 1 transport fork),
  [ADR-0151](./0151-llm-provider-phase2.md) (Bedrock + Vertex Phase 2 — same SDK pattern),
  [ADR-0163](./0163-foundry-future-ready.md) (typed-stub being swapped — its
  `foundry-watch` survives, with the operational meaning re-cast as API drift)

## Context

ADR-0139 reserved the `foundry` slot in the closed `ProviderId` union;
ADR-0151 graduated Bedrock and Vertex to real wire impls and explicitly left
Foundry in Phase 1 because Anthropic had not yet shipped a first-party
`@anthropic-ai/foundry-sdk`. ADR-0163 hardened the stub with a `foundry-watch`
helper that polled the npm registry so ops would learn the day publication
landed without a code edit.

Anthropic published `@anthropic-ai/foundry-sdk@0.2.3` on 2025-11-18.
ADR-0163's "vendor-deferred" premise has been stale for three months. The
stub still throws `ProviderError("provider-unsupported")` on every
`stream()` call, and every operator carrying a Foundry workload has to
either run a forked build or wait. Phase 2 closes the gap.

## Decision

Swap the stub for a real-stream implementation, mirroring the Bedrock /
Vertex Phase 2 pattern from ADR-0151. Four parts:

### Part 1 — `foundry-adapter.ts` rewrite (real stream)

Mirror `bedrock-adapter.ts` verbatim:

1. Lazy `import("@anthropic-ai/foundry-sdk")` inside `resolveClient()`. Every
   failure mode collapses to `null` via the existing `tryImportFoundrySdk()`
   helper (preserved so the watcher and the adapter share one loader).
2. Construct `new AnthropicFoundry({ resource?, baseURL?, apiKey?,
   azureADTokenProvider? })`. Construction throw → `ProviderError("provider-misconfigured")`
   (the "auth-failed" arm; same shape as Bedrock's auth-failed mapping).
3. Open `client.messages.create({ model, max_tokens, stream:true, system?,
   thinking?, messages, tools, tool_choice? }, { signal? })`.
4. Wrap with the shared `withStreamTimeout`; decode through the shared
   `mapRawEvent`. Wire grammar is byte-identical to the public Anthropic
   path — Foundry is a pure transport substitution.

### Part 2 — `registry.ts` — auto-detect "foundry" expanded

The ADR-0139 registry detected only `ANTHROPIC_FOUNDRY_BASE_URL`. ADR-0172
adds three more signals at the same precedence layer:

- `ANTHROPIC_FOUNDRY_RESOURCE` non-empty — SDK resource-name auth path.
- `QUANTA_USE_FOUNDRY` truthy (`1` / `true` / `yes`) — quanta-native switch.
- `CLAUDE_CODE_USE_FOUNDRY` truthy — Claude-CLI mirror (refugee path).

Any one routes to Foundry. The boolean-switch grammar matches
`provider-router.ts` (the operator-facing SSOT). The legacy URL key stays
canonical for `PROVIDER_ENV_KEYS`; the additions land in a sibling
`FOUNDRY_EXTRA_ENV_KEYS` const so the existing type stays a 1:1 map.

### Part 3 — `foundry-watch.ts` premise correction

`foundry-watch` poll logic is unchanged. The operational meaning shifted:
`npmPublished:true` is now the steady state, and a `npmVersion` drift away
from the newly-exported `KNOWN_PUBLISHED_VERSION` (`"0.2.3"` at this commit)
tells ops "validate against this version before bumping". The watcher does
NOT block on a mismatch (graceful default still applies) — it just surfaces
the signal for status panels.

### Part 4 — explicit enable (Default-OFF)

The adapter is reached ONLY when one of the four env signals fires (Part 2)
or a caller explicitly resolves `providerId="foundry"`. Unset env ⇒
byte-identical legacy behavior. We deliberately reject "auto-flip on SDK
present" — that posture is too magical and does not match Claude Code's
explicit-env convention.

### Auth bundle

`ProviderAuth` (the typed credential struct) gained two slots in this ADR:

- `azureResource` — Foundry resource NAME ("acme" in
  "https://acme.services.ai.azure.com"); SDK synthesises the URL.
- `azureADTokenProvider` — caller-supplied async function returning a fresh
  Entra (formerly AAD) bearer; SDK invokes it on every request.

Existing `azureEndpoint` is now the full baseURL override; supplying BOTH
`azureResource` AND `azureEndpoint` ⇒ typed `provider-misconfigured` (SDK
documents the constraint).

## Hellgate

14 unit + 3 integration smoke cases:

- `foundry-adapter-hellgate.test.ts` (18 cases) — meta surface, misconfig
  arms, lazy-import safety, function/class parity, pre-aborted signal.
- `foundry-real-stream-hellgate.test.ts` (20 cases) — DI client factory,
  SDK ctor options, auth precedence, AccessDenied mapping, generic LLMError
  mapping, ProviderError pass-through, abort forwarding, stream-param
  shape (`model` / `max_tokens` / `stream:true`, no `batch` / `batches`),
  SDK peer-dep version pin, baseURL endpoint propagation,
  `CLAUDE_CODE_USE_FOUNDRY` + `QUANTA_USE_FOUNDRY` + `ANTHROPIC_FOUNDRY_RESOURCE`
  registry detection, empty-stream / mid-stream-cancel.
- `foundry-watch-hellgate.test.ts` (4 cases, premise updated) — `installed`
  flag now pinned by TYPE (boolean), not by VALUE — the real local resolve
  is no longer a synthetic-mock-isolatable signal.
- `tests/integration/foundry-real-cred-smoke.test.ts` (3 cases, env-gated
  on `QUANTA_FOUNDRY_SMOKE=1`) — construct / short-completion /
  abort-cancel against a live Azure endpoint.

Total: 42 unit pass / 0 fail / 86 expect() calls on the touched suite;
zero regression in adjacent provider tests (`136 pass` across
`tests/unit/llm-providers/` + `provider-router`).

## Default-OFF posture

`QUANTA_USE_FOUNDRY` / `CLAUDE_CODE_USE_FOUNDRY` / `ANTHROPIC_FOUNDRY_*`
env all unset ⇒ byte-identical existing behavior. The registry's foundry
arm only fires on an explicit signal; the legacy `@/llm/factory` path
remains untouched.

## Alternatives rejected

- **Auto-flip on SDK present.** The adapter could detect a populated
  `node_modules/@anthropic-ai/foundry-sdk` and silently route through
  Foundry. Rejected: too magical, hides operator misconfig (a stray
  `bun add` becomes a route change), and does not match Claude Code's
  explicit-env convention. Operators set ONE env var and ONE only.
- **LiteLLM `azure_anthropic` route.** Wrap a generic HTTP-passthrough
  proxy. Rejected: extra dep on LiteLLM, no first-party retry / backoff /
  Entra refresh semantics, and surfaces in observability as a generic
  HTTP error rather than a typed Foundry auth-failed.
- **Custom REST without SDK.** Re-implement the Foundry wire by hand.
  Rejected: re-implements ~5KB of protobuf-flavored body shapes plus the
  Entra `azureADTokenProvider` refresh dance. The vendor SDK is direct
  and on a free-to-use license; no reason to fork.

## SOTA matrix

| Agent | Foundry transport |
| --- | --- |
| Claude Code 2.1 | first-class (env-driven, `CLAUDE_CODE_USE_FOUNDRY`) |
| Cursor 3.2 | absent |
| Codex 0.131-alpha | absent |
| **quanta (now)** | typed-port real stream, four env signals, DI test seam |

## Follow-up

- API drift detection: `foundry-watch` `npmVersion` vs
  `KNOWN_PUBLISHED_VERSION` ⇒ surface in status panel on drift, do not
  block. Ops review on next minor bump.
- Per-resource quota / billing observability: wire `endpoint` meta surface
  into the budget-ledger so operators can attribute cost per Foundry
  resource (next sprint).
- Deprecation: when the Foundry SDK reaches `1.0` stable and the npm-drift
  signal is no longer load-bearing, retire `foundry-watch` and inline the
  loader directly. ETA unknown — track in W14+ backlog.
