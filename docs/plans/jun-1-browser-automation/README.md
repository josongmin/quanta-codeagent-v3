# Jun 1 — Browser Automation Slice (interactive CDP driving)

> 설계/근거 문서 (**무엇·왜**). 착수 절차·웨이브·증명 게이트는 [EXECUTION.md](EXECUTION.md).
> Baseline 스냅샷: repo HEAD `0802ba65` (clean). 웨이브 디스패치 전 HEAD 재확인.

## 0. 동기 — 마지막 남은 순수 기능 갭

[code-agent-comparison.md](../../master/code-agent-comparison.md) / [quanta-comparison.md](../../analysis/경쟁사리뷰/code-agent-loop/quanta-comparison.md)의 갭 리스트를 코드 현재 상태로 재검증한 결과, 문서가 "HIGH 우선순위 갭"으로 적어둔 것 대부분은 이미 흡수 완료:

| 문서상 갭 | 실제 상태 (2026-06-01 코드 확인) |
|---|---|
| A8 stream idle timeout | ✅ [src/llm/stream-timeout.ts](../../../src/llm/stream-timeout.ts) + spinner-stall |
| A9/E7/E8 background subagent | ✅ [src/tool/subagent-bg/](../../../src/tool/subagent-bg/) (fork/await/poll/mailbox) |
| B12 MCP Tasks/Elicitation | ✅ [src/mcp/elicitation/](../../../src/mcp/elicitation/) + [src/tool/mcp_tasks/](../../../src/tool/mcp_tasks/) |
| B8 OS sandbox | ✅ [src/runtime/os-sandbox/](../../../src/runtime/os-sandbox/) (seatbelt verbatim + landlock + bubblewrap + per-call) |
| F11/F12 web·image 입력 | ✅ [src/tool/web/](../../../src/tool/web/) + [src/tool/image/](../../../src/tool/image/) |

**진짜 안 들어온 순수 기능 갭은 하나** — 인터랙티브 브라우저 드라이빙. `web` 도구는 정적 fetch/search만이고, 클릭·네비게이트·DOM 조작·폼 입력이 0이다. Cursor(6-engine)·Codex(browser/ 디렉터리)는 보유. 이건 [surface-model](GUI 없어도) 핑계가 안 된다 — **headless CDP는 CLI에서도 돈다**. surface 무관한 순수 기능 갭이라 흡수 1순위.

## 1. 베이스라인 — Cursor가 정답을 검증해줬다

추출 소스 직접 분석(`.extracted_source/cursor/extensions/cursor-browser-automation/dist/extension.js`):

- **perception = a11y 스냅샷(YAML)**. 노드당 `ref / role / name(≤200) / tag / states[] / value(≤100) / placeholder / options(≤20) / level / nth / url / src / children`. interactive-first selector + content 요소. Shadow DOM 지원, iframe 미지원. `includeDiff`로 직전 스냅샷 대비 unified diff.
- **ref 기반 액션** — `click(ref)`/`type(ref)`/`fill(ref)`. ref = 스냅샷이 발급한 opaque handle(`e0/e1...`). 좌표 액션(`mouse_click_xy`)은 CDP 비상구로만.
- **보안 3종** — origin allowlist(navigate마다), browser_lock(자동화 중 사용자 입력 차단), **CDP 메서드 제한**(Input.*/Storage.*/Cookies.*/Permissions.*/Browser.*/Page.setDownloadBehavior/Target.*/System.* 거부, Runtime.evaluate/DOM.getDocument/CSS.*/Performance.*/Log.enable/Network.enable 허용).
- **CDP 프록시** — `sendCDPCommand(method, params, viewId)`. >25KB 응답은 파일 스필. headless 탭 지원, Chromium(Electron 임베드).

→ a11y-first perception + ref-기반 액션은 토큰 효율·결정성·hellgate 가능성 모두에서 옳다. 이 모양을 베이스로 채택.

## 2. 핵심 설계 결정 3개

### 결정 ① 엔진 = 시스템 크롬 spawn + raw CDP (playwright 의존 없음)

