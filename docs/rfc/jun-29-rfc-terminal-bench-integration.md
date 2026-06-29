# RFC: Terminal-Bench 통합 — affordance-surface 접근 (no bench-wiring, no preset)

- **Status:** Draft (approach agreed; not yet 3-round audited)
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
- **(a) terminal surface** — manifest SSOT(`src/tool/surface/manifest.ts`)에 surface/프로파일 추가: pty_* + bash 등록, LSP/grep/apply_patch 미등록. cli/ide/headless 옆에 나란히(일반).
- **(b) affordance 기반 surface 선택** — 세션 init이 "repo/LSP 있나 vs 라이브 터미널이냐"로 surface 결정. 벤치 어댑터→terminal surface, 제품 CLI→환경 보고. prompt-sniff 없음.
- **(c) pty 도구 갭** (기존 `PtySessionPort`/`TmuxExec` seam 뒤, 코어 무관):
  - tmux **new-session 부트스트랩** (현재 attach만) — 또는 Bun-native PTY 백엔드 채택.
  - **docker-exec TmuxExec 어댑터** — `TmuxExec.run(args)` 단일 seam(`tmux-adapter.ts:31`)을 `docker exec -i <container> tmux <args>`로 래핑(~1파일).
  - **TUI pane-read 충실도** — 현 `pty_read`=capture-pane poll+diff. 빠른 재페인팅 TUI엔 "대기 후 전체 pane 스냅샷"이 필요할 수도 → **라이브런 검증 필요**(최대 리스크).
- **(d) capability 가이드** — terminal-operator 시스템프롬프트(4.5).

## 6. 재사용 vs net-new (gap 분석서)

**재사용 (HAVE):** 패러다임-무관 루프(`turn-loop.ts:84`/`same-turn-engine.ts:29`) · pty 도구 패밀리(`src/tool/pty/tools.ts:199`, tmux 백엔드 `tmux-adapter.ts`) · FFI openpty 레퍼런스(`tests/e2e-pty/pty-harness.ts`) · manifest 프로파일 시스템 · trajectory/telemetry.

**net-new (노력순):** ① terminal surface 프로파일(낮음) ② tmux new-session 부트스트랩(낮음~중) ③ docker-exec TmuxExec 래퍼(중) ④ Harbor `BaseAgent` shim(중~높) ⑤ TUI pane-read 충실도(중, 불확실).

**가장 큰 질문:** "루프가 터미널-오퍼레이터를 호스팅할 만큼 패러다임-무관한가?" → 코드상 **Yes**. 진짜 갭은 backend/adapter 배선(②~⑤)이고 전부 기존 seam 뒤 격리.

## 7. 측정무결성 / 운영
- Terminal-Bench도 oracle 해답 보유 → 우리 **solvability 오라클(gold-prescreen) 동형 적용** 가능(태스크가 풀리는지 oracle로 사전검증, 측정구멍 제외).
- 대시보드: family partition 패턴 재사용 가능하나 TB는 score 모델이 다름(per-task fractional/pass@k) → 별도 surfacing 필요(후속).
- 채점 권위 = Harbor(우리 측정 불필요). 우리 신호는 선택/관측용.

## 8. 리스크 / 미해결
- ⑤ **TUI pane-read 충실도** — 라이브런 전엔 미확정(최대 리스크).
- v2 데이터셋 핀 문법(`@version` vs `org/name`)·로컬 캐시 위치·5-attempts 기본 여부 [미검증 — 분석doc §미검증].
- Harbor `AgentContext`/`ExecResult` 정확 필드 — 코딩 전 `src/harbor/agents/base.py` 대조 필요.
- 멀티언어 LSP(Pro Go레인)와는 **독립 워크스트림** — 섞지 말 것.

## 9. Phasing
1. **P0 정합 확인** — Harbor `BaseAgent` 인터페이스 + 로컬 Docker 1태스크 oracle-run으로 하네스 손에 익히기(코드 0).
2. **P1 terminal surface + pty 갭** — (a)(b)(c①②) 일반 capability로 랜딩 + 유닛테스트, 제품 CLI서 수동 1태스크.
3. **P2 Harbor 어댑터** — `QuantaAgent` shim, 로컬 1태스크 end-to-end(④ + docker-exec TmuxExec).
4. **P3 ⑤ 라이브런 리스크 해소** — vim/maze류 TUI 태스크로 pane-read 충실도 측정 → 필요시 read 모델 보강.
5. **P4 5-pick 실측** — Pro/Live처럼 small picks 먼저, 측정무결성(gold-prescreen) 적용.

> 이 RFC는 approach 합의분 기록. 구현 착수 전 Pro/Live처럼 **3바퀴 적대 어딧** 권장(특히 §4 affordance 경계가 새지 않는지 = "벤치-전용 누수" 검사).
