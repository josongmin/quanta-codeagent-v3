# Surface ↔ Engine Protocol Unification — SessionProtocol-first 리비전

> 2026-06-11 · 작성 근거: 코드 실측(파일·라인 인용) + 공개 SOTA 패턴(Codex app-server, Claude Agent SDK, LSP).
> 목표: 엔진 공유는 이미 강하다는 전제를 유지하되, 남아있는 surface 배선 비효율을 **stable boundary protocol + 중앙 projection + 선언적 render registry**로 줄인다.

---

## 0. TL;DR

- 엔진 코어 공유 자체는 이미 잘 되어 있다. `createRuntimeFromAgentConfigBase`(`src/apps/web-daemon/runtime-factory.ts:296`)를 CLI와 web-daemon이 같이 쓴다.
- 현재 병목은 "엔진 미공유"가 아니라 **surface read model과 renderer가 여러 층에서 손배선**된 점이다.
- 다만 canonical boundary를 `AgentEvent`로 올리는 것은 아니다. 이 repo의 외부 경계는 이미 **versioned `SessionProtocol`** 이다:
  - `SessionEventEnvelope`(`src/protocol/session/events.ts`)
  - `SESSION_PROTOCOL_VERSION = "session.v1"`(`src/protocol/session/version.ts`)
  - snapshot/replay/seq/revision/causality(`src/protocol/session/codec.ts`, `src/kernel/session/replay-lite.ts`)
- 따라서 목표 아키텍처는 **`AgentEvent`를 그대로 wire SSOT로 승격**하는 것이 아니라:
  1. `AgentEvent` = 엔진 내부 관측 이벤트
  2. `SessionProtocol` = 제품 경계의 canonical protocol
  3. `AgentState`/canvas/observability = 중앙 projection layer가 만든 **파생 read model**
- command 쪽도 generic queue로 평탄화하지 않는다. 이미 검증된 split대로:
  - **readout** = out-of-band query
  - **mutation / live steering** = typed control channel 또는 session verb

---

## 1. 현황 진단 (코드 실측)

### 1.1 공유되는 것 — 엔진

- web-daemon `src/apps/web-daemon/runtime-factory.ts:296` → `createRuntimeFromAgentConfigBase` 호출.
- 동일 슬라이스 공유: `@/sdk/runtime`, `@/host/runtime`, `@/runner/*`.
- web-daemon에 별도 agent loop 재구현은 없다. 이 점은 이미 SOTA 축에 가깝다.

### 1.2 실제 boundary는 이미 하나 있다 — `SessionProtocol`

이 문서의 첫 버전은 "이벤트 어휘가 3개 평행"이라는 진단 자체는 맞았지만, **어느 층이 제품 경계인가**를 잘못 잡았다.

| 층 | 위치 | 역할 |
|---|---|---|
| `AgentEvent` | `src/stream/types.ts` | 엔진 in-proc stream. 가장 rich 하지만 boundary metadata가 없다. |
| `SessionEvent` + snapshot + command | `src/protocol/session/*` | **제품 경계의 versioned protocol**. `eventId/seq/revision/causedByCommandId`와 snapshot/replay를 가진다. |
| `AgentStateObservation` | `src/protocol/agent-state/messages.ts` | web용 point-in-time side channel. 9개 event subset projection이다. |

중요한 점:

- `SessionEvent`는 단순 projection이 아니다. `SessionEventEnvelope`는 `eventId/seq/revision/emittedAt/causedByCommandId`를 가진다 (`src/protocol/session/events.ts:13`).
- transport는 이미 snapshot + replay tail semantics를 가진다 (`src/sdk/runtime/session.ts`, `src/ipc/session/bridge.ts`).
- protocol version도 이미 별도 고정돼 있다 (`src/protocol/session/version.ts:1`).

즉 현재 외부 contract는 `AgentEvent`가 아니라 `SessionProtocol`이다.

### 1.3 진짜 비효율 — projection과 renderer가 분산돼 있다

문제의 핵심은 아래다.

1. **projection logic 분산**
   - `AgentEvent -> SessionEvent` 일부가 `src/kernel/session/scheduler.ts` 안 hand-written reducer로 들어가 있다.
   - `AgentEvent -> AgentStateObservation`는 `src/protocol/agent-state/messages.ts` 쪽 별도 mapper를 쓴다.
   - side-channel별로 별도 projection 규칙이 생겨 drift 위험이 있다.

2. **renderer 분산**
   - CLI는 여러 파일에서 `switch`로 이벤트를 직접 렌더한다.
   - `turn-summary.ts`는 `AgentEvent`를 본다.
   - `attach/render.ts`는 `SessionEvent`를 본다.
   - 같은 semantic이 서로 다른 message family에서 따로 렌더된다.

3. **coverage truth 부재**
   - "어떤 surface가 어떤 이벤트/read model을 지원하는가"가 코드에서 선언적으로 한곳에 모이지 않았다.
   - 그래서 built-not-wired, orphaned UI, parity lag가 생긴다.

