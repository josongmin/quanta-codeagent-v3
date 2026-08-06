# RFC-12 — UIUX observable-render surfaces (Codex/Cursor UIUX audit residual)

**Status:** SCOPED — grounded implementation plan. Surfaced by a 3-track parallel UIUX audit (Cursor generative-UI / Codex webview / Codex+Claude interactive TUI) cross-referenced against quanta code. All BUILDs are default-OFF additive, single-owner, agent-state-observability-aligned (north star), measure-first.

**Audit basis:** corpus `.extracted_source/{cursor,codex,claude-code-cli,claude-code-ide}`, landed surface = `main@a65905c5a` (RFC-01~11).

## Method + what the audit KILLED (grep-verified, do NOT re-litigate)

Every "gap" the sub-audits proposed was re-grepped against `src/`+`apps/`. The bulk of both competitors' UIUX is **already-built** in quanta (permission cascade+profiles+extends, per-hunk apply+CAS undo, statusLine command, mode-cycle, resume picker, rewind/checkpoint/fork, queued-steer, spinner-stall, notify-presence, lifecycle-hooks engine, external import, /ps process panel, office-authoring tools, artifact render mermaid/pdf/csv/notebook, reasoning display) or non-absorbable product chrome (voice/realtime, in-app browser, connectors/marketplace, PR-lifecycle panel, CodeLens, pets/billing). **Two proposed gaps were KILLED by direct grep** (sub-agents were wrong):

- **LSP call-on-demand** — NOT a gap. `src/tool/lsp_nav/` ships `lsp_references`/`lsp_implementation`/`lsp_signature_help`/`lsp_code_action`/`lsp_format` callable tools (`ToolOrigin "lsp"`, `origin.ts:36`). The push-observation kernel is ADDITIONAL, not the only mode. (Matches RFC-09/10 "dispositioned".)
- **Structured mid-turn elicitation** — NOT a gap. `src/tool/ask-user/port.ts:20-71` ships typed `AskUserRequest` (`kind:"string"` + `options`, `AskUserValue = string | boolean | number | readonly string[]`) through the shared `mid-turn-approval-channel.ts` (which explicitly co-serves "MCP elicitation / ask_user").

## The genuine gaps (grep-proven) → BUILDs

### BUILD-1 — Plan dependency-graph (DAG) visualization  ★ top, HIGH alignment, LOW risk

**Reference (corpus):** Cursor `cursor/canvas/dag-layout.d.ts` — `computeDAGLayout({nodes:[{id}], edges:[{from,to}], direction, nodeWidth, rankGap, ...}) → {nodes:[{id,x,y,rank}], edges, rankBoxes, backEdgeFlags}`; pure math, DFS back-edge detection, no render deps. Cursor `todo-list.d.ts` renders it interactively.

**Grounding (quanta — the DATA already exists, only the VIEW is missing):**
- `src/agent/plan/task-projection.ts:11-13` already derives `blockedBy := todo.dependencies` (inbound edge) and `blocks(A) := reverse(dependencies)` (RFC07-3, no storage). `src/tool/plan/schemas.ts:20` — `dependencies … "(DAG)"`.
- `src/tool/plan/current-plan.ts:15-16` already emits `blockedBy=[…]`/`blocks=[…]` in the model-visible text.
- **Renderer already exists:** `apps/web-frontend/src/components/canvas/ArtifactStrip.tsx` `pickInlineRenderer` routes `"mermaid"` → `MermaidDiagram.tsx` (lazy); `src/artifact/rich-markers.ts` detects mermaid.
- **The gap:** `apps/web-frontend/src/components/PlanPanel.tsx` (72 lines) renders a FLAT list — grep for `dependenc|edge|graph|arrow` = 0. The agent produces the DAG edges every turn and the render throws them away.

