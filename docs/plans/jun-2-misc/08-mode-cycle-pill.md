# RFC: shift+tab 권한/모드 사이클 + 입력창 모드 pill ("지금 뭐 할 권한인지" 상시 노출)

상태: Draft · 2026-06-02 · 슬라이스 default-OFF · 본 RFC는 `01-mcp-auto-restart.md` 깊이를 미러링

---

## 1. 배경 — claude-cli 의 shift+tab mode cycling UX (흡수 대상)

Claude Code CLI 는 입력창에서 `shift+tab` 한 번으로 **권한 posture 를 순환**시키고,
각 posture 마다 색상 pill + 한 줄 설명을 입력창에 상시 노출한다.

증거 (`.extracted_source/claude-code-cli/_cli-symbols.txt`, 실제 문자열 verbatim):

- 키 바인딩 자체:
  - `_cli-symbols.txt:144181` — `chat:cycleMode`
  - `_cli-symbols.txt:144183` — `shift+tab`
  - `_cli-symbols.txt:146501` — `confirm:cycleMode` / `shift+tab` (confirm dialog 안에서도 동일 키)
  → 즉 `shift+tab` 은 단일 동작 `cycleMode` 에 바인딩되어 있고, 채팅 입력창과 confirm
    다이얼로그 양쪽에서 같은 키로 권한 모드를 한 칸씩 advance 한다.

- 모드 전환의 실제 setter:
  - `_cli-symbols.txt:144345` — `set_permission_mode`
  - `_cli-symbols.txt:139922` — `Current permission mode (`
  - `_cli-symbols.txt:148679` — `Permission mode`
  - 모드 enum 문자열: `acceptEdits` (다수, 예 `120785`, `131809` `--permission-mode acceptEdits`),
    `bypassPermissions` (`140022` `Cannot set permission mode to bypassPermissions …`),
    `auto` (`140024` `Cannot set permission mode to auto`).

- 각 모드의 한 줄 설명 (verbatim):
  - `_cli-symbols.txt:148290` — `Claude Code won't ask before using allowed tools.`
  - `_cli-symbols.txt:148291` — `Claude Code will always ask for confirmation before using these tools.`
  - `_cli-symbols.txt:148303` — `Claude Code can read files in the workspace, and make edits when auto-accept edits is on.`
  - `_cli-symbols.txt:144195` — `auto-accept edits`
  - `_cli-symbols.txt:161110` — `In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.`
  - `_cli-symbols.txt:161114` — `WARNING: Claude Code running in Bypass Permissions mode`

- plan posture 는 동일 cycle 의 한 칸:
  - `_cli-symbols.txt:148345` — `Enabled plan mode`
  - `_cli-symbols.txt:148346` — `Already in plan mode.`
  - `_cli-symbols.txt:149566` — `(session override from plan mode)`

요약하면 claude-cli 의 cycle 은 **default → acceptEdits → plan → (bypass/auto)** 4 posture 를
하나의 키로 돌리고, 각 posture 가 입력창 바로 옆에 색상 pill 로 항상 보인다.

**왜 좋은가 (anxiety 감소).** 에이전트 CLI 의 가장 큰 불안은 "지금 엔터 치면 얘가 *뭘 할
권한*인가?" 이다 — 파일을 마음대로 고치나? 셸을 물어보고 쓰나? 아무것도 안 건드리나?
posture 가 보이지 않으면 사용자는 매 턴 보수적으로 확인하거나(느림), 반대로 위험 모드인
줄 모르고 위험한 명령을 흘려보낸다(사고). claude-cli 처럼 (a) posture 를 입력창에 상시
색상 pill 로 노출하고 (b) 1-keystroke 로 바꾸게 하면 "확인-비용"과 "사고-위험"을 동시에
낮춘다. ROI 가 높은 순수 UX 흡수다 (모델 호출 0, 새 도구 0).

---

## 2. 현재 quanta — 모드/권한 상태가 *기동 시 고정*, pill 은 있으나 입력창과 분리

### 2.1 두 개의 직교 모드 enum (혼동 주의 — 둘 다 실존)

quanta 에는 "mode" 라는 단어를 쓰는 enum 이 **여럿** 있고, 본 RFC 가 건드릴 것은 정확히
둘이다:

1. **`PermissionMode`** (= claude-cli 의 cycle 축과 1:1 대응) —
   `src/permission/types.ts:40`
   ```ts
   export type PermissionMode = "default" | "acceptEdits" | "bypass" | "auto"
   ```
   - `default` = 매 위험 액션마다 HITL 프롬프트 (claude-cli 의 default 와 동일).
   - `acceptEdits` = 편집은 자동 허용, 명령은 물어봄.
   - `bypass` = 거의 다 허용 (claude-cli `bypassPermissions`).
   - `auto` = 주입된 classifier 가 allow/deny 결정, classify 포트 없으면 `ask` 로 안전
     강등 (`src/permission/types.ts:37-40` 주석).
   - 실제 게이트는 `PermissionContext { mode, classify? }` (`types.ts:42-48`).