### 1.4 첫 버전 문서에서 과장/오진이었던 점

- `AgentStateObservation` 9종 목록은 정확히 다시 세야 한다. 실제 9개는
  `plan_created`, `plan_updated`, `plan_snapshot`,
  `plan_user_input_requested`, `plan_user_input_resolved`,
  `mode_changed`, `tool_progress`, `context_compacted`, `ratelimit_snapshot`
  이다 (`src/protocol/agent-state/messages.ts:87`).
- "web는 agentState 9개만 받는다"는 표현도 정확하지 않다.
  web은 이미 `SessionProtocol`의 `snapshot` + `event` tail을 받는다 (`src/apps/web-daemon/README.md:41-50`, `src/sdk/runtime/session.ts:251-273`).
  `agentState`는 추가 side channel일 뿐이다.
- `web parity ~15-20%`는 event transport coverage가 아니라 **slash/readout 실행 parity** 문맥이다 (`docs/plans/jun-9-cli-web-parity/00-index.md:9-17`).

> 결론: 병은 "이벤트가 3개라서"가 아니라, **stable boundary 위에 놓일 projection/read-model/renderer ownership이 흩어져 있다**는 것이다.

---

## 2. 공개 SOTA에서 가져올 원칙

### 2.1 Codex app-server

공식 문서상 Codex app-server는:

- bidirectional JSON-RPC 2.0 기반 protocol
- 여러 transport 지원
- rich client가 같은 protocol을 소비

즉 SOTA 포인트는 **"내부 이벤트를 그대로 노출"**이 아니라 **"versioned boundary protocol을 transport-agnostic하게 유지"**하는 데 있다.

### 2.2 Claude Agent SDK

공식 문서상 Claude Agent SDK는:

- Claude Code와 같은 tools / loop / context management를 SDK로 노출
- partial stream event를 typed message로 제공

여기서 가져올 핵심은 **shared engine + typed stream contract**다.  
반대로, "반드시 제품 전체가 단 하나의 raw event union만 가져야 한다"까지 일반화할 근거는 공개 문서만으로는 부족하다.

### 2.3 LSP

LSP가 주는 정석은 두 가지다.

- boundary는 JSON-RPC 위의 stable protocol
- capability negotiation은 initialization 시 교환되는 별도 contract

즉 capability는 "이 surface가 지원하는 기능/shape"를 말하지, 현재 repo의 `CapabilityManifest`처럼 runtime 기능 요약과 혼합하면 안 된다.

> 요약하면 공개 SOTA가 지지하는 방향은:
> `internal stream` 1개가 아니라,
> **stable boundary protocol 1개 + derived read models + transport independence + explicit capability/subscription contract** 다.

---

## 3. 수정된 목표 아키텍처

```
        ┌──────────────────── ENGINE / LOOP (shared) ────────────────────┐
        │  @/sdk/runtime · @/host/runtime · @/runner/*                   │
        │  emits internal AgentEvent                                      │
        └──────────────────────────────┬──────────────────────────────────┘
                                       │
                                       ▼
                     ┌─────────────────────────────────────┐
                     │  Projection Layer (central SSOT)    │
                     │  AgentEvent -> SessionProtocol v2   │
                     │  AgentEvent -> AgentState / canvas  │
                     │  AgentEvent -> observability views  │
                     └───────────────┬───────────────┬─────┘
                                     │               │
                                     ▼               ▼
                    canonical boundary         derived side channels
                  SessionEvent + Snapshot      agentState / canvas / obs
                  + SessionCommand
                                     │
             ┌───────────────────────┼────────────────────────┐
             ▼                       ▼                        ▼
      transport: in-proc      transport: websocket    transport: stdio
      / attach bridge         / web-daemon            / future IDE host
             │                       │                        │
             ▼                       ▼                        ▼
       CLI render registry     Web render registry      IDE render registry
```

### 핵심 결정

1. **Canonical boundary는 `SessionProtocol vNext`다**
   - `AgentEvent`를 boundary로 승격하지 않는다.
   - `SessionEvent`/snapshot/command가 여전히 제품 경계의 SSOT여야 한다.
   - 필요하면 `session.v2`를 열되, seq/revision/replay/causality semantics를 유지한다.

2. **Projection layer를 중앙화한다**
   - `AgentEvent -> SessionEvent`
   - `AgentEvent -> AgentStateObservation`
   - `AgentEvent -> canvas/observability`
   를 각각 흩어진 hand-written mapper로 두지 말고 한 군데에서 owning 한다.

3. **Renderer는 각 surface당 declarative registry로 모은다**
   - 단, 섣불리 모든 소비자를 하나의 raw event family로 합치지는 않는다.
   - CLI attach는 `SessionEvent` registry 위에,
   - timeline/summary는 필요하면 `AgentEvent` 또는 projected summary event 위에,
   - web는 `SessionEvent + derived side channels` 위에 선언적으로 올린다.

