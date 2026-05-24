# ADR-0163: Foundry transport — future-ready scaffold + npm watcher

- Status: Accepted
- Date: 2026-05-24
- Related: [ADR-0139](./0139-llm-provider-fork.md) (Phase 1 transport fork),
  [ADR-0151](./0151-llm-provider-phase2.md) (Bedrock + Vertex real streams)

## Context

ADR-0139 reserved the `foundry` slot in the closed `ProviderId` union and
shipped a typed stub: the adapter constructed cleanly, the registry routed by
`ANTHROPIC_FOUNDRY_BASE_URL`, but every `stream()` call threw
`ProviderError("provider-unsupported")`. ADR-0151 graduated Bedrock and Vertex
to real wire impls and explicitly left Foundry in Phase 1 because Anthropic
had not (and has not, as of 2026-05-24) published a first-party
`@anthropic-ai/foundry-sdk` package on npm.

The Phase 1 stub gets the closed-union typing right, but it does NOT prepare
the seam for the inevitable swap. Three concrete gaps:

1. **No lazy-import scaffold.** The Bedrock / Vertex adapters fold the
   `await import(...)` failure into a typed `provider-missing-dependency`;
   the Foundry stub throws unconditionally without ever looking at the
   package. The day the SDK ships, the stub's swap-to-real shape is
   undefined.
2. **No "is it published?" probe.** Operators wiring a multi-transport CLI
   need to know whether the Foundry path will work — today the only signal
   is "try it and watch it throw". No status UI or pre-flight check has the
   data it needs to surface "available" vs "scaffolded, not yet shipped".
3. **No shape-change defense.** When the SDK does ship, the export shape is
   not known in advance (`AnthropicFoundry` class? `default` export? something
   else?). Without a structural check, the first version that exports an
   unexpected surface crashes the adapter rather than surfacing a typed
   diagnostic.

## Decision

### Part 1 — Adapter scaffold (`src/llm/providers/foundry-adapter.ts`)

The file is rewritten around three new symbols, plus the legacy class
preserved for back-compat with `registry.ts`:

1. **`tryImportFoundrySdk(): Promise<FoundrySdkModule | null>`** — dynamic
   `import("@anthropic-ai/foundry-sdk")` wrapped in try/catch. Returns `null`
   on every failure mode (package missing, broken install, top-level throw).
   The caller's contract is "did we load it?", not "why not?". Mirror of
   the lazy-import discipline in `bedrock-adapter.ts` / `vertex-adapter.ts`,
   except the failure is the production arm today, not the exception.
2. **`isFoundryAdapterReady(): Promise<boolean>`** — `true` only when both
   the import succeeds AND `mod.AnthropicFoundry ?? mod.default` is a
   callable constructor. Three distinct states:
   - `tryImportFoundrySdk()` returns `null` ⇒ `false` (SDK absent).
   - Loaded but no expected ctor ⇒ `false` (SDK shape changed).
   - Loaded + ctor ⇒ `true` (SDK ready; `stream()` still throws — see below).
3. **`foundryProviderAdapter(config: ProviderConfig): LlmProvider`** —
   returns a fresh `LlmProvider` per call (no caching). The `stream()` it
   returns walks four arms:
   - Caller signal pre-aborted ⇒ typed `provider-unsupported` with
     "aborted" in the message, BEFORE any SDK touch. Cancel-before-stream
     semantics must hold without the SDK delegating.
   - SDK import returns `null` ⇒ `provider-unsupported` with "not yet
     published" + the canonical npm URL. This is the reachable production
     arm TODAY.
   - SDK loaded but ctor undefined ⇒ `provider-missing-dependency` with
     "shape changed" + model/endpoint context. Distinguishes "SDK absent"
     from "SDK present but broken".
   - SDK + ctor present ⇒ `provider-unsupported` with "scaffolded but
     follow-up". Structural symmetry with Bedrock/Vertex Phase 1 → 2:
     the swap to real wire is a single-file follow-up edit.

The legacy `FoundryProviderAdapter` class is preserved and rewired as a
thin wrapper over `foundryProviderAdapter` so `registry.ts` (which calls
`new FoundryProviderAdapter(config)`) and the `@/llm/providers` barrel stay
byte-identical at the import surface.

### Part 2 — Availability watcher (`src/llm/providers/foundry-watch.ts`)

A pure helper: `checkFoundrySdkAvailability(opts?)` returns

```
interface FoundrySdkAvailability {
  installed: boolean      // local resolve (isFoundryAdapterReady)
  npmPublished: boolean   // HTTP 200 on registry.npmjs.org/@anthropic-ai/foundry-sdk
  npmVersion?: string     // dist-tags.latest if response shape matches
}
```

The helper NEVER throws. Worst case is `{installed:false, npmPublished:false}`
(omitting `npmVersion` per exactOptional discipline — absence means
"unknown", not "version undefined"). Network failure, non-200, malformed
JSON, missing global `fetch` — all collapse into the graceful default.

The `fetcher` parameter is the single seam used by tests; production code
falls back to global `fetch` (Node 18+) or skips the network probe if
global fetch is absent.

### When the SDK ships — follow-up flow

The swap is a single-file diff against `foundry-adapter.ts`:

1. `tryImportFoundrySdk` keeps its current shape (still catches every
   failure into `null` — production environments without the optional
   install must keep working).
2. `isFoundryAdapterReady` returns `true` on the matching environments.
3. The `foundryProviderAdapter` "SDK + ctor present" arm flips from a
   `provider-unsupported` throw to a real wire path mirroring
   `vertex-adapter.ts` (resolve client, open `messages.create({stream:true})`,
   thread `mapRawEvent`, wrap with `withStreamTimeout`).
