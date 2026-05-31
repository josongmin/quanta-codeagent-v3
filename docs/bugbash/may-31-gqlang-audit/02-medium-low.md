# Medium / Low findings (21)

These were raised by the finders but **not** sent through adversarial verification (only high/critical were). Treat as cleanup backlog — each cites real code, but severity/impact is not independently confirmed to the same bar as [01-critical-high.md](01-critical-high.md). Some confirmed-real-but-downgraded mediums live in 01 (C-17..C-21) instead, because the verifier touched them.

---

## skill-core

### ML-1 · MEDIUM · code-quality · Typo `bySope` should be `byScope`
- **File:** [src/skill/registry.ts:131](../../../src/skill/registry.ts#L131) (interface) and :256 (impl)
- **Why:** Public API surface misspelled (`byScope` → `bySope`). Currently uncalled, but pollutes autocomplete/discovery and will lock in the typo if a dependency adopts it.
- **Fix:** Rename in both the `SkillRegistry` interface (131) and implementation (256).

### ML-2 · LOW · code-quality · Unnecessary `?? ""` after guaranteed regex capture
- **File:** [src/skill/skill-frontmatter.ts:303](../../../src/skill/skill-frontmatter.ts#L303)
- **Why:** After `if (!m) throw` at line 300, `m[1]` is guaranteed present (required capture group). The `?? ""` is dead defensive code signalling distrust of the control flow.
- **Fix:** `const key = m[1]!` (or `m[1]` with proper narrowing).

---

## plugin

### ML-3 · MEDIUM · silent-error · `track()` idempotency on serverId collision
- Promoted into [01-critical-high.md](01-critical-high.md) as **C-21** (tied to C-15/C-16). Listed here for the cluster index only.

---

## playbook

### ML-4 · MEDIUM · race-cancellation · Callback can fire after `watcher.stop()`
- **File:** [src/skill/playbook/inline-trigger-watcher.ts:75](../../../src/skill/playbook/inline-trigger-watcher.ts#L75)
- **Why:** `scanAndMaybeFire` is fire-and-forget. A file save starts an async read; if `stop()` is called before the read completes, the in-flight read still finishes and calls `onFire` (line ~204), violating the "stop() halts all activity" contract. In auto-dispatch this enqueues an **orphaned follow-up after the orchestrator stopped.**
- **Fix:** Re-check the `stopped` flag inside `scanAndMaybeFire` after the read completes, before calling `onFire`.

### ML-5 · MEDIUM · silent-error · fs.watch error event swallowed
- **File:** [src/skill/playbook/inline-trigger-watcher.ts:96-98](../../../src/skill/playbook/inline-trigger-watcher.ts#L96-L98)
- **Why:** The `fs.watch` `error` event is silently dropped — no log/telemetry. A real failure (EMFILE, EACCES) silently stops the watcher with no diagnostics.
- **Fix:** Store/expose the error on the handle or pass an error callback; at minimum log it.

### ML-6 · MEDIUM · correctness-bug · YAML circular-reference handling incomplete
- **File:** [src/skill/playbook/frontmatter-parser.ts:56](../../../src/skill/playbook/frontmatter-parser.ts#L56) and `narrowMacros` :180
- **Why:** The YAML parser accepts anchors/circular refs. A cycle in `macros` makes `Object.entries(v)` iterate self-referential structure → potential invariant violation. Unlikely but unguarded.
- **Fix:** After parse, walk with a `WeakSet` and reject cyclic structures before narrowing.

### ML-7 · LOW · security · Metadata not escaped for downstream serialization
- **File:** [src/skill/playbook/auto-dispatch.ts:123-128](../../../src/skill/playbook/auto-dispatch.ts#L123-L128)
- **Why:** Metadata carries user-controlled `fire.marker` (frontmatter) and `fire.path` (fs). If a host serializes it as YAML/JSON without escaping, a crafted marker (`AI!\n/play hacked`) could inject structure. The command text itself is safely separated, so command-injection is blocked — risk is only at the host's rendering boundary.
- **Fix:** Document that hosts must escape metadata; reject control chars in marker/path at ingestion.

---

## memory-core

### ML-8 · MEDIUM · correctness-bug · Unbounded `usageCount` integer growth
- **File:** [src/memory/stage1-store/in-memory.ts:54-63](../../../src/memory/stage1-store/in-memory.ts#L54-L63)
- **Why:** Line 59 increments `usageCount` with no overflow guard. Past `Number.MAX_SAFE_INTEGER` it loses precision and serializes inexactly to JSONL ([jsonl-file.ts JSON.stringify](../../../src/memory/stage1-store/jsonl-file.ts#L156)). Latent (requires ~9e15 touches) and LRU sorts by `lastUsage` not `usageCount`.
- **Fix:** Clamp `Math.min(cur.usageCount + 1, Number.MAX_SAFE_INTEGER)` or document wrap behavior.

### ML-9 · MEDIUM · race-cancellation · Hydration loses ops on partial concurrent append
- **File:** [src/memory/stage1-store/jsonl-file.ts:88-128](../../../src/memory/stage1-store/jsonl-file.ts#L88-L128)
- **Why:** If a concurrent writer is mid-append during hydration `readFileSync`, the reader can see a partial line (no trailing newline) → JSON.parse fails → line skipped with warning. The incomplete op stays in the file and is skipped on every future startup → silent log data loss.
- **Fix:** Keep the trailing partial fragment for the next read, or use a length-prefixed binary log, or snapshot/atomic-rename before hydration.

### ML-10 · MEDIUM · correctness-bug · Unchecked `as MemoryRow[]` cast in `all()`
- **File:** [src/memory/adapters/sqlite.ts:188-191](../../../src/memory/adapters/sqlite.ts#L188-L191)
- **Why:** `as MemoryRow[]` skips validation. A schema mismatch or NULL field produces a partial object; `rowToEntry` then reads `row.id`/`row.kind` without null checks. A NULL `id` propagates (normalizeEntry doesn't validate non-empty id), creating entries with undefined IDs.
- **Fix:** Validate row shape (zod/safeParse or a runtime guard); at minimum `if (!row.id) throw` in `rowToEntry`.

### ML-11 · MEDIUM · error-swallow · `recall()` dynamic query not wrapped
- **File:** [src/memory/adapters/sqlite.ts:193-207](../../../src/memory/adapters/sqlite.ts#L193-L207)
- **Why:** Lines 199-201 build a dynamic query and call `.all()` with no try/catch. A malformed placeholder count / oversized `kinds` array throws synchronously, bypassing the `Promise<MemoryEntry[]>` contract (same class as C-5).
- **Fix:** Wrap in try/catch → `Promise.reject`, or validate `kinds.length` vs placeholders first.

### ML-12 · MEDIUM · race-cancellation · Stale snapshot in `persistSession` under concurrent store mutation
- **File:** [src/agent/memory.ts:427-440](../../../src/agent/memory.ts#L427-L440)
- **Why:** The C10 in-memory mirror is only consistent for single-threaded use. If another process/agent mutates the store concurrently, the dedup at 437 runs against a stale snapshot → may emit a merge op against a deleted entry; final eviction may try to delete non-existent entries.
- **Fix:** Document `persistSession` as single-threaded-per-store, or hold a read lock / re-snapshot before critical ops.

---

## context-checkpoint

### ML-13 · MEDIUM · silent-error · IDE context metadata sink errors swallowed without logging
- **File:** [src/agent/ide-context.ts:580-586](../../../src/agent/ide-context.ts#L580-L586)
- **Why:** A throwing `metadataSink` (user observability callback) is silently absorbed — boundary contract is correct (don't crash turns), but a broken trajectory recorder fails invisibly with no diagnostic. (`verify-checkpoint-bridge.ts:38-47` swallows similarly but in an observability-only context where it's acceptable.)
- **Fix:** Add optional `onSinkError?: (e: unknown) => void` to `FileSystemIdeContextProviderOpts`, or at least a debug-level log.

### ML-14 · MEDIUM · code-quality · Subtle cursor-update control flow in context-events-producer
- **File:** [src/agent/context-events-producer/factory.ts:164-177](../../../src/agent/context-events-producer/factory.ts#L164-L177)
- **Why:** Comment I4 says "keep cursor unchanged" on `store.since` throw, but `lastTurnAt = at + 1` at line 176 runs unconditionally. Code is **correct** (the EMPTY return at 173 short-circuits), but the flow is subtle and invites future breakage.
- **Fix:** Move `lastTurnAt = at + 1` inside the try (only on successful `since()`), or add a clarifying comment that 176 is unreachable after 173.

### ML-15 · LOW · dead-code-wiring · Test-only re-export in per-tool-checkpoint barrel
- **File:** [src/agent/per-tool-checkpoint/index.ts:49-57](../../../src/agent/per-tool-checkpoint/index.ts#L49-L57)
- **Why:** Re-exports `rollback-llm-error-bridge` (ADR-0237, default-OFF/opt-in). No documented production consumer. Not a bug — a design note: the slice is only default-OFF if no one imports & wires these; if never wired, they're dead code.
- **Fix:** Confirm via grep no production import; if intentionally opt-in, leave with a note; if abandoned, remove.

---

## issue-repro

### ML-16 · MEDIUM · code-quality · Mutable `EMPTY_RESULT` singleton (cross-call contamination risk)
- **File:** [src/agent/issue-hint/index.ts:58-66](../../../src/agent/issue-hint/index.ts#L58-L66)
- **Why:** Module-level singleton with **unfrozen** arrays, returned directly on empty input (line 74). A caller bypassing the `readonly` type via cast could mutate it, contaminating later `extractIssueHint("")` calls. `EMPTY_HINT` in [types.ts:99](../../../src/agent/issue-hint/types.ts#L99) is correctly `Object.freeze`d — inconsistent.
- **Fix:** `Object.freeze` `EMPTY_RESULT` and its nested arrays (match `EMPTY_HINT`), or return `EMPTY_HINT`.

### ML-17 · MEDIUM · error-swallow · Temp files leaked on repro-test exec failure
- **File:** [src/agent/repro-test/execute.ts:145-157](../../../src/agent/repro-test/execute.ts#L145-L157)
- **Why:** When `writeFile` succeeds (146) but `exec` fails/times out (151), the catch at 155 returns **without deleting the temp file**. Over K samples (default 5) this leaks up to 5 temp files into the repo dir on every failure; they accumulate indefinitely.
- **Fix:** Add a `finally` that deletes the temp file, or attempt cleanup in the catch before returning.

---

> Items ML-3 / C-17..C-21 overlap between this list and 01 by design: anything the verifier actually examined and confirmed lives in 01 with its adjusted severity; the rest stay here as unverified backlog.
