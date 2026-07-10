# Recommended fix queue (verified 2026-07-10)

Every item below was re-verified against HEAD on 2026-07-10 (see [04-corrections.md](./04-corrections.md) for what was removed). One invariant per PR when possible. Prefer fail-closed or honest messaging over silent success.

> **STATUS (jul-10 night, final):** Waves A–F of this queue + the verified P2
> backlog are **LANDED** (~35 commits on main, hellgate RED-first + 12 audit
> rounds; see docs/plans/jul-10-uiux-structural-fixes.md and the memory ledger).
> Remaining OPEN, with reasons: UUX-1-11/12/14 readout+bridge (protocol
> decisions), UUX-4-18 web parity gaps (feature work), UUX-4-14 /mcp mutation
> (feature), UUX-5-27 naming (churn), UUX-3-10/3-13 stream-interleave chrome +
> UUX-1-20 stream policy (deep chrome, deferred by WS-C), UUX-4-07 /fork attach
> (session-switch semantics), UUX-6-13 /side progress UI. UUX-3-07 re-analyzed
> BENIGN post-WS-B: capture OFF ⇒ no in-turn stdin owner ⇒ the ad-hoc readline
> has no one to fight.
>
> **Execution plan:** do NOT fix these ID-by-ID. The structural plan [docs/plans/jul-10-uiux-structural-fixes.md](../../plans/jul-10-uiux-structural-fixes.md) groups every item under 8 root-cause workstreams (kernels first, then adoptions) — work from there; this file remains the item-level checklist.

## Wave A — false success / wrong target (ship-blocking UX)

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 1 | UUX-6-01, UUX-6-02 | `/snapshot <N>`: real ordinal rewind or refuse N≠last with exit 1 | snapshot-cmd.ts:301 always rewindToLast/Verified |
| 2 | UUX-4-01 | Heartbeat: honor `ok:false` → `scheduler.error`; don't advance anchor on soft fail | heartbeat-binder.ts:145-175; runtime.ts:281 fires after anchor advanced |
| 3 | UUX-1-01 | `/edit-plan`: persist or fail closed | plan-edit-adapter.ts:50-56 `setPlan` is a literal no-op |
| 4 | UUX-2-01 | Web prefill Enter: apply draft / route / never silent clear | App.tsx:596-598 action return explicitly ignored |
| 5 | UUX-2-04 | Approval: ack-then-dismiss / re-show on drop | App.tsx:334-341 dismiss before send; client drops when socket not open |
| 6 | UUX-6-04 | `/knobs` unify show/save with actual overrides | slash-commands-knobs.ts:329 vs 500-534 dual stores |
| 7 | UUX-4-03 | `/color`+`/navigate`: verify renderer consumes prefs; wire or stop claiming success | prefs written+read back by cmd; renderer consumption unverified |

## Wave B — help / chrome lies

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 8 | UUX-2-02, UUX-2-03 | `/help` Esc/Ctrl+C truth (one inverted line, help-render.ts:63 — welcome is already correct); Ctrl+D implement or remove | raw-line-reader drops all control chars |
| 9 | UUX-5-01 | Context warning: `/summarize-now` not `/compact` (+ update hellgate pin) | context-warning.ts:86 literal "/compact"; no such command |
| 10 | UUX-6-05 | Shell intentional bg detach: distinct label, not `aborted (timeout)` | shell.ts:684 → shell-stream-painter.ts:91 |
| 11 | UUX-1-08, UUX-1-09, UUX-6-26 | Keybind/ENV advertising = reality (help shows 5 of 21 binds; ENV_TABLE omits QUANTA_READ_DEDUP / QUANTA_EXTERNAL_EDITOR / QUANTA_KEYBINDINGS) | keybindings/defaults.ts:56 "ADVERTISING ONLY" |
| 12 | UUX-6-07 | ~~READ_DEDUP~~ DONE jul-10: /help row (W-E) + content-hash truth (S3) | was mtime-only trust |

