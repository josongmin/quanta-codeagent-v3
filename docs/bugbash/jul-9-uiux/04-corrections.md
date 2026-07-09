# Corrections & superseded claims

Pass-to-pass corrections so fixers do not re-open closed bugs.

---

## 2026-07-10 verification audit (every P0/Crit/High + all P2 checked against HEAD)

11 parallel verification agents re-read every cited code path at HEAD. All P0/Critical/High items **not listed below were CONFIRMED REAL** with current file:line evidence. The following were removed from the work queue:

### WRONG — claim misread the code (do not fix)

| ID | Why wrong |
|----|-----------|
| UUX-4-09 | Session picker DOES validate input (`session-picker.ts:68-70` checks NaN/range); invalid input closes picker, does not start a new session. |
| UUX-4-11 | `/rewind --restore-files` is NOT a safe no-op — with `QUANTA_REWIND_GIT=1` + `RewindGitPort` it performs a real git reset (`rewind-cmd.ts:329-348,442`). The destructive confirm copy is accurate. |
| UUX-6-06 | `/summarize-now` copy says "next turn boundary" and the code does exactly that (`turn-iteration.ts` drains in `prepareTurnIteration`). Copy is honest. The real gap is UUX-5-05 (no mid-tool-loop drain). |
| UUX-2-12 | No clobber found: pills paint via `paint()` → `setDefault()` (`session-setup.ts:243-286`); hint is not overwritten. |
| UUX-2-15 | No dual approval row: approval renders only via EscalationCard in ChatPanel; the session-hooks message is the same merged transcript path, not a second surface. |
| UUX-4-26 | Sidebar uses `flex-shrink-0` fixed width (`App.tsx:905`) — it does not crush chat. (Mobile collapse absence is a wishlist, not this bug.) |

### FIXED — landed by jul-9/10 ALBB waves (do not re-open)

