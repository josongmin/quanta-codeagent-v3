# RFC: 턴 완료 터미널 알림 (OSC title + bell) + 사전 compaction/limit 경고

- **Status**: Draft (implementation-ready)
- **Author**: architecture
- **Date**: 2026-06-02
- **ADR (제안)**: ADR-0436 (notify), ADR-0437 (context-warning) — `docs/decisions/`의 최신 free 번호. (현재 최신 `0434-permission-profile-list-select.md`; `01-mcp-auto-restart.md`가 0435 선점.)
- **Slice**: 둘 다 `@/apps/cli` 단일 슬라이스(신규 leaf 2개 + 기존 wire 소수 줄). agent/llm 코어 무변경.
- **Default-OFF**: 두 기능 모두 어댑터/홀더 미주입 ⇒ 오늘 동작 **byte-identical**.
- **흡수 출처**: Claude Code CLI `notifChannel` enum(`terminal_bell`/`iterm2_with_bell`/`notifications_disabled`) + "Conversation too long" 문자열; Codex `[tui].terminal_title` + `turn/completed` notification + emulator 감지 테이블. 정확한 line은 §1.

---

## 1. 배경 — 경쟁사 알림/경고 UX (흡수 대상, 증거)

### 1.1 Claude Code — notifChannel 3-값 enum + bell + "too long" 경고

전부 `/Users/songmin/quanta-codeagent-v3/.extracted_source/claude-code-cli/_cli-symbols.txt`.

- **알림 채널 enum** (`:142936`, settings UI `Local notifications` 라벨 바로 아래):
  ```
  notifChannel
  Local notifications
  terminal_bell
  iterm2_with_bell
  notifications_disabled
  ```
  즉 Claude는 사용자-설정으로 (a) BEL 문자만 (`terminal_bell`), (b) iTerm2 네이티브 알림 + bell (`iterm2_with_bell`), (c) 끔 (`notifications_disabled`) 3-모드를 노출한다. 같은 enum이 `:128449`에도 등장(`attacher_term` / `iterm2_with_bell` / `terminal_bell` / `notifications_disabled`).
- **두 가지 트리거 토글** (`:142936` 인접): `inputNeededNotifEnabled` ("Push when actions required") + `agentPushNotifEnabled` ("Push when Claude decides"). ⇒ "입력이 필요할 때"와 "에이전트가 결정할 때(턴 완료)" 두 트리거를 구분한다. 우리 §4.A의 `onIdleAwaitingInput` vs `onTurnComplete` 분리와 정확히 대응.
- **BEL 문자 상수**: `"\\x07"` (`:13717`).
- **OSC 파서**(터미널이 보내는 title query 해석용; OSC 작성 시 같은 종결자 `BEL | ST`를 씀): `^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$` (`:190796`). ⇒ Claude의 OSC 시퀀스는 `ESC ] <ps> ; <pt> (BEL | ESC\)` 형식.
- **컨텍스트 한계 경고 문구** (`:109170`): `Conversation too long. Press esc twice to go up a few messages and try again.` — 이것은 **사후**(이미 너무 길어 API가 거부) 메시지다. 본 RFC의 B는 이 사후 메시지가 뜨기 **전에** 사전 경고를 띄우는 것이 목표("Press esc twice" affordance는 우리의 rewind와 동치 → §4.B에서 재사용).

### 1.2 Codex — 구성형 terminal_title + turn/completed notification + emulator 감지

전부 `/Users/songmin/quanta-codeagent-v3/.extracted_source/codex/_codex-rs-0.135-symbols.txt`.

- **터미널 타이틀 기능 전체**(`[tui].terminal_title` config) — `:2944`~`:2950`:
  ```
  terminal title source:
  terminal title items:
  terminal title activity:
  terminal title invalid items:
  terminal title project source:
  terminal title project value:
  ```
  Codex는 타이틀을 **구성 가능한 item 목록**(activity/project source/project value 조합)으로 빌드한다. `known terminal title item identifiers` + `terminal title configuration contains unknown item identifiers` 유효성 검사(`:47847`)까지 있다. 우리는 1차에서 이 풀 config DSL은 흡수하지 않고(아래 non-goal) **고정 포맷 1개**만 흡수한다.
- **터미널 에뮬레이터 감지 테이블** (`:47839`): `Apple Terminal / Ghostty / iTerm2 / VS Code / WezTerm / kitty / Alacritty / Konsole / GNOME Terminal / VTE`. ⇒ OSC title/notify 지원 여부 판정에 에뮬레이터 식별을 쓴다. 우리는 1차에서 TTY 게이트 + `TERM`/`TERM_PROGRAM` 기반의 **보수적 allow**만 적용(§6).
- **turn 완료 notification**: app-server protocol `turn/completed` (`:4855` `"method": "turn/completed"`, `:5379` `< turn/completed notification:`). ⇒ "턴이 끝났다"는 신호가 1급 이벤트로 존재.
- **legacy notify 훅**: `hooks/src/legacy_notify.rs` (`:7101`) — 외부 notify 커맨드를 실행하는 훅.
- **OSC 작성 실증**: `failed to write OSC 52 to /dev/tty` 등(`:8602`~`:8629`) — Codex가 OSC 시퀀스를 `/dev/tty`에 직접 write하는 패턴(clipboard용 OSC 52). title은 OSC 0/2지만 동일한 write 메커니즘.

