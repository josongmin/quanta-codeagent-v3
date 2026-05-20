# Codex Agent Execution Loop

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

## 1. High-level model

Codex 계열 에이전트는 `질문 -> 답변`의 단순 1-pass 모델이 아니라, 아래처럼 동작하는 반복 루프에 가깝다.

```mermaid
flowchart TD
    A["사용자 입력 수신"] --> B["상위 제약 로드<br/>시스템 / 개발자 / 앱 / 모드 / repo 규칙 / 스킬"]
    B --> C["작업 분류<br/>설명 / 최신정보 / 코드수정 / 리뷰 / 감사 / 시각작업 / 병렬작업"]
    C --> D["도구 필요 여부 판단"]

    D -->|불필요| E["직접 답변 구성"]
    D -->|필요| F["최소 sufficient 도구 선택"]
    F --> G["도구 실행"]
    G --> H["관찰 결과 해석"]
    H --> I["작업 상태 업데이트"]
    I --> J["종료 조건 판단"]

    J -->|불충분| K["다음 행동 결정"]
    K --> D
    J -->|충분| L["최종 답변 생성"]
```

요약:
- `ReAct family`와 닮았지만, 고전적인 `Thought -> Action -> Observation`를 외부에 그대로 노출하지는 않는다.
- 실제 구동축은 `정책 계층`, `도구 라우팅`, `상태 업데이트`, `종료 판단`이다.

## 2. Code-repair loop

코드 수정 작업은 별도의 repair loop를 가진다.

```mermaid
flowchart TD
    A["코드 수정 요청"] --> B["owner surface 식별"]
    B --> C["인접 truth surface 식별<br/>type / wire / tests / callers"]
    C --> D["최소 파일 읽기"]
    D --> E["수정 전략 결정"]

    E -->|국소 / 안정적| F["patch edit"]
    E -->|중복 / 대량 / 불안정| G["scripted replace"]

    F --> H["수정 적용"]
    G --> H

    H --> I["잔존 심볼 / 계약 누락 확인"]
    I --> J["surface alignment 판단"]

    J -->|불완전| K["다음 surface 수정"]
    K --> D
    J -->|충분| L["최종 보고"]
```

핵심 규칙:
- `owner first`
- `type / wire / tests`는 owner semantics에 맞춰 정렬
- patch가 불안정하면 scripted replace로 즉시 전환
- 문자열 grep은 closeout 보조일 뿐, semantic proof는 아니다

## 3. Review loop

리뷰 요청은 수정 루프가 아니라 증거 수집 루프에 가깝다.

```mermaid
flowchart TD
    A["리뷰 요청"] --> B["구현 / 테스트 / 호출부 식별"]
    B --> C["증거 수집"]
    C --> D["break path / drift / stale authority 탐지"]
    D --> E["severity 판정"]
    E --> F["finding 정리<br/>file / line / what / why / impact"]
    F --> G["findings 충분성 판단"]
    G -->|부족| C
    G -->|충분| H["findings 중심 응답"]
```

핵심 규칙:
- findings first
- concrete file/line evidence
- generic praise보다 compile/runtime/semantic break 우선

## 4. Audit loop

감사 요청은 의도와 구현의 정합성 비교가 중심이다.

```mermaid
flowchart TD
    A["감사 / 정합성 요청"] --> B["intended contract 추출"]
    B --> C["truth surface 분리"]
    C --> C1["type truth"]
    C --> C2["owner truth"]
    C --> C3["wire truth"]
    C --> C4["test truth"]

    C1 --> D["surface 간 비교"]
    C2 --> D
    C3 --> D
    C4 --> D

    D --> E["authority leak / dual truth / fail-open / stale compat 탐지"]
    E --> F["증거 정리"]
    F --> G["충분한 mismatch 증거인가?"]
    G -->|아니오| C
    G -->|예| H["audit 결과 보고"]
```