## Wave C — terminal / mid-turn / attach

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 13 | UUX-3-01 | Background `appendOutput` stream tee + portal prune (UUX-3-12) | session-loop.ts:804-808 detach never wires appendOutput |
| 14 | UUX-5-02–04 | Unify SCO/DEC cursor save + single DECSTBM owner + SIGWINCH (also UUX-3-09, UUX-5-03) | timeline SCO vs status-bar DEC; zero SIGWINCH handlers in codebase |
| 15 | UUX-3-02, UUX-3-03 | Attach: pause stdin on approval; fail-closed on pre-handshake sid=undefined | attach-client.ts:154-184, 157-158 |
| 16 | UUX-3-04 | Single stdin owner: Esc-Esc FSM vs in-turn reader | both attach independent data listeners |
| 17 | UUX-5-05 | Drain conversation-actions inside same-turn tool loop | poll only in prepareTurnIteration (outer boundary) |

## Wave D — session / permission / HITL

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 18 | UUX-4-02, UUX-6-03 | `/rewind` + `/rewind-tool` live history swap (same seam as rewind-conv) | rewind-cmd.ts:442 disk-only; rewind-tool prints messagesAfter, never swaps |
| 19 | UUX-6-09 | `/rewind-conv`: add confirm/preview (destructive, currently immediate) | rewind-conv-cmd.ts:142-147 |
| 20 | UUX-4-04 | `/permission` live mode + PermissionStore | permission-explain.ts:249,259 hardcodes DEFAULT_MODE |
| 21 | UUX-1-03, UUX-1-05, UUX-1-02 | HITL align (hitl.enabled split REMAINS post-ALBB-11); elicitation onto mid-turn channel (still ad-hoc readline, mcp-elicitation-prompter.ts:101); precompact normalize `{decision:"approve",scope}` | gates.ts:210; surface-compose.ts:387 strict === |
| 22 | UUX-1-04 | `apps/agent` interactive approval loop | interactive.ts:119 bare turn.run |
| 23 | UUX-4-05 | Doctor ← `checkSessionStoreHealth` | default-probes.ts:106-115 only listSessions |
| 24 | UUX-1-06, UUX-1-07 | Deferred approval verb parity; broker forwards steer + scopes | subagent-runner.ts:394 drops steer |
| 25 | UUX-1-22, UUX-3-11 | Turn cancel / Ctrl+B: pending approval → abort, not silent deny | turn-helpers.ts:119 clear() in finally |

## Wave E — web / Tauri operator signal

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 26 | UUX-3-05, UUX-3-06 | Wire presence-probe notify; cap bootstrap retries + error UI | presence-probe.ts zero call sites; App.tsx:1025-1048 unbounded |
| 27 | UUX-5-07, UUX-5-24 | Hydrate-fail banner; connection-aware empty state | App.tsx:376 `if (!resp.ok) return` silent |
| 28 | UUX-4-06, UUX-2-11 | Thread-list UI (GET /threads unconsumed) and/or gate banners | fetch-handler.ts:113-119 |
| 29 | UUX-6-08 | Tauri send/capture hotkey focus guard (zoom already has one) | hotkey.rs:111-136 vs 190-196 |
| 30 | UUX-2-08, UUX-2-09 | Approvals in ObservabilityPane read-only + Retry never wired: unify or remove | ObservabilityPane.tsx:190-227; onRetryRun never passed |
| 31 | UUX-3-18 | Show Stop during `awaiting_approval` | StatusBar.tsx:63 running-only |

## Wave F — skills / catalog honesty

| # | ID(s) | Work | Verified anchor |
|---|-------|------|-----------------|
| 32 | UUX-5-08, UUX-2-13 | `/reload-skills` refreshes live skillGate + pills (currently display-only) | session-bootstrap.ts:164 gate frozen at boot |
| 33 | UUX-2-05, UUX-1-10 | `/voice` register-or-delete; voice cancel honest exit | handler exists, zero registry entries |
| 34 | UUX-5-28, UUX-2-16 | Refresh FC YAML (mode-cycle plan rung, 0316 hold) + web DESIGN/README (hover retry/edit unimplemented) | DESIGN.md:24 vs MessageBubble copy-only |

---

## Verified P2 backlog (real, below the queue)

All re-verified REAL at HEAD; pick up opportunistically or when touching the file:

