# RFC: Terminal-Bench 통합 — affordance-surface 접근 (no bench-wiring, no preset)

- **Status:** P1 + P2a + **P2b-bridge LANDED** (terminal surface + `container_exec` + 공유 `terminal-sanitize` + IPC bridge 양끝[TS `containerExecOverIpc` + Python shim 프로토콜 코어] + capability 가이드; 헬어딧 R4→R9 **CONVERGED** §11.5, 통합 3시선 어딧 **constraint 5/5 100/100 CERTIFIED** §11.6) · 남은 P2(Harbor 글루 활성·apps entry-point·실 DockerRun, **박스 필요**)–P4 pending
- **P1 구현 (2026-06-29):** `ToolSurface += "terminal"`(첫 클래스, manifest) + `buildTerminalTools`(BASE-free, pty_* only, `src/tool/index.ts`) + `dockerExecTmux`(container-bound TmuxExec, `src/tool/pty/docker-exec-tmux.ts`) + 인변식 테스트(`src/tool/terminal-surface.test.ts` 7/7: S1/S2/S3 + byte-identical + ownership no-leak Glob 가드). 타입·린트 클린. 적대어딧: 인변식 전부 clean, no-leak 가드 over-exclusion(`/apps`→appshot 충돌) 1건 잡아 `apps/` startsWith로 보강.
- **Date:** 2026-06-29
- **Scope:** `src/apps/` (새 외부 어댑터), `src/tool/surface/manifest.ts`, `src/tool/pty/*`, 합성루트(세션 surface 선택). **코어 에이전트 루프 변경 0 목표.**
- **Related:** 분석 = [docs/analysis/terminal-bench.md](../analysis/terminal-bench.md) · 멀티데이터셋 패턴 = [jun-29 SWE platform RFC](../plans/jun-29-swe-benchmark-platform/README.md)

## 1. Summary

Terminal-Bench(v2/Harbor)는 **patch-on-repo가 아니라 terminal-operator** 패러다임 — 에이전트가 컨테이너 tmux pane에 키스트로크를 쏘고 화면을 읽어 과제를 수행. quanta는 이미 그 primitive(`pty_*` 도구 + tmux 백엔드)와 **패러다임-무관 에이전트 루프**를 보유하므로, 통합은 코어 재작성이 아니라 **얇은 외부 Harbor 어댑터 + 일반 terminal surface**다.

**중심 결정:** 터미널 모드는 **"벤치 모드/preset"이 아니라 환경 affordance(주어진 도구셋)로 결정되는 일반 capability**다. 합성루트가 surface를 고르고(=어떤 도구를 등록하나), 에이전트 루프·LLM I/O는 SWE-bench와 동일. prompt-sniffing 없음, bench-only 분기 없음.

## 2. Motivation

- Verified는 포화, Pro/Live는 patch-on-repo. Terminal-Bench는 **다른 능력 축**(인터랙티브 터미널 조작·데몬·시스템 bring-up)을 측정 — 프론티어 ~60%(Hard), 경쟁이 살아있음.
- 리더보드 교훈이 SWE/Pro와 동일: **모델이 지배 레버, 스캐폴드(에이전트 루프)가 타이브레이커**(같은 GPT-5.5가 Codex CLI 83.4% vs bare Terminus 78.2% = 5.2pt 순수 하네스차). 우리가 노릴 자리 = 제품 에이전트(Codex CLI/Claude Code) 옆.
- 진입장벽 낮음: PTY primitive 기보유.

## 3. 절대 불변식 (제약)

1. **벤치-전용 배선 금지.** Terminal-Bench를 위해 코어/CLI에 들어가는 모든 것은 **"터미널을 모는 일반 능력"으로 정당화**돼야 한다. 정당화 안 되면 `src/apps/`의 벤치 어댑터 안에만 존재. ("이게 Terminal-Bench다"를 아는 코드가 코어에 0.)
2. **default-OFF / byte-identical.** terminal surface 미선택 시 기존 동작 무변(SWE/CLI 그대로).
3. **답안지/스니핑 금지.** 모드를 prompt 텍스트로 판별하지 않는다(brittle + gaming).
4. **preset 시스템 안 건드림.** knob/preset은 SWE-bench 스캐폴딩 전용으로 남기고 직교.

## 4. 중심 설계 — affordance-surface (모드 전환을 "하지 않는다")

### 4.1 문제
에이전트는 매번 "task 받고 행동"으로 동일하다. 그럼 언제 패치를 짜고(SWE) 언제 터미널을 모나(TB)? "터미널 모드로 변경"하는 스위치를 어디 두나? preset을 따로 두면 벤치-전용처럼 보인다.