### 1.3 왜 중요한가 (DX)

- **A (완료 알림)**: 긴 턴(빌드/대량 grep/서브에이전트) 동안 사용자는 다른 창으로 전환한다. 터미널 **탭 타이틀**이 `✓ quanta — done`으로 바뀌고 BEL이 울리면, 사용자가 quanta로 돌아올 타이밍을 능동적으로 알 수 있다. multitask DX의 핵심. Claude/Codex 둘 다 채택.
- **B (사전 경고)**: 오늘 compaction은 **조용히** 발동한다(§2.3). 사용자는 어느 순간 컨텍스트가 요약됐다는 걸 사후(turn-summary 박스)에만 안다. compaction 직전에 "context 86% — /compact 또는 esc esc"를 입력줄 근처에 띄우면, 사용자가 (a) 미리 수동 `/compact`로 통제하거나 (b) rewind로 메시지를 줄이거나 (c) 그냥 계속할지 **선택**할 수 있다. Claude의 "Conversation too long" 사후 메시지는 이미 늦었다 — 우리는 사전을 노린다.

---

## 2. 현재 quanta 동작

### 2.1 턴 라이프사이클 — 완료 지점은 명확히 존재(콜백), 그러나 알림 없음

- **인터랙티브 루프**: `src/apps/cli/repl/session-loop.ts:538` `runInteractiveBranch`는 `while`로 `promptSource.next()`(`:540`) → `runOneTurn(...)`(`:543`)를 돈다.
- **턴 완료 콜백**: `runOneTurn`의 `onAfterResult`(`session-loop.ts:561`)가 **턴 1개가 성공적으로 끝난 직후**(result 확정) 호출된다 — 여기서 `renderTurnDashboard` / `renderAndResetSummary` / `flushLifecyclePills`(`:563-565`)가 이미 발화한다. **이것이 feature A의 정확한 wire 지점**.
- **턴 wall-clock**: `runOneTurn`은 `startMs = Date.now()`(`turn-runner.ts:113`) → `durationMs: Date.now() - startMs`(`:138`)를 `RunOneTurnResult.durationMs`로 반환. **"느린 턴만 알림"의 타이밍 소스가 이미 있다** — 새 측정 불필요.
- **idle 신호도 이미 존재**: `createIdleMonitor`(`idle-monitor.ts:118`)는 `isIdle()`(`:137`, `now() - lastActive >= idleMs`, default 60s `:36`)를 제공하고, 이미 prompt 파이프라인에 주입돼 있다(`session-loop.ts:502` → `prompt-pipeline.ts:54`). "에이전트가 입력 대기 중 idle"은 이 monitor가 정확히 표현한다 — **feature A는 이 monitor를 재사용**(새 idle 감지 만들지 않음).

### 2.2 OSC / 터미널 타이틀 / bell — 오늘 **전혀 없음**

```
grep -rn $'\x1b\]' src/apps  →  (0건)
grep -rn ']0;|]2;|\x07|setTitle|process.title' src/apps  →  (0건)
```
오늘 quanta는 **어떤 OSC title도, 어떤 bell도 쓰지 않는다.** `status-bar.ts`/`status-flash-config.ts`는 DECSTBM scroll-region + transient row만 다루지(`status-bar.ts:154` `transient`) 윈도우 타이틀은 건드리지 않는다. ⇒ feature A는 완전 신규 표면(충돌 0).

TTY/지원 판정 idiom은 이미 있다: `isStatusBarSupported(env, stderrIsTTY)`(`status-bar.ts:46`)가 `stderrIsTTY !== true` / `TERM=dumb` / `QUANTA_STATUSBAR=0`를 게이트한다. notify도 동일 형태의 순수 함수 게이트를 쓴다(§4.A).

### 2.3 compaction 트리거 — threshold는 알 수 있고, pre-compact 훅은 **이미 존재**

