# REPL surface map — `src/apps/cli/`

Navigation aid for the next-quarter contributor. Every `.ts` file under
`src/apps/cli/` (46 top-level + 21 under `repl/` = **67 files**) with a
one-line purpose, grouped by concern.

Conventions:

- **Status**: PRODUCTION = wired and runs in default-OFF user path. TEST-ONLY = exercised only by unit tests (or by a slash command that prints "not wired in this surface"). SEAM-FOR-FUTURE = kept intentionally for a downstream surface (Web/Tauri sidecar, alternate driver) but not in the CLI hot path today.
- **Re-export shims** are marked as such — their canonical home is `@/runner/*`, `@/ui/*`, etc., and they exist only to preserve `src/apps/cli/<x>` imports across the slice DAG.

## status-chrome (8 files)

| File | Purpose | Status |
|---|---|---|
| `status-bar.ts` | Fixed bottom status bar via DECSTBM scroll region; transient overlay support; teardown obligation. | PRODUCTION |
| `status-line.ts` | Surface-agnostic context-usage formatter (Claude Desktop `getContextUsage` parity); ASCII bar + k/M token shorten. | PRODUCTION |
| `status-pills.ts` | Surface-agnostic composer for the top status pill row (4 pills: workspace / mode+effort / skills / sandbox). | PRODUCTION |
| `lifecycle-pills.ts` | Subagent / follow-up queue / MCP server health pill renderer; default-ON for TTY. | PRODUCTION |
| `turn-indicator.ts` | Live turn indicator (spinner + elapsed + live token counter); TTY-gated. | PRODUCTION |
| `turn-summary.ts` | Per-turn summary panel (verify-guard / HITL handoff / compaction / memory / recovery) rendered at turn end. | PRODUCTION |
| `rule-indicator.ts` | Codex repo-local-rule ingestion audit surface; `/rules` data layer. | PRODUCTION |
| `cost-panel.ts` | Cumulative session cost panel (Claude SOTA-inspired); cumulative delta fold per turn. | PRODUCTION |

## panel-renderer (3 files)

| File | Purpose | Status |
|---|---|---|
| `plan-panel.ts` | Plan-mode TUI panel; READ-ONLY visualization of plan store. | PRODUCTION |
| `working-state-panel.ts` | Working-state panel (catalog 대5 L4 WorkingState); surface-only renderer. | PRODUCTION |
| `markdown-painter.ts` | Inline Markdown highlighter for the LLM assistant text stream. | PRODUCTION |

## slash-router (10 files)

| File | Purpose | Status |
|---|---|---|
| `slash-commands.ts` | Five built-in Claude-Desktop-parity slash commands (`/context`, `/usage`, `/color`, `/navigate`, `/wait`) + dispatch shell. | PRODUCTION |
| `help-render.ts` | `/help` unified menu — slash inventory + keybinds + ENV knob catalog. | PRODUCTION |
| `history-cmd.ts` | `/history` — recent turns + tool-call breadcrumb. | PRODUCTION |
| `image-cmd.ts` | In-REPL `/image` subcommand handler (ADR-0083 multi-modal extension). | PRODUCTION |
| `mcp-cmd.ts` | `/mcp` slash command — MCP server explorer. | PRODUCTION |
| `memory-cmd.ts` | `/memory` — browse / recall / delete the durable memory store. | PRODUCTION |
| `permission-explain.ts` | `/permission` inspector — Codex 5-axis permission stack breakdown. | PRODUCTION |
| `rewind-cmd.ts` | `/rewind` + `/fork` slash commands (Claude Code v1.7196 SOTA pattern). | PRODUCTION |
| `rules-cmd.ts` | `/rules` slash command — surface the rule inventory built by buildRuleInventory. | PRODUCTION |
| `side-cmd.ts` | `/side <question>` — Claude Code A9 side-chat slash command. | PRODUCTION |

## cmd (5 files)