[verify-workflow](installs blocked) 때문에 playwright(크로미움 ~150MB 다운로드)는 불가. 대신:

- quanta가 시스템 크롬을 **직접 spawn**: `chrome --headless=new --remote-debugging-port=0 --user-data-dir=<.quanta/browser/<id>> --no-first-run --disable-gpu`, `DevToolsActivePort`에서 ws endpoint 파싱.
- CDP를 `ws`로 직접 구동 — 외부 라이브러리/브라우저 다운로드 0.
- `availability()`가 [voice recorder가 sox/arecord를 probe](../../../src/voice/port.ts)하듯 크롬 바이너리(PATH + macOS app 경로)를 probe → 없으면 `null` → 도구 미등록.

**spawn vs attach 결정**: attach(떠있는 디버그 포트에 붙기)는 (a) 사용자가 크롬을 디버그 플래그로 직접 띄워야 하고("그냥 됨" 깨짐), (b) 로컬 아무 프로세스나 브라우저를 조종할 수 있는 ambient-authority 구멍이며 에이전트가 사용자 실세션 쿠키를 만지고, (c) 상태가 비결정적이라 hellgate 불가. **spawn(헤드리스 + 격리 임시 프로필 + dispose 정리)이 default.** port 추상화 덕에 attach는 동일 `BrowserPort`를 구현하는 **두 번째 어댑터로 후순위** 추가 가능(인증 세션 브라우징이 실제로 필요해질 때) — 지금은 아키텍처 선택이 아니라 "어느 어댑터를 먼저 ship하냐"일 뿐.

### 결정 ② perception = a11y 스냅샷 1순위, 스크린샷 2순위

`browser_snapshot`(YAML a11y tree)이 기본 perception 채널. 픽셀 스크린샷보다 토큰 싸고 결정적이며 순수함수로 hellgate 가능. 스크린샷은 기존 [image 블록](../../../src/tool/image/)으로 vision이 진짜 필요할 때만.

### 결정 ③ ref 기반 액션, 좌표는 CDP 비상구로만

`click(ref)`/`type(ref)` 중심. ref는 스냅샷이 발급한 opaque handle, **단조 증가(`e0/e1...`)라 replay byte-stable**. quanta는 ref↔backendNodeId 매핑을 out-of-band ref-map에 보관 → 스냅샷이 라이브 DOM을 mutate하지 않음(Cursor는 `data-cursor-ref` attr를 DOM에 씀; quanta는 페이지 오염 0 + 테스트 가능성 ↑).

## 3. ★ Cursor 대비 강화 5개 (차별점이자 작업 무게중심)

| # | 강화 | Cursor 현황 | quanta |
|---|---|---|---|
| **#1** | **CDP 위험 메서드 = closed allowlist hard gate** | 도구 description(soft instruction)으로만 거부 — 모델이 무시하면 뚫림 | `cdp-allowlist.ts`에 **허용 메서드만 담은 닫힌 Set**, 그 외 전부 `cdp-method-denied` 코드 거부. "prompt 부탁 말고 코드 게이트" 정체성 그대로 |
| **#2** | **SSRF default-ON + 프로토콜 화이트리스트** | origin allowlist는 opt-in config | navigate마다 기존 [ssrfDeny()](../../../src/tool/web/fetch.ts)(RFC1918/169.254/loopback/메타데이터) 재사용 default 차단 + `https?:`만 허용(`javascript:`/`data:`/`file:` 거부). 그 위 선택적 origin allowlist |
| **#3** | **페이지 내용 = 위조 불가 DATA** | 없음 | 스냅샷·추출 텍스트를 [escapeReminderBoundary](../../../src/agent/prompt.ts) 통과 → 페이지가 `<system-reminder>` 경계 위조해 명령 주입 불가. **quanta 고유 injection 방어** |
| **#4** | **다운로드는 막지 말고 fs-jail에 가둠** | `Page.setDownloadBehavior` 통째 거부 | 다운로드 허용하되 경로를 [resolveJailed(path, baseDir)](../../../src/storage/service.ts)로 jail. fs는 `makeBrowserTool(fs)` **팩토리 주입**(ctx seam 아님) |
| **#5** | **verb별 HITL 차등 + dispose lifecycle** | browser_lock 1종 + IDE lifecycle 의존 | `hitlTier(input)`로 차등(navigate/snapshot/read=`pre-approval-ok`, click/type=`always-confirm`, cdp-eval/download=`always-confirm`). 브라우저=long-lived stateful → [WiredSearchPipeline.dispose](../../../src/runner/assemble/search-pipeline.ts) 패턴으로 `close()`를 session teardown disposer 배열 등록(누수 방지). CLI/daemon surface엔 IDE lifecycle이 없음 |

