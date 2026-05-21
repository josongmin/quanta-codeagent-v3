# ADR-0048 — `response.in_progress` SSE/WebSocket 이벤트 1급 처리

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2 / §16 (SOTA++ 흡수의 forward-compat gap),
  [[codex-desktop-build-2867-round-4]] (Codex dispatcher가 silent-drop함),
  ADR-0049 (side-conversation seam — 동일 라운드 진단의 짝)

## 맥락

OpenAI Responses API는 모델이 아직 생성 중이지만 노출할 새 출력이 없을 때
`response.in_progress` 프레임(SSE: `event: response.in_progress`, WebSocket:
`{"kind":"response.in_progress",…}`)을 보낸다. 페이로드는 보통
`progress` / `message` / `elapsed_ms` 같은 보조 필드를 담는다.

Codex 빌드 2867 라운드-4 audit ([[codex-desktop-build-2867-round-4]])에서
확인된 사실: Codex의 WebSocket dispatcher는 `event.kind` switch에 이 케이스가
**없어 silently drop**한다. 사용자 입장에서 그 자체로 무해(아직 새 텍스트가
없으니까)지만, UI가 "thinking..." 인디케이터를 렌더링하려면 외부 polling이
강요된다. v3는 이 이벤트를 forward-compat gap으로 본다.

또한 Responses API는 시간이 지나며 새로운 `response.*` 이벤트를 추가해 왔다
(예: `response.created`, `response.completed`, 모델별 reasoning 이벤트). 알지
못하는 이벤트가 들어와도 turn이 wedge되지 않는 forward-compat 계약이 1급
요구사항이다.

## 결정

`response.in_progress`를 v3 `StreamEvent`의 **첫 시민**으로 추가한다.

- 새 variant: `{ type: "response_in_progress"; data: Record<string, unknown> }`
  - `data`는 의도적으로 opaque (`Record<string, unknown>`) — provider schema가
    drift하므로 consumer가 실제로 쓰는 필드만 narrow.
- 디코더 두 개를 신설: `src/llm/streaming-events.ts`
  - **SSE 디코더**: `parseSseFrame(text)` → `decodeSseEvent(frame)`
    - 멀티라인 `data:`는 SSE spec대로 `\n`으로 join.
    - 잘못된 JSON은 `data: {}` 로 fallback (frame discriminator는 이미 검증된
      상태이므로 payload 깨짐을 throw로 전파하지 않음).
  - **WebSocket 디코더**: `decodeWsEvent(envelope)`
    - `kind` discriminator는 payload에서 제거하고 나머지 필드를 `data`에 보관.
- **forward-compat 계약**:
  - 모르는 event/kind는 `decodeXxxEvent`가 `null`을 반환하고
    `log.debug("unknown_sse_event", { event })` (또는 ws 변종)을 한 번 emit.
  - 절대 throw하지 않음 — provider rollout이 turn을 wedge하지 않게.
- `StreamEvent` union에 명시적 variant 추가 (`src/llm/types.ts`).
- 어셈블러(`src/llm/assemble.ts`)는 이 이벤트를 무시(컨텐츠 누적에 기여 안
  함) — UI/렌더러가 직접 소비.

### 흡수 vs negative invariants

본 변경은 **흡수**다 ([[cc-v2-sota-absorption]] / [[codex-absorption-complete]]
참조). Codex의 silent-drop은 negative invariant가 아니라 단순 forward-compat
누락이며, v3는 동일 wire frame을 더 풍부하게 표면화한다. ADR-0044의 어떤
invariant도 건드리지 않는다.

## 근거

- **UI 인디케이터의 1급 데이터 소스**: polling 없이 모델 진행 상태를 표현하려면
  이 이벤트가 필요. CLI/Web/Tauri 모든 surface가 같은 StreamEvent를 받으므로
  surface별 polling 분기 제거.
- **forward-compat 비용은 0**: unknown은 debug log + null. 알려진 케이스만
  variant로 추가하므로 wire 호환성 손실 없음.
- **typed payload 의도적 회피**: `data: Record<string, unknown>`는 provider
  schema drift를 흡수. consumer는 필요한 필드만 narrow, 그 외는 무시.
- **SSE/WS 동시 지원**: 단일 모듈에 두 디코더를 두어 (1) 같은 known-event
  테이블을 공유, (2) 향후 known-event 확장 시 한 곳만 손대게.

## 대안

- **그대로 silent-drop (Codex 동등)**: 기각 — "thinking..." UX 가능성을 영구
  포기. v3 multi-surface 모델 ([[surface-model]])에서 surface마다 따로
  workaround를 강요.
- **adapter 내부에 매장 (adapter별 분기)**: 기각 — 두 adapter
  (`adapters/anthropic.ts`, `adapters/openai.ts`)에 중복. StreamEvent를
  port-level에서 통합하는 v3 디자인과 충돌.
- **`data`를 typed object (e.g. `{ progress: number; message?: string }`)**:
  기각 — provider schema drift가 잦은 영역. typed object는 1년 안에 깨지고
  consumer 전부 손봐야 함. opaque + per-consumer narrow가 더 안정.

## 결과·트레이드오프

- **얻은 것**:
  - UI는 polling 없이 "thinking..." 인디케이터 렌더 가능.
  - forward-compat 강화 — 미지의 `response.*` 이벤트가 추가되어도 turn wedge
    안 됨, 단지 debug log만.
  - SSE + WebSocket 두 wire 모두 동일한 StreamEvent로 소비.
- **비용**:
  - StreamEvent union에 variant 1개 추가 — assembler/스위치에 새 케이스가
    잠재적으로 누락될 수 있음. `noFallthroughCasesInSwitch` + 단위 테스트로
    회귀 방지 (의도적으로 ignore하는 곳도 명시적으로 명시).
  - `data`의 opaqueness 때문에 consumer가 `typeof` narrow를 반복 — 의도된
    트레이드오프.

## 한계 (LIMITATIONS)

- (a) **adapter 통합은 후속 작업**: 현재 PR은 decoder + StreamEvent variant만
  추가. 실제 `adapters/openai.ts` (또는 동등 OpenAI Responses API adapter)가
  이 디코더를 호출하도록 wiring하는 일은 별도 슬라이스. 단위 테스트는 decoder
  단을 byte-level로 pin.
- (b) **`response.created` / `response.completed`는 KNOWN으로 분류 안 함**:
  현재 audit ([[codex-desktop-build-2867-round-4]])에서 in-progress만 명시적
  silent-drop으로 진단됨. 다른 `response.*`는 forward-compat unknown 경로로
  넘김 — 필요해지면 본 ADR을 amend하거나 별도 ADR.
- (c) **payload 검증 부재**: `data`가 opaque이므로 잘못된 필드(예: `progress`
  가 string)를 emit하는 provider 버그를 v3가 잡지 못함. consumer 책임.

## 불변식 영향

- **슬라이스 격리 유지**: `src/llm/` 내부에서만 변동. `agent`/`tool`/`memory`는
  무관.
- **RFC/ADR 동기**: RFC §16 흡수 changelog에 본 ADR 등록 예정.
- **신규 npm dep 0**.
- **byte-identical prompt cache**: 무관 (StreamEvent variant 추가는 system
  prompt에 영향 없음).

## 변경 절차

본 ADR을 supersede하려면:

1. 별도 ADR ("ADR-00XX: StreamEvent variant 재설계")을 작성.
2. wire-level 호환성 영향 + consumer 마이그레이션 경로 설명.
3. 본 ADR 상태를 "Superseded by ADR-00XX"로 변경.
