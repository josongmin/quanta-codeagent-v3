# Claude-in-Chrome 브라우저 자동화 + Computer Use + 멀티모달 입력

Claude Code v2.1.143의 "기깔나는" 플래그십 능력: Claude가 사용자의 **실제 Chrome 탭**을 클릭/타이핑/스크린샷으로 조작(`claude-in-chrome`)하고, OS 데스크톱 전체를 control(`computer-use`)하며, 그 스크린샷이 대화에 이미지로 흘러 들어온다. v0.2.8에는 전혀 없던 서브시스템.

핵심 식별자:

| 직관 이름 | minified | 종류 | 역할 |
|---|---|---|---|
| `chromeServerName` | `Bg` | const | `"claude-in-chrome"` MCP 서버 이름 |
| `computerUseServerName` | `aC` | const | `"computer-use"` MCP 서버 이름 |
| `chromeMcpSetup` | `NU8` | fn | chrome MCP 서버 config + allowedTools + systemPrompt 빌더 |
| `chromeSystemPrompt` | `fJ8` | fn | chrome "Financial actions" 안전 블록 |
| `chromeBridgeClient` | `chromeCloudBridge` | class | WebSocket 클라우드 브릿지 클라이언트 (멀티 디바이스 페어링) |
| `makeChromeBridge` | `EN_` | fn | `new hN_(ctx)` 팩토리 |
| `chromeDefaultEnabled` | `yX6` | fn | `claudeInChromeDefaultEnabled` 설정 해석기 |
| `chromeExtInstalled` | `U1H`/`ly3`/`nZK` | fn | Chrome 프로필에서 확장 설치 여부 탐지 |
| `chromeAutoEnable` | `iaH` | fn | `tengu_chrome_auto_enable` 게이트 자동 활성화 |
| `chromeOnboardingUI` | `i6O` | fn | `ClaudeInChromeOnboarding` React 컴포넌트 |
| `chromeToolDefs` | `a6H` | const[] | 22개 chrome MCP 도구 정의 배열 |
| `computerUseStateAccessor` | `W6K` | fn | computer-use MCP 상태 getter/setter 어댑터 |
| `getComputerUseMcpState` / `setComputerUseMcpState` | (ctx 필드) | fn | computer-use 권한/디스플레이/스크린샷 상태 슬라이스 |
| `chromeNativeHostName` | `VU8` | const | `"com.anthropic.claude_code_browser_extension"` 네이티브 메시징 호스트 |
| `chromeExtensionId` | `dy3` | const | `"fcoeoabgfenejglbffodgkkbkcdhcgfn"` (Chrome 웹스토어 확장 ID) |

> 신뢰도: 코드 본문에 직접 등장하는 식별자/문자열은 **확인**. 동작 흐름 결합은 **추정** 명기.

---

## 1. 호출 그래프

### 1.1 두 가지 transport 아키텍처 (확인)

`claude-in-chrome`은 **두 개의 완전히 다른 연결 경로**를 가진다:

```
(A) 로컬 stdio MCP — chromeMcpSetup(`NU8`)
  Claude Code 프로세스
    └─ spawn: process.execPath --claude-in-chrome-mcp   (in-binary 서브명령)
         (scope:"dynamic" MCP 서버, transport:"stdio")
         └─ Chrome Native Messaging Host 설치
              name = chromeNativeHostName(`VU8`)
                   = "com.anthropic.claude_code_browser_extension"
              command = process.execPath --chrome-native-host
              → Chrome 확장(ID `dy3`=fcoeoabgfenejglbffodgkkbkcdhcgfn)이
                native host stdio로 MCP 서버와 통신

(B) 클라우드 WebSocket 브릿지 — chromeBridgeClient(`chromeCloudBridge`)
  Claude Code
    └─ ws://{bridgeConfig.url}/chrome/{userId}        (OAuth 토큰 인증)
         └─ Anthropic 브릿지 서버 (relay)
              └─ Chrome 확장이 같은 브릿지에 peer로 접속
                 → tool_call 메시지를 deviceId 기준 라우팅
```

