# transport-unified-SDK — 배선(wiring) 감사 (jul-17 랜딩분)

**감사 대상 HEAD**: `daa3214ac` (main tree, 읽기 전용)
**감사 범위**: 01 connect()/SessionHandle · W4-b JsonlSessionEventLog · 05 durable resume · W1-B approval-continuation
**결론 한 줄**: 코어 seam은 전부 실코드로 존재하고 owner-local 테스트가 강하다. dead-seam(빌드됐지만 프로덕션 소비자 0)은 **의도된 외부 문 2건**(connect / stdio-server)뿐. 진짜 갭은 **서피스 배선-회귀 테스트 부재**(축1·2)와 **capability 정직성**(축5, 02가 스코프)이다.

---

## 축별 판정 요약

| 축 | 판정 | 한 줄 |
|---|---|---|
| 1. eventlog 실배선 깊이 | **PARTIAL-LIVE** | web-daemon·interactive-CLI·SDK-embedder 3서피스는 `createRuntime`로 수렴 → seam LIVE. 그러나 **headless/batch/ci-bot/bench는 `@/agent` 레거시 루프**라 event-log 완전 미배선(구조적, 의도됨). 서피스 레벨 disk-persist 회귀테스트 0. |
| 2. durable resume e2e | **LIVE(서버) / DEAD(클라 소비자)** | 서버측(log↔bridge↔attach)은 web-daemon `attachSessionTransport`까지 실배선. 그러나 **repo 안에서 `resumeFromSeq`를 보내는 프로덕션 클라이언트가 0**(connect=외부문 미호출, attach=resume opt-out, 프론트=repo 밖). 즉 서버 replay는 "정답이 있는데 물어보는 자가 없음". |
| 3. 01 connect dogfood | **의도된 외부 전용(정상)** | `connect()` 내부 호출자 0. quanta attach는 `createSessionTransportClient` 직접 사용(connect 우회, by-design). stdio door(`createSessionStdioSpawnTransport`)의 서버짝 `createSessionStdioServer` 호출자 0 = `serve --stdio`(티켓 02/I) 미구현 확인. 첫 실사용은 serve --stdio가 맞다. |
| 4. owner-local hellgate 커버리지 | **대체로 STRONG** | connect/handle/attach-flow/event-log-jsonl/durable-resume-restart/W1-B 전부 owner-local 존재. 갭 = **서피스 배선-회귀 테스트**(축1·2). |
| 5. capability 표면 정합 | **DEAD(정직성 결함, 02 스코프)** | `transport: "inproc"` **하드코드**(base.ts:77) — web-daemon 세션이 websocket인데 `inproc`으로 거짓 스탬프. `serverAutoContinues`는 gate OFF서 정직하게 false(base.ts:82). |
| 6. knob 거버넌스 | **CLEAN** | `QUANTA_SESSION_EVENT_LOG_DIR` inventory 선언됨(extra.ts:838) + readSite 정직(`host/runtime/persistence.ts`). CLI_FEATURE_GATES 시드 배열 **미포함**(정상 — string dir 노브, boolean gate 아님). |

**발견 dead-seam/미배선 총계**: 의도된 dead-seam 2건(connect 외부문·stdio-server) + 진짜 배선-정직성 갭 3건(축1 서피스 회귀테스트·축2 클라 소비자·축5 transport 스탬프).

---

## 축별 상세 (증거 file:line)

### 축 1 — eventlog 실배선 깊이: PARTIAL-LIVE

**수렴 지점**: 모든 SDK-런타임 서피스는 `createRuntimeFacade`(`src/sdk/runtime/runtime.ts:6`)를 경유하고, 그 안 `runtime.ts:21`이 `createSessionPersistence({ sessionId })`를 무조건 호출한다.

경유 추적 (전부 `createRuntimeFacadeFromBinding → createRuntime → createRuntimeFacade`로 수렴):
- **web-daemon**: `runtime-factory.ts:908` `createRuntimeFromAgentConfigBase(...)` → `context.ts:327` → `createRuntimeFacadeFromBinding` → `create-runtime.ts:4` `createRuntime` → `runtime.ts:6`. 세션 생성은 `server.ts:276` `runtime.createSession(...)`. ✅ LIVE
- **interactive CLI REPL**: `mode-presets/interactive.ts:120` 동일 체인. ✅ LIVE
- **SDK embedder**: `context.ts:300` `createRuntimeFacade` (context record). ✅ LIVE

