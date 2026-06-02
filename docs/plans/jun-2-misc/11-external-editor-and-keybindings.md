# RFC: 외부 `$EDITOR` 작성(ctrl-x ctrl-e) + 사용자 정의 keybinding 레이어

- **Status**: Draft (implementation-ready)
- **Author**: architecture
- **Date**: 2026-06-02
- **ADR (제안)**: ADR-0435 (외부 editor 키-바인드 작성) + ADR-0436 (keybinding 설정 레이어). `docs/decisions/`의 최신은 `0434-permission-profile-list-select.md` — 다음 두 free 번호.
- **Slice**:
  - A: `@/apps/cli` (신규 leaf `src/apps/cli/raw-line-reader-editor.ts`) + `raw-line-reader.ts` 키 핸들러 1훅 + `prompt-pipeline.ts:82` 옵션 1줄. 기존 `edit-plan-cmd.ts`의 `editInTemp`/`resolveEditor`를 **재사용**.
  - B: `@/apps/cli` (신규 leaf `src/apps/cli/keybindings/`) + `raw-line-reader.ts` 디스패치 1지점.
- **Default-OFF**:
  - A: `opts.openEditor` 미주입 ⇒ ctrl-x ctrl-e 무시, 오늘 동작 **byte-identical**.
  - B: keybinding map 미주입 ⇒ 하드코딩 기본 키만 동작, 오늘 동작 **byte-identical**.
- **흡수 출처**: Codex `tui/src/external_editor.rs` + `TuiComposerKeymap`/`TuiEditorKeymap` + `KeybindingsSpec` (정확한 line은 §1). Claude Code CLI external-editor 모드 문자열(§1.2).

---

## 1. 배경 — Codex/Claude의 external-editor + configurable-keybinding (흡수 대상)

### 1.1 Codex — keymap이 closed enum + 설정-주도

`/Users/songmin/quanta-codeagent-v3/.extracted_source/codex/_codex-rs-0.135-symbols.txt`.

- `tui/src/external_editor.rs` (`:3292`) — 외부 `$EDITOR` 작성 전용 모듈이 별도로 존재.
- `tui/src/bottom_pane/paste_burst.rs` (`:8410`) — bracketed-paste 버스트 감지(붙여넣기를 키입력 폭주와 구분). 우리 스코프 밖이지만 같은 레이어임을 보여줌.
- `:47722` — **`TuiComposerKeymap`** 와 **`TuiEditorKeymap`** 의 전체 action 어휘가 직렬화된 enum으로 박혀 있음. composer 쪽 발췌:
  `submit`, `queue`, `history_search_previous`, `history_search_next`, `enter_insert`, `move_left`, `move_right`, `move_up`, `move_down`, `delete_char`, `paste_after`, `decrease_reasoning_effort`, `increase_reasoning_effort`, **`edit_queued_message`**, …
  editor 쪽 (`TuiEditorKeymap`) 발췌:
  `insert_newline`, `move_word_left`, `move_word_right`, `delete_backward`, `delete_forward`, `kill_line_start`, `kill_whole_line`, `kill_line_end`, `open_transcript`, **`open_external_editor`**, `clear_terminal`, **`toggle_vim_mode`**, `toggle_raw_output`.
- 같은 라인 끝의 검증 에러 문자열: **`data did not match any variant of untagged enum KeybindingsSpec`** — 즉 keybinding이 **설정 파일에서 역직렬화되는 closed-enum spec**이고, 매칭 실패 시 명시적으로 거부됨.
- 검증 에러 문자열 (`:5704`~`:5710`): **`invalid keybinding \``**, **`missing key in keybinding \``**, **`duplicate modifier in keybinding \``**. → 우리 validator가 흡수할 정확한 실패 모드 3종(잘못된 키, 키 누락, 중복 modifier).

핵심 흡수 포인트:
1. **action은 closed enum** (우리도 `submit`/`newline`/`cancel`/`history-prev`/`open-editor`/`clear`/… 로 닫는다).
2. **keybinding spec은 설정에서 로드되고 validate된다** (bad spec ⇒ 명시적 거부, 우리는 "거부 후 기본값 fallback + 경고").
3. **external editor는 editor-keymap의 한 action** (`open_external_editor`) — 즉 별도 슬래시가 아니라 **키 한 방으로 호출**되는 것이 power-user UX의 본질.

### 1.2 Claude Code CLI — external editor 모드 + 키 테이블

`/Users/songmin/quanta-codeagent-v3/.extracted_source/claude-code-cli/_cli-symbols.txt`.

- `:42996` — `// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)` — 멀티라인 editor 모드 진입 안내(키-구동).
- `:42944` — `// Editor mode cancelled^C` — 취소 처리.
- `:77112` — `Enter multi-line editor mode` — 멀티라인 작성 진입.
- `:42978` — `Keybindings:Ctrl+A   Move to start of line` — 키바인드 도움말 테이블이 존재(우리 `help-render.ts`의 `KEYBINDS`와 동형).
- `:81557` / `:81625` / `:81626` — `Failed to auto-detect editor` / `Could not find editor "{s}"` / `Opening editor failed {s}` — **editor 자동탐지 실패 + 미발견 + spawn 실패**의 사용자 메시지 3종(우리 `renderEditResult`의 `spawn_failed`/`editor_failed` 분기에 그대로 대응).
- `:51644` — `environment variable PAGER when defined, or VISUAL or EDITOR.` — `$VISUAL` → `$EDITOR` 폴백 순서(우리 `resolveEditor`가 이미 동일하게 구현, §2).