### 4.2 결정: 모드 = **등록된 도구셋(surface)**, surface = **환경 affordance의 함수**
- 루프(`src/agent/loop/same-turn-engine.ts:29`)는 순수 `LLM → tool → observe`. 패치 가정 0. **다른 건 어떤 도구가 등록됐냐뿐.**
  - repo 체크아웃 + LSP서버 있음 → {lsp, grep, read, edit, apply_patch} → 패치 짠다.
  - 라이브 터미널만 있고 repo/LSP 없음 → {pty_write, pty_read, bash} → 터미널 몬다.
  - **같은 루프, 같은 LLM I/O, 다른 affordance.** LLM이 가진 도구로 주어진 task를 풀 뿐.
- **"분기"는 런타임 if문이 아니라 세션 생성 시점(합성루트)의 surface 선택**이고, surface는 **환경이 실제로 뭘 제공하느냐**로 결정:
  - Terminal-Bench 컨테이너 = repo 체크아웃·LSP 인덱스 없음 + 라이브 셸 → **terminal surface가 자연스럽게 도출**. 이건 "벤치 프로파일"이 아니라 "라이브 터미널 환경일 때 말 되는 도구셋"이며, 제품 CLI가 bare shell 컨텍스트일 때도 동일하게 나온다 → **일반**.
- 결과: 코어에 "벤치냐" 판별 0. 어댑터가 terminal surface로 세션을 만들면 끝.

### 4.3 기각한 대안
- **(A) 프롬프트 스니핑으로 터미널 태스크 감지** — brittle·gameable. 불변식 3 위반. ✗
- **(B) Terminal-Bench preset** — preset = SWE knob 번들(localize/repro/verify-select). 터미널엔 repo·테스트가 없어 그 knob들이 무의미 → 빈 깡통이거나 벤치-핵. 불변식 1·4 위반. ✗
- **(C) 런타임 모드 플래그(`--terminal-mode`)** — 코어가 모드를 알게 됨. affordance로 충분하므로 불필요한 결합. ✗ (단 surface를 명시 지정하는 CLI 옵션은 4.6에서 별도 — 그건 "환경 선언"이지 "벤치 모드"가 아님.)

### 4.5 capability 가이드 (preset 아님)
terminal-operator엔 capability-레벨 시스템프롬프트가 필요("tmux pane를 몬다, 키스트로크를 쏜다, 화면을 읽는다, PATH/설치 에러를 복구한다"). 이건 **terminal surface일 때 항상** 적용(제품이든 벤치든) → 일반 capability 가이드지 벤치 전용이 아니다. **선: capability(terminal-operator)에 묶이면 OK, "Terminal-Bench"에 묶이면 금지.**

### 4.6 CLI 통합
- terminal-operator를 **진짜 제품 CLI capability**로 노출: 유저가 "nginx 띄워줘 / 이 설치 마법사 진행해줘 / vim에서 고쳐줘" → quanta가 pty로 터미널을 몲. (이미 `QUANTA_PTY_ATTACH` 게이트 + pty 도구 존재 → 이를 capability로 승격.)
- 제품 CLI는 환경에 따라 도구 superset(코딩+터미널)을 노출하고 LLM이 적합한 걸 고를 수 있음 — terminal-only profile은 주로 "repo가 없는" 환경(TB 컨테이너, bare shell)에서 도출.
- **Terminal-Bench는 이 capability를 외부 하네스로 재사용할 뿐** — SWE-bench가 repo-surface를 재사용하는 것과 대칭.

## 5. 아키텍처

### 5.1 벤치마크 쪽 — 외부 Harbor 어댑터 (코어 무관)
- 타겟 = **v2 / Harbor** (현행). `BaseAgent` 서브클래스 `QuantaAgent` 구현: `name()/version()/setup()/run(instruction, environment, context)`.
- 위치 = `src/apps/`의 별도 엔트리(SWE-bench가 `src/apps/bench`인 것처럼). **일반 에이전트 루프 + 일반 pty 도구를 import만**, 코어에 추가 0.
- `run()` 내부: Harbor `environment`(exec+파일전송) → `docker exec -i <container> tmux ...`로 in-container pane 생성/구동 → instruction을 첫 메시지로 루프 완주 → `context`에 토큰/trajectory 채움. 채점은 Harbor가 `tests/test.sh`→`/logs/verifier/reward.txt`로 자동.
- 실행: `harbor run -d terminal-bench/terminal-bench-2 -m <model> --agent module:QuantaAgent` (로컬 Docker; Daytona는 스케일아웃 옵션).

