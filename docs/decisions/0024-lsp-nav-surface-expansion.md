# ADR-0024: LSP nav surface 확장 (definition/references/hover/symbol/rename-preview)

- **상태**: Accepted
- **날짜**: 2026-05-20
- **관련**: RFC-0001 §3(슬라이스)·§6.2(도구), ADR-0009(LSP diagnostics), ADR-0011(SOTA++ 흡수), Codex `may-20-codex-lsp.md`

## 맥락

ADR-0009로 `LspPort.diagnostics`/`@/tool/diagnostics`만 노출했다. Codex
`may-20-codex-lsp.md` §5는 LSP RPC 25종을 use-frequency × signal-trust로
채점했고, 우리는 그 중 1개(`diagnostics`)만 가진 상태였다 — codex 카탈로그가
대표/조건부로 묶은 owner-tracing·rename-impact·large-file-orientation
usecase의 가속 surface가 부재했다. text/grep 우회로 동일 판단은 가능했으나
LSP가 가진 type/symbol-level 의미 정보를 받지 못해 큰 owner-tracing 작업이
필요 이상의 read/grep 라운드를 돌았다.

## 결정

`LspPort`를 8개 nav RPC로 확장한다 (signal-trust 6 이상의 코어):
`definition` / `references(includeDeclaration)` / `hover` / `typeDefinition` /
`implementation` / `documentSymbol` / `workspaceSymbol` / `prepareRename`.

각 메서드는 capability 부재(JSON-RPC `-32601`/`-32602` 또는 "not supported"
메시지)를 `null`로 surface하고, 빈 결과는 `[]`로 구분한다 — 호출자가
"unsupported"와 "no hits"를 구분하도록.

`@/tool/lsp_nav/` 새 슬라이스에 8개 tool 추가:
`lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_type_definition` /
`lsp_implementation` / `lsp_document_symbol` / `lsp_workspace_symbol` /
`lsp_rename_preview`. 모두 `isReadOnly=true`, `isConcurrencySafe=false`
(서버 세션은 단일 connection). 입력은 1-based human coords → 내부 0-based
NavPos 변환. 슬라이스 격리: `@/tool` ↛ `@/lsp` 유지하기 위해
`LspNavProvider`/`LspNavSession` 구조적 mirror 타입을 별도로 정의 (실 구현은
agent 슬라이스의 `lsp-bridge.ts`가 LspClient를 adaptToNavSession으로 forward).

CLI 노브 `QUANTA_LSP_TOOLS=full` — 기본 OFF. 미설정 시 `defaultTools`에 nav
도구 미포함 ⇒ 레지스트리 byte-identical. 진짜 LSP 서버 binary 부재 시
graceful no-op (`ok:false` 결과, never throw).

## 근거

- Codex 카탈로그가 LSP는 "accelerator지 truth source 아님"으로 명문 — 그 위
  trust 6+ 코어만 흡수, code-action/completion/signatureHelp 등 trust 3-5는
  의도적으로 제외.
- `LspClient`의 stdio/jsonrpc/timeout/didOpen-dedup 기존 인프라 재사용 →
  신규 npm dep 0, 신규 spawn 경로 0.
- 슬라이스 격리는 diagnostics와 동일 패턴: provider 주입 + 구조적 mirror
  타입 — biome 검증된 격리 유지.

## 대안

- **`rg`+source read만**: 기각 — 동일 판단이 가능하나 cross-file
  owner-tracing이 LSP보다 느리고 type-aware 작업(rename blast radius,
  override tracing)에 가속을 못 받음.
- **25개 RPC 전부 흡수**: 기각 — codex 자체 분류 trust 3-5 surface(codeAction
  /completion/signatureHelp/semanticTokens/foldingRange/callHierarchy/inlay)는
  ROI 무관 SOTA++ 기준에서도 truth가 약해 prompt가 잘못 신뢰할 위험.
- **defaultTools에 추가**: 기각 — model의 tool-call 분포 변경 → 기존 bench
  대비 byte-identical 깨짐. opt-in 노브로 한정.

## 결과·트레이드오프

- **얻은 것**: owner-tracing(`hover→definition→references`), rename impact
  preview(`prepareRename`), large-file orientation(`documentSymbol`), repo-wide
  owner search(`workspaceSymbol`) 가속. signal-trust 6-8의 의미 surface
  8종이 도구로 노출. LSP capability 부재(서버 미설치, 미지원 method)는
  `null`로 graceful — never throw, never hang.
- **비용**: tool surface +8 (`QUANTA_LSP_TOOLS=full`일 때만). 미설정 시
  registry byte-identical. 진짜 LSP server smoke은 본 환경에서 unprovable
  (Pyright/typescript-language-server 미설치) — fake-provider 단위/통합
  테스트 + structural compatibility 검증으로 충족.

## 한계 (LIMITATIONS)

- **(a) 진짜 LSP server smoke 미실증**: 본 환경 server binary 부재 →
  fake-provider 46 tool tests + 59 RPC unit tests + structural type-compatibility
  보증만 가짐. 실제 Pyright/TS-LS 통합 검증은 `tests/contract/` REQUIRE_CONTRACT
  토글 또는 user smoke에 위임.
- **(b) workspaceSymbol은 file 인자로 language 선택**: 한 workspace에 Python
  + TS가 공존하면 file 인자가 어느 server에 query할지 결정한다 — 호출자가
  의도적으로 file을 골라야 cross-language search 가능 (per-call open).
- **(c) `prepareRename`은 preview only**: `rename` 실 적용은 의도적 미흡수
  — 코드 변경은 `edit` 도구로 명시(safety boundary 명확).

## 불변식 영향

- **슬라이스 격리 유지**: `@/tool/lsp_nav/types.ts`는 `@/lsp` import 0;
  bridge가 agent 슬라이스에서 structural forward.
- **RFC/ADR 동기**: RFC §3·§6.2 갱신.
- **신규 npm dep 0**.
- **byte-identical default-OFF**: 미설정 시 registry/AgentConfig 동형 보장.
