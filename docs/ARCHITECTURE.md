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

### 1.1 Machine-enforced contract is a DENYLIST (SSOT)

The table above is an **allowlist**-shaped summary of the RFC §3.1 intent (and mirrors the per-path `noRestrictedImports` rules in `biome.json`). The **actual machine-enforced slice boundary** is a **denylist**, driven by an AST scanner test suite. Its single source of truth is:

> **`tests/unit/_arch/slice-boundary-configs.ts`** — `SLICE_BOUNDARY_CONFIGS`.

Each registered slice declares a `denyImports` list; **anything not denied is permitted** (open-by-default), which is the inverse shape of the table above. Consumed by the `*-slice-boundary.test.ts` suites via `registerSliceBoundarySuite` / the scanner in `tests/unit/_arch/slice-boundary-scanner.ts`. Semantics to know when reading a config:

- **`import type` is invisible** to the scanner — type-only cross-slice references are always allowed (they erase at compile time). Only **VALUE** imports can trip a deny rule.
- **Self-prefix is stripped** — a slice may always import its own sub-modules even though the shared deny constant lists its own `@/<slice>` prefix.
- **`allowImports`** are reviewed carve-outs: specifiers that match a `denyImports` prefix but are explicitly re-permitted (documented in-line in the config).
- **`surfaceIsolationOnly: true`** means the slice runs ONLY the surface-isolation check (must not import/type-reference `apps/**`) and is otherwise exempt from the library-purity deny — used for the Layer-2 composition seams `@/host`, `@/sdk`, `@/kernel`.
- `envAllowFiles` / `stdioAllowFiles` / `consoleAllowFiles` / `requireSliceBarrel` are orthogonal purity carve-outs, not import-deny rules.

Two shared deny constants are reused across slices:

- **`PEER_LIBRARY_DENY`** — the peer Layer-0/1 library set: `@/agent, @/tool, @/mcp, @/rules, @/migration, @/session, @/subagent, @/skill, @/observability, @/llm, @/memory, @/storage, @/permission, @/lsp, @/stream` (the self-prefix is dropped per slice).
- **`LAYER2_DENY`** — the Layer-2 composition/surface set no lower slice may up-import: `@/runner, @/host, @/ipc, @/apps`.

**Slices registered in the SSOT but NOT shown in the §1 table above** (with their actual deny rules — mirror of `slice-boundary-configs.ts`, do not edit here without editing there):

| Slice | Enforced deny rule (from `SLICE_BOUNDARY_CONFIGS`) |
|---|---|
| `@/auth` | `PEER_LIBRARY_DENY` |
| `@/git` | `PEER_LIBRARY_DENY` + `LAYER2_DENY` (pure leaf; only runtime dep `@/shared`) |
| `@/browser` | `PEER_LIBRARY_DENY` + `LAYER2_DENY` (pure leaf; only `@/shared`) |
| `@/scheduler` | `PEER_LIBRARY_DENY` + `LAYER2_DENY` (pure leaf; only `@/shared`) |
| `@/stream` | `PEER_LIBRARY_DENY` + `LAYER2_DENY` (leaf; only `@/shared`) |
| `@/reactor` | `PEER_LIBRARY_DENY` + `LAYER2_DENY`; carve-out: `import type { AgentOutcome } from "@/agent"` (type-only, allowed) |
| `@/side-agent` | `PEER_LIBRARY_DENY` + `LAYER2_DENY`; `allowImports`: `@/agent/side-agent-runner`, `@/agent/subagent-runner`, `@/llm`, `@/llm/replay`, `@/tool` (worker composition-root carve-out) |
| `@/patch` | `PEER_LIBRARY_DENY` (pure leaf; OTel binding lives in the `apply_patch` tool root) |
| `@/security` | `PEER_LIBRARY_DENY` + `@/auth` |
| `@/rules` | `PEER_LIBRARY_DENY` + `@/auth` |
| `@/storage` | `PEER_LIBRARY_DENY` (includes `@/tool` — the storage→tool inversion guard) |
| `@/mcp` | `@/agent, @/tool, @/rules, @/migration, @/session, @/subagent, @/skill, @/observability, @/llm, @/memory, @/storage, @/permission, @/lsp, @/stream` |
| `@/skill` | same peer set as `@/mcp` minus `@/tool` (i.e. `@/agent, @/mcp, @/rules, @/migration, @/session, @/subagent, @/observability, @/llm, @/memory, @/storage, @/permission, @/lsp, @/stream`) |
| `@/session` | `@/agent, @/mcp, @/rules, @/migration, @/subagent, @/skill, @/observability, @/permission, @/lsp, @/stream, @/memory` |
| `@/subagent` | peer set incl. `@/agent, @/mcp, @/rules, @/migration, @/session, @/skill, @/observability, @/llm, @/memory, @/storage, @/permission, @/lsp, @/stream` |
| `@/agent` | `@/migration` only (agent is the cross-slice bridge; see table above) |
| `@/tool` | `@/agent, @/mcp, @/rules, @/migration, @/memory, @/session, @/subagent, @/skill, @/observability, @/permission, @/lsp, @/stream`; `allowImports`: `@/observability/coverage`, `@/observability/patch-trace` |
| `@/llm` | `PEER_LIBRARY_DENY`; `allowImports`: `@/memory/history-sanitization` (typed port) |
| `@/memory` | `PEER_LIBRARY_DENY` |
| `@/permission` | `@/agent, @/tool, @/mcp, @/rules, @/migration, @/memory, @/session, @/subagent, @/skill, @/observability, @/llm, @/lsp, @/stream, @/storage` |
| `@/observability` | `PEER_LIBRARY_DENY` |
| `@/runner` | `@/rules, @/patch, @/migration` |
| `@/ipc` | `@/rules, @/patch, @/migration` |
| `@/host`, `@/sdk`, `@/kernel` | `surfaceIsolationOnly` — no import-deny; only the "must not import `apps/**`" fence |