### 5.2 시스템 준비 — 전부 일반 capability

**구현 spec (HARD — 코드리뷰서 강제):**
> **S1.** Terminal은 **정식 `ToolSurface`** ("cli"|"bench"|"web"|"ide"|"headless"에 **"terminal" 추가**, `manifest.ts:53` + `TOOL_SURFACES:56`). **bench surface에 얹지 않는다** — SWE-bench와 섞이면 안 됨.
> **S2.** Terminal registry는 **명시적 terminal builder**가 조립하고 **BASE repo-edit 도구셋을 상속하지 않는다.** 현재 `buildDefaultTools()`는 read/write/edit/apply_patch/bash/grep/test_runner를 **무조건 켬**(`BASE_TOOL_NAMES`, `manifest.ts:105`) → terminal엔 부적합. `buildDefaultTools`에서 per-surface default 끄는 식 X, **별도 `buildTerminalTools(ports)`** (pty_* 만, BASE 미상속).
> **S3.** Harbor 모드의 **exec-capable terminal 도구는 전부 container-bound**여야 함. 현 `bash`는 로컬 `runShell` 기반(`src/tool/bash/index.ts:9`)이라 외부 에이전트서 노출하면 컨테이너 아닌 **host를 때림** → **host bash 금지.** TB surface는 (i) bash를 빼고 `pty_*`만 두거나 (ii) exec를 `docker exec`/Harbor-bound로 교체. 기본 = `pty_*` only.
> **S4.** SWE-bench registry는 `buildDefaultTools()` 기반(`driver.ts:2470`) — **Terminal-Bench를 기존 bench preset 안에 넣지 않는다.**

- **(b) affordance 기반 surface 선택** — 세션 init이 "repo/LSP 있나 vs 라이브 터미널이냐"로 surface 결정. 벤치 어댑터→terminal surface, 제품 CLI→환경 보고. prompt-sniff 없음.
- **(c) pty 도구 갭** (기존 `PtySessionPort`/`TmuxExec` seam 뒤, 코어 무관):
  - tmux **new-session 부트스트랩** (현재 attach만) — 또는 Bun-native PTY 백엔드 채택.
  - **docker-exec TmuxExec 어댑터** — `TmuxExec.run(args)` 단일 seam(`tmux-adapter.ts:31`)을 `docker exec -i <container> tmux <args>`로 래핑(~1파일). = S3의 container-bound 구현.
  - **TUI pane-read 충실도** — 현 `pty_read`=capture-pane poll+diff. 빠른 재페인팅 TUI엔 "대기 후 전체 pane 스냅샷"이 필요할 수도 → **라이브런 검증 필요**(최대 리스크).
- **(d) capability 가이드** — terminal-operator 시스템프롬프트(4.5).

### 5.3 Ownership boundary (한눈에 — "TB 전용 분기" 침입 탐지용)

```
┌─ 진입점 (src/apps/) · 점선 위만 "Terminal-Bench"를 안다 ─────────────────┐
│  제품 CLI            SWE-bench (apps/bench)     ★Harbor BaseAgent shim   │
│  (repl/cli.ts)       buildDefaultTools()        = 유일하게 TB 아는 코드  │
└────┬───────────────────────┬─────────────────────────┬──────────────────┘
─ ─ ─│─ ─ ─ ownership 경계 ─ ─│─ ─ ─ (아래는 전부 일반) ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─
     │ surface=cli             │ surface=bench            │ surface=terminal
     ▼                        ▼                          ▼ (BASE 미상속)
┌─ SURFACE 선택 (manifest SSOT · affordance→도구셋, '벤치냐' 분기 X) ───────┐
│  bench/cli → buildDefaultTools()(BASE)   terminal → buildTerminalTools() │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
┌─ 코어 루프 (불변) turn-loop → same-turn-engine: LLM→tool→observe ────────┐
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
┌─ TOOLS ─ repo: lsp/grep/edit/apply_patch  ·  terminal: pty_* (+container exec)
│           bash = host-bound(runShell) → terminal surface서 금지(S3)       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼ (terminal일 때, S3 container-bound)
┌─ TmuxExec seam (tmux-adapter.ts:31) ─ 로컬: host tmux | NEW: docker exec ─┐
└───────────────────────────────────────────────────────────────────────────┘
채점: Harbor(컨테이너 + tests/test.sh → reward) — 우리 밖, 권위
```

## 6. 재사용 vs net-new (gap 분석서)

