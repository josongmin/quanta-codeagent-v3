# Tickets 16–24 — NEW cluster (진짜 없음 → 신규 구현)

**Date:** 2026-06-08
**Source:** 5병렬 deep-audit(jun-08). 각 갭 current-state(file:line, 재사용할 seam)+design(default-OFF)+files+TDD+ROI. 전부 default-OFF byte-identical · TDD red-first · 신규도구는 manifest GATED.

---

## 16 — §11.1 `/init` 코드베이스 온보딩 doc 생성  · ROI 중
**Current:** `runner/assemble/repo-map-scan.ts:73` `makeRepoMapScan`(rg --files 집계, injection seam) · `agent/repo-rules.ts:103` `loadRepoRules`(AGENTS.md/CLAUDE.md 수집) · `slash/registry-surface.ts:90` cmd 패턴.
**Design:** `/init [--force]` → repo-map 스캔 + build/test 명령 감지(package.json scripts→Makefile) → CLAUDE.md 생성(섹션: Quick Start/Directory/Key Files/Conventions). 존재시 confirm(--force 스킵), 유저편집 섹션 보존. 순수 `scaffoldClaudeMd(cwd, repoMap?, buildCmd?)` 렌더러.
**Files:** `slash/registry-surface.ts`(initCmd) · NEW `slash/init-scaffold.ts`(pure). **TDD:** scaffold 결정적 출력 · repo-map mock+truncation · 존재시 confirm/--force · 미배선 degrade.
**Risks:** build 휴리스틱 오탐(보수적 default+유저편집) · 대형repo 성능(maxChars truncation).

## 17 — §11.2 `/agents` 라이브 fleet 뷰  · ROI 중-고 (observability 북극성)
**Current:** `subagent/registry.ts:61` `TaskRegistry`(running/completed/failed/stopped + id/agentType/startedAt/result, `list()`/`getById()`, LRU 256). `repl/slash-surface.ts:55` ReplSlashCtx(slot 추가지점).
**Design:** `/agents [--format table|json|tree]` → `taskRegistry.list()` 읽어 status 테이블(ID/Status색상/Type/Age/Result). 순수 `renderAgentFleet(tasks, format, now)`. 미래 `--watch`.
**Files:** `slash/registry-surface.ts`(agentsCmd) · `repl/slash-surface.ts`(+taskRegistry?) · `repl/surface-compose`(wire) · NEW render helper. **TDD:** render 순수(no clock) · 포맷 3종 · 미배선 degrade.
**Risks:** LRU 256(doc+`--all`) · TTY ANSI 감지 · result 큰값(50char truncate).

## 18 — §11.4 Ctrl+B 실행작업 백그라운드 이동  · ROI 중 · **HARD (phased)**
**Current:** `keybindings/types.ts:19` KEY_ACTIONS(closed enum) · `repl/turn-cancel-install.ts` Esc-Esc/Ctrl+C FSM · `repl/session-loop.ts` `while{ runOneTurn() }`(턴=monolithic await) · tool-layer `run_in_background`.
**핵심난점:** 턴이 단일 `await runOneTurn()` = 트랜잭션. Ctrl+B는 턴을 안 기다리고 detach+프롬프트 복귀+나중 결과수거.
**Design:** NEW `BackgroundTurnPortal`(detached 턴 관리: taskId/state/bufferedOutput ring buffer). keybinding `move-to-background`+ctrl+b. 턴중 Ctrl+B→`portal.detach(signal, outcome)`→등록+프롬프트복귀. `/background list|reattach|cancel`.
**Files:** `keybindings/types.ts`+`defaults.ts` · NEW `repl/background-turn-portal.ts` · `turn-runner.ts`(onMovedToBackground cb) · `session-loop.ts` · `raw-line-reader`(action) · `slash`(background cmd). **TDD(brutal):** portal(register/detach/list/reattach/cancel) · turn-runner+portal mid-turn detach · raw-reader+loop(Ctrl+B→프롬프트 복귀) · e2e stub-LLM · 미배선 Ctrl+B no-op.
**Risks(치명):** 턴 atomicity(detached=volatile, reattach까지 미persist) · output overflow(50MB cap+disk-spill 미래) · signal cleanup(detached AbortController가 턴보다 오래, session close가 전부 cancel) · weave 충돌(weave on이면 detach 비활성) · history 일관성(close시 "N pending" 경고). **권장: V1(keybinding+portal+read-only reattach)→V2(persist)→V3(weave).**

