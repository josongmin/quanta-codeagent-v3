# Browser Automation — Architecture & Implementation

> [README.md](README.md)(무엇·왜) · [EXECUTION.md](EXECUTION.md)(랜딩 절차)의 자매. 이 문서는 **아키텍처·핵심 로직·구현 방법** — 컴포넌트 경계, 데이터 플로우, CDP 세션 기계, 스냅샷 파이프라인, 보안 강제 지점의 정확한 코드 흐름.
> Baseline: HEAD `0802ba65`.

## 1. 레이어 / 컴포넌트 경계

```
┌─ 모델 (LLM) ────────────────────────────────────────────────┐
│  browser_snapshot / browser_navigate / browser_click / …      │  ← action space (enum 닫힘)
└───────────────────────────┬──────────────────────────────────┘
                            │ tool_use 블록
┌─ admissibility-gate ──────▼──────────────────────────────────┐
│  mode → HARD_DENY → … → HITL(verb별 tier) → … → pre_tool_use   │  ← 기존 8-stage 그대로
└───────────────────────────┬──────────────────────────────────┘
                            │ 통과
┌─ src/tool/browser/ (도구 어댑터) ────────────────────────────┐
│  makeBrowserTool(port, fs)                                     │
│   · zod 입력 검증   · SSRF preflight(navigate)                 │  ← 강화 #2
│   · escapeReminderBoundary(출력)   · fs-jail(다운로드)         │  ← 강화 #3,#4
│   · ToolFailure 매핑   · capToolOutput(스필)                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ BrowserPort 호출 (no-throw Result)
┌─ src/browser/ (실행 채널, plane-clean) ──────────────────────┐
│  port.ts ─ BrowserPort 인터페이스                              │
│  cdp-allowlist.ts ─ isCdpMethodAllowed() (강화 #1, port.cdp 진입에서 강제)│
│  cdp-adapter.ts ─┐                    headless-stub.ts ─┐      │
│                  │ (둘 다 BrowserPort 구현)             │      │
│  snapshot.ts ─ buildSnapshot(domModel)→YAML (순수)      │      │
└──────────────────┼──────────────────────────────────────┼─────┘
                   │ ws CDP                                │ Map<url,page>
            ┌──────▼───────┐                       (네트워크/프로세스 0)
            │ chrome --headless=new                        │ ← 테스트/CI 기본
            │ (격리 임시 프로필)                            │
            └──────────────┘
```

**경계 규칙**: `src/browser/`는 `@/shared`만 import (plane-clean). `@/agent`/`@/tool`/`@/llm`/`@/mcp` 0. 브라우저는 "실행 채널"이지 도구도 권한도 아님 — 도구화·권한화는 `src/tool/browser/`가 담당. 이 분리가 hellgate를 순수 단위로 가능하게 함.

## 2. 데이터 플로우 — 한 번의 `browser_navigate` + `browser_snapshot`

```
[1] navigate
모델: tool_use{name:"browser_navigate", input:{url}}
 → gate: hitlTier="pre-approval-ok" 통과
 → makeBrowserTool.execute:
     · zod 검증
     · new URL(url) → 프로토콜 검사(https? only) → ssrfDeny(hostname)   [강화#2]
       실패 → yield result{ok:false, failure:{mode:"permission_denied"}}; return
     · port.navigate(handle, url, ctx.signal)
         → cdp-adapter: Page.navigate(url) + Page.loadEventFired 대기(또는 timeout)
         → Result<{title}, BrowserError>
     · ok → yield result{ok:true, output:`navigated: ${title}`}
     · err → mapBrowserError(err) → yield result{ok:false, failure}

[2] snapshot (perception)
모델: tool_use{name:"browser_snapshot"}
 → port.snapshot(handle):
     · cdp-adapter: Runtime.evaluate(COLLECT_SCRIPT) → 직렬화된 DomModel(JSON)   [수집=어댑터]
     · refMap.reconcile(domModel) → 각 노드에 ref 배정(단조, 재사용)
     · buildSnapshot(domModel, refMap) → YAML 문자열                            [변환=순수함수]
 → 도구: escapeReminderBoundary(yaml)   [강화#3 — 페이지가 system-reminder 위조 못 함]
        → capToolOutput(head 8K/tail 4K spill)
        → yield result{ok:true, output}
```