| ID / item | Fixed by | Evidence |
|-----------|----------|----------|
| UUX-4-23 identity reminder inert | ALBB-14, Wave A `7798b3379` | `injectIdentityReminder` wired in turn-iteration.ts |
| UUX-5-30 soft budget breach + plan reject silent | ALBB-21 `354d71de9` + ALBB-20 `03e806902` | `budget_breach` AgentEvent + plan-exit rejected now emits |
| UUX-4-22 focus-chain hijacks user_prompt_submit | ALBB-20, Wave E `03e806902` | `isSyntheticUserMessage` filter in session-hooks.ts |
| MCP onServerLoadError unwired (P3, ALBB-09) | Wave B pt1 `113450319` | sink wired at composition root |
| Subagent onPersistError unwired (P3, ALBB-10) | Wave A `7798b3379` | sink on HydratingSchedulerOpts |
| fork transcriptSource unwired (P3, ALBB-16) | Wave A `7798b3379` | live-WM transcriptSource thunk |
| Bg lastTurnOutcome / stream.buffer.dropped (P3, ALBB-18/12) | Waves B/C | `droppedEvents` getter on AgentRun; abort→SSOT classifier |
| Cache metrics dead (P3, ALBB-19 #1) | Wave C decision | deferred as disproportionate — recorded won't-fix, not open work |
| Objective turns self-report-only (P3, ALBB-15) | Wave A triage | idle-continuation deleted as dead; self-report half documented as designed |
| ALBB-11 note on UUX-1-03 | Wave A fixed `allowlistEscalated` minting only | the CLI-vs-web `hitl.enabled` split itself REMAINS OPEN |

### INTENTIONAL — documented decisions, close as not-work

| ID | Decision |
|----|----------|
| UUX-3-20 | `progress_update` deliberately NOT bridged — rationale comment in `session-host-turn-event-bridge.ts:83-90` (would splice progress into streaming prose; CLI renders it separately). Final decision, not a TODO. |
| UUX-3-08 | Mid-turn route ack deliberately not rendered — "the EFFECT is the signal" comment at `turn-helpers.ts:100`. |
| UUX-1-13 | 7-tag bridge subset pinned by hellgates per ADR-0227; expanding is a protocol decision, not a bug. |
| UUX-2-14 | Deeplink resume read-only with honest banner is by design (ADR-528). Live attach = product decision. |

### Downgraded / narrowed

| ID | Correction |
|----|-----------|
| UUX-1-16 | Denominator claim WRONG (`formatSegmentedUsage` uses accurate `view.max`). Only the "not in pills" parity half remains — P3. |
| UUX-2-02 | Only `help-render.ts:63` is inverted; welcome banner footer is already correct. Fix is one line + test. |
| UUX-4-10 | Narrowed: turns rendering works in list-tui, but `cmdLs` never passes `turnsById` (`index.ts:285-287`) — wiring gap, not missing feature. |
| UUX-6-13 | `--tools=` is NOT silently dropped (passed through to RuntimeSideConversationArgs); only the no-progress-UI half is real. |
| UUX-5-13 | "(empty)" vs "disabled" framing imprecise — display is internally consistent; keep only as P3 copy polish. |
| UUX-4-03 | `/color` prefs ARE written and read back by colorCmd; unverified half = whether the renderer consumes the theme palette. Verify before wiring. |
| UUX-1-17 | statusLine DOES refresh when `refreshInterval` is set; real remainder = modelId frozen at boot + no per-turn tick default. |
| UUX-6-12 | Broker escalation worker-context claim unverified in depth after lineage-gate landings — re-scope before fixing. |
| UUX-1-25 | FC YAML drift spot-check inconclusive — re-verify before touching YAMLs. |

---

## Superseded / fixed since Pass 1 claim

### Interrupted-turn capture on signal abort (ALBB-06)
**Pass 1 claimed:** Ctrl+C / Esc-Esc abort does not capture for `/resume`.  
**Correction (Pass 2+):** Fixed. `captureAbortedTurn` runs on signal abort and turn_result abort:

- `src/agent/loop/turn-iteration.ts` (~258, ~272)
- `src/agent/loop/turn-outcome.ts` (~71)
- Ticket: `docs/plans/draft/jul-9-bugbash/tickets/06-interrupted-turn-capture.md`
- Proof: `tests/integration/interrupted-turn-signal-abort.test.ts`

**Do not** re-file as open UIUX work unless a new gap appears (e.g. richer mid-tool resume payload still deferred in ALBB-06 follow-ups).

---

## Intentional tradeoffs (not bugs — document, don’t “fix” blindly)

| Topic | Note |
|-------|------|
| `progress_update` not in session bridge | ALBB-18: bridging spliced into assistant prose. Need a dedicated progress channel. |
| Default-OFF “not wired” + exit 0 | Architectural byte-identical contract; UX still annoying — prefer better messages/exit codes without flipping defaults casually. |
| Mid-turn capture seeded ON in CLI | Approval channel coupling to capture is less painful on default CLI; still broken when capture OFF / non-CLI. |
| Deeplink resume = read-only history | Honest banner exists; product may still want live attach later. |
| 7-tag AgentEvent bridge | Inventory hellgates pin the subset; expanding is a protocol decision. |
| Mode-cycle “plan” rung visual-only | Catalog hold admits fence not applied — overclaim is the bug, not necessarily missing fence. |

---

## Duplicate IDs across passes (same root cause)

Treat as one fix:

| Cluster | IDs |
|---------|-----|
| Web prefill Enter | UUX-2-01 (covers Pass-4 “web rewind/fork never execute”) |
| False-success prefs | UUX-4-03 (`/color` + `/navigate`) |
| Snapshot ordinal | UUX-6-01 + UUX-6-02 |
| Terminal DECSTBM/SCO | UUX-5-02 + UUX-5-03 + UUX-5-04 (+ UUX-3-09 lane resize) |
| Help/keybind lies | UUX-2-02, UUX-2-03, UUX-1-08, UUX-1-09, UUX-6-26, UUX-5-01 |
| Approval optimistic / drop | UUX-2-04 (+ Pass-5 reconnect drop note) |
| Tauri send focus | UUX-3-15 / UUX-6-08 |
| Skills reload stale | UUX-2-13 / UUX-5-08 |
| Summarize timing/copy | UUX-5-05 / UUX-6-06 |

---

## Related ALBB tickets (agent-loop) with UX side-effects

Do not duplicate full ALBB work here; link when fixing UX symptoms:

| ALBB | UX angle |
|------|----------|
| 06 | Resume capture (fixed core) |
| 09 | MCP load errors silent to operators |
| 10 | Persist errors silent |
| 11 | HITL allowlistEscalated (CLI fixed; other surfaces?) |
| 14 | Identity reminder + web automation delivery |
| 16 | fork live-WM unwired |
| 18 | progress_update, bg lastTurnOutcome, SDK labels |
| 19 | cache metrics / skill cursor |
| 20 | plan reject silent, focus-chain hook, stream edges |
| 21 | soft budget breach silent |

See `docs/plans/draft/jul-9-bugbash/`.
