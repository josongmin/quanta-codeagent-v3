# 숨겨진 기능 모음 (Hidden Gems)

Claude Code v2.1.143 — 문서화되지 않은 작지만 흥미로운 기능들. "Claude Code가 이런 것도 한다" 큐레이션.

추출 위치: `extracted-functions.js` (라인:바이트오프셋), `all-big-strings.txt`. 식별자는 minified(`백틱`), 확인/추정 표기.

---

## 1. 음성 입력 — 서버 프록시 + Deepgram Nova-3 STT (확인)

**위치**: `extracted-functions.js:20261/20266` (`o()`/`r()` 녹음 상태머신), `CP6` WebSocket 클라이언트 (라인 18196 영역).

**무엇을 하는가**: `/voice` 또는 음성 키바인딩으로 마이크를 켜면, 로컬에서 transcribe하지 **않는다**. 오디오를 16kHz linear16 PCM으로 캡처해서 Anthropic 백엔드 WebSocket으로 스트리밍하고, 거기서 Deepgram Nova-3로 받아쓴 텍스트를 다시 받아 프롬프트 입력란에 주입한다.

**놀라운 디테일**:

- **엔드포인트**: `wss://...BASE_API_URL.../api/ws/speech_to_text/voice_stream` (`zb3` 상수). `VOICE_STREAM_BASE_URL` env로 override 가능. 쿼리 파라미터에 `stt_provider:"deepgram-nova3"`, `use_conversation_engine:true`, `endpointing_ms:300` 박혀 있음 — 즉 Anthropic이 Deepgram을 서버 사이드에서 프록시. **OAuth(claude.ai 로그인) 필수**, API 키 사용자는 음성 불가 (`"Voice mode requires a Claude.ai account"`).
- **키워드 부스팅**: 코드베이스에서 추출한 keyterm을 STT에 `keyterms` 파라미터로 보내 인식 정확도를 높임 (`un8()` → 프로젝트 컨텍스트 기반).
- **회로 차단기(circuit breaker)**: `cQK=1e4`(10초) 안에 `lQK=3`회 조기 실패하면 새 음성 세션을 막고 `tengu_voice_circuit_breaker_tripped` 전송. 마이크 망가졌을 때 무한 재시도 방지.
- **Silent-drop 복구**: 첫 연결에서 오디오는 잡혔는데 transcript가 0이고 no_data_timeout이면, 버퍼링해둔 raw 청크(`h.current`)를 **새 연결에 재생(replay)**해서 한 번 더 시도 (`tengu_voice_silent_drop_replay`). 첫 WS 핸드셰이크가 음성 앞부분을 삼키는 버그에 대한 방어.
- **"Focus mode" / "tap" vs "hold"**: `O==="tap"`이면 토글식(눌렀다 떼면 끝), 아니면 push-to-talk(누르고 있는 동안 녹음, `pn8=200ms` 릴리스 타이머). KeepAlive 8초 간격 ping.
- **친절한 진단 메시지**: 무음일 때 `"No audio detected from microphone..."`, 네트워크 실패 시 `"Voice connection failed..."` 등 실패 원인별로 다른 안내.

**텔레메트리**: `tengu_voice_recording_started`(sttLanguage/focusTriggered), `tengu_voice_toggled`, `tengu_voice_recording_completed`(transcriptChars/recordingDurationMs/silentDropRetried), `tengu_voice_stream_early_retry`.

---

## 2. UI flicker 측정 — `tengu_flicker` (확인)

**위치**: `extracted-functions.js:20844` (`laK()`), 바이트 ~14137666.

**무엇을 하는가**: 렌더러의 매 프레임 콜백(`onFrame`)에서 Ink/터미널이 보고한 `z.flickers` 배열을 검사해, `resize`가 아닌 진짜 flicker가 1초 내 한 번이라도 발생하면 `tengu_flicker`를 전송. 페이로드는 `{desiredHeight, actualHeight, reason}`.

