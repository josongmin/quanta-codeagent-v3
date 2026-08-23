# Grok Build (xai-grok, Rust) — 전 기능 인벤토리 / 아키텍처 해부

> **수집 방법**: xAI 공식 오픈소스 저장소 `github.com/xai-org/grok-build` **풀 소스 직접 판독**.
> Codex/Cursor 문서와 달리 런타임 포렌식(rollout 파싱)이 아니라 **소스 그 자체**이므로
> 이 문서의 거의 모든 항목은 `file:line` 근거를 가진 **FACT**다. 추론은 명시적으로 INFERENCE 태그.
>
> - 클론: `~/Documents/code-new/competitor-scaffolds/grok-build`
> - `SOURCE_REV` = `7d67dea` (사내 모노레포 커밋 SHA). 공개 커밋 35개 전부 "Synced from monorepo" — **git 히스토리 없음**
> - 규모: **1,657,018 Rust 라인 / 2,765 파일**. first-party 1,630,968 (그중 `crates/codegen` 1,575,347 = 95%), `third_party/` 26,050
> - 라이선스: **Apache-2.0** (first-party). 외부 기여 미수용(CONTRIBUTING.md)
> - 조사: 6축 병렬 1바퀴(TUI / 런타임 / 툴 / 워크스페이스·권한 / CLI·설정 / 프로토콜·확장성) + 적대검증 3건
>
> **⚠️ 완성도 고지**: 본 문서는 **1바퀴 6축 전량 회수** 완료본이다. 다만 2바퀴(누락 메우기)·3바퀴(적대 검증)는 미실시.
> §12에 미확인 항목을 명시했다. 1차 보고 중 이미 3건이 오류로 판명된 전례가 있으므로(§12-B) 3바퀴 전까지 단정 금지.

---

## 0. 저장소 구조 / 빌드 / 공개 범위

### 0-1. crate 맵 (FACT)

| 경로 | 내용 |
|---|---|
| `crates/codegen/xai-grok-pager-bin` | 컴포지션 루트. 바이너리 `xai-grok-pager` (공식 배포명 `grok`) |
| `crates/codegen/xai-grok-pager` | TUI (스크롤백/프롬프트/모달/렌더). **537 rs 파일, views만 67.8K줄** |
| `crates/codegen/xai-grok-pager-minimal` | scrollback-native 미니멀 렌더러 (별도 구현) |
| `crates/codegen/xai-grok-pager-render` | 렌더 프리미티브·테마·클립보드 |
| `crates/codegen/xai-grok-shell` | 에이전트 런타임 + leader/stdio/headless 엔트리 |
| `crates/codegen/xai-grok-tools` | 툴 구현 50종 |
| `crates/codegen/xai-grok-workspace` | 파일시스템/VCS/실행/체크포인트/권한 |
| `crates/codegen/xai-grok-sandbox` | Landlock/Seatbelt 샌드박스 |
| `crates/codegen/xai-grok-mcp` | MCP 클라이언트 (rmcp 2.1 격리용 quarantine crate) |
| `crates/codegen/xai-acp-lib` | ACP 트랜스포트 하드닝 |
| `crates/codegen/xai-grok-hooks` | 훅 엔진 |
| `crates/codegen/xai-workflow` | Rhai 워크플로 엔진 (저널/리플레이) |
| `crates/codegen/xai-grok-telemetry` | 텔레메트리 (이벤트 구조체 111개) |
| `crates/codegen/xai-grok-foreign-sessions` | **경쟁사 세션 임포터** (Claude/Codex/Cursor) |
| `crates/common/`, `crates/build/`, `prod/mc/` | 공유 leaf crate |
| `third_party/` | vendored Mermaid 스택 |

루트 `Cargo.toml`은 **생성물**이며 read-only 명시. 모든 crate에 `default-bazel` feature가 있으나 **`BUILD`/`MODULE.bazel` 파일은 미공개** → 사내 빌드는 Bazel, 공개 경로는 cargo.

### 0-2. 공개 vs 비공개 (FACT)

**공개된 것 (예상보다 정직)**
- **시스템 프롬프트 전량 평문**: `xai-grok-agent/templates/prompt.md` (6,992 B), `apply_patch_prompt.md` (21,360 B), `subagent_prompt.md` (5,502 B), goal 계열 템플릿 ~50 KB, `xai-grok-compaction/src/templates/*.txt`
- 난독화 레이어(`src/prompt/prompt_encrypted.rs`, XOR seed 0x5A/0x7B/0x3D, 생성기 `scripts/encrypt_templates.py`)가 있으나 **복호화 결과가 평문 템플릿과 sha256 일치**(적대검증 확인). 소스 주석에 "obfuscation, not security — seeds live in-repo"(`template.rs:3-4`) 자인. 런타임은 암호화 배열을 사용하고 평문은 staleness 테스트에서만 참조(`template.rs:76-93`)
- **단독 빌드 가능**: `cargo metadata --offline` 통과, 93 패키지 전량 해결. git 의존 2개 모두 공개(`our-forks/async-openai`, `helix-editor/nucleo`)
- **테스트 포함**: `tests/` 420 파일, `#[test]` 포함 1,582 파일, PTY e2e, mock 서버
- **모델 백엔드 교체 가능**: `[model.<id>]`에 `base_url`/`api_key`/`extra_headers`, `api_backend` = `chat_completions|responses|messages`. `[endpoints]`로 전 URL override

**비공개**
| 항목 | 성격 |
|---|---|
| 사내 Bazel 빌드 | 정당(사내 인프라) |
| 텔레메트리 목적지 | `internal_defaults()`가 전부 `None`, 빌드타임 `option_env!("GROK_TELEMETRY_BUILD_*")`. **소스 빌드는 전송처 없음** = 사용자에 유리 |
| `cli-chat-proxy` 서버 | 정당(별개 서비스) |
| `docs/internal/` | 부작용: `tests/registered_features_are_documented.rs:7-8`이 `include_str!`로 참조 → **그 테스트 타깃 컴파일 불가** |
| **eval 하네스** | ⚠️ 유일하게 의미심장. 에이전트 품질 벤치마크/fixture 전무. `session_recap.rs:35` 주석 "Keep in sync with the recap prompt eval harness" — 그 하네스는 모노레포에만 |

### 0-3. 텔레메트리 (FACT)

이벤트 구조체 111개(`xai-grok-telemetry/src/events/mod.rs`), Mixpanel + Sentry + OTel + per-turn feedback client.
`PromptSubmitted`는 **`prompt_length`만** 전송, `prompt_text`는 `#[serde(skip)]` — `OTEL_LOG_USER_PROMPTS` 게이트 시에만 60 KB 상한·시크릿 스크러빙 후 전송(`events/mod.rs:1111-1128`). opt-out 실동작(`[features] telemetry`, `GROK_TELEMETRY_ENABLED`, `/privacy`).

---

## 1. 에이전트 루프

### 1-1. 턴 구조 (FACT)

이중 루프. **바깥 = 라운드**(`acp_session_impl/turn.rs:916-995`, `handle_turn_input`), **안 = 샘플링**(`turn.rs:2139`, `process_conversation_turn`). 안쪽 1회 = 샘플 1회 + 병렬 툴 배치 1회.

```
TurnOutcome (acp_session_impl/types.rs:67)
├ Completed { snapshot, tools_called, structured_output, refusal }
├ Cancelled { category }
├ MaxTurnsReached { limit }
└ StationarityEnded
```

`CancellationCategory` (`xai-grok-session-events/src/types.rs:637`) = `HookDenied | PermissionRejected | PermissionCancelled | MidTurnAbort`

**안쪽 루프 종료 3조건 동시 충족 필요**: 툴 호출 없음 **AND** TodoGate 통과(`turn.rs:2695`) **AND** 인터젝션 없음.
**바깥 루프 재개**: goal 계속 + stop-hook (`stop_gate.rs:9`, `MAX_STOP_HOOK_CONTINUATIONS_PER_TURN = 8`).

### 1-2. 정지 상한 — 턴 수가 아니라 "제자리걸음" (FACT · 흡수 후보)

`--max-turns`는 `Option`, **기본값 없음**(`app/cli.rs:684`), 그리고 **TUI에선 경고 후 무시**(`app/event_loop.rs:1018-1027`) = 헤드리스 전용.

진짜 상한은 **action-stationarity 탐지기**(`turn.rs:3024-3090`):
- 툴 *스텝 전체*를 **순서 무관 해시**
- 8회 반복 → nudge, 12회 → 하드 스톱
- `Read|Plan` kind는 **4/4**로 조임
- `true` 류 keepalive no-op은 4회

추가로 completion-requirement 자동복구 + 지수 백오프(`turn.rs:1610-1745`).

### 1-3. 툴 디스패치 (FACT)

- `FuturesUnordered` + drainer → mpsc, **완료 순서로 처리하되 사전 인덱싱된 슬롯**에 배치(순서 보존) — `tool_calls.rs:704-745`
- **같은 파일 쓰기만 경로별 `Mutex`로 직렬화**, 그 외 완전 동시 — `tool_dispatch.rs:41-57`
- `exit_plan`은 tail 배치로 분리 — `tool_calls.rs:366-374`
- wait 계열은 `tokio::select!`로 사용자 인터젝션과 경합 — `tool_calls.rs:660-685`
- **speculative/early dispatch 없음**(부분 인자 JSON으로 미리 안 쏨)

### 1-4. 컨텍스트 관리 (FACT)

| 항목 | 값 | 근거 |
|---|---|---|
| 자동 컴팩션 임계 | 윈도우의 **85%** (추정 토큰 기준) | `session/compaction_config.rs:12,45` |
| 요약 템플릿 | 7섹션 | 동일 |
| 모드 | `Summary` \| `Transcript` \| `Segments` | `xai-chat-state/src/compaction_mode.rs:16` |
| prefire 컴팩션 | 임계−10%p에서 백그라운드 선요약, fingerprint 검증. **지연 숨김용이지 컨텍스트 절약 아님**. 기본 OFF | `[features] two_pass_compaction` |
| 이미지 예산 | **47 MB 트리거 → 25 MB 회수** 히스테리시스. 목적이 **KV prefix 캐시 보호**로 명시 | `xai-chat-state/src/image_budget.rs:41-60` |

### 1-5. 서버측 doom-loop 탐지 (FACT · 특이)

- 요청 헤더 `x-grok-doom-loop-check`로 탐지 윈도우 전달
- **프로바이더가 생성 도중** `response.doom_loop_check` SSE 프레임으로 누적 `tail_repetition:{t}@{channel}` 트리거 방출
- 클라이언트가 **SSE를 중간에 끊고 재샘플**, 예산 2회
- **`thinking` 채널에만 적용** — 가시 출력의 반복은 사용자가 판단할 몫이라는 이유(`doom_loop.rs:83`)
- 기본 **ON**

근거: `xai-grok-sampling-types/src/doom_loop.rs:24-134`, `xai-grok-sampler/src/stream/responses.rs:204`, 정책 `DoomLoopRecoveryPolicy::is_confident(:127)`

> **우리 적용성**: 프로바이더를 소유해야 가능. 발상(스트림 중간 루프 탐지→즉시 중단)만 이식 가능.

### 1-6. stop reason 파싱 방어 (FACT · 싼 흡수)

프로바이더 stop reason enum에 **untagged `Unknown(String)`**을 둠 — 서버가 새 값을 뱉어도 파싱 실패로 **이미 스트리밍된 응답을 통째로 폐기하는 사고**를 막음. `xai-grok-sampling-types/src/messages.rs:230-244`

### 1-7. 서브에이전트 (FACT)

- 인프로세스 thread + LocalSet
- **`MAX_SUBAGENT_DEPTH = 1`** (`xai-grok-tools/.../task/mod.rs:39`), **2중 강제**: 하드 거부 + 자식 툴 표면에서 `task` 툴 제거(`subagent/handle_request.rs:357-377`)
- admission control: 동시 32 + 큐
- `attempt_store/` **4,525줄(비테스트 2,776줄)이 통째로 dead** — `mod attempt_store;` private 선언 외 참조 0, 문서 주석 "No-caller canonical attempt records". best-of-N 없음

### 1-8. leader 모드 (FACT)

flock 선출 per-machine 데몬이 에이전트 1개를 소유하고 다수 클라이언트를 멀티플렉싱. 길이-접두 JSON이 opaque ACP payload를 운반(`leader/protocol.rs:22-56`). `ClientMode`는 `Stdio | Headless` 2종뿐(`protocol.rs:107`).
**기본 OFF**, 샌드박스 프로필이 non-off면 leader 거부.

---

## 2. 에이전트 런타임 · 세션 영속화

### 2-0. 실행 모델 골자 (FACT)

- 세션 = **전용 OS 스레드 + `LocalSet`**. 자식 서브에이전트도 **별도 프로세스가 아니라 같은 프로세스의 세션 액터 스레드**(`agent/subagent/handle_request.rs:947`). → 격리 경계는 프로세스가 아니라 **worktree / capability_mode / toolset**
- 상태는 **3개 액터**로 분리: SessionActor(커맨드 **125종**) / chat-state(**54종**) / persistence(메시지 **44종**). 전부 단일 FIFO라 순서 보장은 있으나 **전부 unbounded = 백프레셔 없음**
- **완료 판정을 모델에게 맡기지 않는 설계가 일관됨**: 턴은 12/8/4 stationarity 하드스톱, goal은 evaluator→적대 skeptic 패널 3단 게이트, 워크플로는 저널 divergence 검사
- `SessionLiveState` 6종: `Working / IdleResident / Dormant / Completed / DeadFailed / Attaching`(`session/handle.rs:14-37`) — **grok 세션은 pid가 아니라 "디스크 위 재개 가능한 로그"**
- supervisor 스윕이 `catch_unwind`로 panic한 액터를 `Dormant`로 강등(`session_lifecycle.rs:424-446`). busy 판정은 `IDLE_QUERY_TIMEOUT = 500ms`, 타임아웃/락 poison 시 **보수적으로 busy**

### 2-1. 🔴 토큰 회계가 전부 bytes/4 휴리스틱 (FACT · 중요)

토큰 추정 전체가 `bytes/4`다(`xai-token-estimation/src/lib.rs:9`). **실 토크나이저가 없다.**
그 위에 서 있는 것: **auto-compact 85% 게이트**, 프루닝 50% 게이트, 컨텍스트 바 표시.

예외 하나 — **이미지 예산만 직렬화 바이트를 정확히 센다**(`image_budget.rs:62-91`, `ByteCounter`). 413/RST가 실제로 아프기 때문.

**샘플러에 총 요청 타임아웃이 없다.** idle timeout 300초가 유일한 방어선이고, 클라이언트 측 rate limiter/세마포어도 없다.

### 2-2. 세션 디렉터리 · 파일 레이아웃 (FACT)

세션 id = client `_meta.sessionId`(**UUID 검증 필수**, 아니면 `invalid_params` 거부) 또는 `Uuid::now_v7()`.
디렉터리 `{grok_home}/sessions/{encode_cwd_dirname(cwd)}/{session_id}/`, **0700 원자 생성**(`DirBuilder.mode(0o700)`).

**cwd 인코딩**: URL-encode가 ≤255B면 그대로, 초과 시 `{slug≤40}-{blake3[..16]}`. hash-slug를 쓴 경우 `.cwd` 사이드카에 원본 cwd를 `create_new`(O_EXCL)로 기록.

**파일 20종**: `summary.json`(+`.lock`), `chat_history.jsonl`, `updates.jsonl`, `plan.json`, `plan_mode.json`, `signals.json`, `announcement_state.json`, `goal/state.json`, `rewind_points.jsonl`, `feedback.jsonl`, `btw_history.jsonl`, `title_refresh_idx`, `prompts/`, `workflows/`, `subagents/`, `compaction_checkpoints/`, `compaction_requests/`, `recap_requests/`, `compaction/`, `events.jsonl`

세션 생성 시 실제로 쓰는 건 **`summary.json` 하나**뿐. jsonl 2종은 첫 append 시 lazy 생성.
`Summary`는 **39필드**(git_root_dir/git_remotes/head_commit/head_branch/worktree_label/sandbox_profile/generated_title/title_is_manual/…), 대부분 `serde(default, skip_serializing_if)`.

### 2-3. 🔴 durability 기본값 = Buffered (fsync 없음) (FACT)

`append_jsonl()`이 **무조건 `AppendDurability::Buffered`** — `write_all` + `flush`, **fsync 안 함**(`jsonl/mod.rs:22-25, 242-245, 326-333`).

`Durable` 경로(`sync_file_durable` → drop → 부모 디렉터리 fd `sync_all`; macOS는 `sync_all` + `fcntl(F_FULLFSYNC)`)는 존재하나 **프로덕션 유일 호출자가 스케줄러 tombstone**(`ScheduledTaskDeleted`, ack 요청 시)뿐이다.
예외: **cwd-switch append만 항상 fsync**(durability 인자 없이 무조건 `sync_file` + `sync_parent` + summary도 durable).

전체 파일 원자적 재작성(`write_bytes_atomic`)은 유니크 sibling temp(`<path>.<uuidv7>.tmp`) → rename인데 **fsync 안 함(rename-only)**.

**append 파일 락**: tail 치유 + append + 배리어 전체를 `<name>.jsonl.lock` `fs2` exclusive flock 아래. 단 **전체 재작성은 이 락을 우회**한다(`:466-467`).

**★ 찢어진 tail 치유 (흡수 후보)**: append 직전 마지막 바이트가 `\n`이 아니면 새 줄 앞에 `\n`을 삽입해 **손상을 딱 한 줄로 가둔다** + warn(`jsonl/mod.rs:313-325`). 설계 주석에 "이전엔 없어서 resume이 벽돌됐다"고 명시.

**디스크 풀 감지**: ENOSPC/EDQUOT/StorageFull/Win 112·39 → watch 채널 `disk_full=true` + `RetryState::Failed{DISK_FULL}`(프로세스당 1회) + `.disk_ok` 프로브.
**append 실패를 커밋 상태로 3분류**: `AppendUpdateError::{NotCommitted, Committed}`, `DurableAppendError::{…, AcknowledgementLost}` — **재시도 안전 여부를 타입으로** 표현.

