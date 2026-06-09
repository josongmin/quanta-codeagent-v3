# E2E 테스트 카탈로그 (2026-06-10)

전수 조사 대상: `tests/**/*e2e*.test.ts` 195개 파일.
위치 표기: `i/` = tests/integration, `u/` = tests/unit (하위 디렉토리는 그대로 표기).

명명 규칙:
- `-hell-` = 적대적/폭격 시나리오(매트릭스 전수, 대량 반복, 기형 입력)
- `-hellgate` = built-but-not-wired 방지용 실배선 증명
- `-real-` / `-live-` = 실 외부 프로세스 사용(Chrome, debugpy, rust-analyzer, tmux 등)

## 1. 에이전트 루프 · 복구 · 컴팩션 (23)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| agent-recovery-e2e | i/ | src/agent recovery | PTL·transient·output-limit·malformed·empty 응답 각각에서 복구 수행 | 복구 FSM 정확성 보장 |
| abort-mid-recovery-hell-e2e | i/ | src/agent recovery | backoff-sleep·HOL-barrier·verify강제턴 도중 AbortSignal 발화 | 복구 기계 내부에서도 안전한 중단 보장 |
| breaker-e2e | i/ | src/agent compaction-breaker | 반복 PTL→no-progress strike 누적→루프 차단 | 컴팩션 스래싱 브레이커 작동 검증 |
| breaker-x-recovery-hell-e2e | i/ | recovery+breaker | PTL+nudge+backoff 스택 속에서도 strike 카운트 유지 | recovery가 breaker를 마스킹하지 않음 보장 |
| recovery-composition-hell-e2e | i/ | agent/recovery+loop | 여러 복구 유형 체인·예산 독립·도구턴 전환 조합 | 복구 유형 합성 시 예산 고립성 검증 |
| compaction-emit-e2e | i/ | src/agent compaction | 긴 세션에서 proactive/reactive/microcompact 이벤트 발행 | post_compact 이벤트 배선 검증 |
| microcompaction-tier-e2e | i/ | microcompaction | tier-1 오래된 도구 덤프 제거, 추론 텍스트는 보존 | 마이크로컴팩션 시 reasoning 보존 보장 |
| drop-oldest-salvage-e2e | i/ | src/agent compaction | suffix가 너무 커서 PTL이면 salvage shed 수행 | drop-oldest 복구 경로 검증 |
| reactive-failfast-e2e | i/ | agent/compaction | 리액티브 드롭 비율 초과→루프 에러 종료 | 컴팩션 드롭 비율 방어선 검증 |
| loop-d4-d5-baseline-e2e | i/ | compaction baseline | turn1 거대 usage→turn2 압축 강제, baseline 무효화 | 멀티턴 압축 임계값 동적 파생 검증 |
| agent-refusal-e2e | i/ | src/agent decision | refusal stop_reason 수신 시 처리·종료 | 거부 응답 계약 검증 |
| fallback-tombstone-e2e | i/ | FallbackLLM+streamingTurn | 주 LLM 부분 실패→폴백 전환 후 stream_reset 처리 | 죽은 partial 폐기(tombstone) 검증 |
| fallback-x-verify-closeout-hell-e2e | i/ | FallbackLLM+verify-guard | 폴백 복구 후 verify-gate 강제·closeout | 폴백+검증게이트 조합 동작 보장 |
| verify-guard-e2e | i/ | agent/verify-guard | edit 후 미검증 완료 시도→EXTRA 강제턴 삽입, test 통과 후 종료 | 검증 강제·maxTrips 상한·기본OFF 바이트동등 |
| verify-guard-hellgate-e2e | i/ | agent/verify-guard | git status는 검증 불인정, pytest는 인정 | "echo는 검증 아님" 거짓양성 방지 |
| task-budget-loop-e2e | i/ | agent budget | soft task-budget이 턴마다 감소 표시, 정상 완료 | 예산 누적·감소·기본OFF 바이트동등 |
| objective-budget-enforce-e2e-hellgate | u/ | agent objective budget | 목표 예산 소진 시 idle continuation 억제 | 반응형 압축 후 continuation 재발행 게이팅 |
| thread-goals-enforce-e2e-hellgate | u/ | agent/objective | 작은 budget 초과→continuation 차단, cap 상향 시 재개 | H17 토큰 예산 강제 검증 |
| typed-failures-e2e | i/ | agent/dispatch | bash timeout·missing path·permission 거절→typed ToolFailure | 타입화된 실패 round-trip 검증 |
| tool-spill-e2e | i/ | agent/dispatch | 40KB 도구 출력→500B로 캡, spill 파일 저장 | 결과 크기 cap·spill 경로 추적 |
| context-change-injection-e2e | i/ | agent context-change | cwd/mode/skill 플립 감지→저장→buildTurnContext 주입 | context-change 파이프라인 검증 |
| reminder-injection-through-loop-hell-e2e | i/ | agent/prompt-escape | 메모리/규칙/상태에 위조 system-reminder 경계 삽입 시도 | 리마인더 경계 위조(주입) 방어 |
| nicknames-hell-e2e | i/ | subagent/nicknames | 39개 별칭 완전성·결정론·균일분포·순차분배 | 에이전트 별칭 부여 계약 검증 |

