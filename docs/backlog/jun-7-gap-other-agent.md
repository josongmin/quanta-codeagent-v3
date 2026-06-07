# jun-7 — 경쟁사 대비 GAP 정리 (근거 기반)

> **출처**: `.extracted_source/` 코퍼스 — Claude Desktop 1.0.734 · Claude Code CLI 2.1.150 (`claude-code-cli/_cli-symbols.txt`) · Codex Desktop 3390 / codex-rs 0.135 (`codex/_codex-rs-0.135-symbols.txt`) · Codex CLI 0.133 (`codex-cli/`) · Cursor 3.5.33 (`cursor/out/vs/workbench/workbench.desktop.main.js`) · userdata configs.
> **방법**: 12바퀴 적대 검증(7 claim-verify + 5 신규영역). 각 항목 경쟁사 소스(파일:심볼/라인) ↔ quanta 소스(파일:라인) **field-by-field 대조**. "같은 이름 심볼 = covered" 핸드웨이브 금지 — grep으로 부재 확인.

## ✅ Wave R 랜딩 (jun-7) — 비겹침 나머지 5 slice 구현완료

사용자가 고-ROI Wave 1-4(grep/glob·MCP annotations+image·subagent identity·stdout-json·ratelimit·verify-gate)를 직접 가져갔고, **파일 충돌 없는 나머지 leaf 5개를 SOTA++ + 3x 적대검증으로 구현**:

| slice | 갭 | 상태 | 파일 |
|---|---|---|---|
| R1 | §21.5 search_codebase `scope` directory filter | **LANDED** | `src/tool/search-codebase/index.ts` |
| R2 | §22.2 Skill `$ARGUMENTS`/`$N` 템플릿 | **LANDED** | `src/skill/skill-tool.ts` |
| R3 | §23.3 `/version`·`/release-notes` | **LANDED** | `src/apps/cli/version-cmd.ts`+`repo-info.ts` |
| R4 | §23.4 `/bug` → prefilled GitHub issue URL | **LANDED** | `src/apps/cli/bug-cmd.ts` |
| R5 | §23.5 per-model cost breakdown | **LANDED** | `src/apps/cli/cost-panel.ts` |

**2-라운드 적대검증으로 보강**:
- **1차(3-agent)** 실버그 2: F1=skill `$ARGUMENTS`→`$N` 이중치환(chained replace 재스캔)→single-pass 정규식. F3=`QUANTA_REPO_URL` 스킴검증 없음→https-only.
- **2차(30-agent 적대+객관, refute-by-default)** 22제기→15확정→전부 구조수정: **R1** normalizeScope/inScope **asymmetry 근본제거**(공유 `foldPathish`: 백슬래시 scope 0건·`scope="."` 0건·`././` 부분strip 동시해결) + 에러분기 테스트. **R3/R4** repo-controlled package.json version의 **ANSI/OSC 터미널-주입**(untrusted repo open 시 `/version`) sanitize=진짜 bug + repoUrl 정규화(fragment/query/userinfo/FQDN 검증). **R5** model id sanitize·음수 cost clamp·formatTokens dead-branch·per-model cache-read(reconcile).

전부 red-on-injection 회귀테스트 박음. 포스처: correctness-fix는 default-ON, 전부 "absent 입력→byte-identical" 불변식. fc 4 entry(`jun7-*`) 등록, tsc0/biome0/회귀0(1188 pass).

### Wave R2 (jun-7, 사용자 wave land 후) — MCP ingestion 트리오 완성

사용자 Wave 1-C(annotations+image)가 land한 뒤, 같은 파일군 위에 additive로 MCP ingestion 잔여를 완성(+ 3회 적대 셀프검증):

| 갭 | 상태 | 핵심 |
|---|---|---|
| §19.2 structuredContent → `ToolResult.structured` | **LANDED** | client `ToolsCallResult.structuredContent` → `McpCallResult.structured` → bridge `toToolResult`. absent⇒byte-identical |
| §19.4 MCP progress bridge | **LANDED** | 신규 `src/mcp/progress.ts`(parse+DoS cap) + client per-token `progressHandlers` + dispatch route + bridge `streamMcpCall`(async-queue) → `ToolEvent.progress`. **default-OFF seam**(`McpToolBindOpts.progress`): off⇒`_meta` 미전송 byte-identical wire |
| §19.5 tools/list_changed | **LANDED** | `notifications/tools/list_changed` → 기존 observer 채널에 `tools_list_changed` variant 추가(host re-list hook) |

적대검증 finding: progress가 모든 wire에 `_meta` 붙이던 것 → **default-OFF 게이팅**으로 byte-identical 복구. dispatch 복잡도 32→clean(resolveResponse/routeProgressNotification 추출). streamMcpCall sync-throw 하드닝. tsc0/biome0(내 함수)/MCP 591 pass.

**아직 deferred**: §20.4 owned/forbidden FS enforce(subagent-runner hot-path, advisory→enforce 별도 수술) · §22.3 reverse-MCP(신규 server-side subsystem) · §23.2 quota-exhausted graceful(**clean leaf 아님** — `usageLimitExceeded` 메시지 구성이 LLM 에러분류 레이어를 가로지름 + 네 §23.1 ratelimit-notice가 이미 approaching/exhausted+resetMs 대부분 처리). 셋 다 별도 집중 작업 권장.

---

## ⚠️ 정직한 흡수율 (이전 "90%"는 과대평가)

근거로 ~45개 claim 깊이 검증:

| 판정 | 비율 | 의미 |
|---|---|---|
| **TRUE-PARITY** (동등/우위) | **~35%** | 실제 메커니즘까지 패리티 |
| **OVERCLAIMED-PARTIAL** (필드/메커니즘 누락) | **~50%** | shape는 있으나 약함 |
| **ACTUAL-GAP** (진짜 부재) | **~13%** | 없음 |

**기본기(shape) ~85% 갖췄으나, mechanism 깊이 패리티는 ~35%.** "같은 이름 심볼"을 covered로 처리한 게 과대평가 원인.

**🟢 진짜 강한 곳 (패리티/우위, 검증됨)**: retrieval(BM25+RRF+tree-sitter+8 embedder, src tsc-clean) · prompt-assembly(§5 번들 완비) · token-accounting(delta+live-usage) · paste-burst · MCP OAuth(jun-06 live-wire 확인) · MCP sampling(+DoS cap 우위) · deny-reason(typed layer/pillar 우위) · classifier 2-stage core · persona · retention(sqlite GC 충실) · web-fetch(SSRF redirect-recheck 우위) · apply-patch V4A 문법(Move/EOF/fuzzy 완비) · hooks(superset, 15 events) · memory 2-phase 메커니즘 · 1h/5m cache TTL · reasoning carryover(encrypted_content) · multicloud provider · branch-search(speculative N-best) · sandbox(5 profile + seatbelt-verbatim+landlock+bubblewrap+windows) · 권한 profile layering · OTel(span+OTLP+w3c) · realtime voice slice · image-gen(+edit) · 15-tool browser · pdf/office triad.

---

## 🔴 우선순위 TOP (ROI×임팩트, 근거 확정)

> **STATUS (verified jun-07 src grep)** — P-list 검증마커는 각 §섹션 본문에 인라인(아래 §14–§26). 요약(15 verified flips/confirms):
> **✅ LANDED (14)**: P5(tool_search) · P12(closeout-critic) · P13(=§26.5 model-window) · P14(=§26.10 read truncation) · P19(MCP annotations) · P20(MCP image) · P21(subagent system) · P22(named-agent load) · P23(grep -A/-B/-C) · P24(grep output_mode) · P25(glob gitignore/mtime) · P26(stream-json) · P27(ratelimit notice) · §26.1(tree-sitter chunking — jun-07 2nd-pass 배선). 또 §12.2 HTTPS-MITM body-scan(Node+Bun)·D1-D8 naive-impl 하든 8/8 FIXED.
> **🔲 OPEN (10)**: P1(MCP proto 2025-06-18 그대로) · P3(Guardian assessor) · P4(auto-mode bypass) · P6(image downsample) · P7(중앙config/trust-gate) · P10(MCP SSE resume) · **P11(shell ANSI-strip — verified OPEN)** · P15(UTF-16/BOM) · P16(bash -lc Windows) · P17(NotebookEdit). P18(corrupt-store)은 §13 소관(이번 검증범위 외).
> **PARTIAL (3)**: P2(skill 측 부분해소·plugin 측 strict 그대로) · P8(subagent worktree isolation 있음·Enter/ExitWorktree 도구 없음) · P9(compaction-window 해소·1m beta-header 미plumb).

| # | GAP | 카테고리 | 비용 | 임팩트 |
|---|---|---|---|---|
| P1 | MCP 프로토콜 `2025-06-18`→`2025-11-25` + nego fallback | MCP | 저 | 고(interop) |
| P2 | 스킬/플러그인 manifest **실제 codex 아티팩트 거부** | Skill/Plugin | 저 | 고(interop 실패) |
| P3 | Guardian per-action-class assessor 없음 | Safety | 중 | 고(보안) |
| P4 | auto-mode 유저룰 오버레이 + tool-switch 우회탐지 | Safety | 저-중 | 고(보안) |
| P5 | Deferred tool-schema pool (lazy load) | Tools/Token | 중 | 고(토큰) |
| P6 | 대용량 이미지 downsample (reject 대신) | Vision | 저-중 | 중-고 |
| P7 | per-project trust gate + 중앙 config 파일 부재 | Config | 중 | 중-고 |
| P8 | Worktree isolation mode + Enter/ExitWorktree 도구 | Git | 중 | 고(동시편집 안전) |
| P9 | Model `[1m]` 1M-context 와이어링(orphan literal) | LLM | 저 | 중-고 |
| P10 | MCP SSE resumption (Last-Event-ID) | MCP | 저-중 | 중 |

**추가 발굴 (8-12바퀴, 다른 각도)** — robustness/효율/IO/verification:

| # | GAP | 카테고리 | 비용 | 임팩트 |
|---|---|---|---|---|
| P11 | shell 출력 ANSI/control-char strip 없음(`bash/index.ts:281`) | Shell-IO | **저(pure fn)** | 중-고(colored CLI 흔함) |
| P12 | closeout-triggered critic gate(부품 다 있음, 배선만) — **LANDED ✅** (`src/agent/closeout-critic.ts` closed-port `CloseoutCritic`+fail-open `runCloseoutCritic` / `loop/recovery-executor.ts` 두 completed 봉인지점 `maybeRunCloseoutCritic` / knob `QUANTA_CLOSEOUT_CRITIC` default-OFF. reviewer는 DI 포트로만, 포트 absent⇒fail-open, denied verdict는 기존 `recovery`/`closeout` 이벤트로 advisory surface·완료 차단 안 함. OFF/포트-absent⇒await 전 sync 단락 byte-identical) | Verify | 저-중 | 고 |
| P13 | per-model context-window 비례 compaction(고정120k, model-blind) | Efficiency | 중 | 중-고(토큰) |
| P14 | 과긴 단일라인 truncation 없음(`read/index.ts:53`) | IO | 저 | 중 |
| P15 | UTF-16/BOM 감지(UTF-16을 binary로 오분류) | Encoding | 중 | 중(Windows 고) |
| P16 | shell 하드코딩 `bash -lc`(Windows shell 없음 `shell.ts:138`) | Platform | 중 | 중(Windows surface) |
| P17 | cell-aware NotebookEdit(read half는 shipped) | IO | 중 | 중(data-science) |
| P18 | aggregate corrupt-store 감지+복구안내(전체 history 무음손실 방지) | Resilience | 저 | 중 |

**추가 발굴 (13-17바퀴, 깊은 각도)** — 도구계약/subagent전문화/검색/SDK/투명성:

| # | GAP | 카테고리 | 비용 | 임팩트 |
|---|---|---|---|---|
| P19 | MCP `ToolAnnotations`(readOnly/destructiveHint) ingestion 드롭(`mcp-bridge.ts:87` 전부 mutating 하드코딩) | Tool-protocol | 저 | **고(보안+병렬)** |
| P20 | MCP image content-block 결과 드롭(네이티브 image plumb는 완성, 매핑만 `client.ts:161`) | Tool-protocol | 저-중 | 중-고(vision) |
| P21 | subagent role-specialized system prompt 없음(child=`parent.system` `subagent-runner.ts:461`) | Subagent | 저-중 | 고(역할위임) |
| P22 | named agent `.quanta/agents/*.md` 런타임 로드 안됨(converter는 있음) | Subagent | 중 | 고 |
| P23 | grep context lines `-A/-B/-C` 없음(`grep/index.ts:51` 고정argv) | Search | **저** | 고(Read 왕복 제거) |
| P24 | grep `output_mode`(files_with_matches/count) 없음 | Search | **저** | 고(breadth survey) |
| P25 | glob gitignore 미존중 + mtime sort 없음(`glob/index.ts:55` Bun.Glob junk) | Search | 저 | 중-고 |
| P26 | `--output-format stream-json`(stdout) 없음 — SessionEvent+codec 완비, writer만 | SDK | 저-중 | 고(CI/SDK keystone) |
| P27 | usage-limit "approaching·resets" UX(snapshot 파싱됨, `stdout.ts:151` 무시) | Transparency | 저 | 고 |

> **싼 quick-win 묶음(비용 저, 즉효)**: P11 ANSI-strip · P14 라인-truncation · **P19 MCP annotations** · **P23/P24 grep context+output_mode** · **P25 glob gitignore/mtime** · P18 corrupt-store hint · P2 skill/plugin schema 완화 · P9 model[1m] · P27 ratelimit 렌더 · §18.2/§22.2 prose/템플릿. 
> **"부품 다 있고 배선만"(composition-only, ROI 고)**: P12 closeout-critic · P20 MCP image 매핑 · P21+P22 subagent system+named-load(한 seam) · P26 stdout-json · P27 ratelimit-render.

---

## 1. MCP / 프로토콜

### 1.1 [NEW-GAP] 프로토콜 버전 뒤처짐 — P1 — 🔲 OPEN (verified jun-07: `src/mcp/client.ts:46`+`isolated-client.ts:42`+`transports/http-sse.ts:36` 전부 `PROTOCOL_VERSION="2025-06-18"` 하드코딩 그대로; `supportedVersions`/`versionList`/`downgrade`/`2025-11-25` grep 0 in `src/mcp/`)
- **경쟁사**: Cursor SDK `cursor/extensions/cursor-mcp/dist/main.js:9322-9323` → `const i="2025-11-25", s=[i,"2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`. Codex `codex/_codex-rs-0.135-symbols.txt` → `2025-11-25`(×2)+fallback.
- **quanta**: `src/mcp/client.ts:39`·`src/mcp/isolated-client.ts:41`·`src/mcp/transports/http-sse.ts:36` → `PROTOCOL_VERSION="2025-06-18"` 하드코딩. `src/mcp/capabilities/default-negotiator.ts`는 capability만 nego, **버전 리스트/다운그레이드 없음**.
- **델타**: 둘 다 `2025-11-25`(최신)인데 quanta는 한 버전 뒤 + nego 없음. `related-task` _meta·URL-elicitation 등 신기능 막힘. **비용 저(문자열+nego 분기)/interop 고.**

### 1.2 [NEW-GAP] SSE resumption 없음 — P10 — 🔲 OPEN (verified jun-07: `Last-Event-ID`/`lastEventId`/`resume` grep 0 in `src/mcp/transports/http-sse.ts`)
- **경쟁사**: Codex `StreamableHttpClientWorkerresume`, resume/inconsistent-state 처리.
- **quanta**: `src/mcp/transports/http-sse.ts` — POST+GET-SSE+DELETE+`Mcp-Session-Id`는 있으나 `Last-Event-ID`/`lastEventId`/resume grep 0. 자체문서 "spec rev 2025-03-26".
- **델타**: SSE 끊긴 사이 서버발 메시지 유실. **비용 저-중/중.**

### 1.3 [PARTIAL] resources 표면 미완 — PARTIAL (have resource_updated parse+route, missing templates/list + completion/complete: verified jun-07 — `src/mcp/resources/notifications.ts:59` `parseResourceNotification`(`resource_updated`/`resource_list_changed`/`prompt_list_changed`/`tools_list_changed`)+`:83` `routeResourceNotification`→observer 존재 [updated-consume 이미 있음, 이전 "소비 없음" 정정]; 단 `resources/templates`·`completion/complete` grep 0 in `src/`)
- **경쟁사**: Codex `resources/templates/list`(×11)·`resources/subscribe`/`unsubscribe`(×7)·`completion/complete`(×7)·`notifications/resources/updated` 소비.
- **quanta**: `src/tool/mcp_resources/`(4도구)+`src/agent/mcp-bridge.ts:470`(supervised aggregate, 검증됨). resource_updated는 이제 `parseResourceNotification`/`routeResourceNotification`(`src/mcp/resources/notifications.ts`)로 parse+observer route됨. 단 `resources/templates/list`·`completion/complete` grep 0.
- **델타**: list/read/prompts/roots + updated-consume는 패리티, templates·completion 누락. **ROI 중.**

### 1.4 [PARTIAL] URL elicitation 없음 — PARTIAL (have string/number/bool/enum/multiSelect, missing url variant: verified jun-07 `src/mcp/elicitation/schemas.ts` — `url` variant grep 0)
- **경쟁사**: Codex `UrlElicitationParam`(×5)·`UrlElicitationCapability` (2025-11-25 OAuth-redirect elicitation).
- **quanta**: `src/mcp/elicitation/schemas.ts` — string/number/bool/enum/multiSelect 등은 완비, `url` variant grep 0.
- **델타**: 서버-구동 OAuth elicitation 못 받음. **ROI 중.**

### 1.5 [PARTIAL] MCP Tasks 빈약 — PARTIAL (have honest `listChanged:false` advertise + taskId/state/title/progress, missing ttl/pollInterval/related-task: verified jun-07 `src/mcp/tasks/` — `pollInterval`/`related-task`/`ttl` grep 0)
- **경쟁사**: Codex `tasks/list`·`tasks/get`·`tasks/cancel`·`CreateTaskResult`·`Tools/Sampling/ElicitationTaskCapability`·`pollInterval`/`ttl`·`io.modelcontextprotocol/related-task` _meta.
- **quanta**: `src/mcp/tasks/types.ts` — `tasks:{listChanged:false}` 정직광고(`full-negotiator.ts:52`), `McpTaskInfo`는 taskId/state/title/progress만. ttl/pollInterval/related-task 없음.
- **델타**: 정직하게 미지원 광고는 맞으나, Codex 대비 task 표면 작음. **ROI 저-중.**

### 1.6 [PARTIAL] connector는 catalog지 marketplace 아님 — PARTIAL (have `BUNDLED_MCP_CONNECTORS` flat catalog `src/connectors/mcp-connector-catalog.ts:118`, missing marketplace lifecycle: verified jun-07 `marketplace`/`DirectoryApp`/`installUrl` grep 0 in `src/connectors/`+`src/`)
- **경쟁사**: Codex `marketplace`(599×)·`/marketplace_{add,remove,upgrade}`·`/installed_marketplaces`·`/connectors/directory`·`struct DirectoryApp`(10필드: logoUrl/distributionChannel/installUrl/categories/privacyPolicy/firstPartyRequiresInstall)·`OAuthConfig`(auth-on-install).
- **quanta**: `src/connectors/`(rest-registry·oauth-discovery RFC8414·token-rotation·`BUNDLED_MCP_CONNECTORS` `mcp-connector-catalog.ts:118`)+`mcp-connector-wire.ts`(N2). 플랫 큐레이트 리스트, add/remove/upgrade·directory metadata·auth-on-install 없음.
- **델타**: 코어 install path는 커버, 마켓플레이스 lifecycle 없음. **ROI 중(배포-deferred).**

> ✅ NOT-GAP: MCP OAuth(`src/host/runtime/mcp-oauth-provider.ts`, `mcp-bridge.ts:382,390` live-wire 확인, jun-06) · MCP sampling(`src/mcp/sampling/`, DoS cap 우위).

---

## 2. Skills / Plugins / Manifests (interop)

### 2.1 [ACTUAL-GAP] 플러그인 manifest가 실제 codex plugin.json 거부 — P2 🛑 — 🔲 OPEN (verified jun-07: `src/skill/plugin-manifest.ts:106` `skills: z.array(z.string()).optional()` + `:109 .strict()` → string `skills` 거부·`repository` 미인식 그대로)
- **경쟁사**: `userdata/codex/skills/.system/plugin-creator/references/plugin-json-spec.md`. 실제 plugin(spreadsheets)은 `skills:"./skills/"`(**string**), top-level `repository`.
- **quanta**: `src/skill/plugin-manifest.ts` `.strict()` 스키마 — `skills: z.array(z.string())`라 string 거부(`Expected array, received string`), `repository` 미인식(`Unrecognized key`). `interface` 블록 14필드는 패리티.
- **델타**: **실제 codex plugin.json을 safeParse하면 거부됨**(경험적 증명). "codex 플러그인 흡수"라면서 못 읽음. (`hooks`/`apps` 필드는 코퍼스 plugin.json에 실재 안함 — 스카우팅 오보고.) **비용 저/interop 고.**