**재사용 (HAVE):** 패러다임-무관 루프(`turn-loop.ts:84`/`same-turn-engine.ts:29`) · pty 도구 패밀리(`src/tool/pty/tools.ts:199`, tmux 백엔드 `tmux-adapter.ts`) · FFI openpty 레퍼런스(`tests/e2e-pty/pty-harness.ts`) · manifest 프로파일 시스템 · trajectory/telemetry.

**net-new (노력순):** ① terminal surface 프로파일(낮음) ② tmux new-session 부트스트랩(낮음~중) ③ docker-exec TmuxExec 래퍼(중) ④ Harbor `BaseAgent` shim(중~높) ⑤ TUI pane-read 충실도(중, 불확실).

**가장 큰 질문:** "루프가 터미널-오퍼레이터를 호스팅할 만큼 패러다임-무관한가?" → 코드상 **Yes**. 진짜 갭은 backend/adapter 배선(②~⑤)이고 전부 기존 seam 뒤 격리.

## 7. 측정무결성 / 운영
- Terminal-Bench도 oracle 해답 보유 → 우리 **solvability 오라클(gold-prescreen) 동형 적용** 가능(태스크가 풀리는지 oracle로 사전검증, 측정구멍 제외).
- 대시보드: family partition 패턴 재사용 가능하나 TB는 score 모델이 다름(per-task fractional/pass@k) → 별도 surfacing 필요(후속).
- 채점 권위 = Harbor(우리 측정 불필요). 우리 신호는 선택/관측용.

## 7.5 P0 인터페이스 실측 (2026-06-29, harbor-framework/harbor main 소스 verbatim)

- **BaseAgent** (Python): `@staticmethod name()->str` · `version()->str|None` · `async setup(self, environment: BaseEnvironment)->None` · `async run(self, instruction: str, environment: BaseEnvironment, context: AgentContext)->None`.
- **BaseEnvironment.exec**: `async exec(command: str, cwd?, env?, timeout_sec?, user?) -> ExecResult` · `ExecResult={stdout:str|None, stderr:str|None, return_code:int}`. 🔴 **command는 STRING이고 이미 컨테이너-스코프** — Harbor가 활성 백엔드(local-Docker / Daytona / E2B)서 실행. (+ service_exec, upload/download_file/dir, is_file/dir, reset/ensure/empty_dirs, start/stop/attach.)
- **AgentContext**(pydantic): `n_input_tokens·n_cache_tokens·n_output_tokens·cost_usd·rollout_details·metadata` (전부 nullable) — quanta가 채울 토큰/비용/trajectory 슬롯.

**🔴 설계 보정 — cross-language + exec 스코프:**
- Harbor=**Python**, quanta=**TS** → Harbor가 로드하는 `BaseAgent` 서브클래스(shim)는 Python. shim이 `environment`를 쥐고 quanta-TS로 브릿지(서브프로세스).
- `environment.exec`가 **이미 컨테이너-스코프**라, 우리 P1 `dockerExecTmux`(=`docker exec -i <ctr> tmux …`)는 **local-Docker 백엔드(=우리 x86 박스 경로)서만 유효**. 비-local 백엔드(Daytona/E2B)면 컨테이너 핸들이 docker가 아니므로, Python shim이 `environment.exec("tmux …")`로 라우팅해야 함. **타겟 = local-Docker-on-box** → dockerExecTmux 유효, container-id는 shim이 resolve해 quanta에 전달.
- 따라서 P1 dockerExecTmux는 **틀린 게 아니라 "local-Docker 백엔드의 컨테이너-바운드 실현"** — 스코프만 RFC에 명시(범용 비-local은 shim env.exec 경로).

## 8. 리스크 / 미해결
- ⑤ **TUI pane-read 충실도** — 라이브런 전엔 미확정(최대 리스크).
- v2 데이터셋 핀 문법(`@version` vs `org/name`)·로컬 캐시 위치·5-attempts 기본 여부 [미검증].
- ~~Harbor AgentContext/ExecResult 필드~~ → §7.5서 **실측 완료**.
- pip `harbor`는 squat(0.1.20 yanked) — 진짜는 `harbor-framework/harbor`(git/registry). 박스 설치 경로 확정 필요(P2).
- 멀티언어 LSP(Pro Go레인)와는 **독립 워크스트림** — 섞지 말 것.