**미배선 서피스 (구조적, 의도됨)**:
- **headless / batch / ci-bot**: `mode-presets/headless.ts:139` `resolveRunAgent(req.seams)` → `@/agent` `runAgent` 레거시 루프. `grep createSessionPersistence|eventLog|createRuntimeFacade src/agent/` = **0 hit**. 이 루프는 SDK 세션 커널을 아예 안 탄다.
- **bench eval driver**: `apps/bench/eval/driver.ts:339` `runAgent(...)` 직접. 세션 커널 우회.

⇒ `QUANTA_SESSION_EVENT_LOG_DIR`을 켜면 **web-daemon·interactive-CLI·SDK 임베더에서만** disk JSONL이 생긴다. headless/batch/ci-bot/bench는 로그 미생성(이 서피스들이 세션 커널을 안 쓰므로 정상, 단 문서/노브 describe가 "kernel session events"라 서피스 한정임을 밝히지 않음 = 사소한 오해 소지).

**배선-회귀 갭**: web-daemon/interactive가 `createRuntime` 경로를 계속 타는지 잠그는 서피스 레벨 테스트 **없음**. `tests/unit/apps/web-daemon/runtime-factory.test.ts`에 `SESSION_EVENT_LOG` 언급 0. 리팩터가 web-daemon 세션 생성을 non-`createRuntime` 경로로 바꾸면 durable 로깅이 조용히 죽고 red 테스트 0.

### 축 2 — durable resume e2e: LIVE(서버) / DEAD(클라 소비자)

**서버측 배선 (완전 LIVE)**:
`runtime.ts:21` JsonlSessionEventLog → `engine.ts:73-78` `ensureTransportBridge`가 `isDurableSessionEventLog` 가드로 durableLog를 bridge에 주입 → `bridge.ts:302,317-322` `sendReplay`가 `planDurableReplay`(bridge.ts:83) 사용. `ensureTransportBridge`는 `engine.ts:230` `attachSessionTransport`가 호출, 이건 web-daemon `ws-handlers.ts:99` `sharedSession.attachSessionTransport`로 실호출됨. **web-daemon 세션이 eventlog-dir 켜면 재접속 시 로그 replay를 실제로 탄다.**

**클라 소비자 (DEAD)**: `resumeFromSeq`를 보내는 프로덕션 클라이언트가 repo에 0.
- `connect()` `src/sdk/connect.ts:243`이 `resumeFromSeq: handover.lastSeq`를 raw client에 주입하나, connect docblock(connect.ts:32-42)대로 **자동 reconnect 없음** + connect 자체 내부 호출자 0.
- CLI `attach` `attach-client.ts:17,145` = "NO reconnect/resume cursor in v1" 명시적 opt-out.
- 웹 프론트엔드는 이 repo tree 밖(티켓 03-B 생성 번들). `grep resumeFromSeq src/apps/web-frontend` = 디렉토리 부재.

⇒ 서버 durable replay는 실배선이나, **현 repo 내에서 그것을 트리거하는 프로덕션 경로가 없다.** 05 코어는 "테스트(durable-resume-restart)에서만 살아있고 프로덕션 resume-보내는 호출자 0". 정직 판정: **05 서버 코어 LIVE, 05 클라 소비 DEAD until 웹 프론트 resume 배선 or connect door 실사용(serve --stdio, 티켓 02/I)**.

**owner-local 강도**: `tests/unit/sdk/durable-resume-restart.test.ts:170` CROWN 테스트가 실 체인(`createRuntime` → 실 `createSessionPersistence`/JsonlSessionEventLog → 실 `attachSessionTransport` → 실 bridge → raw client `connect({resumeFromSeq})`)을 구동하고 `resume:"replayed"` 단언 + red-on-injection(durableLog 주입 제거 시 red) 문서화. **SessionHost만 fake, 나머지 durable seam 전부 실코드.** 강함.

### 축 3 — 01 connect dogfood 갭: 의도된 외부 전용(정상)