### 2.2 [ACTUAL-GAP] 스킬 frontmatter가 실제 SKILL.md 거부 + 도구 화이트리스트 무음드롭 — P2 🛑 — 🔲 OPEN (verified jun-07: `src/skill/skill-frontmatter.ts:68-69` `userInvocable: z.boolean()` Required + `allowedTools: z.array(...)` (camelCase, list-form) + `:86 .strict()` 그대로 — kebab `allowed-tools`/`user-invocable` 블록리스트 미지원. ADR-0457가 `argument-hint`/`metadata`만 추가했고 kebab 도구키 미추가. `src/skill/discover.ts:155` `declaredAllowedTools(data.allowedTools)` = camelCase만 읽음)
- **경쟁사**: `userdata/codex/skills/.system/*/SKILL.md` — `allowed-tools:` YAML **블록리스트**(`- Read`), kebab `user-invocable`.
- **quanta**: `src/skill/skill-frontmatter.ts` strict — 블록리스트 `allowed-tools` 파싱 실패("empty value"), `userInvocable` Required 실패. `src/skill/discover.ts:155` `declaredAllowedTools(data.allowedTools)` = **camelCase만 읽음** → codex kebab `allowed-tools`/`user-invocable` **무음 드롭**.
- **델타**: 실제 codex SKILL.md 못 로드 + 도구 화이트리스트/user-invocable 손실. **비용 저/interop 고.**

### 2.3 [NEW-GAP] `allow_implicit_invocation` 스킬 정책 플래그 없음 — 🔲 OPEN (verified jun-07: `allow_implicit_invocation`/`implicitInvocation`/`allowImplicit` grep 0 in `src/skill/`)
- **경쟁사**: `userdata/codex/skills/.system/skill-creator/references/openai_yaml.md` → `policy.allow_implicit_invocation: false` (기본 context 미주입, `$skill` 명시호출만).
- **quanta**: `src/skill/skill-frontmatter.ts` — `allowedTools`는 있으나 주입-게이팅 정책 없음(grep 0). 전 스킬 기본주입.
- **델타**: 스킬 수 늘수록 프롬프트 토큰 bloat, opt-out 없음. **비용 저(boolean 1)/ROI 고.** (backlog:293 명시되나 미구현.)

### 2.4 [PARTIAL] plugin manifest `hooks`/`apps`/`repository` 포인터 — 🔲 OPEN (verified jun-07: `src/skill/plugin-manifest.ts:109 .strict()` 그대로 — `repository`/`hooks`/`apps` optional 필드 미추가, 2.1과 동일 루트)
- **경쟁사**: plugin-json-spec.md — top-level `repository`, (claude 쪽 hooks 포인터).
- **quanta**: `src/skill/plugin-manifest.ts` `.strict()`라 optional 필드도 없으면 거부.
- **델타**: 2.1과 연동 — optional 필드 추가 필요. **ROI 중.**

### 2.5 [NEW-GAP] marketplace.json 정책게이팅 — 🔲 OPEN (verified jun-07: `marketplace` grep 0 in `src/`; connector catalog만 존재, install/auth 정책 게이팅 없음)
- **경쟁사**: `userdata/codex/config.toml`(`[marketplaces.openai-bundled]`, `[plugins."browser@openai-bundled"] enabled=true`) + plugin-json-spec.md `policy.installation∈{NOT_AVAILABLE,AVAILABLE,INSTALLED_BY_DEFAULT}`·`authentication∈{ON_INSTALL,ON_USE}`.
- **quanta**: marketplace grep 0. connector catalog는 있으나 install/auth 정책 게이팅 없음.
- **델타**: 플러그인 카탈로그+정책 게이팅 없음. **ROI 중(배포-deferred).**

> ✅ NOT-GAP(superset/parity): plugin `interface` 14필드 · skill `dependencies.tools[]`(ADR-0476) · persona enum(`src/agent/persona.ts`) · memory 2-phase(`src/memory/consolidate/`).

---

## 3. Safety / Permission / Sandbox

### 3.1 [OVERCLAIMED→GAP] Guardian per-action-class assessor 없음 — P3 🔴 — 🔲 OPEN (verified jun-07: `GuardianAssessmentAction`/`AssessmentAction`/`action_class`/`decision_source` grep 0 in `src/agent/`+`src/permission/`; `src/agent/reviewer-port.ts`는 단일 opaque approve/deny reviewer 그대로)
- **경쟁사**: `codex/_codex-rs-0.135-symbols.txt` — `enum GuardianAssessmentAction` **6 variant**(`Execve`(4필드)·`NetworkAccess`(4)·`ApplyPatch`(2)·`Command`(3)·`McpToolCall`(5: tool_name/connector_id/connector_name/tool_title)·`RequestPermissions`(2)) + `GuardianAssessmentEvent`(**11요소**: target_item_id/risk_level/user_authorization/rationale/decision_source) + `guardian_subagent`(전용 model+developer_instructions+timeout) + `GuardianDeniedAction` 오버라이드 상태.
- **quanta**: `src/agent/reviewer-port.ts:43-48`(guardian은 3 reviewer tier 중 1, 기본 `unavailable`) + `src/agent/tier1/reviewer-subagent.ts:13-22,126-157`(자유JSON `{outcome:guardian_approved|denied, rationale, riskLevel?}` = **opaque approve/deny 1개**). `src/apps/cli/repl/reviewer-policy.ts:47-53`(on-request+workspace-write일 때만 선택).
- **델타**: Codex는 **모든 액션을 6 클래스로 자동 구조화 assessment + typed event(risk/authorization/decision_source)** = 직교 차원. quanta는 단일 승인차원의 selectable reviewer 1개, `riskLevel`은 조잡한 `isReadOnly?low:high`. "same gate"는 거짓. **비용 중/보안 고.**

### 3.2 [ACTUAL-GAP] auto-mode 유저룰 오버레이 + tool-switch 우회탐지 — P4 🔴 — 🔲 OPEN (verified jun-07: `soft_deny`/`hard_deny`/`autoMode`/`tool_switch`/`circumvent` grep 0 in `src/`; classifier taxonomy+2-stage+denial-limits 패리티만 그대로)
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` — `autoMode` zod `{allow,soft_deny,hard_deny,deny,environment}` each `array(string).optional()` + 리터럴 `"$defaults"` 위치상속 + 머지코드(`_/q/K/O` 버킷). **우회탐지**: "routing around a deny rule by switching tools" — Bash가 Edit/Write deny 룰 대상 파일을 쓰는 것 잡기(`sed -i`/`python -c`/heredoc/`cat >`).
- **quanta**: `src/permission/classifier.ts` — verbatim taxonomy + 2-stage(`evaluate()` 246-272) + denial-limits(`{maxConsecutive:3,maxTotal:20}` :161)는 패리티. 단 `soft_deny`/`hard_deny`/`$defaults`/`autoMode`/circumvent/tool_switch grep **0**. 프롬프트는 frozen 상수, 유저 오버레이/우회탐지 없음.
- **델타**: 운영자가 환경별 AFK 경계 튜닝 불가 + tool-switch 우회 못잡음. **비용 저-중/보안 고.**

### 3.3 [PARTIAL] Windows Sandbox 컨테이너 모델 스텁 — PARTIAL (have honest boundary-only passthrough, missing native Win32 isolation: verified jun-07 `src/runtime/os-sandbox/windows-native.ts:5-23` `native-binding-unavailable` degrade 그대로, napi addon 미빌드)
- **경쟁사**: Codex 0.135 `WindowsSandboxSetupStart/Completed`·`WindowsSandboxElevatedSetupBegin`·`WindowsSandboxGrantReadRoot`·`windowsSandboxLevel`·`windowsSandboxPrivateDesktop`·`EnableWindowsSandboxForAgentMode`.
- **quanta**: `src/runtime/os-sandbox/windows-native.ts:5-19` — 정직하게 boundary-only("Win32 isolation impossible from pure Node/Bun"), 전 유저 passthrough(`native-binding-unavailable`).
- **델타**: Windows 격리 사실상 부재(헬퍼 exe 미빌드). macOS/Linux는 패리티. **ROI 저(플랫폼 한정).**

> ✅ NOT-GAP: classifier 2-stage core(`classifier.ts`) · deny-reason(C6, `src/permission/deny-reason.ts` typed layer/pillar 우위) · seatbelt/landlock/seccomp(macOS/Linux 패리티).

---

## 4. Multi-agent / Subagent / Background

### 4.1 [OVERCLAIMED-PARTIAL] batch-jobs = CLI 유틸(에이전트 도구 아님) — PARTIAL (have domain model+CSV+schema+retry, missing LLM tool/sqlite/resume/report_agent_job_result/concurrency-cap: verified jun-07 `src/agent/batch-jobs/port.ts` `InMemoryJobStore`만 — sqlite adapter TODO 주석 `:7`, `report_agent_job_result` grep 0; LLM 도구 없이 `src/apps/cli/batch-cmd.ts`만)
- **경쟁사**: `codex/core/src/tools/handlers/agent_jobs/spawn_agents_on_csv.rs` — `SpawnAgentsOnCsvArgs`(8필드: input_csv/instruction`{column}`/id_column/output_csv/output_schema/max_concurrency "**기본16, config cap**"/max_runtime) + worker도구 `report_agent_job_result` + **SQLite** `agent_jobs`/`agent_job_items`(attempt_count/assigned_thread_id, resume용 `started_at=COALESCE`).
- **quanta**: `src/agent/batch-jobs/`(ADR-0463) — 도메인모델·CSV·output_csv·schema검증·retry·abort는 충실. 단 **(a) LLM 도구 없음**(CLI `src/apps/cli/batch-cmd.ts`만), **(b) sqlite 없음**(`InMemoryJobStore`만; `port.ts:84` "restart 못 견딤"), **(c) resume 없음**, **(d) `report_agent_job_result` worker 도구 없음**(child final text 파싱 `batch-cmd.ts:247`), **(e) concurrency cap 없음**(poolSize ≤MAX_SAFE_INTEGER).
- **델타**: "field-for-field mirror"는 데이터모델만. 에이전트가 mid-turn CSV fan-out 불가. **ROI 중-고.**

### 4.2 [OVERCLAIMED-PARTIAL] multi_agents — 3/6 verb만 — PARTIAL (have send_message/followup_task/list_agents (mailbox poll-based), missing peer wait_agent/resume_agent/fork_turns: verified jun-07 `src/tool/subagent-bg/`는 `subagent_fork`/`subagent_await` bg-handle만 (peer-status 대기 아님); `fork_turns`/`resume_agent` grep 0 in subagent surface)
- **경쟁사**: `codex/core/src/tools/handlers/multi_agents_v2/` — `send_message`(prompt push, no turn)·`followup_task`(+turn)·`wait_agent`(peer final-status 대기)·`list_agents`·`resume_agent`(closed agent 재개)·`fork_turns`(none/all/N, 부모 N턴 seed).
- **quanta**: `subagent_send_message`(`src/tool/subagent-mailbox/index.ts:133`, **poll-based**)·`subagent_read_messages`·`followup_task`(`src/subagent/introspect-tools.ts`+`turn-wake.ts`, 패리티)·`list_agents`(패리티). **누락**: agent-to-agent `wait_agent`(가장 가까운 `subagent_await`는 bg-fork 핸들 대기), runtime `resume_agent`(spawn시 `priorAttempt` 요약만 `subagent-runner.ts:65`), `fork_turns`(`subagent_fork`는 background detach지 N턴 seed 아님; grep 0).
- **델타**: 메일박스 양방향은 맞으나 poll-first(push 아님) + wait/resume/fork_turns 부재. **ROI 중.**

### 4.3 [NEW-GAP(embedded)] side-agent는 in-process registry지 process-daemon fleet 아님 — 🔲 OPEN (verified jun-07: `child_process`/`socket`/`attach`/`respawn`/`worktree` grep 0 in `src/side-agent/registry.ts` — in-process `Map` supervise loop 그대로)
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` — `tengu_bg_agent_action`(24×)·`_cc-daemon-detach`·`job_attach`/`job_reply`·`respawnJob`·`fleet_view_open`·`orphan_recovery_failed`·`job_attach_crash_loop`·`agent_namer`·per-job `timeline.jsonl`·`--worktree`. **분리 OS 프로세스 attach/detach/respawn/crash-recovery.**
- **quanta**: `src/side-agent/registry.ts` — **in-process** `Map<string,DaemonState>` supervise loop. `child_process|socket|attach|respawn|worktree` grep **0**. 부모 프로세스와 함께 죽음.
- **델타**: coordination 자체(`src/subagent/coordination/` broker+DAG+barrier)는 Claude보다 우위. 단 **프로세스-레벨 daemon fleet**(attach/respawn/crash-recovery)은 부재. **ROI 중.**

### 4.4 [PARTIAL] Cursor 타입드 agent 템플릿 — PARTIAL (have fork/poll/await + force_background, missing typed agent kind: verified jun-07 `src/subagent/types.ts:29` free-string `agentType` 그대로, `SubagentType` enum 없음)
- **경쟁사**: Cursor `SubagentType{Bash,Browser,Computer,Cursor,Debug,Explore,Media,Shell,Vm,Watch,Custom}` + `SubagentTemplate`(Mutation/Operation/Scope) + `SubagentSlots`(pool) + `ForceBackgroundShell`.
- **quanta**: `src/tool/subagent-bg/`(fork/poll/await 패리티) + `subagent_force_background`(패리티). 단 typed agent kind 없음(free-string `agentType`/`taskKind` `src/subagent/types.ts:29`), `ForceBackgroundShell` 없음(bg 표면이 subagent지 shell 아님).
- **델타**: Browser/Computer/Vm/Watch는 quanta 미보유 표면 의존. **ROI 저-중.**

---

## 5. Tools — Edit / Apply-patch / Generation

### 5.1 [ACTUAL-GAP] Model-based fast-apply 없음 — 🔲 OPEN (verified jun-07: `Morph`/`Relace`/`FastApplyModel`/`fast_apply_model` grep 0 in `src/`; `src/tool/types.ts:556` `FastApplyFallbackSeam`은 V4A patch 재방출 seam (다른 메커니즘))
- **경쟁사**: Cursor `cursor/.../workbench.desktop.main.js` — `FAST_APPLY`/`fast_apply_model_type`/`FastApplyModel`(Morph/Relace)+`speculative` decoding. **전용 fast-apply 모델**이 lazy/elided 편집(`// ... existing ...`)을 받아 전체 파일 rewrite.
- **quanta**: `src/tool/types.ts:542` `FastApplyFallbackSeam` = 모델이 수정된 **V4A patch** 재방출 → deterministic applier 재실행.
- **델타**: 같은 이름, **다른 메커니즘** — 모델-기반 diff-rewriter 없음. **ROI 고/비용 고(fast-apply 모델 통합).** 기존 seam 재사용 가능.

### 5.2 [PARTIAL] image_gen ref-image 단일 — PARTIAL (have single ref-image + size, missing plural referenceImagePaths + aspectRatio: verified jun-07 `src/tool/image-gen/tool.ts:91` `referenceImagePath` 단수 그대로, `referenceImagePaths`/`aspectRatio` grep 0)
- **경쟁사**: Cursor `GenerateImageArgs` — `referenceImagePaths`(**복수**)+`aspectRatio`.
- **quanta**: `src/tool/image-gen/tool.ts:56-100` — `referenceImagePath`(단일)+`size`(WxH). `port.ts:131`은 multipart `image[]` 지원하나 도구 입력은 단일. wired(`agent-arg-builder.ts:810` gated `QUANTA_IMAGE_GEN`).
- **델타**: 다중 ref-image edit 불가. **ROI 저-중.**

### 5.3 [PARTIAL] Canvas는 local(team-shared 아님) + 메모리 오기재 — PARTIAL (have session-local in-memory CRUD, missing team-shared cloud canvas: verified jun-07 `src/artifact/registry.ts:59` "Pure in-memory default" 그대로, `ShareCanvas`/`SharedCanvas` grep 0)
- **경쟁사**: Cursor 실제 RPC = `ShareCanvas`/`GetSharedCanvas`/`ListSharedCanvases`/`DeleteSharedCanvas`+`SharedCanvasVisibility`(**team-shared cloud**). (메모리 `[[jun-05-canvas-artifact-store]]`의 `Canvas{Register,GetUrl,Destroy}`는 코퍼스에 **존재 안함** — 오기재.)
- **quanta**: `src/artifact/registry.ts` — **session-local in-memory** register/get/list/destroy + `quanta-artifact://` URL. wired(`agent-arg-builder.ts:764` gated `QUANTA_ARTIFACT_STORE`).
- **델타**: 로컬 CRUD는 건전하나 Cursor의 협업 shared-canvas와 다른(더 단순한) 것. **ROI 저. + 메모리 provenance 수정 필요.**

### 5.4 [PARTIAL] gh PR code-tour 없음 — 🔲 OPEN (verified jun-07: `code-tour`/`CodeTour` grep 0 in `src/tool/gh/`; view/list/create/comment/blame/review-diff 등 충실하나 code-tour 부재)
- **경쟁사**: Cursor `StreamCodeTourRequest`+`PullRequestReference`+`PR_CODE_TOUR_CACHE`+`CodeTourDoneReason` (PR diff의 ordered 내러티브 walkthrough).
- **quanta**: `src/tool/gh/` — view/list/create/comment/blame/review-diff/auto-merge/labels/resolve-thread/open 충실. code-tour 없음.
- **델타**: PR 가이드 워크스루 부재. **ROI 저-중(comprehension UX).**

> ✅ NOT-GAP: apply-patch V4A 문법(`src/patch/parser.ts`+`types.ts:8-17`, 7 production+Move+EOF+fuzzy 완비, TRUE-PARITY) · WebSearch/WebFetch(`src/tool/web/fetch.ts` SSRF redirect-recheck 우위) · Diagnostics(`src/tool/diagnostics/`+8 LSP도구) · gh labels/resolve-thread(jun-06).

---

## 6. Tools — Browser / Vision / Multimodal

### 6.1 [NEW-GAP] 대용량 이미지 downsample 없음(reject) — P6 — 🔲 OPEN (verified jun-07: `downsample`/`resize`/`scale`/`sharp`/`jimp`/`image_detail` grep 0 in `src/tool/image/` — 5MB 초과 단순 reject 그대로)
- **경쟁사**: `codex-cli/_cli-symbols.txt` `view_image` — `image_detail` 힌트("`high` for default resized / `original` when preserved") + `supports_image_detail_original`. 큰 이미지 resize.
- **quanta**: `src/tool/image/read.ts:139-142`(+read_image_url) — 5MB 초과 시 **단순 reject**. `downsample|resize|scale|sharp|jimp` grep 0.
- **델타**: 6MB 스크린샷이 quanta에선 사용불가(거부), Codex는 auto-resize. **포터블/ROI 중-고.**

### 6.2 [NEW-GAP] browser_tabs (멀티탭) 없음 — 🔲 OPEN (verified jun-07: `browser_tabs`/`new.*tab` grep 0 in `src/tool/browser/`+`src/browser/` — single-page 그대로)
- **경쟁사**: Cursor `workbench.desktop.main.js` `browser_tabs` action enum = list/new/close/select.
- **quanta**: `src/browser/port.ts` — single-page. `browser_tabs|new.tab` grep 0.
- **델타**: OAuth 팝업/target=_blank/두 페이지 비교 불가. **포터블/ROI 중.**

### 6.3 [NEW-GAP] browser_get_bounding_box 없음 — 🔲 OPEN (verified jun-07: `bounding_box`/`boundingBox` grep 0 in `src/tool/browser/`+`src/browser/`)
- **경쟁사**: Cursor — ref/selector로 element bounding box 반환.
- **quanta**: `src/tool/browser/index.ts` — `browser_mouse_click_xy`(좌표클릭)는 있으나 box 조회 없음.
- **델타**: snapshot ref가 못잡는 canvas/shadow-DOM 타겟 좌표 계산 불가. **포터블/ROI 중.**

### 6.4 [NEW-GAP] browser_highlight 없음 — 🔲 OPEN (verified jun-07: `browser_highlight` grep 0 in `src/tool/browser/`+`src/browser/`)
- **경쟁사**: Cursor — ref로 element 시각 하이라이트(screenshot 전 annotation).
- **quanta**: 부재.
- **델타**: screenshot-grounding 개선용. **포터블/ROI 저-중.**

