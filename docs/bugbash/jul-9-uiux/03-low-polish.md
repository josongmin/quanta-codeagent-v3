# P3 — Low / polish / doc drift

Lower urgency. Still operator-annoying or audit traps.

> **2026-07-10 audit:** P3 rows were NOT individually verified (except ALBB-referencing ones, struck below where the jul-9/10 ALBB waves already landed the fix). Treat unstruck rows as unverified polish backlog — re-check the cited code before working one.

---

## Locale / copy

| ID | Summary |
|----|---------|
| UUX-2-25 | Mixed Korean/English chrome (Stop, hotkey prompt, escalation) |
| UUX-1-26 | CLI escalation card Korean (also listed P2 — treat as P2 if English-first product) |
| Context-warning EN+KR mix | `context-warning.ts` (tied to UUX-5-01 fix) |
| Ratelimit notice KR/EN mix | `ratelimit-notice.ts` |

## Exit codes / soft degrade

| ID | Summary |
|----|---------|
| UUX-4-27 | `/onboard` not wired exit 0; doctor warn exit 0 |
| UUX-1-28 | Broad “not wired” + exit 0 pattern |
| UUX-6-27 | Voice cancel / no-transcriber exit 0 (also P2) |
| Slash not-wired exit 0 | Scripts cannot distinguish success vs degrade |

## Attach / one-shot / history polish

| ID | Summary |
|----|---------|
| UUX-3-21 | Deeplink banner “not wired” fallback when `onOpen` absent |
| One-shot no Ctrl+B | `session-loop.ts` one-shot branch |
| Prompt history async boot | `prev()` undefined until load |
| External editor cancel silent | `raw-line-reader-editor.ts` |
| History prefix vs substring search | `prompt-history.ts` |
| `QUANTA_HISTORY_MAX` NaN drift | `cli-feature-config.ts` |

## Web / a11y / multimodal polish

| ID | Summary |
|----|---------|
| Clipboard copy silent fail | `MessageBubble.tsx` |
| Artifact CSV/notebook fail → null preview | `ArtifactStrip.tsx` |
| TokenCounter hides zero cost | `TokenCounter.tsx` |
| DiffPanel split mode no UI toggle | `DiffPanel.tsx` |
| Presence-probe built, unused (High as UUX-3-05) | — |
| Control-request / thin-client no frontend | `runtime-factory.ts` comments |
| Auth LAN/mobile OAuth limitation undocumented in UI | `slash-auth.ts` |
| Queued images single-shot per turn | `image-queue.ts` |
| `/side --tools=` silent drop | `side-cmd.ts` |
| Capture window order / sidecar fallback | `hotkey.rs` (UUX-6-30) |

## Catalog / tickets / intentional tradeoffs