### 1.3 왜 power user가 원하나

- **여러 줄 프롬프트**: 슬래시(`/edit-message`)를 타이핑하는 건 마찰. readline 관례인 **ctrl-x ctrl-e**(bash/zsh의 `edit-and-execute-command`)는 근육 기억. 즉시 `$EDITOR`(vim/emacs/code --wait)로 현재 draft를 열고, 저장→복귀→**Enter로 제출**.
- **키 재바인딩**: vim 사용자는 `↑/↓`보다 ctrl-p/ctrl-n을, emacs 사용자는 ctrl-a/ctrl-e를 기대. 하드코딩된 키맵은 손에 안 맞으면 영구 마찰. `~/.quanta/keybindings.json`으로 키→action을 덮어쓰게 한다.

### 1.4 흡수하지 **않는** 부분 (Non-goal 선반영)

- Codex의 full vim modal editor (`vim_normal`/`vim_operator`/`motion_*`/`yank_line`…) — 본 RFC는 **단일 키→action 매핑**만. modal 상태 머신은 별도 RFC.
- bracketed-paste burst 감지(`paste_burst.rs`) — 직교 기능, 본 RFC 밖.
- 외부 editor 안에서의 LSP/완성 — editor 책임, 우리는 temp 파일만 왕복.

---

## 2. 현재 quanta 동작

### 2.1 REPL 입력은 `raw-line-reader.ts`가 키 단위로 처리

실 REPL 프롬프트는 `node:readline/promises`가 아니라 (그건 `repl.ts:117`의 세션-서브커맨드 전용) **raw-mode 키 리더**다:

- `src/apps/cli/repl/prompt-pipeline.ts:82` — `defaultPromptLineReader`가 `readLine({ prompt: "› ", completer, describe, …signal, …history, …multiline })` 호출. 이게 메인 루프의 한 줄 읽기.
- `src/apps/cli/raw-line-reader.ts:175` — `readLine()` 가 raw mode 진입(`:203` `stdin.setRawMode(true)`), `keypress` 이벤트를 직접 받아(`:693` `stdin.on("keypress", onKey)`) 완성 UX/히스토리/heredoc을 자기가 그림.
- **현재 keypress→action 매핑은 전부 하드코딩된 if-체인**(`onKey`, `:472`~`:691`):
  - `:476` ctrl-c ⇒ abort
  - `:515` ctrl-r ⇒ reverse-i-search
  - `:524` return ⇒ submit / heredoc / commit-selected
  - `:568` escape ⇒ 메뉴 닫기
  - `:577` tab ⇒ 완성/ghost
  - `:588`/`:602` down/up ⇒ 메뉴 nav 또는 히스토리
  - `:619`/`:629`/`:637`/`:643` right/left/home/end ⇒ 커서
  - `:649`/`:663` backspace/delete ⇒ 편집
  - `:676` 그 외 인쇄가능 문자 ⇒ 삽입
  - **`ctrl-x ctrl-e`(또는 어떤 외부-editor 키)는 존재하지 않음.**