| File | Purpose | Status |
|---|---|---|
| `login-cmd.ts` | `/login` — drives the ChatGPT OAuth flow (ADR-0094 Slice C). | PRODUCTION |
| `logout-cmd.ts` | `/logout` — destroys the on-disk ChatGPT OAuth token bundle. | PRODUCTION |
| `status-cmd.ts` | `/status` — provider/auth/token state panel (ADR-0094 Slice C). | PRODUCTION |
| `retry-with.ts` | `/retry-with [<model-id>]` model-swap retry slash command (ADR-0066). | PRODUCTION |
| `snapshot-cmd.ts` | `/snapshot` — shadow-store snapshot UX (ADR-0122, Hermes Agent /rollback parity). | PRODUCTION |
| `session-import-handler.ts` | CLI surface adapter — `createCliImportHandler()` factory wired into `SessionCommandDeps#importHandler` (ADR-0305). | PRODUCTION |
| `session-list-env.ts` | CLI surface adapter — `resolveCliSessionListEnv()` resolves `SessionCommandDeps#listEnv` from runtimeConfig + stdout TTY (ADR-0305). | PRODUCTION |

## wire-helper (8 files)

| File | Purpose | Status |
|---|---|---|
| `sandbox-wire.ts` | Wire OS sandbox policy (ADR-0136 helper) onto the shell tool dispatch. | PRODUCTION |
| `shell-stream-painter.ts` | CLI streaming painter for `ShellExecEvent`s (ADR-0081); paints incremental chunks to stderr. | PRODUCTION |
| `diff-preview.ts` | Inline unified-diff preview for write/edit/apply_patch/scripted_replace; rendered BEFORE the confirm readline. | PRODUCTION |
| `image-loader.ts` | CLI image loader (ADR-0083); reads image off disk into a typed `ImageBlock`. | PRODUCTION |
| `image-queue.ts` | Single-shot image queue for the CLI multi-modal entry point. | PRODUCTION |
| `idle-monitor.ts` | Idle monitor + snooze persistence (Cursor 3.2 inspired). | PRODUCTION |
| `reject-counter.ts` | Consecutive-denial counter (Cursor 3.2 §4.1 verbatim). | PRODUCTION |
| `rewind-git.ts` | Real-git implementation of `RewindGitPort` for the CLI surface. | PRODUCTION |

## config-helper (4 files)

| File | Purpose | Status |
|---|---|---|
| `internal.ts` | CLI-internal feature-load + tooling-build factory (`loadFeatures`, `buildTooling`, `pickPersona`); ADR-0024 export-gap closure home. | PRODUCTION |
| `config-assemble.ts` | Re-export shim — canonical home is `@/runner/assemble/config.ts`. | SEAM-FOR-FUTURE (Web/Tauri) |
| `auth-ui.ts` | Re-export shim — canonical home is `@/ui/ui-helpers`. | SEAM-FOR-FUTURE |
| `dotenv.ts` | Minimal dotenv parser (unquote + interpolate) bundled into the single-binary build. | PRODUCTION |

## input (3 files)

| File | Purpose | Status |
|---|---|---|
| `raw-line-reader.ts` | Bun-compatible raw-mode line reader with Codex-style input box + slash command palette. | PRODUCTION |
| `prompt-history.ts` | Bash-style prompt history (Ctrl-R + ↑/↓); default-ON, ≤ 1000 lines. | PRODUCTION |
| `session-io.ts` | (sub-surface I/O helpers — re-export / glue). | PRODUCTION |

## bootstrap (4 files)

| File | Purpose | Status |
|---|---|---|
| `index.ts` | CLI binary entry point — argv parse + dispatch to runRepl / slash main / session main. | PRODUCTION |
| `repl.ts` | The runRepl God-function (1568 LOC at the time of this map) — target of ADR-0173 split. | PRODUCTION |
| `resume.ts` | Re-export shim — canonical home is `@/runner/orchestrate/resume-fsm` (ADR-0024 surface-agnostic Layer-2). | SEAM-FOR-FUTURE |
| `branch-search-progress.ts` | Live progress visualization for speculative branch search (ADR-0083 / 대6 L4). | PRODUCTION |

## repl/ — the orphan-tree subdirectory (21 files)

