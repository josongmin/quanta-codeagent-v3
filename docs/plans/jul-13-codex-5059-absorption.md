# 작업 명세 — Codex 5059(ChatGPT.app) 흡수 후보 (candidate별)

- **Date:** 2026-07-13
- **Provenance:** `.extracted_source/codex/`(build 5059 / codex-rs 0.144.0-alpha.4) 3-track 신규기능 어딧 → 엔진 후보 6개를 strings 스키마/프롬프트/config 수준으로 구체검증(REFRESH-DIFF-2026-07-13). 이 문서는 후보별 **흡수 작업명세**.
- **증거 SSOT:** `.extracted_source/codex/_codex-bin-symbols.txt`(115K줄). 모든 Codex 인용은 거기 축자.
- **라이선스:** Codex는 OpenAI 사유. **코드 복붙 금지, 패턴/설계만 흡수**, 우리 seam 위에 자작.

> **North-star 제약:** correctness > feature-count. 흡수는 (a) 중복금지(우리 보유물 위 델타만), (b) measure-first(효능 A/B 전 default-OFF), (c) 자율성↑ 기능은 승인/게이트 신중. Codex의 효능은 **미측정**(우리 워크로드 기준 벤치 없음) — 흡수=측정 설계지 맹목 이식 아님.

## 후보 요약 + go/no-go

| # | 후보 | 우리 현황(anti-dup) | 분류 | effort | 판정 |
|---|---|---|---|---|---|
| 1 | **code_mode** (tools-as-code) | isolate/VM 도구실행 **없음** | TRUE-GAP | L | **측정각(프로토타입→A/B)** |
| 2 | **multi_agent_v2** 델타 | subagent/side-agent/team **보유** | 델타-흡수 | M | 델타만(fork_turns·slot회계·억제프롬프트) |
| 3 | **execpolicy amendment** | 승인게이트(gated-tool-ports) 보유, rule-persist **없음** | 델타-흡수 | M | novel, **자율성 신중 검토** |
| 4 | current_time_reminder+sleep | supervisor/cost-cap 보유 | hygiene | S | 조건부(장기 무인런 할 때) |
| 5 | rollout_budget / compaction-v2 | cost meter·compaction 보유 | hygiene | — | 우리도 유사물, 흡수 낮음 |

---

## 후보 1 — code_mode (tools-as-code) 프로토타입

### 목적
N개 도구 호출을 모델의 JS 스크립트 1개로 접어 **라운드트립·컨텍스트 오염·토큰**을 줄인다. Codex 계약: `exec(rawJS)` → V8 isolate에서 `await tools.X()` 오케스트레이션 → 누적 산출만 모델로 반환. 중간 result는 컨텍스트 안 거침.

### 현황 (anti-dup, 검증 2026-07-13)
- **TRUE-GAP:** `src/`에 tools-as-code/isolate/VM 도구실행 없음(grep code_mode/isolate/QuickJS/node:vm = 무관 히트만).
- **보유(재사용):** 병렬 tool_call 이미 지원(`src/llm/openai-responses-wire.ts`, `adapters/openai.ts`) — 근데 이건 "한 턴에 여러 tool_call"이지 "툴 result가 컨텍스트 안 거치는 합성"은 아님(핵심 차이). 도구 디스패치 seam=`src/agent/streaming-dispatch.ts`+`effect-channel.ts`. bash 툴=`src/tool/bash/`. 도구 목록 SSOT=manifest(BASE24+GATED, [[tool-surface-ssot]]).

