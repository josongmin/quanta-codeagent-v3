# Jul-10 UI/UX structural fix plan — no patch-on-patch

**Input:** [docs/bugbash/jul-9-uiux/](../bugbash/jul-9-uiux/) — 2026-07-10 verified inventory ([05-fix-queue.md](../bugbash/jul-9-uiux/05-fix-queue.md) is the item SSOT).
**Principle:** the ~120 verified findings are surface symptoms of **8 root causes**. Fix each root cause once at its owning seam (a kernel/SSOT), then land the findings as thin adoptions of that kernel. No finding gets a bespoke local patch when its class has a kernel.

Anti-goals: per-ID point fixes on shared seams; new parallel stores/channels (we already paid for knob-store and cost-system dualities); "fix the copy" where the copy should be derived.

---

## Root-cause map

Every verified finding belongs to exactly one workstream (WS). If a fix idea doesn't fit a WS, that's a signal it's a point patch — stop and re-derive.

| WS | Root cause | Symptom count |
|----|-----------|---------------|
| A | Approval decision domain is shape-divergent; every surface reimplements prompt + resolution | ~17 |
| B | N independent stdin consumers (5 `readline.createInterface` sites + FSM + in-turn reader) | ~7 |
| C | Terminal chrome has no single owner (SCO vs DEC, dual DECSTBM, zero SIGWINCH) | ~5 |
| D | Success copy not derived from effect (false success class) | ~14 |
| E | Help/keybinds/env/catalog hand-written, not derived from the registries that define reality | ~10 |
| F | Web client↔daemon has no routing/ack/connection contract | ~20 |
| G | Silent degrade + boot-frozen state (no operator-notice channel, no live-refresh seam) | ~20 |
| H | Background/detach lifecycle unowned (tee, prune, labels, consent) | ~5 |

---

## WS-A — Approval decision kernel

**Root cause.** `ConfirmDecision` exists (`src/agent/confirm-decision`) and the runtime approval-protocol controller exists (`context-binding/approval-protocol.ts`), but surfaces bypass them: strict `decision === "approve"` string checks (surface-compose.ts:387), broker forwards `{approved: boolean}` dropping steer/scope (subagent-runner.ts:394), reviewer port has no scope field (reviewer-port.ts:99-117), brain-mode mixes `onConfirm→false` with `resolveApproval→"approve"`, attach prompts y/N, apps/agent interactive passes nothing. Every one of these is a hand-rolled re-interpretation of the same domain object.

**Structural moves** (all in the existing domain, no new parallel system):

1. **One wire type + one normalizer.** `normalizeApprovalDecision(raw: unknown): ApprovalDecision` in `src/agent/confirm-decision` — the ONLY place that reads raw shapes (today `chosenGrantScope` does this ad-hoc). Every consumer (precompact prompt, deferred path, broker, reviewer, web protocol handler, attach) calls it. Grep-gate test: no `=== "approve"` / `=== "allow"` string comparison outside the normalizer.
2. **Outcome taxonomy with `aborted`.** `ApprovalOutcome = approved(by: user|guardian|policy|grant) | denied(by, steer?) | aborted(cause: cancel|background|disconnect|shutdown)`. `midTurnApprovalChannel.clear()` gains a mandatory reason and resolves pending asks as `aborted`, never silent-deny. Guardian/policy approvals emit a visible outcome event (WS-G sink renders it).
3. **PromptSpec: declare once, render everywhere.** A single builder produces the verb set (approve / deny / deny+steer / prefix-grant / hunk-select / diff / scopes) plus subject context (tool, action, diff, **requesting worker for broker escalations**). Surfaces declare capabilities (`{tty, diff, hunks, remote}`) and render the spec — CLI inline, CLI deferred, attach, web EscalationCard all consume the same spec. Verb parity stops being N hand-synced lists.
4. **Ports forward the full object.** Broker (`subagent-runner.ts`) and reviewer port pass `ApprovalDecision` through, not a boolean; scope minting stays in the one controller.
5. **hitl posture SSOT.** One `resolveHitlPosture(surfaceConfig)` interpretation point replacing the scattered `config.hitl?.enabled !== true` checks (gates.ts:210). Decision D-1 below fixes the CLI/web split semantics.
6. **Remote ack protocol.** Protocol gains `approval.decision.ack`. Web card: decision → "sending" state → dismiss on ack → re-show + toast on drop/timeout. Attach: pre-handshake `approval.requested` with `sid === undefined` → fail-closed deny + banner (never silent drop).
7. **apps/agent interactive** adopts `driveSessionTurn`/`resolveApproval` with an explicit posture arg; non-interactive posture is a declared choice, not a fallthrough.

