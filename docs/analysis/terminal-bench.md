# Terminal-Bench 분석 — 벤치 메커니즘 · 경쟁구도 · quanta 통합 갭

> Verified/Pro/Live(전부 patch-on-repo)에 이어 **터미널-에이전트 패러다임** 벤치를 추가할지 판단하기 위한 조사.
> 증거 태그: **[검증]** 1차소스(repo/논문/공식docs) · **[2차]** 블로그/aggregator · **[미검증]** 확인 못함.
> 작성 2026-06-29. 관련: [통합 접근 RFC](../rfc/jun-29-rfc-terminal-bench-integration.md) · [swe-bench-pro-analysis](swe-bench-pro-analysis/README.md) · [멀티데이터셋 RFC](../plans/jun-29-swe-benchmark-platform/README.md).

## 0. 한 줄

Terminal-Bench는 **"패치 생성"이 아니라 "터미널을 직접 모는" 벤치**라 우리 SWE 도구(LSP·grep·apply_patch)는 거의 안 쓰인다 — 대신 **persistent tmux 세션 + 키스트로크**가 전부. **결정적 사실: quanta는 이미 그 primitive(`pty_*` 도구 패밀리 + tmux 백엔드)와 패러다임-무관 에이전트 루프를 보유** → 통합은 코어가 아니라 **어댑터 글루**(Harbor shim + docker-exec tmux + 터미널 전용 도구 프로파일) 수준.

## 1. 뭐하는 벤치냐 — 패러다임이 다름 [검증]

AI 에이전트를 **실제 터미널/CLI 환경**에서 평가 (Stanford + Laude Institute, ICLR 2026). 한 태스크 = ① 영어 instruction ② Docker 샌드박스 환경 ③ 검증 test script ④ oracle 레퍼런스 해답 + 시간제한.

| | SWE-bench (Verified/Pro/Live) | **Terminal-Bench** |
|---|---|---|
| 산출물 | repo diff(패치) | **터미널 행동**(명령 시퀀스) |
| 에이전트 모델 | LSP nav + grep + apply_patch | **tmux pane에 키스트로크 + 화면 읽기** |
| 채점 | 패치 적용 + 테스트 | 컨테이너 상태를 test script로 검증 |
| 성공 정의 | f2p/p2p 통과 | 관찰가능한 머신 상태(서버 떠있나/파일 생겼나/…) |

## 2. 하네스 + 에이전트 인터페이스 [검증]

**2세대 공존** (통합 전 반드시 구분):
- **v1 "Terminal-Bench"** (`laude-institute/terminal-bench`, CLI `tb`): 에이전트가 `perform_task(instruction, session: TmuxSession, logging_dir) -> AgentResult`. 하네스가 **tmux 세션을 직접 건네줌**.
- **v2 "Harbor / TB 2.x"** (`harbor-framework/harbor`, CLI `harbor`, 현행): 에이전트가 `BaseAgent.run(instruction, environment, context)`. `environment`는 **`exec()` + 파일전송만** 제공(tmux 핸들 없음) — 에이전트가 `exec`로 **자기 tmux를 직접 띄움**(`tmux new-session`/`send-keys`/`capture-pane`). 레퍼런스 Terminus2가 정확히 이 방식.
- 커스텀 에이전트 = `BaseAgent` 서브클래스 + `harbor run -d terminal-bench/terminal-bench-2 -m <model> --agent module:QuantaAgent`. (또는 in-container 헤드리스면 `BaseInstalledAgent.install()`.)

**채점**: 에이전트 종료 후 하네스가 `tests/test.sh` 실행 → `/logs/verifier/reward.txt`(v2) 또는 pytest 전수통과(v1). per-task **격리 Docker**, attempts는 `n_attempts`로 설정(5는 기본 아님 [미검증]). **로컬 단일 박스 Docker로 충분**(Daytona/E2B는 스케일아웃 옵션). [검증]

## 3. 경쟁구도 — Terminus는 SOTA 아니라 **베이스라인** [검증/2차]

**공식 2.1 리더보드(agent+model 페어링, tbench.ai):**

| # | Agent + Model | Score | 비고 |
|--:|---|---|---|
| 1 | Codex CLI + GPT-5.5 | 83.4% | 실사용 1위 |
| 2 | Claude Code + Fable 5 | 83.1% | 모델 suspended |
| 3 | **Terminus 2** + Fable 5 | 80.4% | 베이스라인+suspended모델 |
| 4 | Claude Code + Opus 4.8 | 78.9% | Claude 최상 |
| 5 | **Terminus 2** + GPT-5.5 | 78.2% | ← 같은 모델 비교점 |
| 6 | Terminus 2 + Opus 4.8 | 74.6% | |
| 8 | Gemini CLI + Gemini 3.1 Pro | 70.7% | |