(A)는 로컬 단일 머신, (B)는 **다중 브라우저/원격 디바이스 페어링** 경로다. (B)의 `chromeCloudBridge`은 `list_extensions` → `pairing_request` → `pairing_response` 핸드셰이크로 여러 Chrome 인스턴스 중 하나를 deviceId로 선택한다.

로컬 IPC 보조 경로도 존재(`m86`/`t97`): 유닉스 소켓 `/tmp/claude-mcp-browser-bridge-${username}/${pid}.sock`, Windows는 named pipe `\\.\pipe\claude-mcp-browser-bridge-${username}`.

### 1.2 활성화 / 온보딩 경로 (확인)

```
chromeDefaultEnabled(`yX6`):
  arg===true  → true
  arg===false → false
  env CLAUDE_CODE_ENABLE_CFC truthy  → true     (CFC = "Claude For Chrome")
  env CLAUDE_CODE_ENABLE_CFC falsy   → false
  R8() (제한 환경?) → false
  config.claudeInChromeDefaultEnabled !== undefined → 그 값
  else → false                                  (기본 비활성)

chromeAutoEnable(`iaH`)  — 메모이즈드:
  I6H() !== false
  && env CLAUDE_CODE_ENABLE_CFC 비-falsy
  && Rk()                       (지원 플랫폼?)
  && oy3()                      (확장 설치 캐시 갱신: U1H()→cachedChromeExtensionInstalled)
  && Z_("tengu_chrome_auto_enable", false)   ← Statsig 게이트

온보딩 UI: chromeOnboardingUI(`i6O`) = "ClaudeInChromeOnboarding" React 컴포넌트
  mount 시: d("tengu_claude_in_chrome_onboarding_shown", {})
            U1H() 으로 확장 설치 재확인
  완료 시: config.hasCompletedClaudeInChromeOnboarding 기록
  설정 변경: telemetry "tengu_claude_in_chrome_setting_changed"
```

`claudeInChromeDefaultEnabled` / `hasCompletedClaudeInChromeOnboarding`은 둘 다 글로벌 config 키 화이트리스트(`ci_` 배열, ef.js:5725)에 등재된 사용자 설정. 기본값은 비활성 — 사용자가 온보딩을 통과해야 한다.

### 1.3 MCP 서버 등록 — chromeMcpSetup(`NU8`)

```
NU8():
  H = D$()                         (네이티브 실행 환경 여부)
  _ = a6H.map(t => `mcp__claude-in-chrome__${t.name}`)   ← allowedTools (22개)
  q = {}
  if (ik6())                       (= F_.sessionBypassPermissionsMode)
    q.CLAUDE_CHROME_PERMISSION_MODE = "skip_all_permission_checks"   ⚠ 보안 경계
  if (H):
    네이티브 호스트 설치: process.execPath --chrome-native-host
    return {
      mcpConfig: { "claude-in-chrome": {
        type:"stdio", command:process.execPath,
        args:["--claude-in-chrome-mcp"], scope:"dynamic",
        env: q (위 권한모드 전파)
      }},
      allowedTools: _,
      systemPrompt: fJ8()
    }
  else (개발 트리):
    cli.js 경로 해석 후 동일 stdio config, args:[cli.js,"--claude-in-chrome-mcp"]
```

`scope:"dynamic"` → MCP integration 문서의 8-tier scope 중 6번 dynamic(런타임 SDK 동적 추가). 즉 chrome MCP는 `.mcp.json`에 박히지 않고 세션 런타임에 주입된다.

### 1.4 도구 호출 → 결과 이미지 흐름 (확인)

