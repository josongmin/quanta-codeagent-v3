# Confirmed CRITICAL / HIGH findings (25)

Every finding below was raised by an objective or adversarial finder **and** survived a separate adversarial verification pass that re-read the actual source. File paths are repo-relative; line numbers are at audit time (2026-05-31, HEAD `57d78b8a`).

Legend — category: `correctness-bug`, `error-swallow`, `silent-error`, `race-cancellation`, `missing-feature`, `solid-violation`, `security`, `dead-code-wiring`.

---

## C-1 · CRITICAL · Double `usage_count` increment in Stage1 reuse consumer

- **File:** [src/agent/memory-consolidator-hook.ts:579-584](../../../src/agent/memory-consolidator-hook.ts#L579-L584)
- **Adapter impls (the actual double-bump):**
  - sqlite: [src/agent/memory/stage1-store/sqlite.ts:91](../../../src/agent/memory/stage1-store/sqlite.ts#L91) (`incrementStmt`) **and** [:97](../../../src/agent/memory/stage1-store/sqlite.ts#L97) (`selectMarkStmt`) — both run `usage_count = usage_count + 1`
  - in-memory: [src/agent/memory/stage1-store/in-memory.ts:111](../../../src/agent/memory/stage1-store/in-memory.ts#L111) (`incrementUsageCount`) **and** [:136](../../../src/agent/memory/stage1-store/in-memory.ts#L136) (`selectForPhase2`) — both `usageCount + 1`
  - (Note: this is the consolidate-reuse store under `src/agent/memory/stage1-store/`, **not** the best-effort `src/memory/stage1-store/` referenced in C-8.)
- **Category:** correctness-bug
- **Found by:** R1 *and* R2 independently (high confidence — two blind passes converged)

**What:** `consumeStage1ForPhase2` calls `incrementUsageCount()` (increments once) and then `selectForPhase2()`. Both adapter implementations of `selectForPhase2` *also* increment `usage_count` by 1. Net effect: every reuse bumps the counter by **+2** instead of +1.

**Why it's a bug:** The documented contract at [memory-consolidator-hook.ts:521-532](../../../src/agent/memory-consolidator-hook.ts#L521-L532) deliberately keeps Step 3 (`incrementUsageCount`) and Step 4 (`selectForPhase2`) **separate so each surface is observable** — implying `selectForPhase2` should only flip the promotion flag, not increment usage. The double-count makes records hit `maxUsageBeforeRefresh` (line 571) and the refresh-due-to-over-use condition (line 572) roughly **twice as fast as designed**, silently breaking the cache-freshness semantics in the ADR-0216 contract.

**Fix:** Remove the `usage_count = usage_count + 1` from `selectForPhase2` in **both** adapters (sqlite `selectMarkStmt` at :97, in-memory at :136). The counter must be owned solely by `incrementUsageCount`. (Preferred over the alternative of dropping the separate `incrementUsageCount` call, because keeping them separate preserves the observable-surface contract at port.ts:82.)

---

## C-2 · HIGH · logger no-throw contract violated — background Phase 2 dispatch

- **File:** [src/agent/memory-consolidator-hook.ts:389-394](../../../src/agent/memory-consolidator-hook.ts#L389-L394)
- **Category:** error-swallow

**What:** `dispatchPhase2Background` schedules Phase 2 on a `queueMicrotask` and invokes `log?.({ kind: "completed", outcome })` / `log?.({ kind: "error", ... })` inside `.then`/`.catch` with **no try/catch around the logger call**.

**Why it's a bug:** The module contract (lines 254-257) states errors "MUST NOT crash the session-start path", and the logger type (lines 313-321) is documented as no-throw. But nothing enforces it. If a caller-supplied logger throws: the `.catch` handler itself throws → the rejection escapes the whole promise chain → because it runs inside `queueMicrotask` with no outer handler, it becomes a **process-level `unhandledRejection`**, able to crash the session-start path the contract promises to protect.

**Fix:** Wrap each `log?.(...)` in `try { ... } catch { /* swallow per no-throw contract */ }`.

---

## C-3 · HIGH · logger no-throw contract violated — session-end hook

- **File:** [src/agent/memory-consolidator-hook.ts:174](../../../src/agent/memory-consolidator-hook.ts#L174)
- **Category:** error-swallow

**What:** `runMemoryConsolidatorHook` calls `log?.(result)` with no try/catch. This runs in the session-finishing path (invoked from `runAgent`'s `finally`, [loop.ts:2582](../../../src/agent/loop.ts#L2582) inside the try of 2569-2618).

**Why it's a bug:** Contract at lines 9-12 promises "the session-finishing path is never derailed by a consolidator bug." If the logger throws, the exception propagates to the outer catch ([loop.ts:2609](../../../src/agent/loop.ts#L2609)), flipping `spanStatus` from `ok` to `error` — turning a **successful session into a failed one** due to a logger bug.

**Fix:** `try { log?.(result) } catch { /* swallow */ }`.

---

## C-4 · HIGH · logger no-throw contract violated — Phase 2 auto-trigger

- **File:** [src/agent/memory-consolidator-hook.ts:343](../../../src/agent/memory-consolidator-hook.ts#L343)
- **Category:** error-swallow

**What:** `runMemoryPhase2AutoTrigger` calls `log?.(result)` at line 343 with no try/catch. Although `async` and awaited, a throwing logger rejects the returned Promise.

**Why it's a bug:** Contract (lines 329-337) says "The hook ITSELF is no-throw — every failure path returns an outcome." A throwing logger violates that documented guarantee. The current call site (session-memory-auto.ts:156-177) happens to wrap it in try/catch, but the function does not uphold its own contract — defense-in-depth, not by design.

**Fix:** `try { log?.(result) } catch { /* swallow */ }` before `return result`.

---

## C-5 · HIGH · `SqliteStore.delete()` synchronous throw bypasses Promise contract

- **File:** [src/memory/adapters/sqlite.ts:178-181](../../../src/memory/adapters/sqlite.ts#L178-L181)
- **Category:** error-swallow
- **Found by:** R1 *and* R2

**What:** `delete()` calls `this.deleteStmt.run(id)` with no try/catch. The sibling `save()` (lines 133-165) deliberately wraps its INSERT in try/catch — its comment (136-143) documents that better-sqlite operations fail **synchronously** on database-locked / disk-full / constraint-violation.

**Why it's a bug:** A DELETE has identical synchronous failure modes. The method signature promises `Promise<void>`, but a synchronous throw bypasses the promise boundary entirely. Callers using `await` (e.g. [memory.ts:404](../../../src/agent/memory.ts#L404), [memory-tools.ts:188](../../../src/agent/memory-tools.ts#L188)) expect a *rejected promise* and instead get a thrown exception that escapes their try/catch — crashing the eviction sweep / memory persistence pipeline. The parallel `automation-engine/sqlite.ts:276-283` `cancel()` correctly wraps its mutation, confirming the intended pattern.

**Fix:** Wrap `deleteStmt.run(id)` in try/catch and `return Promise.reject(new Error(...))` on failure, matching `save()` at 144-163.

---

## C-6 · HIGH · AbortSignal not forwarded to LLM stream in memory consolidation

- **File:** [src/agent/memory-consolidate.ts:180-185](../../../src/agent/memory-consolidate.ts#L180-L185)
- **Category:** missing-feature

**What:** `arbitrateConsolidation` accepts `opts?.signal?: AbortSignal` (line 172), checks it pre-flight (177) and during iteration (186), but calls `llm.stream({ messages, tools })` **without passing `signal`** — even though `StreamInput.signal` exists ([types.ts:262](../../../src/llm/types.ts#L262)) and is documented to abort the in-flight provider HTTP request.

**Why it's a bug:** On user cancel (Ctrl+C / timeout / deadline) the client stops iterating, but the provider-side HTTP request runs to completion — wasting tokens/resources and delaying socket release & session cleanup.

**Fix:** Add `...(opts?.signal ? { signal: opts.signal } : {})` to the `llm.stream()` input object.

---

## C-7 · HIGH · Non-exhaustive switch → uninitialized `tag`/`body` in `buildOne`

- **File:** [src/agent/context-change/inject.ts:59-149](../../../src/agent/context-change/inject.ts#L59-L149)
- **Category:** correctness-bug

**What:** The switch over `TypedHistoryEvent` covers all 8 current kinds (context_update, mode_change, repo_rules_change, skill_activation, reasoning_echo, compaction_event, plugin_activation, app_activation) but has **no `default` clause** and no `never`-exhaustiveness guard. `tag`/`body` are declared uninitialized above the switch (59-60).

**Why it's a bug:** Add a new event kind to the union without updating this switch and `tag`/`body` stay `undefined` → `embedUntrusted(undefined, undefined)` at line 149 builds an invalid message. TypeScript does **not** catch this — there's no `const _exhaustive: never = event` pattern. Silent data corruption waiting on the next union extension.

**Fix:** Add `default: { const _exhaustive: never = event; throw new Error(\`Unknown ContextEvent kind: ${(event as {kind:string}).kind}\`) }` to force compile-time coverage errors.

---

## C-8 · HIGH · `JsonlFileStage1Store.touch()` split-brain on append failure

- **File:** [src/memory/stage1-store/jsonl-file.ts:178-188](../../../src/memory/stage1-store/jsonl-file.ts#L178-L188) (and `markSelectedForPhase2` 190-195)
- **Category:** solid-violation (port-contract)

**What:** `touch()` mutates in-memory state via `this.inner.touch(threadId)` (line 179, succeeds) then calls `this.append(...)` (182-187). If `append` throws (appendFileSync I/O error, perms, disk-full), the in-memory map is already advanced while the on-disk log write failed.

**Why it's a bug:** On next hydration the entry reverts to the old on-disk state → split-brain between runtime and restart. The port contract (port.ts:17-19, 50-51) describes fire-and-forget semantics but documents no partial-success case; this allows a silent inconsistency the contract doesn't acknowledge. (Distinct from the *intentional* best-effort durability of `append()` itself — see false-positive FP-6 — here the problem is the in-memory/disk **coupling** being broken mid-operation.)

**Fix:** Either append-first-then-mutate, or catch the append error and roll back `inner.touch`. Best: couple the in-memory mutation and the disk append atomically at the append boundary.

---

## C-9 · HIGH · AbortSignal ignored in `ShadowApplyPort` V4A applier

- **File:** [src/agent/shadow-verify-adapters/apply-v4a.ts:84-98](../../../src/agent/shadow-verify-adapters/apply-v4a.ts#L84-L98)
- **Category:** race-cancellation

**What:** The adapter's `apply(signal)` accepts the signal (line 87) but never reads it, and the underlying `applyPatch()` ([src/patch/applier.ts:89-93](../../../src/patch/applier.ts#L89-L93)) takes no signal parameter at all. The runner ([shadow-verify/runner.ts:69 / :125](../../../src/agent/shadow-verify/runner.ts#L125)) passes the signal expecting it honored (test invariant HELL-SV-20).

**Why it's a bug:** A cancelled verify still runs the full patch application — contract violation + wasted work. The `signal?.aborted` early-return pattern already exists in `runChecks()` (runner.ts:93) but is missing on the apply path.

**Fix:** `if (signal?.aborted) return { ok: false, error: 'aborted' }` at the top of `apply`, and thread the signal into `applyPatch` if/when it supports it.

---

## C-10 · HIGH · AbortSignal ignored in `ShadowScratchPort.open()`

- **File:** [src/agent/shadow-verify-adapters/scratch-worktree.ts:37-49](../../../src/agent/shadow-verify-adapters/scratch-worktree.ts#L37-L49)
- **Category:** race-cancellation

**What:** `async open(_signal?: AbortSignal)` — the underscore confirms intentional non-use. Line 40 awaits `createPersistentWorktree(id, repoRoot)` (a multi-second `git worktree add` I/O) without the signal; the underlying chain (`createPersistentWorktree` → `runWorktreeAddWithRetry` → `git` → `runShell`) never threads it. The runner (runner.ts:118) calls `scratch.open(signal)`.

**Why it's a bug:** A cancelled verify blocks on git I/O to completion. Contract violation + observable blocking / resource waste.

**Fix:** Check `signal.aborted` before awaiting `createPersistentWorktree`; thread the signal down into `runShell` (which already supports `options.signal` at shell.ts:106).

---

## C-11 · HIGH · `head+tail` compression silently drops the tail (code fences)

- **File:** [src/agent/issue-hint/extract-code.ts:66-67](../../../src/agent/issue-hint/extract-code.ts#L66-L67)
- **Category:** correctness-bug

**What:** When a code-fence body is so large that the *tail alone* exceeds the 4 KiB budget, `headBudget <= 0` and the fallback returns `body.slice(0, MAX_FENCE_BYTES - ellipsis.length) + ellipsis` — **head + ellipsis only, no tail.**

**Why it's a bug:** Violates the documented contract (lines 8-12): "head + `\n…\n` + last 10 non-empty lines." The tail holds the most localization-relevant lines — the exception / wrong result / final assertion. In exactly the case where content is largest, the critical end of the snippet is silently lost.

**Fix:** When `headBudget <= 0`, still append the tail: `const maxHeadLen = Math.max(0, MAX_FENCE_BYTES - ellipsis.length - tailText.length); return body.slice(0, maxHeadLen) + ellipsis + tailText`.

---

## C-12 · HIGH · `head+tail` compression silently drops the tail (tracebacks)

- **File:** [src/agent/issue-hint/extract-tracebacks.ts:55-58](../../../src/agent/issue-hint/extract-tracebacks.ts#L55-L58)
- **Category:** correctness-bug

**What:** Same defect as C-11 for Python tracebacks. When `tailText.length + ellipsis.length >= MAX_BLOCK_BYTES`, line 58 returns head + ellipsis only, omitting the tail.

**Why it's a bug:** For Python tracebacks the **exception type + message sits at the very end** (contract, lines 36-39). Dropping the tail loses the actual error message — the single most important line for localization.

**Fix:** Same as C-11 — preserve the tail by reducing head allocation when budget is exhausted.

---

## C-13 · HIGH · Exponential glob brace-expansion DoS

- **File:** [src/skill/playbook/inline-trigger-watcher.ts:234-246](../../../src/skill/playbook/inline-trigger-watcher.ts#L234-L246)
- **Category:** security

**What:** `matchesGlobSubset` recursively expands brace groups with **no depth or size limit**. `{a,b}{c,d}{e,f}…` is multiplicative — 20 nested groups = 2^20 = 1,048,576 strings (>10 MB). The `watch-glob` comes directly from **user-authored playbook frontmatter**, unvalidated. Expansion runs synchronously (line 227) on every file save, blocking the watcher.

**Why it's a bug:** A crafted playbook causes memory exhaustion / DoS during file watches. No depth limit, no result-size cap, no glob-complexity validation at parse time; tests only cover trivial 2-alternative patterns.

**Fix:** Add a `maxExpansions` cap (return early when output exceeds it) and/or a brace-nesting depth limit; validate glob complexity at frontmatter ingestion.

---

## C-14 · HIGH · Unhandled promise rejection in fire-and-forget fs-watch dispatch

- **File:** [src/skill/playbook/trigger/fs-watch-adapter.ts:175](../../../src/skill/playbook/trigger/fs-watch-adapter.ts#L175)
- **Category:** error-swallow

**What:** `void scanAndEmit(abs, markers, callback, isStopped)` discards the returned promise with no `.catch`. `scanAndEmit` invokes the user `callback(ev)` (line 104) inside an async context.

**Why it's a bug:** If a `TriggerCallback` throws, the discarded promise rejects → unhandled rejection. The watcher's NO-THROW contract is violated; it currently relies on the process-level handler ([apps/cli/index.ts:109-112](../../../src/apps/cli/index.ts#L109-L112)) — defense-in-depth, not local correctness.

**Fix:** `void scanAndEmit(...).catch(() => { /* swallow */ })`, or wrap the callback invocation inside `scanAndEmit` in try/catch.

---

## C-15 · HIGH · Wrong `PluginManifest` type imported in MCP launcher (SOLID / latent)

- **File:** [src/agent/plugin-mcp-launcher/launcher.ts:38](../../../src/agent/plugin-mcp-launcher/launcher.ts#L38) (and use at :113)
- **Category:** solid-violation
- **Note:** This is the **one surviving** finding of the plugin-launcher cluster; 3 sibling findings about the same code were rejected as false-positives — see [03-false-positives.md](03-false-positives.md) FP-1..FP-3. The thread connecting them is **C-16** below: the function is dead code.

**What:** `launcher.ts` imports `PluginManifest` from `@/skill/plugin-manifest` (ADR-0039 schema: `name, version, description, author, license, keywords, mcpServers, skills, interface` — **no `id`**). But the launcher is conceptually meant to operate on *discovered* plugins from `@/agent/plugin-discovery`, whose `PluginManifest` has a canonical `id` field. At line 113 it does `const pluginId = manifest.name`.

**Why it's a bug (latent):** A port/adapter dependency-direction leak. If `launchPluginMcpServers` were ever called with a discovery-sourced manifest (where `id !== name`), `registry.handlesFor(manifest.name)` (line 122) would look up under the wrong key and fail. Today it can't surface because the function is unreachable (C-16) and the production handler bypasses it with its own correct `runMcpStep`. So: **real architectural defect, zero runtime impact today, lands as a real bug the moment someone wires the primitive.**

**Fix:** Either delete the function (preferred — no callers, see C-16), or import `PluginManifest` from `@/agent/plugin-discovery/types` and use `manifest.id`.

---

## C-16 · MEDIUM (downgraded from high) · Dead-code: `launchPluginMcpServers` exported but unreachable

- **File:** [src/agent/plugin-mcp-launcher/launcher.ts:103-152](../../../src/agent/plugin-mcp-launcher/launcher.ts#L103-L152) (exported from index.ts:25)
- **Category:** dead-code-wiring

**What:** `launchPluginMcpServers` is exported and documented (ADR-0338 docstring) as a "production primitive", but grep confirms **zero call sites outside tests**. The real activation flow (`plugin-activation-handler/handler.ts` `runMcpStep`, lines 143-181) inlines the logic correctly, taking `pluginId` as a parameter and passing it separately to `port.launch`.

**Why it matters:** Anyone following the docstring and calling this primitive hits the C-15 type/`manifest.name` defect. Severity downgraded to medium by the verifier because the docstring (lines 32-34) explicitly says it's a primitive not auto-wired, so the danger is misuse-only.

**Fix:** Delete `launchPluginMcpServers` and remove it from the barrel (option 1, preferred — no callers). Or fix per C-15 and add a `pluginId` parameter. Resolving this also clears FP-1..FP-3 and the related medium [02-medium-low.md](02-medium-low.md) M-track `track()` idempotency item.

---

## Remaining confirmed findings (verifier downgraded to medium but real)

These were raised as high, confirmed real by the verifier, but severity-adjusted to **medium** because impact is bounded by an explicit best-effort contract or a guarded call site. Kept here (not in 02) because they are confirmed, not unverified.

### C-17 · MEDIUM · `migration.writeFile` swallows all `mkdir` errors + miscomputes parent dir
- **File:** [src/skill/migration.ts:62](../../../src/skill/migration.ts#L62)
- **Category:** error-swallow + correctness-bug
- **What:** `await mkdir(join(p, "..").replace(/\/[^/]+$/, ""), ...).catch(() => {})`. Two issues: (a) `.catch(() => {})` discards **all** mkdir errors (EACCES, disk-full) — violates ADR-0134 "fail loudly"; (b) `join(p,"..").replace(/\/[^/]+$/,"")` strips **one path segment too many**, computing the grandparent not the parent.
- **Why bounded:** The live migration path (line 161-162) calls `mkdirp(toDir)` first (which does *not* swallow), so the buggy mkdir is effectively dead and writeFile succeeds against already-created dirs. The defect surfaces only if `writeFile` is called directly without a prior `mkdirp`.
- **Fix:** `import { dirname } from "node:path"; await mkdir(dirname(p), { recursive: true })` and drop the blanket `.catch` (or catch only `EEXIST` and rethrow the rest).

### C-18 · MEDIUM · Silent corrupt-embedding degradation masks data corruption
- **File:** [src/memory/adapters/sqlite.ts:233-250](../../../src/memory/adapters/sqlite.ts#L233-L250) (with [vector.ts:54-64](../../../src/memory/vector.ts#L54-L64))
- **Category:** silent-error
- **What:** A corrupt embedding BLOB (odd byte length / partial write) makes `deserializeVec` return `undefined`; `rowToEntry` then omits the embedding entirely, demoting the entry to "no embedding" with **no warning**. Ranking silently degrades to lexical-only.
- **Why bounded:** Comments (229-231, 50-52) document this "tolerant of legacy/corrupt data" fail-open design; ranking has text/tag/freshness fallbacks. Real risk is **operational blindness** — operators never see the data-quality issue.
- **Fix:** Log a warning on corrupt-embedding detection and/or validate decoded length == `EMBED_DIM` (treat wrong length as corruption). Add a store health-check counting corrupt vs valid embeddings.

### C-19 · MEDIUM · Latent SQL injection via interpolated column names in `migrate()`
- **File:** [src/memory/adapters/sqlite.ts:120-131](../../../src/memory/adapters/sqlite.ts#L120-L131)
- **Category:** security
- **What:** `this.db.exec(\`ALTER TABLE memories ADD COLUMN ${name} ${type}\`)` interpolates identifiers from `NEW_COLUMNS` (lines 39-47).
- **Why bounded:** `NEW_COLUMNS` is a hardcoded `ReadonlyArray` of literals fully controlled by the codebase; `migrate()` is private, called only from the constructor. **Safe today**, dangerous pattern if the schema is ever externalized to config/user input.
- **Fix:** Quote identifiers (`[${name}]`) or use a migration lib; keep the implicit whitelist explicit.

### C-20 · MEDIUM · AbortSignal not checked in `persistSession` persist/eviction loops
- **File:** [src/agent/memory.ts:417-449](../../../src/agent/memory.ts#L417-L449)
- **Category:** race-cancellation
- **What:** `deps.signal` is honored only in the distillation phase (`distillRecords` → `distillSession`). The subsequent persist loop (435-440) and `sweepEviction` (442) never check `deps.signal?.aborted`, so a mid-persist cancel saves the first N records and partially runs eviction before the abort is acknowledged.
- **Why bounded:** `persistSession` is explicitly best-effort/advisory (lines 46-47) and never throws. Still an inconsistency with the codebase's abort-in-long-loops convention.
- **Fix:** `if (deps.signal?.aborted) return;` before line 436 and inside `sweepEviction`'s decay/delete loop.

### C-21 · MEDIUM · `track()` non-idempotent on serverId collision
- **File:** [src/agent/plugin-mcp-launcher/registry.ts:32-41](../../../src/agent/plugin-mcp-launcher/registry.ts#L32-L41)
- **Category:** silent-error
- **What:** When `track()` is called with an already-tracked `serverId`, it returns early without verifying the `pluginId` matches. Two plugins colliding on serverId (possible via the C-15 `manifest.name` path) both believe they own the handle; the second `track` silently no-ops.
- **Why bounded:** Root cause is the C-15 collision; fixing C-15/C-16 resolves it.
- **Fix:** Resolve C-15/C-16; optionally assert `pluginId` matches on collision.

---

> The verifier also confirmed **C-2..C-4 logger** and the **memory-core** findings appear as both R1 and R2 hits in several cases — duplicates were collapsed above. Two additional memory-core items (`delete()` unwrap appears twice as C-5; touch contract twice as C-8) were the same defect surfaced by both rounds, raising confidence.
