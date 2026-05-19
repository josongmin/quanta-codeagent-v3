# ADR-0004: 시스템 프롬프트를 정적 프리픽스로 고정해 캐시 적중

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §3.1(슬라이스 격리), §9.2(LLM provider 메시지 계약 변경 = ADR 트리거), ADR-0002(2 provider 체제), ADR-0003(테스트 피라미드)

## 결정

매 턴 `buildSystemPrompt(cwd) + 메모리 회상 + 플랜 증강`을 새 문자열로
조립해 system으로 넘기던 것을 멈춘다. system은 세션 내내 **byte-identical**
한 정적 프리픽스(`SystemBlock[]`, 마지막 블록 `cache:true`)로 고정한다.
턴마다 바뀌는 컨텍스트(오늘 날짜, cwd/git, 플랜 모드 고지, 메모리 회상)는
system에 섞지 않고, `messages` 끝에 단 1개의 `<system-reminder>...</system-reminder>`
user 메시지로 덧붙인다. 생산자 측을 `src/agent/prompt.ts`의
`buildTurnContext(input): { system, messages }` seam으로 분리하고, 루프는
이 산출물을 소비만 한다. `@/llm`의 system 타입을 `string | SystemBlock[]`
(`SystemBlock = { type:"text"; text; cache? }`)로 넓히되 `string`은 그대로
대입 가능 — 하위 호환. Anthropic 어댑터는 `cache:true` 블록에
`cache_control:{type:"ephemeral"}`를, 마지막 메시지 끝 블록에도 1개
breakpoint를 부착한다. OpenAI는 자동 프리픽스 캐시라 `SystemBlock[]`를
순서 보존해 단일 문자열로 평탄화만 한다(`cache` 플래그 무시).

`AgentConfig.system`(호출자가 넘기는 정적 프롬프트)은 제거하지 않고
`buildTurnContext`의 선택 입력 `system?`으로 그대로 흘려보낸다 — 세션당
1회 설정·턴마다 불변이라 캐시 프리픽스로 안전하고, 죽은 필드 제거보다
blast radius가 작다(apps/cli·테스트 cfg 무변경). 없으면 내장
`buildSystemPrompt()` 폴백. 본문 강화 프롬프트는 이 폴백 기본값이다.

## 근거

- 두 provider 모두 **프리픽스가 byte-stable일 때만** 캐시가 적중한다.
  Anthropic은 명시적 `cache_control`, OpenAI는 자동이지만 양쪽 다 프리픽스
  1바이트가 바뀌면 miss. 종전 방식은 날짜·메모리·플랜 문자열을 system에
  매 턴 새로 끼워넣어 프리픽스를 항상 흔들었다 — 캐시가 구조적으로 0%.
- cwd와 도구 집합은 세션 중 불변(ADR-0002의 조립자 책임). 진짜 가변인
  것만 꼬리로 분리하면 "정적 system + 과거 턴"이 통째로 캐시 프리픽스가
  되고, 변하는 부분은 맨 끝 1개 메시지로 국한된다.
- 트레일링 메시지를 `<system-reminder>`로 감싸 모델이 시스템성 지시로
  인식하게 한다. 기존 메모리/플랜 증강 카피 패턴(loop.ts)을 system이
  아닌 메시지 꼬리로 옮긴 것 — 동작 의미는 보존, 위치만 이동.
- system 타입 확장은 RFC §9.2의 "LLM provider 메시지 계약 변경"에 해당해
  ADR 트리거. `string` 하위 호환 유지로 기존 호출자·테스트는 값 수준에서
  무영향(타입을 스스로 `string`으로 좁힌 테스트 더블만 후속 정정 필요).
- 프롬프트 본문도 함께 강화: SWE-bench급 자율 다중파일 작업을 위해
  행동 편향·편집 전 읽기·경로 환각 금지·변경 후 검증·실패 시 진단을
  명시(블로트 없이 ~45줄). 정적이므로 캐시 비용에 무영향.

## 트레이드오프

- **얻은 것**: 양 provider 캐시 프리픽스 안정 → 턴당 재전송 토큰 급감
  (system+과거 턴이 캐시 히트, 꼬리만 새로). 생산자/소비자 seam 분리로
  루프는 컨텍스트 조립을 모른다. provider 분기는 어댑터 내부에 격리.
- **잃은 것 / 비용**:
  - 가변 컨텍스트가 system이 아닌 대화 꼬리에 위치 → 모델이 시스템
    지시보다 약하게 볼 여지. `<system-reminder>` 래핑으로 완화.
  - Anthropic ephemeral 캐시는 TTL(~5분)이 있어 유휴 후 첫 턴은 miss
    재워밍 — 연속 ReAct 루프에선 사실상 상시 히트라 영향 미미.
  - system 타입이 유니온이 되어 어댑터마다 분기 1개씩 추가(문자열
    경로는 종전과 byte 동일하게 유지해 표면 최소화).
  - `buildSystemPrompt`의 `cwd` 인자는 무시되는 레거시 파라미터로 잔존
    (앱 호출자 컴파일 보존용) — 루프 마이그레이션 후 제거 대상.

## 후속

- `src/agent/index.ts`에 `buildTurnContext`/`TurnContext`/`TurnContextInput`
  re-export 배선(소유권 밖이라 미수정 — 배선 필요).
- 루프가 `buildTurnContext` 소비로 전환되면 `buildSystemPrompt(cwd)`의
  레거시 인자 제거, `system?: string`으로 좁힌 테스트 더블 정정.
- 캐시 히트율을 observability 지표로 노출해 회귀 감지(후속 ADR 불요,
  슬라이스 내부 — RFC §9.3).