- **트리거**: `compactIfNeeded`(`compaction.ts:386`). `threshold = resolveThreshold(input.thresholdTokens)`(`:387`, default `DEFAULT_THRESHOLD = 120_000` `:26`, env override `runtimeConfig().compactTokens` `:92`), `currentTokens = estimateTokens(input.messages)`(`:389`, `Math.ceil(chars/4)` `:30-38`). `currentTokens <= threshold` ⇒ no-op(`:390`). **즉 "곧 compact 된다"는 `currentTokens / threshold`로 정확히 알 수 있다 — 새 휴리스틱 불필요.**
- **pre-compact 훅 — 존재함 (정직 보고)**: 두 종류가 이미 배선돼 있다.
  1. **ADR-0133 `preCompactHook`** (`compaction.ts:218`, `:407` 발화): `{messagesToCompact, isFirstCompaction} → {abortReason}`. threshold+boundary 통과 직후, preflight보다 먼저 발화. agent 쪽 빌더는 `loop-helpers.ts:145` `buildPreCompactHook(hooks)`가 `HookBus`의 `pre_compact` 이벤트로 브리지.
  2. **ADR-0075 `onPreCompact`** (`types.ts:203` `AgentConfig.onPreCompact`, `loop.ts:805` `const onPreCompact = config.onPreCompact`, `loop.ts:892` preflight로 wire): HITL 콜백 `OnPreCompactCallback`(`types/compaction-config.ts:133`) — `PreCompactRequestQuery → "approve"|"defer_one_turn"|"force_now"`(`:64`). `compaction.ts:422` `input.preflight` 자리에 들어간다.

  ⇒ **B는 새 훅을 만들 필요가 없다.** 기존 `onPreCompact`/`preCompactHook` 중 하나에 **read-only 관찰자**를 끼우거나(발동 순간 경고를 띄움), 또는 더 단순하게 **턴마다 같은 토큰 카운트로 사전 비율을 계산**(아래 §4.B는 사전 경고가 목표이므로 *발동 전* 비율 접근을 선호).
- **context-% 계산은 이미 단일 소스**: `buildUsageBreakdown(input, estimate)`(`usage-breakdown.ts:134`)는 **agent loop와 동일한 `estimateTokens`를 주입**받고(`:30` import, `:78` `TokenEstimator` 주입, `:183` `buildUsageBreakdownDefault`가 진짜 estimator 바인딩), `breakdownPercent(b)`(`:172`)가 `Math.round(total/max*100)`를 준다. REPL은 이미 per-turn 스냅샷을 보관한다: `createContextUsageHolder()`(`repl/context-usage-snapshot.ts:39`)의 `sink`가 `onPromptAssembled`에 wire, `view()`가 `/context`에 wire. **B는 이 홀더의 같은 카운트를 재사용** — 새 토큰 휴리스틱 0.
- **렌더러**: `formatContextUsage(used, max, model)`(`status-line.ts:72`)가 한 줄 바를 만든다. 경고 줄은 이 카운트를 재사용하되 짧은 한 줄로(§4.B).

### 2.4 입력줄 렌더 지점 (경고를 붙일 곳)

- prompt 문자열은 `prompt-pipeline.ts:83` `prompt: "› "`로 readline에 넘어간다.
- **preamble 패턴이 이미 있다**: `prompt-pipeline.ts:169` `renderInboxPreamble(inboxEntries)`가 prompt **앞에** 한 블록을 stderr로 쓴다(text-inbox 미리보기). 컨텍스트 경고도 동일하게 "prompt 직전 1줄 preamble"로 붙인다 — 새 렌더 경로 불필요.
- snooze transient 예시: `prompt-pipeline.ts:250` `statusBar.transient("⏸ snoozed …", 4000)`. 경고를 transient로 띄울 수도 있으나, 사라지면 안 되는 정보라 **preamble 한 줄**이 더 적합(§4.B).

### 2.5 Gap 요약

| Gap | 현재 | 본 RFC |
|---|---|---|
| 긴 턴 완료 시 터미널 타이틀/bell 알림 | **없음**(§2.2) | A: `NotificationPort` + OSC/bell 어댑터, 느린-턴/idle만, default-OFF |
| compaction 발동 전 사전 경고 | **없음** — 조용히 발동(§2.3) | B: 같은 토큰 카운트로 사전 비율 → prompt preamble 1줄, default-OFF |

---

## 3. Goals / Non-goals

### Goals
- **A**: 긴 턴이 끝나거나(입력 필요) 에이전트가 idle로 입력 대기에 들어가면, **터미널 윈도우 타이틀**(OSC 0/2)을 갱신하고 **선택적 BEL**을 울린다. (Claude `terminal_bell`/`iterm2_with_bell` 흡수.)
- **A**: **느린 턴에만** 알림 — `runOneTurn`이 이미 측정하는 `durationMs`(§2.1)를 임계와 비교. 빠른 턴(<임계)은 알림 안 함(spam 방지). idle 경로는 idle-monitor의 기존 타이밍 재사용.
- **A**: TTY가 아니면(파이프/리다이렉트/CI) **OSC/bell 둘 다 0건**. 종료 시 타이틀 **복원**.
- **B**: compaction threshold를 **넘기기 직전**, `currentTokens / threshold` 비율(또는 `total/max`)이 경고 임계(default 80%)를 넘으면 prompt preamble에 **한 줄** 경고. compaction이 조용히 발동하기 전에 사용자가 보게 한다.
- **B**: 경고는 **agent loop와 동일한 토큰 카운트**만 사용(§2.3 `estimateTokens` / `buildUsageBreakdownDefault`). **새 토큰 휴리스틱 금지**.
- **B**: rewind affordance 재사용 — "esc esc"(Claude 문구) 제안은 우리 `/rewind`(`rewind-cmd.ts`)와 동치로 안내.
- 둘 다 **Default-OFF byte-identical**: 어댑터/홀더 미주입 ⇒ 오늘 출력과 완전 동일. 신규 테스트로 봉인.
- 둘 다 **순수 DI**: clock/writer/env 주입, 실제 타이머/`process.stdout` write는 wire 지점에서만.