**Covers:** UUX-1-02/03/04/05(A-half)/06/07/19/21/22, 2-04, 2-18, 2-20, 2-21, 3-02(A-half)/03/11, 6-12.
**Proof:** hellgate — inject each raw decision shape at every surface seam, assert identical normalized outcome; red-on-injection for the ack path (drop the socket mid-decision → card re-shows); abort-vs-deny pin (cancel a turn with pending ask → outcome `aborted`, agent sees abort not refusal).

## WS-B — Stdin arbiter (single owner)

> **jul-10 execution note (re-derived scope):** the full `StdinArbiter` module was
> NOT built — on re-reading the live topology, the mid-turn approval channel
> already IS the arbiter for asks, and the remaining bug surface decomposed into
> owner-seam fixes that landed instead: (1) the in-turn reader owns "a captured
> line is text" (escape/chord sequences filtered, cross-chunk); (2) the
> elicitation/ask_user prompter rides the session channel via a registry slot
> (no second mid-turn readline); (3) attach has one stdin owner (the read-loop
> iterator; approvals claim lines via the channel; pre-handshake asks wait for
> readiness instead of dropping). The lease-API arbiter remains a future option
> if a NEW stdin consumer class appears; do not add ad-hoc readline mid-turn —
> route through `currentMidTurnApprovalChannel()`.

**Root cause.** 5 production `readline.createInterface` sites (mcp-elicitation-prompter, attach-cmd, repl, runtime-context-compose, session-picker) + the Esc-Esc FSM + in-turn reader all attach independently to `process.stdin`. Every mid-turn prompt bug (blind typing, Esc leaking into buffers, attach races) is this one fact.

**Structural moves:**

1. `src/apps/cli/repl/stdin-arbiter.ts` — the ONLY raw-mode owner and the only `data` listener. API: `withLineLease(opts: {prompt, echo, mask?})`, `withKeyLease`, `subscribeChords(map)` for the FSM. Leases are exclusive + queued; a lease declares echo policy so consent reads are never blind (UUX-6-21).
2. Esc-Esc / Ctrl+C / Ctrl+B FSM becomes a standing chord subscription — chord bytes never reach a line lease's buffer (UUX-3-04), and the subscription registers its chords into the WS-E keybind registry (help derives from reality).
3. Migrate the 5 readline sites + in-turn reader + hunk picker + trust prompt onto leases. Elicitation/ask_user ride `withLineLease` — the mid-turn channel decouples from the capture wrapper (UUX-3-07): channel activation = arbiter presence, not capture-mode.
4. Grep-gate: `readline.createInterface` banned in `src/apps/cli` outside the arbiter (allowlist: none; one-shot non-REPL commands use the arbiter too).

**Covers:** UUX-3-04, 3-02(stdin-half), 1-05(stdin-half), 3-07, 6-21, 3-13(prompt-half), 5-20.
**Proof:** hellgate — during an active line lease, fire Esc-Esc: assert cancel fires AND the lease buffer contains no `\x1b`; e2e-pty (existing `tests/e2e-pty/` harness) for the attach-approval-during-read race.

## WS-C — Terminal chrome kernel

**Root cause.** timeline-panel saves cursor with SCO `ESC[s`, status-bar with DEC `ESC7`; input-lane sets DECSTBM on stdout while status-bar sets it on stderr; `onResize` exists but zero SIGWINCH handlers exist in the codebase.

**Structural moves:**

1. `src/apps/cli/terminal-chrome.ts` — owns: (a) DEC-only cursor save/restore helpers (SCO banned by grep-gate), (b) a scroll-region manager — `acquireRegion()` with exactly one active owner; a second acquirer suspends/restores the first (lane vs status-bar stop fighting), (c) the singleton SIGWINCH listener broadcasting to registered panels (timeline `onResize`, lane row recompute, status-bar width).
2. Stream policy stated once: chrome → stderr, data → stdout. The shell-live-stream TTY gate (UUX-1-20) reads this policy (stderr-TTY), not its own stdout check.

**Covers:** UUX-5-02/03/04, 3-09, 1-20, 3-10(policy-half).
**Proof:** unit — two panels acquire regions, assert suspend/restore ordering and byte-exact DEC sequences; pty e2e — resize mid-turn, assert lane row and timeline recompute.