### 6.5 [PARTIAL] listVoices 동적 발견 없음 — 🔲 OPEN (verified jun-07: `listVoices`/`RealtimeVoicesList` grep 0 in `src/realtime/` — `voice?:string` 받으나 카탈로그 쿼리 없음)
- **경쟁사**: Codex `RealtimeVoicesList`/`realtime_conversation_list_voices_response`.
- **quanta**: `src/realtime/voice-session/port.ts:62` — `voice?:string` 받으나 `listVoices()` 없음.
- **델타**: 하드코딩 voice명 vs 쿼리 카탈로그. **gated/ROI 저.**

### 6.6 [GATED] 네이티브 OS computer-use (RFC-deferred)
- **경쟁사**: Codex `computer-use`+`allow_locked_computer_use`/`ComputerUseRequirementsToml`; Cursor `computerUse`/`computerUseToolCall`; Claude Desktop computer_use.
- **quanta**: OS screen-capture/AX-tree/mouse-keyboard 부재(`screen_capture|ScreenCaptureKit|ax.tree|CGEvent` grep 0). **이미 RFC `docs/plans/jun-6-computer-use-native.md`에 DEFER 판정**. browser-scoped(`browser_screenshot`+`browser_click`)가 대부분 커버.
- **델타**: Tauri/desktop-only, 최고 보안표면. **올바르게 deferred.**

> ✅ NOT-GAP: realtime voice slice(`src/realtime/`+`/voice`+`/voice-live`) · STT(Whisper+Deepgram `src/media/stt/`,`src/voice/transcriber/`) · image-gen+edit(`src/tool/image-gen/`) · pdf_read(`src/tool/document/pdf-read.ts`)+office triad. ⚠️ `browser_script`(arbitrary JS) = quanta 의도적 미보유(read-only CDP allowlist `src/browser/cdp-allowlist.ts`, 보안 non-gap).

---

## 7. Git / VCS

### 7.1 [NEW-GAP] Worktree isolation mode + Enter/ExitWorktree 도구 — P8 — 🔲 OPEN (verified jun-07: `git_worktree`/`enter_worktree`/`EnterWorktree` grep 0 in `src/tool/`; `src/runtime/worktree.ts` `withWorktree()` host-orchestrated만, 에이전트 도구/edit-fencing 없음)
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` — `EnterWorktree`/`ExitWorktree`는 **에이전트 도구**(`hq7={..."EnterWorktree"...}`, `m76="ExitWorktree"`), isolation mode("'worktree'(default) blocks Edit/Write in main checkout until EnterWorktree") + `createAgentWorktree`/`getAgentWorktreeChanges`/`copyWorktreeIncludeFiles`/`cleanupStaleAgentWorktrees`/sparse-checkout(`worktreeBaseRef`).
- **quanta**: `src/runtime/worktree.ts:133` `withWorktree()` — host-orchestrated(session fork/bg-job)만, **에이전트 도구 아님**(`git_worktree`/`enter_worktree` grep 0), main-checkout edit-fencing mode 없음, sparse-checkout/include-file 없음.
- **델타**: 모델이 mid-session worktree 격리 opt-in 불가 + main 쓰기 펜싱 없음. 기판(`withWorktree`)은 있음. **비용 중/동시편집 안전 고.**

### 7.2 [NEW-GAP] co-change / git-graph related-files 없음 — 🔲 OPEN (verified jun-07: `co-change`/`related-files`/`git-graph` grep 0 in `src/tool/git/`; `git_churn` 단일파일 빈도만)
- **경쟁사**: Cursor `workbench.desktop.main.js` — `GetGitGraphRelatedFiles`/`getGitGraphRelatedFiles`/`_updateRelatedFileSuggestions`/`chatInputRelatedFilesContrib` (git 히스토리상 함께 변경되는 파일 → context 제안).
- **quanta**: `src/tool/git/churn.ts:38` `git_churn` — **단일파일** 변경빈도(`rankChurn`→`{file,count}[]`). co-occurrence pair 없음(`co.?change|related.?files|git.?graph` grep 0). backlog(`jun-02-union-audit`)에 "co-change feed" 명시됨.
- **델타**: churn(많이 바뀌는 파일)은 있으나 co-occurrence("이거랑 같이 바뀌는 파일")는 없음 — retrieval 가치는 후자. **비용 저(read-only `git log --name-only`)/ROI 중.**

### 7.3 [PARTIAL] 구조화 CI-investigation finding 도구 — 🔲 OPEN (verified jun-07: `RecordCiInvestigation`/`CiFinding` grep 0 in `src/`; CI는 prose 스킬 `loop-on-ci/SKILL.md`만)
- **경쟁사**: Cursor `RecordCiInvestigationFinding`/`RecordCiInvestigationFindingsToolCall`/`CI_INVESTIGATION_FINDINGS`/`RecordCiInvestigationOverall` (CI 실패 조사 중 finding을 구조화 기록하는 도구).
- **quanta**: CI 처리는 prose 스킬 `loop-on-ci/SKILL.md`, 구조화 finding-record 도구 없음.
- **델타**: 자유텍스트 vs 타입드 finding loop. **ROI 저-중.**

### 7.4 [PARTIAL] 3-way dirty checkout (stash/discard 선택) — PARTIAL (have commit-wip path, missing stash-or-discard 3-way: verified jun-07 `needsGitStash`/`input_stash`/`git_stash_drop` grep 0 in `src/tool/git/branch-switch.ts`; `commitWipForBranchSwitch`만)
- **경쟁사**: Claude `needsGitStash`/`input_stash`/`git_stash_drop` (branch-switch 전 stash/commit/discard 선택).
- **quanta**: `src/tool/git/branch-switch.ts` — `commitWipForBranchSwitch`(commit-wip path)는 흡수, stash-or-discard 3-way 선택 없음.
- **델타**: commit-wip가 주 케이스 커버, stash/discard 분기 없음. **ROI 저.**

> ✅ NOT-GAP(parity/superset): 14 git도구+12 gh도구 · shadow-ODB+file-history rewind+restore-partial(ADR-0121-0125) · 결정적 git env(`src/storage/git-runner/runner.ts:49` DETERMINISTIC_ENV, 우위) · compose-commit/pr AI authoring · git_moved_code(ADR-0109) · git_conflict_inspect · git_upstream_check · force-with-lease push.

---

## 8. Session / Envelope / Checkpoint

### 8.1 [OVERCLAIMED-PARTIAL] turn_context 7+ 필드 누락 — PARTIAL (missing developer_instructions/dynamic_tools/service_tier/model_provider/approvals_reviewer/base_instructions: verified jun-07 — 6필드 전부 grep 0 in `src/session/envelope.ts`)
- **경쟁사**: Codex `turn_context` — cwd·approval_policy·**approvals_reviewer**·sandbox_policy·active_permission_profile·model·**model_provider**·**service_tier**·effort·summary·collaboration_mode·personality·truncation_policy·**developer_instructions**·**dynamic_tools**·**base_instructions**·user_instructions.
- **quanta**: `src/session/envelope.ts:198-232` — turn_id·cwd·current_date·timezone·approval_policy·sandbox_policy·permission_profile·model·personality·collaboration_mode·realtime_active·effort·summary·user_instructions·truncation_policy·parent_thread_id·thread_role. **누락**: developer_instructions·dynamic_tools·service_tier·model_provider·approvals_reviewer·base_instructions.
- **델타**: "exact match-or-superset" 거짓 — 6필드 누락. **ROI 중(developer_instructions·dynamic_tools가 핵심).**

### 8.2 [OVERCLAIMED-PARTIAL] session_meta 필드 누락 — PARTIAL (have forkedFromId+git fingerprint, missing agent_nickname/dynamic_tools/originator/thread_source/model_provider/cli_version: verified jun-07 `src/session/types.ts:39` `forkedFromId`만, 나머지 6 grep 0)
- **경쟁사**: Codex `session_meta`/`SessionConfigured` — `forked_from_id`·`thread_name`·`agent_nickname`·`dynamic_tools`·`originator`·`thread_source`·`model_provider`·`base_instructions`·`cli_version`.
- **quanta**: `src/session/types.ts`(10필드 SessionMeta) — `forkedFromId`✓(jun-06)+git fingerprint(3). 누락: agent_nickname·dynamic_tools·originator·thread_source·model_provider·cli_version. `thread_name≈title`.
- **델타**: forked_from_id는 추가됐으나 6+ 필드 더 누락. **ROI 저-중(replay 결정성).**

### 8.3 [PARTIAL] dynamic_tools 세션 기록 없음 — 🔲 OPEN (verified jun-07: `dynamic_tools`/`dynamicTools`/`thread_dynamic_tools` grep 0 in `src/session/`)
- **경쟁사**: Codex `session_meta.dynamic_tools:[{namespace,name,description,input_schema,defer_loading}]` + `thread_dynamic_tools` 테이블.
- **quanta**: `src/session/envelope.ts` — base 외 세션별 도구셋 미기록(grep 0).
- **델타**: MCP/skill 도구 가변 세션의 결정적 replay 불가. **ROI 저(+5.1 deferred tools와 연관).**

> ✅ NOT-GAP: forked_from_id(jun-06) · shadow-ODB checkpoint/rewind/restore-partial(`src/storage/shadow-odb/`+`src/tool/shadow/`+`src/tool/file-history/`, ADR-0121-0125/0146) · git fingerprint(ADR-0106) · persona(ADR-0068).

---

## 9. LLM 레이어 — Model / Caching / Reasoning / Usage

### 9.1 [NEW-GAP] Model `[1m]` 1M-context 와이어링(orphan literal) — P9 — 🔲 OPEN (verified jun-07: `context-1m`/`[1m]` suffix-strip/`anthropic-beta` header grep 0 in `src/llm/`; `advisor.ts:53` `claude-opus-4-8[1m]` 리터럴 여전히 orphan. [NOTE: `src/llm/provider-metadata.ts` MODEL_CONTEXT_WINDOWS에 `claude-sonnet-4-*-1m`(1M) 엔트리가 §15.1용으로 신설됐으나, 이는 window 메타지 `[1m]` suffix 감지/beta-header 활성화가 아님 — 이 갭의 코어는 여전히 OPEN])
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` — 모델 `sonnet[1m]`/`opus[1m]`, `[1m]` suffix → `context-1m-2025` beta 활성+window 1,000,000.
- **quanta**: `src/runner/knobs/knobs/advisor.ts:53`에 `claude-opus-4-8[1m]` **리터럴만 존재**, suffix 감지/strip/`context-1m` `anthropic-beta` 헤더 세팅 코드 **부재**(`context-1m|\[1m\]` grep 0). 이 id 넘기면 `...-4-8[1m]` 그대로 보내 400.
- **델타**: advisor가 이미 광고하는 1M-context를 실제론 못씀(half-wired). **비용 저/ROI 중-고.**

