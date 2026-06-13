# 구현 프롬프트 — T06: LSP-as-MCP 브릿지

## 미션
기존 `src/lsp/` 클라이언트 위에 MCP 툴 3종(`lsp_diagnostics`/`lsp_references`/`lsp_workspace_symbols`)을 정의해 CLI 에이전트가 IDE 없이 진짜 코드 인텔리전스를 도구로 쓰게 한다. manifest GATED 등록 + two-way drift guard 통과. default-OFF.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/06-lsp-as-mcp-bridge.md` 정독. 통합 `00-index.md §8`. [[tool-surface-ssot]].

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. 실 LSP(typescript adapter)서 실효과 관찰(무조건단언 후 내로잉).
2. **핵심 로직 TDD + 구조적 구현**: LSP adapter 호출→MCP 툴 환원. manifest 등록.
3. **적대적 어딧 ≥3R**: LSP not-ready race, 대형 workspace cap/timeout, tool-surface drift.
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** references: 게이트 ON에서 에이전트가 `lsp_references` 호출 → 실 typescript LSP가 심볼 사용처 반환(fresh-readback: 실제 파일/라인 단언).
- **UC2** diagnostics: `lsp_diagnostics` → 타입에러 있는 파일서 진단 반환.
- **UC3** workspace symbols: `lsp_workspace_symbols` → 심볼 검색 결과(대형 repo서 cap 적용).
- **UC4** default-OFF: 게이트 OFF면 도구 미등록(manifest GATED) — 도구 목록에 없음.
- **UC5** drift guard: 등록 도구 3종이 `tool-surface-manifest-hellgate.test.ts` 양방향 일치(누락/stale 행 = red).
- **UC6** LSP not-ready: adapter 워밍업 전 호출 시 graceful(empty/wait), 크래시 안 함.

## 코드 앵커 (실측)
- MCP 서버: `src/mcp/server.ts` + `src/apps/cli/mcp-server-setup.ts`(`QUANTA_MCP_SERVER`).
- LSP client: `src/lsp/adapters/base.ts`(references/diagnostics/rename), adapters(typescript 등).
- manifest: `src/tool/surface/manifest.ts`(GATED), guard `tests/unit/tool-surface-manifest-hellgate.test.ts`.

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: **핵심** — manifest GATED 3행, gate=`QUANTA_LSP_MCP`(또는 resource 자가게이트), default `opt-in`. `src/mcp/server.ts` read-only whitelist 추가.
- **knob**: `QUANTA_LSP_MCP` → knob-inventory `{group:"mcp",home:"runtime-config"}`. **manifest gate.envKey가 SSOT, knob-inventory는 readSite 미러**(두 값 일치 라쳇).
- **CLI+Web**: 도구라 surface-무관 자동(공통 레지스트리). **config**: N/A(기존 src/lsp 재사용).

## 규율
- workspace-symbol 결과 cap+timeout(휴리스틱 임계 금지, 검증된 값). drift guard green 필수. zero-unwired 풀배선. claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