## 2. 권한 · 모드 · 보안 게이트 (22)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| permission-mode-adversarial-e2e | i/ | permission+admissibility-gate | 우회 권한·전략 도구·모드 전환으로 경계 공격 | 모드 전환에도 하드 보안 경계 유지 |
| permission-mode-live-proxy-e2e | i/ | permission/mode-proxy | 실시간 모드 전환→다음 턴에 즉시 반영 | 라이브 프록시 권한 게이트 검증 |
| mode-cycle-permission-live-e2e | i/ | runner/assemble+web-daemon | 미드세션 permissionModeState.set()→다음 턴 게이트 결정 변경 | ADR-0303 엔진 소유 권한이 턴마다 live로 읽힘 |
| permission-set-web-daemon-e2e | i/ | web-daemon runtime-factory | 세션 동사로 호스트 모드 변경→다음 턴 허용 | 웹데몬 권한 스위치 풀스택 검증 |
| permission-stack-gate-e2e | i/ | permission/stack | 스택 활성화→스레드수준 거부·우선순위 역전 | 다층 권한 정책 스택 검증 |
| mode-block-e2e | i/ | agentMode+admissibility-gate | plan/review/audit 모드에서 write 차단, default 허용 | 모드 기반 도구 차단 보안 경계 |
| mode-block-matrix-e2e | i/ | agentMode gate+mode notice | 4모드×4뮤테이팅도구 매트릭스+per-turn 모드 공지 주입 | 도구명 커버리지 완전성+공지/게이트 쌍 검증 |
| plan-mode-dispatch-hell-e2e | i/ | agent/mode+dispatch-seam | 모드 전환·병렬 100 디스패치 폭격 | 플랜모드 상태기계·드리프트 방어 |
| hard-deny-mid-multitool-hell-e2e | i/ | HARD_DENY+multi-tool | [read, bash(rm -rf), read] 멀티콜 중간 거부 | 거부 시 순서 보존·안전 호출 존속 |
| hand-off-required-universal-e2e | i/ | permission/hitl-tier | hand-off-required 도구가 HITL 비활성 환경에서도 거부 | 모드 무관 UNIVERSAL 강제 거부 |
| hitl-tier-dispatch-e2e | i/ | HITL-tier dispatch | escalation 오버라이드·HARD_DENY·onHandoff 발화 | HITL 티어 레지스트리·단방향 래칫 |
| auto-classifier-e2e | i/ | permission auto-mode | 2단계 분류기로 write 도구 게이팅 | auto-mode 분류 경로 검증 |
| auto-mode-rule-overlay-circumvention-e2e-hellgate | u/ | admissibility-gate | 규칙 오버레이 적용+도구 전환 회피 감지 풀체인 | 사용자 규칙 도달·우회 감지 실증 |
| rules-argv-array-e2e-hellgate | i/ | rules/matcher | argv 토큰-prefix 규칙 vs 바이트-prefix 비교 | argv 배열 규칙 게이트 정확성 |
| trust-scope-e2e | i/ | permission trust-scope | once_only 승인→첫 호출 skip, 둘째 재확인 | 승인 소비(1회성) 검증 |
| trust-scope-persistent-e2e | i/ | permission trust-scope | 파일 기반 TrustScopeRegistry 프로세스 경계 생존 | 영구 승인 저장·재수화 검증 |
| guardian-per-action-assessor-e2e-hellgate | u/ | permission/reviewer-port | 모델 회신→어댑터→결정 매트릭스 통과 | 가디언 per-action 평가자 실경로 봉인 |
| deny-reason-wire-e2e-hellgate | u/ | permission/deny-reason | 모든 거부 경로의 구조화된 이유가 dispatchTool로 표면화 | 거부 이유 전체 경로 커버리지 |
| ownership-dispatch-e2e-hellgate | u/ | agent/ownership-policy | FS 소유 경계 밖 쓰기 hard-deny | 소유권 게이트·기본OFF 검증 |
| fs-jail-e2e | i/ | fs-jail | ../ 경로 이탈·symlink 탈출 시도 거부, 옵트아웃 동작 | 파일시스템 경계 다중 탈출벡터 봉인 |
| wave2-reachability-e2e-hellgate | u/ | dispatch 보안 wiring | permission_hook deny→도구 거부; interrupt block→criticalSection | 보안 knob들이 실 dispatch 경로에 닿음 |
| source-tag-injection-defense-e2e-hellgate | u/ | agent/untrusted-envelope | 악성 fetched body를 untrusted-source 봉투로 래핑 | H2 source-tag 주입 방어 |

