# ADR-0007: MCP 클라이언트를 신규 슬라이스로 추가하고 agent에서 브리지

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §3.1(슬라이스 격리·의존성 방향), §3.2(슬라이스 목록), §9.2(슬라이스 추가 = ADR 트리거), §13 Q5(MCP 지원 Phase 미정), ADR-0001(Biome 경계 강제)

## 결정

최상위 슬라이스 `mcp`를 신설한다. stdio로 **개행 구분(newline-delimited)
JSON-RPC 2.0**을 말하는 MCP 클라이언트다(`McpClient`, `LineReader`,
`encodeMessage`). public API는 `McpClient`/`McpError`/`McpServerConfig`/
`McpToolDef`/`McpCallResult`만 노출하고 프레이밍 내부(`LineReader`, 코덱,
`jsonrpc.ts`)는 슬라이스 사적으로 둔다. MCP 도구를 우리 `Tool` 인터페이스로
변환하는 어댑터(`mcpToolToTool`, `loadMcpTools`)는 `@/tool` 안이 아니라
`src/agent/mcp-bridge.ts`에 둔다 — 슬라이스 격리상 `@/tool`→`@/mcp` import가
금지이고, `@/agent`만 모든 슬라이스를 조립할 수 있기 때문이다. CLI가 MCP
설정을 받을 때만 `loadMcpTools`가 `defaultTools` 옆에 병합된다. RFC §13 Q5
(MCP 지원 Phase)를 Phase 3로 확정·해소한다.

## 근거

- 도구 정의가 아니라 **외부 프로세스 프로토콜 클라이언트**다 — subprocess
  생명주기·JSON-RPC 상관·프레이밍을 가진 독립 도메인이므로 도구 1개가 아닌
  슬라이스가 맞다(RFC §3.2의 슬라이스=도메인 원칙).
- 브리지를 agent에 둔 이유: `@/tool`은 RFC §3.1에서 `@/storage`/`@/runtime`
  /`@/shared`만 도달 가능. `@/tool`→`@/mcp`는 경계 침범이라 Biome로 차단됨
  (ADR-0001). agent는 조립자라 `@/mcp`·`@/tool`을 동시에 알아도 합법 —
  변환 어댑터의 자연스러운 위치.
- 프로토콜 버전을 `PROTOCOL_VERSION = "2025-06-18"`로 핀 고정: 미합의
  버전 협상은 "빵꾸" 위험(RFC §12). 단일 값으로 고정하고 어긋나면
  `McpError`로 표면화.
- 보수적 기본값: MCP 도구는 부수효과가 불명이므로 `isReadOnly:()=>false`,
  `isConcurrencySafe:()=>false`. 정상 permission 경로를 거치고 직렬 실행.
  `McpError`는 throw가 아니라 에러 result로 매핑 — 다른 도구와 동일 계약,
  루프 밖으로 안 샘. 부모 env 전체를 상속하지 않고 `buildEnv`가 PATH +
  opt-in env만 전달(호스트 시크릿 누출 차단).

## 트레이드오프

- **얻은 것**: 임의 MCP 서버 도구를 격리 위반 없이 도구 레지스트리에
  편입. 프레이밍 견고화(`LineReader`가 부분 read·합쳐진 flush·깨진 줄을
  처리). 한 서버 실패가 치명적이지 않음(`loadMcpTools`가 로그 후 스킵,
  나머지는 로드, CLI 무중단).
- **잃은 것 / 비용**:
  - 슬라이스 1개 추가 → `biome.json`에 `src/mcp/**` override 블록 1개
    신설 + 다른 모든 슬라이스 override에 `@/mcp` 금지 항목 추가(슬라이스
    추가의 RFC §9.2 절차 비용, ADR-0001이 예고).
  - MCP 도구는 side-effect 불명 → 캐시 불가·동시성 비안전으로 못 박아
    네이티브 도구보다 처리량 손해(보수성의 대가, 의도된 안전 선택).
  - `passthroughSchema`는 JSON Schema를 충실 재현하지 않고 top-level
    `required`만 강제 → 정밀한 입력 검증은 서버에 위임(과설계 회피,
    RFC §1.2).
  - subprocess 생명주기 비용: 서버당 spawn·요청별 타임아웃·종료 시 전
    pending reject. `stop()` 멱등으로 누수는 막았으나 프로세스 관리 표면이
    슬라이스에 상존.

## 후속

- 다중 MCP 서버 도구명 충돌 정책(`mcp__server__tool` 위생화는 있으나
  서버 간 동일 도구명 우선순위 미정) — 실제 충돌 시 결정.
- transport는 stdio만. HTTP/SSE transport가 필요해지면 ports 추출 검토
  (현재 단일 구현이라 약식 유지 — RFC §3.1).