### 작업 (scoped 프로토타입, 3단)
1. **[S] 격리 실행기 선정 스파이크** — Bun 환경에서 JS isolate 옵션 평가: QuickJS(WASM, `quickjs-emscripten`) vs `node:vm`(격리 약함) vs Bun Worker. Codex는 `codex-code-mode-host` 별도 프로세스 `--jitless`. **결정 게이트:** "no Node/fs/network/console" 보장 가능한 최소 실행기. 못 고르면 후보1 중단.
2. **[M] `exec` 도구 seam** — 신규 `src/tool/code-exec/`: 입력=raw JS, 글로벌 `tools` 프록시가 우리 manifest 도구를 `await tools.<name>(args)`로 노출(디스패치는 기존 `streaming-dispatch` 재사용, **재구현 금지**). 산출 `text()/store()/load()`, `max_output_tokens` 캡. cell-actor yield/resume·`codex-code-mode-host` IPC는 **v1에서 제외**(동기 단발 exec만, 장기 스크립트는 후속).
3. **[M] manifest 게이팅** — `QUANTA_CODE_MODE` default-OFF. tools-as-code 모드에선 개별 tool_call 노출 억제 여부(Codex `code_mode_only`)는 knob. 승인/HARD_DENY는 `tools` 프록시 안에서 기존 게이트 통과(우회 금지 — red-on-injection로 핀).

### 게이트 (measure-first, 예외 아님)
- default-OFF, A/B: **tokens-per-task · 라운드트립 수 · tool-heavy task 성공률**. Codex의 토큰절감은 미측정이라 **우리 워크로드(SWE/TB)에서 실측 없으면 랜딩 금지**.
- red-on-injection: `tools` 프록시가 승인/HARD_DENY/scope-guard를 우회하면 RED(격리 실행기가 우리 게이트를 건너뛰는 게 최대 위험).

### effort/risk
L. 위험: (a) 격리 실행기 인프라 무거움(Codex도 44MB 별도 host), (b) 도구 우회 보안, (c) 효능 미검증. **스파이크(1단) 결과로 continue/kill 결정.**

---

## 후보 2 — multi_agent_v2 델타 흡수

### 목적
우리 subagent 오케스트레이션에 Codex v2의 검증된 3개 델타만 흡수: **fork_turns 컨텍스트 상속 · concurrency-slot 회계 · delegation 기본억제 프롬프트**.

### 현황 (anti-dup)
- **보유(재구현 금지):** subagent(`src/subagent/turn-wake.ts,turn-gate.ts`), side-agent(`src/side-agent/`), team, senpi-task 상당(이전 어딧: "우리도 유사물 보유"). 스폰/메시지/대기 이미 있음.
- **델타(흡수각):**
  - **fork_turns(none/all/N):** Codex는 스폰 시 컨텍스트 상속을 3단(제로/전체/최근N턴)으로 노출. 우리 subagent 스폰이 컨텍스트 상속을 뭐로 하는지 확인 후, **부분 fork(N턴)** 옵션 없으면 추가. 컨텍스트 토큰 절감각.
  - **concurrency-slot 회계:** "완료 에이전트도 close 전까지 slot 점유" → 우리 side-agent 동시성 상한이 완료분을 회수하는지 확인(bash-bg-registry는 evict 있음, side-agent는?). OmO 티켓 R1과 겹치는 lifecycle 축.
  - **delegation 기본억제 프롬프트:** Codex 축자 "Do not spawn unless explicitly asked; depth/thoroughness do not count." 우리 subagent 스폰 프롬프트가 남발 억제하는지 대조 → 없으면 흡수(측정: 불필요 스폰율).

### 작업
- **[S] 대조 감사** — 우리 subagent 스폰 계약을 Codex v2 스키마와 항목대조(fork_turns/slot/억제). 갭 표 작성.
- **[M] 갭 3개 각각** — 있는 것 재사용, 없는 것만 추가. 전부 default-OFF knob.

### 게이트
델타별 측정: fork_turns=컨텍스트 토큰, slot회계=orphan subagent(OmO 티켓 §11.1 baseline 공유), 억제프롬프트=불필요 스폰율. 효능 없으면 삭제.