## 3. 네트워크 · 이그레스 보안 (6)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| network-proxy-e2e | i/ | runtime/network-proxy | 실 소켓으로 allow/deny/amend/SSRF+결정로그 | 이그레스 프록시 소켓 레이어 봉인 |
| network-proxy-subprocess-e2e | i/ | network-proxy+runShell | 실 자식 프로세스가 HTTP_PROXY 강제 경유, off-list 차단 | 서브프로세스 우회 갭 폐쇄 증명 |
| network-proxy-bash-tool-e2e | i/ | network-proxy+bashTool | ToolContext.proxyEnv→bash 도구→자식 소켓 게이팅 | 실 bash 도구 dispatch 경로 배선(BUG1) 증명 |
| header-rewrite-proxy-e2e | i/ | LoopbackEgressProxy | 헤더 strip/set/append+FORBIDDEN_INJECT 방어 | 프록시 헤더 조작·비밀 유출 방어 |
| secret-egress-proxy-e2e | i/ | network-proxy+secret-detection | plaintext 바디/헤더 시크릿 스캔→deny/redact | 비밀 외부 유출 방어 e2e |
| tls-mitm-egress-e2e | i/ | network-proxy MITM | HTTPS 바디를 TLS 종료 후 시크릿 스캔 | HTTPS 갭 폐쇄·upstream cert 검증·DoS 방어 |

## 4. 도구 — 파일 · git · 문서 · 브라우저 · 디버그 (31)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| edit-line-ranges-e2e-hellgate | u/ | tool/edit | line_ranges로 반복 코드 중 정확히 1곳만 수정 | 범위 기반 편집 디스크 수준 정확성 |
| edit-write-atomic-default-e2e.hellgate | u/ | tool/edit+write | temp→rename 원자 커밋, inode 변경·모드 보존 | 원자 쓰기 POSIX rename 메커니즘 검증 |
| edit-reactor-e2e-hellgate | u/ | agent/edit-repair | 린트 루프가 수렴하거나 maxIters에서 중지 | 편집 복구 리액터 수렴·바운드 |
| fast-apply-merge-e2e-hellgate | u/ | agent/fast-apply-fallback | 불가능한 편집이 모델 merge 러너로 착지·커밋 | fast-apply 폴백 실경로 봉인 |
| applier-scored-tier-e2e.hellgate | u/patch/ | tool/apply-patch | 점수 기반 tie-break로 모호한 패치 해결 | decisive 승리·fail-closed 보호 |
| read-file-unchanged-dedup-e2e-hellgate | u/ | tool/read stale-guard | mtime 추적으로 동일 재읽기 dedup | 연속 동일 읽기 short-circuit·기본OFF |
| git-tools-e2e | i/ | git_commit/branch_switch | wip 커밋·정규 커밋·dirty 상태 브랜치 전환 | git 도구 실사용 패턴 검증 |
| git-review-diff-e2e | i/ | git_review_diff | 실 repo diff 생성→리뷰어 호출→보고서 반환 | 리뷰 경로 git+LLM 복합 e2e |
| git-compose-e2e.hellgate | u/tool/ | tool/git compose | git_compose_commit 메시지 저작→git_commit 실커밋 | diff→prose 저작·env flip 레지스트리 |
| worktree-dispatch-e2e | u/tool/worktree/ | agent/worktree | enter_worktree→bash in worktree→exit→cwd 복원 | worktree dispatch seam·manifest 드리프트 가드 |
| browser-agent-loop-e2e | i/ | src/browser tools | navigate→snapshot→click→text 루프 디스패치 | 브라우저 도구 루프 통합 |
| browser-tool-loop-e2e | i/ | browser tool registry | ToolRegistry 직접 구동(루프가 쓰는 도구 경로)으로 브라우저 도구+HITL confirm | 브라우저 도구 권한 게이트 |
| browser-edge-injection-e2e | i/ | browser+registry | forged 경계 토큰·SSRF·CDP allowlist 공격 | 브라우저 도구 보안 게이트 |
| browser-real-chrome-e2e | i/ | browser cdp-adapter | 실 Chrome으로 navigate→fill→select→click | CDP 어댑터 실브라우저 검증 |
| browser-real-chrome-adversarial-e2e | i/ | browser cdp-adapter | 실 Chrome adversarial 페이지 | forged boundary defang 검증 |
| debug-inspect-tool-e2e-hellgate | u/tool/debug/ | tool/debug (DAP) | fake DAP 어댑터로 breakpoint 정지→stack+locals 렌더 | W5 debug_inspect DAP 핸드셰이크 풀스택 |
| debugpy-real-e2e | u/tool/debug/ | tool/debug (debugpy) | 실 python3 debugpy.adapter 스폰·다중 프로그램 디버그 | 실 debugpy launcher·codec 검증 |
| lsp-diagnostics-e2e | i/ | DiagnosticsProvider | 실 provider 진단 결과·nullProvider 우아한 폐기 | LSP 진단 도구 통합 |
| rust-analyzer-real-e2e | u/lsp/ | lsp/rust-analyzer | 실 rust-analyzer LSP 스핀→정의·hover 해석 | Rust 언어 어댑터(OCP) 실 LSP 증명 |
| office-authoring-e2e-hellgate | u/ | tool/document write | xlsx/docx 쓰기 후 재파싱 round-trip | knob 등록·진짜 포맷 유효성 |
| xlsx-docx-read-roundtrip-e2e-hellgate | u/ | tool/document read | 실 .xlsx/.docx 쓰기→read 도구 재읽기 | H14b reader true round-trip |
| pptx-roundtrip-e2e-hellgate | u/ | tool/document pptx | pptx_write→pptx_read round-trip | 제목·본문 텍스트 보존·게이트 검증 |
| image-gen-e2e-hellgate | u/ | tool/image-gen | key 바운드 port가 canned fetch로 PNG 디스크 기록 | image_gen 등록·쓰기 경로 증명 |
| pty-attach-e2e-hellgate | u/ | tool/pty (tmux) | attach→write→read 사이클+HARD_DENY | 외부 세션 jail·no-throw 경계 |
| pty-attach-cross-tool-e2e-hellgate | u/ | pty+dispatch | 실 composition root 통한 PTY 도구 | knob 등록·plan모드/flag-injection 가드 |
| longtail-new-tools-e2e | i/ | git_co_change 등 신도구 | 실 repo 공변행렬·gh 도구·store 영속성 | 롱테일 신도구 레지스트리·환경 게이트 |
| code-mode-full-surface-e2e | i/ | src/codemode | read→grep→write 3-도구 데이터플로우 체인 | code-mode 풀 표면 작동 |
| code-mode-memory-fault-e2e | i/ | codemode tool | bulk/incremental OOM 후 code_cell_memory 동작 | OOM 분류 end-to-end |
| docker-sandbox-e2e | i/ | runtime DockerSandbox | stub docker로 argv/timeout/cap 계약 | 샌드박스 spawn 파이프라인 계약 |
| docker-sandbox-runagent-e2e | i/ | sandbox+agent | docker 불가→tool result ok:false 매핑 | 샌드박스 도구 dispatch round-trip |
| communicate-update-e2e-hellgate | u/ | tool/communicate_update | 진행률 업데이트→호스트 어댑터→AgentEvent | 구조화 진행 채널 도구→스트림 브릿지 |

