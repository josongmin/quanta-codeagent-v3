# Architecture — quanta-codeagent-v3

> **TL;DR** — Lite-pragmatic **hexagonal** (ports & adapters): every major external concern sits behind a port; concrete adapters are constructed only at the composition root (`src/apps/**`); cross-slice imports are machine-enforced by Biome `noRestrictedImports` (RFC §3.1); a domain-layer **anti-regression scanner** (`tests/unit/src-no-sketchy-code.test.ts`) ratchets banned patterns. New code should mirror this — most invariants will refuse to compile or fail a test if violated.

This document is the human-facing half of the contract. Scanners and the type system enforce the rest.

---

## 1. Layering & the slice fence

Slices under `src/`, with their allowed downward dependencies (per RFC §3.1, enforced by `biome.json` `noRestrictedImports`):

| Slice | May import |
|---|---|
| `@/shared` | (none — kernel; pure types, `runtimeConfig`, `byteCompare`, `assertNever`) |
| `@/storage` | `@/shared` |
| `@/runtime` | `@/storage`, `@/shared` |
| `@/security` | `@/shared` |
| `@/patch` | `@/shared` (pure FS-grammar; receives an injected `PatchFileSystemPort`) |
| `@/rules` | `@/shared` |
| `@/observability` | `@/shared` |
| `@/stream` | `@/shared` |
| `@/llm` | `@/shared` |
| `@/memory` | `@/storage`, `@/shared` (must **NOT** reach `@/llm`; use port inversion) |
| `@/permission` | `@/shared`, `@/storage` |
| `@/mcp` | `@/shared` |
| `@/lsp` | `@/shared` |
| `@/tool` | `@/storage`, `@/runtime`, `@/shared`, `@/security`, `@/patch`, `@/rules` |
| `@/subagent` | `@/shared`, `@/storage` (composition seam, port-shaped) |
| `@/agent` | **everything below it** — `@/agent` is the only slice allowed to cross slices; this is where adapters are bridged into ports |
| `@/apps` | `@/agent` + every slice (composition root) |

**What this looks like in practice:** if `@/memory` needs to summarize via an LLM, it does NOT import `@/llm`. It defines a `Phase2Summarizer` callback type in `@/memory/consolidate/types.ts` and accepts the callback as a constructor argument. The composition root in `@/apps` wraps the `LLMPort` into a `Phase2Summarizer` at wire-up time. This is the **port inversion** pattern — used wherever the consumer slice would otherwise need to look "up" the dependency graph.

Biome rule shape (in `biome.json`):
```jsonc
"includes": ["**/src/memory/**"],        // anchored — must match the relative path
"linter": { "rules": { "style": { "noRestrictedImports": {
  "level": "error",
  "options": { "paths": { "@/llm": "Slice isolation (RFC §3.1): @/memory may only reach @/storage, @/shared" } }
} } } }
```
**Watch-out:** the `includes` matcher needs `**/src/X/**`, not bare `src/X/**` — without the prefix Biome's auto-discovery from project root silently fails to match and the rule becomes dead config. The fence is verified by transiently adding the banned import and confirming Biome trips.

---

## 2. Ports & adapters catalog

A port is named `XPort` or lives in a slice's `ports.ts`. An adapter is its concrete implementation, kept in `<slice>/adapters/` (or a `bridge.ts` when the adapter spans slices).

### `@/llm`
| Port | Definition | Adapters | Status |
|---|---|---|---|
| `LLMPort` | `src/llm/ports.ts` | `AnthropicAdapter`, `OpenAIAdapter`, decorators: `FallbackLLM`, `RetryingLLM` | PROD ×2 + DECORATOR ×2; test fakes via `RecordingLLM` |

Note: `LLMPort.StreamEvent` is **leaky-by-design** — `ThinkingBlock.signature`/`redacted` and `usage.cacheReadTokens` are Anthropic-shaped; OpenAI adapters leave them undefined. Documented; do NOT "fix" — it's the agreed asymmetry.

### `@/memory`
| Port | Definition | Adapters | Status |
|---|---|---|---|
| `PersistentStorePort` | `src/memory/ports.ts` | `InMemoryStore`, `SqliteStore` | PROD ×2 (InMemoryStore doubles as test fake) |
| `EmbedderPort` | `src/memory/types.ts` | `OpenAIEmbedder` (in `@/agent/memory-embedder` bridge), `NullEmbedder`, `CachingEmbedder` (decorator) | PROD ×1 + NULL + DECORATOR |
| `GitPort` (consolidate) | `src/memory/consolidate/git.ts` | `ChildProcessGitPort`, `NullGitPort` | PROD ×1 + NULL |
| `Phase2Summarizer` | `src/memory/consolidate/types.ts` | wired at composition (wraps `LLMPort`) | port inversion — memory never imports `@/llm` |
| `Stage1StorePort` | `src/memory/consolidate/types.ts` | sqlite-backed (`store.ts`) | PROD ×1 |

