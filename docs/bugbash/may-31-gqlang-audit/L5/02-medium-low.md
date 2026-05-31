# L5 — MEDIUM / LOW findings + Cross-cutting themes

검증 상태 범례는 [README.md](README.md) 참조. medium/low는 대부분 단일 verifier 통과(검증됨) 또는 adversarial 단독 — 수정 착수 전 라인 재확인 권장. 경로는 repo root 기준, 라인은 HEAD `57d78b8a`.

---

## 🟡 MEDIUM

### M-1 · host-runtime · MCP client `stop()` 실패 무음
- **위치:** [context-binding.ts:949](../../../../src/host/runtime/internal/context-binding.ts#L949) · **상태:** [검증됨]
- **근거:** MCP client `stop()` 실패가 `.catch(() => undefined)`로 무음 → 자원 누수/좀비 프로세스 미탐지.
- **수정:** catch에 `logger.warn` 추가.

### M-2 · host-runtime · side conversation에 독립 취소 토큰 부재
- **위치:** [context-binding.ts:1022-1036](../../../../src/host/runtime/internal/context-binding.ts#L1022) · **상태:** [검증됨] · missing-feature
- **근거:** side-conv가 부모 signal만 상속하고 자체 취소 토큰을 노출 안 함 → runaway side-conv를 부모 턴 중단 없이 못 끊음.
- **수정:** 별도 `AbortController` 생성 후 부모 signal과 결합(`AbortSignal.any` 또는 수동 link).

### M-3 · host-runtime · 동시 동일 actionKey tool 호출 시 둘째가 배치 중단
- **위치:** [context-binding.ts:636-647](../../../../src/host/runtime/internal/context-binding.ts#L636) · **상태:** [검증됨] · race-cancellation
- **근거:** 동일 actionKey의 동시 tool 호출에서 첫 호출이 grant를 소비(638), 둘째는 `RuntimeApprovalRequiredError`로 throw → 동시 배치 중단. (H-1과 같은 grants 구조에서 파생.)
- **수정:** in-flight approval dedup 캐시 또는 grant 소비를 동시성-safe하게.

### M-4 · kernel-session · reducer switch에 `default: assertNeverCommand` 부재
- **위치:** [reducer.ts:71-238](../../../../src/kernel/session/reducer.ts#L71) · **상태:** [검증됨] · code-quality
- **근거:** command discriminated union switch에 exhaustiveness 가드 부재. 새 command 추가 시 컴파일 타임 미검출(forward-compat 구멍).
- **수정:** `default: return assertNeverCommand(command)` 추가.

### M-5 · kernel-session · `onCommitted` 실패가 turn 실패와 구분 없이 generic catch
- **위치:** [scheduler.ts:493-530](../../../../src/kernel/session/scheduler.ts#L493) · **상태:** [검증됨] · error-swallow
- **근거:** stream 이벤트 체인 내 `onCommitted`(DB 영속화 등) 실패가 turn 실패와 섞여 line 530 generic catch로 묻힘 → 핵심 영속화 실패가 turn 오류로 오인.
- **수정:** `onCommitted`를 별도 try-catch로 감싸 진단 이벤트/로그 분리.

### M-6 · apps-agent · interactive가 base signal 무시하고 controller 2개 생성
- **위치:** [interactive.ts:63-64, 121](../../../../src/apps/agent/mode-presets/interactive.ts#L63) · **상태:** [검증됨] · race-cancellation
- **근거:** interactive가 `req.base.signal`을 무시하고 자체 controller(63, 실사용) + stubBase fallback throwaway(121) 2개 생성. "한 모드당 취소점 하나" 원칙 위반(H-2 정리와 함께).
- **수정:** 단일 controller로 통일, base signal 우선 사용.

### M-7 · apps-agent · mode별 필수 필드 검증이 프리셋 런타임까지 지연
- **위치:** [index.ts:606-623](../../../../src/apps/agent/index.ts#L606) (예: headless `--prompt` 검증이 [headless.ts:89](../../../../src/apps/agent/mode-presets/headless.ts#L89)) · **상태:** [검증됨] · missing-feature
- **근거:** headless `--prompt` 등 mode 필수 필드 검증이 프리셋 런타임까지 미뤄져 generic fatal+exit 1로 떨어짐(FP-A 참조). CLI 파서/컴포지션 루트에서 조기 검증해 `exit 64`(EX_USAGE)로 매핑 가능.
- **수정:** `parseAgentArgs`로 검증 이동, mode-specific 필수 필드 early-validate.

### M-8 · apps-eval-bench · 5초 blocking sleep이 signal과 race 안 함
- **위치:** [python-swebench.ts:300-307](../../../../src/apps/bench/python-swebench.ts#L300) · **상태:** [검증됨] · race-cancellation
- **근거:** transient-crash 재시도 sleep이 abort와 race하지 않음 — signal이 생겨도(H-5) sleep이 취소를 블록.
- **수정:** `Promise.race([setTimeout(...), abortPromise])`.

### M-9 · apps-eval-bench · JSONL result-store append 경합
- **위치:** [result-store.ts:88-97](../../../../src/apps/bench/eval/result-store.ts#L88) · **상태:** [검증됨] · race-cancellation
- **근거:** `Map.get/set` 비원자성으로 동일 runId 동시 append 시 promise 체인 중복·enqueue 유실 → JSONL 줄 인터리브 손상 가능.
- **수정:** waiter `resolved` 플래그 또는 per-runId 직렬화 락.

### M-10 · runner-core · SQLite `new Database()` 생성에 signal 미스레드
- **위치:** [session-memory-auto.ts:191-193](../../../../src/runner/session-memory-auto.ts#L191) · **상태:** [검증됨] · race-cancellation
- **근거:** DB open이 signal을 안 받음 → 세션 abort 시 DB 락 대기로 취소 hang.
- **수정:** `Promise.race`로 signal과 경쟁하거나 open을 abortable하게.

### M-11 · runner-core · setInterval scan 핸들이 세션 teardown에 미배선
- **위치:** [search-pipeline.ts:248-255](../../../../src/runner/assemble/search-pipeline.ts#L248) · **상태:** [검증됨] · wiring-bug
- **근거:** delta-scan `setInterval`이 새 파이프라인 생성 시(global singleton `activeWire`)에만 clear. `unref()`(253-254)로 프로세스 종료는 안 막지만 장수명 세션에서 계속 스캔하며 dispose 경로 부재.
- **수정:** `WiredSearchPipeline`에 `dispose()` 추가, 세션 teardown(context-binding close)에 배선.

### M-12 · runner-assemble · 메트릭 실패 빈 catch (safeObserve)
- **위치:** [search-index-backend.ts:157-169](../../../../src/runner/assemble/search-index-backend.ts#L157) · **상태:** [검증됨] · silent-error
- **근거:** 메트릭 관측 실패가 빈 catch + 주석만 → '미설정' vs '무음 실패' 구분 불가.
- **수정:** `logger.warn` 추가(또는 debug 레벨이라도 신호 남김).

### M-13 · runner-assemble · 명시 store invalid 시 소비자 인터페이스에 신호 없음
- **위치:** [search-index-backend.ts:686-695](../../../../src/runner/assemble/search-index-backend.ts#L686) · **상태:** [검증됨] · silent-error
- **근거:** H-4의 인터페이스 측면 — disabled backend가 정상 backend와 동일 shape이라 소비자가 "깨진 상태"를 감지·적응할 수 없음.
- **수정:** H-4 수정안 (2)와 동일(`disabled`/`error` 플래그 노출).

### M-14 · apps-cli-surfaces · external-prompt-queue waiter cleanup이 abort와 race
- **위치:** [external-prompt-queue.ts:44-55](../../../../src/apps/cli/repl/external-prompt-queue.ts#L44) · **상태:** [검증됨] · race-cancellation
- **근거:** `next()`의 waiter cleanup이 abort 이벤트와 race — push()의 shift/resolve와 onAbort filter가 동일 waiter를 동시 조작하면 큐 불일치.
- **수정:** waiter에 `resolved` 플래그 추가, resolve/reject 멱등 보장.

---

## 🔵 LOW

### L-1 · host-runtime · `describe()`가 호출마다 새 UUID 생성 가능
- **위치:** [context-binding.ts:972](../../../../src/host/runtime/internal/context-binding.ts#L972) · **상태:** [검증됨] · code-quality
- **근거:** `base.sessionId ?? crypto.randomUUID()` — sessionId 부재 시 호출마다 다른 UUID(불변성 계약 위반).
- **수정:** `getSessionId(base)` 사용 또는 fail-fast assert.

### L-2 · host-runtime · side-conv ID suffix가 `Math.random` (~33비트)
- **위치:** [context-binding.ts:592-593](../../../../src/host/runtime/internal/context-binding.ts#L592) · **상태:** [검증됨] · code-quality
- **근거:** `Math.random().toString(36).slice(2,10)` — 급속 spawn 시 충돌 위험.
- **수정:** crypto 기반 suffix(`crypto.randomUUID().slice(...)` 등).

### L-3 · kernel-session · `new SingleWriterLease()` 직접 인스턴스화 (DIP 위반)
- **위치:** [state.ts:103](../../../../src/kernel/session/state.ts#L103) · **상태:** [검증됨] · solid-violation
- **근거:** lease를 직접 `new` → 테스트 주입 불가, 구현 결합.
- **수정:** optional `lease` 파라미터로 주입(기본값은 현 구현).

### L-4 · runner-core · 미등록 `QUANTA_*` env 무음 무시
- **위치:** [knobs/resolve.ts:39-55](../../../../src/runner/knobs/resolve.ts#L39) · **상태:** [검증됨] · silent-error
- **근거:** 인식 안 되는 `QUANTA_*` env가 무음 무시 → 오타가 silent failure.
- **수정:** strict 모드에서 unrecognized 키 warn(점진 도입).

### L-5 · apps-agent · `assembleAgentConfig` 반환값 미사용 (side-effect only)
- **위치:** [batch.ts:139](../../../../src/apps/agent/mode-presets/batch.ts#L139) · **상태:** [검증됨] · code-quality
- **근거:** 반환값 버리고 side-effect만 사용 — 의도적이나 least-surprise 위반.
- **수정:** 검증 로직을 별도 함수로 추출하거나 반환값 명시 사용.

---

## Cross-cutting themes

### 1. 취소 경로 미완 (가장 중요)
C-1 / H-2 / H-5 / H-8 + M-2 / M-6 / M-8 / M-10 / M-11 / M-14가 모두 동일 패턴: **AbortSignal이 컴포지션 루트에서 host/kernel/bench/SQLite/interval까지 끝까지 스레드되지 않는다.** 커널 핸들러는 no-op(C-1), 5개 모드는 dead signal(H-2), dispatch는 signal을 무시(H-8), bench는 통로조차 없음(H-5). **개별 패치보다 "AbortSignal을 일급으로 끝까지 스레드"하는 단일 횡단 작업으로 묶는 것을 강력 권장** — 안 그러면 두더지잡기.

### 2. teardown 자원정리 누락
H-7(runtimeFacade/watcher) / M-1(MCP client) / M-11(setInterval) / M-10(SQLite) — close/dispose가 세션 teardown 훅에 일관되게 미배선. 정상 경로에선 GC가 가리지만 비정상 종료/장수명 세션에서 누수. **세션 lifecycle에 단일 `dispose()` 집결점**을 두고 모든 자원을 등록하는 패턴 권장.

### 3. 무음 폴백 / 삼킴
H-3(bridge) / H-4(invalid store) / H-6(logger 미import) / M-12(safeObserve) / L-4(env) — 오류를 정상 빈-결과로 매핑하거나 logger 미배선으로 진단을 잃음. 특히 H-4/H-6은 "오타·설정 실수가 silent하게 기능을 죽이는" 운영 함정. **fail-loud(throw) 또는 최소 logger.warn**을 일관 적용.