4. The hellgate suite's HELL-C2/HELL-D1 graduate from "expect throw" to
   "expect real `StreamEvent` shape via DI'd fake client" — same pattern
   ADR-0151 used for the Bedrock/Vertex graduation.

No call-site touches. The registry, barrel, and any consumer that imported
`FoundryProviderAdapter` from `@/llm/providers` keep working unchanged.

## Hellgate

`tests/unit/llm-providers/foundry-adapter-hellgate.test.ts` (13 cases,
labeled HELL-A1..D3) covers:

- **A. Meta** — providerId fixed, model echoed, endpoint config survives
  construction.
- **B. SDK absent (live arm)** — `isFoundryAdapterReady()` false; stream
  throws `provider-unsupported` with "not yet published" + the npm URL
  + the package name.
- **C. Wrapper + signal + endpoint context** — class wrapper preserves
  surface, delegates to function; pre-aborted signal short-circuits BEFORE
  SDK touch; model/endpoint context flows through into the typed throw.
- **D. Lazy-import safety** — `tryImportFoundrySdk()` returns `null` today
  (proves the catch-everything contract); multiple `stream()` calls fail
  fast with identical typed errors (no broken-state caching); wrong
  providerId throws `provider-misconfigured` at construction.

`tests/unit/llm-providers/foundry-watch-hellgate.test.ts` (4 cases) covers:

- **W1** — npm 404 ⇒ both flags false, `npmVersion` key absent.
- **W2** — npm 200 with `dist-tags.latest` ⇒ `npmPublished:true` + version
  populated; `installed` still false (local resolve still fails).
- **W3** — caller-supplied fetcher is invoked, target URL is the canonical
  npm registry endpoint.
- **W4** — fetcher throw collapses to graceful default (no rethrow).

Total: 17 hellgate tests / 44 expect calls.

## Default-OFF

- `ANTHROPIC_FOUNDRY_BASE_URL` env var triggers the registry's `foundry`
  arm (unchanged from ADR-0139). Without that env var, the resolver picks
  `default` and no part of this slice is reached.
- No top-level import of `@anthropic-ai/foundry-sdk`. The dynamic-import
  catches every failure; bundlers and static analyzers see no dependency
  on a package that does not exist on npm yet.
- The `@/llm/factory` legacy path is untouched. Existing callers that
  build `Anthropic` directly stay byte-identical.

## SOTA matrix (Foundry slot, 2026-05-24)

| Concern              | Phase 0 (pre-ADR) | Phase 1 (ADR-0139 stub) | Phase 1.5 (THIS ADR)           | Phase 2 (when SDK ships) |
|----------------------|-------------------|--------------------------|--------------------------------|--------------------------|
| Adapter constructs   | n/a               | yes                      | yes                            | yes                      |
| Lazy-import scaffold | n/a               | NO (unconditional throw) | YES (try/catch → null)         | YES (same)               |
| Typed error code     | n/a               | `provider-unsupported`   | `provider-unsupported` + URL   | n/a (real stream)        |
| Shape-change defense | n/a               | n/a                      | YES (`provider-missing-dep`)   | YES (same)               |
| npm publish watcher  | n/a               | NO                       | YES (graceful fail)            | YES (status: published)  |
| Pre-abort honor      | n/a               | n/a                      | YES (signal pre-aborted)       | via SDK signal           |
| Hellgate coverage    | 0                 | 0                        | 17 (13 adapter + 4 watcher)    | +real-stream battery     |
| Call-site churn      | n/a               | 0                        | 0 (registry/barrel unchanged)  | 0 (single-file swap)     |

## Alternatives rejected

- **Hand-rolled `fetch` against the Azure AI Foundry endpoint.** The wire
  grammar Anthropic will use over Foundry is not yet public. Pinning a
  guessed shape today would lock us into the wrong types when the official
  lib ships, and the unwind would touch every caller. The cost of waiting
  is zero (the `provider-unsupported` throw is the documented behavior);
  the cost of being wrong is days of follow-up edits.
- **Eager top-level import (not in try/catch).** Some bundlers (esbuild,
  Vite) will emit a hard error at build time when a top-level import
  references a non-existent package, even if it is gated by a runtime
  branch. The dynamic-import-in-try-catch pattern is the only one that
  survives both static analysis and runtime resolution.
- **`Promise.race` against a timeout in the watcher.** The caller's
  `fetcher` is the right place for timing policy — production callers can
  pass `fetch` wrapped in `AbortSignal.timeout(ms)`. Forcing a timeout
  inside the helper would either be too aggressive (offline mode false
  positives) or pointless (callers who care wrap their own).
- **Caching the import result.** The lazy-import is cheap (Node caches
  module resolution at the loader level). Caching at the adapter layer
  would mean a broken install at boot stays broken until restart — exactly
  the opposite of what an operator wants when they `npm install` the SDK
  mid-session.

## Follow-up

- When `@anthropic-ai/foundry-sdk` ships on npm: graduate the "SDK + ctor
  present" arm to real wire impl per ADR-0151's Bedrock/Vertex template.
  Hellgate `HELL-C2/HELL-D1` move from "expect throw" to "expect real
  `StreamEvent` shape via DI'd fake client". No call-site touches.
- Optional: wire `checkFoundrySdkAvailability` into the status UI (CLI
  `/status` skill, Tauri panel) so operators see the published/installed
  matrix without invoking the adapter.
- Optional: surface the watcher's poll behind a `--check-providers` CLI
  flag for the v3 install audit slice.
