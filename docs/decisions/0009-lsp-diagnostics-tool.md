# ADR-0009: LSP를 `diagnostics` 도구로 에이전트에 노출

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §3.1(슬라이스 격리), §3.2(lsp 슬라이스), §6.2(Tool 인터페이스), §8(Phase 1.5 "LSP 진단 도구로 노출"), §9.2(슬라이스 결선 = ADR 트리거), ADR-0001(Biome 슬라이스 격리)

## 결정

`lsp/` 슬라이스(pyright + typescript 어댑터, `LspPort`)를 에이전트가
호출할 수 있는 단일 `diagnostics` 도구로 노출한다. 결선은
`src/agent/lsp-bridge.ts`가 담당한다: 파일 경로를 입력으로 받아
적절한 `LspPort` 구현을 골라 `start → diagnostics(filePath) → stop`
생명주기를 돌리고, 발행된 `Diagnostic[]`을 `ToolResult` 텍스트로
직렬화한다. 별도 "lint"/"typecheck" 도구를 추가하지 않고 진단 1개
도구로 통일한다 — 도구 알파벳을 최소로 유지(RFC §1.2)하고, 모델이
편집 후 검증 단계(ADR-0004 강화 프롬프트)에서 일관되게 호출하게 한다.

슬라이스 격리는 유지: `@/tool`은 `@/lsp`를 import하지 않는다(Biome
override 강제, ADR-0001). LSP 결선은 조립자인 `@/agent`에만 거주하며
(`lsp-bridge.ts`가 유일 교차 슬라이스 importer), 도구는 `@/agent`가
레지스트리에 주입한다. `@/lsp`는 어느 슬라이스도 import하지 않는다.

## 배경

RFC §3.2/§8은 LSP를 "풀(pyright + typescript), 진단 도구로 노출"로
명시했으나 실제로는 어댑터만 존재하고 에이전트에서 도달 불가능한
고립 슬라이스였다. 모델이 변경 후 타입/문법 회귀를 스스로 확인할
경로가 없어 SWE-bench급 다중파일 자율 작업에서 검증 빵꾸였다.

## 근거

- LSP 진단은 "편집 → 검증" 루프의 핵심 신호. 도구로 노출해야 모델이
  ReAct 안에서 직접 소비할 수 있다(별도 워크플로우 단계 불요 — §1.2).
- 단일 `diagnostics` 도구: 언어 판별·서버 생명주기를 브리지가 흡수해
  모델은 경로만 넘긴다. closed-alphabet 강박 회피(§1.2)와 정합.
- 결선을 `@/agent`에 둠으로써 Biome override 무수정, RFC §3.1 의존성
  방향(`@/tool ↛ @/lsp`) 보존 — ADR-0008의 `EmbedderPort` 격리 패턴과
  동형(지능/결선은 조립자, 슬라이스는 순수).
- 슬라이스 결선은 RFC §9.2 "슬라이스 결선" ADR 트리거에 해당.

## 트레이드오프

- **얻은 것**: 모델이 편집 후 진단을 자율 호출 → 회귀 조기 발견,
  SWE-bench 자율성 향상. 격리·도구 알파벳 무손상.
- **잃은 것 / 비용**: 서버 spawn 지연(턴당 start/stop 비용 — 호출
  빈도가 낮아 허용), 언어서버 부재 환경에서의 graceful degrade 필요
  (브리지가 명확한 오류 텍스트로 표면화, 세션은 깨지 않음). 실
  언어서버 경로는 결정론 단위 게이트가 아닌 contract 티어(§10.3)
  검증 대상.