### Non-goals
- **Codex의 풀 `[tui].terminal_title` config DSL**(item 목록/유효성/project source) ❌ — 1차는 **고정 포맷 1개**(`{state} {cwdBasename} — {summary}`). 흡수 출처는 §1.2지만 config DSL은 후속.
- **iTerm2 네이티브 OSC 9 / OSC 1337 푸시 알림**(Claude `iterm2_with_bell`의 "iTerm2" 절반) ❌ 1차 — 1차는 **타이틀(OSC 0/2) + BEL**만. OSC 9 알림은 §8 후속(어댑터 추가만으로 확장 가능하게 포트 설계).
- **에뮬레이터별 감지 테이블 전체**(Codex 10종) ❌ — 1차는 TTY + `TERM != dumb` + `TERM_PROGRAM` 기반 보수적 allow. (오작동 시 화면에 raw escape가 보이는 게 최악이므로 보수적.)
- **OS-레벨 데스크톱 알림**(node-notifier / terminal-notifier 외부 바이너리, Codex `legacy_notify.rs`류) ❌ 1차 — 외부 의존/권한 문제. 포트는 어댑터 추가로 확장 가능.
- **B의 자동 compaction 정책 변경** ❌ — B는 순수 **read-only 관찰/경고**다. threshold/keepTurns/발동 조건을 일절 바꾸지 않는다(§2.3 `compactIfNeeded` 본체 무변경).
- **B의 사후 PTL 경로**("Conversation too long" 재현) ❌ — quanta는 이미 reactive compaction이 있다(`compaction.ts:265` `REACTIVE_KEEP_TURNS`). B는 사전만 담당.

---

## 4. 설계

### 4.A 완료 알림 — `NotificationPort` (closed-port)

신규 leaf: `src/apps/cli/notify/`.

```ts
// src/apps/cli/notify/port.ts
/** 표면 알림의 의미적 이벤트. 어댑터가 OSC/bell/네이티브로 변환한다.
 *  Claude inputNeededNotifEnabled vs agentPushNotifEnabled 분리를 반영. */
export interface NotificationPort {
  /** 긴 턴이 성공적으로 끝남. `durationMs`로 "느린 턴만" 게이트(어댑터 책임). */
  onTurnComplete(info: TurnCompleteInfo): void
  /** 에이전트가 입력 대기 idle로 진입(사용자 액션 필요). Claude inputNeededNotif. */
  onIdleAwaitingInput(info: IdleInfo): void
  /** 세션 종료/teardown — 타이틀 복원 등. 멱등. */
  dispose(): void
}

export interface TurnCompleteInfo {
  readonly durationMs: number        // runOneTurn이 이미 측정(turn-runner.ts:138)
  readonly ok: boolean               // result !== undefined && !turnAborted
  readonly cwdBasename: string       // 타이틀에 쓸 짧은 라벨
  readonly summary?: string          // 선택: "3 tools · 12.3k tok" 등(turn-summary 재사용 가능)
}
export interface IdleInfo { readonly cwdBasename: string }
```

`NotificationPort`는 **표면 위 의미 이벤트만** 안다 — escape 시퀀스를 모른다(DIP). 기본 어댑터가 OSC/bell로 번역한다.

#### 4.A.1 기본 어댑터 — OSC title + 선택 bell

```ts
// src/apps/cli/notify/osc-adapter.ts
export interface OscNotifyDeps {
  /** /dev/tty 또는 process.stdout에 raw write. 주입(테스트는 버퍼 수집). */
  readonly write: (s: string) => void
  /** Claude notifChannel 흡수: "terminal_bell" | "iterm2_with_bell" | "off".
   *  1차는 bell 여부만 구분(iterm2 native는 §8). */
  readonly channel: "bell" | "title_only" | "off"
  /** "느린 턴만 알림" 임계. default 10_000ms. durationMs < 이 값이면 onTurnComplete 무시. */
  readonly slowTurnThresholdMs: number
  /** 백그라운드일 때만 알릴지(가능하면). 1차: 항상 알리되 slow-gate로 spam 억제.
   *  포커스 감지는 비표준이라 비활성(§6). */
  readonly now?: () => number
}

const BEL = "\x07"                                  // Claude :13717
const oscTitle = (title: string): string =>          // Claude OSC 형식 :190796
  `\x1b]0;${sanitizeTitle(title)}${BEL}`             // ESC ] 0 ; <pt> BEL

// sanitizeTitle: 제어문자 제거(특히 BEL/ESC 자체) — title injection 방지.
```