## 9. Phasing
1. **P0 정합 확인** — Harbor `BaseAgent` 인터페이스 + 로컬 Docker 1태스크 oracle-run으로 하네스 손에 익히기(코드 0).
2. **P1 terminal surface + pty 갭** — (a)(b)(c①②) 일반 capability로 랜딩 + 유닛테스트, 제품 CLI서 수동 1태스크.
3. **P2 Harbor 어댑터** — `QuantaAgent` shim, 로컬 1태스크 end-to-end(④ + docker-exec TmuxExec).
4. **P3 ⑤ 라이브런 리스크 해소** — vim/maze류 TUI 태스크로 pane-read 충실도 측정 → 필요시 read 모델 보강.
5. **P4 5-pick 실측** — Pro/Live처럼 small picks 먼저, 측정무결성(gold-prescreen) 적용.

## 10. 적대 어딧 — 핵심 3체크 (ownership-boundary 누수 탐지)

P1+ 각 단계 + 머지 전, **이 3개를 기계적으로 검증**(= "TB 전용 분기" 침입 잡는 라쳇):

1. **명명 누수 0** — `src/apps/**` **밖**에 `TerminalBench|terminal-bench|Harbor|BaseAgent` 명명이 새지 않는다. (terminal **surface/builder**는 일반이므로 OK; "TerminalBench"라는 고유명사가 코어에 박히면 FAIL.) → grep 가드.
2. **terminal surface가 bench/preset 무침범** — terminal surface/builder 코드가 `@/runner/knobs`(preset) · `apps/bench` · `buildDefaultTools` 기반 bench registry를 import/변경하지 않는다.
3. **default non-terminal registry byte-identical** — terminal surface 추가가 cli/bench/web/ide/headless의 도구셋을 1바이트도 안 바꾼다(`buildDefaultTools()` 출력 불변 + manifest drift guard green).

> 헬게이트 프로토콜로 구현: RED(위 3체크 + 기능 인변식 실패테스트) → TDD 구조구현 → 적대 어딧 3R → 셀프어딧 → 구조적 TDD 보완.

## 11. 적대 어딧 findings (2026-06-30, pre-P2 — P0 검증사실+추론 기반)

**F1 [FATAL-redirect] `dockerExecTmux`(docker exec)는 Harbor 경로가 아니다.** `env.exec`가 container-scoped인 건 Harbor가 백엔드(local-Docker/Daytona/E2B)를 **추상화**하기 때문 — container-id는 의도적으로 숨김. docker exec는 그 추상화를 뚫고 local-Docker + id-노출을 가정 → Daytona/E2B서 사망, local서도 id resolve가 비공개 API 의존. **수정: Harbor 컨테이너 명령은 Python shim의 `env.exec` 경유.** P1 dockerExecTmux는 폐기 아니라 **"Harbor 없는 standalone/로컬-dev 컨테이너 경로"로 강등**(여전히 유효·테스트됨).

**F2 [HIGH] 진짜 transport = cross-language IPC 브릿지.** quanta-TS=brain(루프+키스트로크 결정), Python shim=hands(`env.exec` 실행). 둘이 IPC(JSON over stdio/socket): quanta→{exec cmd | tmux send | read pane}, shim→`env.exec` 결과 반환; 종료시 quanta→token/trajectory, shim→AgentContext 채움. **TmuxExec를 일반화한 `ContainerExec` 포트**: impl-A=dockerExecTmux(standalone), impl-B=IPC-bridge(Harbor). quanta는 포트만 보고 둘 다 무관.

**F3 [HIGH] tmux-only는 비-인터랙티브 태스크서 손해.** TB 다수가 "명령 실행→출력 확인"(non-TUI). 전부 tmux pane(poll+diff)로 강제하면 fidelity↓ + 컨텍스트/비용 폭발. **수정: terminal surface = `container_exec`(one-shot, env.exec 경유) + `pty_*`(인터랙티브 tmux) 둘 다, 전부 container-bound(bridge). host bash 여전히 금지.** (Terminus는 tmux-only지만 그게 baseline이 지는 이유일 수 있음 — 제품 에이전트는 보통 더 가짐.)

**F4 [MED, P3 리스크] pane-read 충실도.** poll+diff capture-pane은 재페인팅 TUI + "명령 끝났나(prompt 복귀)" 감지에 약함. SOTA는 full-pane 스냅샷 + ready-detection(프롬프트 마커) 추정 → P3 라이브 검증, 필요시 read 모델 보강. [winning-agent read 모델 = 네트워크 복구 후 검증]

**F5 [MED → ADDRESSED-content] #1 실패 = exe-not-in-PATH(24.1%, 논문) = 환경-상태 추론.** terminal-operator 시스템프롬프트가 env probe / PATH 발견 / install-on-demand를 유도해야 함. → **capability 가이드 콘텐츠 LANDED**(`src/tool/terminal-capability-guide.ts`, 일반 operator habits·no-answer-key, §11.6). ⚠️정정: env-probe **슬라이스는 이미 존재**(`src/runtime/env-probe/`, ADR-0466, node/bun/python3/git/pytest 체크)—RFC가 greenfield로 본 건 drift. 가이드 주입(prompt) + env-probe를 ContainerExec로 일반화 배선 = entry-point/박스 seam.

