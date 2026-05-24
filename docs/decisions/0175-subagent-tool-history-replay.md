# ADR-0175: Subagent tool-history replay (Phase 3 of ADR-0166)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0124 (conversation checkpoint), ADR-0158 (subagent persistence), ADR-0159 (work resume), ADR-0166 (Phase 2.5 conversation-seed replay — this extends), ADR-0108 (shadow ODB)
- **Note on numbering**: the work-order proposed ADR-0174 but that slot was taken by `0174-plan-queue-lib-evaluation.md` (also dated 2026-05-25); this slice settled on 0175 to avoid the collision.

## Context

ADR-0166 Phase 2.5 added conversation-seed replay (LLM `messages[]`) when a host process dies mid-run. The resumed fork sees its prior dialog turns but every tool call it made is GONE — re-execution would either be wasted work (pure tools), unsafe (mutating-recoverable: re-running an `edit` whose previous output the LLM relied on), or impossible (mutating-external: cannot re-`bash` a side effect without confirming with the user).

We needed: **real tool-output replay + shadow-ODB workspace state restoration**.

## Industry pattern (verified)

Cache-the-output (Option A) is universal in agent runtimes:

| Agent | tool-output cache | workspace restore | external-side-effect confirm |
|---|---|---|---|
| Cursor BackgroundComposer | yes (in-memory turn cache) | yes (shadow git) | proprietary (likely UI prompt) |
| OpenHands EventStream | yes (`Observation` events) | yes (docker volume diff) | no — relies on dockerized isolation |
| Aider | partial (git-tracked only) | yes (git replay) | no |
| Claude Code `--resume` | yes (`toolUseResult` in transcript) | yes (`fileHistory`) | no |
| Codex | yes (`function_call_output` in `archived_sessions/*.jsonl`) | partial (working dir, not git refs) | no |
| Devin (claimed) | N/A — VM-as-state (re-execute against persistent VM) | yes (VM disk) | no |
| **quanta (this ADR)** | yes (JSONL store, sibling to ADR-0158) | yes (shadow ODB SHA per record) | yes (`ask-user-confirm` 3-tier policy) |

