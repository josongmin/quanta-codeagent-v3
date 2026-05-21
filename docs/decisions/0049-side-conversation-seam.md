# ADR-0049 — Side-conversation seam (parallel read-only sub-thread)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2 / §16 (SOTA++ 흡수),
  [[codex-desktop-build-2867-round-4]] (Codex `codex.thread.side` 텔레메트리
  + verbatim system prompt 발견),
  ADR-0030 (mid-turn steering — side conv는 그것의 **반대** 케이스),
  ADR-0041 (subagent 6-tool standard — side conv는 subagent **아님**),
  ADR-0048 (`response.in_progress` — 동일 라운드의 짝)

## 맥락

Codex Desktop 빌드 2867 라운드-4 audit ([[codex-desktop-build-2867-round-4]])
에서 발견된 사실:

1. Codex 바이너리에는 `codex.thread.side=true`라는 OTel 속성이 존재.
2. 그 속성을 emit하는 코드 경로는 별도 시스템 프롬프트를 사용:

   > You are a side-conversation assistant, separate from the main thread.
   > Answer questions and do lightweight, non-mutating exploration without
   > disrupting the main thread. If there is no user question after this
   > boundary yet, wait for one.

3. Codex의 어떤 공개 UI/CLI도 이 경로를 노출하지 않음 — 내부 prototyping seam.

side conversation은 다음 시나리오를 위한 lightweight read-only sub-thread다:
사용자가 메인 에이전트가 작업하는 중에 "이 regex 무슨 뜻이지?" / "이 파일이
뭐 하는 거지?" 같은 질문을 던지면, 메인 thread를 **interrupt하지 않고** 별도
짧은 LLM 호출로 답하는 것. 다음 특징을 갖는다 (모두 의도적인 narrow):

- **read-only**: filesystem mutate / shell spawn / working state write 불가.
- **별도 context window**: 메인 thread의 메시지가 forward되지 않음 (side conv는
  자기 system prompt + 사용자 질문만 봄).
- **subagent 아님**: ADR-0041 6-tool subagent와 다른 컨셉. Task-style fork도
  아님. session 없음, working tree 없음, 별도 로그 없음 — parent의 PROCESS는
  공유하되 conversation은 공유 안 함.
- **bounded effort**: reasoning effort는 `low` 또는 `medium` 뿐 — `high` /
  `xhigh` 금지 (side conv가 비싸지면 본전 손해).
- **중첩 금지**: side conv 안에서 또 다른 side conv를 spawn 불가.

v3는 day-1부터 이 seam을 1급 API로 노출한다 — 내부에 묻어두지 않고
`runSideConversation()`을 `@/agent`의 공개 export로.

## 결정

다음 4개 표면을 신설한다:

1. **시스템 프롬프트 상수** — `SIDE_CONVERSATION_PROMPT`
   - **byte-identical to Codex** (위 인용문 그대로, 줄바꿈 없이 한 줄).
   - 단위 테스트가 byte-equality를 강제 (`toBe(expected)`).
   - DO NOT paraphrase — grep 호환성을 위해 양쪽 prompt corpus가 일치해야.

2. **read-only 도구 allowlist** — `SIDE_CONVERSATION_TOOL_NAMES`
   - `["read", "grep", "glob"]` 세 개만.
   - **모두** `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`에서 `null`(읽기
     전용) 분류여야 — 단위 테스트가 cross-check.
   - 새 도구를 allowlist에 추가하려면 (1) 본 ADR 수정, (2) cross-check 테스트
     통과 필수.

3. **공개 API** — `runSideConversation(opts): Promise<SideConversationResult>`
   (`src/agent/side-conversation.ts`)
   - 입력: `parentThreadId`, `question`, optional `model`, `effort`,
     `now`(테스트 clock), `llm: LLMPort` (caller가 provider/model 선택).
   - 출력: `{ answer: string; tokens: { input, output } }`.
   - 동작:
     - `llm.stream({ messages: [user question], system: PROMPT, tools:
       SIDE_CONVERSATION_TOOL_SCHEMAS })` 1회 호출.
     - assembled text 추출 + `usage` 이벤트에서 토큰 추출.
     - 텔레메트리 1줄 emit (아래 §4).
   - **tool dispatch 엔진은 wire 안 함**: 모델이 tool_use를 emit해도 실제로
     실행되지 않음. tool schema는 모델에 힌트로만 전달 — side conv의
     "read-only-by-construction" 디펜스는 mutating 도구가 애초에 LLM에
     보내지지 않는 것이 1차, dispatch가 없는 것이 2차.

4. **텔레메트리 속성** — `quanta.thread.side`
   - canonical-vocabulary 모듈(`src/observability/vocabulary.ts`)에 등록:
     `QUANTA_ATTRS.thread.side = "quanta.thread.side"`.
   - boolean, side conv 자체 span에서만 `true`. parent thread span에는 절대
     emit 안 함.
   - 부속 속성: `QUANTA_ATTRS.thread.parentId`, `QUANTA_ATTRS.turn.kind =
     "side-conversation"`, `QUANTA_ATTRS.turn.durationMs`.
   - `attrs()` helper로 빌드하여 typo 시 컴파일/런타임 모두 잡힘
     (ADR-0032).

### Codex의 `codex.thread.side`와의 parity

키 prefix는 v3 namespace(`quanta.*`)를 따른다 — 별도 dashboard, 별도
ownership. **시멘틱은 동일**: 둘 다 "이 span은 side conv의 것"을 표시. 추후
양쪽 텔레메트리를 normalize하는 일이 생기면 단일 key 매핑 테이블만 필요.

