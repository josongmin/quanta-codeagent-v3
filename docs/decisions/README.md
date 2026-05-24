# ADR Index

Architectural Decision Records for quanta-codeagent-v3.

Conventions: filenames are `NNNN-slug.md`. Numbers are roughly chronological; the slug describes the decision. Each record is self-contained — read it standalone before tracing forward references.

> ⚠️ **Known collisions**
>
> ADR number **0068** is used by **two** files (audit finding, not yet reconciled — both ship live in `main`):
>
> - [`0068-codex-2-phase-memory-consolidator.md`](0068-codex-2-phase-memory-consolidator.md) — Codex 2-Phase memory consolidator (SOTA++ v2)
> - [`0068-persona-slot.md`](0068-persona-slot.md) — Persona slot (Codex `{{ personality }}` Handlebars absorption)
>
> **Recommendation** (not yet executed — would conflict with user in-flight work on `src/memory/consolidate/*`): keep `0068-codex-2-phase-memory-consolidator.md` as **0068** (it touches the larger surface area, currently being edited per `git status`) and renumber `0068-persona-slot.md` → **0099** as a backfill, updating any back-references. Do **not** rename ahead of that user track.

## Regenerating this index

Manually regenerated. To refresh, run:

```bash
for f in docs/decisions/*.md; do head -1 "$f"; done
```

…and reconcile any new entries against the table below. (No generator script exists yet; if/when one is added, it should live under `scripts/` and emit this file deterministically.)

## Slice key (inferred from slug)

| slice | meaning |
|---|---|
| meta | process / convention / index — not a runtime decision |
| agent | `src/agent/*` — loop, dispatch, admissibility, conversation-action |
| tool | `src/tool/*` — factories, tool surface, apply_patch, lsp, git |
| permission | `src/permission/*` — policy, HITL, trust-scope, rules |
| memory | `src/memory/*` — recall, persist, consolidate, citation |
| prompt | system prompt, templating, sections |
| stream | streaming + JSONL recording + envelope |
| skill | skills / extensions / subagent / plugin |
| mcp | MCP slice |
| runtime | sandbox, shell, jail, effect channel |
| observability | metrics, OTel, dashboards, eval |
| modes | run-mode / collaboration-mode / plan / review |
| arch | cross-cutting architectural keystones (planes, channels, providers) |
| surface | desktop / IDE / CLI surface contracts |

## Index

