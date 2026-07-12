# C5059-08 — No-go and skip register

- **Date:** 2026-07-13
- **Status:** CLOSED decisions
- **Purpose:** prevent rejected or duplicate Codex 5059 candidates from reappearing as implementation work without new evidence.

## D1 — Execpolicy amendment: NO-GO

**Decision:** do not allow the model to propose a baseline-widening prefix and persist it as a permanent grant.

**Already have:** one-shot approval, session/session-prefix grant, persistent trust-scope store, proposed-pattern recording, justification channels, and HARD_DENY-first ordering.

**Reason:** the missing behavior deliberately breaks `recordProposedPattern`'s no-widen invariant. First-token/prefix grants are broader than action capability grants; HARD_DENY only covers known patterns. The durable store also permits caller-selected non-expiring TTL and is file-backed, with keyring protection deferred.

**Reopen only if:** current trajectories prove material cross-session approval friction that session-prefix grants cannot solve, and the replacement design uses capability-bound grants including principal, executable, argv constraints, cwd/repo identity, expiry, grantor, revocation id, justification, and policy version. Plain prefix persistence remains prohibited.

## D2 — Subagent close-to-release slot accounting: SKIP

**Decision:** retain running-only concurrency accounting and immediate slot release on terminal status.

**Reason:** Codex's close-to-release policy would create orphan-slot risk without improving Quanta's registry accounting. OS process/worktree/channel reaping is a separate lifecycle question owned by `docs/tickets/jul-12-agent-runtime-correctness.md` R-lane and Run Ledger receipts.

## D3 — Code-mode host process / cell actor: V1 KILL

**Decision:** do not build a separate IPC host, resumable cell actor, or `yield_time_ms` in this packet.

**Residual risk:** in-process QuickJS-WASM does not provide process-level crash containment. Reopen isolation work if code mode becomes default-ON/untrusted or a VM/runtime fault terminates the host session. That future work is a containment ticket, not a code-mode feature rebuild.

## D4 — `text()` / `exit()` helpers: SKIP

**Decision:** the existing async function body plus `return` is sufficient for v1. Add multi-item output helpers only after a measured task requires them. Do not bundle them with `store/load`.

## D5 — Rollout budget absorption: SKIP

**Decision:** do not add a second enforcement ledger.

**Reason:** `BudgetLedger` owns session/cross-run USD soft/hard policy; `BudgetMeter` owns provider-reported token dials and hard-stop behavior. Weighted prefill/sampling tokens may be useful as an offline cross-model research metric, but not as a second live budget authority.

**Reopen only if:** an eval question requires price-independent normalized compute accounting across models. Implement it as a report metric first.

## D6 — Standalone `comp_hash`: SKIP

**Decision:** do not add a hash without canonical source retention and a defined stale-recovery transition. Any reopened work routes to C5059-07.