## WS-D — Effect receipts (kill false success)

**Root cause.** Handlers print success copy that is not derived from an observed effect: `setPlan` no-op → "updated", ordinal ignored → "rewound to #N", `ok:false` swallowed → `scheduler.fired`, save persists a different store than `set` wrote.

**Structural moves:**

1. **Receipt convention:** slash handlers return `ok(effect, msg)` / `failClosed(msg, hint)`; the renderer prints success only with an effect receipt. Enforced per-command by the hellgate template "**success text while store/target unchanged ⇒ RED**" (this is the reusable proof artifact; new commands copy it).
2. **One store per concern:** knobs — collapse `DEFAULT_OVERRIDES` + `setCliKnobOverride` into ONE override store; show/save/set all read it (this is the third knob-store duality this year — see memory `knob-config-systems-inventory`; do NOT add a bridge, merge).
3. **One history-swap seam:** rewind-conv's `replaceMessages` path becomes the shared `applyLiveHistorySwap()`; `/rewind`, `/rewind-tool` (task leg), `/fork` (attach-or-print-honestly) all call it. `/rewind-conv` gains the confirm/preview the other two already have — one confirm helper, three adopters.
4. **Snapshot ordinal:** extend the shadow-odb port with `rewindToRef(ordinal)` (real fix); until the port lands, `/snapshot <N≠1>` fail-closes exit 1. Never success-copy an unsupported target. `/snapshot diff <N>` same rule.
5. **Heartbeat two-phase:** `binder.resume` result is honored — `ok:false` ⇒ no anchor advance, emit `scheduler.error` (new event, WS-G renders), bounded retry next tick. Keep persist-before-dispatch crash-safety by making it reserve→confirm.
6. **/edit-plan:** re-parse markdown → plan mutations if cheap; otherwise fail-closed "not persisted (structured plan unchanged)" exit 1. No success print from a no-op adapter.
7. **/permission /doctor /color:** thread live mode + PermissionStore into permission-explain; doctor adds the `checkSessionStoreHealth` probe; color/navigate — verify renderer consumption first (audit left this unproven), then wire or downgrade copy to "saved (applies at next boot)" honestly.
8. **Exit-code convention (D-6):** "not wired" ⇒ exit 2 + machine-greppable `hint:` line naming the gate env. One helper, all not-wired sites adopt (also feeds WS-E env hints).

**Covers:** UUX-6-01/02/18, 1-01, 4-01, 4-03, 6-04, 4-02, 6-03, 6-09, 4-04, 4-05, 4-07, 4-10, 1-28/4-27(exit-code half).
**Proof:** per-command hellgate from the template; heartbeat — inject `ok:false`, assert no fireCount advance + `scheduler.error` emitted + prompt retained.

## WS-E — Derived help & catalog (advertising = reality by construction)

**Root cause.** help-render.ts hand-writes keybinds (5 of 21, one inverted), env table (~30 rows missing CLI-seeded gates), and command references (`/compact` ghost). Hand-written mirrors always rot; the fix is derivation + parity gates, not editing the strings.

**Structural moves:**

1. **Keybind registry:** installers (FSM chord subscription, reader bindings, external-editor chord) register `{chord, action, scope: global|during-turn|line-edit}` at install time; `/help` and welcome render the registry. `keybindings/defaults.ts` "ADVERTISING ONLY" entries become impossible — an entry either has an installer or doesn't render. Ctrl+D: implement EOF-on-empty (D-2). Ctrl+B renders with scope `during-turn`.
2. **Env table derivation:** `/help` ENV = derive(RuntimeConfig knob schemas) ∪ derive(`CLI_FEATURE_GATES` seeds — each seed gains a one-line description field). Parity test: every seeded gate appears exactly once (READ_DEDUP, EXTERNAL_EDITOR, KEYBINDINGS close automatically).
3. **Command-ref helper:** copy that names a slash command uses `slashRef("summarize-now")` which test-time-validates against the registry — `/compact`-class ghosts become RED. Fix context-warning.ts:86 + its hellgate pin via this helper.
4. **Registry honesty sweep:** `/voice` register-with-degrade or delete (D-9); dead `complete:` hooks — wire arg completion or delete the field; FC YAMLs (mode-cycle plan rung, 0316 hold) and web DESIGN/README refreshed to match code (one-time, then parity where cheap).