Re-execution (Devin's path) only works when the runtime owns the workspace (a long-lived VM). quanta runs against the user's filesystem; re-execution is unsafe.

## Decision

**3-tier idempotency classifier + JSONL tool-history store + replay policy + resumer wire.**

### Tier table (explicit, no heuristic)

- `"pure"` — `read`, `grep`, `glob`, `git_status`, `git_diff`, `git_log`, `git_blame`, `git_churn`, `git_blame_heatmap`, `git_upstream_check`, `git_review_diff`, `git_moved_code`, `git_conflict_inspect`, `file_tree_summary`, `parse_test_failure`, `test_runner`, `diagnostics`, `localize`, `read_image`, `read_image_url`, `web_fetch`, `csv_read`, `ndjson_read`, `yaml_read`, `pdf_read`, `xlsx_read`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_type_definition`, `lsp_implementation`, `lsp_document_symbol`, `lsp_workspace_symbol`, `lsp_rename_preview`, `lsp_code_action`, `lsp_signature_help`, `shadow_snapshots`, `subagent_poll`, `subagent_await`, `budget_status`, `coverage_check`
- `"mutating-recoverable"` — `edit`, `write`, `scripted_replace`, `apply_patch`, `git_commit`, `git_branch_switch`, `update_working_state`, `request_user_input`, `shadow_rewind`, `shadow_restore_partial`
- `"mutating-external"` — `bash`, `subagent_fork`, `lsp_format`, `lsp_rename_apply`, `web_search`

### Default replay matrix

| Record? | Tier | Decision |
|---|---|---|
| HIT | pure | replay-from-cache |
| HIT | mutating-recoverable | replay-from-cache **+ shadow restore** |
| HIT | mutating-external | replay-from-cache (output captured; do NOT re-run side effect) |
| MISS | pure | safe-re-run |
| MISS | mutating-recoverable | halt (data loss risk; no shadow anchor) |
| MISS | mutating-external | ask-user-confirm |
| any | unknown tier / unknown tool | halt (defensive) |

### Shadow ODB integration

Each persisted `ToolCallRecord` in a mutating tier carries `shadowCommit` — the SHA the shadow store advanced to RIGHT AFTER the call. On replay-from-cache for `mutating-recoverable`, the orchestrator calls a narrow `ShadowCommitRestorer` port to bring the workspace tracked files back to that state, so the resumed agent's next turn sees the EXACT workspace the original LLM saw. The port is narrow (one method) so this slice does NOT depend on `@/storage/shadow-odb`'s full surface — callers wire an adapter at integration time.

### Hellgate (30+ cases — `tests/unit/subagent-tool-replay-hellgate.test.ts`)

- A: IdempotencyClassifier (5) — including DEFAULT_IDEMPOTENCY_TABLE drift sentinel + `__proto__` prototype-pollution defense via `Object.hasOwn`
- B: ToolCallRecord + JSONL store (8) — append/list/byToolUseId/clear roundtrip, multi-handle isolation, argsHash stability, sensitiveRedacted marker, mutating-vs-pure shadowCommit field, **torn-write recovery (HG-B8)**
- C: ToolReplayPolicy (8) — every cell of the 6-cell matrix above + unknown-tier defense + NO-THROW collapse
- D: replayToolHistory orchestrator (5+1) — pure-only path, mutating restore signal, no-shadow-wired halt, mixed-tier ordering, cross-workspace fence, shadow-throw halt + iteration continues
- E: Resumer integration (4) — wired path surfaces `toolReplays`, unwired path byte-identical to Phase 2.5, child handle starts FRESH, restore-throw still allows main resume

## Default-OFF

When `opts.toolReplay` is ABSENT, `resumeInterruptedHandles` is BYTE-IDENTICAL to ADR-0166 Phase 2.5 — no `toolReplays` key on the outcome, no list call, no policy consult. The wire is helper-only; nothing in `loop.ts` / `dispatch.ts` / `apps/agent/bootstrap.ts` instantiates it. A future surface (CLI command, system-skill) opts in by constructing `defaultJsonlToolHistoryStore() + defaultIdempotencyClassifier() + defaultToolReplayPolicy()` and passing them in.

## Alternatives rejected

- **Re-execute on resume (Devin pattern).** Requires the runtime to own the workspace (a VM-as-state model). quanta runs against the user's real filesystem; `bash`'s `npm publish` cannot be replayed safely. Cache-the-output is the universal industry choice for any non-VM agent.
- **Single-tier classifier (pure vs mutating).** Loses the external-side-effect signal — `bash` and `edit` need different cache-miss policies (`ask-user-confirm` vs `halt`).
- **Auto-classify by the tool's `isReadOnly()` flag.** Heuristic; would silently misclassify a tool that grows a side-effect path later. Explicit table is auditable + a missing entry surfaces in the drift-sentinel hellgate (HG-A5).
- **Replay-from-cache + side-effect re-execute for mutating-external.** Data-loss risk on `edit` (running the same patch on different file state) + duplicate-side-effect risk on `bash` (sending the same notification twice). Output is the only safe surface.

## Subtle decisions

- **Tier 4 ("unknown")** is not a separate arm — both the classifier `null` (unknown tool) and a corrupted record `tier` collapse to `halt`. Defensive: an unknown tier is never treated as `pure`.
- **`Object.hasOwn` guard** — `defaultIdempotencyClassifier` checks ownership before lookup so `__proto__` / `constructor` / `toString` cannot smuggle in a classification.
- **Cross-workspace fence** runs BEFORE the policy — a record whose `workspace` differs from the resume workspace is rejected even if the policy would have said replay. Security: paths and git refs in the cached output may not exist on the resume side.
- **Child handle starts FRESH** (HG-E3). The tool-history store is keyed by handle id; a re-fork gets a new id. The chained re-fork has no inherited tool-history. Rationale matches Codex's `function_call_output` scoping: outputs are bound to the original conversation, not propagated.
- **Workspace key joins across 3 stores** — `subagent-persistence-store`, `tool-history`, and `shadow-odb` all use SHA-256 first-16-hex of the canonicalized workspace path. A cross-module audit can join on that key.

## Follow-up

- **PII redaction at record time** — integrate ADR-0171 redaction so `result.output` is filtered before persistence, with the `sensitiveRedacted` marker surfacing the action.
- **Sliding-window estimated-bytes cap** (Codex-style) — to bound on-disk growth across long sessions.
- **Fork shadow ref copy (not alias)** — when the resumed child mutates a file that was also mutated by the parent's resumed history, the shadow ref must be COPIED so the child's ref advancement does not invalidate the parent's audit.
- **Resume budget cap** — limit the number of tool calls replayed in one resume (avoid context blow-up). Default proposal: 200 calls (mirrors the conversation-seed `maxMessages` cap).
