# Wire-Closeout Matrix — ADR 0121-0163 (2026-05-24)

Final wire-closeout audit covering every ADR shipped in this session. Each row traces:
- **AgentConfig slot** — typed slot in `src/agent/types.ts`
- **FeaturesConfig Pick** — slot listed in `FeaturesConfig` union (reachability proof)
- **tier1 builder** — pure builder in `src/agent/tier1/<name>.ts`
- **features.ts call** — `extraTools.push(...buildXBlock(config))` in `buildSessionFeatures`
- **mode-table entry** — `MUTATING_TOOL_TABLE` entry in `src/agent/mode.ts`
- **defaults** — included in `buildDefaultTools()` in `src/tool/index.ts`

**STATUS legend:**
- `fully wired` — every reachable column ticked; the slot is end-to-end live
- `caller-wired (helper-only)` — helper primitive; the slot is documented as intentionally caller-wired (no tier1 builder required by design)
- `partial — missing X` — gap; closed in THIS audit
- `orphan — needs Y` — gap; closed in THIS audit
- `internal — no slot needed` — implementation detail behind another slot
- `stub-only` — no shipped code path consumes it

## Matrix

| ADR | Module path | AgentConfig slot | FeaturesConfig Pick | tier1 builder | features.ts call | mode-table | defaults | STATUS |
|---|---|---|---|---|---|---|---|---|
| 0121 | `src/agent/checkpoint-policy.ts` + `src/agent/checkpoint-wiring.ts` | `shadowCheckpoint?` | (consumed via dispatch.ts) | n/a (dispatch wrap) | n/a | n/a | n/a | fully wired (dispatch.ts:522 `wireCheckpointedEffectChannel`) |
| 0122 | `src/tool/shadow/*` | `shadowOdb?` | yes | `buildShadowBlock` | yes (features.ts:149) | yes (3 entries) | no (caller-wired) | fully wired |
| 0123 | `src/agent/verify-checkpoint-bridge.ts` | n/a (built from `shadowOdb`) | n/a | n/a (caller-built) | n/a | n/a | n/a | caller-wired (helper-only) — wired in `src/agent/guards/build.ts:33` |
| 0124 | `src/agent/conversation-checkpoint.ts` | `conversationCheckpoint?` | yes | n/a (helper-only by design) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0125 | `src/agent/git-observability/*` | `gitObservability?` | (consumed via loop.ts) | n/a (loop-wired) | n/a | n/a | n/a | fully wired (loop.ts:1820 `wireGitObservability`) |
| 0126 | `src/tool/image/read.ts` | n/a (read-only default tool) | n/a | n/a | n/a | yes (`read_image: null`) | yes | fully wired |
| 0127 | `src/tool/web/fetch.ts` + `src/tool/web/search.ts` | `webSearch?` | yes | `buildWebSearchBlock` | **CLOSED-THIS-ROUND** (features.ts) | yes (`web_fetch: null`, `web_search: null`) | yes (`web_fetch`) / no (`web_search`) | **partial → fully wired** |
| 0128 | `src/agent/plan-queue.ts` | `planQueue?` | yes | n/a (helper-only by design) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0130 | `src/tool/subagent-bg/*` | `subagentBackground?` | yes | `buildSubagentBgBlock` | yes (features.ts:152) | yes (3 entries) | no (caller-wired) | fully wired |
| 0132 / 0146 | `src/tool/image/from-url.ts` | n/a | n/a | `buildReadImageUrlBlock` (**NEW-THIS-ROUND**) | **CLOSED-THIS-ROUND** | yes (`read_image_url: null`) | no (always-on factory, no port) | **orphan → fully wired** |
| 0133 | `src/tool/document/csv-read.ts` + `ndjson-read.ts` | n/a (read-only default tools) | n/a | n/a | n/a | yes (5 entries) | yes (5 tools) | fully wired |
| 0134 / 0149 | `src/skill/system-skills/*` | n/a (covered by `skills?` slot via ADR-0011) | n/a | n/a (existing skill block) | n/a | n/a | n/a | fully wired (skill discovery) |
| 0136 | `src/agent/budget-ledger.ts` + `budget-tool.ts` | `budgetLedger?` | yes | `buildBudgetBlock` | yes (features.ts:155) | yes (`budget_status: null`) | no (caller-wired) | fully wired |
| 0137 | `src/tool/document/pdf-read.ts` + `xlsx-read.ts` | n/a (read-only default tools) | n/a | n/a | n/a | yes (2 entries) | yes | fully wired |
| 0138 | `src/agent/budget-ledger.ts` | (same as 0136 `budgetLedger?`) | yes | (same as 0136 builder) | yes | yes | no | fully wired (same as 0136) |
| 0139 / 0151 | `src/llm/providers/*` | `llmProvider?` | yes | n/a (helper-only by design) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0140 | (same as 0130 `subagentBackground?` slot) | (same as 0130) | yes | (same as 0130) | yes | yes | no | fully wired (caller-wire sibling) |
| 0141 | `src/tool/lsp_nav/{code-action,format,signature-help,rename-apply}.ts` | `lspPorts?` | yes | n/a (helper-only — extraTools wire deferred to separate ADR per type doc) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0142 | `src/tool/document/index.ts` + `src/tool/web/providers/from-env.ts` | n/a | n/a | n/a | n/a | n/a | yes (doc tools in defaults) | fully wired |
| 0143 | `src/lsp/adapters/file-write-*.ts` | `osSandbox?` (separate slot — OS sandbox helper) | yes | n/a (helper-only by design) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0144 | `src/observability/metrics/*` | `metrics?` | yes | n/a (caller-instrumented per slice) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0145..0149 renumbered | (see ADRs grouped above) | (see above) | (see above) | (see above) | (see above) | (see above) | (see above) | (see above) |
| 0150 | `src/observability/metrics/otlp-helper.ts` + `src/runtime/os-sandbox/bubblewrap.ts` | n/a (internal Linux sandbox impl) | n/a | n/a | n/a | n/a | n/a | internal — no slot needed |
| 0152 | `src/lsp/adapters/base.ts` (`applyWorkspaceEdit` 2-phase) | n/a (internal to LSP applyEdit) | n/a | n/a | n/a | n/a | n/a | internal — no slot needed |
| 0154 | `src/observability/metrics/otel-sink.ts` | (consumed by `metrics?` slot when caller registers the sink) | (covered by 0144 entry) | n/a | n/a | n/a | n/a | caller-wired (helper-only) |
| 0155 | `src/mcp/skybridge/*` + `src/lsp/adapters/file-write-strategy.ts` | n/a (Skybridge is caller-wired registry; LSP strategy is internal port) | n/a | n/a | n/a | n/a | n/a | caller-wired (helper-only) / internal |
| 0156 | `src/lsp/adapters/base.ts` (cross-FS rename fallback) | n/a (internal) | n/a | n/a | n/a | n/a | n/a | internal — no slot needed |
| 0158 | `src/agent/subagent-persistence-store/*` (`persistentBackgroundSubagentScheduler` wrapper) | (composes onto `subagentBackground?` slot — same shape) | (covered by 0130 entry) | (same as 0130) | yes | (same as 0130) | no | fully wired (composition layer) |
| 0159 | `src/agent/subagent-resume/*` + `src/runtime/os-sandbox/linux.ts` | (uses `subagentBackground?` for resume target) | (covered by 0130 entry) | n/a (caller orchestrates) | n/a | n/a | n/a | caller-wired (helper-only) |
| 0160 | `src/mcp/skybridge/applevz-microvm.ts` + `lima-microvm.ts` | n/a (Skybridge microvm) | n/a | n/a | n/a | n/a | n/a | caller-wired (helper-only) |
| 0163 | `src/llm/providers/foundry-adapter.ts` + `foundry-watch.ts` | (uses `llmProvider?` slot) | (covered by 0139 entry) | n/a | n/a | n/a | n/a | caller-wired (helper-only) — scaffold for SDK availability |