- **Chrome/history:** UUX-6-22 (MCP pill boot-once), UUX-6-23 (follow-up pill desync), UUX-6-24 (/history tools FIFO-by-name mismatch), UUX-1-27 (/replay silent JSONL skip), UUX-1-17 (modelId frozen at boot), UUX-1-18 (indicator port double-swallow).
- **Mid-turn/attach:** UUX-3-07 (approval channel needs capture wrapper), UUX-3-10/13 (stderr prompt vs stdout stream interleave), UUX-3-14 (attach quiet timeout, no soft cancel), UUX-1-19 (attach y/N-only), UUX-1-20 (shell stream stderr-TTY gate), UUX-6-20 (60s consent → default detach), UUX-6-21 (blind consent read when lane off).
- **Subagent/diff:** UUX-6-10/11 (item stream only on cancel; pump only via /activity), UUX-6-13 (no progress UI — `--tools=` half was wrong), UUX-6-14/15 (apply_patch no hunk-select; invalid tokens dropped), UUX-6-16 (preflight silent), UUX-6-17 (dual-flag checkpoint opaque), UUX-1-23 (side chat hard-throw), UUX-1-24 (playbook empty registry), UUX-1-21 (guardian approve silent).
- **Compaction/plan:** UUX-5-16 (defer silent), UUX-2-18 (empty steer → plain deny, EscalationCard.tsx:72-76), UUX-2-19 (plan-exit infinite loop, no cancel), UUX-2-20 (reviewer port drops allow scope), UUX-5-12 (dead formatters — delete or wire).
- **Web parity:** UUX-2-10 (/clear local-only copy), UUX-2-17 (ask_user chips flattened), UUX-4-19 (snooze copy wrong), UUX-4-24 (no drag-drop; /model slug-only), UUX-4-25 (unknown max → full bar), UUX-5-14 (PlanPanel "edit" lie), UUX-5-15 (progress no completion clear), UUX-5-17 (empty submit), UUX-5-25 (messages[] unbounded), UUX-5-26 (no focus trap; no IME guard), UUX-5-29 (plain→markdown reflow), UUX-6-19 (paste PNG-only), UUX-4-18 (doctor/idle/context-warning parity), UUX-3-16 (capture silent fallback).
- **Auth/automation/MCP:** UUX-4-12 (manual QUANTA_PROVIDER after login), UUX-4-13 (OAuth no completion signal), UUX-4-14 (/mcp read-only; resources no guidance), UUX-4-15 (migration overpromise), UUX-4-16 (cron title=prompt), UUX-4-20 (hooks fail-open silent), UUX-4-21 (preset warnings dropped), UUX-5-09 (/dream no hint), UUX-5-10 (memory silent lexical fallback), UUX-5-11 (write-guard invisible), UUX-5-21 (voice-live mic-fail fake listening), UUX-5-22 (probe --failed mislabel), UUX-5-23 (webhook 202-then-drop), UUX-2-22 ("not wired" without env hint), UUX-2-23 (welcome omits Shift+Tab/@), UUX-2-24 (/inbox double-gate), UUX-5-18/19/20 (trust posture invisible), UUX-4-07 (/fork no attach), UUX-4-10 (cmdLs never passes turnsById), UUX-2-21 (headless onConfirm/resolveApproval split), UUX-2-06/07 (dead complete: hooks; /image completion), UUX-1-11/12/14 (readout stubs; stream-json subset), UUX-1-15 (spinner-stall detector unwired to UI), UUX-5-27 (mode/plan naming).

Needs re-scoping before work (verification inconclusive): UUX-6-12 (broker worker-context), UUX-1-25 (FC YAML drift).

## Suggested PR naming

`fix(uiux): <id> <short why>`

## Proof expectations

- Prefer hellgate / e2e that **fails if success message returns while store/target unchanged**.
- For help/copy: snapshot or string assert against FSM/welcome SSOT.
- For web slash: assert Enter either mutates draft, hits readout, or shows error — never empty clear with no side effect.
- For heartbeat/snapshot: assert soft-fail paths emit error events / exit ≠ 0.