**F6 [MED → ADDRESSED] Python shim은 src/ TS 밖** → no-leak 가드(src/.ts 스캔)가 false comfort. → shim home **확정+생성**: 레포루트 `adapters/terminal-bench/`(src/ 밖=가드 무관, owner). no-leak 가드 glob **확장**(.mts/.cts/.yaml/Dockerfile 추가, src/ 내 stray shim 차단). shim이 "유일한 TB-aware 코드"임 유지(Harbor 명명 adapters/에만).

## 11.5 `container_exec` 구현 헬어딧 (R4→R9, 2026-06-30 — clean까지 수렴)

P2a `container_exec`(F3의 one-shot 워크호스) + 공유 `terminal-sanitize` 구현 후 적대+객관 2시선 어딧을 **R9까지 반복**(각 라운드 finding 전부 해소 후 다음 라운드). 코드: `src/tool/container-exec/{tool,port,docker-backend,index}.ts` + `src/tool/terminal-sanitize.ts`(pty와 공유) + `tests/unit/container-exec-harddeny-hellgate.test.ts`. 전부 default-OFF byte-identical(`buildDefaultTools()` 불변), no-leak 가드 통과.

- **R4/R5 (3시선: security·correctness·ownership) → 6 LANDED:** (1) **CRITICAL** `extractShellCommand` 미배선 → HARD_DENY 거부목록(rm-rf/curl|sh/fork-bomb) 우회 → `input.command` 노출 배선 + e2e seam 테스트(registry→policy.evaluate, RED-on-injection 핀). (2) **HIGH** manifest drift guard RED(미등재) → GATED_TOOLS row(`QUANTA_CONTAINER_EXEC`, `terminal:"on"`). (3) **HIGH** defang이 제어바이트 DROP(라인병합 위조) + bidi/ZW/lone-surrogate 누락 → pty의 `neutralizeCapture`를 **공유 `neutralizeTerminalOutput`로 추출**(caret-visible + bidi/ZW/surrogate strip), pty+container-exec 공용(보안로직 중복제거). (4) **MED** null stdout/stderr(IPC bridge str|None) throw → port 타입 `string|null` + coerce. (5) **MED** abort signal 미스레딩 → `exec(cmd, signal?)`. (6) **MED** no-leak 가드 .ts-only → py/sh/json glob 확장.
- **R7 (abort race 재검) → R8 구조 단순화:** R6의 `Promise.race(onAbort)`가 **net-negative**(① 정상완료마다 long-lived turn-signal에 listener LEAK ② abort시 transport partial-output DISCARD ③ signal 이미 threaded라 잉여) → **race 제거, signal-threaded port 직신뢰**(pty 형제 관례 일치, 3문제 동시해소). + stdout flood가 stderr 축출 → **스트림별 독립 cap**(MAX_STREAM 8KB each). + prose over-claim(orphan-kill) 완화, `caretOf` un-export, pty alias drop.
- **R7-objective(테스트강도) → R8 강화:** flood 테스트 비변별(stderr-last라 joined cap도 통과)·abort 테스트 미발화·dead `.filter` → 변별형 flood(STDOUT_TAIL_MARKER가 joined cap의 폐기 중앙에 떨어져 RED)·실제 mid-exec abort 발화(deterministic)·astral-pair 보존·forge-chain 합성·flag 핀·null-contract 핀 추가.
- **R9 수렴 확인:** 5/5 CONFIRMED, **CONVERGED**. 최종 125 테스트 0-fail, lint 0-error(잔여=committed-pty 동급 useRegexLiterals warning + 무관 pre-existing 복잡도 warning), typecheck clean, raw 제어바이트 0.

**P2b-IPC bridge LANDED (box-independent, 2026-06-30):** `containerExecOverIpc(duplex): ContainerExec` (`src/tool/container-exec/ipc-backend.ts`) — F2의 cross-language transport TS측. line-delimited JSON 프로토콜(`→{id,type:exec,command}`/`{id,type:cancel}`, `←{id,type:exec_result,stdout,stderr,code}`/`{id,type:error}`), id-correlation(out-of-order/concurrent), abort=cancel-but-keep(partial 표면화), 닫힌 transport=전 pending reject. **일반 capability**(Harbor 명명 0, no-leak 가드 통과); Python shim이 맞춰야 할 스펙을 핀. injected duplex로 11 테스트 e2e. 적대어딧 1R: CRITICAL(exec-after-close hang→`closed` latch)+HIGH(write-throw가 cleanup 우회→`safeWrite` settle-path) 2건 LANDED, 재검 CONVERGED.

