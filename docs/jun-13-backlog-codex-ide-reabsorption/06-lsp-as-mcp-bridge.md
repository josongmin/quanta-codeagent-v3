# T06 — LSP-as-MCP 브릿지

**현황:** ✅ DONE (2026-06-13) · **ROI:** ★★ · **게이트:** `QUANTA_LSP_MCP`(default-OFF)

## ✅ 구현 요약 (재조정: 신규 도구 X, 브릿지 배선 O)
broad-grep 검증 결과 도구 3종은 **이미 존재**(false-gap): `lsp_references`/`lsp_workspace_symbol`(단수)/`lsp_document_symbol` 등 = `src/tool/lsp_nav` read-only 도구, `diagnostics`(실 도구명; manifest는 `lsp_diagnostics`로 별칭)는 **BASE 도구**라 reverse-MCP가 이미 노출 중(단 `nullDiagnosticsProvider`). **진짜 갭 = reverse-MCP 서버가 LSP를 레지스트리에 안 실음**(headless `assembleAgentConfig`는 lsp 노브/CLI surface를 안 탐).
- `src/apps/cli/mcp-server-setup.ts` `mergeLspBridgeTools`: `QUANTA_LSP_MCP` ON시 기존 read-only LSP 도구를 reverse-MCP 레지스트리에 **override-by-name 머지**(BASE `diagnostics`를 real provider로 업그레이드 + `lsp_*` nav 추가). mutating(`lsp_rename_apply`)은 `isReadOnly()` 필터로 제외 — `QUANTA_MCP_SERVER_EXPOSE` force-opt-in RCE 차단.
- knob-inventory `QUANTA_LSP_MCP`{group:mcp} 등록. manifest는 신규행 없이 `lsp_references` note에 브릿지 문서화(중복행=drift red). `tests/unit/apps/cli/lsp-mcp-bridge-hellgate.test.ts`(8테스트, fake-provider seam로 fresh-readback, red-on-injection 2건). cap=임의 count-cap 미도입(LspClient 8s timeout이 검증된 bound).

## 무엇 (코퍼스 증거)
Codex IDE(`chatgpt.useExperimentalLspMcpServer`)는 in-process MCP 서버 `vscode-codex-lsp-mcp-server`를 tmpdir에 띄워 **에디터의 언어지능을 MCP 툴 3종으로 CLI 에이전트에 노출**:
- `vscodeDiagnostics` — `vscode.languages.getDiagnostics()`
- `vscodeReferences` — symbol references
- `vscodeWorkspaceSymbols` — workspace symbol search

`chatgpt.showLspMcpCliArgs`로 standalone `codex` CLI가 이 IDE 언어지능에 attach하는 CLI args 복사.

## 왜 가져오나
CLI 에이전트가 **IDE 없이도** diagnostics/references/workspace-symbol 같은 진짜 코드 인텔리전스를 도구로 쓸 수 있게. quanta는 LSP 클라이언트는 있는데 그걸 MCP 툴로 노출하는 shim이 없어 에이전트가 직접 못 씀.

## quanta 현황 (코드 앵커)
- MCP 서버 모드: `src/mcp/server.ts` + `src/apps/cli/mcp-server-setup.ts`(`quanta mcp-server`, read-only whitelist, `QUANTA_MCP_SERVER=1`) — **있음**.
- LSP: `src/lsp/`(client 전용) — `src/lsp/adapters/base.ts`(textDocument/didOpen, references, rename), clangd/gopls/pyright/rust-analyzer/typescript 어댑터.
- **부재:** LSP client capability를 MCP 툴로 노출하는 브릿지. (quanta는 LSP **서버** 노릇도 안 함 — 단 이 티켓은 LSP를 MCP로 노출하는 것이지 LSP 서버화가 아님.)

## 제안 접근
1. 기존 `src/lsp/` 클라이언트 위에 MCP 툴 3종 정의: `lsp_diagnostics`, `lsp_references`, `lsp_workspace_symbols`. 각 도구가 LSP adapter 호출 → 결과 환원.
2. `src/mcp/server.ts`의 whitelist에 추가(default-OFF, `QUANTA_LSP_MCP`).
3. 도구 manifest SSOT 등록([[tool-surface-ssot]]) + zero-unwired 풀배선.
4. (선택) CLI 에이전트 외부 attach용 args 헬퍼 — quanta가 mcp-server로 떠 있을 때 LSP 툴 노출.

## 함정
- LSP adapter는 비동기 init/워밍업 — 도구 호출이 LSP ready 전에 오면 graceful(empty or wait). 
- workspace-symbol은 대형 repo서 비쌈 — 결과 cap + timeout([[test-quality-culture-portable]] 강invariant: 무조건 단언 후 내로잉).
- 도구축(tool-surface manifest)과 기능축(fc) 별개 — manifest BASE/GATED에 정확히 등록(drift 가드).

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** **핵심.** 신규 MCP 툴 3종(`lsp_diagnostics`/`lsp_references`/`lsp_workspace_symbols`)을 `src/tool/surface/manifest.ts` **GATED**에 등록 — `gate`=env `QUANTA_LSP_MCP`(또는 `kind:"resource"`로 LSP-available 자가게이트), per-surface `default:"opt-in"`. **two-way drift guard**(`tests/unit/tool-surface-manifest-hellgate.test.ts`) 통과 필수(모든 등록 도구는 manifest 행 必, 역도 成立 — orphan/stale 행 = CI red). `src/mcp/server.ts` read-only whitelist에 추가.
- **CLI+Web:** 도구라 surface 무관 자동 — 에이전트 도구 호출은 양 surface 공통 도구 레지스트리서. 별도 UI/slash 불필요.
- **knob:** `QUANTA_LSP_MCP`(bool, default false) → knob-inventory `{group:"mcp", home:"runtime-config", readSite:"tool/surface/manifest.ts" gate}`. **단 도구 게이트는 manifest의 `gate.envKey`가 SSOT** — knob-inventory는 readSite 미러(orphan ratchet 충족). 두 곳 값 일치 라쳇.
- **config:** N/A — LSP adapter 설정은 기존 `src/lsp/` 재사용(clangd/gopls/pyright/rust-analyzer/typescript). 신규 config 키 금지.

## DoD
- LSP MCP 툴 3종 + manifest 등록; default-OFF.
- e2e: 실 LSP(typescript adapter)서 diagnostics/references 도구가 실제 결과 반환(실 effect 관찰, fresh-readback).
- tool-surface drift 가드 green.
- ≥3R 적대어딧(LSP not-ready race, 대형 workspace cap).