**왜 터미널 깜빡임을 재나**: TUI가 사용 가능한 터미널 높이보다 큰 출력을 그리려 할 때 화면이 점멸하는 현상. desiredHeight vs availableHeight를 함께 보내므로, Anthropic이 "실제 사용자 환경에서 어떤 레이아웃이 터미널 높이를 초과해 깜빡임을 유발하는가"를 텔레메트리로 추적해 렌더링 회귀를 잡으려는 것 (추정). 1초 디바운스(`Y-_<1000`)로 폭주 방지.

**보너스 — `CLAUDE_CODE_FRAME_TIMING_LOG`**: 같은 함수에서 이 env에 파일 경로를 주면, 매 프레임마다 `{total, ...phases, rss, cpu}` JSON 라인을 그 파일에 append. 숨겨진 프레임 프로파일러.

---

## 3. "잠 자라" 감지 — `is_suggests_break` (확인)

**위치**: 판정 함수 `detectBreakKeyword` @ `extracted-functions.js:14048`, 사용처는 turn loop `runTurnLoop`(라인 14057) 응답 처리.

**전체 코드**:
```js
function ma7(H){let _=H.toLowerCase();return/\bgo to (sleep|bed)\b/.test(_)}
```

**무엇을 하는가**: 모델의 텍스트 응답에 "go to sleep" 또는 "go to bed"가 들어 있으면 `tengu_model_response_keyword_detected {is_suggests_break:true}` 전송.

**놀라운/의외인 점**: 사용자에게 휴식을 권하는 UI를 띄우거나 막는 **행동은 없다** — 순수 텔레메트리. 즉 Claude가 새벽까지 코딩하는 사용자에게 "이제 자러 가세요"라고 말하는 빈도를 Anthropic이 측정만 한다. 모델이 사용자의 건강을 챙기는 발화를 얼마나 하는지 추적하는, 다소 인간적인 관측 지표 (추정). 트리거는 영어 두 표현뿐이라 의도적으로 좁게 잡혀 있음.

---

## 4. 스피너 팁 로테이션 + 동사 풀

### 4.1 스피너 동사 풀 (`aJ8`, `extracted-functions.js:9686`)

녹음 중/생각 중 스피너에 붙는 동사. **약 200개의 장난스러운 동사** 풀이 하드코딩:

`Accomplishing, Actualizing, Baking, Beboppin', Befuddling, Bloviating, Boogieing, Boondoggling, Booping, Bootstrapping, Brewing, Caramelizing, Cerebrating, Clauding, Combobulating, Cooking, Crystallizing, Dilly-dallying, Discombobulating, Doodling, Flambéing, Flibbertigibbeting, Flummoxing, Frolicking, Gallivanting, Gitifying, Honking, Hullaballooing, Hyperspacing, Jitterbugging, Julienning, Lollygagging, Moonwalking, Noodling, Photosynthesizing, Prestidigitating, Quantumizing, Razzle-dazzling, Razzmatazzing, Recombobulating, Reticulating, Sautéing, Shenaniganing, Skedaddling, Sock-hopping, Spelunking, Tomfoolering, Topsy-turvying, Vibing, Waddling, Whatchamacalliting, Wibbling, ...`

자기 참조 농담 `"Clauding"`/`"Gitifying"`, SimCity 패러디 `"Reticulating"`(splines), 요리 테마(`Caramelizing/Flambéing/Julienning/Sautéing`)가 섞여 있음.

**커스터마이즈 가능 (의외)**: `spinnerVerbs` 설정으로 사용자가 직접 추가/교체 가능. `mode:"replace"`면 풀 전체 교체, 아니면 append (`lRH()`). 두 번째 동사 풀 `sJ8`(`fQH()`)도 동일 패턴으로 별도 존재.

### 4.2 팁 로테이션 (`tipsHistory`, 라인 20495 영역)

