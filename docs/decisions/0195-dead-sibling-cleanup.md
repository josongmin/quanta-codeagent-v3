# ADR-0195: Dead-sibling cleanup — delete 5 lib-swap adapters that shipped 0 callers

- Status: Accepted
- Date: 2026-05-25
- Supersedes: ADR-0177 (csv-parse-lib swap), ADR-0184 (conversation-checkpoint-lru
  swap), ADR-0185 (file-write-atomic-lib swap), ADR-0192 (shell-execa swap)
- Related: ADR-0133 (csv-parse self-impl — KEPT), ADR-0124
  (conversation-checkpoint Map self-impl — KEPT), ADR-0155
  (`FileWriteStrategy` port + `atomicFileWriteStrategy` self-impl — KEPT),
  ADR-0006 / `src/runtime/shell.ts` self-impl — KEPT
- User principle (corrected): **"self-impl 삭제 안 하면 swap이 아니라 bloat."**

## Context

An audit on 2026-05-25 of the recent "swap self-rolled X for lib Y"
slice cluster (ADR-0172 c8 / ADR-0173 secretlint / ADR-0177 csv-parse /
ADR-0184 lru-cache / ADR-0185 write-file-atomic / ADR-0186 turndown /
ADR-0192 execa + an undocumented fs-jail-lib sibling) revealed that
**5 of 6 lib-swap siblings had ZERO src callers** — only their own
hellgate tests imported them. The earlier ADRs' framing of "external
better than self-impl, but the self-impl stays for back-compat" turned
out to be cover for "we shipped the sibling and then did nothing with
it." No `csv_read` flip. No LSP `applyWorkspaceEdit` flip. No
conversation-store consumer flip. No shell-tool flip. No fs-jail
callers ever.

The user's principle reframes this honestly: a sibling that nobody calls
is not a swap, it is bloat. The "back-compat zero-dep fallback" rationale
is true only when there ARE non-fallback callers — and there were none.

