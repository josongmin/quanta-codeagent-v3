# P2 — Medium findings

Grouped by theme. IDs cross-reference [00-inventory.md](./00-inventory.md).

> **2026-07-10 audit:** every row re-verified against HEAD. Struck rows are closed (reason inline; details in [04-corrections.md](./04-corrections.md)). Unstruck rows are confirmed real.

---

## A. Status chrome / pills / history

| ID | Summary | Evidence (anchor) |
|----|---------|-------------------|
| UUX-1-16 | Context % not in status pills (denominator half WRONG — `view.max` is accurate; parity half only, → P3) | `status-line.ts:65-77` |
| UUX-1-17 | StatusLine no per-turn tick; `modelId` frozen at boot | `status-line-driver.ts`, `session-setup.ts` |
| UUX-1-18 | Tee degrade / indicator swallow silent | `tee.ts`, `indicator-stream-port.ts` |
| ~~UUX-2-12~~ | ~~Esc/Ctrl+C status hint overwritten by pills~~ WRONG — no clobber | — |
| UUX-2-13 | Skills pill boot-once | `skills-surface.ts` |
| UUX-5-08 | `/reload-skills` does not refresh skillGate/pills | `render-helpers.ts`, `session-bootstrap.ts` |
| UUX-6-22 | MCP lifecycle pill boot-once; failed servers absent | `bootstrap-session.ts`, `lifecycle.ts` |
| UUX-6-23 | Follow-up pill ≠ mid-turn external queue | `turn-helpers.ts`, `turn-sinks.ts` |
| UUX-6-24 | `/history tools` clocks unwired; FIFO by tool name | `slash-surface.ts`, `history-cmd.ts` |
| UUX-1-27 | `/replay` skips bad JSONL silently | `wire-builders.ts` |

---

## B. Mid-turn / attach / background (non-P0/P1)

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-3-07 | Approval channel coupled to mid-turn capture wrapper | `turn-helpers.ts` |
| ~~UUX-3-08~~ | ~~Mid-turn route acks never rendered~~ INTENTIONAL (turn-helpers.ts:100 comment) | — |
| UUX-3-09 | Lane row frozen; no resize | `turn-helpers.ts` |
| UUX-3-10 | Lane stdout / approval stderr split | `runtime-context-compose.ts` |
| UUX-3-11 | Ctrl+B → silent approval deny | `turn-runner.ts` + channel clear |
| UUX-3-12 | Portal never pruned; exit no bg warning | `background-turn-portal.ts` |
| UUX-3-13 | Hunk picker during live stream | `runtime-context-compose.ts` |
| UUX-3-14 | Attach: no soft cancel; quiet handshake timeout | `attach-cmd.ts`, `attach-client.ts` |
| UUX-1-19 | Attach y/N-only | `attach/commands.ts` |
| UUX-1-20 | Shell stream stdout-TTY only | `repl.ts` / `bootstrap-session.ts` |
| UUX-6-20 | Bg consent 60s → default detach | `shell.ts` |
| UUX-6-21 | Mid-turn bash consent blind without visible lane | `in-turn-reader.ts` |

---

## C. Diff / checkpoint / subagent

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-6-10 | Subagent item stream only on cancel | `item-stream-projector.ts` |
| UUX-6-11 | Fleet→item only via `/activity` | `registry-surface.ts` |
| UUX-6-12 | Team-broker HITL lacks worker context | `subagent-runner.ts` |
| UUX-6-13 | `/side` no progress UI (`--tools=` half WRONG — it is passed through) | `side-cmd.ts:257-270` |
| UUX-6-14 | apply_patch / fuzzy: no hunk-select | `action-diff.ts` |
| UUX-6-15 | Hunk invalid tokens silent drop | `hunk-select.ts` |
| UUX-6-16 | Preflight internal fail silent | `preflight.ts` |
| UUX-6-17 | Per-tool needs shadow+flag; opaque not wired | `surface-compose.ts` |
| UUX-6-18 | `/snapshot diff` only #1 | `snapshot-cmd.ts` |
| UUX-1-21 | Guardian approve silent | `runtime-context-compose.ts` |
| UUX-1-22 | Cancel → approval deny not abort | `turn-helpers.ts` |
| UUX-1-23 | Side chat throw vs soft | `surface-compose.ts` |
| UUX-1-24 | Playbook empty registry | `playbook-trigger-wire.ts` |