2. **`AgentMode`** (= prompt posture / read-only fence 축, plan 이 여기 있음) —
   `src/agent/prompt.ts:110` (`= AgentPromptMode`), 값 union:
   `default | plan | review | audit | architect | editor`
   (`src/agent/run-mode/types.ts` 주석 + `src/agent/mode.ts:34` 의 `MUTATING_MODES`).
   - `plan/review/audit/architect` = READ-ONLY posture (mutating 도구가 dispatch seam 에서
     fail-closed 로 차단; `src/agent/mode.ts:50-57` `isMutatingToolBlockedInMode`).
   - `default/editor` = mutating 허용 (`mode.ts:34` `MUTATING_MODES`).
   - 이게 status-pills 가 이미 그리는 `[PLAN]/[REVIEW]/[AUDIT]` pill 의 소스다.

> ⚠️ `src/agent/run-mode/types.ts:21` 의 `AgentMode = interactive|headless|batch|ci-bot|ide|daemon`
> 와 `src/agent/subagent-typed/port.ts:60` 의 `AgentMode = architect|editor|debug|tdd|explore`
> 는 **이름만 같은 다른 enum**이다. 본 RFC 와 무관 — 건드리지 않는다.

claude-cli 의 `shift+tab` cycle 은 **권한 축 (`PermissionMode`)** 을 돈다. plan 이 같은
cycle 에 끼는 건 plan 이 "도구를 못 쓰게 하는 가장 강한 read-only posture"이기 때문이다.
quanta 에서 그건 `AgentMode="plan"` 이라 — **두 축을 하나의 사용자-노출 cycle 로 합쳐야**
claude-cli 와 동등해진다 (§4.1 에서 canonical cycle 정의).

### 2.2 모드는 *기동 시 한 번* 읽혀 세션에 고정된다 (핵심 제약)

- `PermissionMode` 출처: `src/apps/cli/repl/session-runtime-config.ts:59`
  ```ts
  mode: env("QUANTA_PERMISSION", "default") as PermissionMode,
  ```
  ENV 로만 들어온다. 슬래시/키로 바꾸는 경로 없음.
- 이 mode 가 `boot.mode` → `runtimeContext.permissionMode()` 로 흐른다
  (`src/apps/cli/repl/runtime-context-compose.ts:164` 부근의 binding, 정확히는
  `src/sdk/runtime/context.ts:197` `permissionMode: () => record.state.snapshot.permission.mode`).
- 그리고 **세션 생성 시 단 한 번** 읽힌다:
  `src/apps/cli/repl/session-loop.ts:278`
  ```ts
  permissionMode: runtimeContext.permissionMode(),
  ```
  `RuntimeContext` 인터페이스 (`context.ts:66-82`) 에는 `permissionMode()` **getter 만**
  있고 setter 가 없다. snapshot 은 `state.patch(...)` 로 갱신 가능하지만
  (`context.ts:120-123`), 그 patch 경로는 `RuntimeFacadeComposeOptions` (granularRegistry/
  automationEngine 등) 에만 노출돼 있고 permission.mode 는 외부에 setter 가 없다.
  → **결론: `PermissionMode` 는 현재 아키텍처상 mid-session 변경 불가**다 (정직하게).

- `AgentMode` (plan 등): `src/agent/prompt.ts` / `mode.ts:41` `resolveAgentMode` 로 결정되며,
  collaboration mode 전환은 *developer-channel 메시지* (`mode=plan`) 로만 일어난다
  (`mode.ts:456-465` `applyDeveloperModeTransition`). 사용자가 키/슬래시로 turn 사이에
  토글하는 경로는 없다. `/plan` 슬래시는 **모드 토글이 아니라 plan 패널 표시**다
  (`src/apps/cli/slash/registry-surface.ts:343-372`, `describe: "Show the current plan"`).

### 2.3 그런데 *mid-session mutable state* 의 선례는 이미 있다 (중요)

세션 중 바뀌는 posture-state 가 quanta 에 이미 둘 있다. 둘 다 `{ get(), set() }` 핸들이다:

- **`effortStore`** — `/effort` 슬래시가 mid-session 으로 set 하고 즉시 pill 갱신:
  `src/apps/cli/repl/surface-compose.ts:487-495`
  ```ts
  effort: {
    get: () => setup.effortStore.get(),
    set: (lvl) => { setup.effortStore.set(lvl); setup.pills.update({ effort: lvl }) },
    ...
  }
  ```