- `grep '\bconnect(' + import from @/sdk` 프로덕션 = **0 내부 호출자**. `src/sdk/index.ts:70`이 export만.
- quanta attach는 `connect()` 우회: `attach-client.ts:30,147` `createSessionTransportClient` 직접 + 자체 handshake.
- stdio door 서버짝 `createSessionStdioServer`(`ipc/session/stdio-server.ts`, `index.ts:64` export) **호출자 0** = `serve --stdio` 미존재 확인 (CLI cmd 리스트에 serve 없음).

⇒ connect는 순수 외부 door라 내부 스모크가 **구조적으로 불가**(정상). serve --stdio(티켓 02/I)가 connect의 stdio door 첫 실사용이 맞다.

### 축 4 — owner-local hellgate 커버리지 맵

| 기능 | owner-local 테스트 | 실 배선 경유? | 배선-회귀 잡나? |
|---|---|---|---|
| 01 connect() | `tests/unit/sdk/connect.test.ts` | scripted transport (fake) | 유닛만 — NO |
| 01 connect() e2e | `tests/integration/sdk-connect-session-handle-e2e.test.ts:134` | **실 `createRuntimeFromAgentConfigBase`** + 실 attach + 실 connect | **YES** (프로덕션 런타임 경로) |
| 01 SessionHandle | `tests/unit/ipc/session-handle.test.ts` + `-conformance` | fake client | 유닛만 — NO |
| attach-flow | `tests/unit/ipc/session-attach-flow.test.ts` | — | handshake 유닛 |
| W4-b JsonlSessionEventLog | `tests/unit/kernel/event-log-jsonl.test.ts` | 로그 단독(격리) | 로그 유닛 |
| W4-b runtime seam | `tests/unit/sdk/runtime-event-log-resume.test.ts:84` | **실 `createRuntime`+`createSessionPersistence`**, fake host | **YES** (runtime.ts:21 seam) |
| 05 durable resume | `tests/unit/sdk/durable-resume-restart.test.ts:170` | **실 log↔bridge↔client**, fake host | **YES (강)** + red-on-injection |
| W1-B approval-continuation | `tests/integration/approval-respond-mid-turn-web-daemon-e2e.test.ts:153` + `tests/unit/apps/headless/approval-wiring.hellgate.test.ts` | **실 `createRuntimeFromAgentConfigBase` + `setupApprovalContinuation`** | **YES** |

**배선-회귀를 못 잡는 갭**:
1. **web-daemon/interactive 서피스가 event-log-dir을 실제로 disk에 쓰는지** — 이걸 잡는 테스트 0 (runtime seam 유닛은 fake host, e2e는 event-log-dir 미설정).
2. connect.test / session-handle.test는 fake transport 격리라 배선 회귀 못 잡음 — 단 e2e가 커버하므로 net-clean.

### 축 5 — capability 표면 정합: DEAD (02 스코프)

- `transport: "inproc"` **하드코드** — `src/host/runtime/internal/context-binding/base.ts:77`. 세션-호스트 빌드 시점에 박혀서 **모든 서피스가 inproc 스탬프**. web-daemon 세션은 websocket으로 client가 붙는데도 manifest는 `inproc`. ⇒ **정직성 결함**. 02(stdio 스탬프)가 이 하드코드를 서피스별 실 transport로 바꿔야 함. web-daemon은 "websocket"으로 나와야 정직.
- `serverAutoContinues` — `base.ts:82` `base.serverAutoContinues === true`. web-daemon은 `runtime-factory.ts:822`에서 `WEB_INLINE_APPROVAL_GATE`(`QUANTA_INLINE_APPROVAL_RESOLVER`) 켜질 때만 true 스탬프. protocol normalize fallback = false(`protocol/session/capabilities.ts:35`). ⇒ **gate OFF서 정직하게 false로 wire에 나감. CLEAN.**

### 축 6 — knob 거버넌스: CLEAN

- `QUANTA_SESSION_EVENT_LOG_DIR` inventory 선언 `src/config/knob-inventory/extra.ts:838` (kind string, default undefined, group agent-feature, home runtime-config).
- readSite = `host/runtime/persistence.ts` — 실 read(`persistence.ts:29`)와 정직 일치. `knob-inventory-readsite-truthful-hellgate.test.ts` 가드 존재.
- CLI_FEATURE_GATES 시드 배열(`src/apps/cli/cli-feature-gates.ts`) **미포함** (grep 0 hit) = default-ON 사고 없음. string dir 노브라 애초에 시드 대상 아님. ✅