The earlier ADRs also each cited 80–120 LOC of additional sibling code as
a feature of the slice. They cited it as a positive ("13–15 hellgate cases
prove parity"). Reframed: those LOC are dead weight that obscures
which-impl-runs-in-prod when someone reads the slice cold.

Verification per sibling (the `grep -rn "<symbol>\b" src/` query that
seeded this ADR returned only the adapter's own file + the barrel
re-export + the hellgate test — no production caller):

| sibling                                | adapter LOC | hellgate LOC | barrel re-export                    | ADR        |
|----------------------------------------|-------------|--------------|-------------------------------------|------------|
| `src/runtime/shell-execa.ts`           |         159 |          166 | `src/runtime/index.ts`              | 0192       |
| `src/storage/fs-jail-lib.ts`           |         119 |          145 | none (storage barrel never added it)| none       |
| `src/lsp/adapters/file-write-atomic-lib.ts` + `.d.ts` |  107 + 31 |  295 | none (lsp/adapters has no barrel)   | 0185       |
| `src/agent/conversation-checkpoint-lru.ts` |     113 |           27 | `src/agent/index.ts`                | 0184       |
| `src/tool/document/csv-parse-lib.ts`   |         260 |          179 | `src/tool/document/index.ts`        | 0177       |

**Total adapter LOC reclaimed: 758 src + 31 ambient = 789 LOC.**
Plus 812 LOC of sibling hellgate tests (no longer protecting any caller).

## Decision

Delete all 5 sibling adapters + their hellgate tests + the `write-file-atomic.d.ts`
ambient module. Remove the 3 barrel re-exports. Remove the `SIBLING:`
comment-pointer at the top of `src/runtime/shell.ts`. Mark ADRs 0177 /
0184 / 0185 / 0192 as Superseded by this ADR.

Self-impls are NOT touched:

- `src/runtime/shell.ts` (`runShell`) — every shell-tool caller depends on it.
- `src/storage/service.ts` (`resolveJailed` + `FileSystemPort` family) — fs-jail
  primitive used across slices; `is-path-inside` was never wired in.
- `src/lsp/adapters/file-write-atomic.ts` (`atomicFileWriteStrategy`) — sole
  atomic-write strategy behind the `FileWriteStrategy` port.
- `src/agent/conversation-checkpoint.ts` (`defaultConversationCheckpointStore`) —
  sole conversation-checkpoint store; consumed by ADR-0166 replay if/when
  invoked.
- `src/tool/document/csv-parse.ts` (`parseCsv`) — sole CSV parser; consumed
  by `csv_read` tool.
- `tests/unit/_parity/checkpoint-parity.ts` — shared parity helper, still
  exercised by the self-impl's own hellgate.

## Retained (NOT deleted by this ADR)

- **ADR-0200 / `src/agent/retry-pretry.ts` and `src/agent/retry.ts`** —
  audit verdict: intentional dual implementation. `retry.ts` returns a
  streaming-class wrapper; `retry-pretry.ts` returns a promise-shape
  result. Callers pick by their consumption shape, not by lib-vs-self
  preference. Not bloat; documented dual surface. (Note: no ADR-0200 file
  exists today; this paragraph is the authoritative "KEEP" record until
  the dual-surface contract gets its own ADR.)
- **ADR-0172 / c8 coverage swap** — uses out-of-process CLI (`c8` invoked
  as a subprocess wrapper for `bun test`). There is no in-tree
  "self-impl" sibling to be dead; the swap pattern doesn't apply.
- **ADR-0173 / secretlint** — per audit, the sibling architecture is
  justified by an unrelated factor (default-OFF detector behind a
  toggleable port, with self-impl `secret-detection.ts` retained
  specifically for the entropy/Luhn signal that secretlint does not
  surface). Not in scope for this ADR.
- **ADR-0186 / turndown** — has at least one real caller (wired into the
  web/fetch markdown projection). Real swap, not bloat.

## Honesty note

Future lib-swap pattern is one of these two, never the middle:

1. **Full migration.** Flip every caller to the lib. Delete the self-impl
   in the same slice. Reclaim the LOC. The slice ADR is the contract that
   the self-impl is gone; reverts go through revert-of-slice, not a hidden
   `engine: "self"` route.
2. **Explicit evaluation-only sibling.** Ship the adapter with a Status
   line that names a deadline ("evaluation-only sibling; promote-or-delete
   by 2026-MM-DD") and a single named owner. If the deadline passes with
   the sibling still uncalled in prod, it gets deleted under a follow-up
   like this ADR.

The half-swap — sibling shipped, self-impl kept, callers never flipped,
deadline never named — is the worst of both. It looks like swap progress
in the changelog but actually adds surface, LOC, and ambiguity about
which path runs in prod. This ADR exists to make that pattern unrepeatable
without an explicit Status decision.

## Verification (post-cleanup)

- `bunx tsc --noEmit` over `src/` and `tests/` — 0 NEW errors. Pre-existing
  failures (in-flight user work on unrelated slices) unaffected.
- `grep -rn "from \"@/runtime/shell-execa\"\|from \"@/storage/fs-jail-lib\"\|from \"@/lsp/adapters/file-write-atomic-lib\"\|from \"@/agent/conversation-checkpoint-lru\"\|from \"@/tool/document/csv-parse-lib\"" src/ tests/` — 0 hits.
- Existing self-impl hellgate batteries
  (`conversation-checkpoint-hellgate`, `tool/csv-read-hellgate`, the
  shell.ts `shell.test.ts` battery, the LSP `lsp-atomic-write-hellgate`,
  `src/storage/service.ts` jail tests) — all stay green; sibling
  deletion is callerless and cannot regress them.

## Subtle decisions

- **`src/runtime/shell.ts` SIBLING comment.** The 2-line `// SIBLING:`
  header at the top of shell.ts was a forward pointer to the now-deleted
  sibling. Removed in the same patch, otherwise the file lies about its
  own siblings.
- **`fs-jail-lib.ts` had no ADR.** Its docstring referenced ADR-0192
  (shell-execa) for posture but it was never standalone-documented. This
  ADR is the first and last note that it existed.
- **The `_parity/checkpoint-parity.ts` shared helper STAYS.** It is the
  shared 23-case battery used by the self-impl's
  `conversation-checkpoint-hellgate.test.ts`. Deleting it would force a
  rewrite of the self-impl battery; the helper has 1 remaining caller and
  is not dead.
- **ARCHITECTURE.generated.md will refresh on the next architecture-gen
  run.** No hand-edit needed for the auto-generated section.