## 19 — §22.3 reverse-MCP (quanta가 MCP 서버)  · ROI 고
**Current:** quanta CLIENT-only(`mcp/client.ts`가 외부 서버 연결+inbound sampling/roots/elicitation 핸들만). `tools/list`/`tools/call` **서버측 0**. 재사용: `mcp/jsonrpc.ts`(encode+LineReader+envelope validate, direction-agnostic) · `transports/`(stdio/http-sse 대칭) · `tool/surface/manifest.ts`(노출할 도구 SSOT) · permission-store+jail(같은 게이트 재적용).
**Design(default-OFF, gated):** NEW `mcp/server.ts` `McpServer`(client.dispatch 미러: initialize/tools/list/tools/call) — `tools/list`는 registry서 **read-only subset만**(default), `tools/call`은 **agent와 같은 permission+jail+redaction 게이트** 통과. 전송=stdio(embedded). gate `QUANTA_MCP_SERVER`. **보안 핵심:** 외부 클라가 quanta `bash` 호출=RCE → default read-only 화이트리스트+per-tool 명시 opt-in.
**Files:** NEW `mcp/server.ts`+`server-builder.ts` · `mcp/index.ts`(export) · NEW `apps/cli/mcp-server-setup.ts`(`quanta mcp-server`) · `manifest.ts`(`mcp_server` meta gate). **TDD:** initialize nego · tools/list(read-only만, pagination) · tools/call(permission 게이트, bash 기본 deny, redaction, result cap) · error(-32601/-32602/-32603) · 실 SDK 클라 통합.
**Risks:** RCE(default read-only+jail 재적용) · 토큰 flood(sampling cap 재사용) · result 무한(MAX_RESULT_CHARS 재사용). **2-3일.**

## 20 — §1.3 MCP resources templates/completion  · ROI 저-중
**Current:** `mcp/resources/port.ts:27` `McpResource`(uri/name/mime/desc, 템플릿 없음) · `codec.ts:46` `parseResourceList`(flat). `completion/complete` 0.
**Design:** `resources/templates/list`(파라미터화 URI `file://{folder}/{name}`) + `completion/complete` inbound(prompt/resource 인자 자동완성). `McpResourceTemplate{uri,name,uriTemplate}`+`parseResourceTemplateList`+client `listResourceTemplates()`+NEW `mcp/completion/` slice. default-OFF(서버가 capability 선언시만).
**Files:** `resources/port.ts`+`codec.ts`+`inbound-router.ts` · `client.ts`(listResourceTemplates) · NEW `mcp/completion/`. **TDD:** fake transport 템플릿 반환+completion 호출 shape · malformed 템플릿 · empty completion.

## 21 — §1.5 MCP Tasks ttl/pollInterval/related-task  · ROI 저-중
**Current:** `mcp/tasks/types.ts:18` `McpTaskInfo`(taskId/state/title/progress만) · `poller.ts:34` 고정 `DEFAULT_INTERVAL_MS=200`.
**Design:** `McpTaskInfo`에 `ttl?`(만료→stop+timeout)/`pollInterval?`(서버 cadence 힌트)/`relatedTaskIds?` 추가 + `parseTaskInfo` defensive 파싱 + `pollTask`가 응답의 pollInterval로 cadence 구동 + TTL 만료체크. default-OFF(optional 필드).
**Files:** `tasks/types.ts`+`poller.ts`+codec parser · `tool/mcp_tasks` 렌더. **TDD:** pollInterval=50→50ms sleep · ttl=500 만료 · related 링크 carry · neg/NaN/circular edge.