### `@/stream`
| Port | Definition | Adapters | Status |
|---|---|---|---|
| `StreamPort` | `src/stream/ports.ts` | `JsonlRecorder`, `SseStream`, `StdoutStream`, `TeeStream` + app-side: `NullStream`, `UsageTap`, `CapturingStream`×2, `LastVerifyCmdTap` | PROD ×4 + NULL/TAPS ×5 |

### `@/lsp`
| Port | Definition | Adapters | Status |
|---|---|---|---|
| `LspPort` | `src/lsp/ports.ts` | `LspClient` (base), `TypescriptAdapter`, `PyrightAdapter` | PROD ×2 (subclass adapters over `LspClient`) |

### `@/storage` & `@/patch`
| Port | Definition | Adapters | Status |
|---|---|---|---|
| `FileSystemPort` | `src/storage/service.ts` | `defaultFileSystemPort` | PROD ×1 (jail boundary) |
| `PatchFileSystemPort` | `src/patch/types.ts` | `FsJailFileSystemPort` (in `@/tool/apply-patch`) | PROD ×1 — **distinct shape from `@/storage`'s port**, renamed to avoid name collision |

### `@/permission`
| Port | Definition | Status |
|---|---|---|
| `PermissionStore` / `PermissionReader` | `src/permission/permission-store.ts` (writer/narrow-reader split) | `createPermissionStore({filePath})` is the factory; `getDefaultPermissionStore()` is the composition-only singleton |
| `ClassifierPort` | `src/permission/classifier.ts` | functional port; injected wrapper enables slice inversion (`@/permission` never imports `@/llm`) |
| `ReviewerPort` | `src/permission/types.ts` | concrete adapter: `createOnConfirmReviewerPort()` in `src/agent/reviewer-port.ts`; live dispatch wire via `AgentConfig.admissibility.reviewerPort` |

### `@/tool`
| Port / Provider | Definition | Adapters | Status |
|---|---|---|---|
| `Tool<I,O>` | `src/tool/types.ts` — `ToolCore` + optional mixins (`ToolSecurityHooks`, `ToolResultShape`, `ToolStreamingInput`) | ~13 built-in tools, gathered by `buildDefaultTools(ports)` | structural ISP grouping (R-structural) |
| `GitRunner` | `src/tool/git/types.ts` | `defaultGitRunner`, CI-bot seam | injected port |
| `LspNavProvider` | `src/tool/lsp_nav/types.ts` | `lspNavProvider()` (bridge), `nullLspNavProvider` | PROD + NULL |
| `DiagnosticsProvider` | `src/tool/diagnostics/index.ts` | `lspDiagnosticsProvider()` (bridge), `nullDiagnosticsProvider` | PROD + NULL |

### `@/agent` (composition layer)
| Seam | Definition | Status |
|---|---|---|
| `SubagentRunner` | `src/subagent/types.ts` | composition-wired via `createSubagentRunner` |
| `PlanExitPort` | `src/agent/plan-exit-flow.ts` | live seam — dispatch wires `AgentConfig.planExitPort` to `ToolContext.requestPlanExit`; current app surfaces do not ship a default adapter |
| `IdeContextProvider` | `src/agent/ide-context.ts` | concrete adapter: `FileSystemIdeContextProvider` + live integration coverage |
| `WorkMetricsSink` | `src/agent/work-metrics-collector.ts` | 1 inline producer (`apps/cli/repl.ts`); promote to a real class when reused |

### `ToolContext` — duck-typed back-channel (intentional)
Six optional fields on `ToolContext` (`depth`, `workingState`, `onShellEvent`, `requestPlanExit`, `gitWriteGuard`, ...) are **structurally mirrored** from `@/agent` types so `@/tool` never imports `@/agent`. This is the slice-isolation discipline. When adding a seam: append to the in-file SEAM REGISTRY at the top of the `ToolContext` interface; never `import type` from `@/agent` into `@/tool`.

---

## 3. Composition root rule

**Adapters are NEW'd ONLY in composition surfaces (`src/apps/**`) and in factory/helper files explicitly designated as composition (`src/llm/factory.ts`, `src/runner/assemble/**`).** Production code anywhere else must accept ports as parameters.