남은 P2 (박스 필요): Python `QuantaAgent` shim의 **Harbor BaseAgent 글루**(brain subprocess 배선, env.exec 바인딩 — 프로토콜 코어는 §11.6서 완성) + `src/apps/` terminal entry-point(buildTerminalTools+가이드 합성 — 현재 호출부 없음=설계대로) + 실 `DockerRun`(Bun.spawn standalone, orphan-reap red-on-injection 테스트).

## 11.6 100/100 box-independent 완성 패스 (2026-06-30 — 통합 3시선 어딧 인증)

P2a/IPC 랜딩 후 **전체 워크스트림 통합 시점**서 3시선 inclusive 어딧(integration / constraint / completeness). constraint 어딧 = **5/5 airtight 100/100 CERTIFIED**(명명누수 0·container-bound·no bench/preset·byte-identical·§3 불변식). 잔여 박스-독립 갭을 ROI순 클로즈:

- **F2 Python shim 프로토콜 코어 LANDED**(`adapters/terminal-bench/quanta_terminal_bridge/{protocol,serve}.py` + 11 pytest) — TS `containerExecOverIpc`의 **카운터파티**(이전엔 단방향 프로토콜). 양 끝 동일 와이어 계약(parse/dispatch/exec_result·error·cancel·malformed-skip·id-correlation·null-stream·non-zero=result), Harbor `env.exec` 글루는 box-only로 분리(`quanta_agent.py`, NotImplemented seam). **fake env로 박스 없이 전수 검증**.
- **F5 capability 가이드 콘텐츠 LANDED** — §13 #5(최대 실패모드) 일반 operator 가이드, no-answer-key 핀(3 테스트). entry-point가 surface와 함께 주입.
- **drift-guard build-proof LANDED** — manifest `terminal:"on"` row를 실 `buildTerminalTools` 산출과 대조(이전엔 "catalogued"만 증명, "built" 미증명 사각). 7 테스트.
- **no-leak glob 확장**(F6) + cap divergence cross-ref 주석.

박스-독립 자투리는 위로 닫힘. 남은 건 전부 진성 박스-의존(Harbor 글루 활성·entry-point·실 DockerRun reap·live TUI). 통합어딧 잔여 MEDIUM(transport 3종이 프로덕션 미배선 scaffold)=설계대로 P2, entry-point 랜딩시 integration test 의무.

**최종 인증 라운드(R-cert, 3시선) — cross-end parity 갭 적발→해소:** 적대어딧이 **HIGH=cancel 계약 모순** 적발(TS가 cancel 후 프레임 대기하는데 Python은 무응답→박스타임 hang; 양 suite가 각자 fake로 통과해 못 봄). **해소 2축**: (1) **cross-end cancel 계약 정합** — Python serve가 cancel시 in-flight task만 cancel+`error("cancelled")` 종단프레임 송신(abort-after-complete는 이미 exec_result로 settle돼 spurious 2중프레임 안 보냄, mutation-검증), TS는 종단프레임에 settle(reject). (2) **공유 golden-frame 코퍼스**(`adapters/terminal-bench/protocol-golden.json`) 양끝 bidirectional replay(exec/cancel/exec_result/error 4종 전부, PRODUCE+CONSUME) — 독립작성 양끝의 와이어 드리프트를 박스 없이 잠금(R3 권고 SSOT). +serve concurrency 강화(closed-event race로 dead-write 즉시정지·identity-pop 교차evict 차단, 둘 다 mutation-RED 검증)·no-leak glob 진성수정(literal `Dockerfile` 0매칭 false-coverage→brace 교정+meta-guard·toml/cfg/txt 추가)·answer-key 테스트 강화(버전핀/node-id/소스경로/"this task" shape 차단)·capability 가이드 inert 정직표기. 양끝 테스트: TS 134 + Python 20 그린, mutation 검증 3건(teeth). 박스-독립 표면 = **defensible 100/100**(잔여 전부 진성 박스-의존).

## 12. 최종 아키텍처 (audit 반영)