**메커니즘**: 팁은 시간이 아니라 **앱 시작 횟수(`numStartups`)** 기준으로 노출 관리. `rZ6(tipId)`가 "이 팁을 numStartups 몇 회차에 봤다"를 `tipsHistory[tipId]=numStartups`로 기록하고, `ytH(tipId)`가 `numStartups - 마지막본회차`(못 봤으면 `Infinity`)를 반환해 "충분히 안 본 팁"을 고른다.

**스피너에 끼어드는 상황별 팁** (`extracted-functions.js:12050`):
- 세션이 `JH>1800000`(30분) + 컨텍스트 안 비웠으면: `"Use /clear to start fresh when switching topics and free up context"`
- `JH>30000`(30초) + `/btw` 한 번도 안 썼으면: `"Use /btw to ask a quick side question without interrupting Claude's current work"`
- `spinnerTipsEnabled:false`로 끄거나 `spinnerTipsOverride`로 강제 가능.

**관련 데스크톱 업셀**: `desktopUpsellSeenCount`가 3 미만이고 dismiss 안 했으면 `"Try Claude Code Desktop"` 다이얼로그 (시작 시, `tengu_desktop_upsell_shown`). 3회 보면 자동 중단.

---

## 5. `/btw` — Claude 작업 중 끼어드는 사이드 질문 (확인)

**위치**: `extracted-functions.js:15730` 영역.

**무엇을 하는가**: Claude가 작업하는 도중에 `/btw <질문>`을 치면, 현재 작업을 중단하지 않고 **대화를 포크(fork)**해서 빠른 질문을 던질 수 있다. UI에 `"(+N earlier /btw)"`로 이전 사이드 질문 누적 표시, `f` 키로 fork, `x` 키로 닫기. `btwUseCount`로 사용 횟수 추적(팁 노출 트리거에도 사용).

**의외인 점**: 명령형 에이전트에서 "잠깐 다른 거 물어볼게"를 메인 작업 흐름을 깨지 않고 처리하는 전용 UX. 스피너 팁이 이 기능을 능동적으로 홍보한다.

---

## 6. Cost / duration 표시 설정

설정 스키마(`extracted-functions.js:3609` 영역)의 describe 문자열이 그대로 남아 있음:

| 설정 | describe (verbatim) | 의외인 점 |
|---|---|---|
| `showTurnDuration` | `Show "Cooked for Nm Ns" after each assistant turn` | 턴 소요시간을 **"Cooked for"**라는 캐주얼한 카피로 표시. 서브에이전트는 `"Worked for ..."`. |
| `showMessageTimestamps` | `Stamp each assistant message with its arrival time` | 메시지별 도착 시각 스탬프 |
| `terminalProgressBarEnabled` | `Emit OSC 9;4 progress sequences during long operations` | 긴 작업 중 터미널 네이티브 진행바(OSC 9;4) 출력 — iTerm/Windows Terminal 등의 탭 진행률 표시기를 점유 |
| `fileCheckpointingEnabled` | `Snapshot files before edits so /rewind can restore them` | 편집 전 파일 스냅샷 → `/rewind` 복원 |
| `autoScrollEnabled` | `Auto-scroll ... (fullscreen mode only)` | 풀스크린 모드 전용 |

비용 자체는 `total_cost_usd`/`modelUsage`로 result 메시지에 실리고 `/usage`(별칭 `/cost`,`/stats`)로 노출 (스키마 `aliases:["/cost","/stats"]` 확인).

---

## 7. 의외인 config 플래그들

`extracted-functions.js:5725`의 설정 키 목록 + `:3609`의 Zod describe에서 발췌. describe가 없는 플래그는 사용처(`:16010`,`:20709`)에서 역추론.

