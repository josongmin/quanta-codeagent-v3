# Codex Agent Tool Routing and Triggering

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

## 1. Core principle

도구는 질문 문자열에 기계적으로 반응하는 것이 아니다. 실제 트리거는 `답변이 무엇을 근거로 해야 하는가`에 의해 결정된다.

즉:
- 최신 사실이 핵심이면 `web`
- 로컬 코드 근거가 핵심이면 `shell/file`
- 실제 수정이 핵심이면 `edit`
- 병렬 전략이 핵심이면 `subagent`
- 시각 결과물이 핵심이면 `image/browser`

```mermaid
flowchart TD
    A["사용자 질문"] --> B["작업 분류"]
    B --> C["답변 진실 조건 판정"]

    C --> C1["최신성 필요한가"]
    C --> C2["로컬 코드/파일 근거 필요한가"]
    C --> C3["실제 수정 결과물이 필요한가"]
    C --> C4["시각 확인이 필요한가"]
    C --> C5["병렬 분할이 유리한가"]

    C1 --> D["web 계열"]
    C2 --> E["shell / local read 계열"]
    C3 --> F["patch / scripted edit 계열"]
    C4 --> G["browser / image / view 계열"]
    C5 --> H["subagent / parallel 계열"]
```

## 2. Tool families

### 2.1 Web tools

언제:
- 최신 정보
- 공식 문서
- 가격/일정/날씨/뉴스
- 링크/출처 요구

트리거 표현 예:
- `최신`
- `오늘`
- `지금`
- `찾아봐`
- `공식 문서`

전형 흐름:
1. search
2. open
3. find
4. cite

### 2.2 Local shell / file tools

언제:
- repo code review
- 심볼 검색
- 함수/테스트/owner 확인
- 빌드/테스트/스크립트 실행

전형 흐름:
1. `rg`
2. `sed -n`
3. 필요 시 script

핵심:
- 로컬 코드가 truth source인 질문은 browse보다 local read가 우선

### 2.3 Edit tools

언제:
- 실제 파일 수정

분기:
- patch edit:
  - 국소 변경
  - 문맥 안정
- scripted replace:
  - 중복 블록
  - 대량 치환
  - patch context mismatch

### 2.4 Browser / visual tools

언제:
- localhost 확인
- 클릭/입력/화면 inspection
- 이미지 생성/편집
- 로컬 이미지 보기

핵심:
- 시각 검증이 필요한 요청을 텍스트 추론으로 대체하지 않는다

### 2.5 Subagent / parallel tools

언제:
- 사용자가 병렬 허용
- 독립 side task 존재
- write scope 분리 가능

핵심:
- critical path는 메인에 남기고
- sidecar task만 위임

## 3. Trigger examples

| 질문 유형 | 답변의 진실 조건 | 우선 도구 |
|-----------|------------------|-----------|
| "최신 OpenAI 문서 확인" | 최신성 + 출처 | web |
| "이 repo에서 foo 어디 남았냐" | 로컬 증거 | shell/file |
| "이 함수 고쳐" | 실제 수정 결과물 | edit |
| "localhost 열어봐" | 시각 관찰 | browser |
| "병렬로 처리해" | 작업 전략 | subagent |
| "monad가 뭐냐" | 안정적 개념 설명 | no tool |

## 4. Tool routing state machine

```mermaid
stateDiagram-v2
    [*] --> Classify

    Classify --> DirectAnswer: 안정적 지식 / 로컬 근거 불필요
    Classify --> WebPath: 최신성 / 출처 필요
    Classify --> LocalRead: 로컬 코드 / 파일 근거 필요
    Classify --> VisualPath: 시각 확인 필요
    Classify --> ParallelPath: 병렬 허용 + 독립 태스크

    WebPath --> DirectAnswer: 충분한 출처 확보
    LocalRead --> EditDecision: 수정 필요
    LocalRead --> DirectAnswer: 읽기만으로 충분

    EditDecision --> PatchEdit: 국소 / 안정적
    EditDecision --> ScriptEdit: 중복 / 불안정 / 대량
    PatchEdit --> LocalRead: 잔존 확인 필요
    ScriptEdit --> LocalRead: 잔존 확인 필요

    VisualPath --> DirectAnswer: 결과 확보
    ParallelPath --> LocalRead: 메인 critical path 진행
    ParallelPath --> DirectAnswer: 결과 통합

    DirectAnswer --> [*]
```

## 5. Fallback behavior

### 5.1 Patch failure

증상:
- context mismatch
- 중복 블록
- partial old/new mix

전환:
- 재patch에 집착하지 말고 scripted replace로 이동

### 5.2 Over-broad shell output

증상:
- 읽기 범위 과다
- grep noise 과다

전환:
- `rg`로 위치를 먼저 좁히고
- `sed -n`으로 필요한 구간만 읽기

### 5.3 Weak web search results

증상:
- 검색 결과가 너무 넓음
- 비공식 문서 혼입

전환:
- domain 제한
- 검색어 구체화
- 공식 URL 직접 open

### 5.4 Bad subagent split

증상:
- 같은 파일 충돌
- critical path 지연

전환:
- 메인에서 직접 처리
- side task만 agent로 분리

## 6. Practical rule of thumb

가장 실전적인 요약:

- 최신 사실이 핵심이면 web
- local truth가 핵심이면 shell/file
- patch가 흔들리면 script
- 병렬은 disjoint side task만
- 도구는 질문에 반응하는 게 아니라 `답변 증거 조건`에 반응한다