### 2-4. 대화 기록 포맷 (FACT)

`chat_history.jsonl` 레코드 6종(serde tag `type`, snake_case): `System`/`User`/`Assistant`/`ToolResult`/`BackendToolCall`/`Reasoning`

**`SyntheticReason` 17종**(어떤 경로로 주입된 user item인지): `CompactionMeta, SystemReminder, ProjectInstructions, AutoContinue, AutoRecovery, Interjection, AgentMessage, TaskCompleted, SubagentCompleted, NotificationDrain, GoalSummary, GoalClassifierNudge, SchedulerFired, StopHookFeedback, WorkingDirectorySwitch, Unknown(serde(other))` — `starts_prompt_turn()`이 **exhaustive match**.

**`Reasoning`을 assistant의 형제 아이템으로 저장** — 병렬 `tco_*` LWW 뭉갬 방지 + KV prefix 안정성. 구버전 `AssistantItem.reasoning`은 **로드 시 sibling으로 업그레이드하되 디스크는 미수정**(멱등).

`CHAT_FORMAT_VERSION = 1`(v0 = 레거시 `ChatRequestMessage`). 버전별 파싱 순서를 바꾸되 **양방향 폴백**.
별도 바이너리 `chat-history-downgrade <IN> <OUT>`으로 v1→v0 변환 가능(단 `--dry-run`/`--backup` 없음, 출력 무조건 truncate, 파싱 실패 시 fail-fast로 **부분 출력 잔존**).

**대형 프롬프트 사이드카**: `LARGE_PROMPT_THRESHOLD = 25,000 B` 초과 시 본문을 `prompts/prompt_{N}.txt`로 분리.

**손상 허용**: chat_history는 줄 단위 skip + 첫 스킵 시 `.corrupt` 복사본 1회 보존. updates도 UTF-8/JSON 실패 모두 스킵 카운트 후 계속.
**이미지 strip 전 백업 게이트**: 파괴적 재작성 전 `.pre-strip` 복사, **백업 성공해야만** 진행. 트레이트에 default 구현 없음 = 새 어댑터가 명시적으로 선택해야 함.

**`chat_rebuild`**: `chat_history.jsonl`이 없거나 0바이트면 `updates.jsonl`(durable SoT)만으로 재구성. CompactionCheckpoint 만나면 reducer reset + 출력 파일 truncate → **압축 이후만 남김**.

### 2-5. Resume / Fork / Rewind (FACT)

**실제 resume 경로는 `load_session_without_updates`** — `updates.jsonl`과 `rewind_points.jsonl`을 **안 읽고** 경로만 넘겨 lazy 로드(파일 전체 스냅샷이라 거대하므로). full `load()`는 `#[expect(dead_code)]`.

**Fork**: 소스 → 새 UUIDv7 + 새 cwd, `copy_session_data_sync`를 `spawn_blocking`에서.
- chat_history: 전체 materialize → (옵션)`target_prompt_index` 절단 → cwd 경로 재작성
- updates: 줄 단위 스트리밍 복사 + 세션 id 치환(`MAX_UPDATE_LINE_BYTES = 64 MiB`, 초과 줄 폐기)
- **미상속(리셋)**: `workflows/`·`goal/` **삭제**, collection_id/next_trace_turn/git 메타/request_id 비움
- **물리 공유·하드링크 없음** — 전부 복사 아니면 리셋
- 타이틀 watermark: 전체 fork면 부모 값 상속(동결 유지), **부분 fork면 0**(재타이틀 허용)

**Rewind**: 세분성 = **프롬프트 인덱스**("프롬프트 N 실행 **전**"), 모드 3종(`All`/`ConversationOnly`/`FilesOnly`).
- `force=false`면 **순수 dry-run** — 되돌릴 파일 + 외부 수정 충돌(deleted/created/modified_externally)만 반환
- 파일 부작용: 가장 이른 before 스냅샷 내용을 write, `None`이면 delete
- **압축 이력 있으면 항상 `replay_to_prompt(updates.jsonl)`로 대화 재구성**, 실패 시 truncation 폴백 **안 함**(명시 에러) — 압축이 user 개수 기반 절단을 무효화하므로
- updates는 append-only라 `RewindMarker{target_prompt_index, created_at}` 추가 후 리더가 dead branch 필터
- 파생 상태 정리: last_turn_summary/last_recap None, recap epoch++, turn-summary/title-refresh abort, auto-compact suppression 해제

**out-of-band 히스토리 repair**: `x.ai/session/repair` — chat-state 액터 안에서 실행, **턴 진행 중이면 거부**, `FlushAndAck` 배리어로 확인. `dry_run` 지원.

### 2-6. Replay (재연결 시 클라이언트 복원) (FACT)

`updates.jsonl` 원시 줄을 method별 디스패치. 원본 `_meta`(agentTimestampMs 등) 보존 + `_meta.isReplay: true`.

- **드롭**: `available_commands_update`(load 후 재광고) + `tool_call_update` 중 `status==in_progress`
- **tool-call collapsing**: 미완료 ToolCall을 버퍼링했다가 Completed/Failed로 머지. start-only는 **자식 스트림 EOF에서만** flush(부모 forward는 커서/eventId 계약 때문에 flush 안 함)
- **커서 델타 재생**: `_meta.eventId`로 `rposition`(드롭 대상 제거 **전**에 탐색). 커서 이후가 전부 드롭대상이거나 eventId 보유일 때만 신뢰, 아니면 **전체 replay**
- **백프레셔**: `REPLAY_COMPLETION_WINDOW = 64` — cold resume 시 un-acked 알림 제한. 긴 completion은 refit, 불가하면 **드롭(연결 유지 우선)**
- 경로 탐색: cwd 힌트(child→parent) fast path → 실패 시 `RelocationView` 전체 스캔. **journal 있으면 fast path 결과 폐기**. 세션 id는 `is_safe_session_id_component`로 traversal 방어

### 2-7. 세션 검색 인덱스 (FACT)

SQLite **FTS5**, `<grok_home>/sessions/session_search.sqlite`. `Feature::SessionSearch` **기본 ON**.

- 스키마 `SCHEMA_VERSION="4"`. **저장 버전이 더 최신이면 drop 안 함** — stable/alpha 핑퐁 wipe 방지
- **인덱싱 대상**: 유저 프롬프트, 어시스턴트 텍스트, 툴 메타(title + locations[].path). **미인덱스**: `agent_thought_chunk`, 툴 content/rawOutput, cwd
- rewind 마커 인지 → **dead branch 제외**
- 상한(하드코딩, knob 없음): `SEARCH_CONTENT_CHAR_LIMIT = 200,000`(**tail 보존** 절단), assistant 100,000, tool 200 calls / 100,000자
- 갱신: 턴마다 + `/rename` + delete 후 큐잉, 워커가 **500ms 디바운스** upsert. `content_hash`(blake3) 동일하면 스킵
- Bootstrap: 동시 4, 세션당 30s, 파일 30 MiB 초과 시 title-only. lease 300s / refresh 30s / peer_wait 60s, 클레임 `"{unix}:{uuid}"` 펜싱(**클럭 롤백도 탈취 대상**)
- 쿼리: BM25 가중 **title=10.0 / content=1.0**, multi-token은 AND → 0건이면 OR 재실행. session-id 모양 쿼리는 FTS 우회 `instr()` substring
- **손상 자가치유**: 특정 오류만 좁게 분류 → `.corrupt.<nanos>` quarantine(-wal/-shm/-journal 포함) → 재생성 → 정확히 1회 재시도
- **3-state**: `Pending`/`Off`/`On` — Pending의 빈 결과는 최종이 아니고 Off의 빈 결과는 최종. 서브에이전트 세션은 `never_indexed()`로 강제 Off

### 2-8. 타이틀 생성 · 경합 해소 (FACT · 흡수 후보)

첫 ContentChunk로 백그라운드 LLM → `set_generated_title_if_absent`(summary 락 아래 원자적). 빈 응답이면 유저 텍스트 fallback.

**락 안에서 3방향 경합을 명시 우선순위로 해소**(`summary_write.rs:187-226`):
```
reset_title_to_auto (early-return) > generated_title(수동) > generated_title_regenerate(auto일 때만) > generated_title_if_absent
```
`/rename`은 즉시 디스크 쓰기 + `title_is_manual=true`. `/rename --auto`는 핀 해제(`generated_title` + `session_summary` 둘 다 비워야 if-absent 재채택 가능) + watermark 0 재오픈.
제목 상한 `MAX_TITLE_SCALARS = 100`, **C0/C1 제어문자 + bidi override 스트립**.

### 2-9. Relocation — 구현됐으나 쓰기 경로 INERT (FACT)

dormant 세션 dir을 `sessions/<enc(source)>/<id>` → `sessions/<enc(target)>/<id>`로 durable 이동하는 5단계 프로토콜이 **완전 구현**돼 있으나 **`stage_and_publish`/`mark_ready_and_commit`/`rollback` 호출자 0건**(grep 확인). 읽기/복구 경로만 배선.

- journal `<grok_home>/relocations/<session_id>.json` + `.lock` lease(`Drop` 해제)
- phase `prepared→staged→target_published→ready→committed`(또는 `rolled_back`). **TargetPublished까지 source 권위, Ready부터 target 권위**
- 복구: Prepared/Staged/TargetPublished→롤백, Ready→커밋
- `rename_no_replace`: Linux(gnu) `renameat2(RENAME_NOREPLACE)`, macOS `renamex_np(RENAME_EXCL)`, **그 외 `UnsupportedPublication`** → Windows/musl에서 relocation 불가
- **복구는 모든 목록 조회에 배선됨** — `list_summaries`/`list_recent_summaries`가 스캔 전 `recover_session_relocations_in` 실행
- `RelocationView`가 모든 세션 dir 열거의 단일 창구. journal 없는데 같은 id가 2곳이면 `None`(행 드롭). `summary.json`이 **정규 파일이고 심볼릭 링크가 아닐 때만** 후보

### 2-10. 세션 목록 (FACT)

**Merge = 대화 병합이 아니라 "목록" 병합**: 로컬 summary 스캔 + 원격 레지스트리를 session_id dedup(**원격 우선**), `source` = local/remote/both. 원격 타임아웃 5s. cwd scope 3종(`Only`/`WithSiblings`(기본, 같은 repo 형제 worktree + 같은 remote)/`RelaxIfEmpty`). over-fetch `max(limit*3, 100)`. `num_messages = max(local, remote.last_turn_number)` — **stale 원격이 로컬을 empty로 강등 못 하게**.

**Unified list 2 lane**: Build lane(로컬+원격) / **Chat lane(grok.com conversations) — 하드 OFF**(`conversations_lane_enabled()`가 리터럴 `false`) → `GROK_SESSION_LIST_CONVERSATIONS`·`GROK_CHAT_MODE` **INERT**.
- 페이지 30, facet 9종(kind/cwd/workspace/starred/repo/branch/worktree/gitRoot/sourceWorkspace), pushdown은 `workspace` 하나뿐
- **facet 카운트가 전체 코퍼스가 아니라 잘라낸 현재 페이지 기준**이고 응답에 `scope:"window"` 명시
- cursor: `CompositeCursor` → serde_json → base64 URL_SAFE_NO_PAD. **서명·암호화 없음**, 깨지면 첫 페이지 폴백
- 부분 실패 `PartialReason::{Timeout, Error, NoOauth}` → `_meta["x.ai/partial"]`

### 2-11. 서브에이전트 영속화 격리 (FACT)

- 자식 세션 dir은 **부모 밑이 아니라 최상위** `sessions/<enc(child_cwd)>/<subagent_id>`. 부모 밑엔 메타만 `subagents/<id>/`
- `with_explicit_session_dir` + `SessionDirMode::Explicit`면 `scan_session_dirs`가 **빈 벡터** → 목록 미노출
- `session_kind`를 `"subagent"`로 강제, **remote_sync/relay_sync/gateway 전부 None**, search_index `never_indexed()` → **클라우드 동기화·공유·인덱싱 전부 제외**
- `is_hidden`: `hidden` 명시값 우선, 없으면 `session_kind`가 `"subagent"` prefix면 hidden

### 2-12. 크래시 핸들러 (FACT)

