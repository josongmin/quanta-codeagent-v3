# Full inventory index (passes 1–6)

IDs are stable for this bugbash: `UUX-{pass}-{nn}`. Severity is the final consolidated grade (after cross-pass corrections).

> **2026-07-10 audit:** all P0/Crit/High + all P2 re-verified against HEAD. Struck-through rows are closed (WRONG / FIXED-by-ALBB / INTENTIONAL) — reasons in [04-corrections.md](./04-corrections.md). Unstruck rows are confirmed real work.

## Pass 1 — CLI / HITL / streaming

| ID | Sev | Title |
|----|-----|-------|
| UUX-1-01 | P0 | `/edit-plan` `setPlan` no-op but prints success |
| UUX-1-02 | P0 | Pre-compaction rich approve ignored (`decision === "approve"` strict) |
| UUX-1-03 | Crit | CLI vs web `hitl.enabled` split (CLI auto-allows always-confirm under acceptEdits) |
| UUX-1-04 | Crit | `apps/agent` interactive: no `resolveApproval` / `driveSessionTurn` → hang |
| UUX-1-05 | P1 | `ask_user` / MCP elicitation not on mid-turn approval channel (stdin fight) |
| UUX-1-06 | P1 | Inline vs deferred CLI approval verb parity (steer/prefix/hunk/diff missing deferred) |
| UUX-1-07 | P1 | Team broker drops `deny_and_steer` steer + collapses allow scopes |
| UUX-1-08 | P1 | Ctrl+B advertising-only in keybind map (reader has no branch) |
| UUX-1-09 | P1 | `/help` keybinds incomplete vs production chords |
| UUX-1-10 | P1 | `/voice cancel` intentional no-op exit 0 |
| UUX-1-11 | P1 | Web readout stubs (9 pending host accessors) |
| UUX-1-12 | P1 | Web transcript NOOP for `item.*` / `artifact.ready` |
| UUX-1-13 | P1 | Session bridge only 7 `AgentEvent` types |
| UUX-1-14 | P1 | Headless `stream-json` drops most events |
| UUX-1-15 | P1 | Progress tool / spinner-stall detector unwired to CLI UI |
| UUX-1-16 | P2 | Context % only via `/context`, not status pills; denominator misleading |
| UUX-1-17 | P2 | Scriptable statusLine no per-turn refresh; modelId frozen at boot |
| UUX-1-18 | P2 | TeeStream degrade silent; timeline/indicator swallow errors |
| UUX-1-19 | P2 | Attach approval y/N-only (no diff/escalation) |
| UUX-1-20 | P2 | Shell live stream gated on stdout TTY only |
| UUX-1-21 | P2 | Guardian auto-approve silent by default |
| UUX-1-22 | P2 | Turn cancel clears pending approval → silent deny (not abort) |
| UUX-1-23 | P2 | Side chat hard-throw vs soft “not wired” |
| UUX-1-24 | P2 | Playbook trigger empty registry |
| UUX-1-25 | P2 | Feature catalog drift (statusLine / turn-summary defaults) |
| UUX-1-26 | P2 | Escalation card Korean copy in English CLI |
| UUX-1-27 | P2 | `/replay` silently skips bad JSONL rows |
| UUX-1-28 | P3 | Default-OFF gates → “not wired” without enable hints (many) |

> **Corrected:** Pass-1 claim that Ctrl+C interrupt is never captured for `/resume` was **wrong** — ALBB-06 landed (`captureAbortedTurn` on signal abort). See [04-corrections.md](./04-corrections.md).

## Pass 2 — Web deep / slash / help