| # | Title | Slice |
|---|---|---|
| 0001 | Biome 2.x로 슬라이스 경계 lint 강제 | meta |
| 0002 | OpenAI를 2번째 LLM provider로 추가 | llm |
| 0003 | 테스트 피라미드를 4티어로 분리하고 CI로 강제 | meta |
| 0004 | 시스템 프롬프트를 정적 프리픽스로 고정해 캐시 적중 | prompt |
| 0005 | (의도적 결번) | meta |
| 0006 | runtime 샌드박스 추상화 — Local(약식) + Docker(opt-in) | runtime |
| 0007 | MCP 클라이언트를 신규 슬라이스로 추가하고 agent에서 브리지 | mcp |
| 0008 | SOTA++ 계층형 시맨틱 메모리 | memory |
| 0009 | LSP를 `diagnostics` 도구로 에이전트에 노출 | tool |
| 0010 | 관측 플랫폼 — Trajectory 스키마 + Probe (SDK 비의존) | observability |
| 0011 | Claude Code v2 SOTA++ 흡수 (Tier 0+1) | arch |
| 0012 | 전역 LoC 예산 철회 | meta |
| 0013 | 완료 전 검증 가드 (verify-before-finish) | agent |
| 0014 | bench 외부 repair 라운드 (continue-from-patched-tree) | observability |
| 0015 | Codex Foundation: TurnContext expansion + repo-local rule ingestion | agent |
| 0016 | Prompt policy: claim ladder + trust ladder + budget + honesty rail | prompt |
| 0017 | Closeout: defended-claim 4-rule + VerificationCloseout scaffold | agent |
| 0018 | Mode enum: default / plan / review / audit | modes |
| 0019 | Code modification: edit-strategy hint + scripted_replace + 4-truth-surface closeout | tool |
| 0020 | HITL: 4-tier confirmation gate | permission |
| 0021 | Memory 5-layer: artifact rail + WorkingState L3 | memory |
| 0022 | Skill trigger rules + tool routing matrix | skill |
| 0023 | SOTA++ Codex absorption: integration + byte-identical invariant | arch |
| 0024 | LSP nav surface 확장 (definition/references/hover/symbol/rename-preview) | tool |
| 0025 | Git 1급 도구 (diff/status/log/blame) | tool |
| 0026 | Admissibility-gate SSOT 추출 | agent |
| 0027 | Anti-signal 카탈로그 + policy-injection 적대성 게이트 | permission |
| 0028 | `apply_patch` V4A format + deterministic fuzzy match | tool |
| 0029 | Reviewer 3-tier enum + 8-state approval outcome | modes |
| 0030 | Mid-turn steering + NonSteerableTurnKind | agent |
| 0031 | Prefix-rule allowlist DSL + 3-layer precedence | permission |
| 0032 | OTel canonical attribute vocabulary | observability |
| 0033 | JSON-RPC 2.0 envelope + 명시적 -timeout 채널 + version lockstep | stream |
| 0034 | Session JSONL envelope (5 top-level types + 17 turn_context fields + v3 subagent linkage) | stream |
| 0035 | jsonl-recorder cumulative-bytes sliding-window retention | stream |
| 0036 | Plan vs Default collaboration mode — dispatch-seam mutating block | modes |
| 0037 | Queued follow-ups (PausedReason + per-thread FIFO 큐) | agent |
| 0038 | External-agent import 4-stage lifecycle | skill |
| 0039 | 플러그인 매니페스트 레이아웃 (.quanta-plugin/) | skill |
| 0040 | Skills vs Extensions split + SKILL.md frontmatter | skill |
| 0041 | Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input) | skill |
| 0042 | agent_role enum (explorer/worker/none) + maestro nickname pool | skill |
| 0043 | 데스크톱 표면 reference (Seatbelt / Skybridge / microVM) | surface |
| 0044 | Negative invariants (Codex/Claude Desktop에서 의도적으로 채택 안 하는 패턴들) | arch |
| 0045 | progress-audit system skill (bundled, code-evidence audit discipline) | skill |
| 0046 | Permission stack: per-thread + per-host + post-denial precedence | permission |
| 0047 | HITL 4-tier gate: annotation registry + handoff seam | permission |
| 0048 | `response.in_progress` streaming event 처음부터 처리 — Codex forward-compat gap 보완 | stream |
| 0049 | Side-conversation seam (Codex `codex.thread.side` 흡수) | agent |
| 0050 | Trust-Scope Registry Wire-Up (Phase C) | permission |
| 0051 | Sectioned system prompt default ON (Claude Desktop `systemPromptSectionCache` 흡수) | prompt |
| 0052 | Message-id rewind (Claude Desktop 1.7196.3 parity) | agent |
| 0053 | Git mutating 1급 도구 (commit, branch_switch) — Claude Desktop `commitWipForBranchSwitch` 흡수 | tool |
| 0054 | Context-usage metrics + surface-agnostic status line | observability |
| 0055 | AWF 2-matcher PreToolUse hook channel | agent |
| 0056 | Disclaimer shell wrapper (dotfile-skipping spawn) | runtime |
| 0057 | Session effort dimension (5-tier) | modes |
| 0058 | Anthropic beta channels + 30 MB skill size cap | skill |
| 0059 | Five built-in slash commands (CLI surface) | surface |
| 0060 | defineTool — output-schema + toModelOutput + deferred + streaming-input (v0.dev `createProviderToolFactoryWithOutputSchema` 흡수) | tool |
| 0061 | rememberPatterns — 권한 패턴 학습 + cascade 자동해소 (v0.dev 흡수) | permission |
| 0062 | Tool-failure ladder + exploration multi-step pattern | tool |
| 0063 | Plan 모드 3-way exit (approve / reject / request-changes) (v0.dev 흡수) | modes |
| 0064 | git_upstream_check — upstream 분기 감지 read-only 도구 (v0.dev chat=branch 흡수) | tool |
| 0065 | workMetrics — turn별 비용·작업 투명성 (v0.dev 흡수) | observability |
| 0066 | 모델 교체 retry — SubmitRetryBotMessage 흡수 (v0.dev) | llm |
| 0067 | Prompt template SOTA++ (vs Codex / Claude Code parity gaps) | prompt |
| 0068 | Codex 2-Phase memory consolidator (SOTA++ v2) — ⚠️ COLLISION | memory |
| 0068 | Persona slot (Codex `{{ personality }}` Handlebars absorption) — ⚠️ COLLISION | prompt |
| 0069 | typed per-failure-mode tool results — discriminated `ToolFailure` 유니온 (Cursor `EditResult`/`ShellResult` 흡수) | tool |
| 0070 | review-kind × isExecutionBlocking × reason_code 권한 매트릭스 + scoped-allowlist 결정 verb (Cursor HITL gate 흡수) | permission |
| 0071 | ConversationAction — 타입드 mid-turn steering 액션 대수 (Cursor `ConversationAction` oneof 흡수) | agent |
| 0072 | Submission op envelope — host→agent 입력의 타입드 봉투 (Codex 흡수, Spec A3) | stream |
| 0073 | StopCategory matrix — 구조적 정지 사유 (Cursor 흡수, Spec B3) | agent |
| 0074 | OTel span tree (Codex 10-step) — core 4-stage wrap | observability |
| 0075 | Pre-Compact HITL + ConversationSummaryArchive (Cursor 흡수) | memory |
| 0076 | Agent-loop branch hardening (refusal / reasoning / submission-op / deny-and-steer) | agent |
| 0077 | Phase marker + TTFT + readonly deny-steer trio | agent |
| 0078 | Secret redaction as content-plane invariant | stream |
| 0079 | tool_choice forcing as an orthogonal control gate | agent |
| 0080 | IDE context provider seam | surface |
| 0081 | Shell output delta streaming | runtime |
| 0082 | memory_citation provenance surface | memory |
| 0083 | Multi-modal image input (dual-provider) | llm |
| 0084 | Speculative branch search — N-best verifier-prover | agent |
| 0085 | Cost & cache dashboard | observability |
| 0086 | request_plan_exit tool — plan-exit 3-way wire | tool |
| 0087 | eval 스키마 additive 필드 — keyed metrics / token·cost / run status·params (Cursor `EvalTrackingService` 흡수) | observability |
| 0088 | PhaseGate HITL feedback ladder (Cursor AiProjectService 흡수) | permission |
| 0089 | Lint-grounded reflect gate with typed 3-way decision | agent |
| 0090 | Declarative event-triggered agent automation (`trigger → agentic filter → agent spawn → run record`) | modes |
| 0091 | git-write-protection static deny — `.git/{hooks,config}` + `.vscode` write = 코드실행 탈옥 벡터 (Cursor `cursorsandbox` 흡수) | permission |
| 0092 | Run-mode expansion — `ide` + `daemon` (C1) | modes |
| 0093 | EffectChannel — relocatable effect boundary (M1 keystone) | arch |
| 0094 | 5-plane contracts — design canon (M0 structural keystone) | arch |
| 0095 | SandboxEffectChannel — substrate-swap proof for the EffectChannel keystone (Phase 2) | runtime |
| 0096 | ContextProvider — pluggable retrieval/memory/snapshot plane (Context plane keystone) | arch |
| 0097 | PhaseGate state machine implementation (ADR-0088 design → code) | permission |
| 0098 | Lint-grounded reflect gate — pure baseline impl (ADR-0089 design → code) | agent |
| 0099 | Git posture — default fail-closed (Codex §18.2/§18.4/§18.5 흡수) | prompt |
| 0100 | Destructive git HARD_DENY 6룰 (런타임 backstop) | permission |
| 0101 | Push mass-delete guard 3룰 (Claude Desktop `push_refused_mass_delete` 흡수) | permission |
| 0102 | `turn_diff_updated` stream event + emitter (Codex `turn/diff/updated` 흡수) | observability |
| 0103 | `gh_pr_blame` — PR review-thread blame (Cursor `StreamCodeTour.Blame` 흡수) | tool |
| 0104 | `gh_pr_review_diff` / `gh_pr_auto_merge` / `gh_pr_create.draft` (Claude Desktop PR IPC 흡수) | tool |
| 0105 | Git env determinism + US-separator log format (Codex §18.7 흡수) | tool |
| 0106 | SessionMeta git fingerprint (Codex §18.9 흡수) | observability |
| 0107 | `GitBudget` 5-knob capture budget (Cursor `captureGitHistory` 흡수) | tool |
| 0108 | Shadow git ODB foundation — 사용자 `.git` 비침습 스냅샷 인프라 | tool |
| 0109 | Moved-code detector + classifier — PR-review canvas §2 "moved" 카테고리 | tool |
| 0110 | Git observability wiring helpers (opt-in seam for ADR-0102/0106) | observability |
| 0111 | CTK git-skill bundle (8 system skills, Cursor cursor-team-kit absorption) | skill |
| 0112 | `git_review_diff` — isolated diff reviewer sub-agent (Claude Desktop `reviewDiff` 흡수) | tool |
| 0113 | `pre_tool_use` hook `updatedInput` (Cursor parity) | agent |
| 0114 | Typed tool failures: bash `permission_denied` + read `not_found` (gap closure) | tool |
| 0115 | Localize tool: SOTA++ signal hardening (BM25-lite + FrameTier + def-boost) | skill |
| 0116 | Branch-search ↔ Shadow ODB 앵커 시밍 — 최초 wiring | agent |
| 0117 | Branch-search minimal-change bias + CLI progress surface | agent |
| 0118 | Shadow ODB `rewindToLast` — 파괴적 복원 + 자동 안전망 | tool |
| 0119 | `shadow_rewind` + `shadow_snapshots` 첫-class agent tool 노출 | tool |
| 0120 | Refusal `stop_reason` typed surface — Gap-1 SOTA++ | agent |
| 0121 | Auto-checkpoint policy for the shadow git ODB | tool |
| 0122 | ShadowOdb rewind extensions — per-file restore + verified anchor + /rewind skill | tool |
| 0123 | Verify-checkpoint bridge — opt-in markVerified caller seam | agent |
| 0124 | Conversation checkpoint store — primitive for the missing rollback half | agent |
| 0125 | Turn-diff wiring consolidation + integration proof | observability |
| 0126 | `read_image` 도구 + ToolResult.images 필드 + 컴포저 헬퍼 | tool |
| 0127 | `web_fetch` + `web_search` tool slice (web 가용성 갭 봉합) | tool |
| 0128 | Plan-queue helper — Codex mid-turn follow-up queue as a typed primitive | agent |
| 0129 | Localize: closing the recall@1 gap (sibling-`.js` penalty + VENDORED_RE for generator dirs) | skill |
| 0130 | Extracted-source absorption roadmap (R1–R6 → ADR 후보 catalog) — **Proposed** (roadmap only) | meta |
| 0131 | Memory hygiene: 4-state outcome enum + preference phrase grammar + 10% phase2 promotion | memory |
| 0132 | Autonomous proactive reactor: SIMULATED_MSG_REASON + cloud-agent branch snapshot 사다리 — **Proposed** | modes |
| 0133 | Hook bidirectional Request/Response RPC paired (6 lifecycle events + prompt_hook injection) | agent |
| 0134 | Skill 7-scope tiering (builtIn / system / admin / team / repo / user / personal) — **Proposed** | skill |
| 0135 | Permission profile + file_system_sandbox_policy 2-layer + 4-pillar Permission — **Proposed** | permission |
| 0136 | OS-level sandbox helper — Cursor `cursorsandbox` + Codex Seatbelt 흡수 | runtime |
| 0137 | Document readers extensions — YAML / PDF (native attachment) / XLSX (stub) | tool |
| 0138 | Token budget ledger — typed BudgetBreach primitive over per-model pricing | observability |
| 0139 | LLM provider fork — Anthropic 전송 4갈래 (default/bedrock/vertex/foundry) 헥사고날 포트 | llm |
| 0140 | ADR-0140 — Background-subagent caller wire — ADR-0145 (renumbered from ADR-0130) helper를 loop에 노출 | agent |
| 0141 | ADR-0141 — LSP 4-tool 확장 — code-action / rename-apply / format / signature-help | tool |
| 0142 | ADR-0142 — Wire finalization — web-search env factory + document-tools default registration | tool |
| 0143 | ADR-0143 — LSP default-adapter 실배선 — code-action / format / signature-help / applyWorkspaceEdit | tool |
| 0144 | ADR-0144 — Observability metrics — typed counter/histogram/gauge primitive over `AgentEvent` trace stream | observability |
| 0145 | Background subagent scheduler — Cursor `force_background_subagent` 흡수 (renumbered from ADR-0130) | agent |
| 0146 | `read_image_url` 도구 — URL → vision 파이프라인 (renumbered from ADR-0132) | tool |
| 0147 | `csv_read` + `ndjson_read` document tool slice (renumbered from ADR-0133) | tool |
| 0148 | Web search provider concrete impls — Brave primary + DuckDuckGo fallback (renumbered from sibling ADR-0133) | tool |
| 0149 | Engineering-task skill bundle — 4 system skills: debug / test / explain / refactor (renumbered from ADR-0134) | skill |

