# ADR-0531: W5 — DAP debugger tool (`debug_inspect`)

- **상태**: Accepted (구현·테스트 완료)
- **날짜**: 2026-06-10
- **슬라이스**: `src/tool/debug/` (NEW: dap-codec · dap-client · inspect-driver · port · tool)
- **출처**: `docs/backlog/jun-09-remaining-absorption-candidates.md` (§F W5), CC IDE 확장 디버거 도구군(`set_breakpoint`/`step_*`/`get_stack_trace`/`get_scopes`/`get_variables`/`evaluate`) — Debug Adapter Protocol 백엔드
- **관련**: ADR-0530(흡수 트리오 — 같은 풀사이클 방법론) · DXT 배선은 DROP(투기적, 소비자 없음 — ADR-0530 §Context의 built-not-wired 메타발견 참조)

## Context

경쟁사 흡수 어딧의 진짜-신규(비-inert) 마퀴 갭. quanta는 print 디버깅 외 런타임 상태 관찰 수단이 전무했다(`grep -rliE 'breakpoint|debugAdapter|stackTrace'` src = 0). CC IDE 확장은 DAP(Debug Adapter Protocol — LSP의 디버거판, Content-Length 프레이밍 stdio JSON-RPC) 백엔드로 브레이크포인트/스텝/스택/변수 도구를 제공한다.

## Decision

`src/tool/debug/` 신규 슬라이스, 4층 + 도구:

1. **`dap-codec.ts` (pure 핵심)** — `encodeDapMessage`(Content-Length = **UTF-8 byte length**) + `DapFrameDecoder`(증분·바이트정확 디코더). TCP 스트림 현실 전부 흡수: 프레임 분할(헤더/바디 중간), 한 read에 다중 프레임, 멀티바이트 바디(byte≠char), malformed 헤더(다음 `Content-Length:` 마커로 resync — buffer 항상 축소 → 무한루프 불가), 비-JSON 바디 → **NEVER-throws**, skip+recover.
2. **`dap-client.ts`** — `seq` 단조증가 할당, `request_seq`로 **out-of-order 응답 상관**(adapter는 순서 안 지킴), `event` 라우팅(`onEvent`/`waitForEvent`). **`success:false`는 reject 아님 resolve**(정상 프로토콜 결과 — 도구가 보고). reject는 transport 사망(dispose)에만. dispose는 pending을 합성 실패로 풀어 awaiter 무한대기 방지.
3. **`inspect-driver.ts`** — 정규 DAP launch 시퀀스 choreography: `initialize` → (`initialized` event 대기) → `setBreakpoints*` → `configurationDone` → race(`stopped`|`terminated`). stopped 시 `threads`→`stackTrace`→`scopes`→`variables*`→(옵션 `evaluate`)→`terminate`. **이벤트 waiter는 첫 request 전에 arm**(빠른 in-process adapter가 `initialized`를 동기 발사 → await 후 arm하면 놓쳐 hang). 모든 대기에 타임아웃 + **abort signal 레이스**(턴 취소 시 즉시 dispose, 30s까지 안 늘어짐).
4. **`port.ts` (spawn seam)** — `DebugAdapterPort.spawn(argv) → DapTransport`. 실 구현은 `Bun.spawn`(stdin=FileSink write/flush, stdout reader→sink). 닫힌포트 DI라 도구는 스크립트 fake adapter로 테스트(PTY 슬라이스와 동일 posture).
5. **`tool.ts` — `debug_inspect`** — 입력 {program, breakpoints[{file,line}], adapter:"python"|adapterCommand, args?, cwd?, evaluate?, stopOnEntry?}. python 프리셋=debugpy(`python -m debugpy.adapter`), 그 외 explicit adapterCommand. 결과를 모델 가독 텍스트로 렌더(stopped 위치+콜스택+로컬변수+eval / exited / error). **NEVER-throws** — spawn/protocol/timeout 결함 → ok:false.

## 보안 posture

- **default-OFF** (`QUANTA_DEBUG_TOOLS` strict opt-in) — 미설정 ⇒ 도구 미등록(byte-identical 메뉴).
- **always-confirm tier** — adapter 기동은 유저 프로그램(임의 코드)을 **실행**하므로 매 호출 인간 승인(bash와 동일 등급).
- `adapterCommand` 임의 argv는 RCE 인접하나: (a) default-OFF (b) always-confirm(승인 시 argv 노출) (c) **셸 아닌 argv spawn**(셸 메타문자 주입 불가)으로 bash 리스크 봉투 내. 반쪽 denylist는 security theater라 미추가 — 게이트+tier가 정본 통제.