| ID | Sev | Title |
|----|-----|-------|
| UUX-2-01 | P0 | Web prefill slash Enter: action return discarded → silent clear |
| UUX-2-02 | P0 | `/help` inverts Esc-Esc vs Ctrl+C (opposite of FSM + welcome) |
| UUX-2-03 | P0 | Ctrl+D advertised; raw-line-reader drops control chars (no EOF) |
| UUX-2-04 | P0 | Web optimistic approval dismiss; send can no-op if `sessionId` null |
| UUX-2-05 | P1 | `/voice` handler exists but not registered (only `/voice-live`) |
| UUX-2-06 | P1 | Per-command slash `complete:` hooks dead (name-prefix only) |
| UUX-2-07 | P1 | `/image` in help virtual list but not tab-completable |
| UUX-2-08 | P1 | Observability sidebar pending approvals read-only (false affordance) |
| UUX-2-09 | P1 | Observability Retry button UI never wired (`onRetryRun` absent) |
| UUX-2-10 | P1 | `/clear` copy vs local-only transcript clear |
| UUX-2-11 | P1 | Feature gates hide Plan/ask-user/canvas/item-stream/DB with no in-app banner |
| ~~UUX-2-12~~ | ~~P1~~ | ~~Status-bar Esc/Ctrl+C hint overwritten by pills immediately~~ WRONG — no clobber, pills paint via setDefault |
| UUX-2-13 | P1 | Skills pill loaded once; `/reload-skills` does not refresh pills |
| UUX-2-14 | P1 | Web deeplink resume = read-only history (not live attach) |
| ~~UUX-2-15~~ | ~~P2~~ | ~~Dual approval: transcript system row + EscalationCard~~ WRONG — single EscalationCard path |
| UUX-2-16 | P2 | DESIGN.md hover retry/edit unimplemented; README v1 boundaries stale |
| UUX-2-17 | P2 | Web ask_user chip metadata flattened |
| UUX-2-18 | P2 | Empty steer on deny+steer → plain deny (CLI + web) |
| UUX-2-19 | P2 | Plan-exit invalid input loops forever (no /cancel token) |
| UUX-2-20 | P2 | Reviewer port loses allow scope |
| UUX-2-21 | P2 | Headless/terminal-brain onConfirm false vs resolveApproval approve split-brain |
| UUX-2-22 | P2 | “not wired” messages missing env hints (`/background`, `/browser-net`, …) |
| UUX-2-23 | P2 | Welcome omits default-on affordances (Shift+Tab, @, Ctrl+B when wired) |
| UUX-2-24 | P2 | Automation `/inbox` double-gated vs banner |
| UUX-2-25 | P3 | Mixed-locale UI (Stop/hotkey Korean) |

## Pass 3 — Attach / mid-turn / background / Tauri

| ID | Sev | Title |
|----|-----|-------|
| UUX-3-01 | Crit | Background portal `appendOutput` never called in production (reattach empty) |
| UUX-3-02 | P1 | Attach approval stdin races main read loop |
| UUX-3-03 | P1 | Pre-handshake `approval.requested` silently dropped (`sid === undefined`) |
| UUX-3-04 | P1 | Esc-Esc FSM fights in-turn reader (Esc injected into follow-up buffer) |
| UUX-3-05 | P1 | Web OS turn-complete notify fully unwired (`presence-probe` unused by App) |
| UUX-3-06 | P1 | Bootstrap config retry unbounded; UI stuck on “Connecting…” |
| UUX-3-07 | P1 | Mid-turn approval channel only activated inside capture wrapper |
| ~~UUX-3-08~~ | ~~P2~~ | ~~Mid-turn route acks computed but never shown~~ INTENTIONAL — "the EFFECT is the signal" (turn-helpers.ts:100) |
| UUX-3-09 | P2 | Input lane row frozen at first keystroke (no SIGWINCH) |
| UUX-3-10 | P2 | Lane stdout vs approval stderr split |
| UUX-3-11 | P2 | Ctrl+B backgrounds → pending approval silent deny |
| UUX-3-12 | P2 | Portal Map never pruned; REPL exit no bg cancel warning |
| UUX-3-13 | P2 | Hunk picker while stream+lane continue |
| UUX-3-14 | P2 | Attach: no Esc-Esc soft cancel; handshake timeout quiet |
| UUX-3-15 | P2 | Tauri send/capture hotkey no focus guard (zoom has it) |
| UUX-3-16 | P2 | Image-capture hotkey no toast; window-pick failure → main display silent |
| UUX-3-17 | P2 | Transcript hydrate `!resp.ok` silent |
| UUX-3-18 | P2 | `awaiting_approval` hides Stop button |
| UUX-3-19 | P2 | Web no `/onboard` / identity switch; no plan permission posture |
| ~~UUX-3-20~~ | ~~P2~~ | ~~progress_update deliberately not bridged to web~~ CLOSED — documented final decision (bridge.ts:83-90) |
| UUX-3-21 | P3 | ThreadDeeplinkBanner fallback “not wired” when `onOpen` absent |

## Pass 4 — Session / auth / automation / false-success prefs