Wiring entry points:
- `src/llm/factory.ts` — `createLLM` / `tryCreateLLM` / `pickProvider` / `ADAPTER_REGISTRY`. The factory takes `EnvLike` so it never reads `process.env` itself.
- `src/runner/assemble/**` — surface-agnostic collaborator assembly helpers (`buildStoreCore`, `buildStreamingCore`, `buildToolingCore`, `assembleConfig`). These are composition helpers, not domain leaves.
- `src/tool/index.ts` — `buildDefaultTools(ports?: DefaultToolPorts)`. **Composition roots must call this; do NOT import the eager `defaultTools` singleton** (kept only for back-compat and tests).
- `src/permission/permission-store.ts` — `createPermissionStore({filePath})` is the constructor; `getDefaultPermissionStore()` is the composition-only singleton accessor.
- `src/apps/{cli,agent,bench,eval,probe}/**` — the per-app wiring graph.

A scanner ratchet (`no-getDefaultPermissionStore-outside-composition`) flags `getDefaultPermissionStore(` outside `permission-store.ts`, the barrel, and the documented composition-adjacent fallback in `admissibility-gate.ts`.

---

## 4. Determinism contract

The project preserves a **byte-identical replay** + **prompt-cache stable prefix** invariant. Smoke fixtures rely on it.

- **Deterministic** (must be byte-stable across runs/locales/machines):
  - The cached system-prompt prefix in `@/agent/prompt`
  - The per-turn `<system-reminder>` block (escaping + ordering)
  - All persisted JSONL transcripts compared on replay
  - The model-facing tool outputs and memory recall
- **Non-deterministic, by design** (telemetry / infra):
  - OTel span ids, turn ids in the trajectory header
  - Wall-clock log timestamps
  - Subagent worktree slugs

Rules in domain code:
- **Sort with `byteCompare` (`@/shared/byte-compare.ts`)**, never `String.prototype.localeCompare` — locale collation varies by host and breaks replay. Scanner rule: `no-locale-compare`.
- **Inject clocks**: `(opts.now ?? Date.now)()` — the established pattern across `@/agent/admissibility-gate`, `@/memory/consolidate/writer`, `@/permission/post-denial`, `@/stream/adapters/{sse,jsonl-recorder}`. Scanner rule: `no-date-now-in-domain` (scoped to `agent/` + `permission/`).
- **Mint ids via crypto only**: `crypto.randomUUID`/`randomBytes` — never `Math.random`. Scanner rule: `no-math-random`.

---

## 5. Anti-regression scanner

`tests/unit/src-no-sketchy-code.test.ts` walks every `.ts` file under `src/` and matches each line against a fixed rule set. A per-file `allowlist` is the audit trail for legitimate exceptions. Optional `scope: RegExp` narrows a rule to a slice subset.

Current rules:

| id | catches | typical fix |
|---|---|---|
| `no-process-env-outside-config` | direct `process.env` outside the SSOT | route through `runtimeConfig()` |
| `no-math-random` | `Math.random(` | use `crypto.randomBytes`/`randomUUID` |
| `no-empty-catch` | `catch {}` swallows | log via `@/shared.logger` or rethrow |
| `no-jailed-path-cast` | `as JailedPath` outside storage | use `resolveJailed` |
| `no-log-level-cast` | `as LogLevel` on raw input | use the `runtime-config` validator |
| `no-error-message-includes-routing` | `.message.includes(` for policy | branch on `LLMError.kind` |
| `no-undocumented-magic-timeout` | bare `5_000`/`30_000`/`60_000`/... | bind to `UPPER_SNAKE_CASE` const with a comment |
| `no-locale-compare` | `.localeCompare(` | use `byteCompare` from `@/shared` |
| `no-raw-number-env` | `Number(process.env...)` | use the validated parsers in `runtime-config` |
| `no-date-now-in-domain` | `Date.now(`/`new Date(` inside `agent/` + `permission/` | inject via `(opts.now ?? Date.now)()` |
| `no-getDefaultPermissionStore-outside-composition` | the service-locator accessor outside composition | accept `store: PermissionStore` as an injected parameter |

**Ratchet model:** burn-down allowlists are tolerated; new violations are not. Adding a file path to the allowlist requires a one-line justification (the audit trail). Removing all burn-down entries makes the rule actively guard the whole repo.

**How to add a rule:** append to the `RULES` array — `{id, pattern: /regex/, why, allowlist?, scope?}`. Set `scope` if the rule is slice-specific (e.g. domain-only determinism). Seed the allowlist with the current grep output so the test stays green; remove entries as each file migrates.

---

## 6. Adding a new ...

**...tool** — implement `Tool<I, O>` in `src/tool/<name>/index.ts`. Pick `hitlTier`. Add it to the `buildDefaultTools(ports)` array in `src/tool/index.ts`. Do NOT add to an external module-load const list.