## 배선 (전 SSOT)

`DefaultToolPorts.debugTools` 조건부 등록(notebookEdit/officeAuthoring 패턴) → `agent-arg-builder`가 `cfg.debugTools` gate → `runtime-config.debugTools = gateOn("QUANTA_DEBUG_TOOLS")` → knob-inventory 엔트리 → manifest GATED(config-slot, risk mutating) → fc `02-tool-system/debug-inspect.yaml`.

## 테스트 (red-first)

**38 fake-기반 유닛** + **13 실 debugpy e2e** = 51:
- codec 9(framing/multi/split/multibyte-byte/malformed-resync/non-JSON) · client 6(상관/out-of-order/success-false-resolve/event/waitForEvent/dispose-reject) · inspect-driver 5(stopped+stack+locals / never-stop→exited / init-fail→error / abort→error / evaluate; **fake가 deferred-launch 모델**=데드락 회귀 가드) · tool e2e 5.
- **실 debugpy 배터리 13(`debugpy-real-e2e.test.ts`, debugpy 부재 시 auto-skip)**: basic stop+locals+eval / **멀티바이트 unicode byte-정확**(`안녕 세계 🌍 テスト`+CJK dict) / deep nested stack 순서 / **의사변수 노이즈 필터** / 복합 중첩데이터 / never-executed bp→exited / failed-evaluate→omit / stopOnEntry / program args / multiple-bp first-hit / **abort mid-run(30s sleep, <15s 복귀)** / spawn-fault→ok:false / missing-program→resolve.

인접: manifest drift + knob default-off + no-throw AST 가드 green. src tsc clean.

**보강(실측 발견):** debugpy `variables`가 presentation-group 의사엔트리(`special variables`/`function variables`, 빈 value)를 섞어 보냄 → driver에서 `value===""` 필터(실 빈문자열은 `''`로 렌더되므로 value-safe). 출력 노이즈 제거.

## 어딧 (적대 1R + 객관 1R + 실물 검증)

- 적대: codec resync 무한루프 불가(buffer 축소 증명) · body 내 `\r\n\r\n`은 byte-length 추출이라 안전 · adapterCommand RCE는 게이트+tier 봉투 내 · 🔴 **ctx.signal abort 미배선(세션이 취소 무시, 프로세스 누수)** 적발 → **보강**: abort signal을 driver까지 thread, 모든 대기 레이스 + 즉시 dispose(+1 test).
- 객관: ADR(본 문서)·fc·결정보드 부재 적발 → 작성. DRY(client frame 중복 제거)·barrel exports·knob 완전성 확인.
- 🔴🔴 **실물 검증(real debugpy 1.8.21 spawn) — fake가 가린 치명 버그 적발:** 실제 debugpy는 **`launch` 응답을 `configurationDone` 이후로 DEFER**한다(DAP "Launch Sequencing"). 기존 driver는 `await client.request("launch")`로 응답을 기다려 → configurationDone을 영영 못 보냄 → **데드락**(fake adapter는 launch에 즉시 응답해 green이었음 = false-confidence). **보강**: launch를 await하지 않고 fire, launch **실패만** stop-race에 fold(성공은 race 미settle). + python 프리셋 launch config에 debugpy 필수 필드(`request`/`type`/`python` 인터프리터) 추가. **fake adapter 2개도 deferred-launch로 교정**(데드락 회귀 red-on-injection 가드) + **실 debugpy e2e 테스트**(debugpy 부재 시 auto-skip) 추가. 검증 결과: breakpoint stop + 정확한 locals(`total=10/n=5/acc=[0..4]`) + `total+100⇒110` 실측 확인.

## Scope / 후속

v1 = 상태없는 one-shot inspect(launch→첫 breakpoint→inspect→terminate). **continue/step-across-calls**(세션 영속, set_exception_breakpoints, conditional bp)는 (기능)세션 상태스토어+스텝 도구군 / (왜)반복 스텝 디버깅 / (ROI)중-M effort, v1으로 런타임 상태 관찰은 이미 가능하므로 후속. node(js-debug) 프리셋도 후속(adapterCommand로 현재 가능).