핵심: **수집(어댑터, 비결정)과 변환(`buildSnapshot`, 순수)을 분리**. 테스트는 직렬화된 `DomModel` fixture를 순수함수에 직접 먹여 byte-stable 단언.

## 3. CDP 어댑터 (`cdp-adapter.ts`) — 가장 복잡한 부분

### 3.1 spawn 시퀀스

```
createCdpBrowser(spawner = defaultChromeSpawner)
  availability(): string | null
    · spawner.which("google-chrome"|"chromium"|"chromium-browser")
      ?? macOS 경로 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    · 찾으면 backend 이름, 없으면 null

  spawn(opts): Promise<Result<BrowserHandle, BrowserError>>
    1. profileDir = resolveJailed(`.quanta/browser/${id}`, cwd)   // fs-jail 안
    2. proc = spawner.spawn([chromeBin,
         "--headless=new", "--remote-debugging-port=0",
         "--user-data-dir="+profileDir, "--no-first-run",
         "--disable-gpu", "--no-default-browser-check"])
    3. wsEndpoint 획득 (둘 중 하나):
         (a) profileDir/DevToolsActivePort 파일 폴링 (1줄=port, 2줄=ws path) — 권장, 결정적
         (b) proc.stderr에서 "DevTools listening on ws://…" 파싱 — fallback
       타임아웃(기본 10s) 초과 → kill + Err{kind:"spawn-failed"}
    4. ws = new WebSocket(wsEndpoint) 연결 + 첫 Target attach
    5. handle = { id, proc, ws, profileDir, closed:false }
    6. ok(handle)
```

`--remote-debugging-port=0` = OS가 빈 포트 할당 → `DevToolsActivePort` 파일로 실제 포트 회수(동시 다중 세션 안전, [shell-snapshot의 8-hex nonce concurrent-safe](../../../src/shell/snapshot/) 선례와 동일 사고).

### 3.2 ws CDP 클라이언트 (의존성 0 — Bun WebSocket 직접)

```
CDP 요청/응답 상관:
  send(method, params):
    id = ++seq
    pending.set(id, {resolve, reject})
    ws.send(JSON.stringify({ id, method, params }))
    return Promise (timeout race + signal abort)
  onmessage(msg):
    if (msg.id && pending.has(msg.id)) → pending.get(id).resolve(msg.result) / reject(msg.error)
    else if (msg.method) → 이벤트 디스패치 (Page.loadEventFired 등 대기자에게)
```

- `Promise.race(cdpCall, idleTimeout, abortSignal)` — 기존 [stream-timeout](../../../src/llm/stream-timeout.ts) 사고와 동형.
- abort: `ctx.signal` → pending 전부 reject{kind:"cancelled"} + ws close.

### 3.3 close / dispose (idempotent)

```
close(handle):
  if (handle.closed) return ok()        // idempotent — 두 번째 호출 no-op
  handle.closed = true
  handle.ws.close()
  handle.proc.kill()
  rmSync(handle.profileDir, {recursive:true})   // jailed 경로만
  return ok()
```