| 플래그 | 동작 | 의외인 점 |
|---|---|---|
| `leftArrowOpensAgents` / `defaultToAgentsView` | 왼쪽 화살표 키로 에이전트(서브에이전트/태스크) 뷰 진입 / 기본 뷰를 에이전트 뷰로 | 키 한 개를 패널 토글로 재배치하는 UX 튜닝 |
| `copyOnSelect` / `copyFullResponse` | 텍스트 선택 즉시 클립보드 복사 / 전체 응답 복사 | 터미널 앱급 클립보드 통합이 내장 |
| `briefTranscript` / `isBriefOnly` | 트랜스크립트 축약 모드 (`tengu_brief_mode_toggled`/`tengu_brief_send`) | "brief" 출력 모드가 별도 텔레메트리까지 갖춘 1급 기능 |
| `messageIdleNotifThresholdMs` | 이 시간만큼 입력이 없으면 `"Claude is waiting for your input"` 알림 (`notificationType:"idle_prompt"`) | Claude가 대기 중일 때 능동 푸시 |
| `showStatusInTerminalTab` | Claude의 라이브 상태(작업 단계)를 **터미널 탭 제목**에 기록 (`tengu_terminal_sidebar` 게이트 + 설정 둘 다 필요) | 탭만 봐도 진행 상황 파악 |
| `terminalProgressBarEnabled` | (위 §6) OSC 9;4 진행 시퀀스 | 터미널 네이티브 진행바 점유 |
| `taskCompleteNotifEnabled` / `inputNeededNotifEnabled` / `agentPushNotifEnabled` | 작업 완료 / 입력 필요 / 능동 푸시를 **모바일**로 알림 (`Push to mobile ...` describe 확인) | claude.ai 모바일 앱으로 데스크톱 세션 알림 전달 |
| `daemonColdStart` | `transient`(이 로그인 세션만) vs `ask`(영구 설치 제안) | 백그라운드 데몬 콜드스타트 정책 선택 |
| `autoUploadSessions` | 로컬 세션을 claude.ai에 view-only 미러 | 원격 조작 없는 읽기 전용 동기화 |

추가 idle 넛지(하드코딩, `extracted-functions.js:20709`): 컨텍스트 토큰이 `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD`(기본 1e5) 넘고 `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES`(기본 75분) 동안 유휴면 `"new task? /clear"` 힌트를 띄움 — 무거운 컨텍스트로 방치된 세션을 정리하라고 권유.

---

## 8. 멀티 터미널 네이티브 알림 (확인)

**위치**: `extracted-functions.js:11975` (`wHH`/`lB5`/`nB5`).

**무엇을 하는가**: `preferredNotifChannel` 설정값(`auto|iterm2|iterm2_with_bell|terminal_bell|kitty|ghostty|notifications_disabled`)에 따라 터미널별 네이티브 알림 escape를 골라 쏜다.

**놀라운 디테일**:
- `auto`면 실행 중인 터미널을 감지(`Apple_Terminal`/`iTerm.app`/`kitty`/`ghostty`)해 각각의 네이티브 알림 API 사용 (`notifyITerm2`/`notifyKitty`/`notifyGhostty`/`notifyBell`).
- **Apple Terminal 특수 처리** (`iB5`): `osascript`로 현재 윈도우 설정명을 얻고 `defaults export com.apple.Terminal -`를 파싱해 그 프로파일에 **벨이 켜져 있는지 확인한 뒤에만** terminal bell로 폴백. 벨이 꺼진 프로파일에 헛된 BEL을 쏘지 않으려는 배려.
- `iterm2_with_bell`은 iTerm 알림 + 벨 동시. `kitty`는 알림에 랜덤 id(`Math.random()*1e4`) 부여.
- `tengu_notification_method_used {configured_channel, method_used, term}` 전송.

---

## 9. Hook가 터미널 escape를 쏠 수 있다 (확인)

**위치**: `extracted-functions.js:18761/18840` 영역.

**무엇을 하는가**: hook 출력에 `terminalSequence` 필드를 넣으면 Claude Code가 사용자 터미널에 그 escape를 대신 emit. 단 **허용 OSC만**: `OSC 0/1/2/9/99/777` (탭/윈도우 제목, 데스크톱 알림류)와 `BEL`. 그 외는 `om8()` allowlist에서 drop하고 경고 로그.

