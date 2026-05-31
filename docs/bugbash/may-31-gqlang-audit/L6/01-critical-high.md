# L6 — CRITICAL / HIGH findings

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준.

---

## 🔴 CRITICAL

### C1. 동시 `close()`가 첫 Promise를 영구 hang
- **위치:** [src/realtime/default-adapter.ts:287-319](../../../../src/realtime/default-adapter.ts#L287)
- **카테고리:** race-cancellation · **상태:** [확인됨]
- **근거:** 가드(line 288)가 `status === "closed" || !ws`만 검사하고 `"closing"`을 빠뜨림. 단순 핸들러 덮어쓰기는 line 299의 `prevOnClose` 체이닝으로 막혀 있으나, 두 번째 `close()`가 진입한 순간 소켓이 이미 닫혀 있으면 line 311-313 "already-closed path"가 **두 번째 Promise만** resolve하고 첫 핸들러(H1)는 호출되지 않아 첫 `close()`가 영구 hang. port.ts:87의 idempotent 계약 위반.
- **수정:**
  ```ts
  if (status === "closed" || status === "closing" || !ws) return ok(undefined)
  ```

### C2. iterator throw 시 stream-timeout 타이머 누수
- **위치:** [src/llm/stream-timeout.ts:183-185](../../../../src/llm/stream-timeout.ts#L183)
- **카테고리:** race-cancellation · **상태:** [확인됨]
- **근거:** `await Promise.race([nextPromise, timeoutPromise])`(line 184)에서 `iter.next()`가 reject로 race를 이기면 line 184가 throw하여 line 185 `clearTimer(timerHandle)`가 실행되지 않음. 타이머는 `ms` 후 self-heal되지만, 빠르게 연속 reject하는 스트림에서는 `ms`-분량의 `setTimeout` 핸들이 누적되어 event loop를 붙잡음.
- **수정:** race를 `try/finally`로 감싸 어떤 예외에서도 `if (timerHandle !== undefined) clearTimer(timerHandle)`가 실행되도록.

---

## 🟠 HIGH

### H1. Responses wire의 bare 콜백이 스트림을 abort (systemic)
- **위치:** [src/llm/openai-responses-wire.ts:404, 444-445, 462, 477](../../../../src/llm/openai-responses-wire.ts#L444)
- **카테고리:** error-swallow · **상태:** [확인됨 — synthesis 중 소스 확인]
- **근거:** `onReasoning`/`onOutputItemDone`/`onCompleted`가 try-catch 없는 옵셔널 체이닝 호출. 같은 파일 `notifyChunkArrival`(82-88)은 감싸지만 이것들만 누락. 콜백(checkpoint/observability sink)이 throw하면 `parseResponsesEvents` 밖으로 전파되어 toolCalls 맵이 깨지고 continuation store가 stale 상태로 남음. types.ts의 "best-effort" 계약 위반.
- **수정:** 각 호출을 `notifyChunkArrival`과 동일하게 래핑: `try { opts.onX?.(...) } catch { /* best-effort */ }`

### H2. `finalizeCalls`가 스트림 try-catch 밖에서 실행
- **위치:** [src/llm/adapters/openai.ts:446-452](../../../../src/llm/adapters/openai.ts#L446)
- **카테고리:** error-swallow · **상태:** [확인됨 — synthesis 중 소스 확인]
- **근거:** line 441의 `for await`는 try/catch(442-443, LLMError로 래핑) 안이지만, line 446 `yield* finalizeCalls(st.pending)`는 밖. malformed tool JSON에서 `parseToolInputOrThrow` 실패가 비구조화 Error로 탈출 → agent loop의 retry/분류 로직 무력화.
- **수정:** line 446-452를 try 블록 안으로 이동.

### H3. ChatGPT-OAuth 모델 카탈로그 캐시 thundering herd
- **위치:** [src/llm/adapters/chatgpt-oauth.ts:162-200](../../../../src/llm/adapters/chatgpt-oauth.ts#L162)
- **카테고리:** race-cancellation · **상태:** [검증됨]
- **근거:** 캐시 체크(162-165)와 async fetch+store(174-200)가 비동기화. 같은 `account_id`의 동시 스트림이 전부 miss하여 중복 `/models` 요청을 발사 → 429 cascade 위험. `RefreshCoordinator`가 이미 올바른 in-flight-dedup 패턴을 보유.
- **수정:** in-flight `Map<accountId, Promise<ModelCatalog>>` 추가하여 pending Promise를 캐싱, 동시 caller가 단일 fetch를 await.

### H4. OAuth refresh의 빈 `access_token` / 비검증 `expires_in`
- **위치:** [src/auth/chatgpt-oauth/refresh.ts:44, 72](../../../../src/auth/chatgpt-oauth/refresh.ts#L44)
- **카테고리:** correctness-bug · **상태:** [검증됨]
- **근거:** 타입만 검사하여 빈 토큰(→ 호출 시 spurious 401)과 음수/비유한 `expires_in`(→ 즉시 만료 토큰)이 통과. `github-token-rotation.ts:143,148` 및 `oidc-federation.ts:255`와 불일치.
- **수정:**
  ```ts
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) throw …
  if (!Number.isFinite(expSec) || expSec <= 0) throw …
  ```

### H5. Snapshot 디코더가 중첩 필드 검증 전무 (DoS surface)
- **위치:** [src/protocol/session/codec.ts:100-110](../../../../src/protocol/session/codec.ts#L100)
- **카테고리:** missing-feature · **상태:** [검증됨]
- **근거:** `sessionId/revision/seq`만 검증하고 `state`/`capabilities`/`pendingApproval`/`openArtifacts`는 unsafe `as unknown as` 캐스트로 통과. downstream(`bridge.ts:85`, `replay-lite.ts:50`)이 이를 역참조 → malformed 신뢰불가 snapshot에서 crash/DoS.
- **수정:** `state`가 필수 속성 가진 객체인지, `capabilities` shape, `pendingApproval`이 null-or-object, `openArtifacts`가 array인지 검증.

### H6. Command/event 디코더가 타입별 필드 검증 생략
- **위치:** [src/protocol/session/codec.ts:51-75, 68-91](../../../../src/protocol/session/codec.ts#L51)
- **카테고리:** missing-feature · **상태:** [적대적-미검증] (verified medium "presence but not types"와 pair)
- **근거:** `assertCommonMetadata`는 key 존재와 `type`만 검사. 명령/이벤트별 필수 필드(`InputAppendCommand.text`, `ApprovalRespondCommand.approvalId/decision`, `TurnCompletedEvent.outcomeReason` 등)는 unsafe 캐스트 전 미검증 → 핸들러 레벨 runtime 실패.
- **수정:** 메타데이터 체크 후 타입별 discriminated guard 추가. (H5와 한 패스로 통합 권장)

### H7. `prevOnClose` 호출 unguarded — throw 시 `close()` hang
- **위치:** [src/realtime/default-adapter.ts:299](../../../../src/realtime/default-adapter.ts#L299)
- **카테고리:** error-swallow · **상태:** [검증됨]
- **근거:** `if (prevOnClose) prevOnClose.call(socket, ev)`에 try-catch 없음. throw 시 line 300의 `resolve()`를 건너뛰어 close Promise hang. (C1과 동일 함수, 별개 결함.)
- **수정:** `try { prevOnClose?.call(socket, ev) } catch { /* ignore */ }`

### H8. 메시지 dispatch 루프가 첫 throw 핸들러에서 중단
- **위치:** [src/realtime/default-adapter.ts:133](../../../../src/realtime/default-adapter.ts#L133) (+ [headless-stub.ts:184](../../../../src/realtime/headless-stub.ts#L184))
- **카테고리:** error-swallow · **상태:** [검증됨]
- **근거:** `for (const h of snapshot) h(msg)` — 한 핸들러가 throw하면 형제 구독자 오염. `event-bridge.ts:204-213` / `ws-adapter.ts:138-143`의 문서화된 isolation 계약과 모순.
- **수정:** `for (const h of snapshot) { try { h(msg) } catch { /* isolate */ } }`

### H9. FallbackLock 체인이 thrown 예외에 깨짐 (acquire & release)
- **위치:** [src/auth/lock-redis-stub.ts:75-91](../../../../src/auth/lock-redis-stub.ts#L75)
- **카테고리:** error-swallow · **상태:** [적대적-미검증]
- **근거:** `tryAcquire`/`release` 루프에 try-catch 없음. RedisLock(timeout)이 throw하면 file/memory 포트로의 fallthrough가 멈춰 문서화된 redis→file→memory degradation이 깨지고 release 시 lock leak.
- **수정:** 각 포트 호출 래핑; acquire에서 throw를 `redis-error`처럼 취급; release는 collect-and-continue 후 첫 에러 rethrow.

### H10. FileBasedLock stale-takeover가 exclusive 아닌 overwrite 사용 (TOCTOU)
- **위치:** [src/auth/lock-file-based.ts:99-114](../../../../src/auth/lock-file-based.ts#L99)
- **카테고리:** race-cancellation · **상태:** [적대적-미검증]
- **근거:** stale-lock 감지 시 read와 write 사이에 `"overwrite"` 사용. 두 프로세스가 모두 reap+acquire 가능 → 둘 다 토큰 refresh, loser의 `refresh_token` 무효화.
- **수정:** takeover 시 `"exclusive"` write; `"exists"`면 `"would-wait"` 반환.
