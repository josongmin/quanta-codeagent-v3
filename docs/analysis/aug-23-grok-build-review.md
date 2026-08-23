# Grok Build (xAI) 리뷰 — 에이전트 루프 해부 + quanta 비교

- 작성: 2026-08-23
- 대상: `xai-org/grok-build` (Apache 2.0), 클론 `~/Documents/code-new/competitor-scaffolds/grok-build`, `SOURCE_REV 7d67dea`
- 규모: Rust 1,657,018줄 / 2,765 파일 (자체코드 1,630,968, `crates/codegen` 이 95%)
- 방법: 1차 6축 병렬 리뷰 → 2차 적대 검증 3축 → 에이전트 루프 4축 정밀 추적 → quanta 4축 대조

> 검증 등급 표기: **[직접]** = 내가 소스를 직접 읽어 확인 / **[에이전트]** = 서브에이전트 보고(교차검증 안 된 것) / **[정정]** = 1차 결론이 뒤집힌 항목
>
> **실행 정본은 §15다.** §11·§13의 초기 제안과 §14.4의 추가 목록은 조사 이력으로만 보존한다. 구현 티켓, 병렬화, merge 순서, 완료 판정은 §15만 따른다.

---

## 0. 한 줄 요약

기본기는 성숙하고 **진짜 차별점은 4개**(스텝서명 정체탐지 · 서버측 doom탐지 · 파일경로별 쓰기잠금 · PreToolUse 인자 재작성). 가장 재사용 가치 높은 건 기능이 아니라 **규율 하나** — 하네스 발화 전량을 평범한 `user` 메시지로 보내되 전송 안 되는 태그로 출처를 추적하는 것. 반면 **관측성(멈춤 사유의 화면 전달)은 실패**했고, 그건 우리 북극성이 실제로 미개척 영역이라는 실증.

---

## 1. 무엇인가

터미널 기반 코딩 에이전트(TUI). 헤드리스/CI, 에디터 임베딩(ACP)도 지원. 사내 모노레포에서 주기적으로 export 되며 커밋은 전부 "Synced from monorepo" 35개.

**crate 배치** (우리와 거의 동일한 분해)
| 경로 | 역할 |
|---|---|
| `xai-grok-pager-bin` | 컴포지션 루트 |
| `xai-grok-pager` | TUI (스크롤백/프롬프트/모달/렌더) |
| `xai-grok-shell` | 에이전트 런타임 + leader/stdio/headless 진입점 |
| `xai-grok-tools` | 툴 구현 |
| `xai-grok-workspace` | 파일시스템/VCS/실행/체크포인트 |

루트 `Cargo.toml`은 **생성물**이라 read-only 명시. 외부 기여 안 받음.

---

## 2. 공개/비공개 경계 — "얌체"는 아님 **[에이전트]**

**들어있는 것**
- **시스템 프롬프트 전량 평문**: `xai-grok-agent/templates/prompt.md` (6,992B, 진짜 최상위 프롬프트), `apply_patch_prompt.md` (21,360B), `subagent_prompt.md` (5,502B), goal 계열 ~50KB
- 단독 빌드 가능 (`cargo metadata --offline` 통과, 93 패키지 전부 해결, git 의존 2개 다 공개)
- 테스트 포함 (`tests/` 420 파일, `#[test]` 포함 1,582 파일, PTY e2e, mock 서버)
- 모델 백엔드 교체 가능 (`[model.<id>]`에 `base_url`/`api_key`/`extra_headers`, `api_backend` = chat_completions|responses|messages)

**프롬프트 난독화 검증 [직접 지시 → 에이전트 실행, sha256 대조]**
`prompt_encrypted.rs`에 XOR 배열이 있고 런타임은 **이쪽을 씀**(평문은 staleness 테스트용). 복호화 결과 **3개 모두 평문과 바이트 동일**. 소스 주석에 "보안이 아니라 난독화, 시드가 repo에 있음"이라 자인.

**빠진 것 4개** (3개는 정당)
1. 내부 Bazel 빌드 (모든 crate에 `default-bazel` feature가 있는데 `BUILD`/`MODULE.bazel` 없음)
2. 텔레메트리 목적지 (코드는 있고 URL/키가 빌드타임 `option_env!` → 소스 빌드는 보낼 데 없음)
3. cli-chat-proxy 서버 (별개 서비스)
4. **🔴 eval 하네스** — 에이전트 품질 측정 코드가 전무. 주석엔 "recap 프롬프트 eval 하네스와 동기화 유지"라 적혀 있으나 그 하네스는 모노레포에만.

부작용: `tests/registered_features_are_documented.rs`가 없는 `docs/internal/`을 `include_str!` 해서 **그 테스트 타겟은 컴파일 불가**.

**텔레메트리**: 이벤트 구조체 111개. `PromptSubmitted`는 길이만 보내고 본문은 `#[serde(skip)]`. 본문은 `OTEL_LOG_USER_PROMPTS` 게이트 + 60KB 상한 + 시크릿 스크러빙. opt-out 실동작.

---

## 3. 에이전트 루프 **[직접 + 에이전트]**

### 3.1 흐름도

```
[사용자 입력]
   ├ "!cmd"     → bash 직행 (샘플링 없음)
   ├ "/command" → 슬래시 처리, 조기 종료 가능
   └ 일반 ↓  리마인더 8종 주입 → user 메시지 커밋 → UserPromptSubmit 훅

┌─ 바깥 라운드 루프 (turn.rs:916) ─────────────────────────────────┐
│ ┌─ [완료요구 재시도 래퍼 :1610]  ※기본 미사용, 소진시 조용히 성공 ─┐│
│ │ ┌─ process_conversation_turn :2029 ─────────────────────────┐││
│ │ │ [준비 1회] 모델메타 · 모델변경시압축 · 툴정의 · 스키마       │││
│ │ │ ┌─ loop :2139 ─────────────────────────────────────────┐ │││
│ │ │ │ ① 정체 하드스톱 검사 ← 지난 바퀴 카운터                │ │││
│ │ │ │     12 / 8(Read·Plan) / 4(noop) ⇒ StationarityEnded  │ │││
│ │ │ │ ② 정체 넛지 (8 / 4, 런당 1회)                         │ │││
│ │ │ │ ③ 루프내 리마인더 5종 + ★개입 드레인(안전지점 A)        │ │││
│ │ │ │ ④ 압축 검사 (85%, 인라인 블로킹)                       │ │││
│ │ │ │ ⑤ 샘플 ─┬ 샘플러층 재시도(빈응답·429·5xx·doom)          │ │││
│ │ │ │         │   반복 소모 X · 모델 비가시 · 최대 15회        │ │││
│ │ │ │         └ 인증401 → 반복 소모하며 재시도(3+50+8)        │ │││
│ │ │ │ ⑥ 툴 호출 없음?                                       │ │││
│ │ │ │     ├ TodoGate ※기본OFF·상한2 → 넛지 ↻                │ │││
│ │ │ │     ├ ★개입 드레인 ×2 (장부마감 전·후) → 있으면 ↻      │ │││
│ │ │ │     └ 전부 통과 ⇒ Completed                           │ │││
│ │ │ │ ⑦ 스텝 서명 해시 → 정체 카운터 갱신(검사는 다음 바퀴)    │ │││
│ │ │ │ ⑧ 준비단계 [순차] 권한·훅·플랜게이트                    │ │││
│ │ │ │     └ 승인 대기 = 배치 전체 정지, 타임아웃 없음           │ │││
│ │ │ │     거부 ⇒ Cancelled                                  │ │││
│ │ │ │ ⑨ 실행 [병렬] 같은 파일 쓰기만 경로별 잠금               │ │││
│ │ │ │     · 15초 초과 → 백그라운드 승격, 즉시 task-id 반환    │ │││
│ │ │ │     · 대기툴만 개입으로 중단 가능(안전지점 B)            │ │││
│ │ │ │ ⑩ 턴수 초과 ⇒ MaxTurnsReached                         │ │││
│ │ │ │ ⑪ 컨텍스트 넘침 → 압축 → ↻                             │ │││
│ │ │ └──────────────── ↻ ────────────────────────────────┘ │││
│ │ └─────────────────────────────────────────────────────────┘││
│ └──────── MaxTurns·Stationarity는 재시도 없이 통과 ─────────────┘│
│  Completed 아니면 ⇒ 즉시 break                                  │
│  Completed면 ↓ 거부→목표정지 / 대기입력→양보 / 목표계속 ↻         │
│              / stop-hook KeepWorking ↻ (최대 8, 훅 있을 때만)    │
└────────────────────────────────────────────────────────────────┘

[취소] Ctrl+C → 자식 프로세스그룹 SIGKILL → 턴 abort
       수집된 툴 결과 보존 / 스트리밍 중이던 응답은 히스토리에서 소실
[Send-now] 대기 중 Enter → 턴 취소하고 새 턴 (목표 모드면 대신 주입)
```

### 3.2 종료 타입 4종 **[직접]**
`TurnOutcome` (`types.rs:66-92`): `Completed{snapshot, tools_called, structured_output, refusal}` / `Cancelled{category, context}` / `MaxTurnsReached{limit}` / `StationarityEnded{snapshot}`.

`StationarityEnded`가 `Completed`와 분리된 이유가 주석에 명시 — **복구·목표·stop-hook이 샘플링 루프를 다시 열지 못하게**.

### 3.3 정체(stationarity) 탐지 **[직접]**
- 임계값 (`turn.rs:2953-2957`): 일반 **넛지 8 / 하드스톱 12**, Read·Plan 계열 **4 / 8**, true-noop keepalive **하드스톱 4**(넛지 없음)
- 서명: 툴 호출 배치 전체를 하나의 스텝으로 해싱. 테스트로 확인된 정규화 — JSON 키 순서 무시, 중첩 객체 키 순서 무시, **툴 호출 순서 무시**. 반대로 인자 값 다르면 구분, 배열 원소 순서는 구분
- **갱신은 툴 실행 직전(:2831), 검사는 다음 바퀴 맨 앞(:2142)** → 한 바퀴 지연 있음
- 주석에 사고 기록: `todo_write` **224회 연속 호출**

### 3.4 에러/재시도 사다리 **[에이전트]**

2층 구조. **샘플러층**은 턴 루프가 못 봄(반복 미소모·모델 비가시), **턴 루프층**은 의미적 실패.