**Covers:** UUX-2-02/03, 5-01, 1-08/09, 6-26, 6-07(doc half), 2-22, 2-23, 2-05/06/07, 1-10, 5-28, 2-16, 1-25(after re-verify).
**Proof:** parity gates (registry ↔ help ↔ welcome), `slashRef` validation test, keybind-registry hellgate: registered-but-uninstalled chord ⇒ RED.

## WS-F — Web client↔daemon contract

**Root cause.** The palette, approval card, and connection lifecycle each improvise: Enter discards action returns, dismiss precedes send, bootstrap retries forever, hydrate fails to nothing, GET /threads has no consumer.

**Structural moves:**

1. **Typed palette entries:** `{kind: 'local' | 'server-slash' | 'readout' | 'unwired'}`. Enter routes by kind — local runs, server-slash sends + echoes into transcript, readout fetches + renders, unwired renders the enable hint inline. Invariant test: **every palette entry either executes or explains; silent clear is unrepresentable.** Prefill-only entries die.
2. **ConnectionState machine:** `connecting | connected | degraded(reason) | failed(reason)` — single source driving the banner, empty-state copy, composer enablement, Stop visibility (`awaiting_approval` shows Stop — it aborts via WS-A outcome), and bootstrap retry (capped, → `failed` + retry CTA). Hydrate `!resp.ok` → `degraded` banner mirroring the resume-failed UI.
3. **Approval ack** (from WS-A move 6) — EscalationCard consumes the PromptSpec verbs (steer/scope arrive free).
4. **Observability honesty:** approvals section delegates to the same EscalationCard flow or becomes a count-link; Retry button removed until a run-control endpoint exists (D-8).
5. **Thread list:** minimal picker consuming GET /threads (D-10).
6. **Tauri:** one `withFocusGuard(hotkey)` helper; send/capture adopt (zoom already has it); capture emits a toast on success and on display-fallback.
7. **Store hygiene + polish batch** (rides the same PRs): messages[] window/cap, tool-progress completion cleanup, IME composition guard on palette Enter, focus trap on KnobsPanel, streaming markdown reflow (render streaming text through the same markdown pipe or reserve layout).

**Covers:** UUX-2-01/04(ack)/08/09/11, 4-06, 3-05/06/16/18, 5-07/14/15/17/24/25/26/29, 6-08, 2-10/17, 4-13(web half)/18/19/24/25.
**Proof:** palette invariant test (enumerate registry, assert route-or-hint per entry); ConnectionState unit table; ack e2e with dropped socket.

## WS-G — Operator-notice bus + live-state refresh

**Root cause.** Two sub-classes, one seam: (a) silent degrade — every `catch {}` in surface code swallows without telling the operator (tee, memory fallback, write-guard, compaction defer, hooks fail-open, webhook drop, preflight, replay row skip); (b) boot-frozen state — computed once at bootstrap, never refreshed (skillGate, MCP pill, statusline modelId).

**Structural moves:**

1. **`OperatorNotice` event** `{severity, source, message, hint?}` + two sinks: CLI (stderr line + status pill badge) and web (toast). ALBB-09/10 already added the error sinks at composition roots — they route here instead of growing bespoke renderers.
2. **Adoption list** (each = one-line emit at the existing catch): tee degrade, memory-search lexical fallback, memory write-guard block, compaction defer→later-drop, unapproved-hook skip, webhook 202-then-timeout, preflight internal failure, `/replay` skipped-row count, MCP server lifecycle transitions, voice-live mic failure (kills the fake listening state), OAuth completion result.
3. **Live-refresh seam:** stateful chrome subscribes instead of snapshotting — skillGate holds a swappable ref that `/reload-skills` replaces (gate + pills refresh together), MCP pill subscribes to lifecycle events (failed servers appear), statusline re-reads modelId per turn tick.

**Covers:** UUX-1-18/27, 5-08+2-13, 5-10/11/16/21(signal half)/22/23, 4-20/21, 6-16/22/23, 1-17, 4-12(hint), 2-24, 5-18/19.
**Proof:** red-on-injection per adoption (force the failure, assert a notice reached the sink); reload-skills hellgate: new skill on disk → `/reload-skills` → agent's next turn can invoke it.

## WS-H — Background/detach lifecycle

**Root cause.** The portal exposes `appendOutput` but nothing tees into it; entries never prune; intentional detach paints as `aborted (timeout)`; consent timeout silently defaults.