### 흡수 vs negative invariants

- ADR-0044 N9 `dangerously-bypass-approvals-and-sandbox` 위배 없음 — side
  conv는 read-only이고 권한 우회 경로 없음.
- ADR-0044 N4 personality 시스템과 무관 — system prompt는 verbatim Codex
  string으로 고정, byte-identical prompt cache invariant ([[cc-v2-sota-absorption]])
  와 양립.

## 근거

- **subagent보다 가벼움**: ADR-0041 subagent는 session + 6-tool 정책 + 별도
  process까지 동원. side conv는 LLM round-trip 한 번 + log 한 줄. "regex
  뜻이 뭐냐"에 subagent를 쓰는 건 over-engineering.
- **mid-turn steering(ADR-0030)의 반대축**: steering은 사용자가 parent
  thread의 **방향을 바꾸는** 것. side conv는 사용자가 parent thread를
  **건드리지 않고 옆에서 물어보는** 것. 둘은 보완적, 충돌 아님.
- **read-only가 trust 모델의 core**: 사용자가 "마법" 같이 side conv를
  띄웠는데 그게 filesystem을 mutate하면 신뢰 파탄. 도구 allowlist + dispatch
  미연결의 이중 디펜스.
- **bounded effort**: type-system + 런타임 guard 둘 다 — type alone이
  `high`/`xhigh`를 거부, 런타임 가드가 `as any` 캐스트도 잡음.
- **첫 시민 API**: Codex처럼 내부에 묻어두면 외부에서 발견 불가 + dashboard
  drift. day-1에 공개하면 UI/CLI 양쪽이 동일한 seam에 묶임.

## 대안

- **subagent로 구현 (ADR-0041 6-tool)**: 기각 — 무게 과잉. side conv는
  session-free / working-tree-free / log-free가 본질.
- **parent thread에 user turn 끼워넣기**: 기각 — context window 오염 +
  parent's conversation history corrupt. side conv는 별도 context가 핵심.
- **system prompt paraphrase**: 기각 — Codex와 grep 호환성 손실. 어느 한
  codebase에서 다른 한 곳의 prompt를 검색할 수 있어야 양쪽 telemetry를
  정합화 가능.
- **mutating 도구 일부 허용 (예: `bash` with stricter approval)**: 기각 —
  trust 모델 깨짐. side conv가 "lightweight, non-mutating exploration"의
  Codex 정의를 벗어나면 본 ADR을 supersede.
- **effort 무제한**: 기각 — side conv가 분 단위 reasoning을 돌리면 parent를
  방해하지 않는다는 promise가 깨짐.

## 결과·트레이드오프

- **얻은 것**:
  - lightweight Q&A seam을 무게 없이 day-1에 노출.
  - Codex parity — `codex.thread.side` 등가 telemetry로 양쪽 분석 일치 가능.
  - read-only-by-construction — security audit 표면 최소.
  - parent thread와 parallel 보장 (integration test가 pin).
- **비용**:
  - 새 API surface 1개 (`runSideConversation` + 5개 export).
  - tool schema 중복 (3개 read-only tool spec가 dispatch 엔진의 것과
    별도 정의됨) — 의도된 분리. 향후 read-only dispatch 엔진을 연결할 때
    같은 schema를 재사용하면 됨.

## 한계 (LIMITATIONS)

- (a) **read-only dispatch 미연결**: 현재 side conv가 모델에게 tool schema를
  보여주지만 실제 tool 실행은 없음. 모델이 "이 파일 읽어줘" 라고 tool_use
  emit해도 결과 없이 turn 종료. 답이 generic해질 가능성 있음. 향후 슬라이스
  에서 read-only dispatch 엔진을 plug-in (additive).
- (b) **session/persistence 미연결**: side conv 결과는 in-memory return만 —
  parent의 session JSONL에 안 들어감. 사용자가 같은 질문을 두 번 하면 두
  번 호출됨. 의도된 stateless 시작점.
- (c) **concurrency 제한 없음**: 동시에 N개 side conv를 spawn 가능. caller
  책임 (UI가 throttle).
- (d) **모델 선택 책임은 caller**: `opts.model` 또는 `opts.llm.model` —
  side conv 자체가 "더 싼 모델"을 자동 선택하지 않음. 의도적 — provider/
  model 선택은 multi-provider seam의 책임 ([[quanta-v3-state]]).

## 불변식 영향

- **슬라이스 격리 유지**: `src/agent/` 내부 + observability vocabulary 1
  엔트리 추가. tool slice / memory slice 무관.
- **RFC/ADR 동기**: RFC §16 흡수 changelog에 본 ADR 등록 예정.
- **신규 npm dep 0**.
- **byte-identical prompt cache**: side conv 자신의 system prompt는 parent
  thread와 별개 — parent의 cache prefix 무영향.

## 변경 절차

side conv 정의를 확장하려면:

1. mutating 도구 추가 / effort 상한 변경 / context forwarding 등 모든
   확장은 본 ADR을 supersede하는 별도 ADR이 필요.
2. system prompt 변경은 본 ADR + 단위 테스트의 expected 문자열 동시 업데이트
   (byte-equality 강제).
3. PR 리뷰는 agent slice 오너 + security 오너 양쪽 필수 (read-only 가드가
   본 ADR의 trust model core).
