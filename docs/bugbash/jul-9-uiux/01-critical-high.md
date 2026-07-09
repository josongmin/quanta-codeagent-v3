# P0 / Critical / High findings

Start here. Each item: symptom → evidence → suggested fix direction.

> **2026-07-10 audit:** every item in this file was re-verified against HEAD and confirmed REAL, except the corrections applied inline below (UUX-6-06 removed as WRONG — see [04-corrections.md](./04-corrections.md)).

---

## P0 — Destructive or data-loss false success

### UUX-6-01 / UUX-6-02 — `/snapshot <N>` ignores ordinal
**Symptom:** Confirm and success text say `#N`, but ODB always calls `rewindToLast` / `rewindToVerified` (or `restorePartial` without rewind-to-N).  
**Evidence:** `src/apps/cli/snapshot-cmd.ts` (~296–308, ~337–346). Shadow port has no `rewindToRef(ordinal)` (`src/storage/shadow-odb/types.ts`).  
**Fix:** Wire ordinal → ref API, or refuse `N≠1` with exit 1 and honest message until API exists. Never print “rewound to #N” for last-only ops.

### UUX-1-01 — `/edit-plan` drops edits
**Symptom:** Editor save → `/edit-plan: updated (N chars)` but structured plan store unchanged.  
**Evidence:** `src/apps/cli/repl/ctx-adapters/plan-edit-adapter.ts` (`setPlan` no-op); `src/apps/cli/edit-plan-cmd.ts` prints success after `setPlan`.  
**Fix:** Re-parse markdown → plan mutations, or fail closed (exit 1 + “not persisted”).

### UUX-2-01 — Web prefill slash Enter no-op
**Symptom:** Palette lists `/effort`, `/rewind`, `/fork`, …; typing + Enter clears draft and does nothing.  
**Evidence:** `apps/web-frontend/src/App.tsx` (~591–601) discards `action()` return; `SlashPalette.tsx` `prefill()` only returns draft string (~253–254).  
**Fix:** Apply return to draft, or route to HTTP readout / server slash; never silent clear. Badge prefill vs wired in palette.

### UUX-2-04 — Optimistic approval dismiss
**Symptom:** Escalation card vanishes immediately; if socket/`sessionId` not ready, command dropped — agent stays blocked.  
**Evidence:** `App.tsx` (~323–341); `session-hooks.ts` (~916); `client.ts` drop-when-not-open.  
**Fix:** Dismiss only after ack; re-show on drop; toast on failure.

---

## Critical — Policy / hang / silent schedule loss

### UUX-1-03 — CLI vs web HITL gate split
**Symptom:** Web `hitl: { enabled: true }` asks on always-confirm tools; CLI has no `hitl.enabled` → fallthrough under `acceptEdits` auto-allows many mutating tools. Contradicts inspect/heartbeat docs.  
**Evidence:** `src/apps/web-daemon/runtime-factory.ts:467`; CLI grep empty; `src/agent/admissibility-gate/gates.ts:210` (`config.hitl?.enabled !== true` passes when undefined).  
**Note:** ALBB-11 (Wave A `7798b3379`) fixed `allowlistEscalated` minting only — this split **remains open**.  
**Fix:** Align policy + document acceptEdits reality; seed CLI `hitl.enabled` or change gate semantics.

### UUX-1-04 — `apps/agent` interactive no approval loop
**Symptom:** `turn.run` only — no `resolveApproval` / `driveSessionTurn` → stall at `awaiting_approval`.  
**Evidence:** `src/apps/agent/mode-presets/interactive.ts` (~118–119).  
**Fix:** Use `driveSessionTurn` or auto-resolve with explicit non-interactive posture.

### UUX-4-01 — Heartbeat false success
**Symptom:** `binder.resume` returns `ok:false` (e.g. thread-not-found); runtime still emits `scheduler.fired`, advances fireCount, prompt lost.  
**Evidence:** `src/apps/cli/repl/heartbeat-binder.ts` (~205–212); `src/scheduler/runtime.ts` fire path; hellgate documents non-throwing fail.  
**Fix:** Inspect resume result; emit `scheduler.error`; do not advance fire on soft fail (or retry policy).

