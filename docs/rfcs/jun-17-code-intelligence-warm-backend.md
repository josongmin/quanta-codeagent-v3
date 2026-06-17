# RFC: Code-Intelligence Warm Backend — 세션-시작 prewarm + first-call join + 엔진-교체 가능 추상화

- **상태**: Draft
- **날짜**: 2026-06-17
- **저자**: 세션 협업 (LSP warm-path 설계)
- **관련**: ADR-0015 (LSP nav 흡수), [src/agent/lsp-bridge.ts](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts), [src/lsp/ports.ts](/Users/songmin/quanta-codeagent-v3/src/lsp/ports.ts), [src/tool/lsp_nav/types.ts](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/types.ts), jun-16 LSP grounding django dead-end (pythonPath/didChangeConfiguration fix), jun-17 LSP steer grounding default-on

---

## 1. 요약 (TL;DR)

pyright 첫 LSP 호출의 2~6초 cold stall을 "첫 호출이 데우는 특수케이스"로 두지 않고 세 가지로 올린다.

1. **세션 시작 background prewarm** — Python workspace면 세션 부팅 시 background에서 workspace를 미리 띄운다. session bootstrap은 warm 완료를 기다리지 않는다(fire-and-forget).
2. **first-call join** — 첫 LSP 호출은 warm-up이 끝났으면 즉시 처리하고, 아직 진행 중이면 **이미 존재하는 cwd-key 공유 세션**에 join해서 기다린다. 기다리는 동안 침묵하지 않고 warm status progress를 즉시 보여준다.
3. **엔진-교체 가능 추상화** — 지금 [src/agent/lsp-bridge.ts](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts)의 warm/pool 층은 `SharedPyrightNavSession`으로 PYRIGHT 하드코딩되어 있다. 이걸 **제네릭 `SharedWorkspacePool` + 좁은 `WarmBackend` 인터페이스**로 쪼개서, 나중에 basedpyright나 readiness 의미가 다른 엔진(rust-analyzer 등)으로 교체 가능한 구조로 만든다.

핵심 불변식: **open()은 계속 ready session만 반환한다.** "session 먼저 반환하고 뒤에서 indexing"은 안 한다 — 첫 definition/hover correctness를 깨뜨리기 때문이다. prewarm은 *동일한* 공유 세션을 background에서 선행할 뿐, 계약을 바꾸지 않는다.

---

## 2. 동기

### 2.1 관찰된 문제

