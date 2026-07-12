# RFC: Wall-clock time injection + `sleep` tool (Codex 5059 흡수)

- **상태**: Draft / BACKLOG (조건부 — 착수 게이트는 §4)
- **날짜**: 2026-07-13
- **North-star 제약**:
  - **measure-first** — 효능은 "실제로 long-unattended-autonomous-run을 돌리느냐"에 전적으로 종속. 그 시나리오 없이는 미측정·미착수.
  - **conditional ROI** — 현재 벤치는 대부분 finite-turn(유한 턴 예산 종료)이라 wall-clock 감각이 outcome을 못 움직인다. 낮은 우선순위 hygiene.
  - **default-OFF** — periodic time-injection은 knob으로 gate, 미설정 시 byte-identical. `sleep` 도구는 도구인 만큼 존재만으로 프롬프트를 오염시키지 않게 surface manifest gate 적용.

---

## 1. 흡수 대상 (Codex 5059)

Codex `current_time_reminder` + `sleep` 도구. config 스키마(발췌, `.extracted_source/codex/_codex-bin-symbols.txt`):

```
CurrentTimeReminderConfigToml {
  reminder_interval_seconds
  clock_source          // system | external
  delivery_mode         // any_inference | after_user_or_tool_output
  sleep_tool
}
CurrentTimeReminderDeliveryMode = any_inference | after_user_or_tool_output
CurrentTimeSource = system | external
```

`sleep` 도구(Codex 설명): *"Pause execution for a specified duration. The sleep ends early when new input arrives... Returns the elapsed wall-clock time."* 관련 flag: `prevent_idle_sleep`(호스트 idle-sleep 억제), 그리고 external clock 경로엔 `external sleep duration is outside the supported range` / `external sleep deadline is outside the supported range` 가드 문자열이 존재(위 심볼 덤프).

**근거(Codex의 rationale, 우리도 동의):** LLM은 wall-clock에 대해 stateless다. 장시간 무인 자율 루프는 (a) 폴링 간격 계산, (b) 마감/데드라인 인지, (c) sleep 회계(얼마나 잤는지)를 위해 주기적 시간 주입이 필요하다. 유한-턴 대화에선 이 셋 다 무의미하다.

---

## 2. 현황 (anti-dup, VERIFY IN REPO)

### 2.1 시간을 context에 주입하는가? — **PARTIAL (day-granularity only, 시각 없음)**

- `src/agent/prompt-reminders.ts:119-120` `todayDateLine`이 per-turn dynamic reminder에 **날짜만** 박는다:
  `` `Today's date is ${new Date((now ?? Date.now)()).toISOString().slice(0, 10)}.` `` — `.slice(0,10)`이라 `YYYY-MM-DD`, **HH:MM:SS 시각은 버려진다.**
- 이 date 라인은 `contentByKey("date", …)`(`prompt-reminders.ts:187`) → `resolveReminderBlocks`(`:241`) → `buildDynamicContext`(`:270`)로 **매 턴** 렌더된다. 즉 "주기적 재주입" 채널(per-turn `<system-reminder>`)은 이미 있고, 거기에 **날짜만** 실려 있다.
- 주의: 이 date는 의도적으로 clock-injected(`opts.now ?? Date.now`, `prompt-reminders.ts:112-118` ADR-0078 replay 결정론 주석)라 byte-identical replay 불변식이 걸려 있다. **시각(초 단위 변화)을 무턱대고 실으면 replay/캐시 불변식을 깬다** — Codex의 `delivery_mode`(any_inference vs after_user_or_tool_output)와 `reminder_interval_seconds`가 바로 이 "매번 바뀌는 값을 언제 넣냐"를 gate하는 이유다.

**판정: 시각/경과-시간 주입은 TRUE-GAP. 날짜 주입 + per-turn 채널은 이미 있음(PARTIAL).**

### 2.2 `sleep`/`wait` 도구가 있는가? — **PARTIAL (handle 대기만, bare sleep 없음)**

- `src/tool/bash/await.ts` `bash_await`(`makeBashAwaitTool`, `:130`) — **기존 background shell handle**에 대해 exit/regex/`timeout_ms`까지 블록. handle이 있어야 한다.
- `src/tool/subagent-bg/await.ts` `subagentAwaitTool`(`:80`) — **기존 background subagent handle** 완료 대기, `timeoutMs` 지나면 `status='running'`으로 polling 유도.
- `src/tool/browser/index.ts:564` `waitTool` — 브라우저 세션 조건 대기(도메인 한정).
- `grep name:"sleep"|"wait"|"delay"|"pause"` over `src/tool` → **bare `sleep(duration_ms)` 도구는 없음.** 세 개 다 "어떤 handle/조건을 기다림"이지 "그냥 N ms 자다가 새 입력 오면 일찍 깬다"가 아니다.