- **`identityModeState`** — `session_config` 도구가 mid-session 으로 set:
  `src/host/runtime/internal/context-binding.ts:1074`
  ```ts
  args.options.boot?.identityModeState?.set(mode as never)
  ```
  세션 루프는 매 turn `createSession` 직전에 `activeIdentityModeState.get()` 으로
  최신 값을 읽는다 (`src/apps/cli/repl/session-loop.ts:279-280`).

이 패턴이 §4.4 에서 **모드 mutable seam 의 설계 템플릿**이다: posture 를 `{get,set}`
스토어로 들고, set 시 (a) pill 갱신 + (b) "다음 createSession 에서 읽힘"으로 turn-경계
적용. effort/identity 가 정확히 그렇게 동작한다.

### 2.4 pill 렌더링은 이미 있다 — 단, 입력창과 분리된 *하단 status bar* 다

`src/apps/cli/status-pills.ts` 가 색상 pill 한 줄을 만든다:

- `formatMode(mode: AgentMode)` (`status-pills.ts:123-129`): `[PLAN]`(yellow bold),
  `[REVIEW]`(magenta), `[AUDIT]`(cyan), `default` 는 숨김(`""`).
- `formatSandbox` (`status-pills.ts:156-163`): `🔒 read-only` / `⚙ workspace` / `⚡ danger`.
- 합성은 `composeLine` (`status-pills.ts:215-240`) → `StatusBar.setDefault` 로 **하단
  scroll-region status bar** (`src/apps/cli/status-bar.ts`, DECSTBM 마지막 행) 에 그린다.
- 갱신 API: `pills.update({ mode })` (`status-pills.ts:278-282`).
- non-TTY 면 전부 no-op (`status-pills.ts:185-193`).

색상 상수는 모듈 안에 인라인 ANSI (`status-pills.ts:41-49`). `formatMode` 는 **현재
`PermissionMode` 를 안 그린다** — `AgentMode` 만 그린다.

### 2.5 `shift+tab` 키 입력 경로 — 현재 *캡처조차 안 함*

raw-line reader 가 키를 raw-mode keypress 레벨에서 직접 다룬다
(`src/apps/cli/raw-line-reader.ts`):

- `KeyEvent` 인터페이스 (`raw-line-reader.ts:81-85`) 는
  ```ts
  interface KeyEvent { name?; ctrl?; sequence? }
  ```
  **`shift` 필드가 없다.** node `readline` 의 keypress 이벤트는 `key.shift` 를 채워주지만
  현재 코드가 그걸 안 읽는다.
- `Tab` 은 이미 점유돼 있다 (`raw-line-reader.ts:577-586`): 완성 메뉴 커밋 / ghost 수락 /
  메뉴 열기. **shift+tab 은 이 Tab 핸들러와 충돌하면 안 된다** (§4.2 가 분리 보장).
- 그리고 결정적 제약: `readLine()` 은 **단일 문자열을 resolve 하는 Promise**다
  (`raw-line-reader.ts:175-176`, `settleResolve(value)` `:363-369`). non-submit 키(shift+tab)
  에 대해 *호출자(REPL)로 콜백을 돌려보낼 채널이 없다.* readLine 은 "한 줄 읽고 끝"
  계약이다. → shift+tab 이 모드를 바꾸려면 이 계약에 **닫힌-포트 콜백 채널을 추가**해야
  한다 (§4.2).

### 2.6 GAP — 정리

1. `shift+tab` cycle 없음 (키 캡처조차 안 함, §2.5).
2. 입력창-인접 prominent 모드 pill 없음 (pill 은 하단 status bar 에만, `PermissionMode`
   는 아예 안 그림, §2.4).
3. `PermissionMode` mid-session 변경 불가 — getter-only (§2.2). **단** effort/identity
   처럼 turn-경계 mutable seam 선례가 있어 신규 닫힌-포트로 메울 수 있다 (§2.3).
4. `/plan` 은 토글이 아니라 표시용 (§2.2).

---

## 3. Goals / Non-goals

### Goals
- G1. canonical **ordered ModeCycle** 정의: 기존 `PermissionMode` + `AgentMode="plan"`
  을 합친 사용자-노출 cycle (새 모드 *발명 금지*; §4.1).
- G2. raw-line-reader 에 `shift+tab` keypress 훅 — Tab 완성과 비충돌, 닫힌-포트
  콜백으로 REPL 에 cycle 요청 통지 (§4.2).
- G3. **입력창 바로 위/옆**에 prominent 모드 pill 렌더 (기존 pill/ANSI 유틸 재사용; §4.3).
- G4. 모드 set 경로: effort/identity 의 `{get,set}+pill.update` 템플릿을 따른
  **turn-경계 적용** mutable seam (default-OFF; §4.4).