| ID | Summary |
|----|---------|
| UUX-5-28 | 0316 deliberate_hold stale; mode-cycle plan visual-only |
| ~~UUX-3-20~~ | ~~`progress_update` bridge exclusion~~ CLOSED — decision documented in bridge source |
| ~~UUX-5-30~~ | ~~ALBB-21 soft budget; ALBB-20 plan reject~~ FIXED — Waves B pt2 + E |
| Spinner-stall FC `cli:full` overstated | detector without UI sink |
| `cli-turn-summary` “Default-OFF” vs TTY default-ON | YAML vs code |
| Goal continuation / `QUANTA_GOAL_ENFORCE` dead | `objective/continuation.ts` |
| `stop-category` shell.needs_approval reserved | `stop-category.ts` |
| SDK approval pause `reason: "aborted"` | ALBB-18 |
| Dual todo systems (plan vs focus-chain) no link | — |
| `/memory delete` print-and-retry only | `memory-cmd.ts` |
| `/kb` empty vs not-wired confusion | `kb-cmd.ts` |
| Markdown aggressive mode reserved | `markdown-painter.ts` |
| Thinking DIM per-delta ANSI churn | `stdout.ts` |
| Bench lane-progress ghost lines | `lane-progress-renderer.ts` |
| PR sink terse gh-exit errors | `pr-output-sink.ts` |
| Voice-live exit-code inconsistency | registry vs cmd |
| Shell stderr recolor breaks child ANSI | `shell-stream-painter.ts` |
| Split stdoutIsTTY vs stderrIsTTY chrome | `cli-feature-config.ts` |
| Turn-summary missing memoryCitations | `turn-sinks.ts` |
| `@` empty query no symbol browse | `symbol-list.ts` |
| Unicode `@` boundary vs CJK | `state-machine.ts` |
| Knobs show 60-col truncate | `slash-commands-knobs.ts` |
| Knobs help runner-ids only | same |
| Subagent mailbox silent loss (quota off) | hellgate |
| Hook sync CPU spin residual | hellgate |
| Budget ledger LWW parallel processes | hellgate |
| Weave on interrupted turn drops user_message | hellgate |
| Rule deny embeds full ruleKey / jargon escalate | `gates.ts`, `policy.ts` |
| Plan mutator “internal mutator error” | plan tools |
| Sampling consent synthetic MCP id | `internal/mcp.ts` |
| MCP elicitation non-TTY auto-decline silent | `mcp-elicitation-prompter.ts` |
| Durable trust grants undiscoverable | `QUANTA_TRUST_SCOPE` |
| Web `/logout` no revoke | `auth-routes.ts` |
| Doctor ignores missing OAuth client_id | `doctor/registry.ts` |
| Session rewind CLI no-op exit 0 | `session-ops/index.ts` |
| `/activity` advertises workflows/daemons future | `registry-surface.ts` |
| Fleet settled collapse / LRU | `agents-fleet-panel.ts` |
| `fork_turns` no operator surface | `handlers-6.ts` |
| Lifecycle pills counts only | `lifecycle-pills.ts` |
| Item stream default-OFF | `surface-compose.ts` |
| apply_patch preview vs preflight not unified | `diff-preview.ts` |
| Sticky-model session-scope no UX hint | `agent-arg-builder.ts` |
| Dual cost surfaces on web disagree | `/usage` vs `/cost` readout |
| Observability runs/approvals unbounded | `observability-hooks.ts` |
| Post-reconnect sessionId null freezes composer | `App.tsx` |
| PlanPromptAnswerForm no Enter-to-submit | `AgentStatePanel.tsx` |
| Hardcoded Korean hotkey image prompt | `App.tsx` |
| `QUANTA_MD_MODE=aggressive` reserved | `markdown-painter.ts` |
| Malformed canvas/agentState frames warn-only | `client.ts` |
| Finalization waits idle; streaming tail can linger | `session-hooks.ts` |
| Untrusted envelope seeded ON, welcome silent | `index.ts` |
| Probe multi-instance needs `--instance` undoc | `probe/index.ts` |
| Timeline orphan `t#?` labels | `probe/render.ts` |
| Background completion notify after forgotten task | `session-loop.ts` |
| Ctrl+B one-shot unavailable | `session-loop.ts` |
| Permission explain unavailable in attach | — |
| Mid-turn editor crippled vs between-turn | `in-turn-reader.ts` |
| `QUANTA_MIDTURN_VISIBLE` without capture useless | `turn-helpers.ts` |
| Sandbox pill hidden for default | `status-pills.ts` |
| Two “mode” surfaces disagree after Shift+Tab | welcome vs pills |
| `QUANTA_PILL_RULES` default off undocumented | `status-pills.ts` |
| Notify default off; presence second opt-in | — |
| Prompt suggestions not seeded (asymmetric) | `index.ts` |
| `/schedule` alias vs `/cron` docs | `cron-cmd.ts` |
| `/cost` readout stub shadows client `/cost` | web |
| Document/presentation artifacts download-only | `canvas-hooks.ts` |
| Generation tools not on web daemon | `runtime-factory.ts` |
| Identity/tool_profile set not emitted by web UI | `protocol.ts` |
| Diff split mode no toggle | `DiffPanel.tsx` |
| Presence-probe unused | — |
| Control-request / thin-client no UI | — |
| Resume failed banner no CTA | `App.tsx` |
| Daemon restart errors not surfaced | `StatusBar.tsx` |
| Color segment unused on usage panel | `protocol.ts` |
| Knobs panel until bootstrap | `KnobsPanel.tsx` |
| Slash `/resume` vs thread resume naming | web |
| `progress_update` recorded as recovery in JSONL | `jsonl-recorder.ts` |
| Item store ignores delta phases | `item-store.ts` |
| Identity onChange errors swallowed | `identity-mode-adapter.ts` |
| Duplicate error surfacing paths | stdout + turn-sinks |
| SDK AgentRun single-consumer | `sdk/run.ts` |
| SDK interactive prompt under batch policy | `sdk/profiles.ts` |
| Capability manifest approvals:"none" on bench | `bench/eval/driver.ts` |
| Web-daemon automation stub delivery | ALBB-14 (reminder half FIXED Wave A; web delivery half re-check) |
| ~~MCP `onServerLoadError` unwired at apps root~~ | FIXED — ALBB-09 Wave B pt1 (113450319) |
| ~~Subagent `onPersistError` unwired~~ | FIXED — ALBB-10 Wave A (7798b3379) |
| ~~fork `transcriptSource` unwired~~ | FIXED — ALBB-16 Wave A (7798b3379) |
| ~~Objective turns self-report-only~~ | CLOSED — ALBB-15 triage: idle-continuation deleted; self-report documented as designed |
| ~~Bg-turn `lastTurnOutcome` deferred~~ | FIXED — ALBB-18 Wave C (abort→SSOT classifier) |
| ~~SDK `stream.buffer.dropped` missing~~ | FIXED — ALBB-12 Wave B pt1 (`droppedEvents` getter) |
| ~~Cache metrics structurally dead~~ | CLOSED — ALBB-19 #1 recorded won't-fix (disproportionate); #3 fixed |
| Marketplace no slash UI | `connector-marketplace.ts` |
| `/inbox` workflow hold | FC 0280 |
| `/state` workingState sink hold | slashctx YAML |
| Paste-edit hold | FC |
| At-mention skill/plugin kinds empty | FC |
| Force-background web missing | FC |
| Radar default-OFF | FC |
| Session resilience `/doctor` residual | FC |

When fixing a P0/P1, prefer also cleaning adjacent P3 copy/exit-code inconsistency in the same PR if cheap.