**판정: bare `sleep(duration_ms, early-exit-on-input, returns elapsed)`는 TRUE-GAP. handle-await 3종은 인접 PARTIAL(재사용 대상 아님 — semantics가 다름).**

### 2.3 long-run/supervisor/clock seam 인벤토리

- **장시간 무인 실행 = 지금은 shell-레벨 supervisor**: `tools/campaign-generic.sh`가 `sleep 45`/`sleep 25`(`:66,70,85`) 폴링 루프로 박스/채점을 돈다. 즉 "장시간 폴링 sleep"은 **agent 밖 bash 스크립트**에 산다. agent-loop 내부엔 sleep 개념이 없다.
- **ClockPort/TimerPort seam 이미 다수 존재** — 재사용 대상:
  - `src/connectors/types.ts:113` `interface ClockPort`
  - `src/connectors/token-refresh-scheduler.ts:53-56` `TimerPort { set/clear }` + `ClockPort` 주입, closed-port DI(주석 `:20-32` — no `Date.now()` leak, fake clock/timer로 결정론). **이게 우리의 표준 timer 격리 패턴이다.**
  - `src/scheduler/types.ts:192`, `src/reactor/types.ts:123`, `src/llm/oidc-federation.ts:63` 등에도 `ClockPort` 재정의.
- **per-turn reminder gate 인프라**: `perTurnReminderEnabled`(`src/runner/assemble/session-state.ts:21,89`) — reminder 채널을 knob으로 끄는 배선이 이미 있음. time-injection도 여기 얹으면 재발명 0.
- **cost-cap/burn 회계**(MEMORY: jun-28) — meter는 token/$ 누적기지 wall-clock 도구가 아님. 무관.

---

## 3. 제안

### [S] `sleep` 도구 (bare, early-exit, returns elapsed)

`src/tool/sleep/`에 순수-leaf 도구:

```ts
// input
{ duration_ms: number (int, positive, capped) }

// behavior
// - ctx.signal(=abort) OR "new input arrives" 시 조기 종료
// - 반환: 실제 경과 wall-clock ms (요청값 아님)
// - default-OFF: surface manifest에서 gate (bench/finite-turn엔 미노출)
```

설계 규칙:
- **TimerPort/ClockPort 재사용** — `token-refresh-scheduler.ts`의 `TimerPort { set/clear }` + `ClockPort { now }` DI 패턴 그대로. prod adapter가 실 `setTimeout`, 테스트는 fake timer 주입 → real-time sleep 없이 결정론 유닛. `Date.now()` raw 호출 금지(replay 불변식).
- **early-exit = `ctx.signal`** — `bash_await`가 이미 `ctx.signal.aborted`(`await.ts:157`)로 abort를 처리하듯, sleep도 abort/새-입력 신호에 즉시 resolve. "new input arrives"를 우리 루프에서 무엇으로 매핑할지는 착수 시 결정(현 loop엔 turn-중간 user-input inject seam 유무 확인 필요 — 없으면 v1은 abort-only, elapsed 반환은 유지).
- **returns elapsed** — `clock.now()` 시작/종료 차. 요청 duration이 아니라 실제 경과(조기 종료 시 < duration). Codex와 동일.
- **cap** — `duration_ms`에 상한(예: 상수). `external sleep duration is outside the supported range` 가드처럼 범위 밖은 typed reject, throw 금지.
- **도구 surface** — `src/tool/surface/manifest.ts`에 `gate: opt-in`/`default: opt-in`(2.3의 gate kind 재사용). finite-turn 벤치엔 미노출.

### [S] periodic wall-clock/elapsed 주입 knob (default-OFF)