**Implementation (lowest-risk path = reuse mermaid, NO new protocol kind):**
1. New pure projector `src/tool/plan/plan-to-mermaid.ts`: `Plan → mermaid flowchart` (`graph TD; id["title"]; dep --> id` for each `dependencies`; status→node class; back-edge/cycle safe). Reuses the `blockedBy`/`blocks` projection already in `task-projection.ts`.
2. Web: `PlanPanel.tsx` gains a graph toggle that renders the projected mermaid via the existing `MermaidDiagram` lazy component (no new renderer).
3. CLI: `current_plan` gains an optional `--graph`/`view:"graph"` that emits the mermaid fenced block (existing `rich-markers.ts` mermaid detection renders it).
4. (Optional richer follow-on) lift Cursor `computeDAGLayout` into a native interactive SVG `PlanDagView.tsx` with back-edge dashing + click-to-focus — only if mermaid fidelity proves insufficient (measure-first).

**Gate:** `QUANTA_PLAN_GRAPH` default-OFF ⇒ PlanPanel/current_plan byte-identical (flat list). **Owner:** `src/tool/plan/` (projection) + `PlanPanel.tsx` (view) — no new store, no protocol change. **Admission RED:** a plan with `dependencies` renders no graph (flat) with the gate on; red-on-injection = drop the projector ⇒ graph vanishes. **North-star:** "what is blocked and why" is answered directly from data the agent already emits. **Effort:** S.

### BUILD-2 — @-mention richer sources (+agents/subagents/mcp-servers/prior-threads)

**Reference (corpus):** Codex `atMentionList.{liveAgents, customAgents, mcpServers, skills}` — `@`-attaching an entity injects its context.

**Grounding (quanta — partial; the seam + 3 kinds already exist):**
- `src/apps/cli/at-autocomplete/provider.ts:45-49` already has `listSkills`/`listPlugins`/`listApps` (kinds file/symbol/skill/plugin/app). `port.ts:14,28` — `MentionKind` from `@/agent/mention-injection`; the resolver is `MentionResolverPort` (agent-loop `mentionInjector`, `loop.ts:1036`).
- **The gap:** no `agent`/`subagent`/`mcp`/`thread` kind — grep of provider.ts = files/symbol/skill/plugin/app only.

