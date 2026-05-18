# ADR-0002: OpenAI를 2번째 LLM provider로 추가

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §3.2(llm 풀 헥사고날), §8(openai는 Phase 3 예정), §9.2(LLM provider 추가 = ADR 트리거), §12(의존성 폭증)

## 결정

`@/llm` 슬라이스에 `adapters/openai.ts`(`OpenAIAdapter implements LLMPort`)를
추가한다. CLI는 `QUANTA_PROVIDER` 또는 키 존재 여부로 provider를 골라
`LLMPort`로만 주입한다. 공식 `openai` SDK(^6.38)를 런타임 의존성으로
추가한다. RFC §8이 openai를 Phase 3로 잡았으나, 사용자가 `.env.dev`에
`OPENAI_API_KEY`만 제공해 실 end-to-end 검증을 그 키로 해야 했고,
`LLMPort` 포트가 이미 존재(§3.2)해 2번째 어댑터가 설계된 확장점이라
앞당겼다.

## 근거

- `llm`은 RFC §3.2에서 이미 "풀 헥사고날"(ports.ts 존재). 2번째 구현
  추가는 RFC §3.1의 "약식→풀 전환 트리거"가 아니라 이미 풀인 슬라이스의
  의도된 확장 — 구조 변경 없음.
- 실 스모크가 차단 상태였다(ANTHROPIC_API_KEY 부재). 사용자 제공 키가
  OpenAI라 OpenAI 어댑터 없이는 "빵꾸 없는" 실 검증 불가. 검증으로
  `read` 도구 1회 호출 후 정답 텍스트, `completed` 2턴 확인.
- 의존성: 2→3 (`@anthropic-ai/sdk`, `openai`, `zod`). RFC §12 목표
  "5개 미만" 내. 공식 SDK 채택 이유: 스트리밍 tool-call 누적·재시도·
  타입을 직접 fetch로 재구현하면 "빵꾸" 위험(부분 JSON 인자 누적,
  finish_reason 처리)이 큼. Anthropic 어댑터와 대칭(둘 다 공식 SDK).
- provider 선택을 CLI(apps)에 둠: 슬라이스는 `LLMPort`만 알면 되고
  (의존성 역전 유지), provider 분기·키 검증·기본 모델은 조립자(apps)
  책임. `@/llm`은 어느 provider도 import하지 않음.

## 트레이드오프

- **얻은 것**: provider 무관 실 검증 가능. Anthropic/OpenAI 런타임
  스위치(`QUANTA_PROVIDER`, 키 자동 추론). 어댑터 격리로 한쪽 SDK
  변경이 루프/도구에 무영향.
- **잃은 것 / 비용**:
  - 의존성 +1(`openai` 6.x).
  - OpenAI는 tool 결과를 별도 `role:"tool"` 메시지로 요구 → Anthropic
    보다 메시지 매핑이 복잡(`toChatMessages`가 user 블록을 user/tool로
    분해). 매핑 버그 표면이 넓어 통합 테스트로 커버 필요(후속).
  - `max_tokens`는 OpenAI o-시리즈에서 `max_completion_tokens`로
    대체됨 — 현재 기본 `gpt-4o`는 동작하나, o-시리즈 사용 시 어댑터
    수정 필요(미지원 모델 시 명확한 `LLMError` 표면화로 완화).
  - 기본 모델 `gpt-4o` 하드코딩(provider별 기본값). 계정에 해당 모델이
    없으면 `OpenAI request failed`로 표면화, `QUANTA_MODEL`로 우회.
  - RFC §8 Phase 계획과 실제 순서 불일치 — RFC §13.1/§15에 기록해
    정합.

## 후속

- OpenAI 어댑터 메시지 매핑·스트림 누적의 단위/통합 테스트 추가
  (FakeLLM이 아닌, 어댑터 자체의 chunk→StreamEvent 매핑 테스트).
- 3번째 provider가 필요해지면 그때 provider 레지스트리 추출 검토
  (현재는 CLI의 `switch` 1곳이라 약식 유지 — RFC §3.1 원칙).