- G5. 전부 default-OFF ENV 게이트, flag off ⇒ byte-identical.

### Non-goals
- N1. `PermissionMode` 의 *진짜 mid-turn(턴 진행 중) 즉시* 변경 — RuntimeContext 가
  setter 를 안 가져서 큰 수술. 본 RFC 는 **turn-경계 적용**까지만 (§6 Edge `mid-turn`).
- N2. `review/audit/architect/editor` 를 cycle 에 넣는 것 — claude-cli cycle 엔 없다.
  pill 표시는 유지하되 cycle 순환 대상은 §4.1 의 4칸으로 한정.
- N3. confirm 다이얼로그 안에서의 cycle (claude-cli `confirm:cycleMode`) — 후속.
- N4. 새 도구 / 모델 호출 추가 0.

---

## 4. 설계

### 4.1 (a) Canonical ordered ModeCycle

claude-cli 의 4-posture cycle 을 quanta 의 *기존* enum 으로 매핑한다. 새 모드는 만들지
않고, 두 직교 축(`PermissionMode`, `AgentMode`)을 합친 **단일 사용자-노출 슬롯**을 둔다.

신규 파일 `src/apps/cli/mode-cycle.ts` (순수, IO 없음):

```ts
import type { PermissionMode } from "@/permission"   // types.ts:40
import type { AgentMode } from "@/agent"             // prompt.ts:110

/** 사용자-노출 cycle 의 한 칸. `agentMode` 가 set 되면 그 read-only posture 가,
 *  아니면 `permissionMode` 권한 posture 가 우세하다. 두 축을 합쳐 단일 슬롯으로
 *  노출 — claude-cli 의 default→acceptEdits→plan→bypass 와 1:1. */
export interface ModeCyclePosture {
  readonly key: "default" | "acceptEdits" | "plan" | "bypass"
  readonly permissionMode: PermissionMode      // 권한 축으로의 투영
  readonly agentMode: AgentMode                // posture 축으로의 투영
  readonly label: string                       // pill 텍스트
  readonly color: "green" | "yellow" | "magenta" | "red"  // 기존 pill 색계열
  readonly desc: string                        // 한 줄 설명 (claude-cli verbatim 차용)
}

/** 고정 순서 — claude-cli 의 cycle 순서를 그대로. wrap-around 는 인덱스 mod 4. */
export const MODE_CYCLE: readonly ModeCyclePosture[] = [
  { key: "default",     permissionMode: "default",    agentMode: "default",
    label: "DEFAULT",     color: "green",
    desc: "ask before every edit" },
  { key: "acceptEdits", permissionMode: "acceptEdits", agentMode: "default",
    label: "ACCEPT-EDITS", color: "yellow",
    desc: "edit freely, ask for commands" },
  { key: "plan",        permissionMode: "default",    agentMode: "plan",
    label: "PLAN",        color: "magenta",
    desc: "research and propose, never touch files" },
  { key: "bypass",      permissionMode: "bypass",     agentMode: "default",
    label: "BYPASS",      color: "red",
    desc: "runs without asking — dangerous" },
] as const

export const nextPosture = (cur: ModeCyclePosture["key"]): ModeCyclePosture => {
  const i = MODE_CYCLE.findIndex((p) => p.key === cur)
  // 미발견(방어) ⇒ 0; 정상 ⇒ (i+1) mod len — wrap-around 보장.
  return MODE_CYCLE[(Math.max(i, 0) + 1) % MODE_CYCLE.length]!
}
```