---

## D. Web parity / gates / multimodal

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-2-10 | `/clear` copy vs local clear | `SlashPalette.tsx` |
| UUX-2-14 | Deeplink read-only history | `App.tsx`, `thread-resume.ts` |
| ~~UUX-2-15~~ | ~~Dual approval rows~~ WRONG — single EscalationCard path | — |
| UUX-2-16 | DESIGN/README stale | `DESIGN.md`, `README.md` |
| UUX-2-17 | ask_user chips flattened | `web-ask-user-port.ts` |
| UUX-3-16 | Image hotkey no toast; silent main-display fallback | `hotkey.rs`, `HotkeyToast.tsx` |
| UUX-3-17 | Hydrate non-OK silent (also P1 as UUX-5-07 for zero UI) | `App.tsx` |
| UUX-3-18 | awaiting_approval hides Stop | `StatusBar.tsx` |
| UUX-3-19 | No onboard/identity/plan posture on web | `ModeBadge.tsx` |
| UUX-4-18 | No doctor/retry/idle/context-warning on web | CLI-only surfaces |
| UUX-4-19 | Snooze copy wrong on web | `SlashPalette.tsx` |
| UUX-4-24 | No drag-drop; model slug-only | `use-image-attachment.ts` |
| UUX-4-25 | Context bar full when max unknown | `category-hues.ts` |
| ~~UUX-4-26~~ | ~~Side panels crush chat~~ WRONG — fixed-width flex-shrink-0 sidebar | — |
| UUX-5-14 | PlanPanel subset; “edit” lie | `PlanPanel.tsx` |
| UUX-5-15 | Tool-progress no completion clear | `agent-state-hooks.ts` |
| UUX-5-17 | Empty plan-input submit | `AgentStatePanel.tsx` |
| UUX-5-24 | Empty state while disconnected | `ChatPanel.tsx` |
| UUX-5-25 | Unbounded messages[] | `session-hooks.ts` |
| UUX-5-26 | Knobs focus trap / IME Enter | `KnobsPanel.tsx`, `SlashPalette.tsx` |
| UUX-5-29 | Streaming→markdown reflow | `MessageBubble.tsx` |
| UUX-6-19 | Paste PNG-only; one-shot no image queue | `paste-cmd.ts`, `repl.ts` |

---