`todayDateLine` 옆에 **시각/경과-시간 라인**을 per-turn reminder 채널에 추가하되 knob-gate:
- 새 `contentByKey` 케이스(예: `"wall-clock"`) — `todayDateLine` 패턴 그대로 `input.now` 주입. off면 `undefined` 반환 → 블록 미방출 → **byte-identical**.
- `delivery_mode` 축소 채택: Codex의 `any_inference`(매 추론) vs `after_user_or_tool_output`(사용자/도구 출력 뒤에만). v1은 **후자만**(더 저렴·덜 시끄러움) — per-turn 채널이 이미 그 자리라 자연 매핑.
- `reminder_interval_seconds` 축소 채택: 매 턴이 아니라 마지막 주입 이후 N초 경과 시에만 갱신(clock diff). 안 하면 초 단위로 매턴 prompt drift → 캐시 무효화 폭발. **이 interval gate가 replay/캐시 불변식(§2.1)을 지키는 load-bearing 부분.**
- `clock_source system|external` — 우리는 v1 `system`(ClockPort)만. external은 미채택(실 수요 없음).
- `prevent_idle_sleep` — 미채택(호스트 idle-sleep 억제는 EC2/박스 supervisor 레이어 관심사, agent 도구 아님; 필요하면 `campaign-generic.sh`/launch에서 `caffeinate` 류로).

**최소 유지**: v1 = `sleep` 도구(abort-early + elapsed) + 시각-주입 knob 1개(after_user_or_tool_output, interval-gated, default-OFF). 그 외 config 축(external clock, prevent_idle, any_inference)은 전부 미채택.

---

## 4. 조건 게이트 (착수 차단조건 — BACKLOG until needed)

**이 RFC는 measured-need 전까지 착수 금지다. 투기적으로 짓지 않는다.**

착수 트리거(하나 이상 실증돼야 함):
1. **실제 long-unattended-autonomous-run 시나리오 존재** — agent가 유한 턴 예산이 아니라, 외부 조건(빌드 완료/배포/타 세션 이벤트)을 **폴링하며 대기**하는 루프를 우리가 실제로 돌린다. 현 상태: 그런 루프는 `campaign-generic.sh`(shell)에만 있고 agent-loop엔 없음 → **트리거 미충족.**
2. **agent가 "지금 몇 시/얼마 잤나"를 몰라서 실패하는 trajectory 관측** — trajectory 스캔에서 wall-clock 부재가 실패·헛폴링을 유발한 사례. 현 벤치는 finite-turn이라 발생 안 함.
3. deadline-aware 자율 작업(예: "X시까지 끝내라") 요구.

미충족 근거: 현 프론티어 lever는 oracle-loop/synthesis 수렴(`jun-29-gap-essence`)이지 wall-clock 감각이 아니다. north-star 6항목(agent-state 가시성) 중 이 기능이 직접 움직이는 건 0. 따라서 backlog.

---

## 5. effort / risk / measure

- **effort: S** — `sleep` 도구 leaf 하나(TimerPort DI 재사용) + `contentByKey` 케이스 하나 + knob 하나 + manifest 엔트리. 새 인프라 없음(clock/timer/reminder-gate 전부 기존).
- **risk: low** — 순수-leaf + default-OFF. 유일 실 리스크는 시각 주입이 **replay/prompt-cache 불변식을 깨는 것**(§2.1) → interval-gate + default-OFF로 봉쇄. `sleep` 도구는 real-time 블록이라 **테스트에서 fake-timer 필수**(안 그러면 유닛이 실제로 잠). abort-early 경로가 hang 안 만들게 `ctx.signal` 배선 필수.
- **measure**: 오직 long-run 폴링/deadline 작업이 존재할 때만 의미. 그때 A/B = (시각 주입 on/off) × (헛폴링 횟수 / 데드라인 준수율 / 불필요 대기시간). finite-turn 벤치엔 측정 지표 자체가 없음.

---

## 6. 요약 + verdict

- **현황**: 시각/경과-시간 context 주입 = TRUE-GAP(날짜만 있음, `prompt-reminders.ts:119`); bare `sleep(duration_ms)` 도구 = TRUE-GAP(handle-await 3종만 있음). 재사용 seam(ClockPort/TimerPort `token-refresh-scheduler.ts:53`, per-turn reminder gate `session-state.ts:21`)은 이미 준비됨.
- **제안**: [S] fake-timer-격리 `sleep` 도구(abort-early, returns elapsed) + interval-gated 시각-주입 knob(default-OFF, after_user_or_tool_output). external-clock/prevent_idle/any_inference 미채택.
- **verdict — BACKLOG-until-needed.** effort S·risk low이나 ROI가 "장시간 무인 자율 폴링 루프 존재"에 완전 종속인데 현 벤치는 finite-turn이라 그 시나리오가 없다. **지금 짓지 말 것.** §4 트리거 1(실 long-run 폴링 루프) 충족 시 S-effort로 즉시 착수. 그 전엔 투기적 구현 금지.
