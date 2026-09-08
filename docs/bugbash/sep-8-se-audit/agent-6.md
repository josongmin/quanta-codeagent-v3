# Sep-08 SE audit — agent-6 (Lane D)

> Scope: `session`, `memory`, `storage`, `kernel`, `stream`, `artifact`
>
> Fact-check snapshot: `f5f4875799141068af73e604129c8b9a09f76007`
>
> Result: retain 5 issues. Product code was not changed.

## Retained

| ID | Severity | Issue |
|---|---|---|
| SEP7-D-05 | P2 | `deleteSession` can race an in-flight save and resurrect the deleted session |
| SEP7-D-06 | P2 | one corrupt index row is permanently dropped by the next unrelated upsert |
| SEP7-D-07 | P2 | malformed/unreadable snapshot is indistinguishable from an absent snapshot during durable resume |
| SEP7-D-10 | P2 | updating a row with a corrupt embedding rewrites the BLOB as `NULL` |
| SEP7-D-11 | P2 | stdout omits redaction on reachable free-text progress fields |

### SEP7-D-05 — delete/save resurrection

- Evidence: `src/session/store.ts:578-590` owns the per-session save queue and `saveSessionById` enters it at `:593-640`. `deleteSession` at `:874-878` bypasses that queue. Per-turn autosave reaches `saveSessionById` from `src/runner/orchestrate/persist-turn.ts:181-198`; the session command reaches delete from `src/runner/session-ops/index.ts:628-665`.
- Trigger: `/session delete <id>` overlaps a save for the same id after delete removes the snapshot/index but before the queued save writes.
- Impact: delete reports success, then the stale save recreates both the snapshot and its index entry.
- Smallest correction: run the complete delete sequence under `withSessionSaveLock(id, ...)`. Add a barrier test that parks a save inside the critical section, starts delete, proves delete waits, then proves the session remains absent.

### SEP7-D-06 — corrupt index row is lost on rewrite

- Evidence: `src/session/index-store.ts:28-57` silently omits malformed/wrong-shape rows. `upsertMeta` reads only the surviving map and rewrites it at `:109-118`; `listSessions` has no snapshot-directory fallback at `:134-149`. `tests/unit/session-index.test.ts:92-105` pins skip-on-read, not recovery-on-rewrite.
- Trigger: one row is corrupt while its `<id>.json` snapshot still exists; any later save/upsert for another session rewrites `index.jsonl`.
- Impact: the corrupt row is deleted from the only listing index. The snapshot remains loadable only when its id is already known, so picker/list-driven recovery and crash-resume discovery lose it.
- Smallest correction: rebuild missing rows from snapshot files before replacing the index, or quarantine the corrupt line without rewriting it away. Add a RED fixture with two rows, corrupt one, upsert the other, then assert the first snapshot is rediscovered.

### SEP7-D-07 — corrupt snapshot becomes fresh resume

- Evidence: `src/session/store.ts:463-497` returns `undefined` for absence, read failure, malformed JSON, and schema mismatch. `loadSessionById` forwards that collapsed result at `:708-719`. `src/sdk/runtime/session/rehydrate.ts:90-135` treats `undefined` as an allowed empty resume, and `src/sdk/runtime/runtime.ts:26-45` invokes it when the durable event-log tip is non-zero.
- Trigger: a resumable durable log exists, but the matching session JSON is unreadable or malformed.
- Impact: the runtime starts with an empty transcript instead of the documented fail-closed refusal; prior context is silently discarded.
- Smallest correction: expose a typed read result (`missing` versus `corrupt`/`unreadable`) and allow fresh resume only for `missing`. Add an end-to-end durable-tip + malformed-snapshot test that expects `ResumeRehydrateRefusedError`.

### SEP7-D-10 — corrupt embedding is destroyed by unrelated update

- Evidence: `src/memory/adapters/sqlite.ts:233-241` builds an update through `rowToEntry`; `rowToEntry` omits undecodable embeddings at `:328-353`; `save` writes an omitted embedding as `NULL` at `:195-225`. Production update callers include `src/agent/memory-tools.ts:477-508` and reinforcement/decay paths in `src/agent/memory.ts:176,423-469`.
- Trigger: a row contains a non-null malformed embedding BLOB and any update omitting `embedding` runs.
- Impact: the original bytes and the `onCorruptEmbedding` signal disappear permanently, preventing later repair or diagnosis.
- Smallest correction: use an SQL partial update, or preserve the raw BLOB whenever the patch does not own `embedding`. Extend the corrupt-BLOB hellgate with update/readback assertions.

### SEP7-D-11 — stdout progress redaction gaps

- Evidence: `src/stream/adapters/stdout.ts:260-262` renders `tool_progress.message` with `oneLine` only; `renderInProgress` does the same for provider-supplied `message` at `:567-571`. Neighboring free-text fields use `redactStr`, including tool results at `:124-126` and errors at `:272-274`. Reachable progress producers include path-bearing LSP events (`src/tool/lsp_nav/code-action.ts:163`, `src/tool/lsp_nav/format.ts:114`) forwarded by `src/agent/stream-callbacks.ts:400-406`; provider heartbeat text is forwarded at `:521-535`.
- Trigger: a progress path/status contains a token recognized by the shared secret scrubber.
- Impact: the TTY path bypasses the redaction invariant applied to other stdout free text.
- Smallest correction: apply `redactStr` before `oneLine` for both fields. Add malicious-secret fixtures to `tests/unit/stdout.test.ts` for `tool_progress` and `in_progress`.

## Verification

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- Focused baseline: 100 tests passed across session-index, stdout, SQLite, budget, classifier, LSP, and session-registry suites. These tests characterize current behavior; they do not close the retained missing regression rails.
- Ephemeral probes reproduced D-06 (`lost.json` remained while the next upsert removed `lost` from `index.jsonl`), D-10 (raw embedding `00` became SQL `NULL` after a text-only update), and D-11 (a fake GitHub token remained verbatim in `tool_progress` output).