### 9.2 [NEW-GAP] Anthropic `service_tier` 미전송 — 🔲 OPEN (verified jun-07: `service_tier`/`serviceTier` grep 0 in `src/llm/anthropic-messages-codec.ts`; OpenAI Responses(`openai-responses-wire.ts:153`+`factory.ts`)에만 세팅. `QUANTA_SERVICE_TIER` 놉은 존재하나 Anthropic codec 미연결)
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` — `service_tier`(×9, priority/batch).
- **quanta**: OpenAI-Responses에만 세팅(`src/llm/openai-responses-wire.ts:153`,`factory.ts:131`). `toAnthropicCreateParams`(`src/llm/anthropic-messages-codec.ts:184-205`)엔 `service_tier` 없음(grep 0). `QUANTA_SERVICE_TIER` 놉은 이미 존재.
- **델타**: Anthropic priority-tier(저지연) 못씀. **비용 저(~3줄)/ROI 중.**

### 9.3 [NEW-GAP] account dual-window rate-limit snapshot — 🔲 OPEN (verified jun-07: `used_percent`/`window_minutes`/`RateLimitWindow` grep 0 in `src/llm/ratelimit-snapshot/`; per-request HTTP 헤더만)
- **경쟁사**: Codex `RateLimitSnapshot`(primary/secondary `RateLimitWindow`·`used_percent`·`window_minutes`·`Credit`/`UsageLimitReached`) — ChatGPT-구독 모델("5h window 82%, weekly 40%").
- **quanta**: `src/llm/ratelimit-snapshot/parse.ts` — per-request HTTP 헤더만(`anthropic-ratelimit-*`/`x-ratelimit-*`). account-level dual-window/percent/credits 없음(`used_percent|window_minutes` grep 0).
- **델타**: quanta가 chatgpt-oauth 출시했으니 "5h 윈도우 80%" 넛지 직접 관련. **ROI 중.**

### 9.4 [PARTIAL] reasoning summary 요청 안함 — PARTIAL (have read-path summary delta `openai-responses-wire.ts:531`, missing write `summary:"auto"`: verified jun-07 — 요청 body는 `reasoning:{effort}`만, `summary:"auto"` 미전송)
- **경쟁사**: Codex `default_reasoning_summary`(auto/none/concise)·`reasoning_summary_format`.
- **quanta**: summary 델타는 READ(`src/llm/openai-responses-wire.ts:531`), 요청 body는 `reasoning:{effort}`만(:343) — `summary:"auto"` 미전송.
- **델타**: read-path 완비, write-path 부재(계정 기본값 의존). **ROI 중(1 optional 필드).**

### 9.5 [NEW-GAP] `verbosity` + effort `xhigh` — 🔲 OPEN (verified jun-07: `verbosity`/`xhigh` grep 0 in `src/llm/`)
- **경쟁사**: Codex `support_verbosity`/`default_verbosity`(GPT-5 `text.verbosity` low/med/high) + effort `xhigh`(`lowmediumxhigh`).
- **quanta**: verbosity grep 0(`src/llm/`); effort는 `minimal|low|medium|high`(`openai-responses-wire.ts:287`), `xhigh` 없음.
- **델타**: 출력길이 제어 + 최고 effort tier 부재. **ROI 저(리터럴 추가).**

### 9.6 [PARTIAL] `opusplan` 프리셋 + Message Batches API — 🔲 OPEN (verified jun-07: `opusplan`/`messages/batches` grep 0 in `src/`; sticky-model-per-mode 기판만)
- **경쟁사**: Claude `opusplan`(plan=opus/exec=sonnet 자동) + `messages/batches`(×18, Anthropic Batch API 50% cost).
- **quanta**: sticky-model-per-mode 기판(`src/agent/loop/skill-gate.ts:43`)은 있으나 `opusplan` 프리셋 없음. Batch API 없음(`messages/batches` grep 0; batch-jobs는 로컬 fan-out).
- **델타**: 프리셋은 config-only. Batch API는 비대화 bulk 한정 50% 절감. **ROI 저-중.**

> ✅ NOT-GAP: 1h/5m cache TTL(`src/llm/anthropic-messages-codec.ts:26` ttlControl) · reasoning carryover(H15 encrypted_content) · multicloud provider(`src/llm/providers/registry.ts:47`) · fallback chains(`QUANTA_MODEL_FALLBACK`) · branch-search(ADR-0084 speculative N-best) · WS decoder(chatgpt-oauth). ⚠️ realtime/responses WebSocket transport = provider-account-specific, BYO-provider엔 N/A.

---

## 10. Rules / Context / Mentions / Retrieval / Compaction

### 10.1 [ACTUAL-GAP] Agent-Requested 룰 — description-only 룰 무음 드롭 — 🔲 OPEN (verified jun-07: `fetch_rules`/`agent.requested`/`agentRequested` grep 0 in `src/agent/glob-rules.ts`; globs/alwaysApply 없는 룰 DROP 그대로)
- **경쟁사**: Cursor 4 룰타입 — Always/Auto-Attached(glob)/Manual(@)/**Agent-Requested**(description-only, 모델이 카탈로그서 본문 fetch). `cursor-agent-exec/dist/main.js` `fetch_rules_params`/`FetchRules` capability + `rules.map(e=>\`- ${e.name}: ${e.description}\`)` 카탈로그.
- **quanta**: `src/agent/glob-rules.ts:116` — globs도 alwaysApply도 없는 룰 **DROP**("can never auto-inject — drop it"). `description`은 파싱하나 hint로만 렌더(:205), selection key 아님(`selectGlobRules` :181은 changedPaths×globs만). `fetch_rules`/`agent.requested` grep 0.
- **델타**: 마이그레이션 유저의 description-only `.mdc` 룰 손실 = **실 correctness 갭**. **비용 저-중/ROI 중-고.**

### 10.2 [PARTIAL] rules 프리미티브 — string-prefix vs argv-array — PARTIAL (have string-prefix + deny/ask + layering (우위), missing codex argv-token `prefix_rule(pattern=[...])` 파싱: verified jun-07 `src/rules/parser.ts:83` startsWith 그대로)
- **경쟁사**: Codex `rules/default.rules` — `prefix_rule(pattern=["uv","run","pytest"], decision="allow")` **argv-token-array**.
- **quanta**: `src/rules/{types,parser,matcher}.ts` — **string-prefix**(`command.startsWith(prefix)`, space-bounded) + 자체 DSL. codex `prefix_rule(pattern=[...])` 문법 거부(`RuleParseError`).
- **델타**: deny/ask + system/user/project 레이어링은 quanta가 우위지만, codex `default.rules` 못 읽음. **ROI 저-중.**

### 10.3 [PARTIAL] mentions folder/git kind 없음 — PARTIAL (have skill/plugin/app/file/symbol (symbol은 우위), missing folder/git: verified jun-07 `src/agent/mention-injection/types.ts:50` `MentionKind=skill|plugin|app|file|symbol` 그대로)
- **경쟁사**: Cursor `FileMention`/`FolderMention`.
- **quanta**: `src/agent/mention-injection/types.ts:50` `MentionKind=skill|plugin|app|file|symbol`(symbol은 LSP+semantic, Cursor 대비 우위). folder/git kind 없음.
- **델타**: 폴더/git mention 부재. **ROI 저.**

### 10.4 [PARTIAL] file-tree 1개 vs Codex 3-tree — PARTIAL (have cwd 1-tree `probeRepoMap`, missing Git/User root trees: verified jun-07 `src/agent/env-context.ts:292` cwd 단일트리만, `Git root tree`/`gitRootTree` grep 0)
- **경쟁사**: Codex — "Working directory tree"+"Git root tree"+"User root tree" 3개 주입.
- **quanta**: `src/agent/env-context.ts:244` `probeRepoMap` — cwd 1트리(turn-1, depth2/200파일/6000자) + `src/tool/file-tree-summary/`.
- **델타**: Codex 3트리 vs quanta 1트리(cwd). **ROI 저.**

### 10.5 [PARTIAL] compaction server-side 없음(N/A by 아키텍처)
- **경쟁사**: Codex `compact_remote_v2`(서버측 history 압축).
- **quanta**: `src/agent/compaction/background.ts`(ADR-0473 2-phase success-gated)+`microcompact`(ADR-0409)+reactive — client-side. server-side 없음.
- **델타**: BYO-provider라 서버 압축 엔드포인트 없음 = **N/A by 아키텍처**(결함 아님).

### 10.6 [PARTIAL] memory record 구조화 라우팅필드 손실 — PARTIAL (have 2-phase distill (TRUE-PARITY), missing structured routing meta: verified jun-07 `task_group`/`applies_to`/`reuse_rule` grep 0 in `src/memory/`; `MemoryEntry` generic 그대로)
- **경쟁사**: Codex MEMORY.md — `task_group`/`scope`/`applies_to`/`reuse_rule`/`keywords` 구조화 라우팅 필드.
- **quanta**: `src/memory/consolidate/` 2-phase 메커니즘+`stage1_outputs` 테이블은 충실(TRUE-PARITY). 단 승격된 `MemoryEntry`는 generic(`id/kind/tier/text/tags`) — 라우팅필드 free text로 collapse.
- **델타**: distill 메커니즘은 패리티, 구조화 라우팅 메타 손실. **ROI 저.**

> ✅ NOT-GAP: retrieval(BM25 `bm25-impl.ts:11`+RRF `parallel-rrf.ts:4`+tree-sitter+8 embedder, prod src tsc-clean — "in-flight tsc errors"는 stale, 232 에러 전부 test fixture) · prompt §5 번들 완비 · token-delta+ratelimit live · paste-burst(`raw-line-reader.ts:117`) · 2-phase compaction.

---

## 11. CLI / Slash / TUI / Steering

### 11.1 [NEW-GAP] `/init` 코드베이스 온보딩 doc 생성 — 🔲 OPEN (verified jun-07: `/init`/`userFacingName.*init` grep 0 in `src/apps/cli/`)
- **경쟁사**: `claude-code-cli/_cli-symbols.txt` `userFacingName=="init"`; `codex-cli/_cli-symbols.txt` `/init`(×6).
- **quanta**: `"/init"` grep 0(`src/apps/cli/`). AGENTS.md 읽기는 하나 생성 못함.
- **델타**: repo 스캔→AGENTS.md/CLAUDE.md 스캐폴드 없음. **ROI 중(1-shot 프롬프트 템플릿).**

### 11.2 [NEW-GAP] `/agents` 라이브 fleet 뷰 — 🔲 OPEN (verified jun-07: `/agents` live roster grep 0 in `src/apps/cli/`; `repl.ts`의 "fleet"은 주석만)
- **경쟁사**: Claude `userFacingName=="agents"`+`tengu_bg_agent_action`(24×)+FLEET.
- **quanta**: REPL 커맨드로 부재(spawn은 되나 라이브 background agent list/inspect/stop 없음). `repl.ts:288`의 "fleet"은 주석.
- **델타**: spawn은 되나 라이브 로스터/stop UI 없음. **ROI 중(background-agent 사용 늘수록).**

### 11.3 [NEW-GAP] Vim 편집 모드 — 🔲 OPEN (verified jun-07: `vimMode`/`editorMode`/`VimMode` grep 0 in `src/`; emacs-style 리매핑만)
- **경쟁사**: Claude `VimMode`/`EditorMode`/`editorMode","normal"`.
- **quanta**: `raw-line-reader.ts` — heredoc 멀티라인+리매핑 키바인딩(`keybindings/defaults.ts`)은 있으나 modal vim 없음(`vimMode|editorMode` grep 0).
- **델타**: emacs-style은 있으나 modal vim 없음. **ROI 저-중(파워유저).**

### 11.4 [NEW-GAP] 실행중 작업 백그라운드 이동(Ctrl+B) — 🔲 OPEN (verified jun-07: `ctrl.b`/`moveToBackground`/`backgroundTask` REPL 제스처 grep 0 in `src/apps/cli/`; tool-layer `run_in_background`만)
- **경쟁사**: Claude `Ctrl+B`/`BackgroundTask`/`Bashes`(실행중 명령 detach).
- **quanta**: 부재(`ctrl\+b|move.*background` grep 0). tool-layer `run_in_background`는 있으나 REPL 제스처 없음.
- **델타**: in-flight task 백그라운드 제스처 없음. **ROI 중(긴 셸).**

### 11.5 [NEW-GAP] 같은-턴 interrupt-and-steer — PARTIAL (have mid-turn capture + next-turn drain + Esc-Esc cancel, missing interrupt-and-inject-into-current-turn + restore: verified jun-07 `INTERRUPTED_TURN`/`injectInbound`/`restoreInterrupted` grep 0 in `src/`)
- **경쟁사**: Claude `INTERRUPTED_TURN` restore + "Injecting inbound user message" (ESC가 in-flight 턴 인터럽트 + 새 메시지 현재턴 주입 + 인터럽트턴 복원).
- **quanta**: `in-turn-reader.ts`+`mid-turn-capture-wire.ts`는 mid-turn 키 캡처하나 **다음 턴 경계서 drain**(`externalPromptQueue`), Esc-Esc(`turn-cancel-install.ts`)는 CANCEL만.
- **델타**: queue-for-next-turn은 있으나 interrupt-and-inject-into-current-turn + 복원 없음. **ROI 중(steering 유일 nuance).**

### 11.6 [PARTIAL] `/model` 인터랙티브 피커 + `/diff` working-tree — PARTIAL (have /retry-with+/sticky-model SET-by-id + edit-diff /diff, missing list-and-pick picker + ad-hoc git working-tree diff: verified jun-07 `modelPicker`/`gitWorkingTreeDiff` grep 0 in `src/apps/cli/`)
- **경쟁사**: Claude/Codex `/model`(×26, 최다 참조), Codex `/diff`(×6, git working-tree).
- **quanta**: `/retry-with [model]`+`/sticky-model`(SET-by-id, `slash-contract.ts:74`)은 있으나 list-and-pick 피커 없음. `/diff`는 edit-diff(`diff-preview.ts`)/snapshot만, ad-hoc `git diff` 없음.
- **델타**: SET은 되나 discover-and-pick 없음; git working-tree diff on-demand 없음(렌더러는 있음). **ROI 저-중.**

### 11.7 [PARTIAL] 스크립터블 statusLine + 접근성 테마 — PARTIAL (have fixed status-bar + /color auto/light/dark/claude/none, missing user-command statusLine + daltonized/ansi 팔레트: verified jun-07 `statusLine`/`daltonized`/`dark-ansi` grep 0 in `src/apps/cli/`)
- **경쟁사**: Claude `statusLine:{type:"command",command}` (유저 셸 명령으로 바텀바 렌더) + 테마 `dark/light/dark-ansi/light-ansi/dark-daltonized/light-daltonized`(6, 색맹-safe).
- **quanta**: `status-bar.ts`(고정 내부 렌더, 유저 명령 훅 없음) + `/color`(`registry-surface.ts:163` auto/light/dark/claude/none, daltonized/ansi 없음).
- **델타**: 바텀바 유저커스텀 없음 + 색맹-safe 팔레트 없음. **ROI 저(접근성).**

> ✅ NOT-GAP: Esc-Esc soft-cancel+Ctrl+C hard-abort(`turn-cancel-install.ts`) · `/queue` 팔로업(retry/edit/delete/send-now) · 리매핑 키바인딩 · 바텀 status bar(DECSTBM) · live token counter · OSC bell+idle notify+away-summary · @-mention dropdown(file/symbol/skill/plugin/app, Cursor보다 넓음) · markdown painter · `/resume`/`/rewind`/`/fork`/`/session`/`/snapshot`/`/history` · ~55 slash commands.

---

## 12. Config / Settings / Trust / Network / Telemetry / Identity

### 12.1 [NEW-GAP] 중앙 config 파일 부재 + per-project trust gate — P7 🛑 — 🔲 OPEN (verified jun-07: `projectTrust`/`trustDialog`/`workspaceTrust`/`trust_level` grep 0 in `src/`; `src/agent/command-hooks/settings-loader.ts:4` "quanta has no central Claude-style settings.json loader today" 주석 그대로 — 전부 `QUANTA_*` env)
- **경쟁사**: Codex `userdata/codex/config.toml:14-30` `[projects."<path>"] trust_level=trusted/untrusted`; Claude `hasTrustDialogAccepted`(×12). **디렉토리 진입 시 전체 approval/sandbox 정책 게이팅하는 persisted per-project trust posture** + first-run trust 다이얼로그. + managed→user→project→local 레이어드 settings.json/config.toml 로더.
- **quanta**: **중앙 on-disk config 없음** — 전부 `QUANTA_*` env(`src/shared/runtime-config.ts`, frozen). quanta 자체 주석 `src/agent/command-hooks/settings-loader.ts:4` "quanta has no central Claude-style settings.json loader today". trust는 per-ACTION(`trust-scope-store.ts` cascade)만, startup per-project gate 없음(`projectTrust|trustDialog|workspaceTrust` grep 0).
- **델타**: env-only라 persisted per-project trust/MCP-gating posture 표현 불가 = Codex/Claude 프로젝트-안전 모델의 척추. trust 기판(trust-scope-store+named-profiles)은 있음. **비용 중(파일스키마+startup gate)/ROI 중-고.**

### 12.2 [NEW-GAP] HTTPS body scan + header-rewrite (NetworkMitmHook) — ✅ LANDED jun-07 (body scan) / header-rewrite OPEN — 🚩 STATUS FLIP (이전 "명시적 DEFER" → TODAY 구현)
- **상태 (verified jun-07)**: HTTPS body scan = **✅ LANDED** — `src/runtime/network-proxy/mitm.ts`(MitmConfig+fail-closed `MitmFailMode`)+`mitm-cert.ts`(ephemeral CA leaf mint)+`mitm-channel-node.ts`(node:tls server-side termination)+`mitm-channel-bun.ts`(Bun TLS channel)+`loopback-proxy.ts:478` `this.config.mitm !== undefined ⇒ mitmTerminate`. 복호화된 HTTPS 요청을 **기존 secret-egress 스캔에 재사용**(`MitmConfig.secretEgress`) 후 own upstream TLS 재-origination(real cert 정상 검증). operator-opt-in(`mitm-gate.ts`); absent ⇒ raw tunnel + `connect-tunnel-unscanned` byte-identical. header-rewrite = **🔲 OPEN**(`rewriteHeader`/`stripHeader`/`injectHeader` grep 0 — body inspection만).
- **경쟁사**: Codex `NetworkMitmHook`(7×)+`mitm`(51×) — TLS MITM 프록시 hook, header-rewrite + HTTPS body inspection.
- **quanta**: ~~`types.ts:70-83` 명시적 DEFER~~ → jun-07 TLS-MITM 구현(Node+Bun 채널). HTTPS body는 이제 복호화-스캔(opt-in); header-rewrite만 미구현.
- **델타**: secret-egress의 TLS body는 이제 봄. **잔여 ROI 저(header-rewrite만).**

### 12.3 [PARTIAL] additionalDirectories (멀티루트 FS jail) — PARTIAL (have sandbox-level extraReadPaths/extraWritePaths, missing tool-level multi-root jail: verified jun-07 `src/runtime/os-sandbox/types.ts:33-35` `extraReadPaths`/`extraWritePaths`만, 도구 FS jail은 single-cwd `jailRoot:ctx.cwd` 그대로)
- **경쟁사**: Claude `additionalDirectories`(×27) — cwd 외 read/write 루트, 도구/FS-jail 레이어 적용.
- **quanta**: sandbox는 `extraReadPaths`/`extraWritePaths`(`os-sandbox/types.ts:33-35`) 있으나 **FS jail은 single-cwd**(`apply-patch-structured-tool.ts:119` `jailRoot:ctx.cwd`). persisted 멀티루트 jail config 없음.
- **델타**: OS-sandbox는 루트 넓힐 수 있으나 도구-레벨 read/write jail은 못함. **ROI 중(monorepo sibling).**

### 12.4 [PARTIAL] per-project MCP enable/disable — 🔲 OPEN (verified jun-07: `enabledMcp`/`disabledMcp`/`enableAllProjectMcp` grep 0 in `src/`; `.mcp.json` discovery만)
- **경쟁사**: Codex `[plugins."x@y"] enabled=true`(`config.toml:48-60`); Claude `enabledMcpjsonServers`/`disabledMcpjsonServers`/`enableAllProjectMcpServers`(×16-22).
- **quanta**: `.mcp.json` discovery는 있으나 per-project allow/deny/enable config 레이어 없음(`enabledMcp|disabledMcp` grep 0).
- **델타**: 프로젝트 MCP 서버 auto-connect 게이팅 없음(보안: Claude `enabledMcpjsonServers`가 닫는 위협). **ROI 중.**

### 12.5 [PARTIAL] verbosity + plan-mode-effort config — PARTIAL (have 5-tier effort thinking-budget, missing output-verbosity + plan-mode-effort: verified jun-07 `plan_mode_reasoning`/`model_verbosity`/`modelVerbosity` grep 0 in `src/`)
- **경쟁사**: Codex `model_verbosity`(×9)+`plan_mode_reasoning_effort`(`config.toml:4`, plan 전용 effort).
- **quanta**: `src/agent/effort.ts`(5-tier)는 thinking-budget 와이어, output verbosity 놉 없음, plan-mode 전용 effort 없음.
- **델타**: reasoning-effort 패리티, output-verbosity+per-mode-effort 누락. **ROI 저(9.5와 연관).**

### 12.6 [PARTIAL] exclude_tmpdir / exclude_slash_tmp 토글 — 🔲 OPEN (verified jun-07: `exclude_tmpdir`/`exclude_slash_tmp` grep 0 in `src/`; quanta가 이미 더 엄격 — missing-config-knob지 missing-protection 아님)
- **경쟁사**: Codex `exclude_tmpdir_env_var`/`exclude_slash_tmp`(×12 each) — workspace-write 시 $TMPDIR//tmp 자동 write-set 포함 토글.
- **quanta**: `os-sandbox/seatbelt.ts:94` /tmp 항상 READ 허용, write-exclusion 토글 없음. quanta가 이미 더 엄격(auto-tmp-write 안함).
- **델타**: missing-config-knob지 missing-protection 아님. **ROI 저.**

### 12.7 [PARTIAL] otelHeadersHelper (동적 OTLP 토큰) — 🔲 OPEN (verified jun-07: `otelHeadersHelper`/`rotatingHeader`/`dynamicOtlp` grep 0 in `src/`; `otlp-helper.ts:77` static headers만)
- **경쟁사**: Claude `otelHeadersHelper`(×22) — 셸 명령으로 단명 OTLP auth 헤더 동적 mint(Honeycomb/Grafana rotating token).
- **quanta**: `observability/metrics/otlp-helper.ts:77` static `headers?` + endpoint, 동적 refresh 없음.
- **델타**: OTLP push+static auth 패리티, rotating-token auth 부재. **ROI 저(엔터프라이즈).**

> ✅ NOT-GAP(parity/superset): sandbox 5-profile(off/read-only/workspace-write/**workspace-write-net**/danger, seatbelt-verbatim+landlock cli+native+bubblewrap+windows-restricted-token+seccomp, `os-sandbox/types.ts:14`) · 권한 profile layering(admin>team>user, profile-layer-merge.ts, provenance-guard) · jwks-identity+attestation+identity-pool(nickname-table=39 마스터) · scheduler cron+heartbeat+rrule · credential rotation(`credential-helper.ts` apiKeyHelper+aws+gcp, Claude보다 우위) · /doctor · OTel spans+OTLP+w3c-propagator+health-snapshot · retention sqlite GC(prior parity).

---

## 13. Resilience / 에러처리 / 복구

### 13.1 [NEW-GAP] aggregate corrupt-store 감지 + 운영자 복구 안내 — 🔲 OPEN (verified jun-07: `corrupt.*unreadable`/`clearSession`/`state_db_recovery`/`quarantine` grep 0 in `src/session/`; per-file silent degrade `store.ts:235,243` 그대로)
- **경쟁사**: Codex `cli/src/state_db_recovery.rs` (전용 모듈) — "…looks corrupt or unreadable. Clearing the sessions directory may help (this will remove saved threads)." 세션 **스토어** 전체 corrupt를 startup서 감지+조치 안내.
- **quanta**: `src/session/store.ts:235,243` — malformed/schema-mismatch는 **파일당** `logger.warn+return undefined`(무음 degrade). `corrupt.*unreadable|clear.*session` grep 0. aggregate signal/quarantine/조치 없음 → 체계적 corrupt 스토어가 "빈 세션리스트"로 보임(전체 history 무음 손실).
- **델타**: corrupt-count tally + 운영자 hint 없음. `reconcileIndexFromMeta` startup 패스 재사용 가능. **비용 저/ROI 중.**

### 13.2 [NEW-GAP] interrupted-turn marker (crash 후 resume) — 🔲 OPEN (verified jun-07: persisted session-side mid-stream interrupt marker 부재 — `interrupt.*marker`/`incomplete.*turn` grep 0 in session. [NOTE: `src/shared/error-classifier.ts:40` `thread_rollback_failed`는 LLM-에러 분류 kind지 세션 partial-turn 마커 아님 — 이 갭과 무관])
- **경쟁사**: Codex `"failed to flush interrupted-turn marker before emitting TurnAborted"` + `"Rolled the thread back, but failed to save the rollback marker. Codex will continue retrying"` — 턴 mid-flight abort/crash시 명시적 마커 persist → resume이 "깔끔완료" vs "중간잘림" 구분해 replay/repair 결정.
- **quanta**: `mid-turn-interruption/default.ts:167` pending input은 `FollowUp`로 persist + tool-pair reconcile(`store.ts:537`)로 transcript valid化. 단 assistant측 "이 턴 mid-stream 인터럽트됨" 마커 없음(`interrupt.*marker|incomplete.*turn` grep 0).
- **델타**: hard crash 후 resume이 "완료 vs 잘림" 구분 못함(pair-reconcile은 valid化지 known-partial 아님). 400-on-resume(최악)은 이미 방지됨 = fidelity/UX 갭. **ROI 중-저.**

### 13.3 [PARTIAL] compaction-time context-overflow degradation — PARTIAL (have fail-fast + breaker (crash 방지), missing drop-oldest salvage: verified jun-07 `removing oldest`/`dropOldest`/`salvage` grep 0 in `src/agent/compaction.ts`)
- **경쟁사**: Codex `"Context window exceeded while compacting; removing oldest history item"` — 압축 요청 자체가 overflow시 oldest item iteratively drop+retry.
- **quanta**: `src/agent/compaction.ts:337,368` — 분할불가 giant turn은 fail-fast + breaker(`compaction-breaker.ts`) trip. drop-oldest salvage 단계 없음.
- **델타**: graceful degrade(crash X)하나 salvage 덜 적극적. breaker가 infinite-loop은 방지. **ROI 저.**

> ✅ NOT-GAP(quanta 우위/패리티): atomic session write(`store.ts:87` tmp+rename) · zod no-throw read(forged file 거부 `:219-250`) · index self-heal(`:316`) · 턴당 recovery budget(`recovery.ts:6-22`) · provider fallback(`fallback.ts`) · responseId-resume(`responses-stream.ts:351`) · dispatch NO-THROW(`dispatch.ts:548`) · compaction-breaker · OAuth refresh-lock+401 purge · credential-helper typed taxonomy. **network/cancellation/auth/corrupt-input 전부 패리티-이상.**

---

## 14. Verification / Self-check / Quality-loops

### 14.1 [NEW-GAP] 자동/강제 critic 패스 (최종 diff 코드품질 리뷰) — 신규 HIGH-ROI — ✅ **LANDED (verified jun-07)** (= P12)
> **STATUS FLIP → LANDED (jun-07)**: 신규 `src/agent/closeout-critic.ts`(closed-port `CloseoutCritic` + fail-open `runCloseoutCritic`). `loop/recovery-executor.ts:2,135,187,200`이 두 completed 봉인지점서 `maybeRunCloseoutCritic` 호출. knob `QUANTA_CLOSEOUT_CRITIC` default-OFF — 포트 absent⇒fail-open, OFF⇒await 전 sync 단락 byte-identical. denied verdict는 advisory(`recovery`/`closeout` 이벤트), 완료 차단 안 함. **auto-invoke 배선 closed.**
- **경쟁사**: Codex 전용 code-quality review task — `core/src/tasks/review.rs`+`core/src/review_prompts.rs`(uncommitted/commit/base-branch diff별 프롬프트), `item/autoApprovalReview/started|completed` 이벤트, 전용 `review_model` config. **생성된 diff에 reviewer 모델을 gate로 강제 실행.**
- **quanta**: `git_review_diff`(`src/tool/git/review-diff.ts`, isolated read-only sub-agent reviewer) + `advisor`(`src/tool/advisor/advisor.ts`)는 **모델-호출 opt-in 도구만**. `turn-closeout.ts`/`loop.ts`/`verify-checkpoint-bridge.ts`에 모델 리뷰 패스 없음 — closeout은 transcript-seal + prompt-nudge(`closeout-guard.ts`)만.
- **델타**: Codex는 reviewer 모델을 closeout서 강제, quanta는 prompt reminder만 + 실제 리뷰는 모델 재량. **모든 부품 존재**(git_review_diff+advisor+closeout trigger+multi-voter) — auto-invoke 배선만 없음. **ROI 고** — `decideVerifyGuard` force 패턴 미러, default-OFF knob, composition seam.
- ⚠️ Codex `approvals_reviewer`(Guardian, **권한**-승인 auto-review)와 혼동 금지 — 그건 quanta `auto-approval-review.ts`가 이미 미러. 이건 **코드-correctness** critic(다른 서브시스템).

### 14.2 [PARTIAL] edit-repair loop default-OFF + diagnostics auto-attach opt-in
- **경쟁사**: Cursor `linterErrors`/`shouldAutoFixLints`/`FIX_LINTS`/`READ_LINTS`(124×) — edit→lint-delta→attach→autofix가 **기본 per-edit 자동**.
- **quanta**: 메커니즘 패리티(`edit-repair-loop/lint-delta.ts` count-aware multiset delta + `lsp-diagnostics-hook.ts`) 단 **default-OFF**(`EDIT_REPAIR_LOOP=1`, `runner.ts:32`) + LSP hook 명시 배선 필요.
- **델타**: capability 있음, default-wired 아님 = posture 차이. **ROI 저(놉 플립).**

### 14.3 [PARTIAL] confidence/uncertainty 신호
- **경쟁사**: Cursor agent 프롬프트 "Preserve uncertainty: use `unknown` or `investigate`" + clarify-vs-act 라우팅.
- **quanta**: `effort-classifier/`(effort 사이징)+`request_user_input`+closeout R1-R4(fact vs inference)는 있으나 ask-vs-act 게이팅 confidence classifier 없음. Cursor도 프롬프트 directive지 hard classifier 아님 = 델타 작음. **ROI 저-중(프롬프트섹션 추가면 대부분 닫힘).**

> ✅ quanta **AHEAD**(강제 게이트가 시그니처 강점): forced verify-guard(`verify-guard.ts:152` 미검증/실패 edit시 re-turn 강제 — 경쟁사 누구도 테스트 실행 강제 안함) · adversarial multi-voter(`multi-voter/` N refute-biased+quorum) · shadow_verify(disposable-worktree lint/typecheck/test, Codex Preflight 초월) · repro-test harness(`repro-test/` SWE-bench §3.3.1) · parse-test-failure(8-framework frame-tiering) · plan/objective/todo-readback/focus-chain.

---

## 15. Token-economy / 효율 / Context-management

### 15.1 [NEW-GAP] per-model context-window 비례 compaction 트리거 — 신규 MED-HIGH — ✅ **LANDED (verified jun-07)** (= §26.5 / P13)
> **STATUS FLIP → LANDED (jun-07 "D4")**: `llm/provider-metadata.ts:97,119-131` model→`{contextWindow,maxOutput}` 테이블(opus/sonnet 200k, `-1m` 1M). `compaction.ts:197-199` `resolveModelWindow`이 `threshold=contextWindow−maxOutput−COMPACTION_SAFETY_MARGIN` 도출, `context-assembler.ts:328`이 실제 window 방출(이전 `max:0`). `DEFAULT_THRESHOLD=120_000`은 unknown-model fallback만. 상세는 §26.5.
- **경쟁사**: Codex `core/src/compact.rs` + 모델 카탈로그 `auto_compact_token_limit`·`effective_context_window_percent`·`model_context_window`·`max_context_window` + `AutoCompactTokenLimitScope`(low/medium/total). **압축 트리거를 활성모델 context window의 %로 계산.**
- **quanta**: `src/agent/compaction.ts:35` `DEFAULT_THRESHOLD=120_000`(절대값, `compactTokens` env override만). `src/llm/provider-metadata.ts`에 context-window 필드 **없음** — 모델별 window registry 부재라 트리거 스케일 불가.
- **델타**: 200k든 1M든 고정 120k서 압축 → 대형window 모델서 **너무 일찍 압축**(불필요 summarization 라운드트립 ~6× 낭비), 소형window 모델선 over-run 가능. **ROI 중-고**(1M 모델서 ~80%로 스케일하면 mid-task 압축 대부분 제거).

### 15.2 [NEW-GAP] rate-limit-aware 백그라운드 작업 deferral
- **경쟁사**: Codex memory config `min_rate_limit_remaining_percent`+`min_rollout_idle_hours` — account rate-limit 여유가 % 미만이면 백그라운드 consolidation **skip**. 별도 `extract_model`/`consolidation_model`(cheap).
- **quanta**: `src/llm/ratelimit-snapshot/`가 snapshot parse+store하나, auto-dream(`src/memory/dream/cross-session-trigger.ts`)은 **count threshold+lock만** 게이팅 — remaining-% 미참조. 백그라운드 dream/consolidation LLM이 foreground 턴 예산 훔칠 수 있음.
- **델타**: snapshot 데이터 수집됨, 백그라운드-작업 게이팅 소비 배선만 없음. **비용 저/ROI 저-중.**

> ✅ NOT-GAP: delta-token(cacheRead/cacheCreation 분리 `types.ts:198`) · 1h cache+4-breakpoint cap · output-spill(`output-spill.ts` head+tail) · read-dedup file_unchanged(`read/index.ts:248`) · speculative 병렬 dispatch(`streaming-dispatch.ts:25` early-start+barrier) · retrieval LRU+sqlite+delta-track · cheap-model 라우팅(title/memory/compaction) · `/context` usage-breakdown. **server-side compaction(`compact_remote_v2`)=N/A by 아키텍처.**

---

## 16. I/O / File-handling / Encoding

### 16.1 [NEW-GAP] 과긴 단일라인 truncation 없음 — HIGH-ROI — ✅ **LANDED (verified jun-07)** (= §26.10 / P14)
> **STATUS FLIP → LANDED (jun-07 "D8")**: `read/index.ts:56` `MAX_LINE_CHARS=2000` per-line cap + surrogate-safe elision 마커(`… (+N chars elided)`, `index.ts:78`) + `OVERSIZED_NUDGE_TOKENS=25_000` 토큰-aware advisory + outline 모드(`read/outline.ts`). 상세는 §26.10.
- **경쟁사**: Claude CLI `wasLineTruncated`/`[Omitted long context line]`/`[... omitted end of long line]`(`_cli-symbols.txt:118645,118675`) + ripgrep `--max-columns-preview`(:1550). **per-line 폭 cap.**
- **quanta**: `src/tool/read/index.ts:53-63` `renderReadOk`는 **라인 수**로만 slice — 5MB minified 단일라인 통째 방출. per-line char/byte cap 없음(`maxLineLength` grep 0). 외부 200K `capToolOutput`이 mid-line 잘라 구조 손실 + `wasLineTruncated` 신호 없음.
- **델타**: webpack bundle/minified JS/one-line JSON read시 거대라인 transcript flood. **비용 저(renderReadOk서 라인별 cap+`[line truncated]`)/ROI 중.**

### 16.2 [PARTIAL] read가 slice 전 전체파일 슬러프
- **quanta**: `src/storage/service.ts:319-323` `readFile`→`Bun.file().text()` **전체 read** 후 slice. `offset`/`limit`은 in-memory 배열 페이징, disk read 아님. 전체-파일 byte cap 없음.
- **델타**: `offset:1,limit:50`이어도 멀티-GB 텍스트파일 전체 materialize = memory-DoS 표면(binary guard는 binary 케이스만 방지). **ROI 중.**

### 16.3 [NEW-GAP] UTF-8 전용 — BOM/UTF-16 감지 없음 (UTF-16을 binary로 오분류) — 🔲 **STILL OPEN (verified jun-07)** (= P15)
> **VERIFIED jun-07 OPEN**: `charset`/`utf-16`/`stripBom`/`﻿` 디코딩 grep=0. read는 여전히 `Bun.file().text()`(UTF-8 고정), shell decode는 `TextDecoder("utf-8")`. `read/index.ts:133`·`storage/service.ts:351`의 "UTF-16-LE-without-BOM"은 주석(NUL-sniff 설명)뿐 실제 디코딩 아님. UTF-16-LE 파일은 여전히 binary 오분류.
- **경쟁사**: Claude CLI encoding 테이블 `utf-8 utf-16{be,le} unicode-1-1-utf-8`(:1045) + `﻿` BOM 클래스(:107447).
- **quanta**: read는 `Bun.file().text()`(UTF-8), shell decode는 hard `new TextDecoder("utf-8")`(`src/runtime/shell.ts:290`). charset 감지/BOM strip/UTF-16 없음(`charset|utf-16|bom` grep 0). slice-whole-chars는 출력안전이지 입력디코딩 아님.
- **델타**: UTF-16-LE 파일(Windows PowerShell `>` 흔함)이 BOM+NUL-interleave로 **binary NUL guard 트립 → binary로 거부**(실은 텍스트). UTF-8-BOM은 line1 상단 stray `﻿`. **ROI 중(Windows 유저엔 고).**

### 16.4 [PARTIAL] edit가 CRLF 미보존 — ✅ **LANDED (verified jun-07)** (= §26.8)
> **STATUS FLIP → LANDED (jun-07 "D6")**: 신규 `tool/edit/eol.ts` `detectEol`(CRLF strict-majority) + `fuzzy.ts:32` `split(/\r?\n/)` + splice가 `next.join(detectEol(source))`로 검출된 EOL 재방출(`fuzzy.ts:117,242`). 상세는 §26.8. (참고: `exact.ts`는 byte-identical literal splice라 CRLF 보존 — fuzzy 경로만 버그였고 그게 fix됨.)
- **경쟁사**: Codex/Claude EOL normalize-then-restore(`\r\n`↔`\n`).
- **quanta**: `src/tool/edit/exact.ts` UTF-8 plain replace, CRLF normalize/restore 없음(`\r|crlf` grep 0). multi-line anchor를 `\r\n` 콘텐츠에 매칭하면 `\r` 때문에 무음 실패.
- **델타**: CRLF 파일서 혼란스러운 edit "not found" + EOL-preserving write 없음. **ROI 중(Windows repo, .gitattributes eol=crlf).**

### 16.5 [NEW-GAP] cell-aware NotebookEdit 없음 (ipynb read-only) — 🔲 **STILL OPEN (verified jun-07)** (= P17)
> **VERIFIED jun-07 OPEN**: `NotebookEdit`/`cell_id`/`editCell` grep=0(src 전체). `read/ipynb.ts`는 여전히 render-only. write half 미구현.
- **경쟁사**: Claude `NotebookEdit`(cell_id별 edit/insert/delete) — 이 하네스의 deferred 도구.
- **quanta**: `src/tool/read/ipynb.ts`는 RENDER만(read-only). `notebook.?edit|cell_id` grep 0. `.ipynb` 편집은 raw-JSON edit fallback(brittle: base64 outputs, escaped source array).
- **델타**: cell-aware notebook mutation 없음. read half는 이미 shipped라 write half는 자연 완성. **ROI 중(data-science).**

### 16.6 [PARTIAL] parquet/sqlite reader 없음
- **quanta**: csv/ndjson/yaml/docx/pdf/pptx/xlsx(`src/tool/document/`)는 있으나 parquet/sqlite reader 없음. `.parquet`/`.db`는 binary guard로 unreadable.
- **델타**: 구조화 커버리지 넓으나 parquet/sqlite 빠짐. **ROI 저-중.**

> ✅ NOT-GAP(quanta 우위): NUL-sniff binary guard + FIFO/device guard(`read/index.ts:65-111`) · `realResolve` dangling-symlink 세그먼트별(`service.ts:204`, MAX_HOPS=40, 흔한 jail보다 우위) · writeFileAtomic(`atomic-write.ts`) + sha256 `expected_hash` precondition + stale-read mtime+marker guard + criticalSection tear-protection(`edit/index.ts:187`).

---

## 17. Cross-platform / Shell / Terminal

### 17.1 [NEW-GAP] shell 출력 ANSI/control-char strip 없음 — HIGH-ROI — 🔲 **STILL OPEN (verified jun-07)** (= P11)
> **VERIFIED jun-07 OPEN**: `bash/index.ts:281` `formatRunBody`가 **여전히 `[r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()` verbatim**(직접 읽음 — stripAnsi 미적용). `stripAnsi` 유틸은 `ui/ui-helpers.ts`에 존재+issue-hint/stdout-adapter서 쓰이나 모델-대면 shell 출력 경로엔 미배선. 순수함수 quick-win 그대로.
- **경쟁사**: Claude CLI `stripANSI`(`_cli-symbols.txt:119654`) + `Contains control characters`(:122353).
- **quanta**: `src/tool/bash/index.ts` `formatRunBody`(:281-290) raw stdout/stderr verbatim join — ANSI/OSC/control scrub 없음. read도 raw. `stripAnsi|\x1b|control.char` grep 0.
- **델타**: `ls --color=always`/progress spinner/`vite` 등 escape 코드가 transcript flood(토큰낭비+모델혼란), NUL 등 control char 무sanitize. **비용 저(pure fn)/ROI 중-고**(colored CLI 극히 흔함).

### 17.2 [NEW-GAP] shell 바이너리 하드코딩 `bash -lc` (Windows shell 없음) — 🔲 **STILL OPEN (verified jun-07)** (= P16)
> **VERIFIED jun-07 OPEN**: `runtime/shell.ts:146` `const baseArgv = ["bash","-lc",command]` **여전히 무조건**(직접 읽음), `process.platform`/win32/cmd/powershell 분기 grep=0.
- **경쟁사**: (Windows-native 지원하는 에이전트들은 cmd.exe/powershell fallback).
- **quanta**: `src/runtime/shell.ts:138` `const baseArgv=["bash","-lc",command]` **무조건**, `process.platform` 분기 없음(win32/cmd/powershell 0). OS-sandbox는 win32 인지(`os-sandbox/default.ts:152` `win32-sandbox-helper-missing`)+`local-env/apply.ts:102` PATH `;` 처리하나, **shell 바이너리는 항상 bash**. WSL/Git-bash 없는 Windows선 모든 bash 도구 spawn 실패.
- **델타**: sandbox/env 레이어는 platform-aware, command spawn은 아님. quanta multi-surface라 Windows desktop 빌드엔 중요. **ROI 중.**

> ✅ NOT-GAP: PTY slice(`src/tool/pty/` tmux+bun-pty, resize) · bracketed-paste/paste-burst(`raw-line-reader.ts`, hellgate 존재).

---

## 18. Prompt-prose 흡수 후보 (콘텐츠 마이닝)

> quanta 프롬프트(`prompt-body.ts`/`prompt-directives.ts`/`mode-variants.ts`)는 **behavioral axis서 이미 최강**(evidence-discipline/claim-ladder/anti-signal/budget/honesty-rail). 대부분 경쟁사 룰을 quanta가 더 엄격히 보유. 갭은 **출력 presentation + notify**에 집중.

### 18.1 [NEW] PushNotification "err toward not sending" 결정 prose
- **경쟁사**: Claude CLI `vq7`/`PushNotification` — "…err toward not sending one. Don't notify for routine progress… Notify when there's a real chance they've walked away and there's something worth coming back for… under 200 characters, one line… Lead with what they'd act on — 'build failed: 2 auth tests' tells them more than 'task done'".
- **quanta**: notify 결정 prose 부재(push/desktop notification 도구 없음).
- **델타**: AFK 유저 interrupt cost/benefit + 메시지 framing. **ROI 고(notify 표면 shipping 시), 그 전엔 dormant.** (§11 notify와 연관.)

### 18.2 [NEW] "패치 후 파일 재read 금지" 워크플로 룰
- **경쟁사**: Codex CLI "Do not waste tokens by re-reading files after calling `apply_patch`… The tool call will fail if it didn't work."
- **quanta**: `prompt-body.ts:172` "이미 read한 파일 재read 금지"(pre-read dedup)는 있으나 "write 착지 검증용 재read" anti-pattern은 없음. edit는 context-mismatch시 에러라 불변식은 성립하나 prose nudge 부재.
- **델타**: 흔한 토큰낭비 verify-loop 제거. Budget-discipline 섹션에 1문장. **ROI 중.**

### 18.3 [PARTIAL] final-answer formatting style-guide
- **경쟁사**: Codex CLI "Final answer structure and style" — `**Title Case**` 헤더(1-3단어), `-` 불릿(4-6 importance순), 커맨드/경로/env를 backtick monospace, **file path `:line[:column]` clickable inline code**, `file://` URI 금지. + Cursor 인용포맷.
- **quanta**: `prompt-body.ts:346` "task kind별 리포팅 shape"(semantic richer)는 있으나 **formatting/markup 룰 없음** — 헤더 casing/불릿그룹/monospace-경로/clickable file:line 규약 없음. file:line 인용은 evidence로 하나 rendering 계약은 모델에 안알림.
- **델타**: scannable 일관 최종메시지 + clickable 경로. ⚠️ quanta CLI 렌더러가 clickable path 지원하는지 확인 후 채택. **ROI 중.**

### 18.4 [NEW] "도구명 노출 금지 / save-the-file 금지" surface-polish
- **경쟁사**: Cursor "Don't refer to tool names when speaking to the USER… say what the tool is doing in natural language." + Codex "no need to tell users to 'save the file'… just reference the file path."
- **quanta**: `prompt-body.ts:77` "Internal vocabulary(NEVER expose)"는 구현 jargon 금지지 도구명/save-the-file 룰은 아님.
- **델타**: natural user-facing voice + 불필요 save 지시 제거. **ROI 저-중.**

> ✅ quanta가 이미 동등-이상(미추천): Codex preamble/progress→`PROGRESS_NARRATION` · ambition-vs-precision→editor/architect mode · keep-going→Bias-to-action+AUTONOMOUS_PREAMBLE · Cursor maximize-context→ORIENT→NARROW→CONFIRM ladder · general-solution-no-reward-hack→휴리스틱금지+honesty-rail · root-cause/minimal→Operating principles.

---

## 19. 도구 프로토콜 / 계약 깊이 (MCP ingestion boundary)

> **STATUS (verified jun-07, src-confirmed)**: §19.1 annotations ✅ LANDED(`agent/mcp-bridge.ts:123,349,431` `annotationPredicates` + `QUANTA_MCP_TOOL_ANNOTATIONS` trust-gate + `mcp/types.ts:58` `McpToolAnnotations`) · §19.2 structuredContent ✅ LANDED(`mcp/client.ts:111-114`→`ToolResult.structured`; `_meta`/audio 절반만 OPEN) · §19.3 MCP image media ✅ LANDED(`mcp-bridge.ts:200,249` `mediaToResultFields`+magic-byte sniff+5MB cap→`ToolResult.images/documents`; audio 미매핑 OPEN) · §19.4 progress bridge ✅ LANDED(`mcp/progress.ts`+`client.ts:331` per-token sink, default-OFF) · §19.5 tools/list_changed ✅ LANDED(observer route). **P19/P20 = §19.1/§19.3 = LANDED 확인.**

> quanta **네이티브** 도구 계약은 경쟁사보다 우위(9-arm `ToolFailure` 유니언·`nextAction` cap·`criticalSection`/`interruptBehavior`·image/document result block). 갭은 전부 **MCP ingestion** — 서버가 보낸 프로토콜 richness를 quanta가 버림.

### 19.1 [LANDED ✅] MCP `ToolAnnotations`(readOnly/destructive/idempotent/openWorldHint) ingestion서 드롭 — HIGH-ROI
- **경쟁사**: Codex `struct ToolAnnotations with 5 elements`(`_codex-rs-0.135-symbols.txt`); Claude CLI readOnlyHint×4/destructiveHint×3/idempotentHint×2/openWorldHint×3; Cursor MCP dist 동일 4개.
- **quanta**: `src/mcp/client.ts:77-82` `RawTool`이 `{name,description,inputSchema}`만 narrow — `annotations` 미파싱. `src/agent/mcp-bridge.ts:87-88`이 **모든 MCP 도구를 `isReadOnly:()=>false, isConcurrencySafe:()=>false` 하드코딩**. `annotations` grep 0.
- **델타**: 모든 MCP 도구가 mutating+non-concurrency-safe 취급 → `readOnlyHint:true` 서버 도구가 read-only 병렬배치 못 타고 `always-confirm` HITL로 잘못 default(`inferToolTier`). **quanta 전 permission/concurrency 머신이 isReadOnly/isConcurrencySafe/hitlTier로 동작하는데 MCP엔 상수 거짓.** 4 hint→기존 ToolCore predicate 매핑은 작은 adapter 변경. **ROI 고(보안+병렬).**
- **구현**: `McpToolAnnotations` 타입(`types.ts`) + `sanitizeAnnotations`(boolean-ONLY lift, poison `"true"`/`1`/`{}`/`null` 드롭)가 `RawTool.annotations`→`McpToolDef.annotations` 파싱(`client.ts`+`isolated-client.ts` 양쪽). 브리지 `annotationPredicates`가 **TRUST GATE** 하에 매핑: `honored = QUANTA_MCP_TOOL_ANNOTATIONS knob ON && McpServerConfig.trusted===true`; `isReadOnly = honored && readOnlyHint===true`; `isConcurrencySafe = isReadOnly && idempotentHint!==false`. **annotations는 trusted+knobOn에서만 ELEVATE; 절대 downgrade 안 함**. untrusted/knobOff/poison/absent ⇒ `false/false` byte-identical. knob=`mcp-tool-annotations`(`AgentConfig.mcpToolAnnotations`). hellgate(red-on-injection): untrusted+`readOnlyHint:true`→`isReadOnly()===false`, knobOff(trusted여도)→false, poison string→false. 13 bridge + 14 parse 테스트.

### 19.2 [LANDED jun-7 R2] MCP `structuredContent`→ToolResult.structured (result `_meta`는 소비처 없어 미surface)
- **경쟁사**: Codex `struct CallToolResult with 4 elements`=content/structuredContent/isError/_meta; Claude structuredContent×30/outputSchema×63; Cursor ×15/×13.
- **quanta**: `src/mcp/client.ts:91-93` `ToolsCallResult`이 `{content?,isError?}`만; `:161-165` `joinTextBlocks`가 text만. structuredContent/_meta grep 0. 네이티브 `ToolResult.structured`+`outputSchema` seam(`types.ts:889`)은 있으나 MCP에 미배선.
- **델타**: 서버의 typed structured payload 무음 드롭. **ROI 중**(네이티브 structured는 deprecated-그룹이라 내부 수요 낮으나 MCP interop엔 lossy).

### 19.3 [LANDED ✅] 비-텍스트 MCP content block(image/audio/resource/resource_link) 결과서 드롭 — image HIGH
- **경쟁사**: Codex `RawImageContent`/`RawAudioContent`/`RawEmbeddedResource`/`resource_link`; Claude `audio`×9/`resource_link`×6.
- **quanta**: `src/mcp/client.ts:161-165` `joinTextBlocks`가 `type==="text"`만 → image/audio/resource 전부 폐기. `ContentBlock`(`:87-90`)은 `{type,text?}`만.
- **델타**: 스크린샷/오디오/embedded resource 반환하는 MCP 도구가 빈/부분 출력. **네이티브 `ToolResult.images`/`documents`(`types.ts:931,942`)는 이미 모델에 plumb** — MCP→ToolResult 매핑만 안함. **image ROI 고(렌더 쪽 이미 완성).**
- **구현**: `ContentBlock`을 `{type,text?,data?,mimeType?,resource?}`로 확장 + `extractMedia`(`client.ts`, 양 클라이언트 재사용)가 `image`(data+mimeType)→`McpMediaBlock{kind:"image"}`, embedded `resource`(blob+mimeType)→`{kind:"resource"}`. `McpCallResult.media?` OPTIONAL(텍스트-only면 omit ⇒ byte-identical). 브리지 `mediaToResultFields`가 **네이티브 vision 도구와 동일 안전**: image는 base64-decode→**5MB cap(`READ_IMAGE_MAX_BYTES` 재사용)**→**magic-byte sniff(`sniffMediaType`, 서버 거짓 mimeType 무시)**; over-cap/unrecognized/bad-base64는 SKIP+정직 마커(crash 없음), 검증바이트 재인코딩→`ToolResult.images`. resource→`ToolResult.documents`. audio는 아직 미매핑(`type`만 추가, 별 follow-up). hellgate: oversized→skip+marker(no crash), 거짓 mimeType+비이미지→skip, valid PNG→magic-byte로 `image/png`(서버 lying `image/jpeg` 덮어씀).
- **남은(부분구현)**: §19.2 `structuredContent`는 이제 **PARSED+매핑됨**(`mcp/client.ts` → `ToolResult.structured`, round-1) — result `_meta` 절반과 전용 테스트만 OPEN(완전 OPEN 아님). audio content block plumb은 여전히 OPEN(`ToolResult`에 audio sink 부재).

### 19.4 [LANDED jun-7 R2] MCP progress bridge (default-OFF seam)
- **경쟁사**: Claude progressToken×5/notifications/progress×5/ProgressToken×13; Cursor progressToken×12.
- **quanta**: 네이티브 `ToolEvent.progress`는 렌더(`registry.ts:136`)되고 `mcp-bridge.ts:90`이 coarse "calling…" 1줄. 단 `tools/call` `_meta`에 progressToken 미전송 + inbound progress handler 없음(grep 0). 느린 MCP 도구가 mid-call progress 0.
- **델타**: UX-only(correctness X). inbound-notification plumbing(`resources/notifications.ts`) 재사용 가능. **ROI 중.**

### 19.5 [LANDED jun-7 R2] `notifications/tools/list_changed` → observer route
- **경쟁사**: Claude tools/list_changed×8/listChanged×25(재-list).
- **quanta**: client로 `listChanged:false`만 광고, 서버 push시 re-`tools/list` 핸들러 없음. connect시 1회 enumerate 후 freeze(`client.ts:424`). reconnect supervisor는 full swap시만 re-list.
- **델타**: mid-session 도구 추가/제거(auth 후 등) 미반영. **ROI 저-중**(static-menu는 reproducibility 기능이기도).

> ✅ NOT-GAP: input-validation(`passthroughSchema` 서버 JSON Schema verbatim + 네이티브 zod) · in-tool sampling/elicitation(inbound router 완비, 패리티-이상) · icons/title(presentation-only, CLI엔 ROI 0).

---

## 20. Subagent 전문화 / Agent-role / Agent-definitions

> **STATUS (verified jun-07, src-confirmed)**: §20.1 role-specialized system prompt ✅ LANDED(`subagent-runner.ts:396` `req.system ?? def.system`, absent⇒parent.system byte-identical) · §20.2 named agent runtime load ✅ LANDED(신규 `agent/named-agent-registry.ts:230` `loadNamedAgents`, `subagent-runner.ts:385` `namedAgentResolver` fold, INTERSECTION tool-filter로 widen 불가) · §20.3 nickname pool ✅ LANDED(`subagent-runner.ts:503,511,723` `recordChildNickname`→`assignNickname`, dead→live) · §20.4 owned/forbidden FS enforce PARTIAL(advisory 그대로, deferred). **P21/P22 = §20.1/§20.2 = LANDED 확인.**

> quanta는 subagent **plumbing**(coordination/mailbox/depth/model-override/owned-forbidden/nickname-pool)은 두꺼우나 **identity/specialization은 얇음** — child가 항상 `parent.system` 상속, agentType은 display-label-only.

### 20.1 [LANDED ✅] role-specialized SYSTEM PROMPT 없음 — HIGH-ROI
- **경쟁사**: Claude 각 agent type이 자체 `getSystemPrompt`+전문 시스템프롬프트(`_cli-symbols.txt:124846-124868` general-purpose/local-agent/guide); Cursor `SubagentType{Explore,Debug,Bash,ComputerUse,BrowserUse,VmSetupHelper,…}`(`cursor-agent-exec/dist/main.js:28915-29096`) 각 distinct posture; Codex role file이 role별 non-empty `developer_instructions` 강제(`:6217`).
- **quanta**: `src/agent/subagent-runner.ts:461` `buildChildConfig`가 `system:parent.system`. `SubagentRequest`(`src/subagent/types.ts`)에 `system`/`developer_instructions` 필드 **없음**. 유일 전문 프롬프트는 내부 `reviewer-subagent.ts:33`(non-selectable).
- **델타**: 모든 subagent가 부모 identity로 실행 — explorer에 read-only-research 페르소나, reviewer에 critique 페르소나 줄 방법 없음. `SubagentRequest`에 optional `system` 추가 + `buildChildConfig`서 `parent.system` 대체, default-OFF byte-identical. **ROI 고(역할위임 실제 작동의 핵심).**
- **구현**: `SubagentRequest`에 optional `system?`/`mode?` 추가(`src/subagent/types.ts`; `model?`은 ADR-0451서 기존). `buildChildConfig`가 `resolveChildSystem(parent,req)`=`req.system??parent.system` 사용(`src/agent/subagent-runner.ts`) — `req.system` absent ⇒ child.system===parent.system byte-identical. 명시 caller OR 매칭 named-agent def(§20.2)이 system 주입. hellgate `tests/unit/subagent/named-agent-spawn-hellgate.test.ts`(NAS-SYS/EXPLICIT/NORES/NOMATCH/SYSABS/MODE) + fc `subagent-role-identity.yaml`.

### 20.2 [LANDED ✅] named agent definitions 런타임 로드 안됨(write-only)
- **경쟁사**: Claude `.claude/agents/*.md`(when_to_use/tools/disallowedTools/permissionMode/mcpServers/maxTurns/model/color, `_cli-symbols.txt:124846`); Codex agent-role TOML(layered load + 중복탐지 `:6202-6232`).
- **quanta**: `src/migration/external-config/convert.ts:245`이 `.claude/agents/<name>.md` **read** + `persist.ts:427`이 `.quanta/agents/<name>.md` **write** — 단 **런타임서 `.quanta/agents/*.md` 로드 안함**(`readdir.*agents`/`loadAgentDefinition`/`namedAgentRegistry`/`resolveAgentType` grep 0).
- **델타**: 경쟁사 agent 파일 ingest하나 named agent 인스턴스화 불가. agent_type→{system,tools,model,mode} registry 없음. converter(producer)는 이미 있음 — 런타임 loader+registry만. **20.1과 같은 seam**(로드된 .md body가 곧 전문 system prompt). **ROI 고.**
- **구현**: NEW `src/agent/named-agent-registry.ts` — `loadNamedAgents(cwd)`가 `.quanta/agents/*.md`(PERSIST 목적지)+`.claude/agents/*.md`(Claude parity) 로드, **converter와 동일한 `@/skill#parseFrontmatter` 재사용**(파서 중복 없음), `Map<agentType,{system,tools?,model?,mode?}>`+`resolve()` 구축. 런너 `applyNamedAgent(parent,req)`가 `AgentConfig.namedAgentResolver`(structural 접근)서 매칭 agentType → `{system,toolFilter,model,mode}` fold(explicit-request-wins). **SECURITY(tool widening)**: def.tools는 repo-controlled → `toolFilter`로만 타고 `filterRegistry` INTERSECTION(parent 부여 surface와 교집합) ⇒ NARROW-only, 절대 widen 불가(NAS-WIDEN red-on-injection 증명: parent에 bash 無 → def `tools:[bash]` 요청해도 child에 bash 無). symlink 거부+64KB body cap+256 file cap. 無 dir ⇒ empty registry byte-identical. loader hellgate `tests/unit/agent/named-agent-registry.test.ts`(NAR-01~09).

### 20.3 [LANDED ✅] nickname pool DEAD CODE(미배선)
- **경쟁사**: Codex per-thread `agent_nickname`+`agentRole` persist(`:7694,4731`), role별 `nickname_candidates`(`:6206`), 2-4단어 `agent_namer`.
- **quanta**: `src/subagent/nicknames.ts` 39-name maestro pool+`assignNickname`/`nextSequentialNickname` — **자체 테스트 외 호출 0**. 실 spawn은 ordinal `root/0`,`root/1`(`subagent-runner.ts:591`). display label은 `agentType??prompt.slice(0,40)`.
- **델타**: pool(+FNV-1a seeding) 만들고 미배선. `assignNickname(mailboxId)`를 `registry.register`에 몇 줄. **built-but-unwired, ROI 저-중(observability).**
- **구현**: `recordChildNickname`(`src/agent/subagent-runner.ts`)이 spawn마다 `assignNickname(STABLE mailboxId)` → host `AgentMetaRegistry`(=`list_agents` label source, `req.taskId` 키)에 DISPLAY label write. STABLE id는 ordinal `root/0` 유지(불변), nickname은 거기서 deterministic 파생(FNV-1a, clock/uuid 無 → recorded session 동일 재생). `agentType` 우선(더 informative), 無이면 nickname fallback. `assignNickname`을 `@/subagent` barrel서 export(dead→live). `subagentAgentMeta` 無 OR `taskId` 無 ⇒ no-op byte-identical. hellgate NAS-NICK/NICK-OFF/deterministic.

### 20.4 [PARTIAL] owned/forbidden surfaces advisory-only(미enforce) + role 정책테이블 미커플
- **경쟁사**: Codex role `filesystem subpath`/`glob` access **enforce**(deny-default subtree, `:6228`).
- **quanta**: `owned_surfaces`/`forbidden_surfaces`는 seed 프롬프트에 **prose 주입만**(`subagent-runner.ts:330-339`) — child가 forbidden surface 만져도 안막음. `src/subagent/role.ts` 3-role×7-kind 정책테이블도 contracts-only(runner 미참조, enforcement는 `agent-tool.ts deriveToolFilter`만).
- **델타**: path-scoped FS enforcement 없음(advisory). **ROI 중(보안).**

> ✅ NOT-GAP: leader/worker coordination(broker/dag/idle-barrier, Codex 초월) · continue_from/checkpoint/result_shape/priorAttempt handoff.

---

## 21. Search / Grep / Glob / Code-navigation 깊이

> **STATUS FLIPS (verified jun-07)**: §21.1 grep `-A/-B/-C` 🔲OPEN→✅ **LANDED**(`tool/grep/index.ts:13-15,75-77` 컨텍스트라인 인자+DoS bound) · §21.2 grep `output_mode` 🔲OPEN→✅ **LANDED**(`grep/index.ts:16-19` `content/files_with_matches/count` enum→rg `-l`/`-c`) · §21.3 grep `-i`/multiline/type filter PARTIAL(미확인 — 별도) · §21.4 glob gitignore+mtime PARTIAL→✅ **LANDED**(`tool/glob/index.ts:18,45,58` rg 기반 `.gitignore`/`.ignore` 존중 + mtime-desc sort, `Survivor{rel,mtimeMs}` stat) · §21.5 search scope ✅ LANDED(`search-codebase/index.ts:40` `scope` param). **P23/P24/P25 전부 LANDED 확인(이전 OPEN/PARTIAL에서 FLIP).**

> quanta **symbol-nav(LSP 15도구) + semantic-retrieval 엔진은 패리티-이상**. 갭은 거의 전부 **grep/glob CLI-flag 표면**(모델 노출 파라미터)에서 — Claude/Cursor가 훨씬 풍부.

### 21.1 [NEW-GAP] grep context lines `-A`/`-B`/`-C` 없음 — HIGH-ROI — ✅ **LANDED (verified jun-07)** (= P23)
> **STATUS FLIP → LANDED**: `tool/grep/index.ts:13-15` schema에 `A`/`B`/`C` int 파라미터(integer-validated + `CONTEXT_MAX` DoS bound), `:75-77`이 `parts.push("-A"/"−B"/"−C", n)`로 rg argv 주입.
- **경쟁사**: Claude `_cli-symbols.txt` — `-A`/`-B`/`-C`("Number of lines after/before/context, rg -A/-B/-C").
- **quanta**: `src/tool/grep/index.ts:7-11,51` — `{pattern,path,glob}`만, rg argv 고정(`--line-number --no-heading --color=never`).
- **델타**: 매치 후 주변코드 보려면 매번 file re-Read 필요. **context line은 최빈출 rg flag. 비용 저(argv 추가)/ROI 고.**

### 21.2 [NEW-GAP] grep `output_mode`(files_with_matches/count) 없음 — HIGH — ✅ **LANDED (verified jun-07)** (= P24)
> **STATUS FLIP → LANDED**: `tool/grep/index.ts:16-19` `output_mode: z.enum(["content","files_with_matches","count"])`(default content) → rg `-l`/`-c` 매핑(`:55-62`, 컨텍스트 flag는 -l/-c서 drop). content 모드는 byte-identical baseline.
- **경쟁사**: Claude — `output_mode`: content/`files_with_matches`(paths-only, default)/`count`(→rg `-l`/`-c`).
- **quanta**: 항상 `path:line:match` 방출. files_with_matches/count 없음.
- **델타**: "어느 파일에 X 있나" breadth 조사를 full-row(200줄cap)로 강제. **ROI 고(cheap breadth survey).**

### 21.3 [PARTIAL] grep `-i`/`multiline`(-U)/`type` filter 없음
- **경쟁사**: Claude `-i`(case-insensitive)/`multiline`(-U dotall)/`type`(js/py/rust…, "more efficient than include").
- **quanta**: 없음 — `(?i)` inline regex로 우회, cross-line 패턴 표현불가, type는 `-g` glob만.
- **델타**: cross-line 함수시그니처 매치 불가, type 더 verbose. **ROI 중.**

### 21.4 [PARTIAL→GAP] glob gitignore 미존중 + mtime sort 없음 — ✅ **LANDED (verified jun-07)** (= P25)
> **STATUS FLIP → LANDED**: `tool/glob/index.ts`가 `Bun.Glob` junk-scan → rg 기반으로 교체 — `:58` 도구설명 "Respects `.gitignore`/`.ignore` (node_modules, dist, etc. excluded)" + `:18,45-49` `Survivor{rel,mtimeMs}` stat 후 **most-recently-modified first** sort. re-jail/TOCTOU-drop 방어 포함. gitignore 존중 + mtime sort 둘 다 closed.
- **경쟁사**: Claude/Cursor glob이 ignore 룰 기본 존중(Cursor `exclude_pattern`); Claude glob "sorted by modification time".
- **quanta**: `src/tool/glob/index.ts:55-74` — `Bun.Glob().scan({dot:false})`가 **`.gitignore` 미존중** → `node_modules/`/`dist/` 반환(300-entry cap을 junk가 먹음); `hits.sort()` alphabetical(mtime 아님 — 최근수정 파일 묻힘).
- **델타**: gitignore 존중(또는 post-filter) + mtime sort. **ROI 중-고(cap 낭비/관련성).**

### 21.5 [LANDED jun-7 Wave R] search_codebase directory scoping
- **경쟁사**: Cursor `codebase_search`/`grep_search` `target_directories`(×8).
- **quanta**: `src/tool/search-codebase/index.ts:26-39` `{query,k}`만 — path/scope 파라미터 없음(엔진 `src/retrieval/`은 강한데). "src/auth/ 안에서만 semantic-search" 불가, 전체 검색 후 필터.
- **델타**: 도구 표면에 scope 1 필드(엔진은 이미 지원). **ROI 중.**

> ✅ NOT-GAP(패리티-이상): LSP nav 15도구(def/type-def/impl/refs/hover/doc-symbol/workspace-symbol/incoming+outgoing-calls/rename, Codex/Cursor는 LSP도구 표면 없음) · retrieval 엔진(BM25+RRF+rerank) · git_blame/heatmap. fuzzy file-find은 NEW-GAP이나 ROI 저(glob 커버).

---

## 22. SDK / Headless / 확장성 / Custom-tool 저작

> **STATUS (verified jun-07, src-confirmed)**: §22.1 `--output-format stream-json` ✅ LANDED(`apps/agent/mode-presets/stream-json-sink.ts` `StreamJsonSink`가 `encodeSessionEvent` 코덱 재사용, default-OFF) · §22.2 `$ARGUMENTS`/`$N` ✅ LANDED(`skill/skill-tool.ts:14-32` single-pass 보간) · §22.3 reverse-MCP OPEN · §22.4 SDK 패키징 PARTIAL. **P26 = §22.1 = LANDED 확인.**

> quanta 확장성 강함(in-process hook bus + shell command-hooks + skills-as-commands + plugin loader + migration importer). 갭은 좁음: stdout JSON output + `$ARGUMENTS` 템플릿 + reverse-MCP. (quanta는 Claude Agent SDK 하네스 **안**서 돌아 일부 SDK 기능 N/A.)

### 22.1 [LANDED ✅] `--output-format stream-json`(stdout) — HIGH-ROI(keystone)
- **경쟁사**: Claude `--print`/`-p`+`--output-format json|stream-json`+`--input-format`+`--include-partial`+`--replay-user-messages` — SDK/CI consumer용 stdout 메시지 envelope.
- **quanta**: `src/host/runtime/agent-args.ts:131` `--mode headless -p`는 있으나 `--output-format` **없음**. `src/apps/headless/index.ts:132`는 FakeLlm 테스트 하네스. NDJSON sink(`ndjson-wire.ts:100`)는 TCP port/file 타겟(introspection firehose)지 stdout consumer 계약 아님. **`SessionEvent`(`src/protocol/session/events.ts:125`)+codec은 이미 완비** — stdout writer만 없음.
- **델타**: `quanta -p "..." --output-format stream-json | jq` 가 아무것도 안 줌. CI/script/SDK consumer 못붙음. **ROI 고(작은 wire, 큰 unlock — headless+output-format 갭이 한 fix로 합쳐짐).**
- **구현**: 새 `src/apps/agent/mode-presets/stream-json-sink.ts` — `StreamPort`를 구현한 `StreamJsonSink`가 각 `AgentEvent`를 `SessionEvent`로 매핑하고 **이미 완성된 `encodeSessionEvent` 코덱을 그대로 재사용**(`{version:"session.v1",kind:"event",payload}` 봉투, bespoke 인코딩 없음). `stream-json`=이벤트당 1줄 NDJSON, `json`=끝에 단일 최상위 JSON 배열로 flush. partial/delta(`assistant_text`→`turn.output.delta`)는 `--include-partial`일 때만. 사람용 최종답변은 `logger`(stderr-bound)로 가 stdout 머신 컨트랙트를 오염 안 함. headless 프리셋(`mode-presets/headless.ts`)이 `req.headless.output`을 읽어 sink를 mint+cfg.stream 주입+json finalize. `HeadlessExtras`(`agent-config-assembler.ts`)에 `output:"text"|"json"|"stream-json"`+`includePartial` 확장. 기본/`text`=stdout byte-identical(default-OFF). 테스트: `stream-json-sink.test.ts`(11) + `headless-stream-json-e2e.test.ts`(6) = 17 신규, jq 파이프라인 exit-0 실증. **CLI arg 파싱 경로(`agent-args.ts` 파서·`agent-arg-builder.ts` `AssembleRequestPartial`·`index.ts` `applyModeSpecificRequestFields`)는 PARENT-OWNED이라 EMIT로 위임**(아래 패치 스펙).

### 22.2 [LANDED jun-7 Wave R] custom command `$ARGUMENTS`/`$1` 템플릿
- **경쟁사**: Claude `.claude/commands/*.md` `$ARGUMENTS`/`$1`/`$2` positional 치환.
- **quanta**: skill이 command 표면(`src/skill/discover.ts:119` allowed-tools/argument-hint/model/userInvocable 파싱은 패리티) 단 `$ARGUMENTS`/`$1` 치환 없음(grep 0) — argument-hint는 descriptive-only, skill body verbatim 주입.
- **델타**: parameterized prompt-command 불가. frontmatter scaffold는 있음, invocation서 interpolation 패스만. **ROI 중.**

### 22.3 [NEW-GAP] quanta-as-MCP-server(reverse) 없음
- **경쟁사**: Claude/Codex가 MCP로 구동/노출 가능.
- **quanta**: `src/mcp/`는 **client-only**(외부 MCP 소비). server-side serving(`StdioServerTransport`/`McpServer`/inbound tool-call handler) grep 0.
- **델타**: quanta를 MCP 서버로 띄워 다른 에이전트가 quanta 도구/세션 호출하는 경로 없음. **ROI 저-중(interop 니치).**

### 22.4 [PARTIAL] agent-SDK 패키징 안됨
- **quanta**: `src/sdk/runtime/types.ts:50-117` `RuntimeSession`(dispatch/subscribe/snapshot/turn/approval)+`RuntimeFacade.createSession()` 풍부 — 단 `package.json`에 `bin`/`exports`/`main` 없음. npm install-embed 불가(내부 composition만).
- **델타**: embeddable session core(어려운 부분)는 완성, 패키징(`exports` map)만. **ROI 중**(quanta 하네스-호스트라 가치 bounded).

> ✅ NOT-GAP: custom-tools(`defineTool` `factory.ts:57`) · hooks-scripting(in-process bus `hooks.ts:126` + shell command-hooks `command-hooks/types.ts:43` JSON-stdin Claude계약 verbatim + `updatedInput` rewrite=Cursor패리티, **ahead**) · custom-subagents(migration import) · plugin-api(`plugin-loader.ts:1`).

---

## 23. Cost / Usage / Quota / 투명성 / Onboarding

> **STATUS (verified jun-07, src-confirmed)**: §23.1 ratelimit notice ✅ LANDED(`apps/cli/ratelimit-notice.ts`, P27) · §23.3 `/version`+`/release-notes` ✅ LANDED(`apps/cli/version-cmd.ts`+`repo-info.ts`) · §23.4 `/bug` ✅ LANDED(`apps/cli/bug-cmd.ts`) · §23.5 per-model cost ✅ LANDED(`apps/cli/cost-panel.ts:56,166` `perModel` Map+`byModel()`) · §23.2 quota-exhausted graceful PARTIAL(deferred).

> quanta 예상보다 강함 — `/cost`(tokens/duration/$/per-turn)·`/usage`·`/context`(segmented window%)·`/status`·`/doctor`·`/help` 다 있음. **`/init`도 present**(`src/skill/system-skills/init/SKILL.md` — 스카우팅 오보고 정정). 갭은 usage-LIMIT 투명성·release-notes·feedback에 집중.

### 23.1 [LANDED ✅] usage-limit "approaching limit · resets" UX — HIGH-ROI(데이터 있음, 미렌더) — ✅ **CONFIRMED LANDED (verified jun-07)** (= P27)
> **VERIFIED jun-07**: `src/apps/cli/ratelimit-notice.ts`(신규 closed StreamPort)가 `ratelimit_snapshot` AgentEvent를 StatusBar transient notice로 렌더. gate `QUANTA_RATELIMIT_NOTICE` default-OFF — OFF면 `stdout.ts:151` 빈 case byte-identical. 실재 확인됨.
- **경쟁사**: Claude `_cli-symbols.txt` — `You're close to your ${usage limit}`/`Approaching ${_} · resets ${O}`, rateLimitType별 라벨(weekly/session/Opus/Sonnet); Codex `RateLimitSnapshot{limit_name,primary,secondary,credits,plan_type,rate_limit_reached}`+`RateLimitWindow{used_percent,window_minutes,resets_at}`.
- **quanta**: snapshot **파싱은 함**(`src/llm/ratelimit-snapshot/parse.ts`,`notice.ts:13`) 단 proactive backoff에만 씀(`policy.ts:27`), notice **렌더 안됨** — `src/stream/adapters/stdout.ts:151`이 `ratelimit_snapshot` 명시적 **무시**("a richer surface renders it" — 근데 그 surface 없음, render grep 0).
- **델타**: "한도 X%"·"approaching · resets Y"·소진 전 경고 없음. **데이터 이미 캡처됨 — status-line/spinner 렌더러+임계값만. ROI 고.**
- **구현 (P27, jun-7)**: `src/apps/cli/ratelimit-notice.ts` (신규 closed StreamPort) — `ratelimit_snapshot` 이벤트를 status-bar transient notice("⚠ 한도 reached · resets 3h")로 렌더. **surface 결정은 새 percent 도입 0 — 슬라이스가 이미 계산한 REACHED 신호(empty-window predicate `remaining <= 0`, `policy.ts::proactiveDelayMs`가 backoff 도출하는 바로 그 신호) 재사용**. gate=`QUANTA_RATELIMIT_NOTICE`(DEFAULT-OFF, knob `ratelimit-notice`), OFF면 port 미설치→`stdout.ts:151` 빈 case byte-identical. malformed/partial(NaN/neg/missing)은 슬라이스 parser가 graceful-skip→무페인트; throwing statusBar는 try/catch로 swallow(tee isolation). 배선: `cli-feature-config.ts`(`ratelimitNotice.enabled`)+`repl/factories/turn-indicator.ts`(TeeStream 합류, indicator gate와 독립). 테스트 26: `ratelimit-notice-hellgate`(16)+`ratelimit-notice-wire-hellgate`(5)+`ratelimit-notice-knob`(3)+`ratelimit-snapshot-stdout-ignore-hellgate`(2). fc=`ratelimit-snapshot-render`. **✅ F3 분리 완료(round-2 발견→해결)**: `session-bootstrap`이 snapshot store+header-capture를 `QUANTA_RATELIMIT_NOTICE OR QUANTA_RATELIMIT_PROACTIVE`일 때 생성(공유 SSOT predicate `ratelimitNoticeWanted`, runtimeConfig+CLI 한 정의), `stream-consume`이 reached-window를 양쪽 모드서 emit하되 `sleep`은 PROACTIVE만 → **`QUANTA_RATELIMIT_NOTICE` 단독으로 capture+render 완결, 요청 지연 없음**. `delta-ratelimit-reachability-hellgate`에 NOTICE-only emit+no-sleep 케이스 lock. (남은 §23.2 quota-exhausted graceful UX는 error-path 한정, deferred.)

### 23.2 [PARTIAL] quota-exhausted graceful UX
- **경쟁사**: Claude typed reset-time 메시지.
- **quanta**: error-path만(`src/agent/error-routing/types.ts:21` `usageLimitExceeded — Fatal` → abort), "소진, HH:MM 리셋" 표시 없음. **ROI 중.**

### 23.3 [LANDED jun-7 Wave R] release-notes / version 표시
- **경쟁사**: Claude `/release-notes`+`What's new` 패널+`VERSION`.
- **quanta**: `/release-notes`/`/version`/`/changelog` 없음(grep 0), `QUANTA_VERSION="0"` 하드코딩 placeholder(`session-cmd.ts:92`) 미surface, `--version` 없음. **ROI 저-중(`/version`은 cheap).**

### 23.4 [LANDED jun-7 Wave R] `/bug` feedback (first-run welcome는 deferred)
- **경쟁사**: Claude `/bug`+Submit Feedback flow; first-run welcome/trust dialog.
- **quanta**: `/bug`/`/feedback` 없음(grep 0); first-run/welcome/banner 없음. **ROI 저**(quanta는 hosted product 아니라 `/bug`→GitHub issue URL이 cheap analog).

### 23.5 [LANDED jun-7 Wave R] per-model cost breakdown (unified `/config`는 deferred)
- **경쟁사**: Claude "Usage by model"(model별 input/output/cacheRead/$); `/config`(×93).
- **quanta**: `src/apps/cli/cost-panel.ts:42` single `model`(last-writer) — heterogeneous-model 세션이 마지막 model로 collapse. `/config` 없음(`/knobs`/`/color`/`/profile` piecemeal). **ROI 중(`Map<model,bucket>`)/저(`/config`).**

> ✅ NOT-GAP: `/cost`(total+duration+turns+tokens 패리티) · `/usage` · `/context`(segmented window%) · `/help`(+tab-completion) · `/status`/`/login`/`/logout` · `/doctor` · `/init`(system skill, 정정).

---

## 24. Event-protocol / Turn-lifecycle / Item-taxonomy (구조적 갭)

> **STATUS (verified jun-07)**: §24.1 item lifecycle 🔲 **STILL OPEN**(`ThreadItem`/`ResponseItem`/`item.started` grep=0) · §24.2 typed file_change/mcp_tool_call/web_search item 🔲 OPEN · §24.3 collab-agent spawn/interaction lifecycle event 🔲 **STILL OPEN**(`collab_agent`/`agent_spawn`/`thread_spawn` grep=0 — subagent 런타임+broker는 존재하나 observability event 미방출) · §24.4 incremental-replay 커맨드 PARTIAL · §24.5 minor PARTIAL. **§24 전체 미진척(구조적, 신규 item-tier 필요).**

> **구조적 root cause**: quanta는 Codex의 `thread → turn → **item**` 3-tier 중 **item tier가 통째로 없음**. quanta는 `session → turn → {tool.*, output.delta}`로 message/reasoning을 item으로 모델링 안함. quanta event 어휘는 2개 병렬(host-facing `SessionEvent` 14종 `protocol/session/events.ts` + loop-facing `AgentEvent`/StreamEvent ~30종 `stream/types.ts`)인데 둘 다 풍부하나 layer가 다름. Codex는 94 typed `*Notification`로 단일화.

### 24.1 [NEW-GAP] 통일 item lifecycle(`item.started/updated/completed`) 없음 — HIGH-ROI
- **경쟁사**: Codex `ItemStartedNotification`/`ItemUpdated`/`ItemCompletedNotification` — 모든 대화 artifact가 typed `ThreadItem`(closed detail union)에 uniform lifecycle.
- **quanta**: `grep ResponseItem|ThreadItem|ConversationItem` over protocol/stream/llm = 0. tool call만 started/completed pair(`events.ts:90,100`), message/reasoning은 lifecycle envelope 없음.
- **델타**: surface가 generic "item card" 타임라인 렌더 불가 — event family마다 bespoke. **Codex resumable transcript UI + `ThreadRead`/`TurnsItemsList` replay의 척추. ROI 고.**

### 24.2 [NEW-GAP] typed `file_change`/`mcp_tool_call`/`web_search` item 없음
- **경쟁사**: Codex `FileChangeItem`/`McpToolCallItem`/`WebSearchItem` first-class structured item → UI가 diff/query/results를 tool출력 파싱 없이 받음.
- **quanta**: generic `tool.completed` + `resultPreview` string(`events.ts:100`)만.
- **델타**: 구조화 replay + richer UI. **ROI 중-고.**

### 24.3 [NEW-GAP] collab-agent spawn/interaction/waiting lifecycle event 없음 — HIGH-ROI
- **경쟁사**: Codex `CollabAgentSpawnBegin/End`/`CollabAgentInteractionBegin/End`/`CollabAgentState`/`CollabAgentStatusEntry`/`ThreadSpawn`.
- **quanta**: 유일 멀티에이전트 event = `AgentEvent{type:"subagent_cancel"}`(`stream/types.ts:225`). spawn/interaction/waiting/resume event 0(`grep collab_agent|agent_spawn|thread_spawn` = 0).
- **델타**: host가 라이브 멀티에이전트 트리(어느 child가 spawn/running/waiting/resumed) 렌더 불가. **quanta는 subagent 런타임+coordination broker는 있는데 observability event만 미방출 = 순수 event-surface wiring. ROI 고.**

### 24.4 [PARTIAL] `events-after-seq` replay / paginated resume protocol
- **경쟁사**: Codex `ThreadResume`/`ThreadRead`/`TurnsItemsList` + `cursor` 페이지네이션 + `replay`.
- **quanta**: envelope는 replay-ready(`eventId`/`seq`/`revision`/`emittedAt` `events.ts:15`, codec가 finite seq/revision hard-validate) — 단 "seq N 이후 전부 달라" 커맨드 없음(`commands.ts`는 `session.transcript.replace` full-replace만). 재접속 client가 전체 transcript 교체 강제.
- **델타**: primitive(seq/revision)는 있고 incremental catch-up 커맨드만 없음. **daemon/web surface 재접속 핵심. ROI 중-고(groundwork 완성).**

### 24.5 [PARTIAL] 기타: `turn.aborted`≠`turn.failed` 분리(G1) · reasoning summary-part 분절(G4 `ReasoningSummaryPartAdded`) · `ProcessOutputDelta` 증분 stdout(G5) · `ThreadTokenUsageUpdated` 라이브 누적 usage push(G6) · `thread.compacted` session-push(G9, quanta는 loop-layer만) · guardian-review item event(G10).

> ✅ quanta WIN/패리티: stream-event delta 어휘(text/thinking/signature/tool delta + `stream_reset` fallback tombstone — Codex 무등가) · `recovery` self-heal taxonomy(backoff/compact/nudge/empty/malformed — **Codex보다 풍부**) · `turn_diff_updated`/`plan_updated`/`ratelimit_snapshot`/`response_queued` 패리티. realtime/audio event family(G8)는 quanta에 voice surface 없어 N/A(로드맵 시 high).

---

## 25. Orchestration / Self-correction / 버전-delta net-new

> **STATUS (verified jun-07)**: §25.1 선언적 multi-phase workflow 엔진 🔲 **STILL OPEN**(`workflowPhase`/`WorkflowEngine`/`QUANTA_WORKFLOW`/phase-engine grep=0 — budget/cap/subagent primitive는 있으나 phase-구조화 엔진 미존재) · §25.2 `reflect` mid-turn 도구 🔲 **STILL OPEN**(manifest `reflect`/`think` 도구 grep=0; `apply_patch`의 "self-correction hints"는 다른 것) · §25.3 SmartMode classifier-gate PARTIAL. **§25 전체 미진척.**

> prev-vs-current(Codex 2867→3390, Cursor 3.2→3.5, Claude 2.1.138→2.1.150) DIFF + Cursor `agent.v1` **832 타입 전수 스윕**(49 tool family)으로 23 카테고리 **밖**에서 잡은 net-new. 대부분 churn/already-landed였고 아래만 진짜 신규.

### 25.1 [NEW-GAP] Claude 선언적 multi-phase `workflow` 엔진 — HIGH-ROI(부품 다 있음)
- **경쟁사**: Claude CLI 2.1.150 신규(2.1.138 부재): `tengu_workflows_enabled`, `tengu_workflow_{launched,phase_completed,completed,saved}`, `tengu_workflow_{agent,budget}_cap_exceeded`, `workflow_{phase,agent,remote_agent,tool}`, `task_local_workflow_{resume,retry_agent,skip_agent}`, env `CLAUDE_CODE_WORKFLOWS`.
- **quanta**: budget-ledger/cap-enforcer/budget/ primitive + loop + skills 있으나 **phase-구조화 workflow 엔진 없음**(`grep workflow` src = prose/role-override만). named phase→per-phase agent→remote-agent dispatch + **phase-level agent-count·budget cap** + per-agent resume/retry/skip 없음.
- **델타**: composition layer(새 infra 아님) — budget/cap/subagent/remote 슬라이스에 깔끔 매핑. **portable(env-gated). ROI 고.**

### 25.2 [NEW-GAP] `reflect` mid-turn self-correction 도구 — ROI 중(cheap)
- **경쟁사**: Cursor `reflect_tool_call` — 모델호출 구조화 자기평가("(1문장) 제대로 가는지/이미 끝났는지 reflect, 아니면 접근 어떻게 갱신", "expensive, use sparingly").
- **quanta**: 모델호출 reflect/think 도구 없음(`surface/manifest.ts` grep 0). 최근접=passive closeout R1–R4 prose(`closeout-guard.ts:43`) — **seal-time 프롬프트지 mid-turn 모델호출 course-correction 도구 아님**.
- **델타**: 순수-prompt 도구, closeout(턴종료 nudge)과 구별되는 mid-turn re-plan. **ROI 중, 비용 저.**

### 25.3 [PARTIAL] Cursor SmartMode classifier-gate + agent self-escalate-after-deny
- **경쟁사**: Cursor `SmartModeClassifier{Args,Decision,Result}` + enum `SMART_MODE_CLASSIFIER_DECISION_{ALLOW,BLOCK}` + shadow mode(`smartModeClassifierShadowMode`); deny 후 모델이 `request_smart_mode_approval=true`+원본 block reason echo → classifier 재실행 없이 native approval card.
- **quanta**: `permission/classifier.ts` 2-stage classifier + HITLTier + denial→risk-seen→override state machine(ADR-0046)는 있으나 **(a) classifier-driven 자동 ALLOW/BLOCK + shadow-rollout** 과 **(b) agent-side self-escalate-after-deny 도구 param**(deny→one-click-approval, block reason 보존) 없음(`request_user_input`은 generic question).
- **델타**: §3 P4(auto-mode 유저룰 오버레이/tool-switch 우회)를 구체 mechanism으로 확장. **ROI 중.**

### 25.4 minor (완전성용, ROI 저)
- **collaboration-mode 런타임 preset**: Codex 0.135가 2-mode enum→`CollaborationMode` struct+`CollaborationModeList`(EXPERIMENTAL preset 나열)+`SetCollaborationMode` op(per-mode `developer_instructions` override, "model/effort/dev-instr보다 우선"). quanta `mode.ts`는 static default|plan. user-authored named mode preset이 갭(UX nicety, 새 capability 아님).
- **CSV `{column}` 보간**: Codex `spawn_agents_on_csv`가 instruction 템플릿에 `{column}`→row값 치환. quanta `batch-jobs`는 `(instruction, rowJson)` 별도전달(child가 instruction+row JSON append). 기능 동등, ergonomics만.
- **`AiAttribution`**(Cursor `ai_attribution_tool_call`): AI-vs-human authorship 추적. quanta grep 0. telemetry, 정확성 무관.
- **`Chronicle`/`RecordScreen`**(Codex skill + Cursor `RecordScreenToolCall`): rolling 화면녹화 buffer로 모호성 해소(passive 화면-history, computer-use=active control과 다른 축). Tauri/desktop-only.
- **config `[notice]`/`[features]` dismissible-flag**(don't-show-again 영속) + `session_meta.source` — §12 P7(중앙config) 하위로 fold.

> ✅ 버전-delta 검증: Codex `collaboration_mode`/`unified_exec`/`code_mode`/`reviewer`/`bypass_hook_trust`/`connectors`/`computer_use`는 **0.133-cli(prev에 이미 존재)에 있음 = this-version 신규 아님**(false-delta 회피). Codex 0.135 신규 rs crate `goal`/`memories`/`hook_runtime`/`exec_policy`는 quanta에 **already-landed**(objective는 successCriteria/blockers/nextActions로 **superset**). Cursor 832타입 중 나머지는 desktop-cloud-only 또는 covered envelope/streaming.

---

## 26. 나이브-구현 / 깊이 결함 (있는데 얕게 구현 + 이전 "강점" 과대평가 정정)

> "없는 기능"이 아니라 **quanta가 가진 기능의 구현이 경쟁사보다 얕거나 실제로 틀린** 것. side-by-side 알고리즘 대조(5바퀴, Codex/Cursor/Claude 전부). 🔴=실제버그/silent-corruption, 🟠=과대평가정정, 🟢=확인결과 나이브 아님(정정).

### 26.1 ✅ **LANDED (verified jun-07, 2nd pass wired)** — tree-sitter syntactic chunking 프로덕션 배선 완료 (HIGH-ROI)
> **STATUS FLIP → LANDED (jun-07 2nd pass)**: 1차 재검증서 미배선 확인된 것을 **`startIndexer`에 parser 주입으로 배선** — `src/runner/assemble/search-pipeline.ts:228` `...(runtimeConfig().syntaxChunk ? { parser: createTreeSitterParser() } : {})`. 이제 `QUANTA_SYNTAX_CHUNK` ON ⇒ live 인덱스가 `chunkFileSyntactic`(AST-boundary, 함수 mid-body 안쪼갬) 사용, OFF ⇒ parser 미생성·WASM 미로드·line-window byte-identical. `createTreeSitterParser`는 lazy(첫 parse까지 grammar 미로드)라 knob-ON 구성 비용 0. 검증: search-pipeline tsc0/biome0, syntax-chunk+retrieval 518/0. (이전 OPEN 증거는 정직하게 보존 ↓)
> **(1차 OPEN 증거, 보존)**: 배선 전엔 `search-pipeline.ts:216` `createDefaultIndexer({scanner, upsert})`가 `parser` 안 넘겨 `createTreeSitterParser` non-test 호출자 0 → knob 무관 line-window fallback이었음. default-scanner의 `parser?` opt(`indexer/default-scanner.ts:54,81-91`)는 준비돼 있었고, 어려운 부분(parser+chunker+WASM+hellgate) 다 완성돼 있어 ~2줄 배선만 남았던 것.
- **증거**: `src/retrieval/indexer/chunker-syntactic.ts`(AST-boundary chunker, 함수 mid-body 안쪼갬)+`code-parser/tree-sitter.ts`(실 web-tree-sitter WASM)는 **존재**하나, 프로덕션 wire `src/runner/assemble/search-pipeline.ts:216`이 `createDefaultIndexer({scanner,upsert})` 호출 시 **`parser` 안 넘김** → `opts.parser` 항상 undefined → `QUANTA_SYNTAX_CHUNK` **무관하게** 고정 50줄 윈도우/20줄 overlap fallback. `createTreeSitterParser` non-test 호출자 0.
- **정정**: [[jun-07-gap-other-agent-audit]]·메모리의 "retrieval 강함(tree-sitter chunking)" 라벨은 **shipped 기준 과대평가**. 라이브 인덱스는 fixed-window. 70줄 함수(30~100)가 두 청크로 쪼개져 tail 매치 시 시그니처 없는 mid-body 청크 반환.
- **fix**: `startIndexer`서 `createTreeSitterParser()` 생성+전달 ~2줄. 어려운 부분(parser+chunker+hellgate) 완성됨. **ROI 고.**

### 26.2 🟠 OVERCLAIM — 기본 embedder가 FNV-hash bag-of-words (semantic 아님)
- **증거**: `src/runner/assemble/search-index-backend.ts:94` `hashEmbed` = 64-dim FNV-1a 토큰해시 L2정규화. `QUANTA_EMBED_PROVIDER` unset 시 기본. synonym(delete/remove, auth/login)이 무관 버킷 → cosine~0. **out-of-box "semantic search"가 semantic 아님**(keyword-overlap proxy). 64-dim은 대형 코퍼스서 충돌多.
- **정정**: 실 embedder(openai/voyage/cohere/ollama)는 `QUANTA_EMBED_PROVIDER`로 배선 가능하나 **기본값이 hash**. zero-dep fallback으론 합리적이나 "semantic"이라 부르면 안됨. **ROI 중**(기본 메시징/문서).

### 26.3 🟠 OVERCLAIM — "8 embedder"는 실제 4 real + 6 throwing-stub
- **증거**: `src/retrieval/embedders/` 8파일 중 `openai.ts`/`voyage.ts`만 실 fetch. `cohere/gemini/moonshot/nvidia/xai/zai.ts`는 전부 `throw RetrievalError("...not yet wired (ADR-0159 type-level stub)")`. (단 프로덕션은 *별개* `src/retrieval/engines/embedder/registry.ts` 사용 — 거긴 openai/voyage/cohere/ollama 4 real + headless stub.) 실 runnable provider = **4, not 8**.
- **정정**: 흡수 ledger가 stub을 패리티로 세지 말 것. catalog 정확성 이슈(런타임 결함 아님). **ROI 저.**

### 26.4 🔴 compaction 트리거가 authoritative API token 무시하고 chars/4 추정 사용 — ✅ **LANDED (verified jun-07)**
> **STATUS FLIP → LANDED (jun-07 "D5" 하드닝)**: `compaction.ts:63` `TokenBaseline` 인터페이스 신설(provider authoritative `usage.inputTokens` 앵커), `triggerTokenCount(messages, baseline)`가 직전 턴 authoritative count를 baseline+이후 추가분만 chars/4로 추정(`compaction.ts:110,583`). 루프 배선 확인: `loop/context-assembler.ts:220-262`가 `tokenBaselineBox` 스레딩+압축 후 stale 마킹, `compaction-wire.ts:191`이 `tokenBaseline` 전달. **chars/4 순수추정 → authoritative-anchored 추정으로 전환됨.**
- **증거**: `compactIfNeeded`가 `estimateTokens(input.messages)`=`Math.ceil(chars/4)`(`compaction.ts:56,444`)로 게이트. quanta는 provider authoritative count(`src/llm/live-usage/index.ts` `usage.inputTokens`)를 **이미 받지만 display(output_progress)에만 쓰고** 트리거엔 안먹임.
- **델타**: chars/4는 code/JSON/identifier-dense에서 **20~40% under-count** → 실제 150k가 ~115k로 추정돼 120k 게이트 통과 → 하드 `context_window_exceeded` → reactive PTL recovery(더 lossy). 이미지/PDF는 고정 char proxy(IMAGE=6000/DOC=12000)라 20장 PDF=1장 동일.
- **fix**: 직전 턴 authoritative `inputTokens`를 baseline+이후 추가분만 chars/4. live-usage가 이미 노출 — wiring. **ROI 중-고.** (Codex는 `total_token_usage` authoritative+delta만 추정. Claude는 실측 %full.)

### 26.5 🔴 compaction threshold 모델-블라인드 상수 `120_000` (P13 심화증거) — ✅ **LANDED (verified jun-07)** (= §15.1 / P13)
> **STATUS FLIP → LANDED (jun-07 "D4" 하드닝)**: `llm/provider-metadata.ts:97,119-131`에 model→`{contextWindow, maxOutput}` 테이블 신설(opus/sonnet 200k, sonnet-1m 1M, 등). `compaction.ts:197-199` `resolveModelWindow(model)`이 `threshold = window.contextWindow − window.maxOutput − COMPACTION_SAFETY_MARGIN` 도출. `context-assembler.ts:328` `max:0` 하드코딩 → `resolveModelWindow(activeModel)?.contextWindow ?? 0`으로 교체(known 모델은 실제 window 방출). `DEFAULT_THRESHOLD=120_000`은 **unknown-model fallback으로만** 잔존(byte-identical). **모델-블라인드 → 모델-비례 압축으로 전환됨.**
- **증거**: `compaction.ts:35` `DEFAULT_THRESHOLD=120_000`. 레포에 **model→context-window 테이블 전무**. 루프가 usage snapshot 방출 시 `max:0`("unknown window") 하드코딩(`loop/context-assembler.ts:287`).
- **델타**: 200k 모델서 120k 컴팩트 = **40% 윈도우 영구 미사용**+조기 요약비용. **1M 모델(Sonnet 1M beta)서 12% = 88% 버림**. 소형(32k) 모델선 120k 트리거 안돼 provider가 먼저 reject.
- **fix**: `Record<modelId,window>` + `threshold=window−outputReserve−margin` ~30줄. plumbing(usage-breakdown.max/status-line max) 이미 있고 `0` 먹는 중. **ROI 고**(Claude: `window(model)−reserve−13000`, override 경로까지. Codex: `model_context_window`+`model_auto_compact_token_limit` per-model catalog).

### 26.6 🔴 단일-PID kill이 프로세스 트리 orphan (HIGH, 클래식 버그) — ✅ **LANDED (verified jun-07)**
> **STATUS FLIP → LANDED (jun-07)**: 신규 `src/runtime/process-tree.ts`가 `ProcessTreeKiller`/`signalTree(pid, sig)` 제공(whole-tree reap). `guarded-spawn.ts:112-130` `escalatingKill(proc, killer?)`이 killer 주입 시 `pid>0` 가드 하에 트리킬, absent⇒legacy single-PID byte-identical. **모든 spawn site 배선됨**: `shell.ts:219` FOREGROUND_TREE_KILLER · `bash-bg-registry.ts:339` BG_TREE_KILLER · `sandbox.ts:222,377` SANDBOX_TREE_KILLER · `command-hooks/sandbox-exec.ts:84` HOOK_TREE_KILLER · pty-backend. **단일-PID orphan → 트리 전체 reap으로 전환됨.**
- **증거**: `src/runtime/guarded-spawn.ts:111,120` `escalatingKill`이 `proc.kill()`→`proc.kill("SIGKILL")` **직접 child PID만**. `shell.ts:186`/`bash-bg-registry.ts:115`/`pty-backend.ts:142` 전부 `detached`/process-group 없이 spawn.
- **델타**: `bash -lc "npm run dev"`→bash가 node fork→node가 vite worker fork. timeout/abort 시 **bash만 SIGTERM**, node+children은 init로 reparent돼 계속 실행(포트/CPU/락 점유). 모든 백그라운드/멀티프로세스 명령이 subtree 누수.
- **fix**: group leader spawn(`setsid` 래퍼)+negative pgid 시그널. `escalatingKill`+2 spawn site 국소. **ROI 고.** (Codex는 `process-wrap` crate `ProcessGroup`+`kill_on_drop`로 **그룹 전체** kill — "kill ... process group" 에러스트링. Cursor `cursor-proclist` 네이티브 process-tree.)

### 26.7 🔴 background-shell 출력버퍼 메모리 무제한 (OOM) — ✅ **LANDED (verified jun-07)**
> **STATUS FLIP → LANDED (jun-07)**: `runtime/bash-bg-registry.ts:63` `MAX_BG_BUFFER_BYTES=200_000` 신설 — per-handle stdout/stderr가 ring-trim 캡(`handle.stdout`이 `.value()`로 capped accumulator 노출, 헤더 주석: "`tail -f`/`yes` cannot OOM the agent"). underlying string이 더 이상 무한성장 안 함. **OOM 벡터 닫힘.**
- **증거**: `bash-bg-registry.ts:337,340` `handle.stdout += chunk`/`stderr += chunk` **per-handle 바이트캡 없음**. LRU(`MAX_BG_SHELLS=16`)는 shell *개수*만 제한, *크기* 아님. placeholder 스냅샷은 read-time 30k tail-cap이나 **underlying string은 무한 성장**.
- **델타**: `tail -f`/chatty server/`yes` 같은 background 스트림이 `handle.stdout` 무한증식→agent OOM. LRU는 newest라 안 evict.
- **fix**: drain 콜백서 `slice(-CAP)` ring-trim. **ROI 중.** (Codex `disable_output_cap`+`max_output_tokens` pragma=accumulator에 캡.)

### 26.8 🔴 CRLF가 fuzzy splice서 드롭 → mixed-EOL silent corruption (narrow) — ✅ **LANDED (verified jun-07)** (= §16.4)
> **STATUS FLIP → LANDED (jun-07 "D6")**: 신규 `src/tool/edit/eol.ts` (`detectEol` — CRLF strict-majority 판정, `EolStyle="\n"|"\r\n"`). `fuzzy.ts:32` `splitLines = s.split(/\r?\n/)` (EOL terminator 비교에서 제거), splice가 `applyWindows`서 `next.join(detectEol(source))`로 **파일의 검출된 EOL 재방출**(`fuzzy.ts:117,242`). 모델 needle LF/haystack CRLF여도 mixed-EOL 미발생. **silent corruption 닫힘.**
- **증거**: `src/tool/edit/fuzzy.ts:25` `splitLines=s.split("\n")`만. CRLF 파일서 haystack `"foo\r"` vs needle `"foo"`: exact rung 실패→whitespace-flex/anchored-trim의 `.trim()`이 `\r` 스트립해 **매치**→splice가 `\r` 없는 newString으로 교체→이웃 줄은 `\r` 유지=**mixed line-ending**.
- **델타**: CRLF 파일 한 블록 fuzzy 편집이 편집줄만 LF로 무음변환→diff 폭증/일부 툴체인선 실제 corruption. exact rung은 무사(byte-identical splice)라 needle이 whitespace-approx+CRLF일 때만 발동(모델은 LF 방출하므로 plausible).
- **fix**: splice 시 각 haystack 줄 `\r` 보존 or `/\r?\n/` split+detected EOL 재방출. hellgate 케이스. **ROI 중**(Windows-authored repo silent integrity). (Cursor `eolSequence` first-class param. quanta V4A applier는 올바름 — edit-tool fuzzy 경로만 버그.)

### 26.9 🔴 V4A `@@` context-header 파싱하나 무시 (false ambiguity, Codex 자기포맷 갭) — ✅ **LANDED (verified jun-07)**
> **STATUS FLIP → LANDED (jun-07)**: `patch/applier.ts:365-367` 신규 `resolveAnchorFloor(workLines, contextHeader)`가 `contextHeader`를 needle로 매치, `applier.ts:404` `locateBlock`이 그 floor 이후로 검색 scope. contextHeader가 더 이상 parser-only dead field 아님 — 모델의 `@@ class Foo` disambiguation을 실제 앵커로 소비. **false-ambiguity throw 제거됨.**
- **증거**: `src/patch/parser.ts:224` `hunk.contextHeader=header` 저장하나 `applyHunkInPlace`/`locateBlock`(`applier.ts:341`)가 **never 참조** — whole-file 스캔으로 위치. `contextHeader`는 parser/types에만 등장.
- **델타**: 모델이 `@@ class Foo`로 동일 메서드 바디 중 하나 disambiguate해도 quanta가 앵커 무시→whole-file 유니크니스 체크→`Ambiguous N matches` throw. fail-safe지만 모델의 올바른 disambiguation 무음폐기.
- **fix**: `locateBlock` 검색을 직전 `contextHeader` 매치 이후로 scope. `line_ranges` scoping primitive 이미 있음. **ROI 중.** (Codex `_codex-rs:5454` "Expected update hunk to start with @@ context marker" — 앵커로 jump. Cursor도 모델에 `@@` 사용 교육.)

### 26.10 🔴 read 토큰-aware 가드 + per-line truncation 없음 (§16.1 확인) — ✅ **LANDED (verified jun-07)** (= §16.1 / P14)
> **STATUS FLIP → LANDED (jun-07 "D8")**: `read/index.ts:56` `MAX_LINE_CHARS=2000` per-line char cap(Claude Read 패리티) + surrogate-safe truncation(`index.ts:78-79` `… (+N chars elided)` 마커, high/low surrogate pair 안쪼갬). 토큰-aware 가드: `read/index.ts:63` `OVERSIZED_NUDGE_TOKENS=25_000` — 파일 추정 토큰(chars/4) 초과 시 offset/limit/grep로 유도하는 non-blocking advisory PREPEND(refuse 아님, 워크플로 유지). 추가로 `read/outline.ts` outline 모드 존재(decl-level 요약 + `… (K more declarations elided)`). **per-line truncation + token-aware nudge 둘 다 closed.**
- **증거**: `src/tool/read/index.ts:53`이 `\n` split 후 줄단위 slice, per-line char cap 없음. 5MB minified 번들=1줄=limit에 1 카운트→200KB 외곽캡까지 통째 방출(읽을수없는 단일줄). 토큰-aware "이 파일 N토큰>한도, range로 읽어라" 가드도 없음(grep `maxReadTokens` 0).
- **델타**: `read dist/bundle.js`가 200KB 단일줄로 transcript 범람, 모델이 페이징 불가(offset/limit은 줄단위인데 전부 line 1). 단일 거대 tool_result는 compaction이 못 쪼갬(orphan-safe boundary)→giant-turn 막힘.
- **fix**: `renderReadOk`에 per-line char cap+`…(+N chars elided)` 마커(ipynb 패턴 이미 있음)+pre-read 토큰추정 nudge. **ROI 중.** (Claude `$_H` 에러클래스 `tokenCount`/`maxTokens` "instead of reading the whole file" — 토큰 초과 시 ranged read 강제.)

### 26.11 🟠 minor + dead-code (혼합 — PTY scrub LANDED, ANSI/dead-code 여전히 OPEN)
- **PTY env 미scrub**(security note) — ✅ **LANDED (verified jun-07 "D3")**: `host/runtime/pty-backend.ts:196` 신규 `buildPtyEnv`가 `runShell`과 동일 chokepoint로 child env scrub(default `inheritEnv:false` ⇒ `DEFAULT_ENV_ALLOWLIST`로 `*_API_KEY`/`*_TOKEN`/`*_SECRET` 드롭, `childEnv`). 헤더 주석 명시 "credential leak from the legacy `{...process.env, ...env}` full inherit". **누수 벡터 닫힘.**
- **ANSI/control-char 모델로 미strip**(§17.1 확인) — 🔲 **STILL OPEN (verified jun-07)**: `bash/index.ts:281` `formatRunBody`가 **여전히 `[r.stdout, r.stderr].join("\n")` verbatim** — stripAnsi 미적용(직접 읽음). `stripAnsi` 유틸은 `ui/ui-helpers.ts`에 존재하고 issue-hint extractor/stdout adapter서 쓰이나 **모델-대면 shell 출력 경로엔 미배선**. 순수함수 quick-win 그대로.
- **dead code `microcompact/compactor.ts`** — 🔲 **STILL OPEN (verified jun-07)**: `createMicroCompactor`(naive FIFO) **non-test 호출자 여전히 0**(`recovery-reason/types.ts`는 type-doc 참조뿐). 라이브 microcompaction은 orphan-safe `tool-result-evict`(`compaction-wire.ts:73` `microcompactToolResults` 배선됨). dead FIFO **삭제 권장** 유효.

### 26.12 🟢 확인결과 나이브 아님 (정정 — "고치지 마라")
- **retry/backoff**: full-jitter exponential(`retry.ts:210`), `.kind` discriminated(RETRYABLE vs FATAL, substring은 kind=unknown fallback만+FATAL override), `Retry-After` epoch/delta magnitude-band 정확(prior bug fixed). **Codex `responses_retry.rs` 패리티.**
- **rate-limit**: proactive backoff가 provider `remaining<=0`(empty bucket)에만 발동 — quanta-invented "80%" threshold **아님**, server-advertised reset 사용.
- **permission classifier**: `startsWith("rm")` 식 naive match **전무**(grep 0). auto-mode는 LLM-backed 2-stage, HARD_DENY는 정직히 "best-effort backstop, NOT sandbox" 라벨+`normalizeShellForDeny`로 obfuscation(`r""m`/`c\url`) 차단+ReDoS-bound, OS sandbox(ADR-0297)가 authoritative gate, `inferToolTier` fail-CLOSED. R7 hellgate 봉인.
- **prompt assembly**: cache-aware(`MAX_CACHE_BREAKPOINTS=4`=Anthropic 실캡), 순서 안정, empty collapse.
- **cost math**: provider-aware cache-read discount(Anthropic 0.1× additive / OpenAI 0.5× carve-out), costUsd NaN **null-proto 테이블로 fixed**, unknown→null.
- **edit 매처 코어**: 4-rung ladder(exact→whitespace-flex→anchored-trim→scored-candidate)+ambiguous는 fail-safe(first-match 안취함)+literal splice($& 안깨짐)+2-phase journaled rollback. **세 경쟁사보다 앞섬**(scored-candidate는 above-SOTA). `line_ranges` off-by-one **확인결과 없음**.
- **shell 나머지**: 출력 truncation head8k+tail4k+disk spill(ADR-0411), timeout SIGTERM→SIGKILL graceful(`KILL_GRACE_MS=2000`), streaming 증분(`RunShellEvent`), `runShell` env scrub. **나이브 아님.**

> **이번 바퀴 핵심**: quanta의 **알고리즘 코어(retry/classifier/edit-matcher/cost/compaction-strategy)는 나이브 아니라 오히려 우위**. 나이브함은 **측정·배선·트리거**에 집중.
> **VERIFIED jun-07 진척**: 🔴 6종 중 5종 **LANDED** — 26.4 authoritative-token ✅ · 26.5 window-table ✅ · 26.6 orphan-kill(tree-killer 전 site 배선) ✅ · 26.7 bg-buffer OOM ✅ · 26.8 CRLF ✅ · 26.9 V4A anchor ✅ · 26.10 read per-line+token-guard ✅ · 26.11 PTY env scrub ✅. **여전히 OPEN**: 26.1 tree-sitter 미배선(headline overclaim 그대로 — parser 미주입) · 26.2 hash-embed 기본 · 26.3 4-real-embedder · 26.11 ANSI-strip(shell 출력경로) · 26.11 microcompact FIFO dead-code 삭제. **남은 🔴 우선순위: 26.1 tree-sitter wire(유일하게 실-correctness 영향 남음) > 26.11 ANSI-strip.** "retrieval 강함" 라벨은 tree-sitter shipped 기준 여전히 부분 과대평가.

---

## 부록 — 검증 방법론 노트

- **"같은 이름 심볼 = covered" 함정**: 12바퀴 모두 이 패턴 확인. `subagent_fork`≠`fork_turns`, `Canvas{Register}`(실재 안함)≠`ShareCanvas`, `FAST_APPLY`(모델)≠patch-reemit, guardian reviewer≠per-action assessor.
- **"superset" 주장은 양쪽 필드리스트로만 증명**: plugin/skill 스키마는 `.strict()`라 더 엄격할 뿐 superset 아님 — 실제 경쟁사 아티팩트를 거부.
- **stale 전제 정정**: retrieval "in-flight tsc errors" = 거짓(232 에러 전부 test fixture, prod src clean). MCP OAuth "no live caller" = stale(jun-06 wired).
- **provider-specific는 N/A**: realtime/responses WebSocket = OpenAI 계정 전용, BYO-provider quanta엔 흡수 부적합.
- 각 항목 경쟁사 소스는 `.extracted_source/<corpus>/...`, quanta 소스는 repo `src/...` 절대경로 기준.