## Status notes

- ADR-0005 is an **intentional gap** (numbering convention — not skipped by error).
- ADR-0043 and 0044 are marked "잠정 번호 (provisional number)" in their files; treat as ratified pending a future cleanup pass.
- ADR-0097 and 0098 are **implementations** of design ADRs 0088 and 0089 respectively — read the design ADR first.
- ADR-0094 is the **structural keystone** for the 5-plane architecture; 0093/0095/0096 specialize one plane each.
- **Proposed** entries (0130, 0132, 0134, 0135) are roadmap/spec ADRs whose implementation work has not landed; they describe future absorption rounds rather than shipped surface.

## Collision audit trail

History of intentional or accidental ADR-number collisions and their reconciliation. New collisions land here when the round closes.

| Collision | Original (kept) | Renumbered (ours) | Round |
|---|---|---|---|
| 0068 | `0068-codex-2-phase-memory-consolidator.md` | `0068-persona-slot.md` (deferred — both still ship live in `main`; see "Known collisions" notice above) | 2026-05-21 |
| 0130 | `0130-extracted-source-absorption-roadmap.md` (user roadmap) | `0145-background-subagent.md` | 2026-05-24 |
| 0132 | `0132-autonomous-proactive-reactor.md` (user) | `0146-read-image-url.md` | 2026-05-24 |
| 0133 | `0133-hook-bidirectional-rpc.md` (user) | `0147-document-tools.md`, `0148-web-search-providers.md` | 2026-05-24 |
| 0134 | `0134-skill-scope-tiering.md` (user) | `0149-engineering-skills-bundle.md` | 2026-05-24 |
| 0176 | `0176-tool-call-dedup.md` (user) | `0183-html-to-markdown-turndown-swap.md` | 2026-05-25 |
| 0178 | `0178-mid-turn-interruption.md` (user) | `0184-conversation-checkpoint-lru-swap.md`, `0185-file-write-atomic-lib-swap.md` | 2026-05-25 |