**Not (yet) in the SSOT:** several `src/` slices have **no** `SLICE_BOUNDARY_CONFIGS` entry, so this scanner suite enforces **no** import-deny for them today — e.g. `activity`, `codemode`, `retrieval`, `workflow`, `runtime`, `radar`, `realtime`, `remote`, `media`, `voice`, `ui`, `protocol`, `connectors`, `integrations`, `plugin-isolation`, `capability`, `artifact`, `config`, `migration`. Adding a boundary config for one of these is the mechanism to bring it under the fence (see §6). This list is descriptive of the SSOT's current coverage, not a statement that those slices have no layering intent.

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
| `GuardedPatchFileSystemPort` | `src/tool/patch-mutation-safety.ts` | `FsJailFileSystemPort` | Tool-boundary extension adding jailed stat for shared Git/stale preflight and post-commit baseline refresh |

### `@/permission`
| Port | Definition | Status |
|---|---|---|
| `PermissionStore` / `PermissionReader` | `src/permission/permission-store.ts` (writer/narrow-reader split) | `createPermissionStore({filePath})` is the factory; `getDefaultPermissionStore()` is the composition-only singleton |
| `ClassifierPort` | `src/permission/classifier.ts` | functional port; injected wrapper enables slice inversion (`@/permission` never imports `@/llm`) |
| `ReviewerPort` | `src/permission/types.ts` | concrete adapters: `createOnConfirmReviewerPort()` + classifier-backed auto reviewer + guardian subagent adapter; live dispatch wire via `AgentConfig.admissibility.reviewerPort` |

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
| `PlanExitPort` | `src/agent/plan-exit-flow.ts` | concrete CLI adapter: `createCliPlanExitPort()` in `src/apps/cli/repl/session-host-ports.ts`; live dispatch wire via `AgentConfig.planExitPort` |
| `UserInputPort` | `src/tool/types.ts` (`UserInputRequester`) | concrete CLI adapter: `createCliUserInputPort()` in `src/apps/cli/repl/session-host-ports.ts`; live dispatch wire via `AgentConfig.userInputPort` |
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

### 3.1 Thin surface rule (ADR-0303)

Surfaces are host adapters, not alternate engine homes.

- `src/apps/cli/**` may own terminal I/O, TTY/raw-mode handling, slash/UI rendering, and host-owned ports. Reusable turn/session semantics belong in `@/runner/*` or lower slices.
- `src/apps/agent/**` is the host-neutral launcher surface. It must not grow into a backdoor that reuses CLI runtime ownership by importing `src/apps/cli/**`.
- Thin does not mean render-only. A surface may still own prompt UX, status chrome, slash dispatch, argv/HTTP/IPC parsing, and concrete host bindings. What it may not own is reusable runtime semantics.
- A surface counts as thin only if all of these are true:
  - sibling app-surface runtime imports are zero,
  - non-surface terminal defaults are zero,
  - reusable interactive/session/batch semantics live below `src/apps/**`,
  - state that can affect a later turn is engine-owned rather than slash-local,
  - the structural ratchets stay green.
- Any state that can affect the next turn's `AgentConfig`, prompt, tool policy, or loop behavior must be wired through an authoritative engine-visible path (`SessionDeps`, `AgentConfig`, or a typed host port). A slash-only mirror is not authority.
- No new runtime imports may be added from one `src/apps/<surface>` tree into another. `tests/unit/surface-coupling-ratchet.test.ts` is now an exact-zero guard: debt reduction is irrelevant because reintroduction is forbidden.
- Non-surface slices must not add fresh terminal defaults. `tests/unit/terminal-defaults-ratchet.test.ts` is now an exact-zero guard for non-`src/apps/**` stdio/exit ownership.
- The CLI REPL must not regain runner-owned session assemblers inside `src/apps/cli/repl/**`. `tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts` pins that ownership boundary.
- Surface-affecting changes are not architecture-closed until `typecheck`, the relevant Biome fences, `surface-coupling-ratchet`, `terminal-defaults-ratchet`, and any feature-specific state-authority hellgate are green.

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
- **`process.stdin` / `process.stdout` / `process.stderr` / `process.exit()` outside `src/apps/**`** — terminal ownership belongs to surfaces; inject a port or sink instead.
- **New cross-surface runtime imports under `src/apps/*`** — this is how a surface gets fat. Add a port or move the logic below `src/apps/` instead.
- **Surface-only mutable state that diverges from engine-visible state** — if a slash/UI action can affect next-turn behavior, the engine must read the same authority source.

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

- **Reviewer authority fallback**: CLI now honors explicit per-thread permission authority (`approvalPolicy` + `approvalsReviewer`) and injects the same `PermissionStore` into admissibility, but threads with no stored record still fall back to the older `PermissionMode.default` proxy for `"on-request"` reviewer selection.
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