---

## 배선 필요 작업 목록

### GAP-1 (P1) — 서피스 durable-persist 배선-회귀 테스트 부재
- **무엇**: web-daemon(및 interactive CLI)이 `QUANTA_SESSION_EVENT_LOG_DIR` 설정 시 실제로 `<dir>/<sessionId>.jsonl`을 만드는지 잠그는 테스트. 현재 seam은 실배선이나(축1 LIVE) 서피스가 `createRuntime` 경로를 계속 타는지 보증하는 게 fake-host 유닛뿐.
- **어디에 배선**: `tests/integration/` — web-daemon `buildProductionRuntimeFactory` 또는 `createRuntimeFromAgentConfigBase` 세션을 `QUANTA_SESSION_EVENT_LOG_DIR=<tmp>`로 띄우고 한 턴 뒤 tmp에 `.jsonl` 존재+decode 가능 단언. red-on-injection = runtime-factory가 non-`createRuntime` 세션 경로로 바뀌면 red.
- **ROI**: 高. 05 전체가 이 disk 배선에 의존하는데 서피스 회귀를 잡는 테스트 0. 리팩터 1건이면 조용히 죽음.
- **테스트 갭**: 위가 곧 그 테스트.

### GAP-2 (P2, 02/03 종속) — durable replay 클라 소비자 부재
- **무엇**: 서버 durable replay(bridge.ts sendReplay/planDurableReplay)를 트리거하는 프로덕션 `resumeFromSeq` 발신자. 현재 repo 내 0 (connect 미호출·attach opt-out·프론트 repo밖).
- **어디에 배선**: (a) 웹 프론트 재접속 시 마지막 seq로 `connect{resumeFromSeq}` 발신 (repo 밖 번들, 03-B 소스 측), **또는** (b) `serve --stdio`(02/I)가 connect door 실사용하며 resume 경유. 어느 쪽도 이 repo main tree 밖/미구현.
- **ROI**: 中. 05 서버 코어는 완성이나 소비자 없이는 실효 0. 02·03 진행 전엔 배선 불가(대기 정당).
- **테스트 갭**: 소비자 생기면 그 서피스에서 실 reconnect→replayed e2e 필요. 현 durable-resume-restart는 raw client 직결이라 소비자-배선은 미증명.

### GAP-3 (P2, 02 스코프) — capability transport 스탬프 거짓말
- **무엇**: `transport: "inproc"` 하드코드가 web-daemon(websocket) 세션에서도 inproc으로 나감 = 정직성 결함.
- **어디에 배선**: `src/host/runtime/internal/context-binding/base.ts:77` — 하드코드를 서피스가 주입하는 실 transport 값으로. web-daemon composition-root(`runtime-factory.ts`)가 `transport:"websocket"`, connect stdio door가 `"stdio"`, in-proc 임베더가 `"inproc"` 스탬프하도록 base에 전파. (`serverAutoContinues` presence-only seam이 이미 있는 그 자리와 동일 패턴.)
- **ROI**: 中. 02가 명시적으로 이 스탬프를 스코프. 지금은 클라가 capabilities.transport로 분기하지 않아 무해하나, connect door 성숙 시 오분기 위험.
- **테스트 갭**: web-daemon 세션 manifest.transport === "websocket" 단언 + inproc 하드코드 회귀 red.

---

## 핵심 3줄
1. 코어 seam(runtime.ts:21 · engine durableLog 주입 · setupApprovalContinuation 배선)은 전부 실코드 LIVE이고 owner-local(durable-resume-restart CROWN·web-daemon approval e2e·runtime-event-log-resume)이 실 프로덕션 런타임을 타 강하다.
2. 진짜 dead-seam은 **의도된 외부 문 2개**(connect 내부호출 0·stdio-server 서버짝 0=serve --stdio 미구현)뿐 — 구조적으로 정상.
3. 배선 갭 3개: **서피스 disk-persist 회귀테스트 부재(GAP-1, 즉시 가능)** · durable replay 클라 소비자 부재(GAP-2, 02/03 종속) · transport:"inproc" 거짓 스탬프(GAP-3, 02 스코프).