- `onTurnComplete`: `durationMs < slowTurnThresholdMs`면 **즉시 return**(빠른 턴 spam 방지). 아니면 `write(oscTitle(\`${ok ? "✓" : "✗"} ${cwdBasename} — done\`))` + `channel==="bell"`이면 `write(BEL)`.
- `onIdleAwaitingInput`: `write(oscTitle(\`… ${cwdBasename} — waiting\`))` + (옵션) bell. idle은 이미 "오래 기다림"이 전제라 slow-gate 불필요.
- `dispose`: **타이틀 복원** — 시작 시 `write(oscTitle(cwdBasename))`(중립)으로 세팅했던 것을 그대로 두거나, 빈 타이틀 OSC로 reset. 멀티플렉서 안전을 위해 빈 문자열보다 `cwdBasename`로 복원(§6).

#### 4.A.2 게이트 (순수 함수, status-bar idiom 그대로)

```ts
// src/apps/cli/notify/notify-enabled.ts
/** isStatusBarSupported(status-bar.ts:46) 패턴 복제.
 *  - stdout/stderr 비-TTY ⇒ false (OSC 절대 안 씀)
 *  - TERM=dumb ⇒ false
 *  - QUANTA_NOTIFY 미설정 ⇒ false (DEFAULT-OFF — A는 opt-in)
 *  - QUANTA_NOTIFY=bell|title|0/off 로 채널 선택 */
export const resolveNotifyChannel = (
  env: NodeJS.ProcessEnv, isTTY: boolean | undefined,
): "bell" | "title_only" | "off" => { … }
```

> **A는 default-OFF (opt-in)**: 타이틀 변경은 사용자 환경(탭 이름, 멀티플렉서)에 보이는 부작용이라 spinner(default-ON)와 달리 명시 opt-in이 안전하다. `QUANTA_NOTIFY` 미설정 ⇒ 포트 미구성 ⇒ wire 무발화 ⇒ byte-identical.

### 4.B 사전 compaction/limit 경고 — read-only predicate + preamble

신규 leaf: `src/apps/cli/context-warning.ts`.

#### 4.B.1 핵심 — 새 토큰 카운트를 만들지 않는다

B는 **이미 보관 중인** per-turn 스냅샷의 카운트만 읽는다:
- `ContextUsageHolder.view()`(`context-usage-snapshot.ts:45`) → `SegmentedUsageView { total, max, … }` (내부적으로 `buildUsageBreakdownDefault` = loop의 `estimateTokens`).
- 비율 = `total / max` (또는 compaction 관점이면 `total / compactThreshold`). 둘 다 **agent와 동일 산식**.

```ts
// src/apps/cli/context-warning.ts
export interface ContextWarningView {
  readonly usedTokens: number    // holder.view().total (loop estimator)
  readonly max: number           // holder.view().max (모델 윈도우)
  readonly compactThreshold: number  // resolveThreshold 동치(=runtimeConfig().compactTokens ?? 120_000)
}

export interface ContextWarningOpts {
  /** 경고를 띄울 비율(컨텍스트 윈도우 대비). default 0.8. */
  readonly windowWarnRatio?: number
  /** compaction 임박 비율(compactThreshold 대비). default 0.9. */
  readonly compactWarnRatio?: number
}

/** 순수 함수: 경고 줄(또는 "")을 만든다. holder가 비어있으면 "". */
export const renderContextWarning = (
  v: ContextWarningView | undefined, opts: ContextWarningOpts = {},
): string => {
  if (v === undefined || !(v.max > 0)) return ""
  const winPct = Math.round((v.usedTokens / v.max) * 100)
  const compactPct = v.compactThreshold > 0
    ? Math.round((v.usedTokens / v.compactThreshold) * 100) : 0
  const winWarn = winPct >= (opts.windowWarnRatio ?? 0.8) * 100
  const compactWarn = compactPct >= (opts.compactWarnRatio ?? 0.9) * 100
  if (!winWarn && !compactWarn) return ""
  // 임박이 더 시급 → compaction 메시지 우선. "esc esc"는 우리 /rewind 동치.
  const head = compactWarn
    ? `context ${compactPct}% of compaction limit — 곧 자동 요약됩니다`
    : `context ${winPct}% — 윈도우가 차고 있습니다`
  return `⚠ ${head} · /compact 로 지금 요약 또는 esc esc(/rewind)로 메시지 줄이기`
}
```

- **"esc esc" = Claude 문구**(§1.1 `:109170`). quanta에서 그 동작은 `/rewind`(`rewind-cmd.ts:2`, Claude v1.7196 패턴). 경고는 둘 다 안내(키 + 슬래시).
- `windowWarnRatio`(윈도우 대비)와 `compactWarnRatio`(compaction threshold 대비)는 **둘 다 같은 `usedTokens`** 위에서 계산 — 별개 측정 없음.

#### 4.B.2 발화 지점 — prompt preamble (inbox preamble idiom)

prompt 직전(다음 턴 입력을 기다리기 직전)에 `renderContextWarning`을 1줄 stderr로 쓴다 — `renderInboxPreamble`(`prompt-pipeline.ts:169`)와 동일한 "prompt 앞 preamble" 자리. compaction이 다음 턴 top-of-turn에 발동하므로, **그 직전 prompt에서 경고**가 가장 자연스럽다(사용자가 입력 전에 본다).