**의외인 점**: 사용자가 hook로 "Claude가 작업 끝나면 내 터미널 탭 제목을 바꾸고 데스크톱 알림을 띄워라"를 직접 구현할 수 있는 확장 포인트인데, raw escape 인젝션 위험을 알고 화이트리스트로 막아둠. 보안 의식이 있는 확장 API.

---

## 10. SDK 스톨 워치독 (확인)

**위치**: `extracted-functions.js:20543` (`trackWrite`/`resetStallWatchdog`).

**무엇을 하는가**: SDK 모드에서 메시지를 write할 때마다 `sdkStallMs` 타이머를 재무장. `result` 타입이 아닌 상태로 그 시간 안에 진전이 없고 세션이 `running`이면, **한 번만** `tengu_sdk_stall {session_age_ms, last_message_type, pending_control_requests}` 전송.

**의외인 점**: "에이전트가 멈췄는데 result를 안 내는" 데드락성 행 상태를 텔레메트리로 잡는 정지 감지기. `stallFired` 플래그로 중복 방지, `unref()`로 이 타이머가 프로세스 종료를 막지 않게 함. 같은 `trackWrite`에서 확률적(`Math.random()<YHO`) SDK 스키마 검증도 수행해 `tengu_sdk_schema_violation`을 샘플링.

---

## 11. 이스터에그 부재 / "없음"이 발견 (확인)

찾았지만 **없는 것**들 (헛수고 방지용 기록):

- **konami / 시크릿 메뉴**: 없음. `konami`, `secret command`, `disco mode` 미발견. (`disco` 매치는 전부 `disconnect`, `snowfl`은 emoji 정규식 또는 `snowflake` 단어.)
- **특수 날짜 동작**: 없음. `getMonth()`/`getDate()` 비교로 핼러윈/크리스마스/만우절 분기를 거는 코드 미발견. 홀리데이 테마 없음.
- 대신 "재미" 요소는 **§4.1 200개 스피너 동사**와 §6의 **"Cooked for"** 카피, §4.2의 `tipsHistory`로 흩어져 있음.

`snowflake`/`comet`/`nebula`/`axolotl`/`narwhal` 등은 워크트리·에이전트용 **랜덤 이름 생성 단어 풀**(`extracted-functions.js:5656`)이지 이스터에그가 아님 (확인).

---

## 요약 표

| # | Gem | 트리거 | 한 줄 |
|---|---|---|---|
| 1 | 음성 입력 | `/voice`/키바인딩 | Anthropic 서버 프록시 → Deepgram Nova-3, OAuth 필수, 회로차단기+silent-drop replay |
| 2 | flicker 측정 | 매 프레임 | 터미널 높이 초과 깜빡임을 텔레메트리로 추적, `CLAUDE_CODE_FRAME_TIMING_LOG` 프로파일러 |
| 3 | "잠 자라" 감지 | 모델 응답 텍스트 | `/\bgo to (sleep\|bed)\b/` 매칭 시 텔레메트리만 (행동 없음) |
| 4 | 스피너 동사/팁 | 스피너/시작횟수 | ~200개 장난 동사 풀(커스터마이즈 가능), `numStartups` 기준 팁 로테이션 |
| 5 | `/btw` | `/btw` 명령 | 작업 중단 없이 대화 포크해 사이드 질문 |
| 6 | "Cooked for" | 턴 종료 | duration 캐주얼 카피, OSC 9;4 진행바 |
| 7 | config 플래그 | 설정 | 모바일 푸시, 탭 제목 상태, idle `/clear` 넛지 등 |
| 8 | 멀티 터미널 알림 | 턴 완료 | 터미널별 네이티브 알림, Apple Terminal 벨 설정까지 확인 |
| 9 | hook terminalSequence | hook 출력 | 화이트리스트된 OSC만 사용자 터미널에 인젝션 허용 |
| 10 | SDK 스톨 워치독 | SDK write | result 없는 행 상태를 1회 텔레메트리 |
| 11 | 이스터에그 없음 | — | konami/특수날짜 부재 확인, 재미는 동사풀/카피에 분산 |