### UUX-3-01 — Background portal output tee unwired
**Symptom:** `/background reattach` / `bufferedBytes` always empty; ADR capture non-functional.  
**Evidence:** `appendOutput` only in tests; `session-loop.ts` detach registers promise only (~804–808).  
**Fix:** Tee turn stream → `entry.appendOutput` on detach; prune portal on settle/exit.

---

## High — Lies in help / chrome / session ops

### UUX-2-02 — `/help` Esc ↔ Ctrl+C inverted
**Evidence:** `src/apps/cli/help-render.ts:63` is inverted. Welcome banner footer (`welcome-banner.ts:126`) is **already correct** — only the help line is wrong.  
**Fix:** Match FSM: Esc-Esc = cancel turn; Ctrl+C = quit REPL. One-line fix + string assert vs FSM SSOT.

### UUX-2-03 — Ctrl+D advertised, unwired
**Evidence:** `help-render.ts` (~64); `raw-line-reader.ts` (~917–918) drops control chars.  
**Fix:** Implement EOF-on-empty or remove from `/help`.

### UUX-5-01 — Ghost `/compact` in context warning
**Evidence:** `src/apps/cli/context-warning.ts` (~86); no `/compact` registry entry; real verb `/summarize-now`. Hellgate pins `/compact` string.  
**Fix:** Rewrite copy + update hellgate.

### UUX-1-02 — Precompact rich approve ignored
**Evidence:** `src/apps/cli/repl/surface-compose.ts` (~382–387) `decision === "approve"` misses `{ decision: "approve", scope: … }`.  
**Fix:** Normalize `ApprovalDecisionResult`.

### UUX-4-02 — `/rewind` disk-only
**Evidence:** `rewind-cmd.ts` (~442–448) vs `rewind-conv-cmd.ts` `replaceMessages`.  
**Fix:** Swap live history after rewind (same seam as rewind-conv).

### UUX-4-03 — `/color` / `/navigate` write-only prefs
**Evidence:** `registry-surface.ts` only consumer of `readPrefs` / `preferredCwd`; theme palettes unused by renderer.  
**Fix:** Consume at boot/render, or stop printing success.

### UUX-4-04 — `/permission` ignores live mode + store
**Evidence:** `permission-explain.ts` (~249–259) hardcodes `DEFAULT_MODE`; store-aware inspector unused.  
**Fix:** Thread live permission mode + `PermissionStore`.

### UUX-4-05 — Doctor misses store-health
**Evidence:** `checkSessionStoreHealth` documented; doctor probes only `listSessions`.  
**Fix:** Wire probe + surface guidance.

### UUX-6-03 — `/rewind-tool` task leg no live swap
**Evidence:** Outcome has `messagesAfter`; slash only prints (`rewind-tool-cmd.ts`); no `replaceMessages`.  
**Fix:** Same history-swap seam as rewind-conv when mode includes task.

### UUX-6-04 — `/knobs` dual store + save gap
**Evidence:** Catalog overrides via `setCliKnobOverride`; show/save use `DEFAULT_OVERRIDES` only (`slash-commands-knobs.ts` ~329 vs ~500–534).  
**Fix:** Unify stores or document + show both; save must persist what set changed.

### UUX-6-05 — Shell bg labeled `aborted (timeout)`
**Evidence:** `src/runtime/shell.ts` (~684) → `shell-stream-painter.ts` (~90–91).  
**Fix:** Distinct event/reason for intentional detach.

### ~~UUX-6-06 — `/summarize-now` copy wrong~~ (WRONG — removed jul-10)
Copy says "next turn boundary" and the code drains exactly there (`prepareTurnIteration`). Honest copy. Real remaining gap = UUX-5-05 (no mid-tool-loop drain).

### UUX-6-07 — READ_DEDUP default-ON stale reads
**Evidence:** CLI seeds ON; hellgate pins mtime-only trust; absent from `/help` ENV_TABLE.  
**Fix:** Document in `/help`; consider content hash; or default OFF for interactive.