## E. Session / auth / automation / MCP

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-4-07 | `/fork` no attach | `rewind-cmd.ts:506-509` |
| UUX-4-08 | `/resume` name collision (minor, orthogonal scopes) | `repl.ts` vs `idle-monitor.ts` |
| ~~UUX-4-09~~ | ~~Picker silent fail~~ WRONG — picker validates input | — |
| UUX-4-10 | `cmdLs` never passes `turnsById` → turns blank in rich list | `session-ops/index.ts:285-287` |
| ~~UUX-4-11~~ | ~~restore-files no-op + scary confirm~~ WRONG — real gated git reset, copy accurate | — |
| UUX-4-12 | Post-login manual provider | `login-cmd.ts` |
| UUX-4-13 | Web OAuth no completion signal | `auth-routes.ts`, `slash-auth.ts` |
| UUX-4-14 | MCP read-only / empty resources | `mcp-cmd.ts`, `mcp-resources-cmd.ts` |
| UUX-4-15 | Migration one-click overpromise | `config-migration-notice.ts` |
| UUX-4-16 | cron create title=prompt | `cron-cmd.ts` |
| UUX-4-17 | inbox deeplink null on web | `thread-deeplink.test.ts` |
| UUX-4-20 | Hooks held fail-open | `command-hooks/runner.ts` |
| UUX-4-21 | knobs preset drops warnings | `slash-commands-knobs.ts` |
| ~~UUX-4-22~~ | ~~Focus-chain → hook as user prompt~~ FIXED — ALBB-20 Wave E | 03e806902 |
| ~~UUX-4-23~~ | ~~Identity reminder inert~~ FIXED — ALBB-14 Wave A | 7798b3379 |
| UUX-5-09 | `/dream` not wired without auto-dream | `registry-app.ts` |
| UUX-5-10 | Memory search silent fallback | `memory-cmd.ts` |
| UUX-5-11 | Write-guard invisible | `memory-tools.ts` |
| UUX-5-18–20 | Trust / welcome / stdout trust prompt | `welcome-banner.ts`, `mcp.ts`, `apps/agent` |
| UUX-5-21 | Voice-live UX gaps | `voice-live-cmd.ts`, `voice-live-wire.ts` |
| UUX-5-22 | probe --failed mislabel | `probe/index.ts` |
| UUX-5-23 | Webhook 202 then drop | `webhook-server-setup.ts` |
| UUX-2-21 | Headless onConfirm/resolveApproval split | `headless/`, `brain-mode.ts` |
| UUX-2-22 | not-wired without env hint | various slash cmds |
| UUX-2-23 | Welcome incomplete | `welcome-banner.ts` |
| UUX-2-24 | Inbox banner vs slash gates | `session-loop.ts` |

---

## F. Compaction / memory / plan (medium)

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-5-12 | Working-state formatters dead | `working-state-panel.ts` |
| UUX-5-13 | `/state` empty vs disabled | `dispatch.ts` |
| UUX-5-16 | Compaction defer silent | `compaction.ts` |
| UUX-2-18 | Empty steer → plain deny | CLI + EscalationCard |
| UUX-2-19 | Plan-exit infinite loop | `session-host-ports.ts` |
| UUX-2-20 | Reviewer loses allow scope | `reviewer-port.ts` |
| UUX-1-15 | Spinner-stall / progress UI unwired | `spinner-stall/`, FC hold |
| ~~UUX-3-20~~ | ~~progress_update not bridged~~ CLOSED — documented final decision (bridge.ts:83-90) | — |

---

## G. Shell / LSP / knobs / opaque errors

| ID | Summary | Evidence |
|----|---------|----------|
| UUX-6-25 | @ symbols uppercase-only; LSP fail empty | `symbol-list.ts`, `provider.ts` |
| UUX-6-26 | `/help` ENV incomplete vs CLI seeds | `help-render.ts`, `index.ts` |
| UUX-6-27 | `/voice` capture exit 0 no transcriber | `voice-cmd.ts` |
| UUX-6-28 | Opaque tool errors | `projects-kb/tool.ts`, `pty/tools.ts`, `mcp_resources/render.ts` |
| UUX-6-29 | settings.json hooks without trust gate | `docs/tickets/misc-jun-7/05-…` |
| UUX-1-25 | FC statusLine / turn-summary drift | feature YAMLs |
| UUX-5-27 | mode/plan naming collisions | ModeBadge / AgentStatePanel / mode-cycle |
| UUX-5-28 | Catalog overclaims | `mode-cycle-pill.yaml`, `0316-…yaml` |
| UUX-1-26 | Korean escalation on CLI | `stdout.ts` |
| ~~UUX-5-30~~ | ~~Soft budget / plan reject silent~~ FIXED — Waves B pt2 + E | 354d71de9, 03e806902 |

---

## H. Approval / HITL medium leftovers

| ID | Summary |
|----|---------|
| UUX-1-28 | Many default-OFF “not wired” exit 0 (pattern) |
| UUX-2-07 | `/image` help vs completer |
| UUX-3-15 | Tauri hotkey focus (also High as UUX-6-08 for send) |