```
runTurnLoop(`runTurnLoop`)  tool_use 블록 (name = mcp__claude-in-chrome__computer 등)
  └─ runSingleTool(`runSingleTool`) → executeToolPipeline(`executeToolPipeline`)
        └─ MCP tool.call → (transport 분기)
              (A) stdio MCP: 서브프로세스 RPC → Chrome 네이티브 호스트 → 확장
              (B) hN_.callTool(toolName, args, opts):
                    tool_use_id = randomUUID()
                    ws.send({type:"tool_call", tool_use_id, tool, args,
                             target_device_id, permission_mode, allowed_domains,
                             handle_permission_prompts, session_scope})
                    pendingCalls.set(id, {resolve,...,timer})
                    ← ws.on "tool_result" → handleToolResult
        └─ 결과 content normalize:
              MCP content block 중 source.data 있는 항목
                → { type:"image", data:source.data,
                    mimeType: source.media_type || "image/png" }
        └─ makeToolResultMessage(`makeToolResultMessage`)로 user role tool_result 메시지에
           image 블록 포함 → 다음 턴 API 요청 content로 모델에 전달
```

스크린샷은 별도 채널이 아니라 **tool_result 안의 image 블록**으로 대화에 합류한다. `computer`/`zoom` 액션의 `save_to_disk:true`이면 디스크에 PNG로 저장하고 그 경로를 결과 텍스트로 반환(사용자 공유용). 저장 안 하면 모델이 "그냥 보기"만 한다(프롬프트 명시).

---

## 2. 핵심 로직

### 2.1 chrome MCP 도구 카탈로그 (`a6H`, 22개, 확인)

| 도구 | 설명 요약 |
|---|---|
| `javascript_tool` | 페이지 컨텍스트에서 JS 실행 (`return` 금지, 마지막 표현식 반환) |
| `read_page` | 접근성 트리 (기본 50000자 한도, depth 15, `ref_id` 포커스) |
| `find` | 자연어로 요소 검색 (최대 20개, ref 반환) |
| `form_input` | ref로 폼 값 설정 |
| `computer` | **마우스/키보드/스크린샷** — 아래 §2.2 |
| `browser_batch` | 여러 도구를 1 라운드트립에 순차 실행 (중첩 불가, 첫 에러에 중단) |
| `navigate` | URL 이동 / forward / back |
| `resize_window` | 창 크기 변경 |
| `gif_creator` | 액션 녹화 → 오버레이(클릭표시/라벨/진행바/Claude 워터마크) GIF 익스포트 |
| `upload_image` | 이전 스크린샷/사용자 이미지를 file input·드래그드롭에 업로드 |
| `get_page_text` | 본문 텍스트 추출 (article 우선) |
| `tabs_context_mcp` | **MCP 탭 그룹 컨텍스트** — 세션 시작 시 필수 호출 (`createIfEmpty`) |
| `tabs_create_mcp` | MCP 탭 그룹에 새 빈 탭 |
| `tabs_close_mcp` | 세션 탭 그룹 내 탭 닫기 |
| `read_console_messages` | 콘솔 로그 (regex `pattern` 필터 권장) |
| `read_network_requests` | XHR/Fetch 네트워크 요청 (도메인 변경 시 자동 클리어) |
| `shortcuts_list` / `shortcuts_execute` | 확장의 shortcut/workflow 실행 |
| `file_upload` | 로컬 절대경로 파일을 file input ref로 업로드 (네이티브 picker 금지) |
| `switch_browser` | 모든 Chrome 확장에 연결 요청 broadcast, 사용자가 Connect 클릭 (2분 대기) |
| `list_connected_browsers` | 계정에 연결된 모든 Chrome (deviceId/name/OS/로컬여부) |
| `select_browser` | deviceId로 특정 브라우저 선택 (broadcast 없이) |

`tabs_context_mcp`는 세션마다 **자기만의 새 탭 그룹**을 만들고(`tabs_create_mcp`), 사용자가 명시하지 않는 한 기존 탭을 재사용하지 않는다 — 사용자의 다른 작업 탭과 격리하는 보안 설계.

### 2.2 `computer` 도구 (computer-use 류 — 확인)

`computer` 도구는 chrome MCP 안에 있으나, Anthropic computer-use tool의 브라우저판 사상이다. 액션 enum:

```
left_click, right_click, double_click, triple_click,
type, key, screenshot, wait (max N__=10초),
scroll, scroll_to, left_click_drag, zoom (region 사각형),
hover
```