## 22 — §1.4 MCP elicitation `url` 변종  · ROI 저(니치)
**Current:** `elicitation/schemas.ts:25` 7변종(string/number/integer/bool/enum/multi/single) · `inbound-router.ts:130` switch · `default-cli-prompter.ts` 7 prompt. url 0.
**Design:** `urlRequestSchema{prompt,title?,url(RFC3986)}` 8번째 변종 + router `case "url"` + `promptUrl()`(CLI: "confirm open? y/n"→`open`/`xdg-open`, headless→`{ok:false,"headless-denied"}`).
**Files:** `schemas.ts`+`port.ts`+`inbound-router.ts`+`default-cli-prompter.ts`+`headless-rejecter.ts`. **TDD:** spec `type:url` 라우팅 · CLI mock open y/n · headless 즉시 decline · malformed url/abort.

## 23 — LLM: §9.4 reasoning summary:"auto" + §9.5 verbosity/xhigh  · ROI 저 (묶음)
**Current:** `openai-responses-wire.ts:343` request에 `reasoning:{effort}`만(summary 미요청; READ path는 이미 summary 보존). `:285` effort normalizer=minimal|low|medium|high(xhigh 없음). verbosity 0.
**Design:** ① request `reasoning`에 `summary:"auto"` 추가(knob `QUANTA_REASONING_SUMMARY`) ② effort enum에 `xhigh` + `verbosity:low|medium|high` 필드(knob `QUANTA_REASONING_VERBOSITY`). factory→adapter→stream prepare→wire 4-seam threading. default-OFF(knob absent⇒body 불변).
**Files:** `openai-responses-wire.ts`(normalizer+builder) · `factory.ts`(resolve) · `adapters/openai-responses.ts` · `responses-stream.ts`. **TDD:** buildResponsesBody가 summary/verbosity emit · normalizer xhigh 수용·invalid→undefined · e2e knob on streaming.

## 24 — browser: §6.2 tabs / §6.3 bounding_box / §6.4 highlight  · ROI 중 (묶음)
**Current:** `tool/browser/index.ts` 16도구 전부 단일 `BrowserSession`(1 page). `browser/cdp-adapter.ts:83` `SessionState`(proc+CDP session+refMap) = driver seam. mouse_click_xy(384)는 좌표클릭 있는데 bounds 얻을 길 없음.
**Design(각 default-OFF GATED):** ① **tabs** — `BrowserPort`에 newTab/switchTab/closeTab/listTabs(CDP `Target.createTarget`/`closeTarget`, SessionState에 per-tab refMap) + `browser_tab_*` 도구. ② **bounding_box** — `getBoundingBox(ref)`(CDP `DOM.getBoxModel` or `getBoundingClientRect`→{x,y,w,h,visible}) + `browser_element_bounds` 도구. ③ **highlight** — `highlight(ref, {color,duration})`(in-page DOM overlay JS, auto-remove) + `browser_highlight` 도구(read-only, cosmetic).
**Files:** `browser/types.ts`(TabInfo/BoundingBox/HighlightOpts) · `browser/port.ts`(메서드) · `browser/cdp-adapter.ts`(구현) · `tool/browser/index.ts`+`schemas.ts`(도구) + manifest GATED. **TDD:** cdp-adapter fake transport(tab state/box 추출/overlay 주입) · 통합(navigate→tab→switch→click 올바른 tab) · multi-tab state machine hellgate. gates `QUANTA_BROWSER_TABS`/`_BOUNDS`/`_HIGHLIGHT`.
**Risks:** tab switch시 ref 무효화(snapshot이 변경 ref 알림) — tabs가 제일 복잡(state refactor).

---

## 시퀀싱 (ROI×난이도)
**Phase 1(싼 LLM):** 23(summary/verbosity) — 4-seam threading, 신규 state 0.
**Phase 2(고 ROI):** 19 reverse-MCP(seam 100% 재사용, 보안 default read-only) · 17 /agents(observability 북극성, TaskRegistry 재사용).
**Phase 3(browser):** 24 §6.3 bbox+§6.4 highlight(driver seam 재사용, thin) → §6.2 tabs(state refactor).
**Phase 4(나머지):** 16 /init · 20/21 MCP templates/Tasks · 22 url(니치).
**별도(가장 어려움):** 18 Ctrl+B background(턴 lifecycle 수술 — V1부터 phased, prototype-in-isolation 먼저).