| 메커니즘 | 기본 | 예산 | 반복소모 | 모델가시 |
|---|---|---|---|---|
| 인증 401 | ON | 3(1/2/4s) + 무과금 50 + 절전리셋 8 | **예** | 아니오 |
| 빈 응답 | ON | 전송 15회 예산 공유, 2s→30s | 아니오 | 아니오 |
| 깨진 툴 인자 | ON | **무제한**(정체탐지가 유일 제동) | 예 | **예** |
| 구조화 출력 검증 | 스키마 있을 때 | 3 | 예 | 예 |
| doom-loop | **ON** ※정정 | 2 | 아니오 | 아니오 |
| 미디어 과다생성 | ON | 1 | 예 | 예 |
| 자동압축(85%) | ON | 인라인 블로킹 | 아니오 | 히스토리 교체 |
| 선제 투패스 압축 | **OFF** | — | 아니오 | 아니오 |
| 429/5xx/네트워크 | ON | 2 / 15 | 아니오 | 아니오 |
| 완료요구 재시도 | **OFF**(내장 사용처 0) | 저자 지정 | 아니오 | 예 |

인증 백오프 상수 주석에 **"1000ms 기준으로 잡았다가 11.6일 행업"** 사고 기록.

### 3.5 개입/취소 **[에이전트]**
- 후속입력 모드 2종: `Queue`(기본, 다음 턴) / `Steer`(현재 턴 메시지에 주입)
- 개입 주입 안전지점 3곳: 툴 배치 직후 / 다음 샘플 직전 / 턴 종료 판정 시(2회)
- **개입은 실행 중 툴을 못 끊음.** `tokio::select!`가 걸린 건 대기 계열 툴만
- **권한 승인 = 완전 직렬 장벽.** 승인은 순차 for 루프에서 처리되고 병렬 실행은 전원 승인 후 시작 → 하나 대기하면 나머지는 **시작도 안 함**. ACP 왕복에 **타임아웃 없음**
- 취소: 자식 프로세스그룹 SIGKILL 먼저 → 턴 abort(진행 중 future는 대기 안 하고 버림). 수집된 툴 결과는 보존, 스트리밍 중이던 assistant 메시지는 히스토리에서 소실

---

## 4. ReAct 대비 **[에이전트]**

뼈대는 동일(샘플 → 툴 → 관측 → 반복). 편차 3방향:

1. **멈추는 조건이 다중** — 정체·턴상한·doom·취소가 각각 독립적으로 끊음
2. **모델이 끝내려 해도 막는 경로 존재** — TodoGate, stop-hook(8회), 완료요구. **단 앞의 둘은 기본 OFF/훅 필요, 셋째는 내장 사용처 0** → 기본 경로에서 실제로 턴을 다시 여는 건 **목표 계속 + 개입 드레인**뿐
3. **하네스가 루프 사이에 계속 말을 걺** — 주입 지점 약 30곳

**진짜 차별점 4개**: 스텝서명 정체탐지 / 서버측 스트림중간 doom탐지(프로바이더 공동설계 필요) / 병렬 실행 중 파일경로별 쓰기잠금 / PreToolUse 훅의 인자 재작성 + 대상 툴 변경.

**기본기(누구나 있음)**: 권한게이트, 훅, stop-hook, 턴상한, 자동압축, 재시도 사다리, 병렬 툴, 백그라운드 승격.

### 🔑 가장 재사용 가치 높은 것 — 하네스 발화 태깅
하네스가 모델에게 하는 **모든** 발화가 평범한 `user` 역할 메시지. 별도 역할을 만들지 않음. "시스템 리마인더"도 user 메시지 본문을 `<system-reminder>` 텍스트로 감싼 것. 대신 **전송되지 않는 `synthetic_reason` 태그 16종**을 달아서 압축·포크·프롬프트 인덱싱이 "사람 말 vs 하네스 말"을 구분. 와이어 포맷은 표준 그대로 유지.

---

## 5. 보안/권한 **[에이전트 + 2차 적대검증]**

### 5.1 좋은 것
- **명령 분류를 tree-sitter-bash로 파싱** (정규식 아님). 체인을 세그먼트로 쪼개 각각 독립 통과 요구, 파싱 불가(heredoc/`$()`/백틱)면 **fail-closed 보수적 프롬프트**. 래퍼(`env`/`command`/`sudo`) 벗기기 깊이 8, 초과시 fail-closed. 접두 매칭에 단어경계 강제(`gitleaks` ≠ `git`, CWE-183 명시)
- **위험목록 대신 실행수단 차단**: dangerous 동사는 9개뿐인데 `EXEC_VEHICLE_HEADS` ~35개(인터프리터·러너·docker·sudo·find·xargs)로 "무언가 실행시킬 수 있는 것"을 막음. 간접 실행 경로도 개별 차단(`tee` 제거=CWE-863, `rg --pre`, `git --textconv/--ext-diff`)
- **커널 레벨 훅 자기설치 차단**: `~/.grok/hooks/`를 읽기 가능·**쓰기 커널거부** → 모델이 훅을 심어 게이트 우회 불가
- 권한 규칙 기본 동작 = **Deny** (CWE-1188 명시)
- "항상 허용"이 **단어 단위 스코프** (←/→로 argv 단어 범위 조정, 관리자 최소 스코프 하한)

### 5.2 🔴 실제 우회 (2차 적대검증에서 발견)
**HIGH — 따옴표 결합 파싱 차이**: 명령 분할 시 따옴표 붙은 조각을 **원문 그대로**(따옴표 포함) 단어 목록에 넣음. 플래그 검사는 문자열 비교라, 빈 따옴표를 끼우면 검사기는 못 보고 bash는 정상 실행.
- `rg --pr''e /tmp/evil.sh pat .` → `--pre` 가드 우회 → **프롬프트 없이 실행**
- 동일 수법으로 `kubectl --kubeconfig''=`, `sort --compress-program''=`, `git --ext-di''ff` 전부 우회
- **버그라는 증거**: 같은 코드베이스의 **파일 쓰기 판정 경로는 따옴표를 제대로 디코딩함**. 한쪽만 정규화 누락

**HIGH — `rg --hostname-bin` 미모델링**: ripgrep이 외부 실행하는 플래그인데 `--pre`만 알고 있음.

**MEDIUM — 지속승인 확대**: `EXEC_VEHICLE_HEADS`에 `npx`/`uvx`는 있는데 **`npm`/`pip`/`make`/`go`/`cargo`/`gradle`/`java`/`gdb` 없음.** `npm run build` 한 번 승인하면 `npm run <아무거나>` 통과. `curl -o`/`wget -O`도 쓰기 수단으로 미모델링.

**막힌 것(음성 결과)**: 래퍼 깊이 8 fail-closed 정확 동작 / `VAR=값 명령` 환경변수 주입은 별도 경로로 전부 차단(모르는 환경변수도 승인 요구) / `$()`·백틱·프로세스치환 전부 파싱불가 분류. **`sed`/`find`/`awk`는 안전목록에 없음**(1차 보고 오류).

### 5.3 구멍
- 샌드박스 **기본 OFF**
- 네트워크 제한은 리눅스 seccomp 전용, **macOS는 문서상 no-op**
- `network_policy.rs`는 enum만 있고 **미집행**(소스에 자인)
- 훅 실패가 **설계상 fail-OPEN** (Claude Code의 exit 2 차단과 정반대)
- 탈출구: `--yolo` / `--dangerously-skip-permissions` (단 관리자 핀으로 무력화 가능), `GROK_SANDBOX_AUTO_ALLOW_BASH`

---

## 6. 관측성 — **실패. 우리 북극성의 미개척 실증** **[에이전트 + 반증 시도]**

### 6.1 잘 만든 것
- **`PhaseKey` 2중 시계**: 턴 전체 경과 + 현재 작업단계 경과. 단계 시계는 **진짜 작업 단위가 바뀔 때만 리셋**(설명 문자열이 바뀌어도 안 돌아감). match가 exhaustive라 새 상태 추가시 정체성 선언 강제. **~50줄, ROI 최고**
- **`Waiting(WaitingReason)`**: `Model | Subagent{누구} | TaskOutput{작업들, 제목, waits} | TasksComplete | Sleep`. `waits: bool`이 중단 가능 대기와 즉시 폴링을 구분
- **완료 후에도 남는 idle watcher**: `"1 command · 2 monitors still running"` — "Worked for X"가 "다 끝남"으로 오독되는 것 방지
- **실패안전 기본값**: goal 상태 역직렬화시 모르는 값 → `Active` 아닌 **`UserPaused`**. 해석 불가 상태가 자율주행으로 보이면 안 된다는 원칙
- **조기 하차 탐지**: 턴 마지막 문단을 앵커 정규식으로 검사(`^Giving up`, `^Ready for review`, `^Please (start|run…)`) → 라벨 붙여 발행(정밀도/재현율 감사 가능) + 계속 넛지

### 6.2 🔴 실패 지점
멈춤 사유 어휘가 **5벌** 존재하고 화면에 가까워질수록 뭉개짐. 가장 풍부한 `StopCancelledReason`(MaxTurns·NoProgress 포함)은 **훅과 텔레메트리로만** 감. 사용자의 셸 스크립트가 화면 앞 사용자보다 많이 앎.

| 사고 | 상태 |
|---|---|
| 제자리걸음 종료가 `"Worked for 2m5s"`로 표시 | **기본 발동, 플래그 불필요**. 내부 이벤트 레일에도 `Completed` 라벨 → 텔레메트리로도 성공과 구분 불가 |
| 턴 상한이 `"Turn cancelled by user"`로 표시 | **[정정]** 잠재 버그. `--max-turns`는 TUI에서 무시됨(헤드리스 전용) → 커스텀 에이전트 정의로 `max_turns`를 준 경우만 발동 |
| `TurnHalted`("Agent was unable to make progress") | **프로듀서 없는 죽은 코드** — 정의·렌더암·테스트만 존재 |

**구조적 원인**: 멈춤사유→화면 매핑을 **4개 레일이 각자 재구현**하고 넷 다 인식 못 하는 값을 `TurnCompleted`(성공)로 흘림. 새 멈춤 사유 추가시 네 곳 모두 조용히 "성공"으로 렌더링. → 우리 `exhaustive-record-classification-drift-guard`가 정확히 막는 클래스.

**아이러니**: `/goal` 패널엔 정답이 있음 — `UserPaused / BackOffPaused / NoProgressPaused / InfraPaused / Blocked / Failed / BudgetLimited / Complete` + `/goal resume` 어포던스. 턴 단위 마커가 이렇게 생겼어야 함.

### 6.3 체크포인트 — 반쪽 함정
`RewindPoint`가 프롬프트 단위로 파일의 **이전/이후 스냅샷 둘 다** 저장(이후 것은 외부 편집 충돌 탐지용). 단 저장이 git 오브젝트가 아닌 **전문 텍스트 JSONL**. 더 중요한 건 `RewindMode`가 `All|ConversationOnly|FilesOnly`이고 백엔드 기본이 `All`인데 **출시 TUI는 `conversation_only` 하드코딩** → 파일 되돌리기가 ACP로는 되고 TUI에선 도달 불가.