- `coordinate:[x,y]` 픽셀 좌표 (뷰포트 원점 기준). `ref`(read_page/find의 요소 ID)를 좌표 대체로 사용 가능.
- `modifiers`: `cmd/ctrl/shift/alt/win` 조합. `key`는 공백 구분 시퀀스("Backspace Backspace Delete") + `repeat`(1–100).
- `zoom`: `region:[x0,y0,x1,y1]` 영역만 캡처해 작은 UI 정밀 검사.
- `save_to_disk`: 스크린샷/zoom 이미지를 디스크에 저장, 결과에 경로 반환 (사용자 공유 의도일 때만).
- 시스템 프롬프트: "click any buttons... with the cursor tip in the center of the element".

별도로 OS 전체를 다루는 진짜 데스크톱 computer-use MCP(`computer-use`/`aC`)가 존재한다(macOS 한정 `Li_={screenshotFiltering:"native",platform:"darwin"}`). 그 상태는 ToolUseContext의 `getComputerUseMcpState`/`setComputerUseMcpState` 슬라이스로 관리되며 `W6K`가 어댑터:

```
W6K() 반환 객체:
  getAllowedApps / getGrantFlags(clipboardRead/Write, systemKeyCombos)
  getSelectedDisplayId / getDisplayPinnedByModel / getLastScreenshotDims
  onPermissionRequest(H,_) → x33(H)         (앱별 권한 다이얼로그)
  onAllowedAppsChanged / onAppsHidden / onScreenshotCaptured
  checkCuLock / acquireCuLock:
    "free" | "held_by_self" | "blocked"      (전역 computer-use 락)
    획득 시 OS 알림:
      "Claude is using your computer · press Esc to stop"
      (notificationType:"computer_use_enter")
    Esc 감지 → fS().abortController.abort()  (사용자 즉시 중단권)
```

`computer_use_enter`/`computer_use_exit`/`computer_use_approval` 이벤트로 라이프사이클 추적. clipboard read 시 `EH("clipboard_read")` + `{base64, mediaType:"image/png", dimensions}` — clipboard 이미지가 그대로 이미지 블록화된다.

### 2.3 멀티모달: 스크린샷/클립보드/붙여넣기 → 이미지 블록 (확인)

세 경로 모두 `{type:"image", content/data:base64, mediaType, dimensions}` 형태로 수렴:

1. **MCP 도구 결과**: `source.data` → `{type:"image", data, mimeType: media_type||"image/png"}`. 매직바이트 스니핑(`Du9`/`LT_`): PNG(137 80 78 71)·WEBP(RIFF+WEBP) 판별, 기본 `image/png`.
2. **사용자 붙여넣기/드래그**: 이벤트 `input_image_paste` / `input_image_drag`. `{id, type:"image", content:base64, mediaType, filename:"Pasted image", dimensions, sourcePath}` 항목 생성 → REPL state에 누적.
3. **디스크 영속화**: `DmK`가 image 항목을 `pasted-${id}.${ext}` 파일로 기록(`writeFile(...,{encoding:"base64"})` + `datasync`). 업로드 도구(`upload_image`, `file_upload`)가 이 imageId/경로를 페이지 file input에 주입.

탭 딥링크 상수 `clau.de/chrome/tab/`(`N33`), 재연결 `https://clau.de/chrome/reconnect`(`ny3`).

### 2.4 멀티모달 입력 스키마 (확인)

`b13` Zod: file content type discriminated union — `image/jpeg | image/png | image/gif | image/webp` (+ text/PDF). PDF는 최대 페이지 제한(`GZH`). 즉 이미지 4종 + PDF + 텍스트가 1급 입력.

### 2.5 멀티 디바이스 페어링 상태머신 (`chromeCloudBridge`, 확인)