These were extracted in acb8d187 (2026-05-24) but never wired into
`repl.ts`. Slice B (c283ad58) plans to delete 20 of them; ADR-0173
plans to recreate 6 NEW modules (different boundaries) and wire them.
The 21 listed below reflect the CURRENT worktree state, BEFORE Slice B
deletes them. All are TEST-ONLY or SEAM-FOR-FUTURE today.

| File | Purpose | Status |
|---|---|---|
| `repl/run-repl.ts` | Re-export shim that delegates to `../repl#runRepl`. | SEAM-FOR-FUTURE |
| `repl/assemble-context.ts` | Surface-agnostic SessionDeps + AgentConfig builder; never wired (re-inlined into repl.ts). | TEST-ONLY |
| `repl/interactive-driver.ts` | Driver for the interactive REPL turn loop; never wired. | TEST-ONLY |
| `repl/oneshot-driver.ts` | Driver for the argPrompt one-shot path; never wired. | TEST-ONLY |
| `repl/readline-loop.ts` | Legacy `readline.createInterface` loop; never wired (raw-line-reader supersedes). | TEST-ONLY |
| `repl/session-router.ts` | Slash-vs-prompt classification helper; never wired. | TEST-ONLY |
| `repl/prompt-source.ts` | Prompt source builder; never wired (re-inlined as `buildCliPromptSource`). | TEST-ONLY |
| `repl/resume-fsm.ts` | Resume FSM dispatch helper; never wired (re-inlined). | TEST-ONLY |
| `repl/seed-images.ts` | Seed image loader; never wired (re-inlined as `loadSeedImages`). | TEST-ONLY |
| `repl/image-queue-wire.ts` | Image queue builder; never wired (re-inlined as `buildImageQueue`). | TEST-ONLY |
| `repl/lifecycle-wire.ts` | Lifecycle bundle builder; never wired (re-inlined as `buildLifecycleBundle`). | TEST-ONLY |
| `repl/skills-callback.ts` | Skills surface callback; never wired (re-inlined as `buildSkillsCallback`). | TEST-ONLY |
| `repl/status-pills-wire.ts` | Status pills installer; never wired (re-inlined as `installPills`). | TEST-ONLY |
| `repl/idle-wire.ts` | Idle-gate wrapper for prompt source; never wired (re-inlined as `wrapPromptSourceWithIdleGate`). | TEST-ONLY |
| `repl/turn-indicator-wire.ts` | Turn indicator + tee stream builder; never wired (re-inlined). | TEST-ONLY |
| `repl/turn-summary-wire.ts` | Turn summary collector + tee stream builder; never wired (re-inlined). | TEST-ONLY |
| `repl/turn-cancel.ts` | Stdin keypress installer (Esc-Esc + Ctrl+C); never wired (re-inlined as `installTurnCancel`). | TEST-ONLY |
| `repl/turn-render.ts` | Per-turn cost+cache dashboard renderer; never wired (re-inlined as `renderTurnDashboard`). | TEST-ONLY |
| `repl/metrics-sink.ts` | Default per-turn work-metrics sink (ADR-0064 L4); never wired (re-inlined as `buildWorkMetricsSink`). | TEST-ONLY |
| `repl/usage.ts` | `topLevelUsage` text block; never wired (re-inlined as `topLevelUsage`). | TEST-ONLY |
| `repl/mcp-surface-wire.ts` | `/mcp` slash data surface builder. **THE ONLY SURVIVING SEAM** — has an independent unit test and covers a contract repl.ts does NOT duplicate. | SEAM-FOR-FUTURE |

## Group breakdown summary

| Group | File count |
|---|---|
| status-chrome | 8 |
| panel-renderer | 3 |
| slash-router | 10 |
| cmd | 6 |
| wire-helper | 8 |
| config-helper | 4 |
| input | 3 |
| bootstrap | 4 |
| repl/ orphan tree | 21 |
| **Total** | **67** |

**Status breakdown**: 43 PRODUCTION + 20 TEST-ONLY (orphan tree, scheduled for deletion in Slice B) + 4 SEAM-FOR-FUTURE.