설계 노트:
- 순서/색/desc 는 §1 증거에서 직접 차용 (desc 는 claude-cli 의 한 줄 요지를 그대로:
  "ask before every edit" ← `148291`, "edit freely…" ← `148303`+`148290`, "research and
  propose, never touch files" ← plan read-only 계약, "runs without asking" ← `161110`).
- 색은 status-pills 의 기존 색계열을 재사용 (`status-pills.ts:45-49`): plan=yellow 였으나
  cycle 4칸 구분을 위해 magenta 로 격상(REVIEW 와 겹치지 않음 — REVIEW 는 cycle 밖). 단순
  보수안: plan=yellow 유지하고 acceptEdits=cyan. **구현 시 한 곳(MODE_CYCLE)에서만 결정.**
- `auto` 는 cycle 에서 제외 (classify 포트 없으면 ask 로 강등돼 사용자에게 default 와
  구분이 안 됨 — `types.ts:37`). claude-cli 도 auto 를 enterprise gated 로 둠. 필요 시
  5번째 칸으로 추가 가능하나 본 RFC 는 4칸.

### 4.2 (b) `shift+tab` keypress 훅 (raw-line-reader, Tab 비충돌)

두 가지를 추가한다.

**(1) `KeyEvent` 에 `shift` 캡처.** `raw-line-reader.ts:81-85`:
```ts
interface KeyEvent { readonly name?; readonly ctrl?; readonly shift?: boolean; readonly sequence? }
```
node `readline.emitKeypressEvents` (`raw-line-reader.ts:201`) 가 이미 `key.shift` 를
채운다 — 인터페이스만 넓히면 된다.

**(2) `ReadLineOptions` 에 닫힌-포트 콜백 추가** (`raw-line-reader.ts:48-72`):
```ts
/** shift+tab(모드 cycle) 같은 *비-제출* 키를 호스트에 통지하는 콜백.
 *  반환값으로 새 pill 텍스트(또는 갱신된 meta)를 받아 즉시 입력창을 repaint.
 *  Absent ⇒ shift+tab 은 완전 무시(byte-identical). */
readonly onCycleMode?: () => { meta?: string } | void
```

**(3) onKey 상태머신** — Tab 핸들러(`:577-586`) **이전**에 shift+tab 가드를 둔다:
```ts
// shift+tab: 모드 cycle. Tab 완성과 분리 — k.shift 가 true 일 때만 진입하므로
// 일반 Tab(:577) 은 절대 이 분기로 안 옴 (충돌 없음).
if (k.name === "tab" && k.shift === true) {
  if (opts.onCycleMode === undefined) return        // default-OFF: 무시
  const res = opts.onCycleMode()
  if (res && typeof res.meta === "string") opts.meta = res.meta  // meta 행 갱신
  redraw()                                          // 입력창 즉시 repaint
  return                                            // ← 버퍼/제출 영향 0
}
```
- non-submit: `settleResolve` 호출 안 함 → 현재 입력 버퍼 보존, 사용자는 타이핑 계속.
- Tab 충돌 0: 일반 Tab 은 `k.shift` 가 falsy 라 이 가드를 건너뛰고 기존 `:577` 분기로 감.
- terminfo variance 대비: 일부 터미널은 shift+tab 을 `name:"tab", shift:true` 가 아니라
  별도 시퀀스 `\x1b[Z` (CSI Z, "backtab") 로 보낸다. node readline 은 보통 이걸
  `name:"tab", shift:true` 로 정규화하지만 **방어적으로** sequence 도 본다:
  ```ts
  const isBackTab = (k.name === "tab" && k.shift === true) || k.sequence === "\x1b[Z"
  if (isBackTab) { /* 위와 동일 */ }
  ```
  (`raw-line-reader.ts` 의 `ESC` 상수는 `"\x1b["` 이므로 `${ESC}Z` 로 표기 가능.)

### 4.3 (c) 모드 pill 렌더러 — 입력창 인접

목표는 "입력창 바로 옆/위에 상시 보이는 prominent pill". 두 위치를 동시에 채운다:

1. **하단 status bar** (이미 있음): `status-pills.ts` 의 `formatMode` 를 확장해
   `PermissionMode` posture 도 그리도록 — 신규 helper `formatCyclePosture(posture)`:
   ```ts
   // status-pills.ts 에 추가. 기존 ANSI 상수(:41-49) 재사용.
   const CYCLE_COLOR = { green: FG_GREEN, yellow: FG_YELLOW, magenta: FG_MAGENTA, red: FG_RED }
   const formatCyclePosture = (p: ModeCyclePosture | undefined): string =>
     p === undefined || p.key === "default" ? "" /* default 숨김(클러터 감소) */
       : `${BOLD}${CYCLE_COLOR[p.color]}[${p.label}]${RESET}`
   ```
   `StatusPillsState` 에 `cyclePosture?: ModeCyclePosture` 추가 (`status-pills.ts:64-71`),
   `composeLine` 의 center 버킷에 push (`status-pills.ts:224-227`).
   - bypass 일 땐 항상 보이게 (`key:"default"` 만 숨김) — danger posture 는 숨기면 안 됨.

2. **입력창 meta 행** (입력창 바로 아래 한 줄, prominent): raw-line-reader 의 `meta`
   슬롯 (`raw-line-reader.ts:57`, `:278-281` 에서 dim 으로 그려짐) 에 pill+desc 를 넣는다.
   호스트가 prompt-pipeline 의 `readLine({...})` 호출(`prompt-pipeline.ts:82-89`)에 `meta`
   를 추가:
   ```ts
   meta: `${cyclePill}  ${dim(posture.desc)}`,   // "› " 입력 바로 아래
   onCycleMode: () => ({ meta: renderMeta(modeStore.advance()) }),
   ```
   이게 claude-cli 의 "입력창 옆 pill+한 줄 설명" 과 시각적으로 동등 (입력 바로 아래
   dim 행). meta 행은 이미 reserved band 안에서 그려지므로 추가 레이아웃 비용 0.

색상은 전부 기존 인라인 ANSI (`status-pills.ts:41-49` / `raw-line-reader.ts:94-98`) 재사용.
새 색 lib 도입 없음 (모듈 import-light 유지, `status-pills.ts:40` 주석 정책 준수).

### 4.4 (d) 모드 setter 경로 — turn-경계 mutable seam (닫힌-포트, default-OFF)

`PermissionMode` 는 mid-session 변경 불가(§2.2)지만, effort/identity 가 쓰는
**turn-경계 mutable store** 패턴을 그대로 복제한다.

신규 파일 `src/apps/cli/repl/mode-cycle-store.ts`:
```ts
import { MODE_CYCLE, nextPosture, type ModeCyclePosture } from "../mode-cycle"

/** effort/identity 스토어와 동형의 {get,set} 핸들 + advance().
 *  set 값은 *다음 createSession* 에서 읽힌다 (turn-경계 적용) — §2.2 의 제약을
 *  존중. mid-turn 즉시 변경은 하지 않는다(N1). */
export interface ModeCycleStore {
  get(): ModeCyclePosture
  set(key: ModeCyclePosture["key"]): void
  advance(): ModeCyclePosture   // shift+tab 1회 = 다음 칸 + set + 반환
}

export const createModeCycleStore = (initialKey: ModeCyclePosture["key"]): ModeCycleStore => {
  let cur = MODE_CYCLE.find((p) => p.key === initialKey) ?? MODE_CYCLE[0]!
  return {
    get: () => cur,
    set: (key) => { cur = MODE_CYCLE.find((p) => p.key === key) ?? cur },
    advance: () => { cur = nextPosture(cur.key); return cur },
  }
}
```

**적용 경로 (turn-경계).** session-loop 이 매 turn `createSession` 직전에 mode 를 읽는
지점이 이미 있다 (`session-loop.ts:278` `permissionMode: runtimeContext.permissionMode()`).
이 한 줄을 store 우선으로 바꾼다:
```ts
permissionMode: modeCycleStore?.get().permissionMode ?? runtimeContext.permissionMode(),
```
그리고 `AgentMode` (plan 등)도 같은 store 의 `agentMode` 를 `createSession` 인자/
turn-context 에 주입 (effort/identity 가 `session-loop.ts:279-285` 에서 spread 되는 방식과
동일하게 presence-spread). store 없으면(`modeCycleStore === undefined`) 전부 기존 경로 →
byte-identical.

**즉시-피드백 vs 적용-시점 분리.** shift+tab 누르는 *즉시* pill+meta 는 갱신(시각 피드백),
실제 권한 적용은 *다음 사용자 turn 의 createSession* 부터. claude-cli 도 진행 중인 턴엔
적용 안 하고 다음 입력부터 적용 — 동등. meta 에 "(applies next turn)" 같은 힌트는 cycle
중 turn 이 진행 중일 때만 붙인다(§6).

> ROI/비용: 신규 파일 2개(mode-cycle.ts 순수 + mode-cycle-store.ts 순수) + 기존 4파일에
> 좁은 edit. RuntimeContext 수술 없음 (getter-only 그대로 두고 store 가 우선). 비용 ~0.5d,
> 사고-위험/확인-비용 동시 감소.

---

## 5. 통합 — 정확한 edit point + ENV flag (file:line)

ENV flag: `QUANTA_MODE_CYCLE` (default-OFF). off/undefined ⇒ store 미생성 ⇒ `onCycleMode`
미전달 ⇒ shift+tab 무시 + pill 미변경 = byte-identical.

| # | 파일:line | 변경 |
|---|---|---|
| 1 | `src/apps/cli/mode-cycle.ts` (신규) | `MODE_CYCLE` / `nextPosture` / 타입 (§4.1) |
| 2 | `src/apps/cli/repl/mode-cycle-store.ts` (신규) | `createModeCycleStore` (§4.4) |
| 3 | `src/apps/cli/raw-line-reader.ts:81-85` | `KeyEvent.shift` 추가 |
| 4 | `src/apps/cli/raw-line-reader.ts:48-72` | `ReadLineOptions.onCycleMode` 추가 |
| 5 | `src/apps/cli/raw-line-reader.ts:577` 직전 | shift+tab/backtab 가드 분기 (§4.2-3) |
| 6 | `src/apps/cli/status-pills.ts:64-71,224-227` | `cyclePosture` state + `formatCyclePosture` (§4.3-1) |
| 7 | `src/apps/cli/repl/prompt-pipeline.ts:82-89` | `meta` + `onCycleMode` 를 `readLine` 에 전달 |
| 8 | `src/apps/cli/repl/session-runtime-config.ts:59` | `QUANTA_MODE_CYCLE` 읽어 initialKey 결정 |
| 9 | `src/apps/cli/repl/session-loop.ts:278` | `permissionMode` 를 store 우선으로 |
| 10 | `src/apps/cli/repl/session-loop.ts:279-285` | `agentMode` presence-spread (effort/identity 패턴) |
| 11 | (옵션) `src/apps/cli/slash/registry-surface.ts` | `/mode [key]` 슬래시 — 키 없는 환경 대체 경로 |

`prompt-pipeline.ts` 는 현재 `meta` 를 안 넘긴다 (`:82-89`) — `ComposePromptPipelineDeps`
(`prompt-pipeline.ts:34-72`) 에 `modeCycleStore?` 슬롯을 추가하고, `defaultPromptLineReader`
(`:77-95`) 에서 store 가 있을 때만 `meta`+`onCycleMode` 를 spread (없으면 기존 호출과 동일).

---

## 6. Edge cases

- **shift+tab terminfo variance.** 터미널마다 (a) `name:"tab",shift:true`, (b) backtab
  `\x1b[Z` 로 옴. §4.2(3) 의 `isBackTab` 가 둘 다 잡음. 그 외 시퀀스(예 일부 Windows
  콘솔)에서 안 잡히면 shift+tab 은 그냥 무반응(안전) — `/mode` 슬래시(table #11)가 대체
  경로.
- **non-TTY.** `stdin.isTTY !== true` 면 raw-mode 진입 자체를 안 함 (`raw-line-reader.ts:202-203`),
  status-pills 도 non-TTY no-op (`status-pills.ts:185-193`). shift+tab 경로 도달 불가 = no-op.
- **mid-turn 변경.** 사용자가 모델 응답 진행 중(턴 안)에 shift+tab — 입력창이 아니라
  readLine 이 안 돌고 있을 수 있음. readLine 밖에선 키가 안 잡힘(안전). 잡히는 경우
  (external-prompt-queue race, `prompt-pipeline.ts:210-224`)에도 store.set 은 다음
  createSession 부터 적용(§4.4) — 진행 중 턴의 권한은 안 바뀜. meta 에 "(next turn)" 힌트.
- **bypass/danger 확인.** `bypass` 칸으로 들어갈 때 claude-cli 는 명시적 경고
  (`161110`/`161114`). quanta 도 cycle 이 `bypass` 에 도달하면 meta/status 에
  `⚡ BYPASS — runs without asking` 를 red bold 로(이미 §4.1 color:"red"). 단순 cycle 로
  bypass 진입은 허용하되, 실제 적용(다음 createSession)은 사용자가 다음 prompt 를 *제출*해야
  발생 — 한 번 더 의식적 행동이 끼므로 실수 진입 방지. (강한안: bypass 진입 시 1회
  y/N 확인 `askLine`. 본 RFC 는 visual-warning 까지, 확인 게이트는 옵션.)
- **plan ↔ 기존 `/plan` 상호작용.** `/plan` 은 표시용(§2.2)이라 cycle 의 plan 칸과 충돌
  없음. cycle 이 plan 으로 가면 store.agentMode="plan" → 다음 turn read-only fence
  (`mode.ts:54`). `/plan` 은 그대로 패널만 보여줌. 둘은 직교.
- **wrap-around.** `nextPosture` 가 mod-len (§4.1) — bypass 다음은 default 로 한 바퀴.

---

## 7. 테스트 (hellgate, 주입 가능 — 실제 터미널/timer 0개)

신규 `tests/hellgate/mode-cycle-pill-hellgate.test.ts`:

1. **cycle order + wrap.** `nextPosture("default")==="acceptEdits"`,
   `"acceptEdits"→"plan"`, `"plan"→"bypass"`, `"bypass"→"default"` (wrap). 미지 키 →
   첫 칸.
2. **각 posture → enum 투영 정확.** `MODE_CYCLE` 각 칸의 `permissionMode`/`agentMode` 가
   §4.1 표와 일치 (plan 칸은 agentMode="plan", bypass 칸은 permissionMode="bypass").
3. **pill 렌더 per mode.** `formatCyclePosture` 가 default→`""`, plan→magenta `[PLAN]`,
   bypass→red `[BYPASS]`; `stripAnsi` 후 라벨 검증.
4. **shift+tab keypress advance.** `onKey(undefined, {name:"tab",shift:true})` 호출 시
   `onCycleMode` 가 정확히 1회 불리고 store 가 1칸 전진; 버퍼 미변경; `settleResolve`
   미호출(제출 안 됨). backtab `sequence:"\x1b[Z"` 도 동일.
5. **Tab 비충돌 regression.** `onKey("\t",{name:"tab"})` (shift 없음) 은 기존 완성
   동작만 하고 `onCycleMode` 0회.
6. **non-TTY no-op.** `isTTY=false` 주입 시 store/pill no-op, shift+tab 도달 시에도 변화 0.
7. **turn-경계 적용.** store.advance 후 *현재* createSession 인자엔 영향 없고, 다음
   createSession 가 새 permissionMode/agentMode 를 읽음 (session-loop 어셈블 단위 테스트).
8. **regression anchor (flag off).** `QUANTA_MODE_CYCLE` 미설정 ⇒ store undefined ⇒
   readLine 호출 인자에 `meta`/`onCycleMode` 없음 ⇒ 키 입력/pill/세션 어셈블 전부
   byte-identical (기존 prompt-pipeline 스냅샷과 동일).

모두 순수 함수 + 주입된 `onKey`/store 로 — 실제 stdin raw-mode, 실제 터미널, setInterval
0개. `raw-line-reader.ts` 의 `__*ForTest` export 관례(`:713-715`)를 따라 `onKey`/가드를
테스트 노출.

---

## 8. 파일별 변경 목록

신규:
- `src/apps/cli/mode-cycle.ts` — `MODE_CYCLE`/`nextPosture`/타입 (순수).
- `src/apps/cli/repl/mode-cycle-store.ts` — `createModeCycleStore` (순수, get/set/advance).
- `tests/hellgate/mode-cycle-pill-hellgate.test.ts` — §7.

수정 (좁은 edit, 전부 presence-gated):
- `src/apps/cli/raw-line-reader.ts` — `KeyEvent.shift`(:81), `ReadLineOptions.onCycleMode`(:48),
  shift+tab/backtab 가드(:577 직전), 테스트 export.
- `src/apps/cli/status-pills.ts` — `StatusPillsState.cyclePosture`(:64), `formatCyclePosture` +
  `composeLine` push(:224), `PILL_ENV_VARS` 에 게이트 추가(:96).
- `src/apps/cli/repl/prompt-pipeline.ts` — `ComposePromptPipelineDeps.modeCycleStore?` +
  `defaultPromptLineReader` 에서 meta/onCycleMode presence-spread.
- `src/apps/cli/repl/session-runtime-config.ts` — `QUANTA_MODE_CYCLE` → initialKey.
- `src/apps/cli/repl/session-loop.ts` — `:278` permissionMode store-우선, `:279` agentMode spread.
- (옵션) `src/apps/cli/slash/registry-surface.ts` — `/mode [key]` 슬래시.
- (옵션) `src/apps/cli/permission-explain.ts` — `/permission` 출력에 현재 cycle posture 반영.

---

## 9. 대략 공수

- mode-cycle.ts + store: ~0.5h (순수, 표 1개).
- raw-line-reader 훅(shift 캡처 + 가드 + 콜백): ~1h (Tab 비충돌 + backtab variance).
- pill 렌더(status-pills + meta 행): ~1h.
- session-loop / prompt-pipeline / runtime-config 배선: ~1.5h.
- hellgate 8 케이스: ~1.5h.
- (옵션) `/mode` 슬래시 + permission-explain: ~1h.
- 합계 ~6h (옵션 제외 ~5h). 모델 호출/새 도구 0.

---

## 10. SOTA++ 체크리스트

- [x] **경쟁사 증거 verbatim**: claude-cli `chat:cycleMode`/`shift+tab`/`set_permission_mode`
      + 4 posture desc 전부 file:line 인용 (§1).
- [x] **새 모드 발명 금지**: 기존 `PermissionMode`(`types.ts:40`) + `AgentMode`(`prompt.ts:110`)
      만 투영 (§4.1).
- [x] **mid-session 가능성 정직 평가**: `PermissionMode` getter-only ⇒ 진짜 mid-turn 불가,
      그러나 effort/identity 의 turn-경계 mutable seam 선례로 메움 (§2.2-2.3, §4.4).
- [x] **Tab 비충돌 증명**: `k.shift===true` 가드가 기존 Tab(:577)과 배타 (§4.2, §7-5).
- [x] **default-OFF byte-identical**: `QUANTA_MODE_CYCLE` off ⇒ store undefined ⇒ readLine
      인자 무변 (§5, §7-8).
- [x] **닫힌-포트 DI**: `onCycleMode` 콜백 / `ModeCycleStore {get,set,advance}` — IO 없음,
      hellgate 가 실제 터미널/timer 없이 구동 (§7).
- [x] **terminfo variance 방어**: backtab `\x1b[Z` 폴백 + `/mode` 슬래시 대체 (§6).
- [x] **danger posture 가시화**: bypass red bold + 숨김 금지 (§4.3, §6).
- [x] **slice-isolation**: status-pills 는 type-only `@/agent`/`@/permission` import 유지
      (`status-pills.ts:32-37` 정책), 신규 모듈도 동일.
- [x] **모든 quanta 주장 = file:line** (전 섹션).
```