---

## 7. 툴 서피스 **[에이전트]**

- 카탈로그 **50개 등록, 세션엔 18개**만 실림. `explore`(읽기전용 3개)·`plan`(4개) 프리셋은 **프롬프트가 아니라 툴셋 제외로** 읽기전용 강제
- **MCP 툴을 모델에 직접 노출 안 함** — `search_tool`/`use_tool` 메타툴 뒤에 숨김(컨텍스트 경제). 문서는 "내장 툴과 나란히 사용 가능"이라 과장
- **툴 이름·파라미터 이름을 모델에게 랜덤화.** 그래서 설명이 MiniJinja 템플릿이고 상호참조가 `${{ tools.by_kind.read }}` 형태
- 편집 도구 4계열 공존:
  - `search_replace`(기본): 정확 문자열, **read-before-edit·해시검사 없음**(`skip_read_before_edit`가 문서상 no-op)
  - `hashline_edit` (**xAI 자체 발명**): 읽기시 각 줄을 `1:abc:rst→내용`으로 렌더, 3글자 앵커 = 공백정규화 줄의 FNV-1a 해시. **앵커 자체가 최신성 검사.** 어긋나면 ±15줄 뒤져 새 앵커 반환 → **모델이 파일 재읽기 없이 재시도**
  - codex `apply_patch`(V4A, 4단계 fuzzy line seek), opencode `edit`
- 셸: 원샷 spawn, PTY·sentinel 없음. 기본 120초/포그라운드 상한 300초. **15초 초과시 죽이지 않고 백그라운드 승격**. 출력 20k head+tail + 디스크 전체로그 경로
- 검색: **코드베이스 임베딩 인덱스 없음.** ripgrep 번들 + LSP가 전부. 시맨틱 검색은 memory에만(sqlite-vec + MMR)

### 포팅 내역 = 신호
Apache §4(b) 고지에 명시:
- codex → `apply_patch`, `grep_files`, `list_dir`, `read_file` (Rust→Rust)
- opencode → `bash`, `edit`, `glob`, `grep`, `read`, `skill`, `todowrite`, `write` (TS→Rust)
- **opencode의 fuzzy 치환 체인은 안 가져옴** — 표면과 설명만 베끼고 fuzzy 매칭은 버림

---

## 8. 확장성 **[에이전트]**

- **ACP는 Zed의 공개 표준**(`agent-client-protocol` 0.10.4, crates.io). 그 위에 `x.ai/*` 확장 **230~278개**
- **🔑 TUI 자체가 ACP 클라이언트** → 에디터에 준 인터페이스 = 자기 1급 UI가 쓰는 것. 통합이 2급 시민이 될 수 없는 구조
- 에디터가 능력 선언하면 **런타임 백엔드가 실제로 교체**(에디터가 fs 지원하면 로컬 fs 대신 에디터 경유)
- Skills: Claude Code와 같은 `SKILL.md`. **문서에 없는 `paths:` 필드**(gitignore 글롭, 해당 파일 건드리기 전엔 목록에서 숨김). 목록은 컨텍스트 50% 예산 + 3단계 축약. **네이티브 Skill 툴 없음** — 소스에 주석처리, 모델은 광고된 절대경로를 `read_file`로 읽음
- Plugins: 스킬·명령·에이전트·훅·MCP·LSP 6종만 기여 가능, **툴 직접 주입 불가**. 기본 거부. 신뢰≠활성화(미신뢰는 스킬/에이전트만 로드, 훅·MCP·LSP 차단). 서명 없음, 커밋 SHA 핀만
- **폴더 신뢰 게이트**(VS Code식): repo 로컬 설정이 뭔가 실행하기 전 워크스페이스 단위 1회 확인, MCP·LSP·훅·프로젝트 권한규칙 통째 게이팅, 헤드리스 fail-closed
- **`GROK_CONFIG` 환경변수 오버레이는 허용목록 소프트 설정만** 먹고, 보안 게이트는 오버레이 없이 재독 → 환경변수로 권한 상승 불가
- 헤드리스 출력 4종 중 하나가 **Anthropic Messages API 와이어 클론**(`streaming-messages-json`) + `--allowedTools`/`--disallowedTools` 별칭 = Claude Code CI 파이프라인 재사용 유도

### 경쟁사 이주 마찰 제거 전략
`~/.claude.json`, `.claude/settings.json`, `~/.cursor/mcp.json`, `.mcp.json` 읽음. 권한 규칙 Claude 문법(`mcp__github__get_issue`) 번역 수용. 훅 이름 Claude/Cursor 별칭 수용. **다른 에이전트 세션 읽기 전용 임포터**(Claude Code, Codex CLI/VSCode/Atlas/ChatGPT, Cursor 데스크톱/CLI).

---

## 9. 죽은 코드 실측 **[2차 적대검증 — 1차 판단 뒤집힘]**

1차에서 "만들어놓고 안 켠 게 많다"고 패턴화했으나 **실측 결과 과장**.

| 지표 | 값 |
|---|---|
| 검증된 도달불가 코드 | **~5,290줄 = 자체코드의 0.32%** |
| 그중 한 모듈(`attempt_store`) 비중 | **86%** (게다가 "호출자 없는 정본 기록"이라 자기 신고) |
| `#[allow(dead_code)]` 자체코드 | 140개 (테스트 26 포함), `reason=` 있는 건 9개뿐 |
| lint 억제 범위 | ~25,900줄(1.6%) — **상한이지 죽은 줄 아님**(최대 3개는 라이브 확인) |

**8개 주장 중**: 6개 확인, 1개 재분류(`deploy_app`=export 스텁), **1개 반증**(`StopReason::MaxTokens` — 서드파티 enum이라 exhaustive match 필요, grok은 max-tokens를 **에러로 보고하는 설계**). 확인된 6개 중 2개는 죽은 게 아니라 ACP/설정으로 도달 가능.

**진짜 죽은 건 `attempt_store`와 `TurnHalted` 둘.** 1.6M줄 모노레포 export로는 평범한 수준.

단, `TurnHalted` 건은 오히려 더 아픔 — 죽은 코드가 거의 없는 코드베이스에서 하필 **"에이전트가 진전을 못 냈다"는 그 한 문장만** 배선이 안 됨. 관측성이 우선순위에서 밀린 흔적.

---

## 10. quanta 대조 **[우리 쪽도 동일 4축 감사]**

### 10.1 우리가 이긴 축

**에러 복구** — 우리 3층(스트림 시작 전 4회 / 프로바이더 교체 / 루프 내 3회) vs 걔네 2층. **18종 분류 테이블이 단일 권위**(걔넨 샘플러 안에 분산). 모델에 알리는 실패가 더 많음(빈 응답·깨진 툴·출력초과 전부 넛지). **압축 쓰래싱 브레이커 보유**(반응형3/선제형3/진전비율0.15) — 걔넨 압축 폭주 가드 없음. 모든 복구가 턴 반복 미소모(걔넨 인증 재시도가 소모).

**개입 모드** — 우리 3종(`queue`/`weave`/`interrupt`) vs 걔네 2종. 취소 후 재개도 우리가 나음: 중단 턴의 부분 응답 + 진행중 툴 id를 버퍼에 담아 `/resume`에서 산문으로 복원. 걔넨 부분 응답이 히스토리에서 소실.

**승인 실패 처리** — 사용자가 안 답하고 나가면 **타입된 사유와 함께 fail-closed 거부**(jun-10 사고 수정). 걔넨 조용히 취소.

**주입 위조 방어** — `embedUntrusted`/`escapeBoundary`로 모든 비신뢰 조각이 경계 이스케이프. repo 파일·툴 출력에 `<system-reminder>`를 심어도 하네스 발화 위조 불가. **Grok 쪽엔 대응물 미발견**.

### 10.2 대략 비긴 축

**정체 탐지** — **[정정]** 아까 "우리 없다"고 한 건 틀림. `src/agent/dispatch-dedup.ts`의 `DedupGate`가 내용 기반이고 **기본 ON**. 오히려 우리가 슬라이딩 턴 윈도우라 "A-B-A-B" 교대 반복까지 잡고(걔넨 연속 카운터라 못 잡음), 환경 변경 셸 명령을 **한 바구니로 묶는** 규제도 있음(일반 8턴/3회, env 4턴/3회, edit 파일별 8턴/5회).
**결정적 차이**: 우리 건 **막기만 하고 안 멈춤**(합성 tool_result로 steer). 걔넨 임계 넘으면 턴을 끊음. 모델이 형태를 바꿔가며 우기면 우리는 브레이크 없음.

**툴 병렬화** — 접근이 다름. 걔넨 전부 병렬 + 파일경로별 잠금. 우리는 읽기전용·동시성안전만 선실행하고 첫 위험 호출에서 **배리어** 걸고 이후 직렬. 잠금 없이 같은 안전성(쓰기끼리 겹칠 수 없음). 우리가 단순, 걔네가 병렬성 높음.

**백그라운드/취소** — 우리: bash 120초 자동 detach(기본 ON) + Ctrl+B는 **턴 전체** 백그라운드(기본 OFF, `QUANTA_BG_TURN`). 걔네: 15초 자동 승격 + Ctrl+B는 **개별 명령**. 우리는 결과 보존·재개가 낫고, 걔넨 취소 응답성이 나음(우리 취소는 **협조적이라 툴이 스스로 풀릴 때까지 대기**, 디스패치에 abort race 없음).

### 10.3 🔴 우리가 진 축 — 하네스 발화 태깅

발상은 동일(`src/agent/synthetic-user.ts`, id 접두어 `quanta:synthetic-user:<kind>:<uuid>`)하나 **완성도가 다름**.

| | Grok | quanta |
|---|---|---|
| 태그 종류 | 16 | 5 |
| 주입 지점 | ~30 | **50** (8채널) |
| 태그 붙는 비율 | 전량 | **6곳** |
| 태그 읽는 소비자 | 압축·포크·인덱싱 | **루프 내 3곳** |

**실제 손실**:
- 압축 경계 계산이 역할만 보고 셈 → 표식 없는 리마인더가 **사람 말처럼 요약됨**
- 압축이 만든 요약 헤더도 표식 없이 들어감 → **다음 압축이 자기 출력을 사용자 발언과 구분 못 함**
- 세션 저장시 id 없는 메시지에 평범한 `m{k}` 부여 → 그 시점부터 **영구 구분 불가**
- `/rewind`가 하네스 리마인더를 되감기 대상으로 목록에 올림
- 부수 버그: 정체성 리마인더가 kind를 `"focus-chain"`으로 오기재