```
ensureConnected → connect:
  bridgeConfig.devUserId 있으면 dev 모드,
  아니면 getUserId() + getOAuthToken() → ws://url/chrome/{userId}
  handshakeTimer w6q=30000ms 초과 시 chrome_bridge_handshake_timeout

handleMessage 메시지 타입:
  paired/waiting     → connected+authenticated, keepAlive 시작
  peer_connected     → 확장 접속 (waiter resolve)
  peer_disconnected  → 선택된 deviceId면 selection clear + pending reject
  routing_ack        → tool_call 라우팅 확인 (target_pong_age_ms 등)
  pairing_response   → deviceId/name 확정 → selectExtension
  permission_request → handlePermissionRequest (§3.1)
  ping/pong          → keepAlive (CO4=30000 간격, Y6q=90000 무응답시 dead)
  tool_result        → handleToolResult (지연 결과 추적: timedOutCalls, 최대 200개)

discoverAndSelectExtension:
  queryBridgeExtensions (vN_=5000ms)
  0개면 waitForPeerConnected(aEH=10000ms)
  requirePairedDevice 설정 시: persistedDeviceId 외 자동선택 거부 (보안)
  1개 & 비-로컬이면 onRemoteExtensionWarning (원격 확장 경고)
  여러 개 → broadcastPairingRequest + firePairingPrompt (120초 타임아웃)

reconnect: 지수백오프 min(2000*1.5^(n-1), 30000), 100회 후 포기
  (chrome_bridge_reconnect_exhausted)
```

도구 호출 기본 타임아웃 `NN_=60000ms` (`getToolCallTimeoutMs`로 도구별 오버라이드).

---

## 3. State / Schema / 보안 경계

### 3.1 권한 모델 (확인 + 추정)

세 층의 권한이 겹친다:

1. **Claude Code permission system** — `mcp__claude-in-chrome__*`는 일반 MCP 도구처럼 `checkPermissions` passthrough → permission rule 매칭/auto-mode classifier (MCP integration 문서 참조).
2. **브릿지 permission_mode** — `hN_.callTool`이 `permission_mode`(기본 `"ask"`), `allowed_domains`를 tool_call에 동봉. 서버/확장 측이 도메인 화이트리스트로 차단. `handle_permission_prompts:true`면 확장이 `permission_request`(toolType/url/action_data)를 역방향으로 보내고 `onPermissionRequest` 콜백이 동기 결정 → `permission_response{allowed}`. 권한 대기 중에는 tool-call 타이머를 일시정지(`permissionPaused`)했다 재개.
3. **확장 자체 권한** — `CLAUDE_CHROME_PERMISSION_MODE` env. **`sessionBypassPermissionsMode`(=Claude Code `bypassPermissions` 모드)일 때 `"skip_all_permission_checks"`로 설정**되어 확장 내부 권한 프롬프트까지 전부 우회된다. ⚠ 이는 명시적 보안 경계: 사용자가 bypassPermissions를 켜면 브라우저 자동화도 무인 실행된다.

### 3.2 격리 / 사용자 데이터 보호 경계 (확인)

- **탭 그룹 격리**: 세션마다 새 MCP 탭 그룹/창. 기존 사용자 탭 재사용 금지(명시 요청 시만). 닫을 수 있는 건 세션 그룹 내 탭뿐.
- **도메인 변경 시 클리어**: `read_network_requests`는 다른 도메인 네비게이션 시 자동 초기화. `read_console_messages`는 현재 도메인 메시지만.
- **원격 확장 경고**: 선택된 확장이 로컬(`isLocalExtension`=osPlatform 일치) 아니면 `onRemoteExtensionWarning`. `requirePairedDevice` 설정 시 영속 deviceId 외 자동선택 거부.
- **텔레메트리 화이트리스트**: MCP 텔레메트리에서 서버/도구명 평문 노출은 built-in MCP 화이트리스트 `xq8 = {"computer-use"}` 또는 1P transport만(MCP integration 문서 §텔레메트리). `claude-in-chrome`은 1P 경로이므로 노출되나 외부 user MCP는 마스킹.
- **subagent 격리**: `forkToolUseContext`(`forkToolUseContext`)가 `getComputerUseMcpState`는 공유하되 `setComputerUseMcpState`는 `shareSetAppState` 아니면 `void 0` — 서브에이전트가 부모 computer-use 상태를 변조 못 함.

### 3.3 dialog-blocking 경고 프롬프트 (system-prompts.txt — 확인, 전문 복원)