**Implementation (additive per-kind sub-listers, mirrors the existing safe-wrapped pattern):**
1. Extend `MentionKind` (`@/agent/mention-injection`) with `mcp`/`subagent`/`thread` (agent-role already reachable via subagent registry).
2. `provider.ts`: add `listMcpServers?`/`listSubagents?`/`listThreads?` NamedEntry sub-listers (each `safe`-wrapped, no-throw, per §6.1), reuse `listKebab`.
3. Resolver (`mention-injection`): resolve each new kind → injected context (MCP server's tool list, subagent handle/role, prior-thread summary via session store).

**Gate:** the new kinds ride the existing `QUANTA_AT_AUTOCOMPLETE`; absent listers ⇒ no candidates (byte-identical today). **Owner:** `at-autocomplete/provider.ts` + `@/agent/mention-injection`. **Admission RED:** typing `@` with MCP servers/subagents/threads present surfaces no candidates; red-on-injection = drop a lister ⇒ its kind vanishes. **Effort:** S-M.

### BUILD-3 — KaTeX display-math rendering

**Reference (corpus):** Codex webview bundles KaTeX WASM+fonts; renders `$$…$$` display math.

**Grounding (quanta — detection exists, renderer missing):**
- `src/artifact/rich-markers.ts:2-8` (A2) already SEGMENTS text into `text`/`mermaid`/`katex` and marks `$$…$$` for "a downstream renderer".
- `apps/web-frontend/src/components/canvas/ArtifactStrip.tsx` `InlineRenderer = "csv"|"notebook"|"mermaid"|"pdf"|null` — **no `"katex"`**; `MarkdownMessage.tsx` uses only remark-gfm.

**Implementation:** add `"katex"` to `InlineRenderer` + a `LazyKatex` component mirroring the existing `LazyMermaidDiagram`/`LazyPdfPreview` dynamic-import boundary (katex behind `lazy`). Wire the `rich-markers` katex segment → the lazy renderer in `MarkdownMessage.tsx`. **Gate:** default-OFF `QUANTA_KATEX` ⇒ katex segments render as plain `$$` text (today's behavior, byte-identical). **Owner:** `ArtifactStrip.tsx` + `rich-markers.ts`. **Effort:** S. **ROI:** LOW (only when the agent emits formal math). Measure-first.

### BUILD-4 — Web approval-card subagent attribution

**Reference (corpus):** Codex `permissionRequest.title.*.actor` — "which subagent asked".

**Grounding:** CLI ALREADY has it — `src/apps/cli/repl/cli-approval-prompt.ts:204` renders `Subagent '${team.workerId}' asks to run …`. The WEB `apps/web-frontend/src/components/EscalationCard.tsx` does NOT thread the requesting subagent id/role.

**Implementation:** thread the existing subagent workerId/role (already on the escalation payload the CLI reads) into `EscalationCard.tsx`'s label ("Allow *reviewer-agent* to edit?"). **Gate:** absent actor ⇒ card byte-identical. **Owner:** `EscalationCard.tsx`. **Effort:** XS. Trivial parity fix.

## Deferred (scoped, measure-first / higher-effort)

- **Inline anchored code-comment render panel** (Codex `::code-comment`, `pullRequestDetail.comments`) — agent already emits anchored comments (`src/tool/git/review-anchor.ts` + RFC-09-2 verdict/category), missing the WEB render over `apps/web-frontend/src/components/canvas/DiffView.tsx`. MED ROI (observability). Deferred: heavier web-render surface; scope after BUILD-1.
- **Chart primitives** (Cursor `chart-primitives.d.ts`: `BarChart/LineChart/PieChart`, `ChartSeries{name,data:number[],tone}`, zero-dep inline SVG) — genuinely absent; agent quantitative output. MED, measure-first (mermaid covers some). New `apps/web-frontend/src/components/canvas/ChartPrimitives.tsx` + a canvas protocol kind or artifact route.
- **Interactive canvas → loop feedback** (Cursor `useCanvasAction`/`useCanvasState`, `hooks.d.ts:57-140`) — quanta canvas is a closed daemon-push union (`src/protocol/canvas/messages.ts` = tool.diff/context.usage/artifact.ready), no reverse channel. HIGH effort + security. **Do NOT absorb Cursor's mechanism** (agent authors arbitrary `.canvas.tsx` React executed in-IDE — fights quanta's closed-protocol slice-fence ADR-0440); absorb only the *concept* (a typed reverse action verb on the closed protocol) if a consumer demands it.
- **Suggested automations** (Codex `automation.sidePanel.createSuggestion`) — scheduler substrate exists (RFC11-2); missing the agent-initiated *proposal* path. LOW-MED, measure-first.

## Non-absorbable (recorded to prevent re-flag)

Voice/realtime, in-app browser/computer-use, connectors/marketplace/OAuth catalog, PR-lifecycle panel (checks/merge/draft — GitHub-app chrome), CodeLens/gutter (editor-specific rendering; the dispatch already exists via context-add), pets/referral/billing, AppGen/image-playground, composer/sidebar/autosave webview affordances, Cursor arbitrary-`.canvas.tsx` execution.

## Landing rules

All BUILDs default-OFF additive, single-owner, hellgate (admission RED + gate-OFF byte-identical + red-on-injection) + ≥3R hellaudit, no new store/protocol-kind (BUILD-1 reuses mermaid; BUILD-2 reuses the provider seam; BUILD-3 reuses the lazy-renderer pattern). BUILD-1 is the flagship (data-present/view-absent, north-star). None is a SWE-score lever — all are agent-state-observability / UX surfaces; measure-first on efficacy.