**초크포인트 없음** — 10개 넘는 파일이 각자 `wm.append({role:"user"})` 직접 호출.

### 10.4 우리만의 결함

- **멈춤 사유를 정규식으로 복원**: `stop-category.ts`가 에러 메시지 문자열을 정규식 매칭해 reasonCode 결정. 인증 실패는 메시지에 `401`/`unauthorized`가 우연히 있어야 `provider.auth`, 아니면 `provider.unknown`. **좋은 타입(19코드 3층)을 휴리스틱으로 채우는 중** → `no-heuristics-only-validated` 원칙 위반
- **출력 길이 초과가 `completed.normal`로 봉인**: 3회 이어쓰기 후 잘림 마커 붙이고 정상 완료 처리. Grok의 "실패를 성공으로 접기"를 비판했는데 **우리도 동일**
- 안쪽 `for(;;)`에 전역 반복 상한 없음, 복구 예산이 매 턴 리셋 → 프로바이더 계속 흔들리면 `3 × maxTurns` 소모
- `too_many_failed_attempts` 데코레이터가 프로덕션 미조립
- `src/agent/auto-background/`(2초 정체시 백그라운드 제안, ADR-0223) — 탐지기/제안기 생성은 되는데 **`shouldPropose`/`accept` 호출부 0** = inert
- `poll_deferred`가 `ToolContext`를 안 받아 **취소 신호 미수신**(현재는 레지스트리가 비어 영향 없음)
- 깨진 툴 호출 재시도 1회뿐, 401 재시도 0회(걔넨 11.6일 행업 겪고 3+50+8로 감)

### 10.5 둘 다 앓는 병
**실패를 성공으로 접는 경로.** Grok 3곳(제자리걸음→"작업함" / 완료요구 소진→성공 반환 / doom 예산 소진→루프 응답 수용), quanta 1곳(출력초과→`completed.normal`).

---

## 11. 흡수 우선순위 — 중간안(실행 정본 아님)

> 이 표는 추가 감사를 하기 전의 중간 결론이다. `TurnCompletedEvent`만 확장하는 안, 별도 `PhaseKey`/`WaitingReason` 도입, 날짜 마스킹 등은 뒤 조사에서 수정됐다. 최종 합집합은 §15 참조.

| 순위 | 항목 | 근거 | 비용 |
|---|---|---|---|
| **0** | **멈춤 사유 last-mile 배선** — §13 참조. 이벤트에 `stopCategory` 탑재 + 공유 `Record<StopReasonCode,{label,tone}>` + 드리프트 가드 + 성공 기본값 3곳 수정 | **우리가 Grok보다 나쁨이 실측 확인됨**. 북극성 직결 | 중 |
| 1 | **하네스 발화 태깅 완성** — 표식 없는 주입 경로를 `makeSyntheticUserMessage`로 통일(kind enum 확장), `findBoundary`/`resolveTarget`이 `isSyntheticUserMessage` 참조 | 실제 손실 발생 중(압축 오염·되감기 노이즈·영구 구분불가) | 소 |
| 2 | **정체 탐지에 하드스톱 추가** — 현재 steer만 하는 `DedupGate`에 임계 초과시 턴 종료 | 형태 바꿔 우기는 경우 브레이크 부재 | 소 |
| 3 | **`PhaseKey` 2중 시계** | 관측성 북극성 직결, ~50줄 | 소 |
| 4 | **종료 사유 분류를 정규식→구조화 에러 타입** | 우리 원칙 위반 + 오분류 실재 | 중 |
| 5 | 출력초과 전용 stop code 신설(`completed.normal` 봉인 해제) | 실패를 성공으로 접는 경로 | 소 |
| 6 | `Waiting(WaitingReason)`식 대기 사유 명명 | "누구를 기다리는가"가 스피너보다 유용 | 소 |
| 참고 | 플랜 승인 상태의 종료 후 재개(셸이 승인 요청 재발행, UI측 디스크 로직 0) | 설계 참고용 | — |

**반면교사**: 멈춤 사유 파이프라인. 타입은 풍부한데 렌더까지 안 감 + 4개 레일이 각자 매핑 + 미인식값을 성공으로. → 우리는 산출 지점부터 화면까지를 **하나의 exhaustive 매핑 + drift-guard**로 묶어야 함.

---

## 13. 🔴 우리 멈춤 사유 last-mile 실측 — **Grok보다 나쁨**

§11의 "미검증 숙제"를 실행한 결과. 자평이 뒤집힘.

**핵심**: `grep -rn "stopCategory" src/apps/ apps/ surfaces/` = **0건**. 어떤 화면도 `stopCategory`를 안 읽음. 18개 코드(문서 앞부분의 "19개"는 오기)가 전부 **생성은 되는데** 화면 직전에 레거시 `reason` 7값으로 붕괴. `hint` 필드 전량 사문, `outcome.refusal.rationale` 소비자 0.

| | Grok | quanta |
|---|---|---|
| 내부 어휘 | 5벌 | 1벌(18코드 3층) — **설계는 우리가 나음** |
| 화면에 도달하는 구분 | 5개 | **0개** |
| 성공 오표시 지점 | 3곳 | **3곳**(아래) |

**성공 오표시 3곳**
1. `src/kernel/session/scheduler-turn-terminals.ts:144` — `outcomeReason: state.lastOutcomeReason ?? "completed"`. **이유 부재를 소스 지점에서 성공으로 채움** = Grok과 동일 버그
2. `src/apps/cli/repl/session-loop/turn-helpers.ts:250` — 성공 판정이 `result!==undefined && !turnAborted` → `error`/`refusal`/`max_turns`/`budget_exhausted`가 전부 `✓ done`(`notify/osc-adapter.ts:150`)
3. `apps/web-frontend/src/ws/session-hooks.ts:191-196` — 미인식값 기본값 `"(turn completed)"`. 게다가 `assistantText`가 `outcomeReason`보다 우선이라 턴 상한 종료도 답변처럼 보임

추가: `surfaces/vscode/src/chat-session-adapter.ts:174`는 `outcomeReason`을 버리고 `Idle` → 정상 완료와 구분 불가. 헤드리스는 이유 미출력(종료코드만).

**렌더 레일 6개, 공유 포매터 0.** 더 심각한 건 **새 reasonCode를 추가해도 컴파일이 안 깨짐**(아무도 안 읽으므로). `StopReason`(레거시 7값)만 2곳에서 exhaustive switch로 걸림.

**드리프트 가드**: 패턴이 repo에 있고 잘 작동함(`src/apps/bench/harness/promax/classify.ts:140-156`, 모듈 로드시 분류표 동기화 단언). **StopCategory엔 미적용** — `Record<StopCategoryKind,…>`/`Record<StopReasonCode,…>` 부재, 어떤 테스트도 렌더를 단언 안 함.

**두 위험 모드**
- **출력 잘림 — 우리가 Grok보다 정직.** `markTruncatedOutput`(`src/agent/recovery.ts:134-142`)이 어시스턴트 텍스트에 `"\n\n[output truncated at token budget]"`를 직접 박아 사용자가 in-band로 봄. `completed.normal` 라벨은 여전히 거짓이나 운영자는 안 속음
- **`model.empty_exhausted` / `model.malformed_tool_use`** — 둘 다 `reason:"error"`로 봉인 → CLI 알림 `✓ done`, 웹은 `"error"` 단어를 어시스턴트 버블로, VS Code는 `Idle`, 헤드리스는 무출력. **정상 완료와 구분되는 곳은 종료코드뿐**

**미사용 자산 2건**: `shell.needs_approval`은 `config.stopReasonPolicy` 경유만 가능한데 **할당 0건**(문서의 "reserved, not wired" 확인). `src/permission/review-kind.ts:183`의 `stopCategoryFor`는 `edit.needs_approval` ×7의 **병렬 제2 분류체계**인데 프로덕션 호출자 0.

**[정정] `TurnCompletedEvent`만 늘리면 안 된다.** 커널의 현재 terminal 분류는 `aborted`만 abort, `error`만 failed, 나머지를 completed로 보내므로 `max_turns`·`budget_exhausted`·`refusal`·향후 `no_progress`·`output_limit`가 계속 성공 이벤트가 된다. §15의 T-lane처럼 `TurnStoppedEvent`를 신설하고, approval/input은 terminal이 아니라 pause 이벤트로 분리하며, 모든 surface를 하나의 exhaustive presenter에 연결해야 한다.

---

## 12. 방법론 메모 — 이번 리뷰에서 내가 틀린 것들

서브에이전트 보고를 그대로 옮겼다가 뒤집힌 게 여러 건. 기록으로 남김.

1. "정규식 미들웨어가 이득의 정체" → ablation상 **최약 기여**, 이득 1등은 벤치 리터럴 0인 메모리 (AHE 건)
2. "자기반증 사망" → 반대편(수정 예측)은 랜덤 대비 5배로 작동 (AHE 건)
3. "만들어놓고 안 켠 게 패턴" → 실측 0.32%, **개별 발견을 패턴으로 승격시킨 오류**
4. "우리는 정체 탐지 없다" → `DedupGate`가 기본 ON으로 존재
5. "턴 상한이 사용자 취소로 오표기(기본 버그)" → TUI에선 `--max-turns` 무시라 **잠재 버그**
6. "doom-loop는 opt-in" → 정책이 `.default(true)`라 **기본 ON**
7. "우리 주입 14곳" → 전수조사 **50곳**
8. 종료 코드: 두 에이전트가 "0/1/2" vs "0/1/130/143/129"로 충돌 → **직접 확인 결과 합집합**(일반 0/1/2 + 시그널 130/143/129)
9. `sed`/`find`/`awk`가 Grok 안전목록에 있다 → **없음**(1차 보고 오류를 그대로 전달)

**교훈**: 개별 축 보고는 자기 파일 안에선 정확해도 "전수"라 단정함. 축을 가로지르는 결론(패턴 주장·비교 판정)은 반드시 실측이나 교차검증 후에.

---

## 14. 프롬프트 · 결정성 · 모드 비교

### 14.1 시스템 프롬프트