[src/tool/lsp_nav/index.ts:171](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/index.ts#L171)의 `openOrEmitUnavailable()`은 `provider.open()`을 **단일 await**로 호출하고, 그 앞에 progress를 내지 않는다. pyright workspace 부팅 + 초기 인덱싱은 large repo(Django)에서 2~6초가 걸리는데, 그 시간이 사용자에게 **침묵 blocking**으로 보인다. 첫 `analyzing ...` progress는 open이 끝난 *뒤에야* 나온다([src/tool/lsp_nav/index.ts:207](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/index.ts#L207)).

핵심은 "blocking 자체"가 아니라 "침묵 blocking"이다. blocking은 correctness를 위해 필요하다(아래 §3.2). 없애야 하는 건 침묵이다.

### 2.2 warm/pool 층이 pyright-특화다

현재 [src/agent/lsp-bridge.ts:174-475](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L174-L475)는 다음을 전부 `SharedPyrightNavSession` / `sharedPyrightSessions` / `openSharedPyrightNavSession()`으로 PYRIGHT에 묶어 두었다:

- cwd-key 세션 맵 + refcount + idle-TTL(`PYRIGHT_NAV_IDLE_TTL_MS = 30분`)
- `startPromise` join (서버부팅+초기인덱싱 = 비싼 부분의 공유 지점)
- `preparedFiles` / `preparingFiles` per-file 준비 dedup
- fatal-transport-error 시 teardown
- import-probe readiness 판정(`findPyrightImportProbe` / `runPyrightWarmup`)

그리고 분기는 [src/agent/lsp-bridge.ts:609](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L609)의 `if (spec === PYRIGHT)` 한 줄이다.

### 2.3 코드 감사 결과 — 진짜 pyright-특화는 둘뿐

위 목록을 읽어보면 **언어 무관**인 것과 **엔진 특화**인 것이 섞여 있다:

| 항목 | 언어 무관? | 비고 |
|---|---|---|
| cwd-key 맵 / refcount / idle-TTL | ✅ 무관 | 순수 pool lifecycle |
| `startPromise` join | ✅ 무관 | 모든 LSP가 start() 가짐 |
| `preparedFiles`/`preparingFiles` dedup | ✅ 무관 | didOpen 멱등성 |
| fatal-error teardown (`isFatalSharedSessionError`) | ✅ 무관 | transport 레벨 |
| client 생성 (`pyrightClientFactory`/spec) | ❌ **엔진 특화** | 어떤 서버를 띄우나 |
| readiness 판정 (`runPyrightWarmup`/import-probe) | ❌ **엔진 특화** | "이 파일에 대해 warm인지" 판정법 |

→ 진짜 varying axis는 **(a) 어떤 client를 띄우나, (b) 이 서버가 이 파일에 대해 warm인지 어떻게 아나** 둘뿐이다. 추상화 seam은 정확히 이 두 점에만 그어야 한다. 6-메서드 strategy를 만들면 백엔드마다 refcount/idle을 재구현하게 되는 잘못된 경계다.

### 2.4 엔진-교체 동기

- **basedpyright**: pyright 드롭인 포크 — 같은 LSP, 같은 import-probe readiness. 사실 이건 SERVERS 테이블에 `bin` 한 줄이면 끝이고 새 backend도 필요 없다.
- **readiness 의미가 다른 엔진**(rust-analyzer의 `ContentModified -32801` 기반 readiness, ty/pyrefly 등 차세대 Python type checker): 이때 비로소 엔진-swap 추상화가 값을 갖는다. 그래서 seam을 **readiness 중심**으로 잡는 게 §2.3 결론과 일치한다.

---

## 3. 목표 / 비목표

### 3.1 목표 (v1)

1. pyright pooled nav path에 대한 session-start background prewarm.
2. first-call join — 기존 cwd-key 공유 세션 재사용(새 promise 발명 금지).
3. open 대기 동안 visible warm-status UX.
4. 엔진-교체 가능한 warm 추상화 (`SharedWorkspacePool` + `WarmBackend`).
5. bench 세션 종료 시 즉시 evict (현존 leak 봉합).

### 3.2 불변식 (깨면 안 됨)

- **open()은 ready session만 반환** — premature session + 뒤에서 indexing 금지. 첫 def/hover correctness 보존.
- **django cross-file correctness 보존** — readiness probe(import 심볼 definition)가 warm 게이트이고, 이건 jun-16에서 고친 `pythonPath`(venv 우선 + extraPaths) + `didChangeConfiguration` push 경로([src/lsp/pyright.ts]의 buildWorkspaceConfiguration / base.ts initialized-후 push)를 **그대로** 탄다. warm 추상화는 이 경로를 건드리지 않는다.
- **session start는 prewarm으로 delay되지 않음** — fire-and-forget.
- **default-OFF / byte-identical** — knob 미설정 시 도구 surface·동작 변화 0.

### 3.3 비목표 (v1에서 안 함)

- diagnostics provider의 pooled/prewarmed 전환 (지금은 fresh-per-call 유지).
- TS/rust/go까지 같은 warm strategy 확장 (v1은 Python만).
- speculative multi-file prewarm.
- persistent cross-session cache.

---

## 4. 설계

### 4.1 상위 추상화는 불변

- `LspNavProvider` / `LspNavSession` 유지. 상위 tool/UI 안 건드린다: [src/tool/lsp_nav/types.ts:136](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/types.ts#L136).
- `@/lsp`의 `LspPort` 유지. 엔진 교체는 이 레벨 **아래에서** 흡수: [src/lsp/ports.ts:11](/Users/songmin/quanta-codeagent-v3/src/lsp/ports.ts#L11).

### 4.2 새 seam — pool과 backend 분리

기존 6-메서드 strategy 제안을 폐기하고, lifecycle(pool)과 엔진-특화(backend)를 분리한다.

```ts
/** 엔진-특화 = 딱 4점. lifecycle/refcount/idle/join은 절대 여기 없음. */
interface WarmBackend {
  readonly id: string                                  // "pyright" | "basedpyright" | ...
  supports(filePath: string): boolean                  // 확장자 → 이 backend가 처리?
  createClient(cwd: string): LspClient                 // = 기존 spec.create / pyrightClientFactory
  /** "이 파일에 대해 server가 warm인가"를 판정. true=verified-ready(혹은 probe 불필요),
   *  false=budget 소진(caller는 prepared 마킹 금지 → 다음 호출 재시도).
   *  pyright: import-probe definition. 다른 엔진: 각자의 readiness 신호. */
  ensureFileReady(client: LspClient, filePath: string, signal?: AbortSignal): Promise<boolean>
}

/** 제네릭 = 엔진 모름. 기존 SharedPyrightNavSession 머신을 그대로 일반화. */
class SharedWorkspacePool {
  constructor(backend: WarmBackend, opts?: { idleTtlMs?: number })
  /** ready session만 반환 (open 계약 보존). 내부에서 cwd-key entry 재사용 +
   *  startPromise join + ensureFileReady + refcount++ */
  open(filePath: string, cwd: string, signal?: AbortSignal): Promise<LspNavSession | null>
  /** background prewarm = open(anchor) 후 즉시 release. ref 0 → idle timer가
   *  세션을 살려둠 → 첫 실호출이 warm 맵 히트. 새 promise 안 만든다. */
  prewarm(anchorFile: string, cwd: string, signal?: AbortSignal): Promise<void>
  /** production teardown (test-only 아님). bench 세션 종료가 호출. */
  evict(cwd: string): Promise<void>
  disposeAll(): Promise<void>
}
```

매핑(기존 → 신규):

| 기존 | 신규 위치 |
|---|---|
| `SharedPyrightNavSession` | `SharedWorkspacePool`의 내부 entry 타입(제네릭) |
| `sharedPyrightSessions` 맵 | pool 인스턴스 내부 맵 |
| `openSharedPyrightNavSession()` | `pool.open()` |
| `runPyrightWarmup`/`findPyrightImportProbe` | `PyrightBackend.ensureFileReady()` |
| `pyrightClientFactory` | `PyrightBackend.createClient()` + test-seam 유지 |
| `PYRIGHT_NAV_IDLE_TTL_MS` 등 상수 | pool opts / backend 상수 |
| `__resetSharedPyrightSessionsForTest` | `pool.disposeAll()` (test가 호출) |

[src/agent/lsp-bridge.ts:609](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L609)의 `if (spec === PYRIGHT)`는 "이 spec에 warm-capable backend가 있나?" 조회로 치환된다. pyright만 backend 등록, 나머지는 기존 fresh-per-call.

### 4.3 first-call join은 "기존 맵"이 join 지점

새 "warm promise"를 따로 만들지 않는다. 코드를 보면 join 머신이 **이미** 있다:

- `sharedWorkspaceSessions`(cwd-key 맵) + `entry.startPromise`: 서버부팅+초기인덱싱이라는 **비싼 부분**이 cwd당 1회로 공유된다.
- `entry.preparingFiles.get(filePath)`: 같은 파일 동시 warm을 dedup한다.

따라서:
- `prewarm(anchor, cwd)` = 세션 시작에 `open(anchor, cwd)` 호출 후 ref 즉시 release. ref 0 → idle timer(30분)가 세션 살려둠.
- 첫 실호출 `open(file, cwd)` → 같은 cwd entry 히트 → `startPromise` 이미 resolved(또는 in-flight면 join) → 즉시.
- 첫 호출이 anchor와 **다른 파일**이면 `startPromise`는 공유(비싼 부분 절약), per-file didOpen만 새로 — 이게 올바른 동작.

### 4.4 anchor 선택 (v1 = Python만)

우선순위:
1. task-local Python file
2. repro / gold / localize candidate (bench)
3. active / anchor file (interactive)
4. deterministic synthesized Python anchor

(4)는 기존 `synthesizeLspAnchors`를 재사용한다: [src/agent/mention-injection/anchor-synth.ts:219](/Users/songmin/quanta-codeagent-v3/src/agent/mention-injection/anchor-synth.ts#L219). 이미 언어별 1앵커 맵을 deterministic하게 돌려주므로 결과에서 `.py` 엔트리만 집으면 된다.

**`targetLanguages` 옵션은 optional 최적화**다. polyglot repo에서 early-exit가 `found.size < allLanguages.size`([anchor-synth.ts:252](/Users/songmin/quanta-codeagent-v3/src/agent/mention-injection/anchor-synth.ts#L252))라 Python을 찾고도 다른 언어를 찾을 때까지 walk를 계속한다. large repo면 "Python 찾으면 즉시 중단"이 walk를 줄인다. 측정 후 필요하면 추가하고, v1 필수는 아님.

### 4.5 세션-시작 흐름

- [src/agent/types.ts:315](/Users/songmin/quanta-codeagent-v3/src/agent/types.ts#L315)의 기존 `prewarm`은 LLM/TTFM 의미로 고정 — **건드리지 않는다.** 새 슬롯 추가:
  ```ts
  lspPrewarm?: { enabled: boolean; warmSignal?: AbortSignal }
  ```
- [src/agent/loop/session-bootstrap.ts:70](/Users/songmin/quanta-codeagent-v3/src/agent/loop/session-bootstrap.ts#L70)의 `maybeRunSessionPrewarm()`는 그대로. 그 아래에 `maybeStartLspPrewarm(cfg, features)` 추가 — fire-and-forget background prewarm 시작, bootstrap은 warm 완료를 await 하지 않는다.
- `warmSignal`은 **세션 signal**을 받아 session end가 prewarm을 abort하게 한다. anchor에 import 심볼이 없으면 `ensureFileReady`가 즉시 true 반환(probe 불필요), 있으면 budget(현 `PYRIGHT_READY_TIMEOUT_MS=90s`) 내 polling — background라 무방.

### 4.6 wiring + gating

- interactive root: [src/host/runtime/agent-arg-builder.ts:504](/Users/songmin/quanta-codeagent-v3/src/host/runtime/agent-arg-builder.ts#L504)
- bench root: [src/runner/batch/eval/driver.ts:877](/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/driver.ts#L877)
- 게이트: `QUANTA_LSP_PREWARM=1` 권장. 단 **`QUANTA_LSP_TOOLS=full` 또는 `QUANTA_BENCH_LSP=1`일 때만** prewarm 허용 — nav 도구가 노출조차 안 됐는데 prewarm 하는 건 낭비다. gate 값 해석은 `@/shared`의 `gateOn` SSOT를 따른다(기존 vocab 통일 라쳇 존중).

### 4.7 호출 시 UX — 싼 것/비싼 것 분리

**v1 (싼 것, 침묵의 80% 제거):** [src/tool/lsp_nav/index.ts:164-192](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/index.ts#L164-L192)의 `openOrEmitUnavailable`에서 `provider.open()` **앞에** progress 한 줄을 emit한다:

```
initializing pyright workspace...
```

이걸로 stall 침묵이 사라진다. open이 join이면 그 동안 한 줄이 떠 있고, ready 후 기존 `analyzing <file>`([index.ts:207](/Users/songmin/quanta-codeagent-v3/src/tool/lsp_nav/index.ts#L207))이 이어진다.

**나중 (비싼 것, gold-plating — v1 deferred):** `joining pyright warm-up for <file>...` / `warming pyright workspace (2.1s elapsed)...` 같은 실시간 경과 메시지는 `open()`이 중간 상태를 스트리밍해야 해서 progress 콜백 seam이 필요하다. `LspNavProvider.open()` 시그니처는 유지하고, 필요해질 때 bridge에 `openWithStatus(onWarmTick)` 헬퍼를 별도로 둔다. v1은 pre-open emit(+ 필요시 단순 ticker)로 끝낸다 — 새 헬퍼 안 만든다.

### 4.8 lifecycle / 누수 방지 (v1의 진짜 correctness 결함)

현재 production 전체 teardown은 idle-TTL(30분)뿐이고, 전량 teardown은 `__resetSharedPyrightSessionsForTest`([lsp-bridge.ts:232](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L232)) **test-only**가 유일하다.

- **interactive**: idle TTL 유지 OK.
- **bench / full-corpus**: 세션 종료 시 **즉시 evict** 필요. 안 그러면 sandbox cwd별 pyright daemon이 TTL(30분) 동안 남아 누수된다. ← 이게 v1에서 우선순위 가장 높은 실결함이다.
- teardown 연결: [src/agent/features.ts:114](/Users/songmin/quanta-codeagent-v3/src/agent/features.ts#L114)의 cleanup 또는 [src/agent/loop/session-lifecycle.ts:79](/Users/songmin/quanta-codeagent-v3/src/agent/loop/session-lifecycle.ts#L79) session-end cleanup에 `pool.evict(cwd)` 배선. **test-only가 아닌 production dispose**를 새로 만든다.

---

## 5. 테스트 계획

기존 헬게이트 확장: [tests/unit/lsp-pyright-pool-hellgate.test.ts:1](/Users/songmin/quanta-codeagent-v3/tests/unit/lsp-pyright-pool-hellgate.test.ts#L1)

**pool/join:**
- background prewarm이 (한 cwd당) 한 번만 client를 띄운다.
- concurrent first open이 in-flight warm(startPromise)에 join한다 — client.start() 호출 1회.
- warm exhaustion 재시도 계약 유지(budget 소진 시 prepared 마킹 안 함).
- **teardown 후 leaked entry 0** (teeth: evict 후 맵 비고 client.stop() 호출됨; red-on-injection으로 leak 주입 시 RED).

**wire:**
- `QUANTA_LSP_PREWARM` unset/on/off × `QUANTA_LSP_TOOLS=full`/`QUANTA_BENCH_LSP=1` 매트릭스.
- interactive root wiring / bench root wiring.

**session bootstrap:**
- prewarm enabled지만 Python anchor 없으면 skip.
- prewarm failure는 swallow(세션 안 죽음).
- session start가 prewarm으로 delay 안 됨(await 없음 증명 — bootstrap 완료가 warm 완료를 기다리지 않음).

**UX:**
- open 대기 중 `initializing pyright workspace...` progress emit.
- ready 후 `analyzing <file>` 이어짐.

**backend swap (추상화 teeth):**
- fake `WarmBackend`(id≠pyright, scriptable readiness)를 pool에 주입 → pool lifecycle이 pyright 심볼 0으로 동작. (엔진-교체 가능성의 wiring-proof.)

## 6. 실측 (Django large repo)

비교 셋업:
1. cold start, prewarm 없음 (baseline)
2. cold session + background prewarm + 즉시 첫 호출 (join 경로)
3. prewarm 후 2~3초 delay + 첫 호출 (warm-hit 경로)

지표:
- session start overhead (prewarm이 부팅을 늦추지 않음 확인 → ~0)
- first usable LSP latency (baseline 2~6s → 목표: warm-hit 시 <300ms)
- warm definition latency
- leaked child count (bench evict 후 0)

n=1로 루프/임계값 바꾸지 않는다 — 측정 먼저(no-heuristics 원칙).

---

## 7. 구현 순서

1. **leak fix 먼저** — `SharedWorkspacePool.evict` + session-end 배선 + hellgate teeth. (현존 correctness 결함)
2. [src/agent/lsp-bridge.ts:174](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L174) warm/pool → `SharedWorkspacePool` 제네릭 추출.
3. `PyrightBackend`(createClient + ensureFileReady=import-probe) 이식. spec===PYRIGHT 분기 → backend 조회로 치환([lsp-bridge.ts:609](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge.ts#L609)).
4. anchor selection seam (synthesizeLspAnchors 재사용; targetLanguages는 측정 후 결정).
5. `lspPrewarm` config 슬롯 + CLI/bench wiring + gate.
6. session-start background prewarm hook(`maybeStartLspPrewarm`).
7. tool progress UX (pre-open emit, v1).
8. unit/wire/bootstrap/UX/backend-swap 테스트.
9. Django 실측 재검증.

---

## 8. 완료 기준

- 첫 LSP 호출이 prewarm 완료 상태면 cold 2~6초 stall이 사라진다.
- prewarm 미완료면 caller는 기존 공유 세션에 join해서 기다리되 progress가 즉시 보인다.
- current product path에서 Django cross-file definition/hover가 계속 맞는다.
- bench 세션 종료 후 pyright child가 누수되지 않는다(evict, leaked=0).
- warm backend가 pyright 전용 함수 뭉치가 아니라, lifecycle은 제네릭 pool이 갖고 엔진-특화는 `WarmBackend` 4점(id/supports/createClient/ensureFileReady)으로 좁혀진 교체 가능한 객체가 된다.

## 9. 미해결 / 후속

- diagnostics provider도 pooled/prewarmed로 올릴지 (지금 fresh-per-call) — ROI: edit-후 진단 반복 호출이 많으면 큼. 별도 RFC.
- TS/rust/go warm backend 확장 — readiness 의미가 달라 `ensureFileReady`만 backend별 구현하면 됨. v1 seam이 이걸 흡수하도록 설계되어 있는지가 backend-swap 테스트로 증명됨.
- 실시간 elapsed warm-status 스트리밍 (§4.7 비싼 것) — open progress 콜백 seam 필요.
- basedpyright: SERVERS 테이블 한 줄(같은 probe). 새 backend 불필요 — 등록만.