핵심 규칙:
- `type truth`, `owner truth`, `wire truth`, `test truth`를 분리해서 본다
- 문서나 테스트만으로 soundness를 선언하지 않는다

## 5. Runtime boundary

에이전트 실행은 LLM과 runtime의 역할 분리가 전제다.

```mermaid
flowchart LR
    A["사용자 요청"] --> B["LLM 판단"]
    B --> C["도구 호출 의사결정"]
    C --> D["런타임이 실제 도구 실행"]
    D --> E["관찰 결과"]
    E --> B
```

경계:
- LLM:
  - 작업 분류
  - 도구 필요 여부 판단
  - 도구 선택
  - 결과 해석
  - 최종 응답 구성
- Runtime:
  - 어떤 도구가 있는지 제공
  - 권한/모드/세션 제약 집행
  - 실제 tool execution 수행

## 6. Practical interpretation

가장 실무적인 요약은 이렇다.

- Codex는 `순정 ReAct`라기보다 `policy-constrained tool-using iterative agent`다.
- Planner-heavy 시스템도 아니고, reflex bot도 아니다.
- 실제 체감은 `light planner + iterative executor + repair loop`에 가깝다.

## Round 2 update (2026-05-21 deep dive)

`agent-loop-deep-dive.md`가 binary structure를 깊게 다루고, 이 doc은 그 binary가 실제 어떤 subcommand surface에서 loop를 돌리는지로 닫는다.

### Codex Rust binary subcommand surface — loop entry points

- `[FACT]` Codex CLI binary path: `/Applications/Codex.app/Contents/Resources/codex`. 182MB Mach-O arm64, `codex-rs` workspace, CLI version 0.130.0 (models_cache `client_version` 기준으로 server-pushed 0.131.0 존재).
- `[FACT]` 실제로 loop을 trigger하는 subcommand 표:

| Subcommand | Loop kind | Notes |
| --- | --- | --- |
| `exec` | one-shot iterative loop | CLI 진입의 default agent loop |
| `exec-server` | persistent JSON-RPC loop | app-session host에서 turn router |
| `tui` | interactive iterative loop | terminal UI에서 동일 inner loop |
| `chat` | chat-style loop | message-only interaction |
| `resume` | continuation loop | rollout/session resume 진입 |
| `apply` | non-loop one-shot | V4A patch 적용 path |
| `mcp` | MCP subprocess driver | tool-routing 쪽 owner |
| `shell` | shell skill driver | tool-inventory 쪽 owner |
| `skill-install` / `skill-list` / `market-place-install` | non-loop admin | skills audit으로 위임 |
| `login` / `feedback` / `feedback-internal` / `notification` | side-channel | loop 외부 |

- `[FACT]` 이 중 `exec`, `exec-server`, `tui`, `chat`, `resume` 다섯 개가 동일 inner agent loop를 공유한다고 보는 게 binary-string 증거와 가장 잘 맞는다. (별도 inner loop string은 발견되지 않음.)
- `[FACT]` `--dangerously-bypass-approvals-and-sandbox` flag가 binary에 존재하지만 default disabled. loop의 admissibility gate를 우회하는 단일 surface.

### Loop boundary 갱신

- mermaid §1 / §5의 `런타임이 실제 도구 실행`은 위 subcommand 중 어느 것을 통해 들어왔는지에 무관하게 동일하다는 점만 명시한다.
- bypass flag는 §1 J 분기(`종료 조건`)가 아니라 §5의 `Runtime`이 외부에서 enforcement를 끊는 axis다. 따라서 loop의 graph는 바뀌지 않고, runtime side enforcement만 약해진다.

### What does not change

- ReAct-like inner shape는 그대로다.
- specialized loops (code-repair, review, audit) 분리도 그대로다.
- repair loop 안의 `owner -> adjacent truth surfaces -> patch -> verification/closeout` discipline도 그대로다.