### UUX-3-02 / UUX-3-03 — Attach approval races / pre-handshake drop
**Evidence:** `attach-client.ts` (~154–184, ~157–158); dual readline on stdin.  
**Fix:** Pause read loop during approval; fail-closed deny if sid missing + banner.

### UUX-3-04 — Esc vs in-turn reader
**Evidence:** `in-turn-reader.ts` accumulates Esc; `turn-cancel-install.ts` Esc-Esc FSM concurrent.  
**Fix:** Single stdin owner; Esc never enters follow-up buffer when cancel FSM armed.

### UUX-3-05 / UUX-3-06 — Web notify unwired; bootstrap infinite retry
**Evidence:** `presence-probe.ts` unused by App; `App.tsx` (~471–477) unbounded retry.  
**Fix:** Wire `notify_turn_complete` + presence; cap retries + error UI.

### UUX-5-02 / UUX-5-03 / UUX-5-04 — Terminal layout cluster
**Evidence:** Timeline SCO (`timeline-panel.ts` ~40–41) vs status DEC (`status-bar.ts` ~18–24); `onResize` unwired; lane DECSTBM stdout vs status stderr.  
**Fix:** Unify cursor protocol + single DECSTBM owner + SIGWINCH.

### UUX-5-05 / UUX-5-06 — Summarize / conversation-actions gaps
**Evidence:** Drain only in `prepareTurnIteration`; web-daemon has no conversation-actions / precompact.  
**Fix:** Poll inside same-turn tool loop; web deferred approval or control-request surface.

### UUX-5-07 — Hydrate fail silent
**Evidence:** `App.tsx` (~374–385) vs deeplink resume banner.  
**Fix:** Mirror resume failed UI for auto-hydrate.

### UUX-1-05 — ask_user / MCP elicitation stdin fight
**Evidence:** Mid-turn channel fixes HITL only; elicitation still ad-hoc readline.  
**Fix:** Route through `midTurnApprovalChannel` / `askLine`.

### UUX-1-06 / UUX-1-07 — Approval verb / broker parity
**Evidence:** `runtime-context-compose.ts` inline vs deferred; `subagent-runner.ts` (~386–395).  
**Fix:** Unify deferred verbs; forward steer + scopes.

### UUX-2-05 / UUX-2-06 — `/voice` unregistered; complete hooks dead
**Evidence:** No `name: "/voice"` in registry; `slash-engine.ts` name-prefix only.  
**Fix:** Register or delete; wire arg completion or remove hooks.

### UUX-4-06 — No web thread list
**Evidence:** `fetch-handler.ts` `GET /threads`; frontend never lists.  
**Fix:** Thread picker UI or remove capability claim.

### UUX-6-08 / UUX-6-09 — Tauri send focus; rewind-conv no confirm
**Evidence:** `hotkey.rs` send vs zoom focus check; `rewind-conv-cmd.ts` immediate restore.  
**Fix:** Focus-guard send; add `--yes` / preview for rewind-conv.

### UUX-1-08 / UUX-1-09 / UUX-6-26 — Help / keybind advertising
**Evidence:** `keybindings/defaults.ts` ADVERTISING ONLY Ctrl+B; help incomplete; ENV_TABLE misses seeded gates.  
**Fix:** Align `/help` + welcome + defaults with real wiring; qualify “during turn only”.

### UUX-2-08 / UUX-2-09 / UUX-2-11 — Web false affordances / gates
**Evidence:** ObservabilityPane approvals/Retry; gates hide surfaces with no banner.  
**Fix:** One interactive approval surface; wire or remove Retry; gate status banner.

### UUX-1-11 / UUX-1-12 / UUX-1-13 — Web event / readout thinness
**Evidence:** `readout.ts` PENDING set; `TRANSCRIPT_NOOP`; 7-tag bridge.  
**Fix:** Ticket-05 accessors; decide transcript vs sidebar for `item.*`; expand bridge or capability flags.