## 4. 슬라이스 사양

### 4.1 파일 레이아웃 (헥사고날 idiom — [mcp/elicitation](../../../src/mcp/elicitation/) / [voice](../../../src/voice/) 모양 그대로)

```
src/browser/
├── port.ts            # BrowserPort 인터페이스 — @/shared만 import, plane-clean, no-throw Result
├── types.ts           # BrowserHandle / BrowserError(closed union) / PageSnapshot / SnapshotNode
├── cdp-adapter.ts      # createCdpBrowser(spawner) — 시스템 크롬 spawn + raw CDP over ws (프로덕션)
├── headless-stub.ts    # createHeadlessBrowser({pages,clock}) — 결정적 no-IO (테스트/CI 기본)
├── snapshot.ts         # buildSnapshot(domModel) → YAML — 순수 함수 (hellgate 핵심)
├── cdp-allowlist.ts    # ★ 강화#1 — 닫힌 CDP 메서드 allowlist + isCdpMethodAllowed()
└── index.ts           # barrel (port 타입 + 어댑터 팩토리 + stub)

src/tool/browser/
├── index.ts           # browser_* 도구들 (defineTool) — makeBrowserTool(port, fs)
└── schemas.ts         # zod 입력 스키마

src/agent/tier1/browser.ts    # buildBrowserBlock(config) → config.browser?.port 있으면 Tool[], 없으면 []
docs/decisions/0427-browser-automation.md   # ADR (다음 free 번호; 채번 시 재확인)

tests/unit/browser-snapshot-hellgate.test.ts        # 순수 snapshot byte-stable + ref 단조성
tests/unit/browser-cdp-allowlist-hellgate.test.ts    # 허용7 통과 + 위험 메서드 전수 거부 (control+adversarial)
tests/integration/browser-injection-jail-hell-e2e.test.ts  # navigate(SSRF) × 페이지내용(escapeBoundary) × 다운로드(jail)
```

### 4.2 BrowserPort (port.ts)

```ts
// @/shared만 import. zero @/agent / @/tool / @/llm / @/mcp — 브라우저는 실행 채널이지
// 도구도 권한도 아님. 전 메서드 no-throw Result.
export type BrowserError =
  | { kind: "backend-missing" }                       // 크롬 바이너리 없음
  | { kind: "spawn-failed"; detail: string }
  | { kind: "navigation-denied"; reason: string }     // SSRF / allowlist / 비-https 프로토콜
  | { kind: "element-not-found"; ref: string }
  | { kind: "cdp-method-denied"; method: string }     // ★ 강화#1
  | { kind: "timeout"; ms: number }
  | { kind: "cancelled" }
  | { kind: "closed" }

export interface BrowserPort {
  availability(): string | null                                     // "chromium" | null — 도구 게이트
  spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>>
  navigate(h: BrowserHandle, url: string, signal?: AbortSignal): Promise<Result<{ title: string }, BrowserError>>
  snapshot(h: BrowserHandle, opts?: SnapshotOpts): Promise<Result<PageSnapshot, BrowserError>>
  click(h: BrowserHandle, ref: string, signal?: AbortSignal): Promise<Result<void, BrowserError>>
  type(h: BrowserHandle, ref: string, text: string, opts?: TypeOpts): Promise<Result<void, BrowserError>>
  screenshot(h: BrowserHandle): Promise<Result<Uint8Array, BrowserError>>
  cdp(h: BrowserHandle, method: string, params?: object): Promise<Result<unknown, BrowserError>>  // allowlist 통과만
  close(h: BrowserHandle): Promise<Result<void, BrowserError>>      // idempotent
}
```