## 5. 서브에이전트 · 멀티에이전트 협업 (22)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| subagent-6tool-hell-e2e | i/ | subagent 6도구 | spawn/wait/close/exec/write_stdin/send_input 스키마 폭격 | 6도구 스키마 정합성·판별식 유지 |
| subagent-spawn-flow-cross-hell-e2e | i/ | subagent+session | 100회 spawn·역할 정책·별명·오류 격리 | 스폰 플로우 결정론·오류 격리 |
| subagent-cancellation-e2e | i/ | subagent+agent | background 자식 spawn 후 task_stop→abort 전파 | 취소 전파·AbortController 체인·리소스 정리 |
| subagent-checkpoint-e2e | i/ | subagent/runner | checkpoint:true→자식 seed에 Checkpoint 블록 주입 | 체크포인트 주입·isolation 호환 |
| subagent-continue-from-e2e | i/ | subagent/runner | continue_from으로 이전 시도를 seed에 주입 | 웜스타트 체인·미지 ID 거절 |
| subagent-fork-e2e | i/ | agent+subagent | 실 runAgent 재귀 포크, maxDepth(2→4 거절) | 재귀 깊이 경계·방어 케이스 |
| subagent-seed-augmentation-e2e | i/ | subagent/runner | result_shape·owned_surfaces seed 주입 | 시드 증강 형식·자식 수신 확인 |
| subagent-cleanup-e2e | i/ | agent/features | buildSessionFeatures cleanup()·background 태스크 정리 | cleanup 계약·idempotency |
| subagent-cleanup-invocation-e2e | i/ | agent/loop | runAgent 완료 경로에서 features.cleanup 호출 | cleanup 호출 시기·done 순서·기본OFF |
| agent-role-x-tool-policy-hell-e2e | i/ | subagent/role | 3역할×7도구 21셀 매트릭스 | 역할별 도구 정책 완전성 |
| named-agent-mode-clamp-file-e2e-hellgate | u/subagent/ | subagent-runner | .quanta/agents/*.md mode가 parent보다 느슨하면 clamp | 파일 정의 공격 표면 mode clamp |
| named-agent-mode-clamp-fold-e2e-hellgate | u/subagent/ | subagent-runner | resolver fold 경로에서 가장 제한적 mode로 clamp | fold 경로 clamp 검증 |
| team-broker-e2e-hellgate | u/coordination/ | coordination-broker | 워커 escalation→리더 승인→워커 적용 왕복 | 리더 기반 HITL 중개 실배선 |
| team-dag-batch-e2e-hellgate | u/coordination/ | coordination/dag | 선형·다이아몬드 그래프 의존성 순서·실패 차단 | DAG 게이트 순서·dead branch 차단 |
| team-dag-spawn-batch-live-e2e-hellgate | u/coordination/ | subagent-batch+dag | spawn_batch 실 dispatch deps-first·순환 거부 | DAG가 실 spawn_batch를 구동함 증명 |
| team-idle-barrier-e2e-hellgate | u/coordination/ | coordination/idle-barrier | 3멤버 비콘으로 teamIdle 전환 | 팀 유휴 장벽 상태기계 |
| team-idle-side-agent-live-e2e-hellgate | u/coordination/ | side-agent+idle-barrier | pass 라이프사이클 비콘/재활성과 teamIdle 일관성 | 실 사이드에이전트가 장벽 구동 증명 |
| side-agent-block-e2e-hellgate | u/ | tier1 side-agent | buildSideAgentBlock에 registry 연결→4도구 등록 | N1 사이드에이전트 포트 구조 검증 |
| side-agent-process-llm-charter-e2e | i/ | side-agent worker-charter | 실 모델 replay→자식 프로세스·IPC 결과 | OS 프로세스 사이드에이전트 LLM 차터 |
| side-agent-process-os-fork-e2e | i/ | side-agent daemon | 실 fork·IPC 경계·크래시 재시작 | OS fork 자식 프로세스 감독 |
| side-conversation-e2e | i/ | agent/side-conversation | 병렬 질의·사용자 응답·중단 전파 | 사이드 대화 라우터 통합 |
| external-agent-import-hell-e2e | i/ | migration importer | Claude Code 4단계 import+envelope→retention | 외부 에이전트 import 라이프사이클 |

## 6. 세션 · 재개 · 영속성 · 메모리 (17)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| resume-e2e | i/ | session load-save | 저장→로드→추가 메시지→재실행 | 세션 재개 트랜스크립트 경계 |
| cli-resume-e2e | i/ | agent state | save→load→resume 멀티턴 | 기록 보존 재개 계약 |
| session-envelope-hell-e2e | i/ | session/envelope | 5타입·17필드·10k 동시쓰기·스냅샷 독립성 | 세션 JSONL 봉투 포맷 봉인 |
| session-rewind-e2e | i/ | session/rewind | 메시지 id로 리와인드→로드, 봉투 불변 | 메시지 단위 리와인드 통합 |
| session-rewind-reconcile-e2e-hellgate | u/ | session rewind/fork | tool_use↔result 쌍 절단 시 placeholder 보정 | 리와인드 후 model-valid 파일 유지 |
| session-ux-e2e | i/ | session commands | ls/show/rename/archive/fork/delete·git worktree | 세션 명령·라이프사이클 UX |
| sqlite-session-registry-e2e | i/ | session-registry sqlite | 다중 프로세스 영속·WAL·GC·충돌 복구 | SQLite 레지스트리 멀티프로세스 불변성 |
| session-transcript-retention-e2e-hellgate | u/ | session registry cleanup | MAX_BYTES 설정 시 transcript 정리 CLI | retention cleanup 핸들러 실동작 |
| jsonl-retention-hell-e2e | i/ | JsonlRecorder | 10k×10KB→1MB 상한·SIGKILL·동시 접근 | JSONL 슬라이딩 윈도우 원자성 |
| migration-import-persistence-e2e-hellgate | u/ | migration+session | 세션 영속·중복 제거·자격증명 읽기 금지·기형 건너뜀·부재 처리 | ADR-0430 경쟁사 import 영속성 7-hell 검증 |
| config-migration-persist-e2e-hellgate | u/ | migration/external-config | 실 .claude/ 트리 감지→변환→영속→재로드 | 마이그레이션 풀 플로우 |
| external-config-migration-e2e-hellgate | u/ | migration/external-config | detect→convert→persist로 실 quanta 파일 생성 | 외부 설정 마이그레이션 전체 흐름 |
| agent-memory-e2e | i/ | src/memory 장기기억 | 2세션에 걸쳐 distill→persist→embed→recall | 메모리 배선 검증 |
| memory-default-on-e2e-hellgate | i/ | memory-factory | InMemory/Sqlite 영속·recall tail 삽입·off 바이트동등 | 메모리 기본ON·저장소 통합 |
| memory-routing-meta-e2e-hellgate | i/ | memory-routing | 라우팅 메타 영속·cwd-scoped 가중·마이그레이션 | 메모리 라우팅 메타 저장소 진화 |
| auto-dream-e2e-hellgate | u/ | memory/dream | 세션 종료 3회 임계 교차→runPhase2 실행 | 크로스세션 auto-dream 상태기계·잠금 |
| dream-trigger-wire-e2e-hellgate | u/ | memory/dream+runner | 실 호스트 구성이 CrossSessionDreamTrigger 조립 | 호스트 바인딩 dream 트리거 봉인 |

## 7. 플랜 · 큐 · 사용자 상호작용 · 멘션 (11)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| plan-queue-mid-turn-e2e | i/ | plan-queue+follow-up | 턴 중 캡처→다음 턴 주입·SendNow | 플랜큐·팔로업큐 실시간 통합 |
| queued-follow-ups-hell-e2e | i/ | follow-up-queue | 10이유×3스레드·100항목 FIFO·스냅샷 | 팔로업큐 다층 정책 폭격 |
| request-plan-exit-lifecycle-e2e | i/ | tool/request-plan-exit | 승인/거절/변경요청→모드 전환·플랜 관리 | 플랜 종료 요청 라이프사이클 |
| request-user-input-e2e | i/ | tool/request-user-input | 포트 배선→사용자 입력 캡처·응답 미러 | 사용자 입력 요청 호스트 포트 통합 |
| web-user-input-port-e2e | i/ | web-daemon user-input-port | request→resolve/cancel·연결 해제 처리 | 웹 입력 포트 계약·양방향 통신 |
| streaming-dispatch-in-progress-e2e | i/ | streaming-dispatch | 스트림 중 response_in_progress 이벤트 처리 | 진행 지표 시퀀스·바이트 동등성 |
| streaming-dispatch-rejection-e2e | i/ | streaming-dispatch | Phase 2/3/4에서 디스패치 거절 발생 처리 | 거절 시 오류 합성·순서 불변성 |
| mention-e2e-hellgate | i/ | mention injector | @file/@symbol/@skill 주입+실 LSP 앵커 합성 | 멘션 와이어 전체 구성(ADR-0423) |
| mention-async-file-e2e | i/ | mention file-resolver | @파일 실제 읽기·용량 절단·symlink 방어 | 멘션 파이프라인 원시 검증 |
| mention-folder-git-e2e-hellgate | i/ | mention resolver | @folder→파일 목록, @git→status 주입 | 폴더/git 멘션 파이프라인 |
| agents-md-scope-e2e | i/ | AGENTS.md scoping | 3층 monorepo 트리 스코핑 렌더링 | AGENTS.md deeper-wins 계약 |

## 8. 스킬 · 플러그인 · 워크플로우 · 훅 (13)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| skill-frontmatter-hell-e2e | i/ | skill 파서 | CRLF/UTF8·15개 기형 케이스 디스크 파싱 | SKILL.md 파서 정확성 |
| skill-scope-e2e | i/ | agent/skill-gate | 스코프 스킬→금지 도구 거부·메타 허용·읽기 네비 | 스킬 도구 스코프 게이트(ADR-0512) |
| skill-implicit-policy-e2e-hellgate | i/ | skill/discovery | allow_implicit 정책→발견·필터 제외·명시 허용 | 스킬 암시 호출 정책 필터 |
| skill-paths-activation-e2e | i/ | skill/activation | 경로 필터로 인벤토리 좁히기·호출 권한 유지 | 스킬 경로 조건 활성화 |
| skills-slash-e2e-hellgate | i/ | skill+slash-commands | 디스크 SKILL.md 발견·병합·/skills·/reload-skills | 스킬 발견 풀경로·충돌 해결·핫리로드 |
| skill-mcp-e2e-hellgate | u/ | skill-mcp-deps | 턴별 skill MCP 의존성 attach→dedupe→detach | ADR-0476 skill→MCP 자동연결 생명주기 |
| plugin-discovery-hell-e2e | i/ | plugin-loader | 20플러그인(깊이4)+기형 5개+junk 필터 | 플러그인 발견 캡·기형 방어 |
| plugin-hooks-apps-pointers-e2e-hellgate | i/ | plugin pointer-resolver | 훅/앱 포인터 로드·경로 이스케이프 필터 | 플러그인 포인터 주입 방어 |
| plugin-x-skill-cross-hell-e2e | i/ | plugin+skill | 플러그인→스킬 발견→파싱→분류 크로스 | 플러그인·스킬 크로스 파이프라인 |
| manifest-codex-compat-e2e-hellgate | u/ | plugin-manifest | 실 codex plugin.json 로드·정규화·스킬 검색 | 매니페스트 호환 정규화 봉인 |
| workflow-e2e-hellgate | u/workflow/ | workflow 엔진 | review→verify→synthesize 3단계+loop-until-dry | 선언적 워크플로우 오케스트레이션 |
| cursor-gap-e2e | u/ | glob-rules+hooks | 글로브 규칙 매칭·pre_tool_use 입력 재작성 | Cursor 흡수 기능의 runAgent 통과 증명 |
| hook-args-rewrite-e2e | i/ | HookBus pre_tool_use | bash 인자 후킹 재작성(deny 우선) | 훅 재작성 파이프라인 dispatch 통합 |

## 9. MCP · 커넥터 (11)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| mcp-e2e | i/ | MCP bridge | 실 MCP 서버 stdio JSON-RPC·악의 서버 | MCP 브릿지 풀스택·프로토콜 내성 |
| protocol-version-e2e-hellgate | u/mcp/ | HttpSseMcpTransport | 실 HTTP 클라이언트 버전 협상·knob 해석 | LATEST/FLOOR 다운그레이드 안전성 |
| mcp-oauth-e2e-hellgate | u/ | mcp/client OAuth | 401 미드세션 재인증·토큰 갱신 | Bearer 부착·자동 재시도 |
| mcp-resources-host-wire-e2e-hellgate | u/ | mcp-bridge resources | 실 MCP 클라이언트 위 자원/프롬프트 도구 등록 | N3 멀티클라이언트 라우팅 |
| mcp-resources-prompts-roots-e2e-hellgate | u/ | mcp/client (McpClient) | 실 McpClient가 fake MCP 서버와 initialize→listResources/readResource/getPrompt 풀 라이프사이클 | H19 typed 메서드가 실 클라이언트 플러밍과 합성됨 증명 |
| mcp-roots-supervised-wire-e2e-hellgate | u/ | cli loadFeatures (roots) | roots 번들이 단일+supervised 클라이언트 모두 도달, knob OFF면 광고 없이 빈 응답 | H19 roots+B1 supervised 실배선·기본OFF 봉인 |
| mcp-sampling-handler-e2e-hellgate | u/ | mcp/client sampling | inbound sampling/createMessage 라우팅→LLM | 동의 거부·에러 포함 전체 흐름 |
| mcp-sampling-live-wire-e2e-hellgate | u/ | cli loadFeatures | 스레드 LLM·대화형 동의 prompter | knob+LLM+동의 조건부 광고 |
| mcp-connector-tools-e2e-hellgate | u/ | connectors 도구 | 커넥터 카탈로그 조회·설치 | 카탈로그 변환·도구 등록 연결 |
| mcp-connector-wire-e2e-hellgate | u/ | mcp-connector-wire | .mcp.json 원자적 병합 쓰기·재설치 | 스키마 검증·설정 충돌 방지 |
| connector-marketplace-lifecycle-e2e-hellgate | i/ | connectors marketplace | install→reload→disable→enable→uninstall | 마켓플레이스 상태기계 |

## 10. LLM 어댑터 · 자격증명 · knob 도달성 (9)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| byok-apikey-e2e-hellgate | u/ | llm/credential | 민트 API 키가 env 무시하고 어댑터 도달·TTL 캐시 | H7-BYOK 키 민팅·캐싱 검증 |
| rotating-credentials-e2e-hellgate | u/ | llm Bedrock/Vertex | stream() 시 refresh 실행·TTL throttle | H7 클라우드 자격증명 사전갱신 |
| h7-transport-e2e-hellgate | u/ | llm/multicloud | QUANTA_LLM_TRANSPORT로 bedrock/vertex 선택 | 멀티클라우드 전송 buildLLM 전 단계 |
| service-tier-factory-e2e-hellgate | u/ | llm factory | QUANTA_SERVICE_TIER env→어댑터 serviceTier | service tier 스레딩 검증 |
| context-1m-factory-e2e-hellgate | u/ | llm/context-1m | [1m] 접미사/knob→1M 베타 헤더 활성화 | 1M 컨텍스트 헤더 실배선 |
| reasoning-carryover-e2e-hellgate | u/ | OpenAI Responses | turn-1 암호화 추론 저장→turn-2 재전송 | H15 추론 carry-over 2턴 교환 |
| reasoning-carryover-live-e2e-hellgate | u/ | openai-responses 어댑터 | 실 어댑터 per-session 추론 저장소 동작 | 실 어댑터 캐리오버 검증 |
| reasoning-summary-verbosity-e2e-hellgate | u/llm/ | llm/responses-stream | reasoning.summary+verbosity가 요청 본문 도달 | knob의 OpenAI 와이어 끝 검증 |
| wave1-reachability-e2e-hellgate | u/ | llm factory knobs | PROMPT_CACHE_TTL·VERTEX_REGION이 실 요청 도달 | 개별 knob→request 추적 |

## 11. 관찰성 · 메트릭 · 디버그 표면 (12)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| spans-e2e | i/ | observability OTel | runAgent 1턴에서 10단계 span 트리 캡처 | span 계약·속성·중첩 순서 |
| agent-metrics-e2e | i/ | observability metrics | 토큰 사용 이벤트→OTel 카운터 | 메트릭 흐름 검증 |
| instrumentation-coverage-e2e | i/ | metrics | LLM+subagent+도구 1턴의 ADR-0158 메트릭 전수 | 계측 완성도 |
| observability-error-event-e2e | i/ | compaction+memory | 컴팩션/메모리 실패→에러 이벤트 발출·복구 | 무음 실패 경로 수정 검증 |
| observability-wire-multi-emit-e2e | i/ | observability-wire | 멀티이벤트 시퀀스→단일 버스→퍼사드 | 관찰성 와이어 실시간 추적 |
| observability-e2e-real-hookbus-hellgate | u/ | hooks+observability | 실 HookBus로 post_tool_use/post_compact 발행 | ledger·compaction 이벤트 구독 |
| decision-counter-e2e-hellgate | i/ | decision-emit | permission/rule/hook/jail/budget 결정 카운터 | decision 카운터 메트릭 |
| decision-emit-wire-e2e-hellgate | i/ | decision-emit-phase3 | emitCapReminder·BudgetExhausted·FsJailSink | Phase 3 emit 배선 계약 |
| decision-tracer-e2e-hellgate | i/ | cli debug-tracer | decision→TeeStream→tracer→stderr 포맷 | 디버그 tracer 격리 |
| debug-cli-surface-e2e-hellgate | i/ | cli slash-commands | /debug /inspect /replay /why 디스패치 | 디버그 CLI 표면 조립 |
| delta-token-loop-wire-e2e-hellgate | u/ | agent/token-delta | knob ON 시 tokenTotal()≡estimateTokens 항상 일치 | 델타 토큰 카운터 무드리프트 배선 |
| repo-map-3tree-e2e-hellgate | i/ | agent/repo-map | 3트리(cwd·git·홈)·실 rg·병렬 캡·렌더 | 레포맵 3트리 스캔 렌더링 |

## 12. 앱 표면 — CLI · 웹데몬 · 헤드리스 · 런모드 · 기타 (18)

| 파일 | 위치 | 관련기능모듈 | 시나리오 | 목적 |
|---|---|---|---|---|
| headless-stream-json-e2e | i/ | headless preset | stream-json/json/text 출력 형식 | 헤드리스 출력 계약·프로토콜 호환 |
| mode-runners-ide-daemon-e2e | i/ | apps/agent mode-presets | runMode(ide/daemon) 풀 조립: 12레버·예산·branch_search·idempotency | ADR-0092 모드 프리셋 L4 배터리 |
| multi-plane-e2e-hellgate | i/ | 5-plane 조립 | 5플레인(오케스트레이션/이펙트/컨텍스트/컨트롤/관찰성)을 단일 AgentConfig로 조립+구조 펜스 | 크로스플레인 누수 없는 합성 증명 |
| agent-state-daemon-e2e-flow-hellgate | u/ | web-daemon agent-state | 9개 AgentEvent를 실 WebSocket으로 인코딩 전송 | 웹데몬 이벤트 매핑·장애 격리 |
| attach-e2e | u/apps/cli/attach/ | cli/attach+web-daemon | CLI가 웹데몬에 attach, 핸드셰이크 후 입출력 | CLI attach 풀 라운드트립 |
| knob-control-plane-e2e-hellgate | i/cli/ | cli knobs | /knobs set·reset이 runtime config에 적용 | 라이브 컨트롤플레인 배선 |
| read-routing-burndown-e2e-hellgate | u/cli/ | cli/knob-overrides | /config set 오버라이드가 readCliKnob로 라이브 반영 | 킬스위치 읽기 세션 내 적용 |
| capability-exposure-e2e-hellgate | u/capability/ | capability/exposure | 표면별 노출 해석·기본OFF 일관성 프로브 | 단일 해석기 split-brain 방지 |
| capability-probe-bootstrap-e2e-hellgate | u/capability/ | capability/probe | 부트스트랩 시 전 기능×표면 쌍 프로브 | 마스터 게이트 계약·레거시 일관성 |
| heartbeat-binder-e2e-hellgate | u/ | scheduler+cli-binder | 하트비트 자동화→스레드 큐에 프롬프트 착지 | 스케줄러→런타임→CLI 바인더 흐름 |
| heartbeat-fire-routing-e2e-hellgate | u/scheduler/ | scheduler/runtime | heartbeat fire가 targetThreadId+policy로 enqueue | H8 fire 라우팅·정책 상속 |
| jsonrpc-envelope-hell-e2e | i/ | JSON-RPC codec | 1000 병렬 상관·timeout 경쟁·10MB 라인 | RPC 프레이밍 무결성·경쟁 조건 |
| bench-python-harness-e2e | i/ | apps/bench | stub python으로 실행 파이프라인 | swebench harness 인자 계약 |
| eval-five-tier-compare-e2e | i/ | apps/eval | CLI 어댑터(cursor/aider)+judge+persist | Tier-4 비교 평가 흐름 |
| artifact-store-e2e-hellgate | u/ | artifact-store | register→list→get→destroy 순환 | 아티팩트 CRUD·기본OFF |
| artifact-auto-register-cross-tool-e2e-hellgate | u/ | artifact+생성 도구 | 이미지/시트 생성 후 자동 등록·조회 | 생성 도구·아티팩트 레지스트리 공유 |
| passive-vcs-classify-e2e-hellgate | u/ | git/passive-classify | bash post-exec VCS 이벤트 분류·sink 발행 | knob+sink 양조건 검증 |
| passive-vcs-bus-wire-e2e-hellgate | u/ | dispatch+config-assembler | 분류된 VcsEvent→AgentEvent 재구성·스트림 구독 | 병합/커밋 분류 end-to-end |