> **왜 onPreCompact 관찰자가 아니라 사전 predicate인가**: onPreCompact 훅(§2.3)은 compaction이 **이미 발동한 순간**(threshold 초과 후) 발화한다 — 그 시점엔 이미 늦었고, B의 목적은 "발동 전 사용자에게 선택권". 따라서 B는 발동-전 prompt에서 같은 카운트로 사전 비율을 계산한다. (단, 시작 시점에 이미 초과면 §6 edge로 첫 prompt에서 즉시 경고.) onPreCompact는 직교하게 그대로 둔다.

---

## 5. `runOneTurn` / session-loop 최소 변경

### A wire (session-loop.ts:561 `onAfterResult`)

`RunOneTurnDeps`에 optional `notify?: NotificationPort` 추가(turn-runner.ts:44 deps bag). `onAfterResult`(`session-loop.ts:561`)에서 마지막에 1줄:

```ts
notify?.onTurnComplete({
  durationMs: out.durationMs,        // 이미 RunOneTurnResult로 반환(turn-runner.ts:138)
  ok: out.result !== undefined && !out.turnAborted,
  cwdBasename, summary,
})
```
실제로는 `runOneTurn` 반환 후(`session-loop.ts:575` 이후, `:576` `process.stderr.write("\n")` 인접)가 `durationMs`/`turnAborted`에 접근 가능하므로 그 자리에 둔다. **`notify` 미주입 ⇒ no-op ⇒ byte-identical.**

idle 경로: `prompt-pipeline.ts`가 `idleMonitor.isIdle()`로 idle을 감지하는 자리(snooze/idle gate, `prompt-pipeline.ts:247-250` 인접)에서 idle 진입을 한 번 `notify?.onIdleAwaitingInput(...)`로 통지. (1회성 latch — idle 동안 매 tick 알리지 않음, §6.)

### B wire (prompt preamble)

`composePromptPipeline`(`session-loop.ts:497` 호출, `prompt-pipeline.ts:34` deps)에 optional `contextWarning?: () => string` 추가. `next()`가 prompt를 띄우기 직전, `renderInboxPreamble` 호출(`prompt-pipeline.ts:169`) 근처에서:

```ts
const warn = contextWarning?.() ?? ""
if (warn !== "") process.stderr.write(`${warn}\n`)
```
`contextWarning`는 composition root에서 `() => renderContextWarning(holder.view() ? toWarningView(...) : undefined, opts)`로 바인딩(holder는 §2.3 이미 존재). **미주입 ⇒ no-op ⇒ byte-identical.**

---

## 6. Edge cases

| 케이스 | 처리 |
|---|---|
| **비-TTY (파이프/리다이렉트/CI)** | `resolveNotifyChannel`가 `isTTY !== true` ⇒ `"off"` ⇒ 포트 미구성. OSC 1바이트도 안 나감. (eval/bench byte-identical.) B의 preamble도 stderr지만, 경고 자체는 TTY 게이트 뒤에서만 wire(composition root에서 isTTY 확인). |
| **알림 spam (빠른 연속 턴)** | OSC 어댑터의 `slowTurnThresholdMs`(default 10s) — 빠른 턴은 `onTurnComplete` 즉시 return. idle은 진입 1회만(latch) 통지. bell은 onTurnComplete의 slow-gate를 통과한 경우에만. |
| **종료 시 타이틀 복원** | `notify.dispose()`를 session-loop `finally`(`session-loop.ts:584` 이후)의 closeStack에 등록. `dispose`는 `oscTitle(cwdBasename)`(중립 타이틀)로 복원 — 빈 타이틀 reset은 일부 멀티플렉서에서 "탭 이름 사라짐"으로 보이므로 cwd로 복원. 멱등. |
| **경고 깜빡임(flicker)** | B는 transient가 아니라 **prompt preamble 1줄**(사라지지 않음, §2.4). 매 prompt마다 한 번 평가 — 비율이 임계 아래로 내려가면(rewind/compact 후) 자동으로 "" 반환 ⇒ 다음 prompt엔 안 뜸. 같은 비율이 유지되면 매 prompt에 같은 1줄(깜빡임 아님, 정상). |
| **시작 시 이미 임계 초과** (resume된 긴 세션) | holder가 첫 turn 전이면 `view()===undefined` ⇒ `renderContextWarning(undefined)===""`(경고 없음, 데이터 없으니 안전). 첫 turn 후 snapshot이 생기면 다음 prompt부터 경고. (resume 직후 즉시 경고가 필요하면 §8 후속: resume 시 초기 snapshot 주입.) |
| **멀티플렉서 (tmux/screen) title passthrough** | tmux는 OSC 0/2를 기본으로 가로채고 pane title로 흡수하거나 `set-titles on`일 때만 외부 터미널로 전달. screen도 유사. 1차는 **표준 OSC 0(`ESC ] 0 ; … BEL`)만** 송신 — tmux/screen이 자체 처리하게 둠(우리가 DCS passthrough 래핑은 안 함; §8 후속). `TERM`이 `screen*`/`tmux*`여도 OSC 0은 안전(최악: pane title만 바뀜, raw escape 노출 없음). bell은 멀티플렉서가 그대로 전달. |
| **title injection** | `cwdBasename`/`summary`에 BEL/ESC가 섞이면 OSC 조기 종결 → escape 주입. `sanitizeTitle`이 `\x00-\x1f`/`\x7f` 제거(Claude `O05` 제어문자 regex `_cli-symbols :…` 동류). |
| **느린 turn 임계 vs idle 임계 중복** | onTurnComplete(slow-gate 10s) ↔ onIdleAwaitingInput(idle-monitor 60s)는 다른 이벤트. 빠른 턴 후 60s idle ⇒ idle 알림만. 느린 턴 직후 ⇒ 완료 알림(slow). 둘 다 안 겹치게 latch. |