세션 teardown wire (강화#5): composition root에서 `disposers.push(() => port.close(handle))` — [search-pipeline dispose 등록](../../../src/runner/assemble/search-pipeline.ts) 패턴. `finally`에서 역순 호출.

## 4. 스냅샷 파이프라인 (`snapshot.ts` 순수 + 수집 스크립트)

### 4.1 수집 스크립트 (`Runtime.evaluate`로 페이지 주입)

페이지 안에서 실행되어 **직렬화 가능한 DomModel(JSON)**만 반환. ref를 DOM에 쓰지 않음(Cursor와 차이):

```js
// COLLECT_SCRIPT (브라우저 컨텍스트, 문자열로 주입)
// interactive-first selector + content 요소 walk (Shadow DOM 포함, iframe 제외)
// 각 노드: { backendPath, role, name(≤200), tag, states[], value(≤100),
//           placeholder, options(≤20), level, url, src, children }
// backendPath = 안정적 노드 식별자(DOM 트리 경로) — ref 배정의 입력
```

### 4.2 ref-map 메커니즘 (`refMap.reconcile`)

```
reconcile(domModel):
  · 직전 스냅샷의 backendPath→ref 매핑 유지
  · 같은 backendPath 재등장 → 같은 ref 재사용 (모델이 직전 ref로 클릭해도 유효)
  · 신규 backendPath → ref = `e${++counter}` (단조 증가)
  · 사라진 backendPath → ref 만료(매핑에서 제거)
  · ref→backendPath 역매핑 보관 → click(ref)/type(ref)가 backendPath로 해석
```

**단조 counter라 동일 페이지 시퀀스 = byte-stable ref**(replay/hellgate 가능). ref가 DOM에 안 박히므로 페이지 오염 0.

### 4.3 buildSnapshot (순수)

```
buildSnapshot(domModel, refMap) → YAML
  · DomModel 트리를 들여쓰기 YAML로 직렬화
  · 노드 라인: `{ref} {role} "{name}"` + 부가 필드(states/value/url) 조건부
  · 입력 동일 → 출력 byte-identical (Date/random 불사용)
```

click(ref) 흐름: `refMap.resolve(ref)` → backendPath → `DOM.querySelector` 또는 `Runtime.evaluate`로 요소 찾고 `Input.dispatchMouseEvent` ... **단, Input.* 은 allowlist 거부 대상**(아래 §5.1) → click은 port의 전용 메서드로 내부 처리(모델이 raw cdp로 Input 못 부름), 어댑터 내부에선 사용 가능.

## 5. 보안 강제 — 정확한 코드 지점

### 5.1 강화#1 — CDP allowlist (port.cdp 진입에서 hard gate)

```
// cdp-allowlist.ts
const CDP_ALLOWED = new Set([
  "Runtime.evaluate", "DOM.getDocument", "DOM.querySelector",
  "CSS.getComputedStyleForNode", "Performance.getMetrics",
  "Log.enable", "Network.enable",
])  // 닫힌 집합 — 그 외 전부 거부
export const isCdpMethodAllowed = (m: string): boolean => CDP_ALLOWED.has(m)

// cdp-adapter.ts port.cdp()
cdp(handle, method, params):
  if (!isCdpMethodAllowed(method)) return err({kind:"cdp-method-denied", method})
  return ok(await send(method, params))
```

→ `browser_cdp` 도구는 `port.cdp`만 호출 → Input.*/Storage.*/Cookies.*/Browser.* 전부 코드 거부. **어댑터 내부 메서드(click/type 구현)는 send를 직접 써서 Input.* 사용 가능** — allowlist는 "모델이 raw로 부를 수 있는 표면"에만 적용, 내부 구현엔 비적용. 이 비대칭이 핵심(Cursor도 같은 의도지만 코드 강제 아님).

### 5.2 강화#2 — SSRF (navigate 도구 preflight)

```
// makeBrowserTool navigate execute, port 호출 전
let u: URL
try { u = new URL(input.url) } catch { yield fail("invalid_url"); return }
if (u.protocol !== "https:" && u.protocol !== "http:") { yield fail("protocol_denied"); return }
const deny = ssrfDeny(u.hostname)   // 기존 src/tool/web/fetch.ts 재사용
if (deny !== null) { yield result{ok:false, failure:{mode:"permission_denied", path:u.hostname}}; return }
// (선택) originAllowlist.check(u.origin)
```

### 5.3 강화#3 — 페이지 내용 위조 방어 (도구 출력 시)

```
// snapshot/read 결과를 모델에 주기 직전
const safe = escapeReminderBoundary(snapshotYaml)   // src/agent/prompt.ts
yield result{ok:true, output: capToolOutput(safe, …).output}
```

페이지가 `</system-reminder>...명령...` 같은 걸 심어도 boundary 위조 무력화. quanta 고유.

### 5.4 강화#4 — 다운로드 fs-jail (Phase 2)

```
// 다운로드 저장 경로
const jailed = resolveJailed(input.savePath, ctx.cwd)   // src/storage/service.ts
// FsJailError → failure{mode:"permission_denied", path}
await fs.writeFile(input.savePath, bytes, ctx.cwd)      // fs = 팩토리 주입
```

### 5.5 강화#5 — verb별 HITL tier

```
hitlTier: (input) => {
  switch (input.verb) {            // 또는 도구별로 분리 정의
    case "navigate": case "snapshot": case "read": return "pre-approval-ok"
    case "click": case "type":                      return "always-confirm"
    case "cdp": case "download":                    return "always-confirm"
  }
}
```

생략 시 [inferToolTier](../../../src/permission/policy.ts) fail-closed(`isReadOnly()===false → always-confirm`)라 안전 쪽으로 degrade.

## 6. 도구 execute() 흐름 (quanta 계약)

```
async *execute(input, ctx): AsyncIterable<ToolEvent> {
  // 0. abort 선검사
  if (ctx.signal.aborted) { yield result{ok:false, failure:{mode:"error"}}; return }
  // 1. preflight (SSRF/프로토콜/jail) — 실패면 result yield 후 return
  // 2. yield {type:"progress", message:`browser: ${verb} …`}
  // 3. const r = await port.<verb>(handle, …, ctx.signal)
  // 4. r.ok ? yield result{ok:true, output: escape+cap}
  //         : yield result{ok:false, ...mapBrowserError(r.error)}
}
```

`mapBrowserError`: `cdp-method-denied`→`{mode:"permission_denied"}`, `timeout`→`{mode:"timeout", timeoutMs}`, `element-not-found`→`{mode:"not_found"}`, `closed`/`backend-missing`→`{mode:"error", modelVisibleError}`. 절대 throw 안 함(registry.run이 generator 소비 — throw하면 loop가 ok:false로 변환하지만, 명시적 result yield가 계약).

핸들 수명: 세션당 1 브라우저 핸들을 tier1 builder가 보유(lazy spawn — 첫 browser_* 호출 때 `port.spawn`). 도구는 그 핸들 참조만. `isConcurrencySafe: () => false`(상태 공유라 병렬 금지) → streamingTurn HOL barrier가 직렬화.

## 7. 동시성 / abort

- 브라우저 핸들 = 단일 stateful 리소스 → `isConcurrencySafe(false)`로 [HOL barrier](../../../src/agent/streaming-dispatch.ts)가 다른 도구와 인터리브 차단.
- 한 세션 내 browser_* 들은 순차(같은 핸들). CDP send는 id 상관이라 내부적으론 여러 in-flight 가능하나 도구 레벨은 직렬.
- `ctx.signal` → CDP pending reject + (필요 시) Page.stopLoading. abort-aware.

## 8. 구현 순서 요약 (EXECUTION 웨이브와 매핑)

| 컴포넌트 | 결정성 | 웨이브 | 의존 |
|---|---|---|---|
| `types.ts` / `port.ts` | 순수 타입 | W1 | 없음 |
| `snapshot.ts` (buildSnapshot) | 순수함수 | W1 | DomModel 타입 |
| `cdp-allowlist.ts` | 순수 | W1 | 없음 |
| `headless-stub.ts` | 결정적(Map+clock) | W2 | port |
| `cdp-adapter.ts` (spawn/ws/refMap) | 비결정(실브라우저) | W2 | port, allowlist, snapshot |
| `tool/browser/` (execute+보안) | 결정(port stub로) | W3 | port, ssrfDeny, escapeBoundary, fs |
| `tier1/browser.ts` + dispose wire | — | W3 | tool, composition root |

**가장 어려운 건 `cdp-adapter.ts`의 spawn+ws+refMap**(유일한 비결정 + 외부 IO). 나머지는 전부 순수/결정적이라 hellgate로 박힘. 무게중심은 알고리즘이 아니라 (a) DevToolsActivePort 회수 안정성, (b) ref-map reconcile 정확성, (c) allowlist 비대칭(모델 표면만 거부) 세 군데.