**핵심 해석:**
- **Terminus = 도구 없는 중립 레퍼런스**(tmux 단일도구). 모델 능력을 공정 비교하려는 testbed. 제품 에이전트가 항상 이김.
- **모델 = 지배 레버**(~25pt 스프레드), **스캐폴딩 = 타이브레이커**(~3–5pt): 같은 GPT-5.5가 Codex CLI 83.4% vs Terminus 78.2% = **5.2pt가 순수 하네스 차이**. → SWE-bench서 "스캐폴드가 모델천장보다 진범"이던 구조와 동일.
- 숫자 혼란 정리: **Hard 서브셋 ~60%**(="<65% 프론티어"), **풀 2.0/2.1 ~80s**, **model-only aggregate 88%**(Mythos 5) — 측정기준이 다른 것. 2.0은 출시때 "~50% 천장" 설계였으나 ~5개월 만에 mid-80s로 돌파.
- 2.0 보드(~142 entry)엔 NexAU/LemonHarness/Capy 등 **커스텀 하네스가 제품 CLI를 이기는** 경우 많음 = 하네스 엔지니어링이 실제 경합 엣지. (Warp는 보드서 못 찾음 [미검증].)

## 4. 태스크 분류 — 패치 에이전트가 불리한 곳 [검증/2차]

89 태스크, 단일 카테고리 과반 없음. 도메인(2차, Snorkel): SW엔지니어링 26 · 시스템관리 9 · 과학컴퓨팅 8 · 보안 8 · 데이터사이언스 8 · (ML/비디오/RE 등 ~30).

**예시**: fix-ocaml-gc(GC 수정, 최난), build-linux-kernel-qemu(커널 컴파일+부팅), nginx-request-logging(서버설정), qemu-alpine-ssh(VM+SSH), feal-differential-cryptanalysis(암호공격), vim-terminal-task(vim 인터랙티브 조작), blind-maze-explorer(상태탐색), crack-7z-hash, sanitize-git-repo, cartpole-rl-training, hf-model-inference(추론 API 띄우기).

**성공을 가르는 능력(순위)**: ① 환경/시스템-상태 추론 & 에러복구(최다 실패=실행파일 PATH에 없음 24.1%) ② 롱호라이즌 멀티스텝 계획 ③ **인터랙티브/TUI 제어**(vim/REPL/maze) ④ 데몬/네트워킹(서버 띄우고 포트로 대화) ⑤ self-verification ⑥ 도메인지식(crypto/RE/ML).

**patch-on-repo 에이전트가 구조적으로 불리**: 인터랙티브/TUI(vim·maze), 데몬/서버/네트워킹, 시스템빌드/부팅, 환경 bring-up/PATH/패키지설치(최대 실패원), RE/crypto. **상대적 강점**: SW엔지니어링 버킷(26, 최대) + fix-git/fix-ocaml-gc류 디버깅(산출물이 코드변경).

## 5. quanta 통합 갭 — HAVE vs NEED [검증, file:line]

**헤드라인: SWE 프레이밍이 시사하는 것보다 훨씬 준비됨.** 이미 Terminus가 쓰는 send-keystroke/read-pane primitive를 프로덕션 도구로 보유.

**HAVE (재사용):**
- **패러다임-무관 에이전트 루프** — `src/agent/loop/turn-loop.ts:84` → `same-turn-engine.ts:29`의 `for(;;)`는 순수 LLM→tool→observe. 패치/diff 가정 0개(patch-gen은 루프 밖 bench *driver*에). 터미널 도구가 **루프 변경 없이** 꽂힘.
- **PTY/tmux 도구 패밀리** — `src/tool/pty/tools.ts:199`의 `pty_write`(키스트로크, `:252`)/`pty_read`(pane 읽기, `:291`)/`pty_attach`/`list`/`resize`/`kill`. tmux 백엔드(`tmux-adapter.ts:146` send-keys / `:167` capture-pane) = **Terminus primitive 그대로**. Bun-native PTY 백엔드도 있음(`pty-backend.ts`).
- **FFI openpty 레퍼런스** — `tests/e2e-pty/pty-harness.ts`(send/screen/waitFor).
- 도구 manifest/프로파일 SSOT(`src/tool/surface/manifest.ts`) — 터미널 전용 프로파일 = 합성루트 설정.
- 트래젝토리/텔레메트리 루프 기존.