### effort/risk
M. 위험 낮음(기존 위 델타). **주의:** slot회계는 OmO 티켓 R lane과 lifecycle 축 겹침 → 중복작업 금지, 한 곳에서.

---

## 후보 3 — execpolicy amendment (self-amending approval)

### 목적
반복 승인 마찰 감소: **모델이 승인규칙(prefix)을 제안 → 유저 승인 → 정책에 영구저장**해 이후 같은 prefix 명령은 무승인 통과. Codex 축자: `prefix_rule(..., decision="allow")` + justification 필수, `approved_for_session`(휘발) vs `approved_execpolicy_amendment`(영구).

### 현황 (anti-dup)
- **보유:** 승인 게이트(`src/host/runtime/agent-arg-builder/gated-tool-ports.ts`), sandbox-escalation-wire, HARD_DENY(bash 전모드, [[jun-28...]]), admissibility-gate.
- **없음(델타):** "모델이 규칙 제안 → 승인 → **영구 persist** → 런타임 allowlist 갱신" 흐름. 우리는 승인이 대개 1회성.

### 작업
- **[S] 승인 표면 감사** — 우리 승인/HARD_DENY가 rule을 어디에 저장하는지, 세션-persist 개념 있는지 확인.
- **[M] amendment 흐름** — 신규: 승인 UI에 "이 prefix 영구허용" 옵션(justification 강제) → 정책파일 persist → 런타임 allowlist 즉시갱신. 범위 분리(session/영구). 조직상한(Codex `RequirementsExecPolicyToml` 대응)은 우리 gate 규칙원 재사용.

### 게이트 (자율성 = 신중)
- default-OFF. **위험 명시:** 자기 승인표면 확장 = HARD_DENY 원칙과 충돌 소지. 측정=승인마찰 감소 vs 잘못 영구허용 사고율. HARD_DENY 대상(rm -rf류)은 amendment **불가**로 하드핀(red-on-injection).

### effort/risk
M. 위험 중(자율성). 우리 안전문화([[no-heuristics...]], HARD_DENY)와 정면이라 **흡수 전 유저 승인 필요**한 유일 후보.

---

## 후보 4 — current_time_reminder + sleep (조건부)

### 목적
장기 무인런 중 벽시계 시각 주기 주입 + `sleep(duration, 새입력시 조기종료)`. Codex config `{reminder_interval_seconds, clock_source, delivery_mode, sleep_tool}`.

### 현황
- **보유:** supervisor(campaign-generic.sh), cost-cap, background run. 시각 주입·sleep 툴은 없음.
- 필요조건: **우리가 장기 무인 자율런을 실제로 돌 때만** 가치(폴링간격/데드라인 회계). 현재 벤치는 대체로 유한턴 → ROI 낮음.

### 작업/게이트
[S] sleep 툴 + 시각주입 knob(default-OFF). **조건:** 무인 자율런 시나리오가 실재할 때 착수. 지금은 backlog.

---

## 후보 5 — rollout_budget / remote_compaction_v2 (흡수 낮음)

우리 cost meter(pricing SSOT)·compaction 이미 보유. Codex의 session-scoped 가중토큰예산·서버측 compaction 상태머신은 우리 유사물과 델타 작아 **흡수 낮음**. 기록만.

---

## 순서 / 권고

1. **후보 2(multi_agent 델타)** 먼저 — 위험 낮고 기존 위 델타, slot회계는 OmO 티켓과 합침.
2. **후보 1(code_mode)** 스파이크 — 격리 실행기 continue/kill 결정이 관문. 통과 시 최대 ROI(토큰경제).
3. **후보 3(execpolicy amendment)** — 유저 승인 후에만(자율성 리스크).
4. 후보 4·5 backlog.

**공통 하드룰:** 전부 default-OFF + 우리 워크로드 A/B. Codex 효능은 미측정 근거이므로 "Codex가 하니까"는 흡수 명분 아님 — 측정이 명분.