| | Grok Build | quanta |
|---|---|---|
| 크기 | **6,992 B / ~1.75k 토큰** | **21,053 B / ~5.3k 토큰** (3배) |
| 지시문 수 | ~30 | ~90 |
| 환경정보 위치 | **시스템 프롬프트에 없음** → 대화 인덱스1 user 메시지 | 끝단 `<system-reminder>` user 메시지 |
| 재조립 | **세션 시작 1회**, 턴마다 안 함(재작성 함수 주석: "호출자는 턴 0임을 보장") | 정적부 세션당 1회 + 휘발부 매 턴 |
| 최신성 | git status·날짜가 **세션 시작 스냅샷**, 긴 세션서 낡음 | 매 턴 갱신 |
| 구조 | `<work_policy>` `<tool_calling>` `<background_tasks>` `<communication>` `<formatting>` `<user_guide>` `<browser_verification>` | 인트로/정책 L1–L9/운영원칙/내부어휘/프로덕션 규범(한영 이중)/git 자세/증거·신뢰 사다리/예산/툴 라우팅/정직성 레일/주입 방어/보고 형태/검증 리포트/완료 기준 |
| 배포 | **XOR 난독화본을 런타임이 사용**(평문은 staleness 테스트용). 소스에 "보안 아닌 난독화" 자인 | 평문 |

**[정정] `apply_patch_prompt.md` 21,360B는 추가분이 아님** — **Codex 시스템 프롬프트를 거의 그대로 포팅한 대체 베이스 템플릿**(`TemplateOverride::Codex`), `codex` 프로필에서만. 기본 1.75k vs codex 5.3k, **합산 안 됨**. 내용도 V4A 문법이 아니라 Personality/AGENTS.md 스펙/preamble 예시 8줄/최종답변 스타일가이드 ~90줄. 패치 문법 언급은 한 줄뿐(`NEVER try applypatch or apply-patch`).

**톤 지시 (걔네, 인상적)**
> "Concise means being selective about what you include, not clipping the prose: no telegraphic fragments, no shorthand the user hasn't used."
> "Write every user-facing message for a reader who has NOT seen your tool calls"
> "NEVER coin acronyms, shorthand, or technical-sounding labels of your own."
> "State facts literally. Do not invent metaphors, idioms, or catchy labels."

⚠️ codex 프로필 프롬프트는 **정반대**를 지시("서문을 툴 호출과 항상 같이", "10줄 이내") — 한 코드베이스에 두 인격 공존.

**사고 유래 규칙 (goal_rules.md)**
> "NO TEST THEATER: a passing test must prove the SHIPPED code works on the real path. Never hard-code the expected value... **A test that passes while the program is broken is worse than none.**"
> "never shared `/tmp/...` paths (skeptics and concurrent goals collide there)"

포팅 흔적 미정리: Codex의 `【F:README.md†L5-L14】` 인용금지 문구가 그대로 잔존.

**우리 3축 구성**: `env posture(frozen|default|owned) × task pack(interactive|ide|headless|daemon|batch|ci-bot) × verify strategy(none|reproduce-first|verify-after-edit|grader-only)` + 4번째 `promptStyle(flat|sectioned)`. 기본 = CLI `frozen+interactive+none`, 벤치 `frozen+batch+(grader-only|reproduce-first|none)`. `grader-only`는 **감산적** — 검증·repro·아티팩트·ORIENT 사다리·검증리포트·완료기준을 제거하고 19,145B로 축소.

**우리 지시문 9종 전부 default-OFF, 다 끄면 바이트 0**(골든 테스트로 고정). AUTONOMOUS/READ_COMPLETE/PROGRESS/MEMORY_VERIFY/THINK_FREQ/ANTI_PLATITUDE/PARALLEL_TOOLS/ADVISOR_RAIL/CODE_MODE_ONLY.

### 14.2 결정성 — **우리 우세**

| | Grok Build | quanta |
|---|---|---|
| temperature | 기본 미전송(키 생략), 0 사용처 없음. 보조 호출만 명시(web_search 0.1 / 압축 1.0 / recap 0.1) | 기본 미전송. repair 팬아웃만 cand0 greedy·cand≥1 **0.8** |
| top_p / top_k | top_p 배관만, **top_k 없음** | **둘 다 없음** |
| max output | `None` → provider 기본 | **기본 8192 명시** |
| stop | 구조체에만, 하드코딩 `None` | 미전송 |
| **seed** | **없음** (필드·플래그 전무) | **없음** (필드·어댑터·knob 전무) |
| 추론강도 | 7단계, 기본 `Medium`, 모델별 기본 설정파일, 서브에이전트 상속 | 2축 분리 — OpenAI 6단계 **기본 없음**(provider 위임), Anthropic thinking 예산(미설정/1024/4096/16384/64000), 스킬·서브에이전트별 오버라이드 |
| 캐시 | Anthropic `cache_control` 4중 중 3개 사용(4번째 의도적 여유), Responses는 `prompt_cache_key`=세션id | 4구획 `base｜project_md｜session_ctx｜user_append` + 대화꼬리 1개, ttl 5m/1h, **드리프트 탐지기 + 캐시 감사기** 보유 |
| 캐시 위험 | 🔴 메모리 리마인더가 **시스템 아이템을 제자리 변형** → 메모리 변경시 시스템 브레이크포인트 전체 무효 | 없음(휘발부 전량 끝단 분리) |

**양쪽 다 날짜·턴카운터가 캐시 접두어에 없음** — 걔넨 날짜를 세션시작 첫 user 메시지에, 턴 인덱스는 `#[serde(skip)]`으로 헤더에만. 우리는 명시적 제외.

**모델 외 비결정성**
- **Grok — 미완화**: 병렬 툴 결과를 `FuturesUnordered` **완료 순서**로 트랜스크립트에 push → 순서가 벽시계 의존(코드가 자인). 정렬은 doom-loop 서명에만
- **quanta — 고정됨**: 미리 시작하되 결과는 **원래 모델 호출 순서**로 방출, 시계 주입식, 벤치 검증-선택 동시성 1 고정, 카세트 append는 tail-promise 뮤텍스로 직렬화. 잔여 누수 2 = 동시성>1시 샌드박스 경로 랜덤 접미어(의도), 동적 블록의 cwd

**리플레이**
- **quanta만 보유** — `LLMPort` 레벨 카세트(ADR-0192), 키=messages/system/tools/thinking/toolChoice/promptCacheKey/retention의 sha256. 메타(시각·durationMs·trace·lane·runId)는 계약상 replay-neutral. 정책 3종(`exact`/`messages-only`/`fuzzy-content`), miss 기본 `throw`, append는 tail-promise 뮤텍스로 직렬화, S3 내구화
- **Grok 없음** — 스크립트 HTTP 응답 / ACP 이벤트 UI 재생 / 텔레메트리 jsonl뿐

### 14.2.1 🔴 우리 쪽 실측 결함 (심층 조사)

**① 캐시 브레이크포인트 5개 초과 — 하드 API 거부, 미테스트**
`MAX_CACHE_BREAKPOINTS = 4`(`src/agent/prompt-sections.ts:25`)는 **시스템 섹션만** 셈. `cacheConversationPrefix`(`src/llm/anthropic-messages-codec.ts:115-144`)가 메시지 배열 마지막 텍스트 블록에 **무조건 5번째 마커**를 찍고(`:285`), 어디서도 대화 브레이크포인트를 예산에서 빼지 않음(grep 확인). repo규칙+세션ctx+user append가 모두 있는 세션 = 4+1 = 5 → Anthropic 거부. 헬게이트 테스트(`tests/unit/prompt-sections-hellgate.test.ts`)는 **섹션 수만 단언**해서 이 조합이 안 잡힘.

**② 리플레이 identity가 로컬 전송 메타와 모델 의미를 혼합**
- 현재 exact 해시는 raw `StreamInput`에 가까워 로컬 message id(합성 UUID 포함), `promptCacheKey`, retention 같은 전송 메타에 민감하다.
- 반대로 provider/model/effective max output/temperature 등 샘플링 의미 일부는 identity에서 빠질 수 있다.
- **날짜를 exact replay에서 마스킹하면 안 된다.** 날짜는 모델이 실제로 보는 의미 입력이다. 동일 캠페인의 cross-day 재현이 목적이면 `TurnContextInput.now`를 캠페인 입력으로 고정해야 한다.
- 수정 방향: provider-visible semantic request 기반 `ReplayIdentityV2`를 만들고 local id/phase/cache transport metadata는 제외, provider/model/effective sampling identity는 포함한다. v1은 명시적 legacy 모드에서만 허용한다.

**③ 카세트 confidentiality 경계 미완성** — `RecordingLlmOpts.scrubber`(`recording-llm.ts:26-32`) DI 훅은 있으나 프로덕션 recorder 배선에서 강제되지 않는다. partial 경로도 scrubber가 설정돼 있으면 적용되므로 "partial/error가 무조건 우회"는 오판이었다. 실제 위험은 scrubber 없는 production 조립과, degraded sentinel이 scrubber를 거치지 않은 full request를 저장할 수 있다는 점이다.

**④ 부수 발견**
- **git status가 프로덕션 프롬프트에 안 들어감** — `TurnContextInput.env`를 `context-assembler.ts:404-431`이 한 번도 안 채움 → env 프로브 경로 사문
- 대화 브레이크포인트가 **휘발 블록에 앵커됨** — 마지막 텍스트 블록이 곧 날짜·cwd를 담은 리마인더라, 매 턴 캐시 **쓰기**만 발생(읽기 앵커 아님)
- `injectIdeContext`(`context-assembler.ts:228-247`)가 **과거 user 메시지를 매 턴 재작성** → IDE 프로바이더 배선시 그 지점부터 메시지 캐시 무효화(리댁션 배너는 세션 상수라 무해)
- 마이크로컴팩션이 **벽시계 주기로 트랜스크립트 변형**(`compaction-wire.ts:154-155,194,656`, 기본 OFF) → 같은 입력도 실행 속도에 따라 다른 프롬프트
- MCP 서버 연결 실패시 조용히 스킵(`mcp-bridge.ts:427-432`) → 툴 배열이 바뀌어 **tools 구간부터 캐시 무효**

**⑤ 벤치 고정 상태 (양호)**
동시성 기본 **1**(`run-args.ts:63-76`), `mapWithConcurrency`가 인덱스로 기록해 "serial과 바이트 동일" 보장(`core.ts:123-146`), 도커 채점 별도 뮤텍스. 프롬프트에 랜덤 없음(randomUUID는 id에만, 합성-user id는 resume 경로서 `<SYN>`으로 마스킹). 시계 읽기는 전부 telemetry/timeout용.
**단 temperature 미고정**(팬아웃 cand≥1이 0.8), **seed 미지원**.

### 14.3 모드 — **[대폭 정정]** 축이 다를 뿐, 구조적 강제는 우리가 더 많음