**...LLM adapter** — implement `LLMPort.stream` in `src/llm/adapters/<provider>.ts`. Honor the closed `StreamEvent` union exactly. Add an entry to `ADAPTER_REGISTRY` in `src/llm/factory.ts`. Exhaustiveness `default: assertNever(x, "ToolChoice")` on every switch over the `ToolChoice` / `ContentBlock` / `RawEvent` unions.

**...agent mode** — add `src/apps/agent/mode-presets/<name>.ts` exporting the runner. The dispatch in `src/apps/agent/index.ts` is dynamic-import — no central switch to edit.

**...port** — define the interface in `<slice>/ports.ts` (or `<slice>/types.ts`). Ship at least **two** impls (a real adapter + a `null*` fake) unless you document the YAGNI exception. If only one impl exists, justify it by testability/inversion in a comment; otherwise the port is ceremony and will eventually be removed.

---

## 7. Prohibited patterns (one-line WHY)

- **`localeCompare`** — locale collation breaks byte-identical replay. Use `byteCompare`.
- **`Math.random`** — collision space too small under parallelism. Use `crypto.randomUUID`/`randomBytes`.
- **`Date.now()`/`new Date()` in `agent/` or `permission/`** — non-deterministic; inject `(opts.now ?? Date.now)()`.
- **`process.env` outside `runtime-config.ts`** — garbage values silently flip behavior. Route through `runtimeConfig()`.
- **`as JailedPath` outside storage** — brand-typed; only `resolveJailed` may mint one.
- **Empty `catch {}`** — swallowed errors are silent bugs. Log or rethrow.
- **`buildDefaultTools` skipped in apps** — composition must call the factory, not the eager singleton.
- **`getDefaultPermissionStore()` in non-composition code** — service-locator; pass `PermissionStore` explicitly.
- **`@/memory` importing `@/llm`** — slice fence; invert via `Phase2Summarizer`-style callback.
- **`FileSystemPort` collision** — `@/storage`'s is the canonical one; the patch-side is `PatchFileSystemPort`.
- **Switch over a closed union without `default: assertNever`** — adding a variant must be a compile error, not a silent fall-through.

---

## 8. Glossary

- **Port** — an interface defining what the domain needs from the outside world.
- **Adapter** — a concrete implementation of a port, isolated to the slice's edge.
- **Composition root** — the single place adapters are constructed and injected; here, `src/apps/**`.
- **Slice** — a top-level `src/<name>/` package with its own dependency budget enforced by Biome.
- **Ratchet** — a test/lint rule with a burn-down allowlist; tolerates existing debt but forbids new debt.
- **Exhaustiveness pin** — a `default: assertNever(x)` branch that turns "new variant + missed case" into a compile error.
- **Byte-identical** — output that matches across runs/machines/locales given the same inputs and injected clock.
- **Replay** — re-running a recorded LLM+tool transcript through the agent and expecting the same trajectory.

---

## 9. Open debt

- **Remaining port-adoption debt**: `PlanExitPort` still lacks a default app-surface adapter, and `ReviewerPort` only has the user-backed `createOnConfirmReviewerPort()` adapter today — higher-tier auto/guardian reviewers still need real composition wiring.
- **Multi-process permission flock**: the current `read-reconcile-merge` defends against last-write-wins clobber but not true concurrent-flush atomicity. OS lockfile is v4 scope (ADR-0046).
- **Cost dashboard `cacheHitRate` denominator**: cosmetic understatement for OpenAI (`prompt_tokens` includes cached). Not a billing bug.
- **Some `@/agent` callsites still call `Date.now()` directly** — burn-down list in the scanner rule; migrate to injected clocks per round.
- **`AgentConfig` god-container**: still too large; narrow `Pick<>` sub-configs exist (`RecoveryConfig`, `MemoryConfig`, `FeaturesConfig`, `TurnContextConfig`, `BudgetConfig`) and newer gate knobs are now grouped under `admissibility` to stop further flat-surface drift. More consumers should migrate off the full bag.

---

## 10. References

- RFC §3.1 — slice isolation
- ADR-0046 — permission v4 multi-process flock
- ADR-0029 — Reviewer integration seam
- ADR-0075 — conversation summary archive bound
- `biome.json` — `noRestrictedImports` enforcement
- `tests/unit/src-no-sketchy-code.test.ts` — ratchet definitions
- `tests/unit/invariant-default-tools-wired.test.ts` — `buildDefaultTools` usage invariant
- `tests/unit/invariant-session-roundtrip.test.ts` — `ContentBlock` round-trip exhaustiveness