**Structural moves:**

1. On detach, the portal attaches a tee sink (ring buffer, byte-capped) to the live turn stream → `appendOutput`; reattach replays the buffer. Settle → completion notice (WS-G) → prune (LRU). REPL exit enumerates live entries and warns.
2. Shell observer event gains `kind: "detached"` distinct from `aborted`; painter renders "moved to background (consent timeout)" — the 60s default stays but is *announced* (D-5).
3. Ctrl+B with a pending approval → WS-A `aborted(background)`; the ask re-presents on reattach.

**Covers:** UUX-3-01/12, 6-05/20, 3-11(re-present half).
**Proof:** hellgate — detach mid-stream, reattach, assert buffered bytes non-empty and ordered; exit-with-live-bg warns.

---

## Sequencing (dependency-ordered waves)

Kernels land first so every later fix is an adoption — this is the whole anti-patch-on-patch mechanism.

```
Wave 1 — kernels (parallel, file-disjoint):
  B stdin-arbiter        C terminal-chrome      A.1-3 decision/outcome/PromptSpec
  E.1-2 registries       G.1 notice bus         F.1-2 palette+connection contracts
Wave 2 — P0/Crit riding the kernels:
  D.2-6 (knobs/rewind-seam/snapshot/heartbeat/edit-plan)
  A.4-7 adoptions (broker, reviewer, precompact normalize, apps/agent, attach fail-closed)
  F.3-5 (ack-dismiss, prefill routing, observability honesty)   H.1-2 (tee + labels)
Wave 3 — sweeps (mechanical adoptions, parallelizable):
  B migrations (5 readline sites)   C panel adoptions   E.3-4 (slashRef, registry honesty)
  G.2-3 adoption list + live-refresh   F.6-7 (tauri, hygiene)   D.7-8 (permission/doctor/exit-codes)
Wave 4 — verified P2 backlog leftovers that are pure per-site work after the sweeps
```

Rules per wave (per `hellgate-implementation-protocol` + `parallel-wave-landing-coupled-hotpath`):
- Hellgate RED **before** each kernel (the proof artifacts named per WS above), then TDD, then ≥3 adversarial audit rounds before calling a WS done.
- `bun test` does not typecheck — run `tsc` on MAIN after every land; worktree cp-land for parallel items; hard-reset staleness guard between waves; re-check HEAD before commit (concurrent sessions land on main).
- Hot shared modules (runtime-config, surface-compose) are edited sequentially, never in two parallel worktrees.
- Behavior-visible agent-loop changes (only **UUX-5-05** mid-tool-loop drain qualifies) land last, alone, with a bench smoke before/after — everything else is surface-only.

## Decision ledger (defaults chosen; veto before Wave 2)

| # | Decision | Default |
|---|----------|---------|
| D-1 | hitl split (UUX-1-03) | Always-confirm tools prompt whenever a prompt port exists, regardless of mode; `acceptEdits` auto-allows edit-class only. CLI-only behavior change; bench unaffected (bench manifests run approvals:none). |
| D-2 | Ctrl+D | Implement EOF-on-empty-line (small, standard) rather than deleting from help. |
| D-3 | Snapshot ordinal | Add `rewindToRef(ordinal)` to shadow-odb port; fail-closed interim if port work slips a wave. |
| D-4 | Heartbeat soft-fail | No anchor advance on `ok:false` + `scheduler.error` + bounded retry (keeps crash-safety via reserve→confirm). |
| D-5 | Bg consent 60s timeout | Keep default-detach, announce it explicitly (notice + distinct event kind). |
| D-6 | "not wired" exit code | exit 2 + `hint:` line. Compat note: scripts treating exit 0 as success will now see intent honestly. |
| D-7 | READ_DEDUP | Keep default-ON; document in derived env table; content-hash upgrade = separate measured follow-up. |
| D-8 | Observability Retry | Remove until a run-control endpoint exists. |
| D-9 | /voice | Register with transcriber-presence degrade message (not delete). |
| D-10 | GET /threads | Consume with a minimal picker pane (route already shipped). |

## Explicitly out of scope

Closed by the jul-10 audit (do not re-open): WRONG×6, ALBB-fixed×~10, intentional×4 — see [04-corrections.md](../bugbash/jul-9-uiux/04-corrections.md). Needs re-scoping before any work: UUX-6-12 depth, UUX-1-25 FC drift.
