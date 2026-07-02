# Competitor UX/Product Absorption Catalog — 2026-07-03

> **⚠️ READ THE FINAL SECTION FIRST.** The catalog below was written from the *competitor corpus
> only* — it did NOT audit quanta's own `src/`, so it over-assumes quanta lacks these features. A
> subsequent **3-round adversarial audit against quanta `src/`** (existence → adversarial flip →
> strengthen) corrected the picture: several "biggest gaps" (browser CDP control, context gauge,
> HITL, memory citation) are **already IMPLEMENTED**. The verified status + concrete
> strengthen/complete/land plans are in **[§ FINAL: quanta implementation status](#final--quanta-implementation-status-3-round-audit)** at the bottom. Treat that as the source of truth.

Source: `.extracted_source/` corpus refreshed 2026-07-03 (Codex Desktop 4598, codex-rs 0.142.3
IDE ext, Codex CLI 0.142.5, Claude Code CLI 2.1.198; Cursor 3.5.33 / Claude Desktop 1.0.734 as
standing corpus). 6 parallel domain agents, every pick verified WIRED (real component / RPC /
tool-schema / config struct) — locale-string and vapor hits rejected. Lens = **user-experience /
product**, NOT benchmark. quanta = multi-surface (CLI / Tauri / embedded browser); north-star =
agent-state observability.

## Cross-cutting thesis
The competitor edge is almost never a new *engine* — quanta already has the engines headless
(worktree enter/exit, skills+plugin-loader, reactor/self-wake+CI trigger, STT/voice, MCP client,
spot-resume cassette/replay, MEMORY.md, TodoWrite). **The gap is the Tauri UX shell + the
user-facing contract on top.** So most absorption = "put a surface + a typed contract over an
engine we already have." Landing cost is mostly low. Two hard rules carried from memory:
(1) observability items must land as ONE unified turn-item model, not parallel systems (else
knob-config 3중복 재발); (2) anything with a threshold or auto-generation (rag_active, auto-memory)
is measure-first + approval-gated + default-OFF (no-heuristics).

---

## TIER S — do first (highest ROI × north-star × on-surface)

### S1. In-app browser control over CDP + aria/DOM snapshot as the agent's "eyes"
- **What**: Agent drives a real embedded browser (navigate/click/type/screenshot/tabs) via Chrome
  DevTools Protocol on the app's webview; primary sense is a structured `ariaSnapshot`/`domSnapshot`
  (role+name tree) with a locator-stability ladder (`data-testid` > stable `data-*` > href >
  role+name > text > CSS), screenshots only for visual confirm. Background-by-default with a
  `visibility.set(true)` reveal + named sessions; console/network captured into context; origin
  allowlist + elevated-risk consent gate.
- **Evidence**: Codex `codex/.vite/build/main-CNod9zFW.js` (`webContents.debugger.sendCommand`,
  `ensureTabReadyForCdp`); agent API `userdata/codex/plugins/cache/openai-bundled/browser/…/browser-client.mjs`
  (46 CDP commands, `ariaSnapshot`/`domSnapshot`, JSON-RPC backend `iab`); Cursor
  `workbench.desktop.main.js` `WebviewBrowserManager` (console retention cap, `browser_origin_allowlist`,
  file:// block). Claude = MCP-delegated (Playwright MCP) only → not app-native.
- **Why/UX**: biggest capability gap; agent verifies its own frontend changes, reproduces UI bugs,
  reads JS-gated content — inside the app, no separate Playwright. User *watches* it (north-star).
- **Landing**: embedded-browser (primary host) + Tauri. Expose `browser.tabs.*` + `tab.{goto,click,
  type,screenshot,dom_snapshot}` façade over CDP. CLI = thin proxy / headless fallback.
- **ROI 상**. **함정**: Tauri/WRY doesn't expose `webContents.debugger` — need a CDP bridge or
  bundled headless Chromium off Electron. `Runtime.evaluate` = arbitrary exec → allowlist + consent
  mandatory. Snapshot staleness (re-snapshot after nav/modal/failed click) is the hard discipline.
- **Reference**: CDP host + snapshot from Codex `browser-client.mjs`; tool decomposition + security
  (allowlist, console/network capture, retention cap) from Cursor.

### S2. Unified turn-item observability model (task-graph + subagent panel + blocked-reason + progress)
- **What**: ONE stream of typed turn-items — `subagentActivityItemGroups | todoListItem |
  proposedPlanItem | planImplementationItem | permissionRequestItems | approvalItem | userInputItem`
  — backed by a task **DAG** (`blocks/blockedBy/owner/activeForm`, status transitions with
  `statusChange{from,to}`). Subagent activity rolls up per `owner` with drill-down (`openSubagent`),
  `interrupted` distinct from `done`. Blocked/waiting is a first-class item ("why stopped").
- **Evidence**: Claude `claude-code-cli/sdk-tools.d.ts` `TaskCreate/Get/Update/List` (real DAG:
  `blocks[]`, `blockedBy[]`, `owner`, `activeForm`, `statusChange`); Codex
  `codex/webview/assets/…onboarding-page-DewXrzLR.js` `dwn({activityItems,backgroundAgents})` subagent
  rollup + `openSubagent`, and the co-equal turn-item set; Cursor
  `TodoList/TodoListCard/TodoStatusIndicator` + item `dependencies[]`.
- **Why/UX**: dead-center of the north-star. A DAG (not a linear todo) is what answers "why is it
  stopped" — this task is `blockedBy` that; and "what are the 5 parallel subagents doing."
- **Landing**: extend quanta's existing `TodoWrite` with `blocks/blockedBy/owner/activeForm` as the
  SSOT. CLI = dependency-indented tree (`⤷ waiting on #3`) + collapsed subagent lines; Tauri =
  DAG/activity panel with drill-down. **Land items as one model, not four.**
- **ROI 상**. **함정**: quanta is harness-forced — if the LLM authors the graph, `blockedBy` edges
  can lie; need a witness against real process state (pending tool-call / unfinished subagent) or
  it's "fake blocked" observability debt. Map `interrupted` to real kill/timeout (no zombie "active").

### S3. Context + rate-limit budget gauge (surfaced to the user)
- **What**: live "% context left" / "N tokens left in this window" (multi-window aware,
  reasoning-tokens accounted separately from output) + rate-limit gauge
  (`usedPercent`/`resetsAt`/`windowDurationMins`). Agent-facing tools `get_context_remaining`,
  `new_context_window` let the model self-pace / roll windows.
- **Evidence**: `codex-ide/_codex-bin-symbols.txt` (`% context left`, `get_context_remaining.rs`,
  `new_context_window.rs`, `model_context_window`); `codex-ide/webview/assets/app-main-*.js`
  `bj({intl,bucket})` → `{usedPercent,resetsAt,windowDurationMins}`; token accounting in
  `codex-ide/extension.js` `last_token_usage{output_tokens, reasoning_output_tokens}`.
- **Why/UX**: "why did it slow/stop" hidden cause = context exhaustion / rate-limit. Promotes
  quanta's known metering gap (jun-26: tokens/cost never serialized to report) to a live gauge.
- **Landing**: CLI status line (`ctx 62% · 41k left`), Tauri header gauge. Adopt reasoning-token
  split accounting.
- **ROI 상**. **함정**: this lives in codex-rs (coding surface) ONLY — Codex Desktop chat webview
  has NO gauge (verified 0). Correct choice: gauge on coding surface, not chat.

---

## TIER A — strong

### A1. Human-in-the-loop spine: structured elicitation + steer-mode + unified permission port
- **What**: (a) `AskUserQuestion` — 1–4 questions, each a ≤12-char chip header + 2–4 options
  {label, description, optional focus-`preview`}, `multiSelect`, framework auto-adds "Other". (b)
  follow-up-while-running `followUpMode: queue|steer|interrupt` (default steer) + one-shot invert
  keybind + typed `ActiveTurnNotSteerable` fallback. (c) unified `canUseTool` port returning
  `{behavior: allow|deny, updatedInput, updatedPermissions{scope: once|session|prefix|project}}` —
  one seam for every gated tool, can rewrite input & persist a scoped rule; `decision_reason` +
  `permission_suggestions` explain why. (d) granular approval: `approve_for_prefix`, per-path
  read/write/deny, project `trusted_hash` pinning.
- **Evidence**: `claude-code-cli/sdk-tools.d.ts` (`AskUserQuestionInput`, `ExitPlanMode`,
  permission modes `acceptEdits|auto|bypassPermissions|default|dontAsk|plan`); `codex-ide/extension.js:17323`
  (`followUpQueueMode` enum) + `:66284` (`turn/interrupt`); `claude-code-ide/extension.beautified.js:43111`
  (`can_use_tool` control request, `updatedInput`/`updatedPermissions`); codex-rs
  `GranularApprovalConfig`, `TuiApprovalKeymap` (approve/for_session/for_prefix/decline),
  `ProjectTrustConfig`/`trusted_hash`.
- **Why/UX**: chip+description+preview beats free-text Q&A; steer/queue/interrupt is the definitive
  "redirect a running agent"; one permission port subsumes ad-hoc prompts and enables
  "approve for session/prefix/edit-then-approve."
- **Landing**: leaf `ask_user_question` tool (gated) + route every manifest gate through one
  `canUseTool` port; add `followUpMode` to the turn loop with a safe steer-injection point.
- **ROI 상**. **함정**: `updatedInput` ⇒ approved call ≠ requested call → re-validate the rewritten
  input (confused-deputy). `approve_for_prefix` too broad = foot-gun (`git ` grants `git push -f`).
  `trusted_hash` must invalidate on repo change. steer mid-tool-call needs a safe injection point or
  fall back to `queue` + surface "not steerable now".
- **Bonus (A1b)**: auto-resolution/snooze coordinator (`requestUserInputAutoResolutionCoordinator`,
  `submitEmptyResponse`) for unattended runs — TTL on any elicitation, auto-resolve to a *declared
  safe default* on expiry, **log loudly**. Directly helps headless/bench hangs.

### A2. Artifacts — rich renderable output (staged; reject the WASM .NET trap)
- **What**: first-class typed artifact channel (document/spreadsheet/presentation/pdf/notebook) with
  deep-link anchors (slide/sheet+range/page), rendered in a side panel separate from chat; inline
  mermaid+katex in transcript; CSV/markdown → live grid; read-only pdf/docx/notebook previews;
  anchored annotation/comment threads.
- **Evidence**: Codex `codex/webview/assets/` — `CODEX_ARTIFACT_KIND_*` proto unions
  (`…onboarding-page-DewXrzLR.js`), `PopcornElectron{Document,Presentation,Workbook}Panel-*.js`,
  `docx-preview-panel`, `pdf-preview-panel` (pdf.js), `notebook-preview-panel`, `runtime.worker-*.js`
  (recalc/SUM/dep-graph), `workbook-from-{csv,markdown}`, `mermaid-diagram-*.js`, KaTeX fonts,
  `artifact-annotation-comment-*.js`.
- **Why/UX**: moves quanta output from diff/terminal to renderable artifacts — the biggest
  product-differentiation axis on Tauri/Web. Claude Desktop / Cursor have nothing comparable
  (Cursor = mermaid/katex-in-chat = table stakes).
- **Landing order**: (1) mermaid+katex inline — days, client-side, lazy-load per diagram type;
  (2) artifact channel + panel framing (keystone); (3) read-only previews (pdf.js Apache-2,
  docx-preview MIT, ipynb=trivial); (4) live table via **OSS** (HyperFormula/exceljs), not Codex's
  bespoke worker; (5) export via **Tauri-native/lightweight libs** (rust_xlsxwriter / docx-rs /
  exceljs/pptxgenjs), (6) annotations last.
- **ROI 상** (mermaid) → **중상/중** (rest). **함정 (the big one)**: Codex ships an ~11.6MB .NET
  OpenXML WASM runtime (`DocumentFormat.OpenXml.wasm` + `dotnet.native.wasm` + `Walnut.wasm`) —
  absorb the *capability*, **reject the implementation**. Artifact mutation granularity is
  **unverified** (no `set_cell`/`insert_slide` protos found — likely whole-artifact regen); don't
  assume fine-grained patch ops. appgen = unverified/hosted-backend → skip.

### A3. Projects knowledge-base — upload-that-never-enters-context + injection-budget guard
- **What**: remote KB where doc contents NEVER enter context; on budget overflow auto-switch to
  RAG-retrieval. 5 methods (`project_info/read/search/write/delete`); `local_path` upload
  (reads/encodes/uploads directly); output `knowledge{knowledge_size, max_knowledge_size,
  search_threshold, rag_active, remaining_budget}` — **budget accounting surfaced in the response**;
  `project_search{query,n}` → `hits[{name,doc_uuid,text}]`; bare filenames namespaced `claude/<name>`.
- **Evidence**: `claude-code-cli/sdk-tools.d.ts:2340` `ProjectsInput` (+ L2351 local_path "contents
  never enter your context", L2355 `force` budget bypass, L364 `knowledge{}` accounting).
- **Why/UX**: solves attach-big-doc-blows-context; surfacing `remaining_budget` explains "why this
  doc is in retrieval mode" (north-star). semantica-codegraph = embedding/search backend (seam swap).
- **Landing**: pure leaf tool (5 methods) + serialize `knowledge{}` to report/status; Tauri KB panel
  + budget gauge; CLI `quanta project …`.
- **ROI 상**. **함정**: `rag_active` threshold must be measured, not guessed (no-heuristics).
  "never enters context" needs a red-on-injection wiring test (assert doc text absent from
  transcript) or it's an inert claim.

---

## TIER B — solid (mostly UX-shell over existing quanta engines)

- **B1. Product onboarding as a skill** (Codex `onboard-new-user/SKILL.md`, `name: setup-codex`):
  5-step `update_plan`-enforced contract (start → role → first task → connect context → first
  artifact). quanta's `onboard` skill is repo-understanding only, not product-onboarding. Tauri-first
  (role picker/connector modals). ROI 상; 함정: connector/MCP-approval modals need real OAuth or it's
  vapor; name-collision with repo-onboard.
- **B2. Durable cron CRUD + rrule + cross-surface deeplink handoff** (Claude `CronCreate{cron,prompt,
  recurring,durable}` + `ScheduleWakeup{delaySeconds 60–3600 clamp}`; Codex rrule RFC5545
  `wall_clock|interval` + per-automation model + cooldown; `codex://threads/{id}` deeplink +
  `threadsHandoffToHost` tool). quanta has reactor/self-wake + spot-resume cassette/replay as the
  exact foundation for handoff. north-star (what's scheduled / next). ROI 상/중상; 함정: durable
  stale-prompt zombies (7-day expiry), deeplink session-ownership auth.
- **B3. 2-phase auto-memory + line-level citation** (Codex `MemoriesToml` 12-field, `memory_stage1`
  → `memory_consolidate_global`, `MemoryCitationEntry{threadIds,rolloutIds,entries[{lineStart,
  lineEnd,note}]}`, rate-limit-aware scheduling `min_rate_limit_remaining_percent`). quanta has
  MEMORY.md but no consolidation loop / citation. Citation = north-star. ROI 상 (citation) / 중
  (auto-gen — risks overwriting user's durable instructions → dedicated-tools + approval + default-OFF).
- **B4. MCP resource read/dir + blob-to-disk** (Claude `ReadMcpResourceDir`, `ReadMcpResourceOutput.
  blobSavedTo`; Codex `resources/list|read` + `list_mcp_resource_templates.rs`). quanta already
  landed `mcp_list_resource_templates` — net-new is `read_resource_dir` + blob-to-disk only; grep
  before wiring (over-claim guard). ROI 중상.
- **B5. Presence-aware push notification** (Claude `PushNotificationInput{status:"proactive"}` →
  `{pushSent, disabledReason: config_off|user_present|no_transport, idleSec, hasFocus}` — suppress
  when user present, send when idle). Pairs with feedback-proactive-failure-alert. Genuinely-new to
  quanta. ROI 중 (상 bundled with B2).

---

## VAPOR / SKIP (verified negatives — don't chase)
- **Claude Desktop agent observability** — 0 (consumer chat app; no todo/subagent/thinking surface).
- **Codex Desktop context/cost gauge** — 0 (gauge is codex-rs only; don't mis-attribute to Desktop).
- **Office export via 11.6MB .NET OpenXML WASM** — capability yes, this implementation no.
- **appgen (shareable app-gen)** — preview/bundle/hosting runtime unverified + hosted-backend dep.
- **Codex `token_count` event as live gauge** — it's telemetry aggregation, not the live gauge.
- **remote-hosted-pip, hatch-pet skill, executor_plugin/remote_control** — niche / mascot / likely
  convergent-with-existing-MCP; measure-first.
- **1st-party connectors (Drive/Gmail/GitHub) as-is** — server-side (Anthropic/OpenAI hosted);
  generalize to universal remote-MCP-OAuth instead of hardcoding providers. Token-rotation footgun.
- **Cursor tinder-diff accept/reject-hunk** — real in product but minified past clean verification;
  build on Claude's `updatedInput` + FileEdit `old_string/new_string` seam instead.
- **SendMessage / RemoteTrigger / leader-approval** — multi-agent-team / cloud-backend; defer.

## Suggested sequencing (product lens)
1. S2 (unified observability model) + S3 (budget gauge) — north-star, extends TodoWrite, low cost.
2. A2.1 (mermaid+katex) — days, immediate visible win.
3. S1 (browser control) — highest capability, needs CDP-bridge spike for Tauri.
4. A1 (HITL spine) — unify elicitation + permission port.
5. A3 (Projects KB over semantica) + B3 citation — grounding + provenance.
6. A2.2–6 artifacts, B1 onboarding, B2 scheduling/handoff, B5 push — UX-shell buildout.

---

# FINAL — quanta implementation status (3-round audit)

Method: 11 candidates × 3 rounds, pipelined, each round an independent agent grounded in quanta
`src/` (R1 existence → R2 adversarial flip-attempt → R3 strengthen). Wiring discipline enforced:
file-present ≠ implemented; a capability must be registered + invoked on a live path + reachable, or
it's INERT. **Headline correction: quanta already has more than the competitor-only catalog assumed
— 4 of 11 are IMPLEMENTED, and every ABSENT one has an existing seam to reuse (no new subsystems).**

| # | Candidate | Verified status | What to do |
|---|---|---|---|
| S1 | Browser CDP control + aria snapshot | **IMPLEMENTED** (15 browser tools, CDP adapter, aria snapshot, nav SSRF-guard) | STRENGTHEN: network-capture buffer/tool + locator-stability ladder in snapshot |
| S2 | Unified turn-item observability | **PARTIAL** (item-stream + plan/subagent events exist; projector drops them; 3 disjoint models) | COMPLETE: fold plan/subagent/blocked into item-stream (default-OFF `QUANTA_ITEM_STREAM`) |
| S3 | Context/rate-limit budget gauge | **IMPLEMENTED** (/context gauge + rate-limit notice wired) | STRENGTHEN: land reasoning-token split (parsed but dropped at emit); kill dead single-bar gauge |
| A1 | HITL spine | **IMPLEMENTED** (ask_user, steer/interrupt, trust-scope, approval gates) | STRENGTHEN: AskUserQuestion structured options {label,description,preview}+auto-Other; activate inert control-request drain |
| A2 | Rich artifacts | **ABSENT** (rich render), but 3 seams exist (ArtifactRegistry, plumbed protocol channel, Canvas WS) | LAND: bridge registry→artifact.ready producer; mermaid/katex first; read-only previews (avoid 11.6MB .NET WASM) |
| A3 | Projects knowledge-base | **ABSENT** | LAND: `projects_kb` leaf tool (5 ops) over SearchPipeline + resolveJailedDoc; knowledge{} accounting real, rag threshold measure-first |
| B1 | Product onboarding skill | **ABSENT** (repo-onboard exists, not product-onboard) | LAND: `product-onboard` system-skill, 5-step update_plan contract; reuse SKILL.md SSOT + IdentityMode |
| B2 | Durable cron + rrule + handoff | **PARTIAL** (Cron CRUD+RRULE wired; durable sqlite off-wire, per-task model + deeplink missing) | COMPLETE: wire sqlite store + model field; LAND minimal `quanta://threads/{id}` deeplink/handoff |
| B3 | Memory citation + consolidation | **IMPLEMENTED** (line-citation + consolidation + write-guard) | STRENGTHEN: real sub-spans (span is degenerate L1..N today); back guard with real provider rate-limit signal (not local cost) |
| B4 | MCP read-dir + blob-to-disk | **ABSENT** (mcp_resources exists; read-dir + blob absent) | LAND: read_resource_dir tool + blob-to-disk on existing N3 surface, reuse ImageWritePort + resolveJailed |
| B5 | Presence-aware push | **ABSENT** | LAND: presence gate on RFC-09 notify port reusing IdleMonitor; typed disabledReason |

Tally: **IMPLEMENTED 4** (S1, S3, A1, B3) · **PARTIAL 2** (S2, B2) · **ABSENT 5** (A2, A3, B1, B4, B5).

## Per-candidate strengthen / complete / land

### S1 — Browser CDP control · IMPLEMENTED → strengthen the agent's "eyes"
Gap vs Codex/Cursor = console-capture exists but **no network capture** and the aria snapshot emits
no **stable locator hints**.
- **[M]** `src/browser/cdp/network-buffer.ts` — ring buffer cloned from `console-buffer.ts` (dual
  maxEntries/maxBytes, `drain(clear)`). Capture `Network.requestWillBeSent/responseReceived/
  loadingFinished/loadingFailed` (`Network.enable` already in `cdp-allowlist.ts:34`). **Metadata only
  — method/url/status/mime/size, NO bodies/headers** (leak guard). Wire producer in `cdp-adapter.ts`
  (~L700) + `port.networkMessages()` (`:618`).
- **[S]** `browser_network` tool modeled on `consoleTool` (`src/tool/browser/index.ts:418-441`);
  gate `QUANTA_BROWSER_NETWORK` default-OFF in `gated-tools.ts` SSOT + `knob-inventory/host.ts`.
- **[M]** Locator ladder in `collect.ts` COLLECT_SCRIPT (`:87-120`): emit `data-testid` + whitelisted
  `data-*` + `href`; render ladder-ordered hint in `snapshot.ts` (same NAME_CAP/VALUE_CAP).
- **[S]** `network-buffer.test.ts` (dual-cap eviction) + wiring test (double-gate mirror of
  `agent-config-assembler.ts:296`). Caps = mirror console-buffer 200/65536, measure-first for changes.
- **Risk**: network capture leaks tokens/bodies → metadata-only + URL redaction + separate default-OFF gate.

### S3 — Context budget gauge · IMPLEMENTED → close reasoning-split + kill dead code
- **[M]** Reasoning-token split is **parsed at `openai-responses-wire.ts:784` but dropped by
  `emitUsage` at `:794`**. Add optional `reasoningTokens?` to the `usage` StreamEvent (`types.ts:194`,
  optional ⇒ Anthropic byte-identical), forward through `emit-helpers.ts`.
- **[M]** Surface it in `/context` gauge (`formatSegmentedUsage`, `status-line.ts:158`) as a Reasoning segment.
- **[S]** `formatContextUsage` (single-bar, `status-line.ts:72`) has **zero prod callers** — DELETE it +
  its dangling knob refs, or wire it. Don't leave it masquerading as "always-on default".
- **[S]** Doc that `reasoningTokens` is OpenAI-Responses-only (Anthropic bills thinking as output) — no synthetic split.
- **Risk**: `usage` event has many sinks (meter/ledger/recorder) — optional field keeps them byte-identical.

### A1 — HITL spine · IMPLEMENTED → AskUserQuestion parity + activate inert drain
- **[M]** `ask_user` options are bare `z.array(z.string())`. Widen to `string | {label,description?,
  preview?}` union (back-compat) + chip `header`, threaded end-to-end through tool→port→MCP prompter
  (`ask-user.ts`, `port.ts`, `ask-user-wire.ts`, `mcp/elicitation/schemas.ts`).
- **[M]** Auto-"Other" free-text escape in `mcp-elicitation-prompter.ts`.
- **[M]** **Activate inert `drainControlRequests`/`applyControlEffect` (ADR-0496, ZERO loop callers)** —
  add one gated poller edge in `turn-iteration.ts` parallel to the existing `pollFollowUpQueue`/`pollPeerInbox`.
- **[L]** Verify `trust-scope-store.ts` persists `trusted_hash` grants durably (codex-rs ProjectTrustConfig parity), not just a session Set.
- **Risk**: structured-options spans 3 schema hops — partial thread drops description/preview at the narrow hop and builds green (wired-but-inert). Pin with red-on-injection test.

### B3 — Memory citation · IMPLEMENTED → real spans + real rate-limit signal
- **[M]** `lineSpanOf` (`memory-tools.ts:58`) always returns **L1..N (whole record) — the `[L{s}-{e}]`
  tag is informationally empty**. Carry match offset from `store.recall` → real 1-based sub-span.
- **[M]** Add provenance (threadId + note) to `LineCitation` (Codex `MemoryCitationEntry` parity).
- **[L]** **Top gap**: `writeBlockReason` reads `BudgetMeter.remainingPercent()` = LOCAL cost fraction
  (returns 100 when no dial) — it mirrors Codex `min_rate_limit_remaining_percent` **by name only**.
  Add a real provider `x-ratelimit-remaining` tap (`meter.ts`, `bootstrap-session.ts:570`).
- **[S]** Arm-state telemetry (guard is fail-open unless knob + live source both exist — latent-config trap).
- **Risk**: today the rate-limit-aware memory scheduling is semantically fake — the tap is load-bearing.

### S2 — Unified observability · PARTIAL → fold the disjoint models into one item-stream
The events **already flow on the AgentEvent stream** — the projector drops them (`default: return []`).
- **[M]** Extend `ItemStreamItemType` (`src/shared/item-stream.ts:32`) with `plan` (DAG via
  `TodoItem.dependencies`=blockedBy, `assignee`=owner), `subagent`, `progressCard`; `blocked` = status
  on the plan item (not a 5th kind).
- **[L]** Fold arms in `item-stream-projector.ts:61-84` for `plan_created/snapshot/updated` +
  `subagent_cancel` — unifies the parallel `PlanDelta` mirror channel into the item stream.
- **[M]** Bridge `ActivityStore` subagent snapshots → `subagent` event (`producers/fleet.ts:44`) with
  L0→L2 drilldown (the `openSubagent` equivalent, 0 hits today).
- **[S]** Add `activeForm` to `TodoItem` (Claude parity, 0 hits repo-wide) — append-only.
- **[M]** Drift hellgate on BOTH wire planes (session.v1 + web agent-state). Gate `QUANTA_ITEM_STREAM` default-OFF.
- **Risk**: if `PlanDelta` mirror stays live alongside, you create a 4th channel instead of unifying — migrate the web frontend consumer.

### B2 — Durable cron/rrule/handoff · PARTIAL → converge durable runtime + land handoff
- **[M]** **Activate durable store**: `scheduler/automation-engine/sqlite.ts` fully implements the port
  but has **ZERO call-sites** — `runtime-wire.ts:116` hardcodes `inMemoryAutomationEngine()` and
  `QUANTA_AUTOMATION_STORE=sqlite` is a dead doc comment. Add the engine-select branch.
- **[M]** Thread per-task `model` through the shared `ScheduleInput` port (`port.ts:90`) — sqlite table
  already has the columns; the port drops it.
- **[M]** Add `HOURLY`/`MINUTELY` to `Frequency` (don't invent Codex's wall_clock|interval discriminator — measure-first).
- **[L]** **Land deeplink/handoff (fully ABSENT)**: pure `quanta://threads/{id}` builder/parser
  (`scheduler/deeplink.ts`) + gated `threads_handoff` leaf tool. Reuse spot-resume cassette/replay as the transport.
- **Risk**: two scheduler systems (live in-memory vs unwired ADR-0161 `createSchedulerRuntime`) — converge onto the LIVE wire, don't wire the second as a parallel path.

### A2 — Rich artifacts · ABSENT → bridge existing seams, mermaid first
Three seams exist: metadata `ArtifactRegistry` (`src/artifact/registry.ts`, gated
`QUANTA_ARTIFACT_STORE`), a **plumbed-but-producerless** protocol `artifact.ready` channel
(`scheduler.ts:120,245` emits from `result.artifacts` which **nothing populates**), and a Canvas WS union.
- **[M]** Bridge registry → `result.artifacts` producer (the missing piece); consume at `scheduler.ts:245`.
- **[S]** Flip capability manifest `artifacts:false`→`artifactRegistry!==undefined` (`context-binding/base.ts:66`).
- **[M]** Host preview resolver for `quanta-artifact://` scheme (read-only, jailed bytes).
- **[M]** Extend Canvas WS union with typed artifact frame (same transport, no fork).
- **[L]** **Mermaid+katex inline first** (cheapest, avoids the 11.6MB .NET OpenXML trap); **[L]** then
  read-only pdf.js/docx-preview/notebook/csv-grid previews.
- **Risk**: two `artifact` nouns in src (rich-preview `ArtifactRegistry` vs run-status `RunArtifact`) — extend the registry SSOT, don't fork.

### A3 — Projects KB · ABSENT → leaf tool over the retrieval seam
- **[L]** `src/tool/projects-kb/` cloning the `ci_finding` store+port pattern; op-dispatch 5 methods,
  no-throw; `local_path` upload encodes bytes **through `resolveJailedDoc`** — returns metadata only.
- **[M]** `project_search` delegates to existing `SearchPipeline` (`@/retrieval/pipeline`, same as
  `search_codebase`) — no parallel search stack; lexical fallback when no pipeline.
- **[M]** ONE `GATED_TOOLS` entry `projects_kb`, gate `QUANTA_PROJECTS_KB` default-OFF opt-in.
- **[M]** Serialize `knowledge{}` accounting to status (the north-star "why is this doc in retrieval mode").
- **[M]** **Hellgate red-on-injection**: after `project_write`, assert doc text ABSENT from tool
  output + transcript, yet `project_search` returns a hit. This invariant IS the value prop.
- **Risk**: `rag_active`/`search_threshold` are heuristic thresholds — ship as real byte-budget accounting, keep the RAG-crossover measure-first (no guessed cutoff).

### B1 — Product onboarding · ABSENT → a system-skill, no subsystem
- **[M]** `src/skill/system-skills/product-onboard/SKILL.md` mirroring frontmatter SSOT
  (`skill-frontmatter.ts`); triggers "onboard me / get started / first task"; `allowedTools:[…,update_plan]`.
- **[S]** Discoverability via existing `discoverSystemSkills` dir-scan; **[S]** make `onboarding`
  IdentityMode reachable (`agent-args.ts:123,170` — it's in DEFAULT_IDENTITIES but omitted from VALID_IDENTITY_MODES).
- **[S]** Lean on existing `update_plan`/planMutator for the 5-step contract (no onboarding-specific plan tool).
- **Risk**: name/trigger collision with the existing repo-recon `onboard` skill (inverted semantics) — name it `product-onboard` with sharp triggers.

### B4 — MCP read-dir + blob-to-disk · ABSENT → onto the existing N3 surface
- **[M]** Extend `ResourcesHandle` port with `readResourceDir(uri)` (= `resources/list` filtered to
  direct children; subdirs as `inode/directory`) — mirror on source port + `mcp-bridge.ts` for structural identity.
- **[M]** `mcp_read_resource_dir` tool mirroring `read_resource.ts`; `renderResourceDirList` in `render.ts`.
- **[L]** **Blob-to-disk**: inject existing `ImageWritePort` + `resolveJailed` (same chokepoint as
  read/write/image-gen) — decode blob → jailed path under `ctx.cwd`, report `blobSavedTo`, never inline base64.
- **[S]** Add to the single `mcp_list_resources` GATED_TOOLS group (same `QUANTA_MCP_RESOURCES` gate, no new gate).
- **Risk**: blob-to-disk makes a read-only tool write files — `isReadOnly()===true` becomes a lie + adversarial-MCP can drop bytes → jail must be load-bearing, re-mark tool.

### B5 — Presence-aware push · ABSENT → gate the notify port with IdleMonitor
- **[S]** Pure `shouldPush({status,present,transport}) → {pushSent, disabledReason: config_off|user_present|no_transport}` (`notify/push-decision.ts`).
- **[M]** `NotificationPort` consults optional injected `isUserPresent?()` before OSC/BEL write (default absent ⇒ byte-identical).
- **[M]** Wire `IdleMonitor` at composition root: `isUserPresent = () => !idle.isIdle()` (reuse the SSOT idle signal, no parallel focus tracker). Gate default-OFF.
- **[S]** `getPushStats()` accounting (measurable suppression) + truth-table/wiring tests.
- **Risk**: `!idle.isIdle()` ⇒ "present" true for 60s after a keypress → a fast turn right after typing is suppressed (matches competitor intent, inverts current always-notify) — default-OFF.

## Landing order (verified)
1. **Cheap high-value strengthens on IMPLEMENTED**: S3 reasoning-split (value already parsed, just
   forward it) → B3 real citation spans → S1 network-capture+locator ladder → A1 structured options.
2. **Activate the inert**: A1 control-request drain, B2 durable-sqlite wire (code exists, ZERO call-sites — pure activation).
3. **Complete PARTIAL**: S2 item-stream unification (north-star) → B2 per-task-model + deeplink.
4. **Land ABSENT over existing seams**: B4 (smallest) → B5 → A3 → A2 (mermaid first) → B1.
Everything default-OFF; every threshold measure-first; every "never-in-context"/blob invariant pinned by a red-on-injection test.