- raw-mode 복원은 이미 정확히 try-shaped로 되어 있음: `wasRaw` 캡처(`:202`), `cleanup()`가 `setRawMode(wasRaw)`로 복원(`:339`). **단, 이 복원은 `readLine` 종료(settle) 시에만** — 즉 readLine "안에서" 외부 프로세스를 띄우려면 **임시로 raw를 끄고 다시 켜는 별도 경로**가 필요(§4.A, #1 위험).

### 2.2 `/edit-message`는 **이미 `$EDITOR` 기반**이다 (단, 키가 아니라 슬래시)

플래그된 가설("edit-message-cmd가 in-place 재편집일 수 있다")은 **거짓**. 확인 결과:

- `src/apps/cli/edit-message-cmd.ts:57` — `/edit-message` 는 ADR-0225 (Claude `tengu_external_editor` 흡수, composer leg). `:78` `resolveEditor(...)` → `:80` `editInTemp({ body: pending, suffix: "msg.md", editor, spawn })` → `:90` `setPending(res.text)`. **명백히 외부 `$EDITOR` spawn**.
- `src/apps/cli/edit-plan-cmd.ts` — sibling이고 **공유 드라이버를 export**:
  - `resolveEditor` (`:98`): 우선순위 `editorOverride` → `$VISUAL` → `$EDITOR` → `vi` (`:102`~`:107`). Claude `:51644`와 동순서.
  - `parseEditorCommand` (`:88`): `vim -O` / `code --wait` 처럼 공백분리, 첫 토큰=binary, 나머지=선행 args, 파일 경로는 맨 뒤 append.
  - `defaultEditorSpawn` (`:114`): `spawn(cmd, args, { stdio: "inherit" })`, no-throw, exit code resolve(127 = spawn 실패).
  - `editInTemp` (`:162`): `mkdtemp(join(tmpdir(), "quanta-edit-"))` → `quanta.<suffix>` write → spawn → readback → `{ kind:"ok", text, changed }`. 모든 실패는 typed result(`spawn_failed`/`editor_failed`/`fs_failed`).
  - `renderEditResult` (`:203`): typed result → stderr 한 줄 + exit code. Claude `:81625`/`:81626` 메시지와 대응.
- **결론**: 외부 프로세스 editor spawn 인프라는 **이미 존재하고 안전하다**(no-throw, typed, tmpdir 격리). 본 RFC A는 새 spawn을 만들지 않고 **이 드라이버를 키-바인드에서 재호출**하는 것이 전부.

### 2.3 외부 프로세스 spawn은 어디서 안전하게 쓰이나 (재사용 대상)

- `edit-plan-cmd.ts:114` `defaultEditorSpawn` — `stdio: "inherit"` 로 자식이 터미널 직접 점유(editor에 적합). 본 RFC가 재사용할 정확한 함수.
- `paste-cmd.ts:93` `runOnce` — `node:child_process.spawn` no-throw wrapper(타임아웃+SIGKILL). 다만 이건 `stdio: ["ignore","pipe","pipe"]`(출력 캡처)라 editor엔 부적합. editor는 `inherit`가 맞다.
- `tool/bash/` — agent 도구의 셸 실행. composer-side editor와는 다른 경로(권한/jail 적용 대상). **재사용하지 않음**(editor는 사용자 의도 명시 행위, 도구 권한 게이트 밖).

### 2.4 설정 파일은 어디서 로드되나

- `src/runner/knobs/persist.ts:17` — `DEFAULT_DIR = join(homedir(), ".quanta")`, `DEFAULT_FILE = .../knobs.json`. **JSON 설정 파일 표준 패턴**:
  - read: `readKnobConfig(path)` (`:25`) — read 실패/`JSON.parse` 실패/`version!==1` ⇒ `null` 반환(throw 안 함).
  - write: `writeKnobConfig` (`:60`) — `mkdir -p` 후 `mode 0o600`.
  - `path`는 주입 파라미터(테스트가 tmpdir 사용).
- `src/runner/knobs/resolve.ts:8` — 레이어 우선순위 명시: CLI args > session > env > **user config (`~/.quanta/knobs.json`)** > preset > default. `safeGet` (`:39`)가 `__proto__`/`prototype`/`constructor` 차단(JSON 입력의 prototype-pollution 방어). **keybinding 머지도 이 가드를 흡수**.
- `src/shared/runtime-config.ts` — env-only 설정(파일 아님). `~/.quanta` 경로 override는 `quantaHome`(`:151`, `QUANTA_HOME`).

→ **keybindings.json은 `~/.quanta/keybindings.json`에 둔다** (knobs.json과 같은 디렉토리, 같은 로더 패턴).

### 2.5 도움말 키 테이블 (동기화 대상)

- `src/apps/cli/help-render.ts:59` `KEYBINDS` — 정적 키바인드 도움말 표(Tab/↑↓/Ctrl+C/Ctrl+D). raw-line-reader 변경 시 여기도 갱신해야 한다고 주석(`:56`). 본 RFC가 새 키를 추가하면 이 표에 한 줄 추가 + (B) 활성 시 동적 머지.

### Gap 요약

| | 갭 | 증거 |
|---|---|---|
| A | ctrl-x ctrl-e 같은 **키로** $EDITOR 호출 없음 (슬래시 `/edit-message`만) | `raw-line-reader.ts:472`~`691` onKey에 editor 키 없음 |
| A | readLine "도중" raw-mode 일시 해제→복원 경로 없음 (복원은 settle 시에만) | `:339` cleanup, `:203` 진입 |
| B | keypress→action이 전부 하드코딩 if-체인 | `:472`~`:691` |
| B | keybinding 설정 파일 로더/머지/validator 없음 | `~/.quanta/`에 knobs.json만 |

---

## 3. Goals / Non-goals

### Goals

- **A**: raw-line-reader에 **ctrl-x ctrl-e**(readline 관례) 훅 추가 → 현재 draft(`state.buf`)를 `$EDITOR`로 열고, raw mode 안전 일시정지→spawn→복원→편집결과를 `state.buf`로 반영. **자동 제출 안 함**(Claude/Codex 모두 사용자가 다시 Enter; `edit-message-cmd.ts:96` 주석과 동일 posture). 기존 `editInTemp`/`resolveEditor`/`defaultEditorSpawn` **재사용**.
- **A**: default-OFF — `readLine` 옵션에 `openEditor` 콜백/플래그가 주입될 때만 키 활성. 미주입 ⇒ ctrl-x ctrl-e는 그냥 무시(byte-identical).
- **B**: `~/.quanta/keybindings.json` 로드 → 코드측 **기본 맵 위에 머지** → raw-line-reader의 키 디스패치가 **action enum**으로 라우팅. closed action enum.
- **B**: bad config ⇒ **기본값 + 경고 한 줄**, 절대 crash 안 함. unknown action/잘못된 키/중복 ⇒ Codex식 명시적 거부(해당 항목만 드롭, 나머지 유지).
- **B**: default-OFF — keybinding map 미주입 ⇒ 오늘 하드코딩 키 그대로(byte-identical).

### Non-goals

- modal vim editor (Codex `vim_normal`/`motion_*`) — 별도 RFC.
- bracketed-paste burst 감지.
- Tauri/Web 서피스 키바인딩(서피스가 자기 입력 위젯 소유 — 포트만 공유 가능, 본 RFC는 CLI만).
- editor 안에서의 협업/LSP.
- 원격 동적 config(Codex Statsig 류). 정적 파일만.

---

## 4. 설계

### A. 외부 `$EDITOR` 작성 (ctrl-x ctrl-e)

#### A.1 `ExternalEditorPort` (closed-port) — 신규 `raw-line-reader-editor.ts`

readLine은 surface state(buf)를 소유하므로 editor 호출은 **순수 함수 한 개**로 격리한다. 기존 드라이버를 재사용:

```ts
// src/apps/cli/raw-line-reader-editor.ts  (신규 leaf)
import { defaultEditorSpawn, editInTemp, resolveEditor } from "./edit-plan-cmd"

/** raw-line-reader가 주입받는 editor 작성 포트. 닫힌 포트. */
export interface ExternalEditorPort {
  /** 현재 draft를 $EDITOR로 열고 편집 결과를 돌려준다. 실패 시 입력
   *  text를 그대로 반환(편집 취소 = no-op)하고 사유는 onWarn으로만 알린다. */
  openDraft(text: string): Promise<{ text: string; changed: boolean }>
}

export interface BuildExternalEditorArgs {
  readonly editorOverride?: string            // 테스트 시드
  readonly env?: NodeJS.ProcessEnv            // 기본 process.env
  readonly spawn?: (cmd: string, args: readonly string[]) => Promise<number>  // 테스트 시드
  readonly onWarn?: (line: string) => void    // stderr 한 줄 (실패 사유)
}

export const buildExternalEditor = (a: BuildExternalEditorArgs = {}): ExternalEditorPort => ({
  async openDraft(text) {
    const editor = resolveEditor(a.editorOverride, a.env ?? process.env)
    const spawn = a.spawn ?? defaultEditorSpawn
    const res = await editInTemp({ body: text, suffix: "draft.md", editor, spawn })
    if (res.kind === "ok") return { text: res.text, changed: res.changed }
    // 실패는 전부 no-op로 강등: editor 못 띄움/비정상 종료/fs 오류 ⇒ 원본 유지.
    if (res.kind === "spawn_failed")
      a.onWarn?.(`editor not found: ${res.cmd} (set $EDITOR or install vi)`)
    else if (res.kind === "editor_failed")
      a.onWarn?.(`editor exited with code ${res.code} — draft unchanged`)
    else a.onWarn?.(`${res.stage} failed: ${res.message} — draft unchanged`)
    return { text, changed: false }
  },
})
```

- temp 파일 라이프사이클/정리는 `editInTemp`가 이미 소유(`mkdtemp` + `quanta.draft.md`, `edit-plan-cmd.ts:162`~`193`). tmpdir 격리도 그대로 — fs-jail 밖의 `os.tmpdir()`이고, editor는 사용자-의도 행위라 jail 비대상(§2.3와 일치).
- **자동 제출 없음**: 편집결과를 `state.buf`로만 넣고 redraw. 사용자가 Enter로 제출.

#### A.2 raw-line-reader의 키 훅 (raw-mode 일시정지가 #1 위험)

`onKey`에 ctrl-x → ctrl-e **2-키 chord** 추가(bash `edit-and-execute-command`와 동일; ctrl-x는 prefix). 또는 단순화로 단일 chord 상태머신:

```ts
// readLine() 내부, state에 1필드 추가
let pendingCtrlX = false   // ctrl-x를 막 받았는가 (다음 키가 ctrl-e면 editor)

// onKey 안, ctrl-c 분기 다음:
if (opts.openEditor !== undefined) {
  if (k.ctrl === true && k.name === "x") { pendingCtrlX = true; return }
  if (pendingCtrlX && k.ctrl === true && k.name === "e") {
    pendingCtrlX = false
    void runExternalEdit()      // 아래 §A.3
    return
  }
  pendingCtrlX = false          // 어떤 다른 키든 chord 리셋
}
```

- `opts.openEditor` 미주입 ⇒ 이 블록 통째로 건너뜀(ctrl-x는 기존대로 무시됨 — 현재도 인쇄불가 제어문자라 `:678`에서 드롭). **byte-identical**.

#### A.3 raw-mode suspend→spawn→restore (try/finally, 치명 경로)

```ts
const runExternalEdit = async (): Promise<void> => {
  if (settled) return
  // 1) keypress 리스너 떼고 raw 끄고 band 비우고 커서 정리 (터미널을 editor에 양보)
  stdin.removeListener("keypress", onKey)
  releaseBand()                                 // 예약 band 지움 (:323)
  stdout.write(CR + ERASE_LINE)                 // 프롬프트 줄 지움
  const reRaw = stdin.isTTY === true ? (stdin.isRaw ?? false) : false
  try {
    if (stdin.isTTY === true) stdin.setRawMode(false)   // editor가 자기 raw 관리
    stdin.pause()
    const edited = await opts.openEditor!.openDraft(state.buf)   // spawn inherit
    state.buf = edited.text
    state.cursor = state.buf.length
  } finally {
    // 2) 무슨 일이 있어도 터미널 복구 — editor crash/throw/비정상 종료에도.
    if (settled) return                          // ctrl-c가 그새 settle했으면 손대지 않음
    if (stdin.isTTY === true) stdin.setRawMode(true)
    stdin.resume()
    readline.emitKeypressEvents(stdin)
    stdin.on("keypress", onKey)                  // 리스너 재부착
    refreshCandidates()
    growBandTo(targetReserved())
    redraw()                                     // 프롬프트 + 편집된 buf 재그림
  }
}
```

- **#1 위험 봉합**: `setRawMode(true)` + `resume()` + 리스너 재부착이 `finally`에 있어 editor가 어떻게 죽든 터미널은 raw로 복귀. `openDraft`는 절대 throw 안 함(§A.1에서 모든 실패를 result로 흡수)이지만, `finally`는 그래도 방어선으로 둔다(spawn 콜백 자체가 reject할 가능성 0이 아님).
- editor가 도는 동안 `stdin.pause()`로 우리 키 핸들러는 죽어 있고 editor가 stdin 점유(`stdio:"inherit"`). 복귀 시 `emitKeypressEvents` 재호출(Bun polyfill 안전).

#### A.4 readLine 옵션 확장

```ts
// raw-line-reader.ts ReadLineOptions에 추가
/** ADR-0435 외부 editor 작성. 주입 시 ctrl-x ctrl-e로 현재 draft를
 *  $EDITOR로 연다. 미주입 ⇒ ctrl-x ctrl-e 무시 (byte-identical). */
readonly openEditor?: ExternalEditorPort
```

### B. 사용자 정의 keybinding 레이어

#### B.1 closed action enum + 기본 맵 — 신규 `keybindings/types.ts`

```ts
// src/apps/cli/keybindings/types.ts
export const KEY_ACTIONS = [
  "submit", "newline", "cancel", "abort",
  "history-prev", "history-next",
  "reverse-search", "complete", "menu-up", "menu-down", "menu-close",
  "cursor-left", "cursor-right", "cursor-home", "cursor-end",
  "delete-back", "delete-forward",
  "open-editor", "clear",
] as const
export type KeyAction = (typeof KEY_ACTIONS)[number]
const ACTION_SET: ReadonlySet<string> = new Set(KEY_ACTIONS)

/** 정규화된 키 토큰: "ctrl+x ctrl+e" / "up" / "ctrl+r" (소문자, 공백=chord). */
export type KeySpec = string
export type KeybindingMap = ReadonlyMap<KeySpec, KeyAction>
```

closed enum 근거: Codex `TuiComposerKeymap`/`TuiEditorKeymap`(`:47722`)이 동일하게 직렬화 enum. 우리 action은 현재 `onKey` 분기(§2.1)에서 직접 추출 — 1:1 대응이라 회귀 없음.

#### B.2 기본 맵 — 현재 하드코딩의 SSOT화

```ts
// src/apps/cli/keybindings/defaults.ts
export const DEFAULT_KEYBINDINGS: KeybindingMap = new Map([
  ["return", "submit"],
  ["ctrl+c", "abort"],
  ["ctrl+r", "reverse-search"],
  ["escape", "menu-close"],
  ["tab", "complete"],
  ["up", "history-prev"],     // (메뉴 열림 시 menu-up은 핸들러가 컨텍스트로 분기)
  ["down", "history-next"],
  ["left", "cursor-left"],
  ["right", "cursor-right"],
  ["home", "cursor-home"],
  ["end", "cursor-end"],
  ["backspace", "delete-back"],
  ["delete", "delete-forward"],
  ["ctrl+x ctrl+e", "open-editor"],   // A와 합류
])
```

> 주의: 현재 `up`/`down`은 **컨텍스트 의존**(메뉴 열림 ⇒ nav, 닫힘 ⇒ history). action은 의도("history-prev")로 두고, 컨텍스트 분기는 핸들러가 유지(§B.4). 즉 keybinding은 "어떤 키가 어떤 의도인가"만 바꾸고, 의도→동작의 컨텍스트 로직은 코드 소유. 이로써 회귀면이 최소.

#### B.3 로더 + validator — 신규 `keybindings/load.ts` (knobs.json 패턴 흡수)

```ts
// src/apps/cli/keybindings/load.ts
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_PATH = join(homedir(), ".quanta", "keybindings.json")
const PROTO = new Set(["__proto__", "prototype", "constructor"])  // resolve.ts:34 흡수

export interface LoadResult {
  readonly map: KeybindingMap          // 항상 사용 가능 (실패해도 기본맵)
  readonly warnings: readonly string[] // Codex식 거부 사유 (invalid/missing/duplicate/unknown)
}

/** 파일 스키마 v1: { "version": 1, "bindings": { "<keyspec>": "<action>" } }
 *  read 실패 / parse 실패 / version!=1 ⇒ 기본맵만 (knobs persist.ts:25 패턴). */
export const loadKeybindings = async (path = DEFAULT_PATH): Promise<LoadResult> => {
  let raw: string
  try { raw = await readFile(path, "utf8") } catch { return { map: DEFAULT_KEYBINDINGS, warnings: [] } }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { map: DEFAULT_KEYBINDINGS, warnings: ["keybindings.json: invalid JSON — using defaults"] } }
  return mergeOverDefaults(parsed)   // §B.4 순수 함수
}
```

`mergeOverDefaults`(순수, 별도 export로 테스트):

```ts
export const mergeOverDefaults = (parsed: unknown): LoadResult => {
  const warnings: string[] = []
  if (typeof parsed !== "object" || parsed === null) return { map: DEFAULT_KEYBINDINGS, warnings: ["keybindings.json: not an object — using defaults"] }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) return { map: DEFAULT_KEYBINDINGS, warnings: ["keybindings.json: unknown version — using defaults"] }
  const bindings = obj.bindings
  if (typeof bindings !== "object" || bindings === null) return { map: DEFAULT_KEYBINDINGS, warnings: [] }
  const merged = new Map(DEFAULT_KEYBINDINGS)
  const seenActionKeys = new Set<string>()
  for (const [rawKey, rawAction] of Object.entries(bindings as Record<string, unknown>)) {
    if (PROTO.has(rawKey)) continue                                   // prototype-pollution 차단
    const key = normalizeKeySpec(rawKey)                              // §B.5
    if (key === null) { warnings.push(`invalid keybinding \`${rawKey}\``); continue }      // Codex :5704
    if (typeof rawAction !== "string") { warnings.push(`missing action for keybinding \`${rawKey}\``); continue }
    if (!ACTION_SET.has(rawAction)) { warnings.push(`unknown action \`${rawAction}\` for \`${rawKey}\``); continue }
    if (seenActionKeys.has(key)) { warnings.push(`duplicate modifier in keybinding \`${rawKey}\``); continue }  // Codex :5710
    seenActionKeys.add(key)
    merged.set(key, rawAction as KeyAction)
  }
  return { map: merged, warnings }
}
```

- **fail-safe**: 어떤 단일 항목이 나빠도 그 항목만 드롭 + 경고, 나머지/기본맵은 살아있음. 절대 throw 안 함.
- **머지 over defaults**: 사용자가 안 건드린 키는 기본 유지(replace 아님, operator-merge — `resolve.ts:8` 철학).

#### B.4 디스패치 통합 — `onKey`를 keymap-라우팅으로

`onKey` 최상단에서 키이벤트를 정규화→action 조회→기존 분기로 위임:

```ts
const km = opts.keybindings ?? DEFAULT_KEYBINDINGS
const action = km.get(keyOf(k))   // keyOf: KeyEvent → "ctrl+x" 등 (chord는 §A.2 pending과 결합)
switch (action) {
  case "open-editor": if (opts.openEditor) void runExternalEdit(); return
  case "submit":      /* 기존 return 분기 본문 */ ; return
  case "history-prev":/* 기존 up 분기 본문 (컨텍스트 분기 그대로) */ ; return
  // … 나머지 action도 기존 분기 본문 재사용
}
// action 미매핑 ⇒ 기존 "인쇄가능 문자 삽입"(:676)로 폴백
```

- **핵심 회귀 보호**: `opts.keybindings` 미주입 ⇒ `DEFAULT_KEYBINDINGS` 사용 ⇒ 기존 if-체인과 **동일 키→동일 동작**. 단, 구현은 if-체인을 switch로 재배선하므로 **회귀 앵커 테스트**(§7)로 byte-identical을 봉인한다.

#### B.5 키 정규화 `normalizeKeySpec`

- 입력 예: `"Ctrl+X Ctrl+E"`, `"ctrl+r"`, `"up"`, `"escape"`.
- 규칙: 소문자화, modifier 정렬(`ctrl`+`alt`+`shift` 고정순서로 "duplicate modifier" 검출), chord는 공백분리 토큰 시퀀스. 알 수 없는 키 이름/빈 토큰 ⇒ `null`(거부).
- 허용 키 이름 = `node:readline` keypress의 `name` 어휘(`return/escape/tab/up/down/left/right/home/end/backspace/delete` + `a..z` + `ctrl+<x>`). closed set으로 validate.

#### B.6 readLine 옵션 + 도움말 동기화

```ts
readonly keybindings?: KeybindingMap   // ReadLineOptions에 추가; 미주입 ⇒ 기본맵
```

`help-render.ts:59 KEYBINDS`에 ctrl-x ctrl-e 행 추가; (B 활성 시) 활성 맵에서 동적 머지 한 줄.

---

## 5. 통합 (wire) — 정확한 편집 지점

| # | 파일:line | 변경 |
|---|---|---|
| 1 | `src/apps/cli/raw-line-reader-editor.ts` (신규) | `ExternalEditorPort` + `buildExternalEditor`. `edit-plan-cmd.ts`의 `editInTemp`/`resolveEditor`/`defaultEditorSpawn` import. |
| 2 | `src/apps/cli/keybindings/{types,defaults,load,normalize}.ts` (신규) | action enum / 기본맵 / 로더+머지 / 키 정규화. |
| 3 | `src/apps/cli/raw-line-reader.ts:48` (ReadLineOptions) | `openEditor?` + `keybindings?` 필드 2개. |
| 4 | `src/apps/cli/raw-line-reader.ts:472` (`onKey` 진입부) | `pendingCtrlX` 상태 + keymap 라우팅 switch. 기존 분기 본문은 case로 이동(동작 보존). |
| 5 | `src/apps/cli/raw-line-reader.ts` (`runExternalEdit` 신규 클로저) | §A.3 suspend→spawn→restore (try/finally). |
| 6 | `src/apps/cli/repl/prompt-pipeline.ts:82` | `readLine({...})`에 `openEditor`/`keybindings` 조건부 spread 추가(둘 다 default-OFF gate). |
| 7 | `src/apps/cli/repl/surface-compose.ts:63` (`buildPromptUx`) 또는 인접 factory | feature flag 읽어 `buildExternalEditor(...)` + `loadKeybindings()` 결과를 `PromptPipelineUxOpts`로 전달. warnings는 stderr 한 줄씩. |
| 8 | `src/apps/cli/repl/cli-feature-config.ts` | `externalEditor.enabled` / `keybindings.enabled` 플래그(env: `QUANTA_EXTERNAL_EDITOR=1`, `QUANTA_KEYBINDINGS=1`). 기본 OFF. |
| 9 | `src/apps/cli/help-render.ts:59` | `KEYBINDS`에 `Ctrl+X Ctrl+E → Edit draft in $EDITOR` 행. |
| 10 | `src/apps/cli/prompt-pipeline.ts:21` (`PromptPipelineUxOpts`) | `openEditor?` / `keybindings?` 전달 슬롯 2개. |

설정 로드 위치: `loadKeybindings(~/.quanta/keybindings.json)` 는 #7(surface compose, 세션 시작 1회 비동기). knobs.json과 동일 디렉토리·동일 fail-safe.

---

## 6. Edge cases

| 케이스 | 처리 |
|---|---|
| `$EDITOR`/`$VISUAL` 미설정 | `resolveEditor`가 `vi` 폴백(`edit-plan-cmd.ts:107`). vi도 없으면 `editInTemp`가 `spawn_failed`(127) ⇒ `openDraft`가 no-op + 경고("set $EDITOR"). draft 보존. |
| editor crash / 비정상 종료 | `editInTemp`가 `editor_failed{code}` ⇒ no-op + 경고. draft 보존. **raw-mode는 finally가 복원**. |
| **editor 종료 시 터미널 깨짐 (#1 위험)** | §A.3 `finally`에서 `setRawMode(true)`+`resume()`+`emitKeypressEvents`+리스너 재부착. editor가 throw/SIGKILL/비정상 어떤 식으로 죽든 복귀. settle 레이스도 `if (settled) return`로 차단. |
| 거대 draft | `editInTemp`는 tmp 파일 write/read만(메모리 1회 복사). paste-cmd의 1MB 캡과 달리 editor는 사용자 의도라 캡 없음 — 단 readback은 일반 `readFile`(거대 시 사용자 책임). |
| 동시 편집 | readLine은 단일 키 핸들러·단일 inflight. editor 도는 동안 `stdin.pause()` + 리스너 제거 ⇒ 재진입 불가. ctrl-x ctrl-e 두 번 못 들어옴. |
| keybinding 충돌/중복 | `mergeOverDefaults`가 같은 정규화 키 2회 ⇒ "duplicate modifier" 경고 + 후자 드롭(첫 승). |
| bad config (parse/version/타입/unknown action) | 항목별 드롭 + 경고, 기본맵 살아있음. 절대 crash 안 함. (Codex `KeybindingsSpec` 거부 흡수.) |
| non-TTY (`stdin.isTTY !== true`) | A: setRawMode 가드 이미 `isTTY` 체크(`:203`,`:339`). editor spawn은 inherit라 non-TTY에선 사용자가 안 부름. B: keymap 라우팅은 TTY 무관(순수 매핑). |
| 멀티바이트 | `state.buf` 편집은 기존 `stringColumns`/codepoint 경로 그대로. editor 왕복은 UTF-8 read/write(`editInTemp`가 `"utf8"`). |
| ctrl-x 후 다른 키 | `pendingCtrlX` 리셋(§A.2). ctrl-x 단독은 무시(기존과 동일). |
| heredoc/reverse-search 모드 중 ctrl-x ctrl-e | searchMode/heredocOpen 우선순위 유지 — editor 훅은 그 모드 분기 **밖**(일반 입력 컨텍스트)에서만 발동. |

---

## 7. 테스트 (hellgate)

신규 `*-hellgate.test.ts`:

1. **editor spawn + 편집결과 반영** — `buildExternalEditor({ spawn: fakeSpawn, editorOverride: "fake" })`, `fakeSpawn`이 temp 파일에 새 내용 write 후 `0` resolve ⇒ `openDraft("old")` 가 `{ text: "<new>", changed: true }`.
2. **raw-mode 복원 (치명)** — `openDraft`가 reject하도록 fake spawn이 throw ⇒ `runExternalEdit` 후 (a) `setRawMode` 마지막 호출이 `true`, (b) keypress 리스너 재부착됨, (c) draft 원본 유지. (stdin mock로 `setRawMode` 호출 시퀀스 단언.)
3. **editor 비정상 종료 = no-op** — fake spawn `code=1` ⇒ `changed:false` + 경고 1줄 + draft 보존.
4. **$EDITOR 미설정 폴백** — env에서 `EDITOR`/`VISUAL` 제거 ⇒ `resolveEditor`가 `vi`; spawn 127 ⇒ no-op + "set $EDITOR" 경고.
5. **keybinding 머지 over defaults** — `{version:1,bindings:{"ctrl+p":"history-prev"}}` ⇒ 결과 맵에 `ctrl+p→history-prev` 추가 + 기본맵 전 항목 유지.
6. **bad config fail-safe** — invalid JSON / `version:2` / `bindings:[]` / unknown action / 중복키 / `__proto__` 키 각각 ⇒ throw 0건, 기본맵 보존, 각 사유별 경고 문자열(Codex `invalid keybinding`/`unknown action`/`duplicate modifier`).
7. **회귀 앵커 (byte-identical)** — `opts.keybindings`/`opts.openEditor` **미주입** ⇒ 합성 keypress 시퀀스(타이핑/↑↓/tab/enter/backspace/ctrl-c)에 대한 출력·resolve 값이 RFC-전 raw-line-reader와 동일. (기존 raw-line-reader 테스트 스위트를 회귀 기준으로 재실행.)
8. **chord 격리** — ctrl-x 후 ctrl-e 아닌 키 ⇒ editor 안 뜨고 그 키는 정상 처리; ctrl-x 단독 ⇒ 무시.
9. **non-TTY** — `isTTY=false`에서 keymap 라우팅 정상, setRawMode 미호출.

타이머/실제 editor 0개 — fake spawn + fake stdin으로 결정적.

---

## 8. 파일별 변경 목록

### 신규
- `src/apps/cli/raw-line-reader-editor.ts` — `ExternalEditorPort` + `buildExternalEditor` (edit-plan-cmd 드라이버 재사용).
- `src/apps/cli/keybindings/types.ts` — action enum + `KeybindingMap`.
- `src/apps/cli/keybindings/defaults.ts` — `DEFAULT_KEYBINDINGS` (현재 하드코딩 SSOT).
- `src/apps/cli/keybindings/normalize.ts` — `normalizeKeySpec` + `keyOf`.
- `src/apps/cli/keybindings/load.ts` — `loadKeybindings` + `mergeOverDefaults`.
- `docs/decisions/0435-external-editor-keybind.md`, `docs/decisions/0436-keybinding-config-layer.md`.
- hellgate 테스트 2~3 파일.

### 편집
- `raw-line-reader.ts:48` ReadLineOptions(+`openEditor`/`keybindings`), `:472` onKey(keymap switch + ctrl-x chord), `runExternalEdit` 클로저 추가.
- `repl/prompt-pipeline.ts:21,82` UxOpts + readLine spread.
- `repl/surface-compose.ts:63` 인근 — editor/keymap 빌드 + 주입 + warnings stderr.
- `repl/cli-feature-config.ts` — 2 플래그(default OFF).
- `help-render.ts:59` KEYBINDS 행 추가.

### slice fence
- 신규 leaf는 `@/apps/cli` 내부만 import(`./edit-plan-cmd`, `node:*`). `@/agent`/`@/runner`/`@/permission` import 0건. `edit-plan-cmd`의 export(`editInTemp` 등)는 이미 public — 새 의존 방향 안 생김.

---

## 9. 대략 공수

- A (external editor): **0.5d** — 드라이버가 이미 있어 신규 코드는 포트 래퍼 + chord 훅 + suspend/restore. 위험은 raw-mode 복원 테스트(2번)에 집중.
- B (keybinding 레이어): **1d** — 로더/머지/normalize는 knobs.json 패턴 복붙 수준이나, `onKey` if-체인 → switch 재배선의 **회귀 앵커**(7번)가 비용의 절반.
- 합계 **~1.5d** (테스트 포함). A를 먼저 머지(독립), B는 A의 `open-editor` action을 흡수.

---

## 10. SOTA++ 체크리스트

- [x] **흡수 출처 file:line 명시** — Codex `external_editor.rs:3292` / `KeybindingsSpec`·keymap enum `:47722` / 검증 에러 `:5704`~`:5710`; Claude editor 모드 `:42944`/`:42996`/`:77112`/`:81557`~`:81626`/`:51644`.
- [x] **default-OFF 양쪽** — 포트/맵 미주입 ⇒ byte-identical(회귀 앵커로 봉인).
- [x] **기존 spawn 인프라 재사용** — `editInTemp`/`resolveEditor`/`defaultEditorSpawn`(`edit-plan-cmd.ts`) 그대로. 새 spawn 0개.
- [x] **#1 위험(raw-mode 복원) try/finally 설계** — §A.3, editor가 어떻게 죽든 복귀; settle 레이스 가드.
- [x] **closed action enum** — Codex 패턴; unknown action 거부.
- [x] **fail-safe config** — bad config ⇒ 항목 드롭 + 기본맵, throw 0; prototype-pollution 차단(`resolve.ts:34` 흡수).
- [x] **no-throw 공개 표면** — `openDraft`/`loadKeybindings` 둘 다 실패를 result/경고로 강등.
- [x] **설정 위치 일관** — `~/.quanta/keybindings.json`, knobs.json과 동일 로더/권한/머지 철학.
- [x] **slice fence clean** — `@/apps/cli` 내부만.
- [x] **도움말 동기화** — `help-render.ts:59` KEYBINDS 갱신.
- [x] **거짓 가설 정정** — `edit-message-cmd`는 이미 `$EDITOR` 기반(ADR-0225)임을 §2.2에서 코드로 확인.