**NEED (net-new, 노력순):**
1. (낮음) **터미널 전용 도구 프로파일** — `pty_*`+bash만 등록, LSP/grep/apply_patch 드롭. manifest 게이트 설정.
2. (낮음~중) **tmux `new-session` 부트스트랩** — 현 tmux 어댑터는 기존 세션 **attach만**(create 없음). 생성 경로 추가 또는 Bun-native 백엔드(spawn 가능) 채택.
3. (중) **docker-exec TmuxExec 어댑터** — `TmuxExec.run(args)` 단일 seam(`tmux-adapter.ts:31`)을 `docker exec -i <container> tmux <args>`로 래핑(~1파일) → 컨테이너 밖 에이전트가 안쪽 pane 조작.
4. (중~높) **Harbor 에이전트 어댑터** — `BaseAgent` 서브클래스 shim: quanta를 외부 오퍼레이터 프로세스로 띄우고, 컨테이너 핸들을 docker-exec TmuxExec에 배선, task prompt 주입, 루프 완주. (현재 Harbor/Terminus 코드 0.)
5. (중, 불확실) **TUI pane-read 충실도** — 현 `pty_read`는 capture-pane poll+diff. 빠른 재페인팅 TUI엔 Terminus식 "대기 후 전체 pane 스냅샷"이 필요할 수도 — **라이브 런으로 확인 필요**.

**가장 큰 아키텍처 질문**: "루프가 터미널-오퍼레이터를 호스팅할 만큼 패러다임-무관한가?" → **단정적으로 Yes**. 진짜 갭은 *백엔드/어댑터 배선*(2~5번)이고, 전부 기존 `PtySessionPort`/`TmuxExec` seam 뒤에 격리됨 — 코어 아님.

## 6. 권고

- **우리 자리는 Codex CLI / Claude Code 옆** — bare Terminus(78.2% GPT-5.5)를 넘어 제품 에이전트(83.4%)와 겨루는 것. 모델은 동일(GPT-5.5/Opus)이니 **승부는 터미널-에이전트 루프 품질**(SWE/Pro와 같은 교훈: 스캐폴드가 레버).
- **통합 타겟 = v2/Harbor** (현행, `BaseAgent.run` + 자체 tmux-over-exec). 로컬 Docker로 측정 가능.
- **ROI**: 코어 재사용 + 어댑터 글루라 Pro 박스배선급(며칠) 추정 — 단 TUI 충실도(5번)가 라이브-런 리스크. 멀티언어 LSP(Pro Go레인)와 별개의 독립 워크스트림.
- **측정무결성**: Terminal-Bench도 oracle 해답 보유 → 우리 gold-prescreen(solvability 오라클) 동형 적용 가능(태스크가 풀리는지 oracle로 사전검증).

### 미검증/주의
- 5-attempts 기본값 / `@version` vs `org/name` 데이터셋 핀 문법 / Harbor 로컬 캐시 위치 — [미검증].
- 도메인 per-category 정수(26/9/8/8/8) + easy/med/hard(4/55/30) = 단일 2차소스(Snorkel).
- Fable/Mythos 5 점수는 historical(6/12 수출통제 suspended, 실행 불가).
- quanta PTY 도구가 bench/headless 합성루트서 `DefaultToolPorts.ptySession` 민팅 가능한지 전 경로 추적 못함 [미검증].

### Sources
- [arXiv 2601.11868](https://arxiv.org/abs/2601.11868) · [OpenReview ICLR2026](https://openreview.net/pdf?id=a7Qa4CcHak)
- [github harbor-framework/harbor](https://github.com/harbor-framework/harbor) · [terminal-bench](https://github.com/laude-institute/terminal-bench) · [Harbor docs](https://www.harborframework.com/docs/agents) · [task-difference](https://harborframework.com/docs/tasks/task-difference)
- [tbench.ai 2.1 리더보드](https://www.tbench.ai/leaderboard/terminal-bench/2.1) · [2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0) · [Terminus](https://www.tbench.ai/news/terminus) · [task gallery](https://www.tbench.ai/tasks)
- [Snorkel TB2.0](https://www.snorkel.ai/blog/terminal-bench-2-0) · [artificialanalysis Hard](https://artificialanalysis.ai/evaluations/terminalbench-hard)
- quanta repo: `src/agent/loop/{turn-loop,same-turn-engine}.ts` · `src/tool/pty/{tools,tmux-adapter,port}.ts` · `src/host/runtime/pty-backend.ts` · `src/tool/surface/manifest.ts` · `tests/e2e-pty/pty-harness.ts`