```
quanta-TS (brain) ── ContainerExec 포트 ──┬─ impl-A dockerExecTmux  (standalone/로컬-dev, docker exec)
  terminal surface:                       └─ impl-B IPC-bridge      (Harbor: ↔ Python shim → env.exec)
   • container_exec (one-shot, non-TUI)         │
   • pty_* (interactive tmux, TUI)              │  JSON/stdio
   • (host bash 금지)                            ▼
                                          Python BaseAgent shim (adapters/terminal-bench/, 유일 TB-aware)
                                          setup()/run(): env 쥐고 quanta-TS 서브프로세스 launch,
                                          명령 env.exec 라우팅, 끝에 token/trajectory→AgentContext
                                                │
                                          Harbor (컨테이너 + tests/test.sh → reward)
```
- **포트 일반화**: P1 `dockerExecTmux`를 `ContainerExec` 포트의 한 impl로 재배치(standalone). Harbor impl-B(IPC)는 P2 net-new.
- **one-shot + tmux 이원화**: 비-TUI는 container_exec, TUI만 pty_*. 둘 다 ContainerExec 포트 위.
- **shim 위치**: `adapters/terminal-bench/`(repo 루트, src/ 밖 — Python). no-leak 가드를 이 디렉토리 제외 + "TB 명명은 여기/src/apps만" 으로 확장.
- **수정된 phasing**: P2a=ContainerExec 포트 + container_exec 도구(테스트가능, 박스불필요) → P2b=IPC 브릿지 프로토콜 + Python shim(박스) → P2c=박스 setupTerminalBench(real harbor git) → P3 라이브.

### 네트워크 복구 후 검증할 잔여 (audit 미완)
- Harbor local-Docker 백엔드가 외부 docker-exec 가능한 container-id를 노출하나(=dockerExecTmux standalone 유효성) / 기본 backend. [deepwiki: env.exec가 sanctioned, DockerEnvironment=compose 추상화 → §12 IPC-bridge 확정]
- 커스텀 `--agent module:Class` 등록 메커니즘(shim PYTHONPATH/pip) — P2b 박스서 확정.

## 13. SOTA++ 레버 (source-verified, Harbor/terminal-bench 소스 + TB2.0 논문 2601.11868)

랭크 결정 capability(높은순) + 구현 메커니즘. **scaffolding gap ~9pt(GPT-5.2: Codex CLI 62.9 vs Terminus-2 54.0) = tool richness**(raw keystroke보다 구조화 도구). 우리 2-tool 설계가 정확히 그 엣지.

1. **구조화 도구 > raw keystroke (최대 측정갭).** → `container_exec`(exit-code+stdout/stderr) = Codex가 갖고 bare-Terminus가 없는 그 도구. **native tool-calling**(JSON-in-pane 파싱 X). 다음 증분=전용 file-edit(apply-patch) 도구.
2. **completion detection (최대 리스크).** → container_exec=**exit-code가 신호(공짜)**. pane=KIRA marker-poll(`printf '__CMDEND__<seq>'` 후 capture-pane 폴, 마커 뜨면 조기복귀, 없으면 duration 타임아웃 폴백). non-marker 대안=Terminus-1 `; tmux wait -S done`.
3. **surface별 read 모델.** → 스트리밍 출력=diff-since-prev-buffer(라벨 "New Terminal Output"); 인터랙티브/TUI=**full visible-pane 스냅샷**(라벨 "Current Terminal Screen"); full scrollback on-demand. **diff-only 금지**(repainting TUI서 깨짐) — 현 pty_read 보강 필요(F4).
4. **output byte-cap (head+tail ~10-30KB).** first-half+last-half + elision marker. tail-only는 명령echo/초기에러 손실. (논문: turns多≠점수↑ → 익사 방지용.)
5. **env-probe + install-on-demand** — #1 실패(exe-not-in-PATH 24.1%). `command -v`/which 프리플라이트 + 패키지매니저 which-loop({apt-get,dnf,apk,…}) 비대화 설치. 최고 ROI, steering+thin-probe.
6. **완료 self-verify** (KIRA double-confirm: task_complete시 요건 체크리스트 재투입). **context 압축**(free-token<8000 proactive summarize).

> **구현 우선순위 (SOTA++ 정렬):** P2a=`container_exec`+`ContainerExec` 포트(#1·#2 exit-code, 박스불필요·테스트가능) **먼저** → pane read-model 보강(#3, F4, 라이브 검증) → env-probe 가이드(#5) → marker-poll(#2 pane). container_exec가 워크호스라 여기서 대부분 점수.
> **미검증:** KIRA 마커 리터럴·30KB·74.8% 수치(2차); "Endless Terminals" 2601.16443 404. 나머지 §13 = Harbor/terminal-bench 소스 + TB2.0 논문 직접확인.