---

## 7. 테스트 계획 (hellgate, 주입 writer/clock — 실제 터미널 0개)

신규: `src/apps/cli/notify/__tests__/osc-adapter.hellgate.test.ts`, `notify-enabled.hellgate.test.ts`, `src/apps/cli/__tests__/context-warning.hellgate.test.ts`.

writer는 버퍼로 주입(`const out:string[]=[]; write:(s)=>out.push(s)`), clock 주입.

### A
1. **느린 턴만 OSC 발화**: `slowTurnThresholdMs=10_000`. `onTurnComplete({durationMs:500,…})` ⇒ `out`에 0건. `onTurnComplete({durationMs:15_000,…})` ⇒ `out[0]`가 `\x1b]0;✓ <cwd> — done\x07`와 정확히 일치.
2. **bell 채널 vs title_only**: `channel:"bell"` ⇒ OSC 뒤에 별도 `\x07` 1건 추가. `channel:"title_only"` ⇒ BEL은 OSC 종결자에만(별도 bell 없음). `channel:"off"` ⇒ 어댑터 미구성(포트 자체 없음).
3. **비-TTY 억제**: `resolveNotifyChannel(env, false)===="off"`. `QUANTA_NOTIFY` 미설정 + TTY ⇒ `"off"`(default-OFF opt-in). `QUANTA_NOTIFY=bell` + TTY ⇒ `"bell"`. `TERM=dumb` ⇒ `"off"`.
4. **타이틀 복원 on dispose**: `dispose()` ⇒ `out` 마지막이 `\x1b]0;<cwd>\x07`(중립 복원). 멱등(2회 호출 시 추가 1건 이하/동일).
5. **idle 1회 latch**: `onIdleAwaitingInput` 연속 3회 ⇒ OSC 1건만(중복 억제). 새 turn(markActive 동치)으로 latch reset 후 재진입 ⇒ 다시 1건.
6. **title injection 방어**: `cwdBasename:"a\x07evil\x1b]0;x"` ⇒ 송신된 OSC에 raw BEL/ESC 없음(제어문자 strip), 단일 종결 BEL만.

### B
7. **임계에서 발화**: `renderContextWarning({usedTokens:96_000,max:120_000,compactThreshold:120_000}, {})` ⇒ winPct 80 → 윈도우 경고 문자열 비어있지 않음. compactPct 80(<90) ⇒ compaction 문구 아님. `usedTokens:110_000` ⇒ compactPct 91 ⇒ compaction-우선 문구 + "esc esc(/rewind)" 포함.
8. **임계 미만 ⇒ ""**: `usedTokens:50_000,max:120_000` ⇒ `""`(깜빡임/소음 없음).
9. **진짜 토큰 카운트 재사용 증명**: holder를 `buildUsageBreakdownDefault`(loop estimator)로 채운 fixture로 `view().total`을 얻고, **같은 메시지로 `estimateTokens`를 직접 호출한 값과 일치**함을 단언 — B가 별도 휴리스틱을 쓰지 않음을 봉인.
10. **max<=0 / holder 빈 경우 graceful**: `view()===undefined` ⇒ `""`. `max:0` ⇒ `""`(NaN/Infinity 없음).

### 회귀 앵커 (둘 다)
11. **DEFAULT-OFF byte-identical**: `notify` 미주입 + `contextWarning` 미주입으로 `runOneTurn`/`composePromptPipeline`을 돌리면 prompt 출력/turn-summary/dashboard가 §2와 **완전 동일**(snapshot). `QUANTA_NOTIFY` 미설정 시 OSC 0건, preamble 0줄.

---

## 8. 파일별 변경