| ID | Sev | Title |
|----|-----|-------|
| UUX-4-01 | Crit | Heartbeat `binder.resume` `ok:false` ignored → `scheduler.fired` false success |
| UUX-4-02 | P1 | `/rewind` truncates disk only; live REPL history stale |
| UUX-4-03 | P1 | `/color` + `/navigate` write prefs nothing reads |
| UUX-4-04 | P1 | `/permission` always `DEFAULT_MODE="default"`; ignores store |
| UUX-4-05 | P1 | `/doctor` never calls `checkSessionStoreHealth` |
| UUX-4-06 | P1 | Daemon `GET /threads` exists; web has no thread-list UI |
| UUX-4-07 | P2 | `/fork` mints ID but does not attach/switch |
| UUX-4-08 | P2 | `/resume` naming collision (session vs snooze) |
| ~~UUX-4-09~~ | ~~P2~~ | ~~Session picker silent invalid input → new session~~ WRONG — picker validates (session-picker.ts:68-70) |
| UUX-4-10 | P2 | Rich list `turns`/`sort=size` never populated |
| ~~UUX-4-11~~ | ~~P2~~ | ~~`/rewind --restore-files` safe no-op with destructive confirm copy~~ WRONG — gated but real git reset; copy accurate |
| UUX-4-12 | P2 | Login success requires manual `QUANTA_PROVIDER=chatgpt-oauth` |
| UUX-4-13 | P2 | Web OAuth: no completion poll; post-URL failures warn-only |
| UUX-4-14 | P2 | `/mcp` read-only; `/mcp-resources` empty without guidance |
| UUX-4-15 | P2 | Config migration “one-click” needs second env + different command |
| UUX-4-16 | P2 | `/cron create` duplicates title as prompt |
| UUX-4-17 | P2 | `quanta://inbox/{id}` unsupported on web |
| UUX-4-18 | P2 | Web missing doctor/retry-with/reject-counter/idle/context-warning |
| UUX-4-19 | P2 | Web snooze descriptions claim “background tasks” (CLI = new-turn gate) |
| UUX-4-20 | P2 | Unapproved hooks fail-open with no surface signal |
| UUX-4-21 | P2 | `/knobs preset` discards hot-toggle warnings |
| ~~UUX-4-22~~ | ~~P2~~ | ~~Focus-chain synthetic user hijacks `user_prompt_submit`~~ FIXED — ALBB-20 Wave E (03e806902) |
| ~~UUX-4-23~~ | ~~P2~~ | ~~Identity per-turn reminder inert~~ FIXED — ALBB-14 Wave A (7798b3379) |
| UUX-4-24 | P2 | Web no image drag-drop; `/model` slug-only vs CLI picker |
| UUX-4-25 | P2 | Context `max<=0` renders full bar “? Full” |
| ~~UUX-4-26~~ | ~~P2~~ | ~~Side panels crush chat~~ WRONG — sidebar is flex-shrink-0 fixed width (App.tsx:905) |
| UUX-4-27 | P3 | `/onboard` not wired exit 0; doctor warn exit 0 |

## Pass 5 — Memory / paint / compaction / empty-state

| ID | Sev | Title |
|----|-----|-------|
| UUX-5-01 | P1 | Context warning cites nonexistent `/compact` (real: `/summarize-now`) |
| UUX-5-02 | P1 | Timeline uses SCO cursor save; status-bar uses DEC (VSCode leak) |
| UUX-5-03 | P1 | Timeline `onResize` never wired; no SIGWINCH |
| UUX-5-04 | P1 | Mid-turn lane DECSTBM on stdout + status-bar on stderr (dual owners) |
| UUX-5-05 | P1 | `/summarize-now` drained only at outer turn boundary (not mid tool-loop) |
| UUX-5-06 | P1 | Web: no `onPreCompact` / conversation-actions surface |
| UUX-5-07 | P1 | Page-reload transcript hydrate fails with zero UI |
| UUX-5-08 | P2 | `/reload-skills` display-only (skillGate + pills stale until restart) |
| UUX-5-09 | P2 | `/dream` registered but unwired without `QUANTA_AUTO_DREAM` |
| UUX-5-10 | P2 | `/memory search` silent lexical fallback on embedder fail |
| UUX-5-11 | P2 | Memory write-guard blocks invisible to operator |
| UUX-5-12 | P2 | Working-state transient/summary formatters dead (tests only) |
| UUX-5-13 | P2 | `/state` shows “(empty)” when feature OFF (not “disabled”) |
| UUX-5-14 | P2 | Web PlanPanel ⊂ CLI; palette “Show / edit” but `/plan` show-only |
| UUX-5-15 | P2 | Web tool-progress accumulates without completion cleanup |
| UUX-5-16 | P2 | Compaction defer silent (no follow-up notice) |
| UUX-5-17 | P2 | Plan-input Submit allows empty answers |
| UUX-5-18 | P2 | Welcome omits trust / untrusted-envelope posture |
| UUX-5-19 | P2 | MCP central-config non-interactive trust drop (slog only) |
| UUX-5-20 | P2 | Trust prompt on stdout vs REPL chrome on stderr |
| UUX-5-21 | P2 | Voice-live: no control legend; mic fail → fake listening; transcript corrupts REPL |
| UUX-5-22 | P2 | `probe --failed` treats missing summary as all-failed |
| UUX-5-23 | P2 | Webhook 202 then publish timeout drop |
| UUX-5-24 | P2 | Empty state “Start a conversation” while disconnected |
| UUX-5-25 | P2 | Web `messages[]` unbounded growth |
| UUX-5-26 | P2 | KnobsPanel aria-modal without focus trap; SlashPalette Enter no IME guard |
| UUX-5-27 | P2 | “mode” / “plan” naming collisions across surfaces |
| UUX-5-28 | P2 | Catalog: mode-cycle plan rung visual-only but `cli: full`; 0316 hold stale |
| UUX-5-29 | P2 | Web streaming plain→markdown reflow jump |
| ~~UUX-5-30~~ | ~~P3~~ | ~~ALBB-21 soft budget breach discarded; ALBB-20 plan reject silent~~ FIXED — Waves B pt2 + E |