> ⚠️ 1차 판정("Grok 3겹 vs 우리 1겹", "우리에겐 툴셋 프리셋 개념 자체가 없음")은 **틀렸음**. 심층 감사 결과 우리 모드 축은 **14개**이고, 모델이 보는 툴 목록에서 실제로 제거하는 경로가 **5개** 존재.

**우리의 툴 제거(STRUCTURAL — 모델이 아예 못 봄) 5경로**
| 경로 | 구현 |
|---|---|
| 스킬 스코프 `allowed-tools` | `filterSpecsByScope`(`skill-gate.ts:51-58`) → `stream-consume.ts:434`. L2 디스패치 게이트가 **같은 술어**라 visible == dispatchable |
| 서브에이전트 `toolFilter`/`task_kind`/네임드 `tools:` | 교집합으로 **새 ToolRegistry 생성**(`subagent-runner-child-config.ts:22-42,142`). 네임드는 NARROW-ONLY(확장 불가) |
| SDK `read-only` 프로필 | 레지스트리 필터(`sdk/embed.ts:114`) |
| 사이드 대화 | 허용목록 밖이면 **throw**(`side-conversation/run.ts:403-412`), 조용한 드롭 없음 |
| 툴 서피스 매니페스트 | 서피스별 등록 자체를 결정(`manifest.ts:123-151`). `terminal` 서피스는 BASE-free라 **구조적으로 repo 편집 도달 불가** |

**하드 런타임 게이트(툴은 보이되 거부)**: AgentMode(`gates.ts:128-146`, 스테이지1, HITL보다 앞) / CollaborationMode 플랜 펜스 / PermissionMode(`policy.ts:263-300`) / 툴 프로필 / 승인 사다리 / OS 샌드박스(백엔드 4종) / `bash mode:"read"`(호출별 샌드박스 + 검증명령 하드거부 `bash/index.ts:186-208`)

**정확한 차이**: 툴 제거를 **Grok은 모드 축**에, **우리는 스킬·서브에이전트·서피스·SDK 축**에 걸어둠. 그래서 우리 `AgentMode`(plan/review/audit/architect)만 카탈로그 전량 노출 + 디스패치 거부 → 위반마다 툴 호출+턴 소모. **기계는 이미 보유**(스킬 스코프가 정확히 그 일을 함)이므로 AgentMode에 연결만 하면 됨.

**✅ 우리가 오히려 모범인 부분**
- 플랜 펜스 `MUTATING_TOOL_TABLE`이 **모든 툴에 명시적 항목**(~180행, `mode.ts:162-534`), 미분류 이름은 `isMutatingTool`이 **throw**(`:742-745`) — 조용한 허용 없음. **이것이 곧 §13에서 StopCategory에 적용하라고 한 exhaustive 분류 + 드리프트 가드 패턴** (우리는 방법을 이미 알고 있고 멈춤 사유에만 안 씀). 드리프트 가드 + 헬게이트 e2e 보유
- 플랜 이탈이 self-service 아님 — 3방향 운영자 결정(`approved|rejected|changes_requested`), `changes_requested`는 펜스 유지
- `bypass`에서도 HARD_DENY 선행(`policy.ts:275`), hand-off-required 층 해제 불가(`admissibility-gate.ts:113-118`), 미분류 변경툴은 `always-confirm`로 fail-closed(`policy.ts:254-256`) → Grok의 `--yolo`보다 강함
- 서브에이전트 모드 clamp: repo 제어 자식 `mode:`가 읽기전용 부모를 **완화 불가**(`subagent-runner-child-config.ts:91-98`)

**🔴 새로 발견된 실제 결함 — shift+tab `plan` 단이 장식**
`MODE_CYCLE`(`mode-cycle.ts:39-72`) 4단 중 턴마다 권위 있게 투영되는 건 `permissionMode`뿐(`session-turn-driver.ts:65`). `plan` 단의 `agentMode`는 **상태 알약에만** 소비됨(`core-state.ts:41`, `prompt-ux.ts:87,95`). "파일을 절대 건드리지 않음"이라 표시하면서 `AgentConfig.mode`/`planMode`를 세팅하는 경로 없음 — `bypass`/`acceptEdits`는 진짜인데 `plan`만 cosmetic. `QUANTA_MODE_CYCLE=1` 기본 OFF라 범위는 제한적이나 **UI가 거짓말하는 클래스**(=우리가 Grok 관측성 실패를 비판한 바로 그것).

**미배선 재판정**
- `src/subagent/role.ts` — `roleAllowsKind`/`getToolPolicyForRole` **소비자 0, INERT 확정**. 모듈 헤더가 자인("wired by ./agent-tool.ts (in-flight on main)")
- `src/agent/subagent-typed/mode-registry.ts` — 1차 판정("아무것도 안 막음")은 **과했음**. 강제가 주입 러너에게 계약 위임(`delegation-router.ts:37`), `maxTurns`/`maxTokens`는 구조적 강제(`budget-overflow`), 기능 전체가 `config.delegation?.delegator` 기본 OFF. "미배선"보다 "계약 위임 + 기본 OFF"가 정확

**유지보수 위험**: `RunMode`의 `AgentMode`와 프롬프트 `AgentMode`가 **동명이형**(소스 주석에 명시, `agent-args.ts:35-37`)

**샘플링을 바꾸는 모드**: Grok은 `AgentDefinition.effort`·페르소나 `reasoning_effort`가 샘플링 설정으로 유입. 우리 `EffortLevel`도 **구조적으로 wire 파라미터를 바꿈**(`skill-gate.ts:181-200`, thinking budget) — 단 **모드와 미결합 독립축**이고 스킬 frontmatter·`session_config` 툴·`/effort`로만 움직임

**서로 없는 것**: Grok엔 `weave`/`interrupt` 턴중 주입 없음(큐만), 벤치 knob 프리셋 계층 없음, 사이드 대화 없음. 우리에겐 **모드↔툴셋 결합**이 없음(기계는 있으나 AgentMode에 미연결), `Devbox`/`Strict` 커널 티어 없음, `DontAsk` 없음

### 14.4 §14에서 추가된 흡수 항목

| 순위 | 항목 | 근거 |
|---|---|---|
| 추가-A | **AgentMode를 기존 툴 제거 기계에 연결** — 스킬 스코프의 `filterSpecsByScope`를 plan/review/audit/architect에도 적용 | 기계는 이미 있음(신규 구축 아님). 못 쓸 메뉴 제공은 턴+토큰 낭비 |
| **추가-A2** | **shift+tab `plan` 단이 `AgentConfig.mode`를 실제로 세팅하게** | UI가 "파일 안 건드림"이라 표시하고 실제로는 안 막음(§14.3) |
| 추가-B | `src/subagent/role.ts` **삭제 또는 배선**(INERT 확정) | 강제로 읽히는데 소비자 0 = 감사 오도 |
| 참고-B2 | `subagent-typed/mode-registry.ts`는 "계약 위임 + 기본 OFF" — 삭제 대상 아님 | 1차 판정 정정 |
| 참고-B3 | `RunMode.AgentMode` ↔ 프롬프트 `AgentMode` 동명이형 리네임 | 유지보수 위험 |
| **추가-0** | **캐시 브레이크포인트 5개 초과 수정** — 대화 브레이크포인트를 예산에 편입 + 그 조합의 헬게이트 테스트 | **하드 API 거부**, 현재 미테스트 (§14.2.1①) |
| **추가-C** | `ReplayIdentityV2` — provider-visible semantic request를 해시하고 local id/cache transport metadata 제외, sampling identity 포함. 날짜는 마스킹하지 않고 캠페인 `now`를 고정 | exact replay의 의미 보존 + cross-run 안정성 (§14.2.1②) |
| 추가-D | 카세트 스크러버 production 강제 + request 없는 `RecordingGap` | 원본 프롬프트·툴출력 및 degraded sentinel 누출 방지 (§14.2.1③) |
| 추가-E | `TurnContextInput.env` 배선 또는 삭제 | git status가 프롬프트에 안 들어가는 사문 경로 |
| 참고 | 프롬프트 크기 3배(5.3k vs 1.75k)의 효용 미측정 | 측정 후 감량 여지 |

---

## 15. 최종 실행 정본 — 모듈별 병렬 lane

### 15.0 기준과 현재 상태

- 이 절은 §11·§13·§14.4의 **교체본**이다. 새 발견은 해당 표에 덧붙이지 말고 이 절의 lane/보류표를 갱신한다.
- 문서 편집 중에도 `HEAD`가 `4c1ce01719ef24e669de1ddeb370544304d92e7c`에서 `27e7bc6cd1b8cccac0cf32873ba043d91575db08`로 이동했고 dirty 목록도 바뀌었다. 따라서 이 문서의 SHA는 실행 snapshot이 아니다. 구현 시작 시 한 coordinator가 `git rev-parse HEAD`와 `git status --short --branch`를 다시 기록하고 그 뒤 lane을 분기한다.
- 마지막 관측에서 `src/agent/stop-category.ts`, `src/host/runtime/internal/context-binding/approval-support.ts`, `tests/unit/agent/stop-category-producer-completeness-hellgate.test.ts`가 dirty였다. **T-lane 선점 변경 후보**이므로 W0에서 diff의 소유자·의도를 고정하기 전에는 잃거나 다른 lane에서 동시에 편집하지 않는다.
- 병렬화 단위는 아이디어가 아니라 **write set**이다. 같은 front door(`stream-consume.ts`, kernel terminal reducer/event, CLI session driver)를 건드리는 항목은 한 lane에 합치거나 integration wave에서 직렬화한다.
- 각 lane은 독립 worktree/branch를 쓴다. 권장 branch는 `codex/aug23-grok-<lane>`이다. 공유 worktree의 dirty overlay는 구현 근거나 테스트 receipt로 사용하지 않는다.

### 15.1 전체 DAG

```text
W0  snapshot + dirty-owner freeze + baseline RED
 |
 +--> Wave 1 (최대 4병렬, owner-disjoint)
 |      C cache-budget
 |      R replay-recording
 |      T terminal-control-loop
 |      A activity-spine
 |
 +--> Wave 2 (Wave 1 merge 뒤 최대 4병렬)
 |      M mode-tool-projection
 |      S synthetic-provenance
 |      P plan-resume
 |      E env-config-consumer-audit
 |
 +--> Wave 3 (직렬 integration)
        I1 protocol generation + CLI/web/VS Code/headless receipts
        I2 full regression + feature catalog + exact-SHA closeout
```

Wave 1의 네 lane도 아래 exclusive write set을 지킬 때만 병렬이다. T는 CLI/web/VS Code 파일을 직접 만지지 않고 terminal contract까지만 만든다. A의 CLI 소비자 연결, shared presenter 생성, T의 surface 연결은 Wave 3 integration owner가 직렬로 수행한다.