4. **Capability와 render coverage를 분리한다**
   - 현재 `CapabilityManifest`는 approvals/tools/memory/transport 같은 runtime feature 요약이다 (`src/protocol/session/capabilities.ts`).
   - 여기에 "렌더 가능한 event set"을 섞지 않는다.
   - 별도 `SurfaceSubscription` 또는 `SupportedReadModels` contract를 둔다.

5. **Command split을 유지한다**
   - readout은 out-of-band query로 유지한다.
   - mutation / steering은 typed `control-request` 또는 session verb로 유지한다.
   - running turn generic queue를 기본값으로 도입하지 않는다.

6. **Ratchet은 coverage에 건다**
   - 모든 internal event를 모든 surface가 직접 받아야 한다는 식이 아니다.
   - 대신 각 surface가 선언한 read model에 대해:
     - renderer 존재
     - unsupported면 명시적 이유 존재
     - projection inventory 최신
     를 CI로 강제한다.

---

## 4. 마이그레이션 (점진, byte-identical 우선)

| Phase | 내용 | 리스크 | 산출 |
|---|---|---|---|
| **0. truth inventory** | `AgentEvent 36` / `SessionEvent` / `AgentState 9` / web readout parity를 **축별로 따로** 카탈로그화 | 0 | 거짓 결론 제거 |
| **1. renderer registry** | CLI/web의 scattered switch를 surface별 registry로 추출 | 낮음 | built-not-wired 방지 |
| **2. central projection** | `scheduler.ts`와 agent-state mapper의 event projection을 중앙 projection layer로 이동 | 중 | projection drift 차단 |
| **3. session.v2 필요성 판단** | 현 `session.v1`에서 부족한 필드만 보강할지, v2를 열지 결정 | 중 | boundary 명확화 |
| **4. subscription contract** | `CapabilityManifest`와 별개로 `SupportedReadModels`/subscription 선언 추가 | 중 | coverage truth 확보 |
| **5. selective expansion** | web에 필요한 read model만 확장. raw 36 event full fanout은 목표 아님 | 중 | parity 향상, 과전송 방지 |
| **6. command revisit** | event/read-model 정리 후에만 mutation wire 재검토 | 중-상 | lease 의미 보존 |

### 단계별 원칙

- **Phase 0 이전에 "canonical을 AgentEvent로" 같은 결론을 내리지 않는다.**
- **Phase 1은 구조 리팩터만** 한다. 동작은 byte-identical이어야 한다.
- **Phase 2의 ownership seam**은 명확해야 한다. projection source-of-truth를 한 군데로 모아야 한다.
- **Phase 6은 마지막**이다. command semantics는 concurrency/authority와 직결되므로 event-side 정리 후에 다룬다.

---

## 5. 비목표 / 금지선

- ❌ CLI를 네트워크 daemon에 강제 종속시키지 않는다.
- ❌ `AgentEvent`를 그대로 wire protocol로 노출하지 않는다.
- ❌ readout을 WS turn channel에 얹지 않는다. 이건 이미 jun-09 audit에서 반증됐다.
- ❌ `CapabilityManifest`를 render coverage manifest로 오용하지 않는다.
- ❌ running turn mutation을 generic queue로 뭉개서 authority/ordering semantics를 흐리지 않는다.
- ❌ "web도 raw 36 event를 다 받아야 한다"를 목표로 삼지 않는다. 필요한 read model을 선언적으로 받는 것이 목표다.

---

## 6. 기대 ROI

- 기능 추가 비용을 `N x M hand wiring`에서 `projection 1 + registry entry` 수준으로 줄일 수 있다.
- built-not-wired / orphan UI / parity lag를 coverage ratchet로 구조적으로 차단할 수 있다.
- reconnect / replay / causality 같은 이미 가진 강점을 버리지 않고 surface 확장을 할 수 있다.
- IDE/Tauri 같은 future surface도 raw engine coupling 없이 붙일 수 있다.

---

## 7. 바로 할 다음 일

1. `truth inventory`부터 만든다.
   - `AgentEvent 36`
   - `SessionEvent 실제 type 목록`
   - `AgentState 9`
   - web이 이미 받는 `SessionProtocol` vs 추가 side channel
   - slash/readout parity 수치와 event transport coverage 수치 분리
2. CLI render registry PoC를 작은 범위에 적용한다.
   - statusLine / pills / attach text 같은 built-not-wired가 잦은 surface부터
3. projection ownership 리팩터 초안을 만든다.
   - `scheduler.ts`
   - `agent-state` mapper
   - 필요한 observability/canvas mapper

> 이 리비전의 핵심 차이:
> **"단일 프로토콜"은 맞다. 다만 그 단일 프로토콜은 `AgentEvent`가 아니라 `SessionProtocol`이어야 한다.**