## Summary

- **Fully wired** (end-to-end live, no closeout needed): ADR-0121 / 0122 / 0123 / 0125 / 0126 / 0130 / 0133 / 0134 / 0136 / 0137 / 0138 / 0140 / 0142 / 0158
- **Closed THIS round (partial → fully wired)**:
  - **ADR-0127** — `buildWebSearchBlock` exists but was not called in `buildSessionFeatures`; appended.
  - **ADR-0132/0146** — `readImageUrlTool` had no tier1 builder and was not in the image / tool barrel; tier1 builder added + barrel re-export added + features.ts call added.
- **Caller-wired (helper-only — intentionally no tier1 builder)**: ADR-0124 / 0128 / 0139 / 0141 / 0143 / 0144 / 0154 / 0155 / 0159 / 0160 / 0163
- **Internal — no slot needed**: ADR-0150 / 0152 / 0156

## Subtle decisions

1. **`read_image_url` builder vs always-on default tool.** Mirrors the `web_search` posture, NOT the `web_fetch` posture: it accepts an OPTIONAL `{ fetcher? }` test-injection seam, so an always-on default-tools entry would force a single fetch implementation. The tier1 builder is a thin "always emit" block (no AgentConfig slot needed — the tool's own DI seam is inside its factory), keeping the discovery posture parallel to `web_search` without churning AgentConfig.
2. **No new AgentConfig slot for `read_image_url`.** The tool has no host-side port to inject; its factory binds global `fetch` by default. Adding a slot would be ceremony without a real switch — keep it as the tier1 always-emit block.
3. **ADR-0141 LSP-sibling tools stay caller-wired.** The `lspPorts?` slot doc explicitly says "Caller-wire of these tools to `extraTools` is a separate ADR; for now just the slot." The 4 tool factories (`lspCodeActionTool` / `lspFormatTool` / `lspSignatureHelpTool` / `lspRenameApplyTool`) exist and are barrel-exported via `src/tool/lsp_nav/index.ts`; the registration ADR is intentionally separate. NOT a gap.
4. **0123 verify-checkpoint bridge stays caller-built.** It is built from the `shadowOdb` slot at `src/agent/guards/build.ts:33` and threaded into the verify path — no separate AgentConfig slot of its own, and that is the documented contract.