### 신규
| 파일 | 내용 |
|---|---|
| `src/apps/cli/notify/port.ts` | `NotificationPort`, `TurnCompleteInfo`, `IdleInfo` |
| `src/apps/cli/notify/osc-adapter.ts` | OSC title + BEL 어댑터, `sanitizeTitle`, slow-gate, idle latch |
| `src/apps/cli/notify/notify-enabled.ts` | `resolveNotifyChannel` (status-bar 게이트 idiom) |
| `src/apps/cli/notify/index.ts` | leaf barrel |
| `src/apps/cli/context-warning.ts` | `renderContextWarning`, `ContextWarningView/Opts`, `toWarningView` |
| `src/apps/cli/notify/__tests__/osc-adapter.hellgate.test.ts` | §7 A 1–6 |
| `src/apps/cli/notify/__tests__/notify-enabled.hellgate.test.ts` | §7 A3 |
| `src/apps/cli/__tests__/context-warning.hellgate.test.ts` | §7 B 7–11 |
| `docs/decisions/0436-completion-notify-osc-bell.md` | ADR (A) |
| `docs/decisions/0437-pre-compaction-context-warning.md` | ADR (B) |

### 편집
| 파일 | 변경 |
|---|---|
| `src/apps/cli/repl/turn-runner.ts` | `RunOneTurnDeps`에 optional `notify?` (deps bag, `:44`). 미주입 no-op. (또는 wire는 session-loop에서만 하고 turn-runner 무변경 — 선호: §5처럼 session-loop `:575` 이후에서 호출, turn-runner 무변경으로 surface 최소화.) |
| `src/apps/cli/repl/session-loop.ts` | (A) `onAfterResult`/턴 종료 직후(`:561`/`:575`)에서 `notify?.onTurnComplete(...)`. (B) `composePromptPipeline` 호출(`:497`)에 `contextWarning` 전달. `closeStack`에 `notify.dispose` 등록(`:584` 인접). |
| `src/apps/cli/repl/prompt-pipeline.ts` | (A) idle 진입 자리(`:247-250` 인접)에서 `notify?.onIdleAwaitingInput(...)` 1회 latch. (B) prompt 직전(`:169` `renderInboxPreamble` 인접)에서 `contextWarning?.()` 1줄 write. 둘 다 deps optional. |
| `src/apps/cli/repl.ts` 또는 composition root (`repl/session-setup.ts`) | `QUANTA_NOTIFY` → `resolveNotifyChannel` → OSC 어댑터 구성; 기존 `createContextUsageHolder()`(`context-usage-snapshot.ts`)를 `() => renderContextWarning(toWarningView(holder.view()), opts)`로 바인딩. 미설정 ⇒ 둘 다 undefined. |

### slice fence
- `@/apps/cli/notify`는 **표면 전용** — `@/agent`/`@/llm`/`@/stream` import 금지(turn-indicator/lifecycle-pills 슬라이스 규칙 그대로, `turn-indicator.ts:21-23` 주석). OSC 문자열만 다룬다.
- `context-warning.ts`는 `SegmentedUsageView`(같은 슬라이스 `status-line.ts`) 구조만 소비 — `@/agent` 직접 import 없음(holder가 이미 변환). `context-usage-snapshot.ts`(`@/agent/context/usage-breakdown` import는 holder가 이미 함)와 동일한 경계.

---

## 9. 대략 공수
- `notify/port.ts` + `osc-adapter.ts` + `notify-enabled.ts` + hellgate: 0.75d (순수 문자열/게이트, Claude/Codex 직접 흡수).
- `context-warning.ts` + hellgate (특히 §7-9 "진짜 카운트 재사용" 봉인): 0.5d.
- session-loop / prompt-pipeline wire + default-OFF 회귀 + dispose 복원: 0.5d.
- ADR ×2 + catalog row: 0.25d.
- **합계 ~2d** (1 worktree-isolated agent, hellgate-first TDD).

---

## 10. SOTA++ 체크리스트
- [x] closed-port (`NotificationPort` — escape를 모름; `OscNotifyDeps.write`/`now` 주입; `ContextWarningView` 주입)
- [x] no globals — writer/clock/env 주입, 실제 `process.stdout`/`/dev/tty` write·title 부작용은 composition root에서만
- [x] default-OFF byte-identical (§5 미주입 no-op, `QUANTA_NOTIFY` 미설정 opt-in, §7-11 회귀)
- [x] **새 토큰 휴리스틱 0** — B는 `buildUsageBreakdownDefault`(=loop `estimateTokens`)의 기존 카운트만 재사용(§2.3, §4.B.1, §7-9 봉인)
- [x] 기존 신호 재사용 — A는 `runOneTurn.durationMs`(`turn-runner.ts:138`) + `idle-monitor`(`idle-monitor.ts:137`), B는 `ContextUsageHolder`(`context-usage-snapshot.ts:45`) + compaction threshold(`compaction.ts:387`)
- [x] 경쟁사 정확 흡수 — Claude `notifChannel`(bell/iterm2/off, `:142936`), `\x07`(`:13717`), OSC 형식(`:190796`), "esc twice" 문구(`:109170`); Codex `terminal_title`(`:2944`)/`turn/completed`(`:4855`)
- [x] slice-fenced `@/apps/cli` — notify는 표면 전용 import만(turn-indicator 규칙)
- [x] non-TTY/멀티플렉서/injection edge 명시 처리(§6) + 타이틀 복원 보장
- [x] B는 compaction 정책 read-only(threshold/keepTurns 무변경; `compactIfNeeded` 본체 무수정)