## Pass 6 — Subagent / snapshot / knobs / shell

| ID | Sev | Title |
|----|-----|-------|
| UUX-6-01 | P0 | `/snapshot <N>` confirm/success uses N but always `rewindToLast`/`Verified` |
| UUX-6-02 | P0 | `/snapshot <N> <file>` partial restore also ignores N |
| UUX-6-03 | P1 | `/rewind-tool` task leg never swaps live REPL transcript |
| UUX-6-04 | P1 | `/knobs` dual stores; save persists only runner `DEFAULT_OVERRIDES` |
| UUX-6-05 | P1 | Shell intentional background painted as `aborted (timeout)` |
| ~~UUX-6-06~~ | ~~P1~~ | ~~`/summarize-now` copy says "next turn boundary" but acts on current poll~~ WRONG — copy matches code; real gap = UUX-5-05 |
| UUX-6-07 | P1 | `QUANTA_READ_DEDUP` default-ON; mtime-trust stale reads; absent from `/help` ENV |
| UUX-6-08 | P1 | Tauri send hotkey global without focus guard |
| UUX-6-09 | P1 | `/rewind-conv` restores with no confirm |
| UUX-6-10 | P2 | Subagent item stream only on cancel (not live) |
| UUX-6-11 | P2 | Fleet→item pump only via `/activity` |
| UUX-6-12 | P2 | Team-broker escalation lacks worker context in HITL |
| UUX-6-13 | P2 | `/side` blocks with no progress UI; `--tools=` silent drop |
| UUX-6-14 | P2 | `apply_patch` / fuzzy edit: no hunk-select, no explanation |
| UUX-6-15 | P2 | Hunk picker silently drops invalid tokens |
| UUX-6-16 | P2 | Preflight internal failures silent |
| UUX-6-17 | P2 | Per-tool checkpoint needs both env flags; “not wired” opaque |
| UUX-6-18 | P2 | `/snapshot diff <N>` only #1; other N exit 0 deferral |
| UUX-6-19 | P2 | `/paste` image PNG-only; one-shot disables image queue |
| UUX-6-20 | P2 | Background consent 60s timeout defaults to detach |
| UUX-6-21 | P2 | Mid-turn bash consent via non-echoing reader when lane off |
| UUX-6-22 | P2 | MCP lifecycle pill boot-once; failed servers invisible |
| UUX-6-23 | P2 | Follow-up pill ≠ mid-turn external queue |
| UUX-6-24 | P2 | `/history tools` clocks unwired / tool-name FIFO mismatch |
| UUX-6-25 | P2 | @-mention symbols require uppercase-leading; LSP fail → empty |
| UUX-6-26 | P2 | `/help` omits many CLI-seeded gates; Ctrl+X Ctrl+E shown as opt-in |
| UUX-6-27 | P2 | `/voice` exit 0 after capture with no transcriber |
| UUX-6-28 | P2 | Opaque tool errors (project_search kind-only, PTY codes, MCP generic) |
| UUX-6-29 | P2 | Repo-local settings hooks without project-trust gate (ticket 05) |
| UUX-6-30 | P3 | Capture picks first non-Quanta window not frontmost; sidecar fail → main display |