### 15.2 W0 — 무조건 먼저: 변경 격리와 RED 고정

| 항목 | 실행 계약 |
|---|---|
| snapshot | source SHA, branch/upstream, dirty/untracked 목록, runtime profile, Bun 버전을 receipt에 저장 |
| dirty 분류 | 각 변경을 `KEEP/current-lane`, `UNRELATED/user-owned`, `DROP`으로만 분류. 추정으로 되돌리거나 합치지 않음 |
| owner lock | 아래 lane별 exclusive write set을 선언. 겹치면 worker를 더 띄우지 말고 merge wave를 조정 |
| RED | 실제 shipped front door에서 실패하는 최소 테스트를 먼저 작성. 소스 문자열 존재 테스트만으로 시작 금지 |
| anti-vacuum | production call/use를 요구하고 known-item floor를 둠. guard mutation/injection으로 정확히 RED가 되는지 증명 |
| stop | baseline 자체가 비결정적이거나 dirty overlay 없이는 재현되지 않으면 구현 중단 후 원인부터 분리 |

### 15.3 Wave 1 — 독립 owner 4병렬

#### C — Cache breakpoint hard budget (P0)

- **목표**: 최종 Anthropic wire payload의 cache breakpoint가 어떤 조합에서도 4개를 넘지 않게 한다.
- **authority/write set**: `src/llm/anthropic-messages-codec.ts`, 신규 `src/llm/cache-breakpoint-budget.ts`, `src/agent/prompt-sections.ts`, cache 관련 unit/hellgate. 다른 lane은 이 파일을 쓰지 않는다.
- **구현**:
  1. system section과 conversation prefix가 공유하는 `CacheBreakpointBudget`을 최종-wire owner에 둔다.
  2. 1차 정책은 기존 system marker를 보존하고, 남은 예산이 없으면 conversation marker를 생략한다.
  3. codec 직전 실제 wire count를 다시 세어 `<= 4`; 초과는 fail-fast한다.
  4. 효율 최적화는 별도 P1 측정으로 분리한다. `4+0`과 `3+1` hit/token/cost를 비교하기 전 정책을 바꾸지 않는다.
- **RED/negative**: base+repo+session+user-append+conversation 조합이 현재 5개로 RED; 각 system section 하나를 제거한 조합과 non-Anthropic adapter는 GREEN이어야 한다.
- **완료**: mock 객체가 아니라 adapter가 실제 전송할 payload receipt에서 marker `<=4`, 기존 TTL/section ordering 불변, 관련 unit+adapter contract 통과.

#### R — Replay identity + recording confidentiality (P0)

- **목표**: 동일한 모델 의미 요청은 안정적으로 재생하고, 다른 샘플링 요청은 충돌하지 않으며, 카세트가 비밀을 평문 보존하지 않게 한다.
- **authority/write set**: `src/llm/replay/**`, `src/llm/with-recording-lane.ts`, replay/recording tests. bench 조립 변경은 이 lane만 소유한다.
- **구현**:
  1. `ReplayIdentityV2`는 provider-visible messages/system/tools/toolChoice/thinking과 provider/model/effective max output/temperature 등 sampling identity를 canonicalize한다.
  2. local message id, phase, `promptCacheKey`, retention 등 cache/transport metadata는 identity에서 제외한다.
  3. 날짜는 마스킹하지 않는다. cross-day 캠페인은 `TurnContextInput.now`를 campaign manifest에서 고정한다.
  4. key에 version을 포함하고, v1 fallback은 명시적 legacy 옵션에서만 허용한다. silent dual lookup 금지.
  5. production recorder는 scrubber 필수. append 불가 시 verified benchmark는 fail-closed한다.
  6. degraded 상태는 full request/events를 재기록하지 않는 `RecordingGap`만 남긴다. interactive diagnostic만 safe gap + warning을 허용한다.
- **RED/negative**: UUID/cache key만 다른 요청은 같은 v2 key, model/temperature/max output 하나가 다른 요청은 다른 key; secret fixture는 정상/partial/error/gap 어느 record에도 없어야 한다.
- **완료**: replay hit/miss reason과 key version이 receipt에 남고, v1 accidental reuse 및 raw-secret injection test가 RED.

#### T — Terminal truth + structured failure + stationarity (P0)

- **목표**: 실패·중단·정체·출력잘림을 정상 완료로 접는 모든 경로를 하나의 terminal authority에서 제거한다.
- **authority/write set**: `src/agent/stop-category.ts`, `src/agent/loop/{types,stream-consume,recovery-executor,stop-conditions,turn-loop}.ts`, `src/agent/dispatch-dedup.ts`, `src/agent/recovery.ts`, `src/kernel/session/{scheduler-turn-terminals,reducer}.ts`, `src/protocol/session/events.ts`, terminal/protocol tests. 현재 dirty T 파일도 이 lane만 소유한다.
- **구현 순서**:
  1. `StopCategory.reasonCode: string`을 닫힌 `StopReasonCode`로 바꾸고 producer table을 exhaustive하게 만든다.
  2. provider의 `LLMErrorKind`를 `StreamConsumeResult -> RecoveryAction -> TurnResult`까지 구조적으로 보존한다. regex는 legacy fallback으로만 남기고 fallback telemetry를 센다.
  3. terminal event를 `completed | stopped | failed | aborted`로 분리한다. `max_turns`, `budget_exhausted`, `refusal`, `no_progress`, `model.output_truncated`는 `TurnStoppedEvent`; approval/input은 pause event다.
  4. `max_tokens` continuation 소진은 visible marker만 붙이고 끝내지 말고 `model.output_truncated` non-success로 귀결한다.
  5. `DedupGate` verdict를 `{fingerprint, regulation, count}`로 만들고, 첫 block은 steer, sampling round를 넘어 동일 blocked-equivalent이며 실질 progress가 없으면 `no_progress.stationarity`로 종료한다. reset은 성공한 distinct observation 또는 실제 mutation에서만 한다.
  6. `awaitingApprovalCategory()`가 모든 승인을 `shell.needs_approval`로 오분류하지 않게 한다. 공통 `approval.required` 또는 실제 `ToolAction` 기반 code를 쓴다.
- **RED/negative**: max turns, budget, refusal, empty exhausted, malformed tool use, output truncation, stationarity가 `turn.completed`로 가면 RED; user abort와 provider failure가 stopped로 섞여도 RED; approval 대기가 terminal이면 RED.
- **완료**: terminal classifier exhaustive, producer completeness + red-on-mutation, protocol codec/generator 통과. surface 렌더 receipt는 Wave 3에서 닫는다.

#### A — Existing activity spine에 turn projection (P1)

- **목표**: 새 상태 저장소 없이 턴 전체/현재 작업의 이중 시계와 실제 대기/정체 이유를 기존 activity spine에서 노출한다.
- **authority/write set**: `src/activity/**`, turn activity producer 신규 파일, activity tests. CLI renderer/front door는 Wave 3 전까지 수정하지 않는다.
- **구현**:
  1. 기존 root/child `startedAt`을 turn elapsed/current operation elapsed로 투영한다.
  2. stable id는 `toolCallId`, request/task id를 사용한다. 설명 문자열 변경으로 시계를 재시작하지 않는다.
  3. 새 `PhaseKey` store와 별도 `WaitingReason` enum은 만들지 않는다. 기존 `StuckReason`을 exhaustive하게 필요한 만큼만 확장한다.
  4. 완료 뒤 살아 있는 task/monitor는 idle watcher child로 남긴다.
- **RED/negative**: 같은 작업의 label만 바꾸면 child 시작시각 불변; 실제 tool/request id 변경 시에만 재시작; 완료 후 monitor가 있으면 activity가 사라지면 RED.
- **완료**: activity projection unit + fake clock 통과, 구독자가 상태를 재구성하지 않고 spine snapshot만으로 동일 렌더 가능.

### 15.4 Wave 2 — Wave 1 merge 뒤 4병렬

#### M — Live AgentMode + visible tool projection (P1)

- **목표**: Shift+Tab plan 표시를 실제 `AgentConfig.mode`에 연결하고, 모델이 보는 툴과 dispatch 가능한 툴을 동일 authority로 만든다.
- **authority/write set**: `src/agent/mode.ts`, `src/agent/loop/{skill-gate,skill-scope-view,stream-consume}.ts`, 신규 generic tool projection 모듈, `src/apps/cli/mode-cycle.ts`, CLI session driver와 관련 tests.
- **구현**:
  1. skill 전용 `filterSpecsByScope`를 mode authority로 재사용하지 말고 generic final-wire projection을 추출한다.
  2. visible set은 `registered ∩ surface/profile ∩ skill ∩ agent mode`; dispatch gate도 같은 predicate/manifest 결과를 사용한다.
  3. 기존 `isMutatingMode`/`isMutatingTool`을 변경 가능성 SSOT로 유지한다. 미분류 tool은 fail-closed한다.
  4. Shift+Tab `plan`이 매 턴 실제 mode를 세팅하고 상태 pill은 그 effective mode를 읽는다.
- **RED/negative**: plan UI인데 mutating tool이 visible하거나 dispatch되면 RED; normal/bypass에서 허용 tool이 사라지면 RED; unknown tool이 보이거나 허용되면 RED.
- **완료**: visibility-dispatch parity, mode cycle PTY, bypass/HARD_DENY negative control 통과. `src/subagent/role.ts`는 실제 owner가 없으면 별도 삭제 commit으로 처리한다.

#### S — Synthetic message provenance (P1)

- **목표**: message id를 provenance로 오용하지 않고, persisted synthetic user message를 저장/포크/되감기/압축 후에도 식별한다.
- **authority/write set**: `src/agent/synthetic-user.ts`, message persistence/fork/rewind/compaction adapters, provenance tests. T/M lane 파일이 필요하면 직접 수정하지 않고 integration patch로 넘긴다.
- **구현**:
  1. 부록 A의 50개 혼합 채널을 그대로 producer 수로 세지 않는다. persisted user message, transient prompt block, tool result, assistant rewrite, UI observation으로 machine census한다.
  2. message id는 identity만 담당한다. local-only metadata에 닫힌 `syntheticReason`을 둔다.
  3. save/load/fork/rewind/compaction에서 metadata를 보존하고 provider adapter 직전에만 제거한다.
  4. legacy `<SYN>`/id-prefix는 load migration에서만 해석하고 새 write에는 사용하지 않는다.
- **RED/negative**: synthetic message가 round-trip 후 human으로 바뀌거나 metadata가 wire에 노출되면 RED; 실제 human message가 synthetic으로 분류되어도 RED.
- **완료**: producer census receipt, migration/round-trip/adapter-strip E2E, boundary/compaction consumer가 metadata authority를 사용.