| 항목 | 내용 |
|---|---|
| 시그널 | Unix: SIGBUS/SIGSEGV/**SIGABRT**(`panic="abort"` 릴리스도 리포트). Windows: access violation만 |
| **기본값** | **OFF** (`[diagnostics] crash_handler`, env `GROK_CRASH_HANDLER`, remote — default false) |
| blob 포맷 | async-signal-safe 고정 크기 바이너리. magic `"GCRX"`, version 1, `MAX_FRAMES=64`. 미리 연 fd에 `libc::write`. **프레임 포인터 워킹 직접 구현** |
| 이전 크래시 감지 | `check_previous_crash` → 심볼리케이트 → `last-crash-report.txt`(0600) → `history/crash-{ts}.txt`(최대 5) → blob 삭제. **반드시 `install()` 전에** 호출(install이 O_TRUNC) |
| 리포트 권한 | 0600(기존 0644도 조임) — 백트레이스에 소스 경로 포함되므로 |
| **터미널 복구 핸들러** | crash handler가 꺼져도 **항상 설치**. termios 저장 + altstack, 복구 escape 출력 후 **default disposition으로 re-raise(코어 덤프 보존)**. 파일 I/O·스택워킹 없음 |

### 2-13. 프롬프트 조립 (FACT)

**템플릿 3종**: `prompt.md`(73줄) / `apply_patch_prompt.md`(283줄) / `subagent_prompt.md`(91줄). 복호 후 **`Zeroizing<String>`으로 drop 시 소거**.

- `PromptMode`: `Extend`(기본, base + body) / `Full`(body가 전체)
- `PromptAudience`: `Primary`(전체 base + 모든 카탈로그) / `Subagent`(compact base, persona/subagent 카탈로그 없음)
- `TemplateOverride`: `None` / `Codex`(apply-patch 프로필) / `Custom(String)`
- `PromptContext` **20필드**, placeholders 13개. **직렬화 가능 → `grok prompt --section template`로 덤프 가능**
- 라벨: `DEFAULT_SYSTEM_PROMPT_LABEL = "Grok"` → `"You are ${{ system_prompt_label }} released by xAI."`
- **non-interactive 분기**: `is_non_interactive`면 "autonomous agent… no human operator", 아니면 "interactive CLI tool"
- base 섹션 7종: `<work_policy>`, `<tool_calling>`, `<background_tasks>`, `<communication>`, `<formatting>`, `<user_guide>`(interactive일 때만), `<browser_verification>`(플래그 시)
- subagent 섹션 11종(+`project_instructions_spec`의 Scoping/Precedence rules)
- `COMPACT_SYSTEM_PROMPT` = 압축 후 쓰는 최소 프롬프트

**AGENTS.md 탐색**: 파일명 `Agents.md`, `Claude.md`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENT.md`, `AGENTS.md`(+ claude compat면 `.claude/CLAUDE.md`, `.claude/CLAUDE.local.md`). rules 디렉터리 `.grok/rules`(+`.claude/rules`, `.cursor/rules`).
순서: 홈 roots → 프로젝트 chain(git root → cwd, **깊은 파일 우선**). gitignore된 파일 제외.

**★ AGENTS.md 인젝션 방어 (흡수)**: `(?i)<(\s*/?\s*system[-_]reminder)` 매칭을 `&lt;$1`로 이스케이프 — **경로와 내용 양쪽**(`agents_md.rs:323-352`). 신뢰 못 할 AGENTS.md가 하네스 프레이밍을 위조하지 못하게.
rules 섹션도 별도 `neutralize_file_rule_content`.

**리마인더 정책**: `TodoNudgeConfig{turns_since_todo_write:3, turns_between_reminders:5}` **기본 ON**, `TodoGateConfig{max_fires_per_prompt:2}` **기본 OFF**.
**MCP 디스크립터 루트**: `~/.grok/projects/<encoded-cwd>/mcps` — 모델이 `<folder>/tools/<tool>.json`으로 스키마 조회.

### 2-14. 훅 발화 지점 (런타임 측) (FACT)

| 이벤트 | 발화 위치 | 게이트 |
|---|---|---|
| SessionStart | `run_loop.rs:1761,1773` | Observe |
| UserPromptSubmit | `turn.rs:897` | Observe(matcher Ignored=항상 발화) |
| **PreToolUse** | `tool_calls.rs:1104,2143` (`may_have_hooks_for` 사전 체크) | **유일한 Tool 게이트**. deny 시 `ToolLoop::HookDenied`(비-terminal) |
| PostToolUse / PostToolUseFailure | `tool_calls.rs:764,803-812,849` | Observe |
| PermissionDenied | `tool_calls.rs:1366` | Observe |
| **Stop (turn-end)** | `stop_gate.rs:238-245` | **blocking**. payload에 `{reason, stop_hook_active, last_assistant_message, background_tasks[], session_crons[]}` — **실행 중 백그라운드 작업 + 예정 cron 스냅샷 동봉** |
| Stop (session-end) | `stop_gate.rs:119-147` | **observe-only** — exit 2가 파싱되나 **결정은 폐기**(`demote_ignored_blocks`로 Blocked→Success 강등). 예산 `SESSION_END_STOP_BUDGET = 5s` |
| SubagentStop | `stop_gate.rs:229-236` | 자식의 turn-end 게이트. payload `phase: Gate` + subagent_id/type |
| StopFailure / StopCancelled | `turn_end_hooks.rs:128-150` | Observe. **Stationarity→NoProgress, MaxTurns→MaxTurns** 매핑 |
| SubagentStart | `updates.rs:696,709` | Observe |
| Notification | `updates.rs:855,871` | DiffReview→`permission_prompt`, AutoRecoveryExhausted→`agent_error`, idle 60s→`idle_prompt`. 고빈도 내부 업데이트는 제외 |
| PreCompact / PostCompact | `compaction.rs:920-928, 1732-1740` | payload `source: "manual"\|"auto"` |
| SessionEnd | `run_loop.rs:37,50` | 자식도 `subagentType` 실어 발화 |

**클라이언트 훅**(`x.ai/hooks/run`)은 파일 훅과 별개로 클라이언트에 awaited 요청, 결과 병합 후 1회 emit.

### 2-15. 확장 레일 — 대부분 INERT (FACT)

- `session_extension_registry`가 실제로 설치하는 건 **`idle_prompt` 하나뿐**. 등록 순서 = 디스패치 순서, 세션 생성 시 freeze
- 디스패치 사이트 5곳: `on_turn_start_with_policy` / `on_turn_done` / `on_turn_error` / `on_turn_abort` / `on_session_idle`
- **`TurnInputContributor` 레일 INERT** — 턴에 model-visible fragment를 기여하는 트레이트인데 **구현체·디스패치 사이트 0건**
- **`CommandContributor` 레일 INERT** — 확장이 슬래시 커맨드를 광고/처리하는 트레이트인데 **구현체 0건**
- `!Send` TUI 액터용 `Local*` 트레이트 + `Send` 구현체를 자동 승격하는 blanket impl 이중화

### 2-16. 텔레메트리 (FACT)

**세션 이벤트 로그**: `<session_dir>/events.jsonl`, 한 줄 = `{ts(RFC3339 ms), …event}` append-only. `EVENT_SCHEMA_VERSION = "1.0"`. 열기/쓰기 실패는 warn 1회 후 무시.
런타임 `Event` **~52종**(TurnStarted, PhaseChanged, FirstToken, ToolStarted/Completed, PermissionRequested/Resolved, TurnEnded, Interjected, YoloToggled, GoalAutoPaused, TodoGateFired/Exhausted, Laziness 3종, Goal 26종, Mcp 15종).
`Phase{WaitingForModel, StreamingText, StreamingReasoning, ToolExecution, PermissionPrompt}`.

**내부 분석 이벤트 ~110종**(`events/mod.rs:359-2100`). `doom_loop_recovery`는 턴 누적 attempts/accepted_after_budget/top_trigger 실어보냄.

**★ 외부 OTel(고객 소유)의 3중 방어 (흡수 후보)**
- master switch `GROK_EXTERNAL_OTEL=1` **AND** `OTEL_METRICS_EXPORTER`/`OTEL_LOGS_EXPORTER` 중 최소 1개 실제 exporter — **master switch 단독으로는 부족**
- **fail-closed 게이트**: 텔레메트리 init 전 `suppress()`로 닫고, fleet policy 도달 **불가할 때만** `open_at_startup`. `PolicyChannel::{Applies, Unavailable(RemoteFetchDisabled|ProxyRepointed)}` — **remote fetch가 꺼졌거나 프록시가 xAI가 아니면 정책이 도달 불가**로 분류
- 스키마 `SCHEMA_VERSION="v1"`, scope `"ai.xai.grok_code"`, 이벤트 18종 고정
- **속성 키가 closed enum** + `EXTERNAL_ALLOWED_KEYS` pin 테스트 + export-time validator = **3중**. CODEOWNERS 게이트
- 콘텐츠는 **additive opt-in만**: `OTEL_LOG_USER_PROMPTS=1`(프롬프트 본문), `OTEL_LOG_TOOL_DETAILS=1`(툴 파라미터/전체 경로) — **둘 다 기본 OFF, tighten만 가능**
- truncation: `MAX_STRING_LEN=512`, `MAX_TOOL_INPUT_JSON_BYTES=4KiB`, `MAX_JSON_DEPTH=2`, `MAX_COLLECTION_ITEMS=20`, `MAX_CONTENT_BYTES=60KiB`
- 인증 헤더는 **env로만** — config 파일에 시크릿 미저장

**`SessionSignals`(`signals.json`)**: turn_count, message counts, error/tool_failure/cancellation counts, consecutive_cancellations, regeneration_count, has_reverted, compaction_count, context_window_usage, tools_used[], models_used[], edit_and_retry_count, bash_bare_echo_count, git/PR 메트릭, **RSS 고수위** 등. 백엔드 분석 동기화는 `Feature::Feedback` **기본 ON**.

### 2-17. Claude 임포트 (FACT · 대화 임포트 아님)

**`.claude/settings*.json`, `~/.claude.json`, `.mcp.json` → `.grok/config.toml` + `.grok/hooks/*.json`.**
**메시지/툴콜/thinking 변환 코드가 없다** — 대화 임포트가 아니라 **설정 임포트**다.

- 대상 5종: `Permission(PermissionRule)`, `EnvVar`, `McpServer`, `Hook{event,matcher,command,timeout}`, `PathEntry{Skill|Rule, path}`
- `type != "command"` 훅은 드롭, 파싱 실패 rule은 조용히 스킵
- additive — env/mcp는 기존 키 미덮음, TOML 파싱 불가면 쓰기 거부
- `[claude_compat] imported` 마커가 true면 **Claude 호환 경로(MCP/hooks/skills/plugins 흡수)가 전부 꺼짐**. 프로세스 전역 RwLock 캐시라 수동 편집은 재시작 필요
- 🔴 **`_GROK_CLAUDE_MARKER_OVERRIDE` env가 `#[cfg(test)]` 가드 없이 프로덕션에서 읽힘** — `=="1"`이면 모든 Claude 호환을 끔
- [INERT] `claude_import_state` 변화감지 — hash를 **쓰기만 하고 비교 함수가 없음**
- [INERT] `/import-claude` UI — `AppView.has_claude_import`가 `false` 초기화 후 **레포 어디서도 true 대입 없음**
- [버그] project-scope MCP 오분류 — 코드가 스스로 `TODO(phase-2)`로 인정

---

## 3. 툴 표면

### 3-1. 규모 (FACT)

레지스트리 `ToolRegistryBuilder::new()` (`registry/types.rs:677-767`)에 **정확히 50개** 등록. 네임스페이스: GrokBuild 28 / opencode 8 / GrokBuildHashline 3 / GrokBuildConcise 3 / Codex 4 / 기타 4.
같은 호출에 툴 아닌 리마인더 3종(`LspDiagnosticsReminder`, `TaskCompletionReminder`, `SkillDiscoveryReminder`)과 out-of-tree 확장점 `tool_packs()`도 등록.

**모든 input schema는 schemars 생성물**(`registry/types.rs:613`, `generate_schema` `:1922-1942`). 9개 툴이 finalize 시 `versioned_definition`으로 후처리.

### 3-2. 프리셋 (FACT)

| 프리셋 | 툴 수 | 용도 | 근거 |
|---|---|---|---|
| `grok-build` (기본) | **30** | 풀 워크스페이스 | `config.rs:221`, 빌더 `:176-194` |
| `grok-build-plan` | 20 | **셸 기본 에이전트 타입**(`DEFAULT_AGENT_TYPE`) | `config.rs:223`, `:399-432` |
| `grok-build-concise` | 14 | SFT/RL용 축약 설명 | `config.rs:222`, `:288-310` |
| `codex` | 10 | Codex 호환 툴셋 + Codex 시스템 프롬프트 | `config.rs:224`, `:341-358` |
| `explore` | 3 | 읽기전용 탐색 서브에이전트 | `config.rs:225`, `:365-374` |
| `plan` | 4 | 읽기전용 아키텍트 | `config.rs:226`, `:380-392` |
| `grok-computer` | 8 | 워크스페이스/샌드박스 | `config.rs:227`, `:196-213` |
| *(비공개)* hashline | 19 | `[toolset] file_toolset="hashline"` 전용 | `config.rs:314` (**호출자 0**), 실경로 `tools/config.rs:376-410` |
| *(비공개)* orchestrator | 26 | 코딩 전량을 서브에이전트에 위임. `search_replace`/`write` **의도적 제외** | `config.rs:434-482` |
| *(비공개)* plan-no-subagents | 20 | 서브에이전트 인프라 없는 셸용 | `config.rs:484-515` |
| *(비공개)* ask-user | 19 | 플랜모드 없이 구조화 질문만 | `config.rs:517-542` |
| *(비공개)* opencode | 10 | opencode 툴 8종 중 7종의 **유일 소비자** | `config.rs:544-561` |

> `default_grok_build_toolset()` 18개는 **이름 붙은 프리셋이 아니라** 내부 베이스다. 흔한 오독 지점.

**읽기전용 강제는 프롬프트가 아니라 툴셋 누락**: `explore`는 bash를 일부러 빼고, bash가 없으니 백그라운드 헬퍼도 불필요해서 뺐다고 소스에 명시(`config.rs:359-364`).

**50개 중 12개는 어떤 공개 프리셋에도 미포함**: `image_edit`(동적 주입만), hashline 3종, opencode 7종(`bash`/`read`/`edit`/`grep`/`glob`/`todowrite`/`skill`).

### 3-3. 파일 편집 — 5가지 전략 공존 (FACT · 핵심)

| 전략 | 매칭 방식 | staleness 검사 | 근거 |
|---|---|---|---|
| `GrokBuild:search_replace` (기본) | CRLF 정규화 후 정확 `match_indices`. 유니코드 정규화 폴백은 **opt-in**(기본 false) | **없음**. `skip_read_before_edit`는 문서상 "런타임 no-op". read-before-edit는 *툴셋* 요구사항(Read 툴 존재)일 뿐 런타임 선행조건 아님 | `search_replace/mod.rs:575-625`, `:104-107` |
| `GrokBuildConcise:search_replace` | 동일 엔진 | 동일 + **Read 툴 요구조차 제거** | `grok_build_concise/search_replace.rs:41-47` |
| `opencode:edit` | 정확 `match_indices`만, 폴백 없음 | 없음 | `opencode/edit/mod.rs:369-393` |
| `Codex:apply_patch` | V4A 봉투, **4단계 퍼지**(exact→rstrip→trim→유니코드 구두점 정규화) | 없음. uniqueness 검사도 없음 | `codex/apply_patch/seek_sequence.rs:1-13` |
| **`hashline_edit`** | **앵커 해시 검증** | **1급 구현** ↓ | `grok_build_hashline/edit/apply.rs` |

**hashline 상세 (흡수 1순위)**
- 읽기가 `1:abc:rst→content` 형태로 렌더 — 3글자 앵커 = 공백 정규화한 줄의 **FNV-1a 해시**
- 편집은 앵커로 지정 → **앵커 자체가 최신성 검사**
- 앵커 불일치 시 `AnchorStale`로 **이동한 줄 번호 + 모호한 후보들 + 새 앵커 문맥(±5줄)** 반환, ±15줄 탐색 — **모델이 파일을 재읽기 없이 즉시 재시도**
- 배치는 **all-or-nothing**: 하나라도 낡으면 전체 거부(`apply.rs:1100-1135`)
- 연산 3종(`#[serde(tag="op")]`): `replace{anchor, end_anchor?, content}`, `insert_after{anchor, content}`, `write{content}`
- **레지스트리가 hashline+표준 파일툴 혼용을 하드 에러로 차단**(`registry/types.rs:869-903`)
- 설정 `HashlineSchemeParams{scheme="chunk", hash_len=3(1..=4), chunk_size=8}`, 설명이 scheme별로 템플릿 렌더

**포팅 신호 (FACT)**: `xai-grok-tools/THIRD_PARTY_NOTICES.md` — Codex에서 `apply_patch`/`grep_files`/`list_dir`/`read_file`(Rust→Rust), opencode에서 `bash`/`edit`/`glob`/`grep`/`read`/`skill`/`todowrite`/`write`(TS→Rust). **opencode의 퍼지 치환 체인은 미이식** — 표면과 설명만 베끼고 퍼지 매칭은 버림.

`FileOperationLockManager`(`editor_infra/file_operation_lock.rs:19`)는 구현·re-export돼 있으나 **어떤 툴도 획득하지 않음**(dead).

### 3-4. 셸 툴 (FACT)

- **일회성 spawn**, PTY 없음, 센티넬 마커 없음. 옵션으로 fd 3/4 스냅샷/리플레이 상태 연속성(기본 OFF)
- 타임아웃: 기본 120s, 포그라운드 상한 300s (프로덕션 opt는 최대 10h)
- **포그라운드 블록 예산 15초 → 죽이지 않고 백그라운드 승격**(`terminal.rs:57`, `:1826-1856`)
- 출력 절단: 20k에서 head+tail + **디스크 전체 로그 경로 동봉**(`util/truncate.rs:279`)
- 완료는 폴링 아닌 **push**: 툴 결과에 완료 리마인더 주입(`reminders/task_completion.rs`), "사용자가 죽였으니 재시작 말라" 통지까지 있음
- Linux cgroup-v2 메모리 캡 + seccomp 네트워크 필터
- 명령 블록리스트는 미대기 `&`와 자기 매칭 `pkill` 외 없음(권한 레이어가 담당)

### 3-5. 검색 (FACT)

**렉시컬 전용**. ripgrep 번들(항상) + ugrep·bfs(조건부), `~/.grok/vendor/`에 self-extract. 셸의 `find`/`grep`은 bfs/ugrep으로 **투명 대체**(`embedded_search_tools.rs:1-28`).
**코드베이스 임베딩 인덱스 없음.** 구조 프리미티브는 `lsp` 툴. 시맨틱 검색은 memory에만(sqlite-vec + MMR).

### 3-6. 툴 이름 랜덤화 (FACT · 특이)

**모델에게 주는 툴 이름과 파라미터 이름이 무작위화**된다. 그래서 툴 설명이 정적 문자열이 아니라 **MiniJinja 템플릿**이고, 상호참조는 `${{ tools.by_kind.read }}`, 파라미터는 `${{ params.edit.old_string }}`로 간접 참조. 에러 문자열까지 템플릿.
근거: `types/description.rs:1-12`, `template_renderer.rs`, `opencode/edit/mod.rs:801`, `bash/mod.rs:295`
> **INFERENCE**: 이유 미명시. 다른 에이전트에서 학습된 툴 이름 prior 차단 또는 학습 오염 탐지로 추정.

### 3-7. 설명 길이 (FACT)

포팅해온 prose가 압도적으로 김 — opencode `bash` **10,787자**, `todowrite` 8,843자, Codex `apply_patch` 3,016자(V4A 문법 verbatim), `hashline_edit` 2,752자.
xAI 자작은 짧음 — `read_file` 705, `search_replace` 665, concise 변형 566/515, `write` 217.
`grok-build-concise` 프리셋이 **토큰 예산용으로 존재**한다는 것 자체가 설명 길이를 비용으로 인식한다는 증거.

---

## 4. 권한 · 샌드박스 · 훅

### 4-1. 기본 자세 (FACT)

CLI 기본: **샌드박스 `off`**, 퍼미션 전면 `Ask`, auto-classifier/yolo/hub 위임 전부 OFF.
워크스페이스 서버 기본: 샌드박스 **`Workspace`**.
실제로 강제되는 건 규칙 엔진 + 정적 명령 분류뿐.

### 4-2. 명령 분류 — tree-sitter (FACT · 방향 흡수)

- **tree-sitter-bash 파싱**(`bash_command_splitting.rs:50`), 정규식 아님
- 체인의 non-setup 세그먼트가 **각각 독립 통과** 필요
- 파싱 불가(heredoc, `$( )`, 백틱, `&`) → `SegmentEvaluation::Unparseable` → **보수적 프롬프트**(`manager/mod.rs:604`)
- 래퍼(`env`/`command`/`sudo`) 벗기기 **깊이 8 캡, fail-closed**
- 접두 매칭에 **단어 경계 강제**(`gitleaks` ≠ `git`, CWE-183 명시)
- `setup command` 8종은 분류 스킵: `cd pushd popd export unset set sleep timeout`

**목록 실측**
| 목록 | 개수 | 대표 |
|---|---|---|
| `is_safe_command_words_str` | ~22 | `ls cat pwd date whoami hostname uptime grep rg head tail wc sort uniq tr cut ps kubectl get/logs/describe` |
| `ALWAYS_SAFE_COMMANDS` | ~14 | — |
| `SAFE_GIT_SUBCOMMANDS` | 22 | — |
| **dangerous verbs** | **9** | `rm chmod chown chgrp chattr pkill kill killall "git push"` |
| `EXEC_VEHICLE_HEADS` | ~35 | 인터프리터/러너/`docker`/`sudo`/`find`/`xargs` |
| auto 모드 `ROUTINE_PREFIXES` | **69** | `cargo `, `git add`, `pytest`, `rg `, `jq `, `bazel `, `kubectl get` … |

**설계 의도**: 위험 목록을 늘리는 대신 **실행 수단(vehicle)을 막는다**. 간접 실행 경로를 개별 봉인 — `tee` 제거(CWE-863), `rg --pre`, `git --textconv/--ext-diff/-c/--git-dir`, `tree -o`, `ps -e` 환경덤프, `kubectl` 위험 플래그 16종(kubeconfig `users[].user.exec` credential plugin이 임의 프로세스를 실행하므로 읽기 verb라도 프롬프트).

**패키지 매니저는 blanket prefix 금지 → 서브커맨드 화이트리스트(fail-closed)**: npm/pnpm/yarn 35개, uv 15개, rustup 12개. `npx`/`uvx`/`uv tool run`/`dlx`/`create` 등 **원격 런처는 항상 차단**. `uv run`/`npm exec`/`rustup run`은 **내부 명령을 벗겨 재검사**.

**환경변수는 default-deny**: `SAFE_ENV_KEYS` **12개만** 통과(`RUST_LOG`, `NO_COLOR`, `CARGO_TERM_COLOR` 등 대소문자 정확일치), 그 외 전부 `Unvetted`=Block. `INJECTION_ENV_KEYS` 9개(`LD_PRELOAD`, `BASH_ENV`, `ENV`, `IFS`, `PATH`, `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND`, `PROMPT_COMMAND`, `LD_AUDIT`) + 접두 2개(`DYLD_`, `GIT_CONFIG`)는 즉시 Injection. `env`에 **어떤 옵션 플래그든** 붙으면 Injection.

### 4-3. 🔴 확인된 우회 취약점 (적대검증 FACT)

**HIGH — 인용 연결(quoted-concatenation) 파싱 차이로 전 플래그 가드 무력화**

`bash_command_splitting.rs:1051-1060`의 `"concatenation"` 분기가 **따옴표 포함 원문 텍스트**를 `PlainCommand::words()`에 넣는다. 플래그 가드들은 그 words에 정확/`starts_with` 문자열 비교를 하므로, 빈 따옴표를 끼우면 분류기 눈엔 안 보이고 bash는 정상 확장한다.

| 공격 문자열 | 무력화되는 가드 | 결과 |
|---|---|---|
| `rg --pr''e /tmp/evil.sh pat .` | `rg_has_pre_flag` (`manager/mod.rs:222-232`) | **프롬프트 없이 실행** |
| `kubectl get pods --kubeconfig''=/tmp/evil.yaml` | `kubectl_has_unsafe_flag` (`:240-251`) | exec credential plugin 조용히 실행 |
| `sort -S 1K --compress-program''=/tmp/evil big.txt` | `sort_has_compress_program_flag` (`exec_risk.rs:92-105`) | 조용히 실행 |
| `git diff --ext-di''ff` | `GIT_QUERY_UNSAFE_OPTIONS` 축약 fail-closed (`exec_risk.rs:267-276`) | 우회 |

**버그임을 증명하는 비대칭**: 같은 코드베이스의 *쓰기* 판정 경로 `shell_access.rs:880-889`는 `decode_shell_literal_spelling`으로 **연결을 디코딩한다**. 즉 한쪽만 정규화가 빠진 것.

**HIGH — `rg --hostname-bin` 미모델링**: ripgrep이 `{host}` 해석용으로 실행하는 플래그인데 `rg_has_pre_flag`는 `--pre`만 안다. `segment_has_exec_risk_flag`(`exec_risk.rs:196-204`)는 `sort`/`git`만 모델링. → 조용히 실행.

**MEDIUM — 지속 승인 확대**: `EXEC_VEHICLE_HEADS`에 `npx`/`bunx`/`pipx`/`uvx`/`uv`는 있으나 **`npm`/`pnpm`/`yarn`/`pip`/`make`/`go`/`cargo`/`gradle`/`mvn`/`dotnet`/`java`/`gdb`/`busybox`/`nix-shell`/`parallel`/`nohup`/`just`/`cmake` 없음**. `npm run build` 승인 → scope-2 grant `npm run` 저장 → 이후 `npm run <아무거나>` 조용히 통과. `curl -o`/`wget -O`도 `special_file_operands`에 없어 임의 쓰기 프리미티브.

**차단 확인된 것(negative result)**: 래퍼 깊이 8 정확히 fail-closed / 바레 `VAR=v cmd`는 `script_env_risk`가 별도 경로로 전부 차단 / `$'…'`·`$( )`·백틱·`<( )`·`&`·`|&`·`>|` 전부 Unparseable → 프롬프트 / `"rm" -rf /`·`r''m`은 `command_name`이 bare `word` 자식을 요구해 거부.
**1차 보고 오류 정정**: `sed`/`find`/`awk`는 **manager 안전목록에 없다**(1차가 틀림). `sort -o`/`uniq out`/`sed -i`/`tee`/`dd of=`는 전부 `FileWrite` → grant floor.

### 4-4. 승인 grant 모델 (FACT · 흡수)

- 승인 명령은 **dequote 후 word join** 문자열로 저장, 이후 세그먼트마다 word-boundary prefix 매칭
- 저장소 3종: `allowed_bash_commands`(리터럴 prefix), `disallowed_bash_commands`, `allowed_bash_globs`
- **exec vehicle head는 prefix가 아니라 exact 매칭** — `docker run nginx` grant가 `--privileged`를 못 염(`manager/mod.rs:763`)
- dangerous verb는 prefix grant 무시
- join이 재파싱해 같은 argv로 안 돌아오면(공백 든 인용 인자, `;`) **grant 키로 사용 불가**
- **catch-all glob 거부**를 하드코딩 목록이 아니라 **"모든 bash probe에 매치되는지"로 판정**(`bash_grants.rs:135`)
- 세그먼트 5개 초과면 자동 grant 발행 안 함
- **UX: "항상 허용"이 단어 단위 스코프** — 승인 모달에서 ←/→로 argv 단어를 넓혀/좁혀 지정, 관리자 최소 스코프 하한 존재(`permission_cursor.rs:40`, `bash_grants.rs:21`)

### 4-5. 권한 enum (FACT)

```
설정/와이어: PermissionMode { Default, AcceptEdits, Auto, DontAsk, BypassPermissions, Plan }
             (config.rs:987) — 주석: "BypassPermissions만 spawn에 배선, 나머지 forward-compat"
런타임:      PermissionMode { Ask, AlwaysApprove, Auto }  (telemetry/src/enums.rs:42)
규칙:        RuleAction { Allow, Deny(기본), Ask } × ToolFilter { Any,Bash,Edit,Read,Grep,Mcp,WebFetch,WebSearch }
             × PatternMode { Glob, Domain }   (config-types/src/permission.rs:38)
결과:        Decision { Allow, Ask, FollowupMessage, Reject, PolicyDeny, Cancelled }
```
**기본 액션 Deny**는 CWE-1188 대응으로 명시. `Auto` 모드는 **LLM 트랜스크립트 분류기**가 판정(`permission/auto_mode/mod.rs`, `ClassifierVerdict{Allow,Block,Unavailable}`).
**Claude Code `.claude/settings.json` 호환 읽기**(`permission/claude_settings.rs`), `mcp__server__tool` 규칙 문법 번역(`rules.rs:245-262`).

### 4-6. 샌드박스 (FACT)

**메커니즘**: `nono` crate **정확 핀 `=0.53.0`**. Linux=Landlock, macOS=Seatbelt.
> `Cargo.toml:22-27` 주석 원문 요지: macOS Seatbelt deny 우선순위가 nono의 rule-emission 순서에 의존하므로, bump 시 `mv x y && cat y` 우회가 `is_applied()=true`인 채 재개방될 수 있음.

**프로필 6종** (`profiles.rs:69`, `#[default]`=Workspace):

| 프로필 | default_read | read_write | restrict_network |
|---|---|---|---|
| `workspace` | **true**(`/` 전체 읽기) | workspace + grok_home + temp | false |
| `devbox` | true | `/data`·`/proc`·`/sys`·`/dev` 제외 전부 | false |
| `read-only` | true | grok_home + temp만 | **true** |
| `strict` | **false** | workspace + grok_home + temp | **true** |
| `off` | — | 즉시 빈 CapabilitySet 반환 | — |
| `Custom(String)` | base 상속 | + kernel deny 목록(glob 지원) | 명시 시 override |

`strict`의 명시 read_only: `/usr /lib /lib64 /bin /sbin /etc /dev /proc /sys /tmp /run /var /System /Library /private` + `~/Library`(macOS 키체인/TLS).
DEVICE_FILES 6종(`/dev/null,zero,random,urandom,tty,ptmx`) + DEVICE_DIRS 2종(`/dev/pts`, `/dev/fd`) 항상 RW.

**macOS deny 정교함**
- `(deny file-read*)` + `(deny file-write*)` + **쓰기 서브액션 8종 개별 deny**(광역 workspace allow가 last-match로 이기므로)
- `/private` firmlink 별칭 전부 규칙 생성(`tmp`/`var`/`etc`)
- rename 우회 차단: 쓰기 가능 루트 내 deny 리프의 **조상에 `file-write-unlink`+`file-write-create` deny**
- 경로 이스케이프: `\`→`\\`, `"`→`\"`, **제어문자 있으면 규칙 생성 거부**
- Linux globset과 **정확히 같은 집합을 매치하는지 크로스 검증 property 테스트** 존재

**🔴 구멍**
| 구멍 | 내용 | 근거 |
|---|---|---|
| 미지원 플랫폼 **fail-open** | `is_supported`가 false면 warn + `ApplyFailed` 이벤트 후 **그냥 진행**(`Ok(())`). `apply` 실패도 동일 | `lib.rs:194-236` |
| **macOS 네트워크 미차단** | `should_restrict_child_network()` = `applied && configured && cfg!(linux)`. seccomp이 Linux 전용이라 read-only/strict를 골라도 자식 네트워크가 안 막힘 | `lib.rs:86-90` |
| Linux deny glob은 **launch-time 1회 확장** | 마운트 네임스페이스에 런타임 globbing이 없어 기동 시 열거해 `--ro-bind`. **이후 생성된 매치 파일은 미커버**(소스에 warn 명시) | `lib.rs:514-528` |
| `network_policy.rs` | `ChildNetworkPolicy{Unrestricted,Blocked,Websites}`·`WebsiteAction` 모델링만, **미집행** (모듈 주석 자인) | `network_policy.rs:1-4` |
| 프로세스 자신의 네트워크 | 의도적으로 열어둠(LLM API 필요). 차단은 per-subprocess seccomp만 | `lib.rs:11-12` |

**hook write-deny (흡수 후보)**: `Devbox`·`Off` 제외 **모든 프로필**이 `$GROK_HOME/hooks` 디렉터리·`hooks-paths` 레지스트리·레지스트리가 가리키는 절대경로를 **커널 레벨 쓰기 거부**(읽기는 허용). 에이전트가 자기 훅을 심어 가드레일을 푸는 것을 원천 차단.
무결성 검사: `symlink_metadata`로 (dev, ino, is_dir, nlink) 캡처 — **심볼릭이면 거부**, 일반 파일은 **`st_nlink != 1`이면 거부**(하드링크 별칭이 쓰기 가능하게 남으므로). 에러 8변형.
Linux는 bwrap 재실행 + **네임스페이스 락다운 seccomp**(`unshare`/`setns`/`clone(CLONE_NEW*)`→EPERM, `clone3`→ENOSYS)로 새 마운트 네임스페이스를 만들어 bind-over를 벗기는 우회까지 차단. `__GROK_INSIDE_BWRAP` 스푸핑도 재검증으로 방어.

**탈출구**: `--always-approve`(별칭 `--yolo`, `--dangerously-skip-permissions`), `[ui] permission_mode/approval_mode/yolo`, ACP `_meta.yoloMode`, `Ctrl+O`.
**관리자 핀으로 무력화 가능**: `requirements.toml`의 `[ui].yolo=false`가 `--yolo` 플래그 자체를 죽임(`default_yolo_mode=false`), `disable_bypass_permissions_mode=true`(`permission/resolution.rs:1097-1111`), UI도 표시 모드를 "ask"로 clamp.
`GROK_SANDBOX_AUTO_ALLOW_BASH`는 **샌드박스를 HITL 대체물로 쓰는 트레이드오프**(샌드박스 활성 시 bash 프롬프트 생략, 기본 OFF).

### 4-7. 훅 (FACT)

**이벤트 16종**(매크로 테이블 1행=1이벤트, `event.rs:89-197`): `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Stop, StopFailure, StopCancelled, Notification, SubagentStart, SubagentStop, SubagentEnd(legacy alias), PreCompact, PostCompact, SessionEnd`

**타 CLI 이름 alias 수용**: `PreToolUse` ← `beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`; `PostToolUse` ← `afterShellExecution`/`afterMCPExecution`/`afterFileEdit`/`afterAgentResponse`/`afterAgentThought`; `UserPromptSubmit` ← `beforeSubmitPrompt`. CamelCase/snake_case/camelCase 스펠링 모두 수용.

**`GateKind` 3종**: `Observe`(기록만) / `Tool`(allow·deny) / `Stop`(block·continue:false·additionalContext). **`Tool` 게이트는 `PreToolUse` 하나뿐.**
**`hub_forward`**: 16개 중 15개 true, **`PreToolUse`만 false**.

**핸들러 2종**: `Command`, **`Http`(URL)** — Claude Code 대비 상위집합.
**타임아웃**: 일반 5초, **Stop 게이트 600초**(실제 빌드/테스트를 돌리고 타임아웃 시 fail-open이라 5초면 정책이 조용히 무력화된다는 이유를 소스에 명시).

**🔴 훅 실패 = fail-OPEN (설계 선언)**
> `dispatcher.rs:59-63` 원문 요지: "Grok은 보호된 환경에서 실행되며, 유발된 실패로 보안 훅을 우회하는 것은 위협 모델에 없다. 이전 fail-closed 자세는 무고한 툴 호출을 과차단했다."

즉 타임아웃/크래시/command-not-found/출력 파손은 전부 **툴을 허용한 것처럼 진행**. Claude Code(exit 2 차단)와 정반대 자세.

**게이트 출력 계약**: stdout JSON `{decision:"allow"|"deny", reason, hookSpecificOutput.updatedInput}`. `decision` 부재/`"allow"`=Allow, `"deny"`=Deny, **그 외 값은 에러**(오타가 fail-open 되지 않게). exit code 2 = deny; **JSON deny는 어떤 exit code에서도 존중**하되 JSON allow인데 exit 2면 deny 판정.
**stdin 상한** 128 KiB, **출력 상한** 64 KiB, stderr 첫 줄 256자(JSON 없는 deny의 fallback reason).
**타임아웃 kill은 killpg**(손자까지).

**매처 3-모드**: 빈문자열/`*`=전체; `[A-Za-z0-9_|]`만 있으면 **exact**(`|` 분리 리스트, 정규식 아님); 그 외 **unanchored 정규식**. 분리 이유는 `^a|b|c$`가 첫/끝만 앵커돼 과다 매치하는 문제.
**컴파일 실패 시 `never()`**(아무것도 매치 안 함) = fail-closed.
외부명 alias 확장: `Bash`→`run_terminal_command`, `Edit|Write`→`search_replace`,`hashline_edit`.

**주입 env 5종**: `GROK_HOOK_EVENT`, `GROK_HOOK_NAME`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT`, `CLAUDE_PROJECT_DIR`. 우선순위 사용자 env < plugin < **runner(신원은 항상 승리)**.
**command는 로드 시 1회 확장, URL은 런타임 재확장 후 SSRF 검증**(의도적 비대칭).

**HTTP 훅 SSRF 방어**: **https만**, 해석된 IP가 private/link-local/메타데이터 대역이면 차단(IPv4-mapped IPv6도), **loopback은 허용**, **리다이렉트 미추적**. 알려진 구멍: 요청이 호스트를 재해석하므로 TOCTOU(소스 자인).

### 4-8. 폴더 신뢰 (FACT · 흡수)

**판정 순서**: ① feature OFF→Trusted ② 스토어에 self/조상 trusted→Trusted ③ 키가 over-broad→Trusted ④ repo-local code-exec 설정 없음→Trusted ⑤ 인터랙티브 TTY→Prompt ⑥ **헤드리스→Untrusted**

**게이트 대상 11종**: `mcp`, `plugins`, `permission`, `lsp`, `envrc`, `claude`, `hooks`, `agents`, `roles`, `personas`, `workflows`
마커: `.mcp.json`, `.grok/config.toml`의 non-empty `[mcp_servers]`/`[plugins].paths`/기여 `[permission]`, `.grok/lsp.json`, `.cursor/mcp.json`, `.envrc`, `.claude/settings{,.local}.json`, `.grok/hooks`, `.cursor/hooks.json`, 프로젝트 plugin/agent 디렉터리, `.grok/roles`, `.grok/personas`, `.grok/workflows`, `~/.claude.json`의 `projects.<cwd>.mcpServers`

- 스토어: `~/.grok/trusted_folders.toml`. 조회는 **최장 조상 매치**, 같은 깊이 복수면 **전부 trusted여야 trusted**(fail-closed)
- **over-broad 루트 거부**: 비절대 / `/` / 홈 디렉터리는 기록 거부·읽기 무시
- 워크스페이스 키: grok 관리 worktree면 소스 repo git root로 접음 → 한 repo의 모든 worktree가 **하나의 신뢰 키** 공유
- 마커 스캔 **fail-secure**: NotFound만 false, 그 외 IO 에러는 존재로 간주
- 🔴 **로컬/dev 빌드에선 전면 inert** — `GROK_VERSION` 스탬프가 없으면 명시적 opt-in조차 무시하고 프롬프트·게이팅·스토어 I/O 전부 없음(`folder_trust.rs:125,136`)

---

## 5. 관측성 (Agent State) — 우리 북극성

### 5-1. 진행 중 표시 (FACT · 흡수 1순위)

**상태줄**(`views/turn_status.rs:5-13`): `⠧ Run command 0.2s … 1m20s ⇣12k [stop]` — 스피너(~7.5fps) / 활동 라벨 / **단계 타이머** / **턴 타이머** / 토큰 / `[stop]` / `[↓]`(백그라운드 강등). 유휴 시 높이 0.

```
TurnActivity (acp/tracker.rs:231)
├ Thinking | Responding | WritingToolCall
├ ToolRunning { title, description }
├ AutoCompacting
├ Retrying { attempt, max_retries, reason }
└ Waiting(WaitingReason)

WaitingReason (tracker.rs:56)
= Model | Subagent{display} | TaskOutput{task_ids, subject, waits} | TasksComplete | Sleep
```

**★ `PhaseKey` 2중 시계** (`tracker.rs:270-306`) — **최고 ROI(~50줄)**
단계 타이머가 **진짜 작업 단위 변경 시에만 리셋**. 설명/subject 문자열이 중간에 바뀌어도 재시작 안 함. match가 exhaustive라 새 변형 추가 시 정체성 선언 강제 → 드리프트 방지.

**★ `waits: bool`** — 중단 가능한 블로킹 대기 vs 즉시 폴링을 구분. "Enter 치면 바로 보냄" affordance의 근거.

**★ idle watcher cue** (`turn_status.rs:161`): `Watchers{commands,monitors,loops,subagents,workflows}` → `"1 command · 2 monitors still running"`. **"Worked for X" 마커 뒤에도 유지**되어 완료 오독 방지. 턴이 wait에 막혀 있으면 `· send a message to interrupt` 추가.

기타: `context_bar.rs`(토큰/한도 + hover %), `credit_bar.rs`(과금), 대시보드 `RowState{NeedsInput,Working,Idle,Inactive,Completed,Failed,Blocked}`, `peek_tail.rs`(다른 에이전트 턴 라이브 테일).

### 5-2. 🔴 멈춤 사유 — 타입은 5벌, 화면은 5문구 (반면교사)

**어휘가 화면에 가까울수록 뭉개진다.**

```
(a) acp::StopReason (외부 crate)         EndTurn, MaxTokens, MaxTurnRequests, Refusal, Cancelled
     └ 이 repo가 실제 생성하는 건 3개뿐(EndTurn/Cancelled/Refusal)
(b) PromptCompletionKind (commands.rs:38-61)
     Completed | StationarityEnded | Cancelled{category,context} | MaxTurnsReached{limit} | Rewound | RemovedFromQueue
(c) CancellationCategory (session-events/types.rs:636)
     HookDenied | PermissionRejected | PermissionCancelled | MidTurnAbort
(d) StopCancelledReason (hooks/event.rs:329-337)  ← 가장 풍부
     UserInterrupt | PermissionRejected | PermissionCancelled | MaxTurns | NoProgress | Unknown
     + CancelledBy { User, Runtime, Unknown }
(e) SessionEvent (scrollback/blocks/session_event.rs:32-162)  ← TUI가 그릴 수 있는 유일한 것
```

**(d)가 가는 곳은 훅 서브프로세스와 텔레메트리뿐. TUI엔 안 감.** → 사용자가 짠 셸 스크립트가 화면 앞의 사용자보다 더 많이 안다.

**화면 문구 전량**(`session_event.rs:169-198`):
```
TurnCompleted{Some}  → "Worked for {duration}"
TurnCompleted{None}  → "Turn completed."
TurnCancelled        → "Turn cancelled by user in {d}."
TurnBlockedByHook    → "Turn blocked by a hook in {d}."
TurnHalted           → "Agent was unable to make progress — turn ended in {d}."   ← 프로듀서 없음
TurnFailed           → "Turn failed in {d}: {error}"
```

**사고 2건**

| 사고 | 경로 | 심각도 |
|---|---|---|
| **제자리걸음이 성공으로 표시** | `StationarityEnded` → `EndTurn`(`turn.rs:1300-1305`) → `(Ok,false)`(`dispatch/prompt.rs:1354`) → `TurnCompleted` → **"Worked for Xs"**. `ACTION_STATIONARITY_CATEGORY`는 pager에서 grep 0건. 게다가 이벤트 레일에도 `TurnOutcomeLabel::Completed`(`turn.rs:1092-1095`) | **기본 동작. 플래그 불필요.** 에이전트가 제자리걸음하다 강제종료된 것과 성공이 구분 불가 |
| 턴 상한이 "사용자 취소"로 표시 | `MaxTurnsReached` → `StopReason::Cancelled`(`turn.rs:1318-1323`) + `_meta.cancellationCategory="max_turns_reached"`(`commands.rs:94`) → `cancelled_turn_event()`(`turn_completion.rs:32-40`)가 **`HookDenied`만 구분** → `TurnCancelled` → **"Turn cancelled by user in 4m12s"**. `limit` 값은 버려짐 | **잠재적**. `--max-turns`가 TUI에선 무시되므로 커스텀 에이전트 정의의 `max_turns` 사용 시에만 발현. 헤드리스는 정상(`eprintln!("Max turns reached")`) |

**구조적 원인**: 멈춤사유→마커 매핑을 **4개 레일이 각자 재구현**(`dispatch/prompt.rs:1339`, `dispatch/turn.rs:638`, `turn_completion.rs:344`, `prompt_origin.rs:136`)하고 **넷 다 미인식 값을 `TurnCompleted`로 흘림**. `turn_completion.rs:357` 주석이 자인: `// end_turn / max_tokens / max_turn_requests / refusal / unknown → done.`
→ **새 멈춤 사유를 추가하면 네 곳 모두에서 조용히 "성공"으로 렌더링된다.**

> **우리 대응**: `exhaustive-record-classification-drift-guard` 패턴 그대로 — 닫힌 union을 `Record<Union,Verdict>`로 강제해 새 값 추가 시 컴파일 실패 + 런타임 drift-guard.

**아이러니**: `/goal` 패널엔 정답이 있다. `GoalDisplayStatus`(`app/agent.rs:380-399`) = `UserPaused / BackOffPaused / **NoProgressPaused** / InfraPaused / Blocked / Failed / Interrupted / BudgetLimited / Complete`, 라벨 `"Paused (no progress)"`, 재개 어포던스 `"Status: {label} — type /goal resume to continue"`(`goal_detail.rs:626-629`). **턴 단위 마커가 이렇게 생겼어야 하는데 `/goal` 안에서만 그렇다.**

### 5-3. 조기 하차 탐지 (FACT · 흡수)

`goal_stop_detector.rs` — 턴 최종 텍스트의 **마지막 문단**을 앵커 정규식으로 검사: `^Giving up`, `^Stopping here`, `^Ready for review`, `^VERDICT: (PASS|FAIL)`, `^Please (start|run|provide…)`, `N agents in flight`.
적중 시 `GoalPrematureStopDetected{pattern}` 발행(**패턴 라벨 포함 → 정밀도/재현율 사후 감사 가능**) + 하차 전용 계속 넛지 주입.
> 정규식이지만 **답안지 기반이 아니라 모델의 하차 화법**을 잡으므로 `no-answer-key-regex-heuristics` 위반 아님.

### 5-4. 실패 안전 기본값 (FACT · 흡수)

goal 상태 역직렬화 시 **모르는 값은 `Active`가 아니라 `UserPaused`로 떨어짐**(`goal_tracker.rs:99`).
원칙: **해석 불가능한 상태가 절대 "자율 주행 중"으로 보이면 안 된다.**

### 5-5. 체크포인트 / 되감기 (FACT)

```
RewindPoint (xai-grok-workspace/src/session/file_state.rs:284)
= { prompt_index, created_at, file_snapshots(BEFORE), after_snapshots(AFTER) }
FileSnapshot (:219) = { content: Option<String> }   ← 전문 텍스트. git object 아님, diff 아님
```
- 저장: append-only `rewind_points.jsonl`(`:371`)
- 입도: **사용자 프롬프트 단위**, 파일별 first-write-wins(`:311`)
- **after 세트의 목적은 외부 편집 탐지 → `conflicts`**
- `RewindMode { All | ConversationOnly | FilesOnly }`, 백엔드 기본 `All`(`acp_types.rs:303,328`)
- 🔴 **TUI는 `REWIND_MODE_WIRE = "conversation_only"` 하드코딩**(`pager/src/app/effects/mod.rs:4777`) → 파일 되돌리기가 ACP로는 노출되나 **TUI에서 도달 불가**. 튜토리얼도 "file changes are left as-is" 확인

> **판정**: 저장 방식(전문 JSONL)은 shadow git repo보다 명백히 약함 — 흡수 대상 아님. **before+after 쌍으로 충돌 탐지**하는 발상만 취할 것.

### 5-6. 세션 지속 (FACT)

세션 디렉터리별: `summary.json`, `chat_history.jsonl`, `updates.jsonl`, `plan.json`, `plan_mode.json`, `signals.json`, `goal/state.json`(`session/storage/mod.rs:32-38`). 원자적 temp+rename, macOS `F_FULLFSYNC`. `updates.jsonl`에 FTS 인덱스.
재개 `grok -c` / `/resume`, `fork.rs`가 `target_prompt_index`에서 분기.

**크래시 복구**: `~/.grok/active_sessions.json`에 `{session_id, pid, cwd, opened_at}` flock 기록. 정상 종료는 제거, 크래시는 잔존 → 다음 기동의 `collect_crashed()`가 죽은 PID 항목 회수. 시그널 핸들러용 **비차단 `try_unregister`**(경합 시 포기, 고아는 다음 기동이 정리). 손상 JSON은 warn 후 빈 목록으로 시작.

---

## 6. 작업 관리

### 6-1. 플랜 모드 (FACT · 흡수)

**4상태**: `PlanModeState { Inactive, Pending, Active, ExitPending }`(`plan_mode.rs:17-43`)
전이 상태는 재시작 시 접힘: `Pending→Inactive`, `ExitPending→Inactive + pending_exit_reminder`

**★ 계획이 모델이 넘긴 문자열이 아니라 디스크의 `plan.md`**
`exit_plan_mode`의 입력이 **의도적으로 빈 객체**(`mod.rs:37-38`) — 계획은 디스크에서 읽으므로 사용자는 모델이 *말한 것*이 아니라 *실제로 쓰인 것*을 본다.
경로: `~/.grok/sessions/<encoded-cwd>/<session-id>/plan.md`

**★ 편집 게이트가 프롬프트가 아니라 하드 거부**
`Active` 중 plan 파일 편집은 자동 승인, **그 외 편집은 묻지 않고 거부**(`tool_calls.rs:238-252`). **always-approve로도 못 뚫음.** `apply_patch`는 보수적으로 항상 거부.
단 **서브에이전트는 부모 게이트에 미포함**(각자 `Inactive` 트래커로 시작) — 문서에 명시.

**★ 승인 UI**: 스크롤 프리뷰 + **줄 범위 인라인 코멘트**(`c` 또는 Enter), 액션 `a approve` / `a approve w/ comments` / `s request changes` / `q quit plan`. `PlanApprovalFocus{Preview,Prompt,Commenting}`, `PlanComment{line_range,text}`.
**outcome fail-closed**: `"approved"|"abandoned"`만 인식, 미지 값은 플랜 모드 유지(`tool_calls.rs:264-274`).

**★ 승인 대기가 종료를 견딤**: `awaiting_plan_approval:true`가 `plan_mode.json`에 영속 → `--continue` 시 **셸이 `x.ai/exit_plan_mode` 역요청을 실제 ACP waiter로 재발행**(`session_setup.rs:1009-1012` → `SessionCommand::RestorePlanApproval` → `run_loop.rs:499`) → pager가 **자기 쪽 디스크 로직 0으로** 승인 UI를 원래 경로로 재표시. PTY 테스트로 검증(`scenarios/plan_approval_resume.rs:99-127`).

진입: `enter_plan_mode`(승인 필요) / `/plan [설명]` / **Shift+Tab** 순환(Normal→Plan→Always-approve). `/compact`도 견딤.

### 6-2. 할일 (FACT · 흡수)

`todo_write`(`todo/mod.rs:247`), kind `Plan`. 모델 대상 설명:
> "Create and manage a structured task list. The user sees this list live — it is your primary way to show progress. Use for any task with 3+ steps. Skip for trivial single-step work."

- **`merge: bool` 기본 true** — 바뀐 항목만 id로 보내면 됨. 상태만 뒤집으려면 id+status만
- **`TodoStatus` 4종: `pending | in_progress | completed | cancelled`** ← Claude Code에 없는 `cancelled`
- `TodoPriority`는 구조체에 있으나 write 경로가 항상 default를 씀 = **실질 dead**
- 모델이 `merge`를 빠뜨렸는데 모든 항목이 기존 id·content 없음이면 **자동 merge 승격**(`:337-344`)
- 저장: `IndexMap`(모델 작성 순서 보존, 상태 재정렬 안 함) → 타입드 리소스 `"grok_build.Todo"` → 디바운스 `resources_state.json`
- **작성권은 에이전트 전용** — `/todo` 슬래시 명령 없음, `TodoPane::handle_key`는 검색/필터/복사/`h`토글만
- 와이어는 ACP `Plan` 업데이트. ACP엔 `Cancelled`가 없어 **`Completed` + `meta.{cancelled:true}`로 인코딩 후 복원**(`tools/todo.rs:14-50`)

**렌더**: `Ctrl+T` 사이드 패널, 자동 표시 안 함. 글리프 `□`/`▶`(bold+warning)/`✓`(dim)/`✗`(strikethrough). **`todo_write` 툴 호출 자체는 트랜스크립트에서 숨김**(`acp/tracker.rs:2467-2476`) — 패널이 더 나은 표면이므로.
**미니멀 모드가 더 나은 디자인**: 프롬프트 **바로 위**에 flush-left로 붙고 **전부 완료되면 자동 숨김**, `Ctrl+T`로 고정. 넘치면 `… +N more · ctrl+t to expand`.

**★ TodoGate** (Claude Code에 없음): 턴 끝에 툴 호출이 없는데 미완/미뒷받침 in_progress 항목이 남으면 넛지 — "다음 pending을 지금 진행하거나, 사유를 적고 `cancelled`로 바꿔라". "뒷받침됨"의 정의 = 해당 in_progress 항목 뒤에 살아있는 백그라운드 작업/서브에이전트가 있음(`reminders.rs:15-53`).
기본 OFF, `--todo-gate` 또는 원격 `todo_gate_enabled`. 프롬프트당 발화 상한. 텔레메트리 `TodoGateFired`/`TodoGateExhausted`.

### 6-3. 서브에이전트 (FACT)

`task` 툴(별칭 `Task`, `spawn_subagent`). **`get_task_output`과 `kill_task`가 등록돼 있어야만 등록**됨 — 모델이 자기가 스폰한 걸 항상 관리할 수 있게.

```
prompt, description(3-5 words), subagent_type(기본 "general-purpose")
run_in_background: bool = true          ← 백그라운드가 기본 자세
isolation: "none" | "worktree"          ← worktree면 자식에게 격리 git worktree
resume_from: Option<String>             ← ★ 끝난 형제 서브에이전트의 raw 트랜스크립트를 이어받아 새 프롬프트 추가
cwd, model
(hidden) capability_mode, task_id
```
툴 설명은 **등록 시점에 살아있는 서브에이전트 로스터로 생성**(`builder.rs:1313`).

**진행 표시 3중**
1. **인라인 스크롤백 블록**(`scrollback/blocks/subagent.rs:44-72`) — **살아있는 `activity_label`**("Thinking", "Running: cargo build")이 **접힌 줄에** 표시되어 열지 않아도 자식 진행이 보임. Enter/Ctrl-F로 자식 전체 트랜스크립트
2. **통합 tasks 패널 `Ctrl+G`** — 백그라운드 명령 + 서브에이전트 + 워크플로 런 + `/loop`을 한 목록에. 실행중 우선·최신순, 행마다 스피너/✓/✗ + 경과 + 토큰 + `[✗]`kill + `[⤢]`view
3. **프롬프트 위 "still running" 상태줄** — `◎ 1 command · 2 monitors · 1 loop · 1 subagent still running`. **개수는 여기에만** 존재하고 트랜스크립트는 완료 칩 하나만 남김

진행 데이터: `SubagentInfo`(`app/subagent.rs:19-84`) = `last_progress_at, activity_label, context_usage_pct, tools_used, turn_count, pending_kill` + `ChildTranscript{NeedsReplay, DiskBacked, MemoryOnly}` 상태머신.
와이어: `SubagentProgress`가 **~2초마다** 토큰/컨텍스트%/툴호출수/에러수 발행(`subagent/mod.rs:2118-2173`).

### 6-4. 장기 작업 (FACT · 광고 대비 약함)

**4종**: ① bash `background:true` → `task_id` ② `monitor` 툴(스크립트 stdout을 줄 단위 대화 알림으로, `persistent:true`면 세션 수명, 볼륨 초과 시 자동 정지) ③ 스케줄러/`/loop`(`interval`="5m"/"2h"/"1d", `recurring`, `durable`, `foreground`, `fire_immediately`, `task_id`로 in-place 업데이트. **7일 후 자동 만료, 최대 50개**. 각 발화는 기본 **백그라운드 서브에이전트**로 실행) ④ 백그라운드 서브에이전트

**완료는 push**: `TaskCompletionReminder`가 매 툴 호출마다 터미널 백엔드+서브에이전트 코디네이터를 조회해 `<system-reminder>` 완료 텍스트를 툴 결과에 주입, `ReportedTaskCompletions`로 dedup.

**🔴 TUI 종료하면 다 죽는다**
기본 모드에서 에이전트는 **pager 안의 워커 스레드**(`acp/mod.rs:78,112`)이고 자식 프로세스 트리는 teardown 시 SIGKILL하는 `ProcessScope`에 묶임(`xai-tty-utils/src/process_scope.rs:1-19`).
유일한 detach는 **`--leader` 모드**(기본 OFF, 샌드박스 non-off면 거부). 스케줄러는 데몬이 아니라 **세션 재개 시 재무장**(`actor.rs:1356-1382`) — 프로세스가 없으면 아무것도 안 울림.
→ README의 "manages long-running tasks"는 실제로는 **세션 내 관리**.

### 6-5. 워크플로 (FACT)

Rhai 스크립트를 **모델이 툴로 호출**(`workflow` 툴). 입력: `agent_budget`(기본 128, 최대 1024 — `agent()`와 `parallel()` 항목마다 슬롯 소모), `name`/`script`/`script_path`, `args`, `resume_from_run_id`, `validate_only`(스모크 체크).
스크립트는 **`let meta = #{...}`로 시작해 `name`/`description`/`phases` 선언 필수**(`xai-workflow/src/meta.rs:9-25`) = 저자 선언 단계 체크리스트.
런은 저널링되어 **결정적 리플레이-재개 + 발산 탐지**(`journal.rs:11-45`). 엔진 샌드박스(eval 비활성, op/depth 캡).
tasks 패널에 `current_phase`·에이전트별 행·예산 회계로 렌더.

### 6-6. goal 모드 (FACT)

`update_goal` 툴 + `/goal`. **LLM 분류기가 모델의 완료 주장을 심판**하고 시도 상한·정체 탐지·자동 일시정지를 가짐. 자체 상세 뷰(`goal_detail.rs`)에서 할일 목록과 goal 상태를 함께 렌더.
`GoalDisplayStatus` 9종(§5-2 참조)이 **이 코드베이스에서 가장 legible한 상태 어휘**.

---

## 7. 프로토콜

### 7-1. ACP (FACT · 구조 흡수)

**Zed의 공개 표준** `agent-client-protocol = "0.10.4"`(`unstable` feature). crates.io 의존, 벤더링 안 함. 12개 crate가 의존.
**★ TUI 자체가 ACP 클라이언트** — 자기네 1급 UI가 쓰는 인터페이스와 에디터가 받는 인터페이스가 동일. 확장 메서드가 방대한 이유가 이것.

**표준 메서드 19종**
- client→agent 8: `initialize`, `authenticate`, `session/new`, `session/load`, `session/set_mode`, `session/prompt`, `session/cancel`, `session/set_model`
- agent→client 9: `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `session/update`, `terminal/{create,output,release,wait_for_exit,kill}`
- 확장 반송: `ext_method`, `ext_notification`
- (`unstable`) 추가 구현: `list_sessions`, `resume_session`, `close_session`

**`x.ai/*` 확장 — 문자열 295개, 실제 배선 223개**
= 에이전트측 요청 **167** + 클라이언트→에이전트 알림 **17** + 에이전트→클라이언트 역방향 **39**
나머지 ~72 = `_meta` 키, 라우팅 접두사 21, 테스트 픽스처

도메인별 요청 분포: session 24 / git 17 / worktree 12 / terminal 10 / mcp 10 / auth 9 / misc-UX 9 / skills+workflows 8 / hunk-tracker 8 / internal 8 / tasks·scheduler·subagents 6 / feedback·review 5 / fs 5 / code-nav 5 / cloud 5 / plugins 4 / search 4 / bundle 3 / memory 3 / debug 3 / hooks 2 / marketplace 2 / rewind 2 / billing 2 / pr 1

**🔴 결정적 비대칭**: 에이전트는 167개 요청을 처리하는데 **1급 TUI가 구현하는 역방향 핸들러는 2개뿐** — `x.ai/ask_user_question`, `x.ai/exit_plan_mode`. 나머지는 `-32601`(`acp_handler/mod.rs:821-834`).
→ 에디터가 에이전트를 *부리는* 능력은 풍부하고, 에이전트가 에디터에 *요구*하는 건 최소한.

**능력 협상이 실제 위임으로 이어짐**(`agent_ops.rs:4054-4087`):
```rust
let use_acp_fs = client_fs_read && client_fs_write;   // all-or-nothing
let fs = if use_acp_fs { AcpSessionFs } else { LocalFs };
let terminal = if client_terminal { AcpTerminalRunner } else { TerminalRunner };
```

**전송 하드닝**(`xai-acp-lib`)
- `stdin_reader.rs`: `tokio::io::stdin()`이 취소 불가라 **전용 OS 스레드 + 블로킹 std::io**. **Windows는 stdin을 dup하고 프로세스 핸들을 `NUL`로 재지정**해 떠도는 `std::io::stdin()` 리더가 데드락 못 만들게(`session/new` 중 행 관측됨)
- `line_reader.rs`: ACP의 `handle_io`가 `select_biased!`에 **취소 안전하지 않은** `BufReader::read_line`을 쓰므로, 완결된 `\n` 라인만 내보내 중간 서스펜드를 방지. `MAX_LINE_SIZE = 64 MiB`
- `normalize.rs`: Foundation/Swift 인코더가 뱉는 `\/` 이스케이프된 `method` 필드 재직렬화

**와이어 주의**: ACP는 선두 `_`가 있어야 커스텀 메서드를 `ext_*`로 라우팅 → 영속/릴레이 형태는 `_x.ai/session/update`.

### 7-2. SessionUpdate — 61종 (FACT)

표준 10 + xAI 50 + `Unknown` catch-all 1. 두 enum이 같은 `sessionUpdate` 태그를 공유.

**표준 10**: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `session_info_update`, `config_option_update`

**xAI 50 중 관측성 직결**
| variant | 페이로드 | 비고 |
|---|---|---|
| `subagent_progress` | duration/turn_count/tool_call_count/tokens_used/context_usage_pct/tools_used/error_count | ~2초 주기 |
| `subagent_spawned` / `subagent_finished` | 14 / 9 필드 | — |
| `goal_updated` | **30 필드** | 1초 rate-limit |
| `workflow_updated` | run_id/revision/phases/current_phase/agent_budget/agents_used/… | — |
| `retry_state` | `Retrying{attempt,max_retries,reason}` \| `Exhausted{attempts,reason,is_rate_limited}` \| `Failed{error_type,message}` | — |
| `pending_interaction` / `interaction_resolved` | `{tool_call_id, kind}` | **영속 안 됨** |
| `auto_compact_{started,completed,failed,cancelled}` | 토큰 before/after, elapsed, summary_preview | — |
| `auto_recovery_started` / `_exhausted` | attempt/max_retries/error/delay_ms | — |
| `task_backgrounded` / `task_completed` / `monitor_event` | — | fg→bg 승격 포함 |
| `scheduled_task_{created,fired,deleted}` | — | — |
| `hook_execution` / `hook_annotation` / `hooks_changed` | 훅별 run 결과 | — |
| `turn_completed` | prompt_id/stop_reason/agent_result/usage | **영속 레일** |
| `response_started` / `reasoning_completed` / `response_completed` | 토큰 버킷, 서명 | 앞 둘은 **Messages 백엔드 전용** |
| `image_compressed` / `image_dropped` | — | — |
| `model_auto_switched` / `model_changed` | — | — |

**영속 전용(UI 미전송)**: `compaction_checkpoint`, `rewind_marker`
**정의만 있고 프로덕션 emit 0**: `diff_review`(유일 생성이 테스트), `auto_continue_completed`(pager 리듀서는 소비하는데 셸이 안 만듦)

`_meta`에 `eventId`(`{sessionId}-{seq}`), `agentTimestampMs`, `turnStartMs`, `usage`. 벌크 리플레이는 `x.ai/session/updates`(offset 음수=tail, limit, turnIndex, stream) → 청크 알림, `chunkSize` 기본 64.

### 7-3. MCP (FACT)

**클라이언트 전용**. `rmcp 2.1`을 feature `client`만으로 사용(server 계열 미포함). 프로덕션 MCP 서버 없음(테스트 픽스처만). crate 자체가 `rmcp 2.1`+`reqwest 0.13`을 워크스페이스의 `reqwest 0.12`에서 **격리하는 quarantine 목적**도 겸함.

**전송**
| 전송 | 상태 |
|---|---|
| stdio | **구현**. `SafeTokioChildProcess`, `kill_on_drop`, 분리된 프로세스 그룹, 종료 유예 3초 후 그룹 kill |
| streamable HTTP | **구현**. rmcp `StreamableHttpClientTransport` + **자체 백오프 래퍼**(rmcp의 zero-backoff SSE 재연결 폭주 회피, 회귀 테스트 `repro_sse_flood.rs` 존재) |
| **SSE** | 🔴 **설정·CLI(`-t sse`)·`initialize` capability(`sse(true)`)로 광고하지만 전용 클라이언트 없음.** `start_mcp_server`가 `Sse`를 `Http`와 **같은 arm**에서 처리. 레거시 HTTP+SSE 서버(별도 `/sse` GET + `/messages` POST)는 동작 안 함 |
| ACP 역채널 | xAI 자체. SDK 호스트의 in-process MCP 서버를 `x.ai/mcp/sdk_call`로 터널링. **half-duplex** — server→client(`notifications/*`, `sampling/createMessage`, `roots/list`, elicitation) **미전달** |

**클라이언트 능력**: `ClientCapabilities::default()` + `io.modelcontextprotocol/ui` 확장 하나. **roots·sampling·elicitation 미선언.** 프로토콜 버전 **`V_2025_11_25` 명시 핀**(rmcp bump가 와이어를 조용히 옮기지 못하게).

**거버넌스 (흡수 후보)**
- 네임스페이싱 `server__tool`, 구분자 `"__"`
- `parse_mcp_qualified_name`: **정확히 하나의 `__` 경계** 요구(overlap-aware 바이트 윈도우 스캔 → `a___b` 거부), 전체가 `ToolId` 규칙 통과 필요
- 이름 검증 정규식 `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` = **Anthropic/OpenAI/Gemini 규칙의 교집합**(주석 명시). 불일치 시 **자르지 않고 skip**
- 중복 등록은 조용한 덮어쓰기가 아니라 **하드 에러**
- 타임아웃 4단계 precedence + 전역 tier 5단계. **기본 startup 30s / tool 6000s**(⚠️ 주석은 "60s"라 적혀 있음 — **100배 doc/code 불일치**)
- **타임아웃 시 재시도 안 함** — "부작용 있는 느린 툴이 두 번 실행되면 안 됨"
- 덴리스트만 존재(allowlist 없음): `[disabled_mcp_tools.<server>]` 정확 이름, 글롭 불가. 서버 단위는 `disabled_mcp_servers`
- ⚠️ stdio의 `cwd`는 **파싱만 하고 버림**(`mcp.rs:422` `cwd: _`) — 표준 `.mcp.json`이 에러 없이 엉뚱한 디렉터리에서 실행됨

**OAuth**: RFC 8414 + RFC 9728 **선제 탐색**(401 반응이 아니라 연결 전), 5초 상한. DCR(RFC 7591) 클라이언트명 **`"Grok"`**. PKCE + 루프백 `http://127.0.0.1:{port}/callback`. **완료 감지가 2중 레이스** — 루프백 콜백 또는 2초 주기 자격증명 파일 폴링(다른 창에서 끝낸 로그인 수용). 2중 dedup(flock + in-process watch). 브라우저 상한 600초. 저장 `$GROK_HOME/mcp_credentials.json`(0600, flock reload-merge, **OS 키체인 아님**). 비대화형은 **fail-closed**.

**★ `search_tool`/`use_tool` 간접화 (흡수)**: **무조건, 임계값 없음**. MCP 툴은 모델의 툴 목록에 **절대 안 들어감** — 서버가 연결돼도 툴셋(따라서 KV 캐시)이 안 바뀌도록. `search_tool{query, limit=5}`가 BM25로 `{server} {tool} {description} {params}` + 식별자 분해 성분을 검색, **정확 매칭 fast path**는 BM25 우회. 응답에 `total_hidden_tools`와 `status:"ready"|"partial"`. 연결된 서버는 `<system-reminder>`로 `- name (N tools): desc`만 announce하고 **툴 이름은 일부러 제외**(발견은 search_tool의 일).
> 문서(`07-mcp-servers.md`)의 "내장 툴과 나란히 사용 가능해진다"는 이 간접화 때문에 **오해 소지**.

**리소스**: `list_resources`/`read_resource` 구현, 단 **클라이언트 UI에만** 노출(모델 호출 불가).
**프롬프트**: `prompts/list`·`prompts/get` **완전 미구현**.

**설정 위치 우선순위**(name-keyed, compat 티어는 first-writer-wins): 프로젝트 `.grok/config.toml`(git root→cwd, 가까운 쪽 승) > 전역 `~/.grok/config.toml` > `~/.claude.json` > `.cursor/mcp.json`(cwd 후 홈) > `.mcp.json`(repo root→cwd).
compat 티어는 **"Phase 2 cutoff"** 적용 — 사용자가 임포트를 한 번 실행하면 그 파일들을 더 이상 읽지 않음.

### 7-4. LSP (FACT)

**어떤 language server도 번들/기본 제공 안 함.** 기본 서버 테이블 없음, 파일타입 자동감지 없음, 다운로더 없음 — 전부 선언 필요.
설정: `~/.grok/lsp.json`(User) + `<cwd>/.grok/lsp.json`(Project, 이름 단위 override) + 플러그인 기여(`.lsp.json` 또는 인라인). **플러그인은 빈틈만 채움**(`or_insert_with`) — user/project를 못 덮음. 미신뢰 폴더면 Project 소스 드롭.

`LspServerConfig`: `command`(필수), `args`, `transport`(`stdio` 기본 | `socket`, **둘 다 구현**), `env`, `extensions`, `initialization_options`, `settings`, `workspace_folder`, `workspace_open`(Roslyn류용 `solution/open`), `startup_timeout`(15,000ms), `shutdown_timeout`(5,000ms), `restart_on_crash`(false), `max_restarts`(3, **평생 예산**). 요청 타임아웃 30초.

**모델 대상 연산 6종**: `goToDefinition`, `findReferences`, `hover`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`. read-only. `Arc<dyn LspBackend>` 리소스 부재 시 **lsp.json 두 경로를 명시한 실행 가능한 에러**.
진단은 별개 경로 — `publishDiagnostics` 수집 + `textDocument/diagnostic` pull → 시스템 리마인더.

**⚠️ `x.ai/code/*` 5종은 LSP가 아님** — `xai-codebase-graph` **정적 인덱스** 백엔드, cwd별 spawn/재사용, 첫 사용(신규 spawn) vs 재사용 지연을 텔레메트리로 구분. **좌표가 1-indexed**(LSP 툴은 0-indexed).

---

## 8. 확장성

### 8-1. Skills (FACT)

`SKILL.md` = YAML frontmatter + 마크다운. Claude Code와 같은 형태.

**프론트매터 전 필드**
| 필드 | 기본값 | 비고 |
|---|---|---|
| `name` | 디렉터리 basename(또는 `commands/*.md`는 파일 stem) | 슬러그 정규화, `[a-z0-9-]`, ≤64 |
| `description` | 본문에서 유도(첫 heading/문단) | ≤1024자 |
| `when-to-use` | None | ≤1024자 |
| `allowed-tools` | None | 🔴 **강제되지 않음**(§8-1 하단) |
| **`paths`** | None | 🔴 **문서 미기재**. gitignore 글롭 |
| `model`, `effort`, `license`, `compatibility`, `argument-hint` | None | — |
| `metadata` | None | 문자열 값만, `short-description`/`author`는 승격 |
| `user-invocable` | **true** | — |
| `disable-model-invocation` | **false** | true면 시스템 프롬프트엔 보이되 Skill 툴에서 제외 |

파서는 3단 복구: 평문 → YAML 지시자 포함 값 인용 후 재파싱 → `RECOVERABLE_KEYS` 줄 단위 salvage. 프론트매터 4 KiB 상한, 본문 peek 2 KiB, 스킬 walk 깊이 5.

**★ `paths:` 지연 노출**: 비어있지 않으면 **툴이 매칭 파일을 건드리기 전까지 모델 목록에서 제외**, 이후 세션 내내 활성. `ConditionalSkills`가 `held`/`activated`/`dynamic_paths` 관리, `ignore` crate `GitignoreBuilder` + `matched_path_or_any_parents`(bare dir 패턴이 하위 파일 매치), cwd 접두 렉시컬 strip(아직 없는 파일도 동작). `/clear`가 `rehide()`.

**★ 점진 노출 예산**: **모델 컨텍스트의 50%**(윈도우 미상이면 400,000자). 항목당 `description`+`when_to_use` 합쳐 **400 B 상한**, 비례 축약 시 하한 20자. 3단 degradation — 전문 → 비례 축약 → 이름만 + 오버플로 표시.
**시스템 프롬프트는 절대 변형 안 함**(`skill_discovery_tracker/mod.rs:63-66`) — 목록은 user-role system-reminder로 주입.

**★ 네이티브 Skill 툴이 없다**: `config.rs:386`에 `// (&grok_build::SkillTool).into(),` 주석 처리. 등록된 건 `opencode::OpenCodeSkillTool`(opencode 호환용)뿐. 네이티브에선 모델이 **광고된 절대경로를 `read_file`로 읽어** 펼침.
> 문서는 모델이 스킬을 "호출"하는 것처럼 서술 — **불일치**.

**발견 스코프 6단**(낮을수록 우선): `Local=0`(cwd) → `Repo=1`(cwd~git root) → `User=2`(`~/.grok`,`~/.agents`,`~/.claude`,`~/.cursor`) → `Server=3` → `Bundled=4` → `Plugin=5`. 각 레벨에서 `.grok`/`.agents` 항상, `.claude`/`.cursor`는 compat 게이트.
**벤더 기본 스킬 덴리스트**: `.cursor/` 경로의 14종(babysit, canvas, create-hook, …), `.claude/`의 5종(pdf, docx, xlsx, pptx, skill-creator) 드롭. 경로 기준이라 같은 이름의 사용자 스킬은 생존.
**동일 스코프 충돌**: 도전자를 디렉터리 basename으로 re-key, 프론트매터 `name`은 `display_name`으로.

**치환 토큰**: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`(인자 토큰 — 이게 있으면 `**ARGUMENTS:**` 접미 억제), `${SKILL_DIR}`/`${CLAUDE_SKILL_DIR}`, `${SESSION_ID}`, `${GROK_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}`, `${GROK_PLUGIN_DATA}`(경로 토큰 — 접미 억제 안 함). 본문 상대 링크는 스킬 디렉터리 안이면 절대경로화.
**미지원**: `` !`bash` `` 명령 치환, `@file` 포함(grep 확인).

🔴 **`allowed-tools`는 advisory only** — 파싱·저장·`x.ai/skills/list` 와이어 전송까지 하지만 **유일한 비테스트 소비자가 TUI 확장 모달의 표시용 행**. 툴 호출 시점 필터가 코드 어디에도 없음. 진짜 강제는 `AgentDefinition::tools`/`disallowed_tools`(다른 필드).

**슬래시 명령 = 스킬과 동일 객체**: `commands/*.md`(flat, 재귀 없음)가 **같은 파서·같은 스키마**를 씀. 별도 명령 스키마 없음.

### 8-2. Plugins (FACT)

매니페스트 위치 순서: `plugin.json` → `.grok-plugin/plugin.json` → `.claude-plugin/plugin.json`. 없으면 관례 기반.
**기여 6종(닫힌 enum + `categories() -> [_; 6]` SSOT)**: `Skills`, `Commands`, `Agents`, `McpServers`, `Hooks`, `LspServers`. **UI/테마 확장 없음, 툴 직접 주입 불가**(툴은 MCP 경유만).
매니페스트 경로는 canonical 후 플러그인 루트 접두 검사 — 탈출 경로는 warn + 드롭(fail-closed).
인라인 hooks/mcpServers/lspServers는 **전부 실제 구현**(파싱만이 아님).

**발견 순서**: CLI `--plugin-dir`(항상 신뢰) → `.grok/plugins`·`.claude/plugins`(cwd→git root, **신뢰 필요**) → `$GROK_HOME/plugins`·`~/.claude/plugins`·`~/.grok/installed-plugins`·claude 마켓플레이스 클론(항상 신뢰) → `[plugins].paths`.
`PluginId` = `<scope>/<sha256[..8] of canonical root>/<name>`.

**신뢰 모델**: 플러그인 **루트 단위**(worktree 단위 아님), 스토어 `~/.grok/trusted-plugins`. **미신뢰 프로젝트 플러그인은 스킬·에이전트는 여전히 발견·목록화(메타데이터만), 훅·MCP·스크립트만 차단.** canonicalize 실패 → 미신뢰(fail-closed).
🔴 **서명/체크섬 검증 없음.** 유일한 공급망 통제는 **기본 꺼짐**인 커밋 SHA 핀(`[marketplace].require_sha`, tighten-only). 설치는 `git clone/fetch`(설치 시 라이프사이클 스크립트 없음) — 코드 실행은 *신뢰된* 플러그인의 훅/MCP/LSP가 돌 때.

**설치 소스**: HTTPS git URL / SSH git URL / GitHub 단축 `owner/repo` / 로컬 경로. 전부 `@ref`·`#subdir` 접미 지원. **타르볼/레지스트리 소스 없음.**
**마켓플레이스**: `SourceKind::{Local{path}, Git{url,branch?}}`, 인덱스 `.grok-plugin/marketplace.json` 등 4경로 탐색. 경로 안전성: `MarketplaceRelativePath::parse`가 절대경로·`..`·후행 `.`·Windows 드라이브/UNC 거부, `join_under`가 canonicalize 후 재검사(심볼릭 `plugins/` 탈출 차단). 기본 공식 소스 `github.com/xai-org/plugin-marketplace.git`, 캐시 `~/.grok/marketplace-cache`(5분 TTL).

### 8-3. 에이전트 정의 (FACT)

발견: `.grok/agents`·`.claude/agents`(cwd→repo root, Project) → `~/.grok/agents`·`~/.claude/agents`(User) → `~/.grok/bundled/agents`(Bundled) → BuiltIn.
우선순위 `Project=3 > User=2 > Bundled=1 > BuiltIn=0`, **단 내장 이름(`explore` 등)은 Project 스코프만 덮을 수 있음** — 사용자 레벨 `~/.grok/agents/explore.md`는 내장을 못 이김.

스키마: `name`,`description`(필수), `prompt_mode`, `tool_config`, `capability_mode?`, `permission_mode`, `skills[]`, `discover_skills`(true), `inherit_skills`(true), `agents_md`(true), `inject_default_tools`(true), `tools[]`, `disallowed_tools[]`, `effort?`, **`max_turns?`**, `isolation?`, `background?`, `color?`, `initial_prompt?`, `mcp_servers[]`, `mcp_inheritance`, `hooks?`, `memory?`, `model`, `completion_requirement?`, `tool_overrides?`

---

## 9. CLI · 설정

### 9-1. 서브커맨드 23개 (FACT)

`agent`(+`stdio`/`headless`/`serve`/`leader`), `inspect`, `doctor`(+`fix`), `leader`(list/info/kill), `login`, `logout`, `mcp`(list/add/remove/enable/disable/doctor), `plugin`(list/install/uninstall/update/enable/disable/details/validate/tag/marketplace…), `memory clear`, `models`, `sessions`(list/search/delete), `setup`, `share`, `wrap`, `export`, `trace`, `update`, `version`, `completions`, `worktree`(list/show/rm/gc/db), `du`, `workspace`(start/pause/resume/stop/restart/status), `dashboard`

**특이**
- 🔴 `share`: 커맨드 자체 `hide=true` + 핸들러가 무조건 `bail!("Session sharing is temporarily disabled")` — **죽은 커맨드**
- `workspace`: hidden + **서버측 계정 플래그** 게이팅. 원격 설정 못 읽으면 `WorkspaceGate::Unknown`으로 **fail-closed 거부**. 샌드박스 프로필 있으면 start/restart/resume 거부
- `dashboard`: 진짜 서브커맨드가 아니라 env 세팅 후 `args.command=None`으로 되돌리는 소프트 커맨드
- ⚠️ 번들 README에 문서화된 `grok ssh`는 **이 빌드의 `enum Command`에 없음**(README stale)
- `agent serve --bind` 기본 `127.0.0.1:2419`, `--secret` 미지정 시 12자 랜덤

### 9-2. 최상위 플래그 64개 (그중 hidden 20 + cfg-gated 3) (FACT)

전량은 `app/cli.rs:410-802`. 주요 기본값:
| 플래그 | 기본 | 비고 |
|---|---|---|
| `--output-format` | `plain` | `plain\|json\|streaming-json\|streaming-messages-json` |
| `--max-turns` | **없음** | **TUI에서 무시**(경고 후 버림) |
| `--background-wait-timeout` | **600초** | hidden. 첫 턴 후 백그라운드 대기 = **기본 동작** |
| `--no-wait-for-background` | false | hidden |
| `--todo-gate` | false | hidden. **원격·기본값 모두 무시하는 세션 최고 우선순위** |
| `--sandbox` | 없음 | env `GROK_SANDBOX` 백업 |
| `--always-approve` | false | 별칭 `--yolo`, `--dangerously-skip-permissions` |
| `-w/--worktree` | 없음 | **헤드리스(`-p`)에선 워크트리 미생성** |

env 백업 플래그 3개: `--sandbox`←`GROK_SANDBOX`, `--log-sampling`←`GROK_LOG_SAMPLING`, `agent serve --secret`←`GROK_AGENT_SECRET`.

### 9-3. 헤드리스 (FACT)

**stdin을 프롬프트로 읽지 않음.** 입력은 `-p/--single`(별칭 `--print`) / `--prompt-json` / `--prompt-file` 셋 중 하나.
출력 4포맷 중 **`streaming-messages-json`은 Anthropic Messages API 와이어 클론** — `system/init`, `assistant`(content blocks `text`/`thinking`/`tool_use`/`server_tool_use`/`web_search_tool_result`), `user`(tool_result), `stream_event`(`--include-partial-messages`), `result`(subtype `success|error_max_turns|error_during_execution|error_max_structured_output_retries`).
→ **Claude Code용 CI 파이프라인 재사용을 노린 설계.** `--allowedTools`/`--disallowedTools` 별칭도 같은 의도.

권한은 비대화형 구조 — `--always-approve`면 자동 승인, 아니면 모든 `RequestPermission`을 `Cancelled`.

**종료 코드**(직접 검증): 일반 경로 `0`(21곳) / `1`(41곳) / `2`(2곳, managed-config requirements 검증 실패). **시그널 경로 별도** — Ctrl+C `130`, SIGTERM `143`, SIGHUP `129`(`app/signal_handler.rs:129-149`), 그 외 `128 + signal` 1곳.
> 서브에이전트 2건이 이 항목에서 서로 다른 답을 냈고(하나는 "0/1/2뿐", 하나는 "130/143/129"), **둘 다 반쪽만 맞았음**. 정답은 합집합.

### 9-4. 설정 레이어 7단 (FACT · 흡수)

```
1 /etc/grok/managed_config.toml          (Unix 전용)
2 $GROK_HOME/managed_config.toml
3 $GROK_HOME/config.toml
4 GROK_CONFIG(인라인 JSON) / GROK_CONFIG_PATH(파일)   ← env 오버레이
5 $GROK_HOME/requirements.toml           (Ed25519 서명 검증 가능)
6 /etc/grok/requirements.toml
7 macOS MDM (도메인 ai.x.grok, requirements_toml_base64)  ← 최상위
```

**★ env 오버레이가 닿는 범위가 허용목록으로 제한**(`config_layers.rs:37-61`): `models`, `features`, 좁힌 `toolset`(`[toolset.bash] login_shell_capture` + `[toolset.web_search]` 도메인), `shell_environment_policy`의 **필터 필드만**(`set`은 드롭 → env 주입 불가). 그 외 전 테이블 **fail-closed 드롭**.
**★ 보안 게이트는 오버레이 없는 병합본을 따로 읽음**(`config_layers.rs:62-69`): permission mode, plan approval, auto permission mode+classifier, remember tool approvals, `remote_fetch`, managed-config fetch, marketplace `require_sha`, ZDR access, folder trust, `[permission]` allow/deny, `[cli]` 버전 바운드.
→ **환경변수로 하네스 설정은 주입하되 권한 상승은 구조적으로 불가능.**

**MDM은 admin-forced 값만** 읽어 로컬 유저 위조 불가, `$VAR` 확장도 **일부러 안 함**.
**캠페인 패치 후 requirements를 재병합**해 저신뢰 레이어가 관리자 필드를 못 덮게 함(`config_layers.rs:244-265`).

**프로젝트 로컬 `.grok/config.toml`은 전체 병합 레이어가 아님** — `[mcp_servers]`, `[disabled_mcp_*]`, `[plugins].paths/.disabled`, `[permission]`만 섹션별로 기여.
`pager.toml`은 **별도 파일**(TUI 외형 전용, config.toml 체인과 무관).

**`requirements.toml`이 강제 가능한 항목 40+**: 기능 플래그 15개 전량, 샌드박스 프로필, 전 egress 엔드포인트, 텔레메트리 목적지, 릴리스 채널·버전 하한/상한(구버전 기동 차단), 모델, `[memory].enabled`, `[subagents].enabled`, `[permission]` 규칙, 훅, 그리고 **`[ui].yolo=false`가 `--yolo` 플래그 자체를 무력화**.
`GROK_MANAGED_CONFIG_FAIL_CLOSED`로 정책 검증 실패 시 실행 거부 가능.

### 9-5. 환경변수 387개 (FACT)

비테스트 코드에서 **실제로 읽히는** 것 387개(GROK_/XAI_/OTEL_ 리터럴 전체는 570개, 에이전트가 자식에 *설정*하는 것 포함).
그룹: 홈/경로, config 오버레이, 인증(OAuth2/OIDC/외부 provider), 엔드포인트, 기능 플래그 레지스트리 15, 기타 토글, 퍼미션/샌드박스/신뢰, 모델, 컴팩션, MCP, UI/터미널, 클립보드/PTY, 텔레메트리/OTel(표준 `OTEL_*` ~30 포함), 업데이트, 로깅/디버그, 성능/한계, 워크스페이스(~40), 워크트리, compat(18 = 3벤더 × 6서피스), 훅 주입, 시스템 표준, 빌드타임.

**불리언 파싱**: `""`, `"0"`, `"false"`, `"off"`, `"no"`만 falsy — **그 외 전부 truthy**(`main.rs:408-415`).

---

## 10. TUI 표면

`xai-grok-pager` 537 rs 파일, `views/`만 67.8K줄. 전수 census 약 470행(별도 표 보유). 여기엔 구조적 발견만 기록.

### 10-1. 죽은 기능 (FACT)

| 기능 | 상태 | 근거 |
|---|---|---|
| **세션 공유 전체** | `app.sharing_enabled`가 **하드 `false`**, 코드 어디서도 true 안 됨. CLI도 `bail!` | `app/event_loop.rs:1046`, `share_cmd.rs:12` |
| **인라인 메시지 편집** | `INLINE_EDIT_ENABLED: bool = false` 컴파일 상수로 진입점 차단 | `app/inline_edit.rs:33` |

### 10-2. "vim 모드" 실체 (FACT)

**프롬프트에 vim 서브모드/오퍼레이터/모션이 아예 없음** — readline 바인딩뿐.
게다가 `simple_mode` 기본 **true**(프롬프트 vim OFF) + `vim_mode` 기본 **false**(스크롤백 vim OFF) → `defaults.rs`에 등록된 `j/k/h/l/y/Y/e/E/r/o/O/x` 문자 바인딩이 **out-of-box 전부 비활성**이고 `lookup_with_mode`가 억제.

### 10-3. 키 리맵 미구현 + 소스 주석 거짓 (FACT)

설정 레지스트리가 받는 건 `screen_mode`와 `mouse_reporting_toggle` 둘뿐. `actions/defaults.rs:900` 등 **주석 2곳이 "config.toml로 리바인드 가능"이라 주장하지만 거짓**. 이 경우 **문서(`03-keyboard-shortcuts.md`)가 맞고 코드 주석이 틀림**.

### 10-4. 터미널 대응 (FACT · 참고 가치)

**진단 15종** + `--fix` 자동수정 5종: tmux OSC52 passthrough, DCS passthrough, tmux control mode, Byobu+screen, Apple Terminal OSC52 미지원, tmux 3.3+ `extended-keys=off`(CSI-u 소실), 알림 프로토콜 BEL 폴백, CSI focus 미지원, **WezTerm `enable_kitty_keyboard` 기본 false**(Shift+Enter 불가), **GNOME ≤47 Wayland data-control 부재**, truecolor 미만, tmux 팔레트 재작성, 샌드박스 프로필 충돌, `grok wrap` 없는 SSH.
**키맵이 터미널 브랜드별 5축 분기** — VSCode 계열 / local-mac-VSCode / Apple Terminal / `ctrl_dot_unreliable`(KKP skip·WSL·Windows) / minimal. **같은 액션이 4가지 다른 chord**를 가짐.

### 10-5. 🔴 기본값 판정 함정 (FACT · 우리에게 직접 교훈)

**필드 선언만 보고 기본값을 판정하면 오판한다.**
- contextual hints: 구조체 필드 기본 `false`인데 앱이 설정(기본 true)으로 주입 → **실효 ON**
- `InputMode` enum은 `Vim`이 `#[default]`인데 실효 기본은 **`Simple`**
- 같은 "제안" UX인데 프롬프트 제안 기본 **ON**, 셸 제안 컨트롤러 기본 **OFF**로 게이트 분리
- `appearance/watcher.rs`는 파일명이 watcher지만 prod 빌드는 static 로드만 → `.changed()`가 절대 안 뜸
- `/workflows`의 `visible()`은 하드코딩 true — `AppCtx.workflows_available` 게이트 필드가 **사문화**

### 10-6. 기본 OFF로 숨은 완성 기능 (FACT)

`/auto`(fail-closed hidden), `/loop`·`/imagine`·`/imagine-video`(툴 게이트), `/recap`·`/voice`(레지스트리 hidden), selection buttons, dual line numbers, RTL bidi, mouse-reporting toggle, suggestion controller, plugin CTA, workspace dashboard, privacy banner, remember 모드(`#`), iTerm2 이미지 프로토콜.
**미지원 확인**: Sixel(참조 0건), IME 프리에디트(터미널 위임), 사용자 정의 슬래시 명령(스킬로만).

---

## 11. 죽은 코드 · 미배선 인벤토리

### 11-1. 정량 (FACT · 적대검증 실측)

| 지표 | 값 |
|---|---|
| `#[allow(…dead_code…)]` first-party | **140** (테스트 26) |
| 그중 `reason=` 문서화 | **9 / 140** |
| lint 스코프 내 라인 | ~25,900 (1.6%) — **상한이지 죽은 라인 아님** |
| **검증된 도달 불가** | **~5,290 라인 = first-party의 0.32%** |
| 그중 한 모듈(`attempt_store`) 비중 | **86%** |
| `cfg(feature=…)` 사이트 | 340, 15 feature. `local-workspace`가 221(65%), **기본 feature set에 없음** |
| `#[path="*_stub.rs"]` 교체 | 3 (283줄) |

### 11-2. 개별 항목 판정 (FACT)

| 항목 | 판정 | 분류 |
|---|---|---|
| `attempt_store/` 4,525줄 | **CONFIRMED dead** | (a) 진짜 죽음. 단 주석에 "No-caller canonical attempt records" 자인 |
| `SessionEvent::TurnHalted` | **CONFIRMED dead** (정의·렌더 arm·테스트만, 프로듀서 0) | (a) |
| `network_policy.rs` 501줄 | **CONFIRMED** 미집행 | (b) 소스 주석 자인 |
| `PermissionMode` 6변형 | **CONFIRMED** — 단 이건 *에이전트 정의 spawn* enum만. 셸 자체 enum은 완전 배선 | (b) |
| `RewindMode::All` | **CONFIRMED** — ACP로는 도달, **TUI 하드코딩으로 미도달** | (d) 비기본 경로 |
| laziness 탐지 | **CONFIRMED** default-OFF + `max_nudges=0` | (d) 2단 opt-in, 경로는 살아있고 계측됨 |
| `deploy_app` 스텁 | **재분류** — 죽은 코드가 아니라 **export용 스텁 교체** | (c) 사내 빌드 전용 |
| `StopReason::MaxTokens/MaxTurnRequests` | **REFUTED** — 외부 crate enum이고 exhaustive match라 필수. max-tokens는 stop reason이 아니라 **에러로 보고하는 설계** | 오류였음 |
| `FileOperationLockManager` | 구현·re-export되나 **획득하는 툴 0** | (a) |
| `diff_review` SessionUpdate | 정의·소비자 있으나 프로덕션 emit 0 | (a) |
| `auto_continue_completed` | pager 리듀서가 소비하나 셸이 생성 0 | (a) |
| Cursor 외부세션 스캐너 | 항상 빈 `Vec` 반환 = **스텁** | (a) |
| `ShuttingDown.delay_ms` | 필드 존재하나 항상 0 | (b) |
| cgroup 메모리 제한 | 테스트에만 존재, 프로덕션 미배선 | (a) |

### 11-2b. 런타임 축 INERT 추가분 (FACT · 전부 grep으로 호출자 부재 확인)

| # | 항목 | 근거 |
|---|---|---|
| 1 | `attempt_store/**` 전체 (~2,700줄 비테스트) | `mod attempt_store;` 선언 1줄이 유일 참조 |
| 2 | **relocation 쓰기 경로 전체** (`stage_and_publish`/`mark_ready_and_commit`/`rollback`) | 5단계 프로토콜 완전 구현, 호출자 0 |
| 3 | `WorktreePool::new` / `try_claim` | live 경로는 `cleanup_stale_pool_worktrees`뿐 |
| 4 | **conversations lane** | `conversations_lane_enabled()`가 리터럴 `false` → `GROK_SESSION_LIST_CONVERSATIONS`·`GROK_CHAT_MODE` **무효** |
| 5 | `persistence::load()` full | `#[expect(dead_code, reason="wired when session restore flow calls load")]` |
| 6 | `claude_import_state` 변화감지 | hash를 **쓰기만 하고 비교 함수 없음** |
| 7 | `/import-claude` UI | `AppView.has_claude_import`가 `false` 초기화 후 **true 대입 0건** |
| 8 | `parallel_tool_calls`(Responses), `stop_sequences`(Messages) 송신 | — |
| 9 | `SamplerConfig.reasoning_effort`, `supports_backend_search`, `CompactionPolicy::compact_model`, `auto_continue`, `AUTO_CONTINUE_PROMPT`, `use_short_prompt`, summary-before-recent carrier, `ChatStateHandle::check_auto_compact_needed` | — |
| 10 | `SubagentRuntimeOverrides::{harness_agent_type, output_schema, output_token_budget}` + `buffered_completion_output_cap` | — |
| 11 | **`TurnInputContributor` / `CommandContributor` 확장 레일** | 트레이트 정의만, 구현체·디스패치 사이트 **0건** |
| 12 | goal: `total_verify_rounds`, `budget_limit_reported`, `live_context_window`, deliverables wire 필드 5종, `[goal] planner_model` | — |

### 11-2c. 버그성 발견 (FACT)

| # | 내용 | 근거 |
|---|---|---|
| 1 | `chat-history-downgrade`가 `BackendToolCall`에서 pending reasoning을 **in-process 정본과 다르게 소비**. 테스트 미커버 | `chat-history-downgrade.rs:106-108` vs `chat_completions.rs:211-215` |
| 2 | Claude 임포트의 project-scope MCP 서버 오분류 — **코드가 스스로 `TODO(phase-2)`로 인정** | `claude_import.rs:457-465` |
| 3 | `GoalStatus` doc이 "six variants"인데 실제 **8종** | `goal_tracker.rs:53` vs `:64-84` |
| 4 | 🔴 `_GROK_CLAUDE_MARKER_OVERRIDE` env가 **`#[cfg(test)]` 가드 없이 프로덕션에서 읽힘**. `=="1"`이면 모든 Claude 호환 흡수 경로 OFF | `permission/claude_settings.rs:535` |

### 11-3. 종합 판정

**라인 수로는 평범(0.32%), 기능 수로는 눈에 띔.** 세션 공유·인라인 편집·파일 되감기·vim 모드처럼 **완성돼 보이는 사용자 기능이 통째로 도달 불가**한 사례가 여럿. 모노레포 export 특성상 소비자가 미공개인 코드가 딸려오는 건 정상이나, `sharing_enabled = false` 하드코딩이나 `INLINE_EDIT_ENABLED = false`는 export 아티팩트가 아니라 **의도적 비활성**.

> **우리 관점 하이라이트**: 전체적으로 죽은 코드가 적은 코드베이스인데, 하필 **"에이전트가 진전을 못 냈다"는 그 한 문장(`TurnHalted`)만 배선이 안 됐다.** 우연한 방치라기보다 관측성이 우선순위에서 밀린 흔적으로 읽힌다.

---

## 12. 문서 ↔ 코드 불일치 / 미확인

### 12-A. 확인된 불일치 (FACT)

| # | 내용 | 어느 쪽이 틀림 |
|---|---|---|
| 1 | MCP 툴 타임아웃 기본값: 주석 "60s" vs 상수 **6000s** (100배) | 주석 |
| 2 | MCP `cwd` 파싱 후 **버림** → 표준 `.mcp.json`이 에러 없이 엉뚱한 디렉터리에서 실행 | 코드(사일런트) |
| 3 | MCP SSE: 설정·CLI·`initialize` capability 모두 광고, **전용 클라이언트 없음** | 코드 광고 |
| 4 | Skills `paths:` 필드 문서 미기재 | 문서 |
| 5 | Skills 문서가 모델의 스킬 "호출"을 서술하나 **네이티브 Skill 툴 없음** | 문서 |
| 6 | MCP 문서 "내장 툴과 나란히 사용 가능" — 실제는 `search_tool`/`use_tool` 간접화 | 문서 |
| 7 | 헤드리스 문서가 종료코드 129(SIGHUP) 누락 | 문서 |
| 8 | 키 리맵 "config.toml로 가능"이라는 **소스 주석 2곳이 거짓** | 코드 주석 |
| 9 | `/session-info` 별칭 `/status`,`/info`가 **문서에만** 존재 | 문서 |
| 10 | `/transcript`·`/recap`·`/voice`·`/cd`·`/queue`·`/tasks`·`/announcements`·`/toggle-mouse-reporting`이 **코드에만** 존재 | 문서 |
| 11 | 번들 `~/.grok/README.md`의 `grok ssh` 서브커맨드가 **이 빌드에 없음** | 문서 |
| 12 | `docs/internal/` 미공개인데 테스트가 `include_str!`로 참조 → 그 타깃 컴파일 불가 | export 누락 |
| 13 | 존재하지 않는 `grok_build/skill/` 모듈을 가리키는 죽은 주석 | 코드 주석 |
| 14 | README "manages long-running tasks" — 실제는 TUI 종료 시 전멸(leader 모드 제외) | 문서 과장 |

### 12-B. 🔴 본 조사 중 발생한 1차 보고 오류 (방법론 교훈)

| 오류 | 정정 | 교훈 |
|---|---|---|
| "`sed`/`find`/`awk`가 manager 안전목록에 있다" | **없다** | 목록 주장은 원본 배열을 직접 인용해야 |
| "종료 코드는 0/1/2뿐" vs "130/143/129" | **둘 다 반쪽.** 합집합이 정답 | 각 에이전트가 자기가 본 파일 안에서만 "전수"라 보고 |
| "만들어놓고 안 켠 게 많다"(라인 수 기준 0.32%로 반박) | 라인 수로는 평범하나 **기능 수로는 유의미** | 같은 현상도 **측정 단위**에 따라 결론이 뒤집힘 |
| `StopReason::MaxTokens` 미배선 주장 | 외부 crate enum이라 exhaustive match 필수 | 서드파티 타입을 자사 미배선으로 오인 |
| "TUI가 ACP 클라이언트라 에디터가 받는 게 동일" | **방향 비대칭** — 역방향 핸들러는 2개뿐 | 대칭 가정 금지 |

### 12-C. 미확인 (본 문서 범위 밖)

1. **2바퀴(누락 메우기) / 3바퀴(적대 검증)** 미실시 — 사용자 지시는 3바퀴였으나 현재 1바퀴 완료
2. 축 경계에 낀 crate: `xai-grok-voice`(음성 STT), `xai-grok-update`(자동 업데이터·버전 정책), `xai-grok-announcements`, `xai-codebase-graph`(정적 코드 인덱스 — `x.ai/code/*`의 백엔드), `xai-grok-secrets`(시크릿 스크러빙), 마켓플레이스 crate 내부
3. **실행 검증 0** — 본 문서는 **정적 판독**만. 빌드·실행·동작 확인 안 함
4. 런타임 축이 확보되며 §2가 채워졌으나, 그 축도 단독 1회 조사다. 특히 다음은 교차검증 없음:
   - goal 9컴포넌트의 **개별** 로직(evaluator 판정 기준, skeptic 패널 구성)
   - 샘플러 재시도/failover 정책 상세
   - 메모리 시스템(`/dream` 통합, watcher, 임베딩)
   - 워크플로 Rhai 호스트 API 표면

---

## 13. 흡수 판정

### 13-A. 흡수 1순위

| # | 항목 | 근거 | 왜 |
|---|---|---|---|
| 1 | **`PhaseKey` 2중 시계** | `acp/tracker.rs:270-306` | ~50줄. "타이머가 자꾸 리셋돼 얼마 걸렸는지 모름" 직격. exhaustive match로 드리프트 방지 |
| 2 | **hashline 앵커 편집** | `grok_build_hashline/edit/apply.rs` | stale-read를 **재읽기 강제**가 아니라 **정정 앵커 즉시 반환**으로 해결. 우리 bench에서 stale guard가 자기 편집에 spurious 발동했던 문제와 같은 지점 |
| 3 | **action-stationarity 정지** | `turn.rs:3024-3090` | 임의 턴수 대신 **진전 없음을 직접 측정**. `no-heuristics-only-validated` 원칙과 정합 |
| 4 | **폴더 신뢰 게이트** | `xgw/folder_trust.rs` | 남의 repo에서 에이전트 돌릴 때 필수. 11종을 한 번에 게이팅, 헤드리스 fail-closed |
| 5 | **설정 오버레이 허용목록 + 보안게이트 분리 읽기** | `config_layers.rs:37-69` | env로 설정 주입하되 **권한 상승 불가**. CI/벤치 하네스에 그대로 적용 가능 |

### 13-B. 흡수 후보 (2순위)

- **`WaitingReason` + `waits: bool`** — 누구를 기다리는지 + 중단 가능 여부
- **idle watcher cue** — 완료 마커 뒤에도 남는 개수 표시
- **조기 하차 탐지** — 모델의 하차 화법 앵커 정규식 + 라벨 발행(감사 가능)
- **실패 안전 기본값** — 해석 불가 상태는 `Active`가 아니라 `Paused`로
- **stop reason `Unknown(String)`** — 미지값 흡수로 스트림 폐기 방지
- **플랜 모드 3종 세트** — 디스크 `plan.md` / 하드 거부 편집 게이트 / 승인 대기의 종료 견딤
- **TodoGate + `cancelled` 상태 + merge 기본**
- **MCP `search_tool`/`use_tool` 간접화** — 서버 늘어도 툴 목록·KV 캐시 불변
- **MCP 이름 검증 = 3사 규칙 교집합**, 중복은 하드 에러, 타임아웃 시 재시도 안 함
- **훅 자기설치 커널 차단** — 모델이 자기 훅 심어 게이트 우회 방지
- **tree-sitter 명령 분류 + 단어경계 + fail-closed unparseable**(단 §13-C 주의)
- **exec vehicle 목록 / kubectl 위험 플래그 16 / 간접 실행 경로 봉인 목록** — 우리 체크리스트 원재료
- **단어 단위 승인 스코프 UX**
- **포그라운드 15초 → 백그라운드 승격**
- **서브에이전트 `resume_from`** — 끝난 형제의 트랜스크립트 이어받기
- **이미지 예산 히스테리시스** — KV prefix 캐시 보호 목적 명시
- **찢어진 tail 치유**(§2-3) — append 전 마지막 바이트가 `\n`이 아니면 개행 삽입해 손상을 한 줄로 가둠. "이전엔 없어서 resume이 벽돌됐다"는 실전 흔적
- **append 실패를 커밋 상태로 타입 분류**(§2-3) — `NotCommitted` / `Committed` / `AcknowledgementLost`로 **재시도 안전 여부를 타입이 표현**
- **AGENTS.md 인젝션 방어**(§2-13) — `<system-reminder>` 위조를 경로·내용 양쪽에서 이스케이프. 우리도 repo 파일을 프롬프트에 넣으므로 직결
- **타이틀 3방향 경합 해소**(§2-8) — 락 안에서 수동핀 > 재생성 > if-absent 명시 우선순위
- **검색 인덱스 스키마 버전 래칫**(§2-7) — 저장 버전이 더 최신이면 drop 안 함(stable/alpha 핑퐁 wipe 방지)
- **외부 OTel 3중 방어**(§2-16) — closed enum + pin 테스트 + export-time validator, 콘텐츠는 additive opt-in만
- **fail-closed 텔레메트리 게이트**(§2-16) — 정책 도달 불가를 `RemoteFetchDisabled`/`ProxyRepointed`로 분류해 **불가할 때만** 열어줌
- **터미널 복구 시그널 핸들러**(§2-12) — 크래시 리포터가 꺼져도 항상 설치, termios 복구 후 **default disposition으로 re-raise해 코어 덤프 보존**

### 13-C. 반면교사 (하지 말 것)

| # | 사례 | 교훈 |
|---|---|---|
| 1 | **멈춤사유 마지막 1미터** — 내부 어휘 5벌인데 화면 5문구, 4레일이 미인식 값을 "성공"으로 흘림 | 멈춤 사유는 **산출→화면을 하나의 exhaustive 매핑**으로 묶고 drift-guard 필수. 우리에겐 이미 `Record<Union,Verdict>` 패턴이 있음 |
| 2 | **제자리걸음이 "Worked for Xs"** | 실패를 성공처럼 보이게 하는 기본값은 최악. 필요한 문구(`TurnHalted`)를 써놓고 배선을 안 함 |
| 3 | **인용 연결 파싱 차이 우회** | 파서를 쓰는 것만으론 부족 — **판정에 쓰는 모든 경로가 같은 정규화를 거쳐야**. 한 경로만 디코딩하면 그 틈이 우회로 |
| 4 | **위험 플래그 목록 방식의 한계** | `rg --pre`는 막고 `--hostname-bin`은 놓침. 도구가 새 실행 플래그를 추가하면 즉시 낡음 → **실행 수단 차단**이 구조적으로 우선. 그마저도 npm/pip/make 누락 |
| 5 | **훅 fail-open** | 트레이드오프 선언은 정직하나, 보안 훅으로 쓰면 타임아웃 한 번에 조용히 뚫림 |
| 6 | **macOS 네트워크 no-op** | 프로필 이름이 `read-only`/`strict`인데 실제로 안 막히는 건 광고와 실제의 괴리 |
| 7 | **skill `allowed-tools` 미강제** | 파싱·저장·와이어 전송까지 하고 강제는 0. 사용자는 제한된다고 믿음 |
| 8 | **문서/주석이 코드보다 앞서 감** | 14건 불일치. 특히 소스 주석이 거짓인 경우(§10-3) |
| 9 | **토큰 회계 전체가 bytes/4**(§2-1) | auto-compact 85%, 프루닝 50%가 전부 근사 위에 섬. 우리도 같은 함정 — 게이트 임계를 정하기 전에 **무엇으로 재는지** 먼저 정할 것 |
| 10 | **fsync 없는 durability 기본값**(§2-3) | 세션 로그가 `flush`까지만. 크래시 시 마지막 구간 소실 가능. 되돌리기·재개를 로그에 의존하면서 durable 경로를 스케줄러 tombstone에만 쓴 건 불균형 |
| 11 | **3액터 전부 unbounded FIFO**(§2-0) | 순서는 보장되나 백프레셔가 없음. 샘플러에 **총 요청 타임아웃도 없음**(idle 300s만) |
| 12 | **`_GROK_CLAUDE_MARKER_OVERRIDE`가 프로덕션에서 읽힘**(§11-2c) | 테스트 escape hatch로 문서화됐으나 `#[cfg(test)]` 가드 없음. 우리 테스트 훅도 같은 검사 필요 |

### 13-D. 전략적 관찰 (INFERENCE 포함)

- **경쟁 제품 흡수 전략이 일관됨**: Claude Code `.claude/settings.json`·`~/.claude.json`, Cursor `~/.cursor/mcp.json`, 표준 `.mcp.json` 읽기 / 훅 이름 alias(Claude + Cursor 양쪽) / 권한 규칙 `mcp__*` 문법 번역 / 스킬 디렉터리 `.claude`·`.cursor` 스캔 / 헤드리스 Anthropic Messages 와이어 클론 / **세션 임포터**(Claude·Codex 동작, Cursor 스텁). **이주 마찰을 0으로 만드는 데 상당한 코드를 씀.**
- **툴 이름 랜덤화**(§3-6)는 이 코퍼스에서 처음 보는 기법. INFERENCE: 타 에이전트 학습 prior 차단 또는 오염 탐지.
- **eval 하네스만 비공개**(§0-2)라는 게 의미심장. 프롬프트·툴·권한·프로토콜을 전부 열고 **품질 측정 레일만 닫았다.**
- ACP를 자체 규격으로 만들지 않고 **Zed 표준 위에 확장**을 얹은 선택. 표준 코어는 얇고 실질은 `x.ai/*` 223개에 있음.

---

## 부록 A. 재현 방법

```bash
# 클론 (얕게)
cd ~/Documents/code-new/competitor-scaffolds
git clone https://github.com/xai-org/grok-build.git

# 규모
find . -name '*.rs' -not -path './.git/*' | wc -l          # 2765
find . -name '*.rs' -not -path './.git/*' -exec cat {} + | wc -l   # 1,657,018

# 시스템 프롬프트 원문
cat crates/codegen/xai-grok-agent/templates/prompt.md              # 6,992 B
cat crates/codegen/xai-grok-agent/templates/apply_patch_prompt.md  # 21,360 B
cat crates/codegen/xai-grok-agent/templates/subagent_prompt.md     # 5,502 B

# 툴 레지스트리 (50개)
sed -n '677,767p' crates/codegen/xai-grok-tools/src/registry/types.rs

# 프리셋
sed -n '176,561p' crates/codegen/xai-grok-agent/src/config.rs

# 멈춤사유 매핑 (반면교사)
sed -n '1281,1324p' crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs
sed -n '32,40p'     crates/codegen/xai-grok-pager/src/app/turn_completion.rs
sed -n '169,198p'   crates/codegen/xai-grok-pager/src/scrollback/blocks/session_event.rs

# 종료 코드 (양쪽 다 봐야 함)
grep -rn --include='*.rs' 'process::exit(' crates/ | grep -v '/tests/'
sed -n '125,155p' crates/codegen/xai-grok-pager/src/app/signal_handler.rs

# 프롬프트 난독화가 평문과 동일한지 (검증 완료)
cat crates/codegen/xai-grok-agent/scripts/encrypt_templates.py
# xor_encrypt(data, seed) = b ^ ((seed + i) & 0xFF), seeds 0x5A / 0x7B / 0x3D
```

## 부록 B. 관련 문서

- 같은 위계: [`claude.md`](./claude.md), [`codex.md`](./codex.md), [`cursor.md`](./cursor.md), [`quanta-comparison.md`](./quanta-comparison.md)
- repomap: [`../code-agent-suit/`](../code-agent-suit/)
- 메모리: `agent-loop-4way-comparison`, `implementation-baseline-from-competitors`, `tool-surface-ssot`, `agent-state-observability-northstar`, `exhaustive-record-classification-drift-guard`
