# L6 — MEDIUM / LOW findings + Cross-cutting themes

검증 상태 범례는 [README.md](README.md) 참조. medium/low는 대부분 단일 verifier 통과 또는 적대적 단독.

---

## 🟡 MEDIUM

### M1. `cloudCreds`가 `chatgpt-oauth`에 잘못된 credential 반환
- **위치:** [src/llm/provider-router.ts:157-178](../../../../src/llm/provider-router.ts#L157)
- **카테고리:** correctness-bug · **상태:** [검증됨 high — 라우팅 영향]
- **근거:** `chatgpt-oauth`가 `default`로 떨어져 `{kind:"api-key",source:"env"}` 반환 (should be `{kind:"oauth",source:"file"}`). Layer-4 detection과 불일치 → downstream refresh-mechanism 라우팅 오류.
- **수정:** default 전에 `case "chatgpt-oauth": return { kind: "oauth", source: "file" }` 추가.

### M2. `pickProvider`가 `QUANTA_PROVIDER`를 trim 안 함
- **위치:** [src/llm/factory.ts:183-190](../../../../src/llm/factory.ts#L183)
- **카테고리:** correctness-bug · **상태:** [검증됨]
- **근거:** `" anthropic "`가 `in DEFAULT_MODEL` 실패하여 silent하게 env detection으로 fall through. `provider-router.ts:195`는 이미 `.trim()`함.
- **수정:** `const explicit = env.QUANTA_PROVIDER?.trim()`

### M3. 모델 카탈로그 empty vs parse-failure 혼동
- **위치:** [src/llm/adapters/chatgpt-oauth.ts:178-196](../../../../src/llm/adapters/chatgpt-oauth.ts#L178)
- **카테고리:** correctness-bug · **상태:** [검증됨]
- **근거:** `res.json().catch(() => null)`이 parse 에러를 정당한 빈 카탈로그와 동일한 `kind:"auth"` "no model access" 에러로 매핑 → 사용자가 retry/네트워크 점검 대신 re-login.
- **수정:** parse 실패(network/corrupt kind)와 zero-models 구분; parse 성공 시에만 zero-models를 auth로 취급.

### M4. Response body 에러 swallow로 4xx/5xx context 유실
- **위치:** [src/llm/responses-stream.ts:388](../../../../src/llm/responses-stream.ts#L388) (+ chatgpt-oauth.ts:179)
- **카테고리:** error-swallow · **상태:** [검증됨]
- **근거:** `res.text().catch(() => "")`가 provider 에러 본문을 버림. status/kind는 보존되나 디버그 context 유실. 패턴이 10+ 사이트 반복.
- **수정:** `""` 대체 전 read 에러 로깅.

### M5. Continuation store가 transient 포함 모든 stream 에러에 clear
- **위치:** [src/llm/responses-stream.ts:451-456](../../../../src/llm/responses-stream.ts#L451)
- **카테고리:** correctness-bug · **상태:** [검증됨 overstated]
- **근거:** 체크포인트는 이미 emit되지만, *모든* 에러에 `store.clear()`가 transient hiccup에서도 resumable state를 폐기 → resume-on-retry 무력화.
- **수정:** clear 전 partial checkpoint persist, 또는 known-terminal 에러(예: 422)에서만 clear.

### M6. JsonlRecorder: flush 전 `closed` 설정 + 부정확한 drop count
- **위치:** [src/stream/adapters/jsonl-recorder.ts:99-105, 122-135, 222-232](../../../../src/stream/adapters/jsonl-recorder.ts#L99)
- **카테고리:** race-cancellation / correctness-bug · **상태:** [검증됨]
- **근거:** (a) `closed=true`가 `flush()` 전 설정 — flush 실패 시 버퍼 데이터가 retry 없이 trap, idempotent 계약 위반. (b) `handleCap`이 `capDone` 가드로 `dropped=1`을 1회만 설정 → N>1 dropped 미반영. (c) `JSON.stringify` 실패 시 `degrade()` 호출하나 어떤 event `kind`가 실패했는지 미기록.
- **수정:** flush 성공 후 `closed` 설정; capped emit마다 `dropped` 증가; 실패 `kind`를 `degrade()`/degraded-line payload에 전달.

### M7. handleCap이 degraded cap-line write 실패 silent swallow
- **위치:** [src/stream/adapters/jsonl-recorder.ts:136](../../../../src/stream/adapters/jsonl-recorder.ts#L136)
- **카테고리:** silent-error · **상태:** [검증됨]
- **근거:** 8줄 떨어진 `tryDegradedLine`(159-171)은 stderr로 로깅하는데 cap 신호(critical state transition)는 write 실패 시 그냥 드롭.
- **수정:** handleCap catch에 동일 stderr/logger.warn 패턴 적용.

### M8. transport 핸들러의 async rejection silent swallow
- **위치:** [src/ipc/session/transports/websocket.ts:18-19](../../../../src/ipc/session/transports/websocket.ts#L18), [stdio.ts:25-26](../../../../src/ipc/session/transports/stdio.ts#L25)
- **카테고리:** error-swallow · **상태:** [검증됨]
- **근거:** `void result.catch(() => undefined)` — 의도된 sibling-isolation이지만 관측성 0. 핸들러 async I/O 실패가 증발. Bridge-layer `onBridgeError`는 command 처리만 커버.
- **수정:** isolation 유지하며 optional 에러 콜백 / logger.warn 추가.
- **참고:** 본 항목은 L9(ipc) 경계지만 동일 error-swallow 테마로 함께 기록.

### M9. replay-llm passthrough가 AbortSignal 무시
- **위치:** [src/llm/replay/replay-llm.ts:90-114](../../../../src/llm/replay/replay-llm.ts#L90)
- **카테고리:** correctness-bug · **상태:** [검증됨]
- **근거:** replay-hit 경로는 yield마다 `signal.aborted` 검사(replayEvents:57)하나 passthrough의 bare `for await`는 안 함 → 모듈의 문서화된 cancellation 계약 위반.
- **수정:** `upstream.stream(input)`을 `replayEvents`와 동일한 signal-aware iterator로 래핑.

### M10. Foundry abort가 wrong error code + LLMError 분류 우회
- **위치:** [src/llm/providers/foundry-adapter.ts:315, 332, 353-354](../../../../src/llm/providers/foundry-adapter.ts#L315)
- **카테고리:** correctness-bug · **상태:** [검증됨 + 적대적]
- **근거:** (a) abort가 `ProviderError("provider-unsupported")` throw — 의미상 "transport not implemented", abort 오라우팅. (b) `if (e instanceof ProviderError) throw e`가 raw rethrow하여 auth ProviderError가 `classify()` 우회 → non-retryable "fatal"화. (c) auth 감지가 message regex 의존, Azure 문구 변경 시 취약.
- **수정:** abort에 `LLMError{kind:"aborted"}` throw; stream-path ProviderError를 mapped kind로 LLMError 래핑; regex 대신 `error.code/statusCode` 우선(status-based `classify()` fallback).

### M11. truthy env-var 로직 중복 (SSOT 없음)
- **위치:** [src/llm/providers/registry.ts:146-150](../../../../src/llm/providers/registry.ts#L146) vs [provider-router.ts:94-98](../../../../src/llm/provider-router.ts#L94)
- **카테고리:** code-quality · **상태:** [검증됨]
- **근거:** 동일 `isTruthy`/`isFoundryUseTruthy` 복붙. divergence 시 silent routing bug(예: `"yes"`가 Foundry 라우팅 중단). Foundry env key 테스트 없음.
- **수정:** 공유 leaf util로 추출 + `"yes"`-case 테스트 추가.

### M12. RefreshCoordinator가 rejection 시 in-flight 엔트리 삭제 → 중복 refresh
- **위치:** [src/auth/chatgpt-oauth/refresh.ts:203-212](../../../../src/auth/chatgpt-oauth/refresh.ts#L203)
- **카테고리:** race-cancellation · **상태:** [적대적-미검증]
- **근거:** `.finally(() => inflight.delete(key))`가 reject에서도 실행. delete 후 settle 전 도착한 두 번째 caller는 dedup 안 됨 → thundering herd + 첫 rejection swallow.
- **수정:** settle까지 엔트리 유지, 두 caller가 공유 결과 관찰; caller `.catch` 부착 문서화.

### M13. SDP codec 추론을 substring 매치로
- **위치:** [src/realtime/sdp-negotiator.ts:39-51](../../../../src/realtime/sdp-negotiator.ts#L39)
- **카테고리:** correctness-bug · **상태:** [적대적-미검증]
- **근거:** `trimmed.includes("opus/")`가 `myopus/8000`도 매치 → 잘못된 codec 협상 (RFC 4566은 encoding-name만 매치해야 함).
- **수정:** rtpmap 정식 파싱: `line.split(/\s+/)[1]?.split("/")[0]?.toLowerCase() === "opus"`

### M14. 기타 적대적 Medium [적대적-미검증]
- **realtime connect/close 타임아웃 없음** [default-adapter.ts:146-242, 287-320](../../../../src/realtime/default-adapter.ts#L146) — half-open 소켓에서 Promise 영구 hang. → 설정가능 타임아웃 `Promise.race`.
- **headless stub connect가 `closing` 상태 덮어씀** [headless-stub.ts:85-120](../../../../src/realtime/headless-stub.ts#L85) — microtask gap 중 `close()` 후 connect가 `open`으로 resolve. → `'open'` 전 `status==='connecting'` 가드.
- **browser-flow 타이머 unref 안 됨** [browser-flow.ts:143-153](../../../../src/auth/chatgpt-oauth/browser-flow.ts#L143) — 전체 timeout 동안 CLI 살아있음. → `timer.unref()`.
- **web-daemon login 백그라운드 task 에러가 `urlResolve` 후** [src/apps/web-daemon/auth-routes.ts:87-112](../../../../src/apps/web-daemon/auth-routes.ts#L87) — `writeToken` 실패해도 client는 success, 토큰 없음. → URL과 최종 결과 둘 다 await.
- **github-token-rotation이 lock-acquire throw swallow** [github-token-rotation.ts:184-188](../../../../src/auth/github-token-rotation.ts#L184) — 실 에러를 `skipped-lock-error`로 collapse, 로그 없음. → 반환 전 로깅.
- **`applyRetention` export됐지만 호출처 없음** [jsonl-retention.ts:84](../../../../src/stream/adapters/jsonl-retention.ts#L84) — prod에서 JSONL 무한 증식. → recorder `close()` 또는 scheduled task에 wire. (default-OFF seam인지 dead-code인지 wiring 확인 필요)
- **retention이 rename 실패 시 `.tmp` orphan** [jsonl-retention.ts:178-193](../../../../src/stream/adapters/jsonl-retention.ts#L178) + row-count mismatch(:208 vs `readJsonlRows`) — → rename 실패 시 `.tmp` 정리, split 로직 통일.
- **Anthropic adapter가 open tool slot 미종료** [anthropic.ts:139-181](../../../../src/llm/adapters/anthropic.ts#L139) — `content_block_stop` 전 stream 종료 시 tool 영구 open. → 루프 후 remaining `open` 엔트리에 `tool_use_end` emit.
- **OIDC 빈 `orgId`를 no-org로 silent 처리** [oidc-federation.ts:228-232](../../../../src/llm/oidc-federation.ts#L228) — → `readOidcEnv`에서 empty→undefined 정규화.

---

## 🟢 LOW

### L1. Recording-LLM이 append 실패 silent swallow (관측성 훅 없음)
- **위치:** [src/llm/replay/recording-llm.ts:102-110, 118-124](../../../../src/llm/replay/recording-llm.ts#L102)
- **카테고리:** error-swallow · **상태:** [검증됨 — 의도된 sidecar 설계, overstated→low]
- **근거:** 의도된 sidecar swallow이나 `onRecordError` 관측성 훅 부재. cassette write 실패(디스크 full, 권한)가 invisible.
- **수정:** optional `onRecordError` 콜백 추가, 기본 swallow 유지.

### L2. Debug 출력이 OAuth request body 유출 (security)
- **위치:** [src/llm/adapters/chatgpt-oauth.ts:282-290](../../../../src/llm/adapters/chatgpt-oauth.ts#L282)
- **카테고리:** security · **상태:** [검증됨 + 적대적]
- **근거:** `QUANTA_DEBUG_OAUTH=1`로 게이팅되나 replacer가 data-URI만 truncate, prompt/message 텍스트는 그대로. → 본문 redact 또는 제거.

### L3. 기타 Low [일부 적대적-미검증]
- Bedrock/Vertex가 raw SDK 에러를 ProviderError에 splice → credential 부분문자열 노출 가능 [bedrock-adapter.ts:152](../../../../src/llm/providers/bedrock-adapter.ts#L152). → 일반 메시지 + raw는 `cause`로만.
- WebSocket subprotocol에 Bearer 토큰 [default-adapter.ts:155-159](../../../../src/realtime/default-adapter.ts#L155) — upgrade 헤더/DevTools/로그 노출. → 노출 문서화 또는 fetch-based upgrade + Authorization 헤더.
- Continuation store evict가 LRU 아닌 insertion-order [responses-continuation-store.ts:41](../../../../src/llm/responses-continuation-store.ts#L41) — hot route가 evict됨. → 접근 시 re-insert.
- `resumedFromResponseId`가 retry 재할당 시 드롭 [responses-stream.ts:363](../../../../src/llm/responses-stream.ts#L363).
- toolCalls delta가 output_item.added 전에 오면 유실 [openai-responses-wire.ts:422](../../../../src/llm/openai-responses-wire.ts#L422) — 재정렬 SSE delta가 yield되나 미누적 → tool input 손상.
- AbortSignal이 streamResponsesSurface에 미전달 [openai-responses.ts:43-67](../../../../src/llm/adapters/openai-responses.ts#L43) — Responses 경로에서 caller cancel 무시.
- 도달불가 null check / dead code 클러스터 (전부 low, 관측성/품질): replay-llm.ts:105-107, model-swap.ts:110-114(오해소지 주석), bedrock-adapter.ts:171, stdout.ts:328-333, default-resolver.ts:57-61, drift-detector.ts:67-97(hit/miss 통계 반전), jsonl-store.ts:116-192(무한 `used` Set), in-memory-cache.ts:48-51, jwt.ts:57-78(관대한 UTF-8 claim), token-store.ts:268-276(파싱불가 expiry 무로그), cli-callback.ts:154-167(server leak), cache-control-audit/analyzer.ts:194-202(`secondIndex:-1`).

---

## Cross-cutting themes (상세)

### 1. 관측성 없는 조직적 error-swallowing
`catch(() => undefined)` / 빈 catch / `.catch(() => "")`가 transport(websocket/stdio) · wire 콜백 · recorder(jsonl, recording-llm) · decoder(codec, observability) · lock 전반에 분포. 대부분 *의도된* isolation/best-effort이나 일관되게 로깅 훅 부재. **권고:** best-effort swallow는 OK이되, 모든 site가 optional `onError`/logger로 라우팅하여 operator 가시성 보존. 공유 헬퍼 하나로 ~15곳 봉합 가능.

### 2. bare 콜백 vs `notifyChunkArrival` 표준
올바른 패턴(try/catch 래핑)이 이미 stream-timeout/openai-responses-wire `notifyChunkArrival`에 존재하나, `onReasoning`/`onCompleted`/`onOutputItemDone`/`onCheckpoint`는 일관성 없이 bare. generator 내부에서 host 콜백 발사 시 동일 래퍼 적용. (H1과 직결)

### 3. LLM lane 전반의 비대칭 AbortSignal 전파
Responses adapter가 `input.signal` 미전달; replay passthrough 무시(M9); fallback `streamProvider` 재확인 안 함; stream-timeout pre-aborted 경로 비대칭. 취소가 일부 분기는 존중, 인접 분기는 silent drop.

### 4. 프로토콜 디코더가 presence만 검증, shape/type 미검증
Session command/event/snapshot(H5/H6) 및 observability 디코더가 key-presence + unsafe `as unknown as` 캐스트에서 멈춰 malformed 신뢰불가 입력을 downstream crash로 push. 공유 discriminated-guard 레이어가 답.

### 5. 토큰/credential 검증 drift
`github-token-rotation`/`oidc-federation`은 non-empty + finite 검증하나 신규 `chatgpt-oauth` refresh/token-store 경로는 안 함(H4). 중복 truthy-env predicate(M11)도 동일. SSOT validator 추출.

### 6. realtime + lock의 lifecycle idempotency/race
`close()` re-entrancy(C1/H7), timeout 없는 hang(M14), stale-lock takeover(H10), TOCTOU release(H9)가 cluster 형성 — 모두 exclusive/settled-flag 가드 없는 check-then-act에서 기인.