chrome 시스템 프롬프트(`fJ8` "Financial actions" 블록 + 동적 MCP instructions delta로 주입). 추출본 system-prompts.txt는 문장 분할로 잘려 있어 원 바이너리에서 전문 복원:

```
## Alerts and dialogs

IMPORTANT: Do not trigger JavaScript alerts, confirms, prompts, or browser
modal dialogs through your actions. These browser dialogs block all further
browser events and will prevent the extension from receiving any subsequent
commands. Instead, when possible, use console.log for debugging and then use
the mcp__claude-in-chrome__read_console_messages tool to read those log
messages. If a page has dialog-triggering elements:
1. Avoid clicking buttons or links that may trigger alerts (e.g., "Delete"
   buttons with confirmation dialogs)
2. If you must interact with such elements, warn the user first that this
   may interrupt the session
3. Use mcp__claude-in-chrome__javascript_tool to check for and dismiss any
   existing dialogs before proceeding

If you accidentally trigger a dialog and lose responsiveness, inform the
user they need to manually dismiss it in the browser.
```

이유: JS 모달(`alert`/`confirm`/`prompt`)이 페이지 이벤트 루프를 블로킹 → 확장이 이후 명령을 전혀 못 받음 → 자동화 데드락. 그래서 `console.log` + `read_console_messages`로 디버깅하라는 우회 지침.

추가 시스템 프롬프트 블록(바이너리 확인):

- `# Claude in Chrome browser automation` — GIF recording 의무(전후 프레임 캡처, 의미있는 파일명), console 디버깅(`pattern` regex 권장), Alerts/dialogs(위), "Avoid rabbit holes and loops"(2–3회 실패/무응답 시 사용자에게 보고하고 같은 액션 재시도 금지), "Tab context and session startup"(세션 시작 시 `tabs_context_mcp` 필수, 이전 세션 탭 ID 재사용 금지).
- `fJ8()` "Financial actions - do not execute trades or move money." — 가계부/회계 앱(Quicken/YNAB/QuickBooks)은 분류/리포트 위해 full tier 허용하나 **거래 체결·송금·주문·이체는 절대 금지**, 사용자에게 직접 하라고 요청.
- ToolSearch 게이트: "Before using any chrome browser tools, you MUST first load them using ToolSearch" — chrome MCP 도구는 deferred(지연 로드), `ToolSearch select:mcp__claude-in-chrome__<tool>`로 먼저 로드 후 호출. 또는 `Skill` 도구로 `claude-in-chrome` 스킬 invoke.
- computer-use 멀티모달 tier 선택 프롬프트(바이너리 확인, UTF-16): "You have a computer-use MCP available... Pick the right tool for the app" — 3-tier 우선순위: ① 앱 전용 MCP(Slack/Gmail/Linear 등 API 기반, 가장 빠르고 정확) → ② Chrome MCP(웹앱, DOM 인지로 픽셀 클릭보다 빠름; 확장 미연결이면 computer use로 빠지지 말고 설치 요청) → ③ Computer use(네이티브 데스크톱 앱/크로스앱). "Look before you assert" — 앱 상태 질문엔 스크린샷 먼저 확인 후 답변.

### 3.4 텔레메트리 라이프사이클 (확인)

브릿지(`chrome_bridge_*`, 14종):

```
chrome_bridge_connection_started {bridge_url}
chrome_bridge_connection_succeeded {duration_ms, status:"paired"|"waiting"}
chrome_bridge_connection_failed {error_type:no_user_id|no_oauth_token|websocket_error, reconnect_attempt}
chrome_bridge_handshake_timeout {duration_ms, ws_state}
chrome_bridge_disconnected {close_code, duration_since_connect_ms}
chrome_bridge_peer_connected (null)
chrome_bridge_peer_disconnected {disconnected_device_id, selected_device_id, had_match, pending_calls}
chrome_bridge_routing_ack {tool_use_id, routed_to, target_pong_age_ms, extension_sockets, mcp_sockets}
chrome_bridge_tool_call_started {tool_name, tool_use_id, session_id, user_message_uuid, timeout_ms}
chrome_bridge_tool_call_completed {tool_name, tool_use_id, duration_ms, ...}
chrome_bridge_tool_call_error {tool_name, error_message(앞 200자), ...}
chrome_bridge_tool_call_timeout {tool_name, duration_ms, timeout_ms, routing_ack_received, permission_paused, free_mem_pct, pong_age_ms}
chrome_bridge_tool_call_late_result {tool_use_id, gap_from_timeout_ms, reason:post_timeout|unknown, is_error}
chrome_bridge_reconnect_exhausted {total_attempts:100}
```