### 4.3 도구 verb

**MVP (Phase 1)**: `browser_snapshot`(perception) · `browser_navigate` · `browser_click` · `browser_type` · `browser_read`(텍스트 추출) · `browser_screenshot`. (open/close는 세션 lifecycle 내부, 모델 노출 안 함)

**Phase 2**: `browser_fill` / `browser_select_option` / `browser_scroll` / `browser_press_key` / `browser_drag` / `browser_tabs` / `browser_cdp`(allowlist) / `browser_mouse_click_xy`.

거대 출력(스냅샷/CDP 응답)은 기존 [capToolOutput](../../../src/tool/output-spill.ts)(head 8K/tail 4K + `.quanta/tool-output` spill) 재사용.

### 4.4 quanta 도구 계약 준수 (코드 확인 완료)

- 도구는 [defineTool](../../../src/tool/factory.ts) 팩토리로. `execute(input, ctx): AsyncIterable<ToolEvent>` (`{type:"progress"|"result"}`).
- `isReadOnly()` / `isConcurrencySafe(input)` — 브라우저는 stateful이라 `isConcurrencySafe: () => false`.
- `hitlTier(input)` 명시(강화#5). 생략 시 [inferToolTier](../../../src/permission/policy.ts) fail-closed(write→always-confirm).
- 실패는 [ToolFailure](../../../src/tool/types.ts) closed union(`permission_denied`/`timeout`/`error`/...)으로.
- 포트 주입은 **팩토리 인자**(`makeBrowserTool(port, fs)`), `ctx`는 `cwd`+`signal`만 필수 — fs는 ctx seam 아님(에이전트 보고 오류 교정).
- 등록은 [tier1 builder](../../../src/agent/tier1/) 패턴 + env-gate(`QUANTA_BROWSER_TOOL=1`, [QUANTA_GIT_TOOLS](../../../src/apps/cli/internal.ts) 선례) + `availability()` 이중 게이트. default-OFF.

## 5. hellgate 증명 계획

- `snapshot.ts`는 **순수 함수**(DOM 모델 → YAML)로 분리 → fixture DOM으로 byte-stable 단언 + ref 발급 단조성.
- `headless-stub.ts`: `pages: Map<url, {title, html}>` + 주입 clock → 모든 메서드 결정적. [voice-transcriber-hellgate](../../../tests/unit/voice-transcriber-hellgate.test.ts) 패턴(Result exhaustive branching).
- **CDP allowlist hellgate**: 허용 7종 통과(control) + 위험 메서드 전수(Input/Storage/Cookies/Permissions/Browser/Target/System) `cdp-method-denied` 강제(adversarial). vacuous-pass 방지를 위해 양 군 짝.
- **e2e**: navigate(SSRF 차단) × 페이지내용(escapeBoundary 위조 1개만 통과) × 다운로드(jail escape 차단)를 한 턴 조합. [outcome-hellgate](../../../tests/unit/outcome-hellgate.test.ts) counter-port 기법(위험 경로 실제 미실행 증명).

## 6. negative invariants (따라하지 말 것)

- Cursor `data-cursor-ref` DOM mutation → **금지** (페이지 오염 + 테스트 비결정). quanta는 out-of-band ref-map.
- Cursor CDP 제한을 description으로만 두는 것 → **금지**. 반드시 코드 allowlist.
- attach 어댑터를 default로 두는 것 → **금지** (ambient-authority). spawn이 default.
- 인증 세션 자동 재사용 → Phase 1 범위 외 (attach 어댑터 + 명시적 사용자 opt-in 동반 시에만).

## 7. 범위 밖 (의식적 비흡수)

- **Computer Use(스크린/마우스/키보드 OS 제어)** — surface(GUI) 의존 + OS 권한 위험 큼, ROI 브라우저보다 낮음. 별도 트랙.
- **record screen / generate image** — surface 의존, 후순위.