#### P — Existing PlanStore restart/resume closure (P1, 제품 요구 확인 후 BUILD)

- **목표**: 별도 `plan.md` SSOT를 만들지 않고 기존 typed `PlanStore`/`planSnapshotStore`로 승인 대기 상태를 재시작 후 복구한다.
- **authority/write set**: `src/agent/plan/**`, `src/agent/plan-exit-*.ts`, `src/apps/cli/repl/factories/plan-store.ts`, kernel/session persistence adapter와 plan tests.
- **구현**: plan snapshot과 pending approval identity를 동일 session checkpoint에 원자적으로 저장하고, reopen 시 승인 요청을 한 번만 재발행한다. snapshot만 있고 approval identity가 없으면 fail-closed paused로 복구한다.
- **RED/negative**: kill 직전/직후, torn final write, 중복 reopen, stale plan version을 주입한다. 중복 승인·자동 실행·plan 유실은 RED.
- **완료**: `start -> plan approval pending -> kill -9 -> reopen -> approve/reject` 실제 프로세스 E2E. restart-resume가 제품 요구가 아니면 구현하지 않고 PARK 근거를 남긴다.

#### E — Existing trust/config authority와 env dead-wire audit (P2)

- **목표**: 새 trust/config subsystem을 만들지 않고 기존 authority를 모든 실행형 consumer가 사용하게 하며, 죽은 env/repo-map knob는 배선 또는 삭제한다.
- **authority/write set**: `src/config/{merge,trust-store}.ts`, `src/agent/env-context.ts`, context assembler/bootstrap 소비자, 관련 trust/env tests.
- **구현**:
  1. hooks, MCP, endpoint, credential helper, plugin/app, LSP executable config가 기존 workspace trust 결정을 우회하는지 consumer census한다.
  2. 우회 consumer만 기존 authority에 연결한다. 별도 trust store/overlay 계층은 금지한다.
  3. `TurnContextInput.env`, `probeTurnEnv`, `probeRepoMap`, `AgentConfig.repoMap`은 한 `TurnEnvironmentProvider` owner로 연결하거나 knob/docs/types를 삭제한다.
  4. 기본 경로에 매 턴 `git status` subprocess를 추가하지 않는다. TTL/event invalidation 또는 session snapshot 정책을 명시한다.
- **RED/negative**: untrusted workspace에서 각 실행 consumer를 하나씩 주입해 fail-closed 확인; env knob ON인데 wire prompt 변화가 없거나 OFF인데 subprocess가 실행되면 RED.
- **완료**: consumer inventory와 negative receipt, dead knob 0. authority 신규 복제 0.

### 15.5 Wave 3 — 공유 front door 직렬 integration

Wave 3는 병렬 금지다. 앞 lane들이 일부러 건드리지 않은 공유 surface를 한 owner가 현재 merged SHA에서 연결한다.

1. **Protocol/generator**: `TurnStoppedEvent`와 pause/failed/aborted를 session protocol, codec, generated clients에 반영하고 drift 0을 확인한다.
2. **Terminal presenter**: `Record<StopReasonCode,{label,tone,exitClass}>` 하나를 만들고 CLI, web, VS Code, headless가 이를 소비한다. 각 surface의 unknown/default-to-success 분기를 제거한다.
3. **Activity consumer**: CLI spinner/status가 activity spine snapshot을 소비하고 별도 phase/reason 재구성을 하지 않게 한다.
4. **Shared-loop patches**: S/M/P lane이 제출한 integration patch를 `stream-consume.ts`, session lifecycle/driver에 하나씩 적용하고 매 적용 후 focused tests를 돌린다.
5. **Real front-door matrix**:

| 시나리오 | CLI | web | VS Code | headless/protocol |
|---|---:|---:|---:|---:|
| completed.normal | 성공 표시 | 성공 표시 | completed | exit 0 + completed event |
| max_turns/budget/refusal | stopped + 정확한 code | stopped | stopped | non-success + stopped event |
| provider failure | failed | failed | failed | error exit + failed event |
| user abort | aborted | aborted | aborted | signal/user-abort event |
| approval/input wait | paused, 재개 가능 | paused | paused | pause event, terminal 아님 |
| stationarity/output truncation | stopped + 정확한 code | stopped | stopped | non-success + stopped event |

### 15.6 ALREADY / DROP / PARK — 다시 만들지 말 것

| 판정 | 항목 | 처리 |
|---|---|---|
| ALREADY | workspace trust store, config overlay merge | consumer coverage만 감사. 새 subsystem 금지 |
| ALREADY | kernel session JSONL torn-final-line repair + single-writer lock | global JSONL abstraction 금지. retry 의미가 필요한 writer에만 committed/not-committed 계약 |
| ALREADY | `too_many_failed_attempts` decorator/routing/tests | 신규 decorator 티켓 삭제; T-lane structured provenance와 연결 여부만 확인 |
| ALREADY | `.scratch-prompt` 제거 | 재작업 금지 |
| ALREADY | typed `PlanStore` + optional snapshot port | Grok식 `plan.md` SSOT 복제 금지 |
| DROP | 새 `PhaseKey` store / 별도 `WaitingReason` enum | 기존 activity spine/`StuckReason` 사용 |
| DROP | 날짜 regex masking을 exact replay 해법으로 사용 | campaign `now` 고정 + semantic identity 사용 |
| PARK | 파일경로별 write lock | 현재 barrier 방식의 실측 병목/안전성 손실 없이는 복잡도 불필요 |
| PARK | server doom signal, PreToolUse target rewrite | provider/hook authority와 threat model을 먼저 확정 |
| PARK | 조기하차 regex를 control-flow로 사용 | telemetry label로만 실험; 종료 authority로 승격 금지 |
| PARK | prompt tone/크기 감량, hashline edit, MCP indirect exposure | ablation/비용 자료 후 결정 |
| PARK | global recovery cap | 실패 종류별 budget과 terminal truth가 먼저. 임의 전역 상한 금지 |
| DROP/PARK | `src/subagent/role.ts` | 소비자 owner가 없으면 삭제; 미래 배선을 이유로 강제 연결하지 않음 |

### 15.7 각 lane 공통 완료 계약

다음 항목이 하나라도 없으면 branch는 merge-ready가 아니다.

- start SHA / result SHA / branch / clean-or-dirty 상태
- exclusive write set과 실제 `git diff --name-only` 일치
- authoritative RED signature와 fix 후 GREEN
- paired negative control
- guard의 red-on-injection 또는 red-on-mutation 증명
- owner-local tests + `bun run typecheck`
- 변경 범위에 따른 `bun run lint:debt`, god-code ratchet
- public/front-door receipt. helper unit test만으로 완료 금지
- gate/default-OFF 변경이면 OFF byte/parity receipt
- 기능 maturity/evidence가 바뀌면 해당 feature YAML 수정 후 `bun fc validate && bun fc build`; 생성 MD 직접 편집 금지
- `git diff --check`, protocol generator drift 0, 최종 exact SHA와 잔여 dirty 목록

전체 closeout은 위 조건에 더해 full unit/integration/contract 범위, real CLI PTY 또는 실제 provider wire receipt, 모든 surface terminal matrix를 요구한다. 기존의 targeted 90-test green과 typecheck green은 조사 시점 관측일 뿐 이 실행계획의 완료 증거가 아니다.

---

## 부록 A — quanta 하네스→모델 주입 전수 (50개 / 8채널)

다시 뽑기 비싼 인벤토리라 보존. 상세 file:line은 조사 원본 참조.

**채널1 — 턴마다 붙는 단일 `<system-reminder>` user 메시지** (`prompt.ts:786-795`, 조립 `prompt-reminders.ts:273-293`)
날짜 / 작업디렉토리 / 모드 공지 / BRIEF 공지 / 행동 지시문 7종+ / 언어 힌트 / Environment 블록 / repo 규칙 / glob 규칙 / 활성 스킬 카탈로그 / 워킹 스테이트 / 회상 메모리 / 훅 컨텍스트 / 소프트 태스크 예산 = **14 서브블록**

**채널2 — 별도 메시지로 스플라이스**
`<hook-context>` / 컨텍스트 변경 이벤트 8종(`<context-update>`, `<mode-change>`, `<repo-rules-change>`, `<skill-activation>`, `<reasoning-echo>`, `<compaction-event>`, `<plugin-activation>`, `<app-activation>`) / 멘션 주입

**채널3 — 마지막 사용자 메시지에 prepend**
IDE 컨텍스트 블록 / 시크릿 redaction 비활성 배너

**채널4 — working memory에 mid-loop append (전부 role user)**
focus-chain 투두·드리프트 / 정체성 리마인더 / 워크플로 키워드 넛지 / **턴 예산 꼬리 리마인더** / steer 배리어 드레인 / same-turn steer safepoint / conversation-action(weave) / **재개 메시지** / 후속 큐 / **피어 인박스** / same-turn 복구 넛지 4종(출력한계·깨진툴·빈응답·거부폴백) / verify-guard 강제 / closeout-guard / 중화된 거부 assistant 턴 / 잘림 마커 / tool_result 캐리어

**채널5 — tool_result 내부에 하네스 텍스트**
cap 강제 리마인더 / repro-doubt steer / **dedup-gate 관찰**(3규제) / localize-phase 차단 + LSP 그라운딩 steer + CHA multisite steer / `deny_and_steer` + READONLY 노트 / 기타 거부 문자열 / `<untrusted-source>` 봉투 / `<deferred>` 토큰 / lint 델타 / edit-repair 판정 / stale-read 리마인더 / read-mode 거부 안내

**채널6 — 히스토리 재작성**
선제 압축 요약 / 반응형(PTL) 계속 요약 / 백그라운드 요약 설치 / `/summarize-now` / 마이크로컴팩션 tool_result 축출 / 재개시 고아 tool_result 스텁 / 잘못된 이미지 자리표시자

**채널7 — 플랜모드·훅 `injectAfterSystem`**
플랜 승인/변경요청/거부/진입 4종 / LSP 편집후 진단 / 서브에이전트 start·stop 훅 / no-patch 브레이커 넛지 / 외부 command-hook 컨텍스트

**채널8 — 관측 커널**
`<quanta_observations>` — **유일하게 mid-turn 아님**(벤치 초기 프롬프트에만, `QUANTA_OBS_RENDER` 게이트)

**태그 현황**: `synthetic-user.ts`의 5종(`same-turn-recovery`/`hook-context`/`context-change`/`mention-injection`/`focus-chain`)만 표식. 나머지 무표식.