설정/온보딩: `tengu_chrome_auto_enable`(Statsig 게이트), `tengu_claude_in_chrome_onboarding_shown`, `tengu_claude_in_chrome_setting_changed`, `claude_in_chrome_mcp_path`, `chrome_native_host_install`/`_path`/`_run`, `computer_use_mcp_path`, computer-use 락 `computer_use_enter`/`computer_use_exit`/`computer_use_approval`.

### 3.5 주요 상수 (확인)

| 상수 | 값 | 의미 |
|---|---|---|
| `NN_` | 60000ms | 도구 호출 기본 타임아웃 |
| `w6q` | 30000ms | 브릿지 핸드셰이크 타임아웃 |
| `CO4` | 30000ms | keepAlive ping 간격 |
| `Y6q` | 90000ms | pong 무응답 → dead 판정 |
| `aEH` | 10000ms | peer_connected 대기 |
| `vN_` | 5000ms | 확장 discovery 대기 |
| `N__` | 10 | `computer` wait 액션 최대 초 |
| reconnect | min(2000·1.5^(n-1), 30000) | 지수 백오프, 100회 cap |
| pairing prompt | 120000ms | 페어링 프롬프트 타임아웃 |
| `dy3` | `fcoeoabgfenejglbffodgkkbkcdhcgfn` | Chrome 확장 ID |
| `VU8` | `com.anthropic.claude_code_browser_extension` | 네이티브 호스트 |

---

## 4. v0.2.8 대비 차이

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 브라우저 자동화 | 없음 (WebFetch만) | `claude-in-chrome` 22-도구 MCP, 실제 사용자 Chrome 탭 조작 |
| Transport | — | stdio MCP(`--claude-in-chrome-mcp`+네이티브 호스트) + WebSocket 클라우드 브릿지(`chromeCloudBridge`, OAuth, 멀티 디바이스 페어링) + 로컬 유닉스 소켓 |
| Computer use | 없음 | OS 데스크톱 `computer-use` MCP (macOS native screenshot, 전역 락 + Esc 중단) + chrome `computer` 도구 |
| 멀티모달 입력 | 텍스트 위주 | image(png/jpeg/gif/webp)+PDF, 붙여넣기/드래그(`input_image_paste`/`_drag`), 스크린샷→tool_result image 블록, `pasted-${id}.${ext}` 디스크 영속 |
| 도구 로딩 | 정적 | chrome 도구는 deferred → `ToolSearch select:` 또는 `Skill` invoke 필요 |
| 권한 | rule | + 브릿지 `permission_mode`/`allowed_domains` + 확장 `CLAUDE_CHROME_PERMISSION_MODE` (bypassPermissions 시 `skip_all_permission_checks`) + 역방향 `permission_request` 콜백 |
| 격리 | — | 세션별 MCP 탭 그룹, 도메인 변경 시 네트워크/콘솔 클리어, 원격 확장 경고, `requirePairedDevice`, subagent set-state 차단 |
| 설정 | — | `claudeInChromeDefaultEnabled` / `hasCompletedClaudeInChromeOnboarding` config 키, `tengu_chrome_auto_enable` Statsig 게이트, `CLAUDE_CODE_ENABLE_CFC` env |
| 안전 프롬프트 | — | dialog-blocking 경고, "Financial actions"(거래/송금 금지), rabbit-hole 루프 가드, 3-tier 도구 선택 가이드 |
| 텔레메트리 | — | `chrome_bridge_*` 14종 풀 라이프사이클 + 온보딩/네이티브호스트/computer-use 락 이벤트 |
