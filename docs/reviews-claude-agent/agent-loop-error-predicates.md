# Agent loop — 에러 분류 / `FallbackTriggeredError` fallback / `stop_reason` 처리

`runTurnLoop` ([`extracted-functions.js:14057`](../../extracted-functions.js#L14057)) 가 한 턴의 stream 을 끝낸 뒤 후속 동작 (계속 / 재시도 / 종료 / 모델 교체) 을 결정하는 모든 술어 (predicate) 와 분기 경로의 상세. 진입 문서 [agent-loop.md](agent-loop.md) §2 본문의 가지를 한 단계 더 펼친 것.

## 1. 호출 그래프 — 술어들이 들어가는 자리

```
Bq3 turn body
├─ inner try { while (DH) { ... for await ev of callModel(...) ... } }
│    ├─ on each event:
│    │     ├─ r47(J_)   → PTL/wg-text 시작인 assistant 메시지면 yield 보류
│    │     ├─ rD8(J_)   → 이미지/문서 에러인 assistant 메시지면 yield 보류 + M_ stash
│    │     ├─ Fa7(J_)   → max_output_tokens 잘림이면 yield 보류
│    │     └─ message_delta 만나면 KH = ev.event.delta.stop_reason
│    └─ catch (H_):
│          ├─ H_ instanceof ANH && fallbackModel($) 있으면
│          │     → model fallback path (§3 상세)
│          └─ else → throw → outer catch
│
├─ outer catch (T_):
│    ├─ d("tengu_query_error", {assistantMessages, toolUses, queryChainId, queryDepth})
│    ├─ T_ instanceof mUH | iF (이미지 사이즈/리사이즈) → image_error 종료
│    └─ 그 외 → Ua7(collectedAssistant, errMsg, deps) 로 partial tombstone +
│              y1(...) error msg yield → model_error 종료
│
├─ signal.aborted 체크 (스트림 종료 직후)
│    ├─ TH (gX_) 있으면 getRemainingResults() 남은 도구 결과 yield
│    ├─ 없으면 Ua7(...) 로 "Interrupted by user" tool_result yield
│    ├─ signal.reason !== "interrupt" 면 EHH({toolUse:false}) "Tools cancelled" yield
│    └─ return { reason: "aborted_streaming" }
│
└─ if (!sawToolUse(t)) {  // last assistant 메시지로 종료 판단
     let T_ = collectedAssistant.at(-1)
     let H_ = (T_?.isApiErrorMessage && OGH(T_))                              // PTL/413
     let M_ = !(Ba7?.isToolUseDeniedMessage(T_)) && rD8(T_)                   // image error
     ├─ if (H_ || M_) → reactive compact path (rapid-refill breaker + u47 + o47)
     │                  성공시 continue; 실패시 return prompt_too_long | image_error
     ├─ if (Fa7(T_)) → max_output_tokens recovery (최대 mq3=3회) or fallthrough
     ├─ if ((T_?.message.stop_reason ?? KH) === "tool_use" && _H.length===0 && !T_?.isApiErrorMessage)
     │                → malformed tool_use retry (1회) or completed
     ├─ if (T_?.isApiErrorMessage) → completed (일반 API 에러는 그대로 종료)
     └─ else → Va7 (Stop hook) → completed | stop_hook_prevented | stop_hook_blocking continue | ...
   }
```

## 2. 핵심 술어 (predicate) 카탈로그

전부 한 줄 술어. 모두 stream-event-loop 안에서 매 event 마다 평가되며, 마지막 메시지 분기에서도 재평가됨.

### 2.1 `r47(message)` — "API 에러 + Prompt-too-long 텍스트" (확인)

[`extracted-functions.js:9891`](../../extracted-functions.js#L9891):

```js
function r47(H){ return H?.type==="assistant" && OGH(H) }
```

### 2.2 `OGH(message)` — PTL/413 본체 검사 (확인)

[`extracted-functions.js:7913`](../../extracted-functions.js#L7913):

```js
function OGH(H){
  if (!H.isApiErrorMessage) return false
  let _ = H.message.content
  if (!Array.isArray(_)) return false
  return _.some(q => q.type==="text" && q.text.startsWith(wg))
}
```

`wg = "Prompt is too long"` (확인, [`line 7944`](../../extracted-functions.js#L7944)).

- 즉 "isApiErrorMessage 가 true AND content 의 어떤 text 블록이 `"Prompt is too long"` 으로 시작" 인 assistant 메시지.
- 서버 측 status 코드 (413) 가 아니라 **메시지 내용 prefix** 로 판단 — 1P/Bedrock/Vertex 무관하게 동작하게 의도된 것으로 추정.
- v2 의 `callModel` 레이어가 PTL 응답을 `apiError` 필드를 채운 가짜 assistant 메시지로 normalize 해서 stream 으로 흘려보내기 때문에 (call-model.md `buildCreatePayload` 의 `promptTooLongIsHandled:true` 옵션과 연결됨) `runTurnLoop` 는 일관되게 이 predicate 로만 검사.

### 2.3 `rD8(message)` — 이미지/문서 에러 (확인)

[`extracted-functions.js:9892`](../../extracted-functions.js#L9892):

```js
function rD8(H){ return H?.type==="assistant" && ye_(H) }
```

`ye_` ([`line 7920`](../../extracted-functions.js#L7920)):

```js
function ye_(H){
  return H.isApiErrorMessage === true
      && H.errorDetails !== void 0
      && YH5(H.errorDetails)
}
```

`YH5(errorDetails)` ([`line 7916`](../../extracted-functions.js#L7916)):

```js
function YH5(H){ return H.includes("request_too_large") || bT8(H) !== void 0 }
```

`bT8` ([`line 7918`](../../extracted-functions.js#L7918)) 는 `messages[N].content[N].image|document|pdf` 정규식 + `wH5`/`jH5` 키워드 리스트 (`"could not process image"`, `"image exceeds"`, `"could not process pdf"`, ...) 매칭.

- 즉 `errorDetails` (서버 400 메시지) 가 `request_too_large` 를 포함하거나, 또는 미디어 path/키워드를 포함하면 image_error.
- 이 검사는 call-model.md 의 `xT8` directive (`retry:media-strip:...`) 와 **공유** — call-model 이 알아서 retry 가 가능한 케이스는 다 처리하고, retry 한도 (`c_=3`) 를 넘긴 경우에만 PTL/이미지 에러 메시지가 stream 으로 escape 되어 `runTurnLoop` 까지 도달.

### 2.4 `Fa7(message)` — max_output_tokens 잘림 (확인)

[`extracted-functions.js:14053`](../../extracted-functions.js#L14053):

```js
function Fa7(H){ return H?.type==="assistant" && H.apiError==="max_output_tokens" }
```

- 정확히 `apiError === "max_output_tokens"` 한 필드 검사.
- v2 가 **`stop_reason === "max_tokens"`** (구버전 표기) 를 직접 검사하지 않음에 주의 — 확인. `stop_reason` 자체는 stream watchdog (`KH` 추적) 에서만 다른 용도 (malformed tool_use detection) 로 사용된다.
- 서버는 `max_tokens` 도달 시 SDK 가 메시지를 `apiError:"max_output_tokens"` 로 패키징해서 흘려보내는 것으로 추정 — Bq3 진입 시점엔 이미 평탄화된 형태.

### 2.5 `FUH(message)` — PTL 토큰 격차 추출 (확인)

[`extracted-functions.js:7915`](../../extracted-functions.js#L7915):

```js
function FUH(H){
  if (!OGH(H) || !H.errorDetails) return                  // PTL 메시지가 아니면 무시
  let { actualTokens:_, limitTokens:q } = IT8(H.errorDetails)
  if (_ === void 0 || q === void 0) return
  let K = _ - q
  return K > 0 ? K : void 0
}
```

`IT8` ([`line 7914`](../../extracted-functions.js#L7914)) 는 errorDetails 에서 `/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i` 정규식으로 `actualTokens` 와 `limitTokens` 추출.

- Bq3 의 호출 사이트 (확인): `let l_ = H_ && T_ ? FUH(T_) : void 0;` — `H_` 은 `T_?.isApiErrorMessage && OGH(T_)` (즉 PTL 여부 flag), `T_` 은 last assistant.
- `o47({ ..., initialTokenGap: l_ })` 로 phase B reactive compact 에 전달. compact 가 **얼마나 줄여야 하는지** 의 초기 추정치 — `actualTokens - limitTokens` (보낸 토큰 - 모델 한도).
- PTL 응답이 아니거나 (이미지 에러 경로) 메시지에 actual/limit 숫자가 없으면 `undefined`. 추정: 이 경우 `reactiveCompactPhaseB` 는 기본 휴리스틱 (예: 절반 compact) 으로 동작.

### 2.6 `Ba7` 및 `isToolUseDeniedMessage` — 도구 거부 식별 (확인)

[`extracted-functions.js:14058`](../../extracted-functions.js#L14058) `var Ba7 = null` 로 모듈 초기화. **현재 v2.1.143 에서는 항상 `null`** — 코드 전체에서 다른 할당이 없음 (확인).

Bq3 의 사용처:

```js
let M_ = !(Ba7 !== null
           && T_?.type === "assistant"
           && Ba7.isToolUseDeniedMessage(T_))
       && rD8(T_)
```

해석:
- 만약 `Ba7` 가 의존성 주입되어 (`null` 이 아니고) `T_` 가 도구 거부 메시지로 분류되면, `predicateImageError` 결과를 무시 (image_error 분기로 가지 않음).
- 즉 "사용자가 tool_use 를 거부했을 때 모델이 생성한 어떤 응답이 우연히 미디어-에러처럼 보일 수 있는데 그것을 image_error 로 오분류하지 않게 막는 가드" — **추정**.
- 현재 binary 에서는 `Ba7` 의 setter / 활성화 사이트가 없으므로 가드는 항상 비활성. 추정: SDK/테스트 측에서 주입하기 위한 hook 자리, 또는 향후 활성화 예정.

### 2.7 보조 술어 — `runStopHooks` 의 `isApiErrorMessage` 검사 (확인)

stream 종료 후 `!t` (sawToolUse 가 false) 일 때 위 4종 (`predicatePromptTooLong`/`predicateImageError`/`predicateMaxOutputTokens`/malformed) 어디에도 안 잡히면, 마지막에 `if (T_?.isApiErrorMessage) return { reason: "completed" }` — 일반 API 에러 메시지는 `completed` 로 종료. (※ 사용자에게는 이미 yield 했으므로 추가 메시지 없음.)

## 3. `FallbackTriggeredError` (`FallbackTriggeredError`) — 모델 fallback 전체 경로

### 3.1 클래스 정의 (확인)

[`extracted-functions.js:15638`](../../extracted-functions.js#L15638):

```js
class ANH extends Error {
  originalModel;
  fallbackModel;
  constructor(H, _) {
    super(`Model fallback triggered: ${H} -> ${_}`);
    this.originalModel = H;
    this.fallbackModel = _;
    this.name = "FallbackTriggeredError";
  }
}
```

필드: `originalModel`, `fallbackModel`, `name="FallbackTriggeredError"`, `message="Model fallback triggered: <orig> -> <fb>"`, `stack` (Error 기본).

### 3.2 어디서 throw 되는가 (확인)

`retryHelper` (SDK retry generator) 내부 ([`extracted-functions.js:15620`](../../extracted-functions.js#L15620)) — **단 한 곳**. 발화 조건 (확인):

```js
if (zDH(X) && (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS || !Hq() && Y2H(q.model))) {
  if ($++, $ >= qA3 /* =3 */) {
    if (q.fallbackModel) {
      d("tengu_api_opus_fallback_triggered", {original_model, fallback_model, provider})
      M6("api_request", "api_request_fallback_triggered")
      throw new ANH(q.model, q.fallbackModel)
    }
    if (!process.env.IS_SANDBOX && !AoH()) {
      d("tengu_api_custom_529_overloaded_error", {})
      throw new XS(Error(C$_), O)   // "Repeated 529 Overloaded errors"
    }
  }
}
```

- `zDH(err)` ([`line 15625`](../../extracted-functions.js#L15625)): `err.status === 529` 또는 message 가 `"type":"overloaded_error"` 포함.
- 추가 가드: `FALLBACK_FOR_ALL_PRIMARY_MODELS` env 또는 (`!Hq()` (non-enterprise) AND `Y2H(model)` (Opus 4.x family)) — Opus 모델만 자동 fallback 하는 게 기본.
- 카운터 `$` 는 동일 RJ6 호출 내에서만 누적 — 3회 연속 529 에서 trigger.
- `fallbackModel` 이 옵션에 없으면 ANH 대신 `XS("Repeated 529 Overloaded errors")` 가 throw 됨.

call-model 레이어 다른 곳의 catch 절들도 `if (BH instanceof ANH) throw BH` 로 항상 통과시킴 (확인, line 19057 의 두 catch). 즉 ANH 는 reliably Bq3 까지 전달됨.

### 3.3 `runTurnLoop` 의 inner catch 동작 (확인)

[`extracted-functions.js:14057`](../../extracted-functions.js#L14057) 안:

```js
} catch (H_) {
  if (T_.length > 0) yield* T_, T_.length = 0          // 1. pending hint_clears flush
  if (H_ instanceof ANH && $) {                         // 2. ANH + fallbackModel($) 있어야
    $H = $                                              // 3. resolvedModelId := fallbackModel
    DH = true                                           // 4. inner while 재진입
    for (let G_ of wH)
      yield { type: "tombstone", message: G_ }          // 5. partial assistant 들 tombstone
    if (d("tengu_orphaned_messages_tombstoned", ...),  // (실제로는 다른 곳; 정리상 명시)
        wH.length = 0,                                  // 6. collected* 전부 리셋
        JH.length = 0,                                  //    JH = tool result accumulator
        _H.length = 0,                                  //    _H = pendingToolUses
        t = false                                       //    sawToolUse flag
       , TH)
      TH.discard(), TH = new gX_(Z.options.tools, T, Z) // 7. streaming-tool-exec 새로 생성
    Z.options.mainLoopModel = $                          // 8. ctx 의 mainLoopModel 갱신
    EH("model_fallback")                                 // 9. tengu_feature_ok 텔레메트리
    d("tengu_model_fallback_triggered", {
      original_model: H_.originalModel,
      fallback_model: $,                                 // 주의: H_.fallbackModel 이 아닌 $
      entrypoint: "cli",
      queryChainId: S,
      queryDepth: p.depth
    })
    yield VO(                                            // 10. "Switched to ..." warning
      `Switched to ${nM(H_.fallbackModel)} due to high demand for ${nM(H_.originalModel)}`,
      "warning"
    )
    continue                                             // 11. inner while → callModel 재호출
  }
  throw H_                                               // 12. ANH 아니면 outer catch
}
```

각 단계 보강:

1. **pending hint flush (`T_`)**: callModel 의 `onHintCleared` 콜백이 누적해둔 `{type:"hint_clears",ids,contentById}` 이벤트들 — 에러 전에 모델이 hint 토큰을 클리어 한 적이 있으면 우선 사용자에게 흘림.
5. **tombstone**: SDK 측 accumulator 가 이미 partial assistant 를 client UI 로 보냈을 수 있으므로 "이 메시지들 무효" 신호. streaming-tool-execution.md 의 같은 패턴.
6. **collectedAssistant (`wH`) / toolResults (`JH`) / pendingToolUses (`_H`) / sawToolUse (`t`)**: in-place 리셋 (`.length=0` 으로 reference 보존). 새 모델 호출의 결과를 신선하게 받기 위함.
7. **`TH.discard()` + new `gX_(...)`**: 이미 실행 시작한 streaming tools 있으면 결과 무시하고 새 컨테이너. streaming-tool-execution.md `gX_.discard()` 가 in-flight AbortController 발동.
8. **`Z.options.mainLoopModel = $`**: ctx mutation. tool-use-context.md 의 `share-by-ref` 패턴 — subagent / 다음 턴에 그대로 보임.
9. **`EH("model_fallback")`**: [`extracted-functions.js:3185`](../../extracted-functions.js#L3185) `function EH(H){ d("tengu_feature_ok", {feature_name: H}) }` — "feature succeeded" telemetry. fallback 자체가 성공한 회복이라는 의미.
10. **VO warning** ([`line 15579`](../../extracted-functions.js#L15579)): `{type:"system", subtype:"informational", level:"warning", ...}` 형태. UI 가 notification 으로 띄움. `nM(model)` ([`line 4216`](../../extracted-functions.js#L4216)) 은 model id → human name ("Opus 4.7", "Sonnet 4.6", ...) 변환.

**turnCount 영향 없음**: `D` 객체는 손대지 않는다 → 같은 턴 안에서 다시 시도 (`turnCount` 그대로, `transition` 그대로).

### 3.4 `FallbackTriggeredError` 인데 `fallbackModel` 없는 경우 (확인)

```js
if (H_ instanceof ANH && $) { ... }   // $ 가 falsy 면 분기 안 들어감
throw H_                              // outer catch 로
```

→ outer catch:
- `T_ instanceof mUH || T_ instanceof iF` → 이미지 에러 아니므로 분기 안 탐
- 일반 경로: `vH(T_)` (logger), `yield* Ua7(wH, H_, J)` (partial tombstone as tool_results), `y1(...)` API 에러 메시지 yield, `{reason: "model_error", error: H_}` 종료.

ANH 의 message `"Model fallback triggered: <orig> -> <fb>"` 가 그대로 사용자에게 노출되므로 caller 가 fallbackModel 을 미리 설정해야 의미 있음. CLI 진입점은 보통 `--fallback-model` 또는 자동 페어링 (Opus → Sonnet) 으로 채움. **추정**: 채우지 않은 경우는 SDK 직접 호출 시나리오로, model_error 로 정상 보고됨.

### 3.5 `FallbackTriggeredError` 두 번째 throw — fallback 모델도 overloaded (추정)

코드 흐름 (코드에서 명시되지 않지만 정적으로 추정 가능):

- Bq3 의 inner catch 가 ANH 받으면 `$H = $` (resolvedModelId := fallbackModel). 이후 callModel 재호출 시 model 이 fallbackModel.
- 그런데 callModel 의 `retryHelper` 는 **`q.fallbackModel`** 을 그대로 다시 받음 (`fallbackModel: $` 로 옵션에 전달됨, 확인). 즉 두 번째 호출에서 model 도 fallbackModel, fallbackModel 옵션도 같은 fallbackModel.
- 두 번째 호출에서도 3회 연속 529 받으면 `throw new ANH(q.model, q.fallbackModel)` = `new ANH(fallbackModel, fallbackModel)`.
- Bq3 inner catch 다시 진입 → `H_.fallbackModel = fallbackModel` (이미 그것임), `$H = $` (그대로), 모든 collector 리셋, ctx 갱신 (no-op), `EH("model_fallback")` 다시 emit (중복), warning notification 다시 yield (`"Switched to X due to high demand for X"` — 같은 모델 이름이 양쪽에 나옴), `continue`.

→ **루프가 무한 반복** 될 위험. 다만:

1. `retryHelper` 자체에 backoff (`Re()` exponential, base 500ms factor 2 cap 32s) 가 있고, `CLAUDE_CODE_MAX_RETRIES` (`_A3=10`) 한도가 있어 결국 다른 에러 (`XS` 등) 로 떨어짐.
2. 카운터 `$` 가 RJ6 인스턴스마다 새로 시작이므로, ANH throw 조건 (`$ >= qA3=3` 연속 529) 자체가 매 호출 새로 만족되어야 함 — 잠깐 풀리면 더 진행 가능.
3. 두 번째 ANH 진입 시 yield 되는 warning notification 의 텍스트가 동일 모델 이름끼리라 사용자 입장에선 "왜 같은 메시지가 또?" 처럼 보임. UI/UX 결함 가능성 — **확인 필요**.

요약: **사이클 차단 로직은 없음** (확인). 결국 outer 또는 SDK 차원의 retry 한도가 발화하기까지 same-turn fallback 시도가 반복됨. 추정: 실용적으론 두 번째 fallback 도 다른 429/rate-limit 같은 에러로 빠지면 `XS` 가 던져져서 outer catch → model_error 종료로 수렴.

## 4. `latestStopReason` (`KH`) 추적 및 활용

### 4.1 추적 메커니즘 (확인)

`KH` 는 매 턴 시작 시 `null` 로 초기화. stream 안에서:

```js
if (J_.type === "stream_event" && J_.event.type === "message_delta") {
  KH = J_.event.delta.stop_reason
  for (let { src: l_, dst: p_ } of G_)
    p_.usage = l_.usage,
    p_.stop_reason = l_.stop_reason,
    p_.stop_details = l_.stop_details
  G_.length = 0
}
```

즉:
- API 의 `message_delta` 이벤트가 `stop_reason` 을 최종 확정해서 보냄 — 한 메시지 끝날 때마다 갱신.
- 동시에 `G_` (backfillObservableInput 으로 만들어진 src/dst 쌍 큐) 의 dst 메시지에 usage/stop_reason/stop_details 를 역주입 — collectedAssistant (`wH`) 에 들어가 있는 사본도 같은 값 갖게.
- 한 턴에 여러 assistant 메시지가 있을 수 있으면 `KH` 는 **마지막 메시지의 stop_reason** 으로 덮어쓰여짐.

### 4.2 활용 — malformed tool_use 검출 (확인)

```js
if ((T_?.message.stop_reason ?? KH) === "tool_use"
    && _H.length === 0
    && !T_?.isApiErrorMessage) {
  // malformed retry 분기
}
```

- 우선 `last.message.stop_reason` 을 보고, 거기 없으면 (`undefined`) `KH` (스트림 fallback) 사용. 둘 다 nullable 일 수 있으므로 안전망.
- 조건: stop_reason 이 `"tool_use"` (서버가 도구 호출하려는 의도였음을 알림) 인데 실제로 파싱된 `pendingToolUses` (`_H`) 가 비어 있음 → **모델이 tool_use 블록을 만들다가 망쳤음** (JSON 파싱 실패, 잘못된 schema, 등).
- 안전망: `isApiErrorMessage` 가 true 이면 (이미 API 에러로 처리되는 케이스) malformed 분기 안 탐.

분기 동작:
- 첫 시도면 (`transition.reason !== "malformed_tool_use_retry"`) `"Your tool call was malformed and could not be parsed. Please retry."` meta 메시지 추가 + `transition: {reason:"malformed_tool_use_retry"}` 로 continue.
- 두 번째 시도에서도 같은 분기에 들어오면 `"The model's tool call could not be parsed (retry also failed)."` 일반 api error 메시지 yield + `completed` 종료.

### 4.3 stop_reason 값별 Bq3 거동 — 전체 표

| `stop_reason` | Bq3 동작 |
|---|---|
| `"end_turn"` | 정상 완료. `_H` 비어 있고 errorMessage 아니면 `runStopHooks` (Stop hook) 호출 → `completed` 또는 `stop_hook_blocking`. |
| `"tool_use"` | `_H.length>0` 이면 정상 tool 경로 (Hj_ / TH) → 다음 턴. `_H.length===0` 이면 malformed retry 분기. |
| `"max_tokens"` | 직접 검사하지 않음. v2 는 같은 상황을 `Fa7(msg)` (`apiError==="max_output_tokens"`) 로 대신 검출 → `mq3=3` 회 한도 내 recovery meta inject. |
| `"stop_sequence"` | 별도 분기 없음. `_H` 비어 있고 에러 아니면 `end_turn` 과 동일하게 처리 (Stop hook → completed). |
| `"refusal"` | 별도 분기 없음 (확인). refusal 응답은 일반 텍스트 메시지로 취급되어 Stop hook 통과 후 `completed`. v2 가 refusal 을 특별 처리하는 코드는 검색되지 않음 — **확인**: `grep "refusal"` 결과 streaming SDK 의 `stop_reason` enum 표시 외 의미 있는 분기 없음. |
| `"pause_turn"` | 별도 분기 없음 (확인). `"pause_turn"` 문자열 직접 검색 hit 없음 — Anthropic SDK 가 도입한 server-side compact 신호이지만 v2.1.143 Bq3 는 이 값을 아직 사용 안 함. 추정: 미래 server-side compaction (`compact_20260112` 베타) 이 활성화될 때 추가될 자리. |

malformed 분기에서 `_H.length===0` 인 동시에 `last.isApiErrorMessage===true` 이면 일반 api error 분기 (`completed`) 로 가는데, 이는 "tool_use 인 척 했는데 사실 PTL/이미지 에러로 잘려나간 케이스" 회피. 확인.

### 4.4 `KH` 만 채워지고 last assistant 가 없는 경우 (추정)

`T_ = wH.at(-1)` 가 undefined 이면 (스트림이 message_delta 만 보내고 assistant content 전혀 없었음 — 비현실적 코너 케이스) `T_?.message.stop_reason` 은 undefined, `KH` 가 fallback. 이 경우 malformed 검사는 `T_?.isApiErrorMessage` (undefined → falsy) 통과해서 분기로 들어가 retry meta 추가 → 다음 턴 시도. 추정: 정상 코드 경로는 아님, 다만 잘 처리.

## 5. `tombstonePartialThenError` — partial tombstone helper (확인)

[`extracted-functions.js:14050`](../../extracted-functions.js#L14050):

```js
function* Ua7(H, _, q) {
  for (let K of H) {                                  // K = assistant message
    let O = K.message.content.filter(T => T.type === "tool_use")
    for (let T of O)
      yield D6({                                       // 각 tool_use 마다 fake tool_result 생성
        content: [{
          type: "tool_result",
          content: _,                                  // _ = error message string
          is_error: true,
          tool_use_id: T.id
        }],
        toolUseResult: _,
        sourceToolAssistantUUID: K.uuid,
        now: q?.now,
        uuidFn: q?.uuid
      })
  }
}
```

- 인자: `H` = 누적된 assistant 메시지 (`wH`), `_` = 에러 메시지 문자열, `q` = deps (now/uuid).
- 출력: 각 assistant 메시지의 `tool_use` 블록마다 `is_error:true` 인 가짜 `tool_result` 메시지 yield.
- 목적: 모델이 도구 호출 의도까지는 보냈는데 실제 실행하지 못한 상태에서 종료 → 다음 턴에 들어오는 `messages` 의 무결성 (tool_use ↔ tool_result 쌍) 유지.
- 사용처 (확인):
  - outer catch 에서 model_error 종료 시: `yield* Ua7(wH, H_, J)` (`H_` = error message)
  - `signal.aborted` 종료 중 `TH` 가 없을 때: `yield* Ua7(wH, "Interrupted by user", J)`
  - `TH` 가 있으면 `TH.getRemainingResults()` 가 더 정확한 결과를 yield 하므로 `tombstonePartialThenError` 안 부름.

## 6. 종료 시 텔레메트리 (확인)

### 6.1 `tengu_query_error` (outer catch)

```js
d("tengu_query_error", {
  assistantMessages: wH.length,
  toolUses: wH.flatMap(M_ => M_.message.content.filter(J_ => J_.type === "tool_use")).length,
  queryChainId: S,
  queryDepth: p.depth
})
```

- model_error / image_error 둘 다에서 emit (분기 진입 직후).
- chainId/depth 는 subagent 트리 추적 — subagent-system.md `queryTracking` 와 연결.

### 6.2 종료 직전 보조 텔레메트리

| 함수 | 호출 시점 |
|---|---|
| `pJH(ctx, querySource, errorMsg)` ([`line 14052`](../../extracted-functions.js#L14052)) | 거의 모든 비정상 종료 직전 (`rapid_refill_breaker`, `blocking_limit`, `image_error`, `model_error`, `prompt_too_long`, malformed retry 실패, `isApiErrorMessage` 종료). `u4H().markApiFailure` 로 ClassifierJobState 에 마킹 — `repl_main_thread` 진입점에서만 동작. |
| `mJH(ctx, querySource)` ([`line 14051`](../../extracted-functions.js#L14051)) | abort 종료 시 (`aborted_streaming`, `aborted_tools`, `tool_deferred`, `hook_stopped`, `max_turns`, loop dynamic wakeup). `markTurnAborted` 호출. |
| `$NH(errorMsg, ctx)` ([매핑은 `bp3.StopFailure`](#) line 18750 = `executeStopFailureHooks`) | terminal 분기에서 `prompt_too_long`/`image_error`/`isApiErrorMessage` 종료/malformed retry 실패 시 호출 — Stop hook 의 변종 "StopFailure" hook 발화. |

### 6.3 `persistTurnFailure` 의 `markTurnActive` 게이트 (확인)

```js
function pJH(H, _, q) {
  let K = riH()
  if (!u4H || !K || !G7() || !_.startsWith("repl_main_thread") || H.agentId) return
  u4H().markApiFailure(K, x0(), q.error, rE(q) ?? q.errorDetails ?? "").catch(() => {})
}
```

조건:
- `markTurnActive` 모듈 로드 됨
- `riH()` (ClassifierJobState 존재)
- `G7()` (telemetry enabled)
- querySource 가 `"repl_main_thread"` 로 시작
- 서브에이전트가 아님 (`!H.agentId`)

→ 즉 메인 REPL 에서만 활성. SDK / subagent / non-interactive 는 무시.

## 7. `signal.aborted` 검출 지점 — 전체 카탈로그

`runTurnLoop` 안에서 `Z.abortController.signal.aborted` 검사 위치 (확인, code 순서):

| # | 위치 | 분기 동작 | return reason |
|---|---|---|---|
| 1 | streaming loop 내부: `TH.addTool(...)` / `TH.getCompletedResults()` 양쪽 guard | 도구 dispatch 건너뜀 | (계속, stream 종료 후 다음 체크) |
| 2 | streaming loop 종료 후 (`!t` 검사 전) | `TH` 있으면 `getRemainingResults()` 끝까지 yield. 없으면 `Ua7(wH, "Interrupted by user", J)` tombstone. `!agentId` 면 `await eRH(Z)` (resource cleanup). `signal.reason !== "interrupt"` 이면 `EHH({toolUse:false})` "Tools cancelled" 메시지 yield. `mJH(Z,z)` 텔레메트리. | `aborted_streaming` |
| 3 | reactive compact 분기 안 (`reactiveCompactPhaseB` 옵션 `aborted: signal.aborted` 로 넘김) + `tengu_ptl_surfaced_to_user` emit 게이팅 | compact 자체는 진행할 수 있도록 함 (사용자가 abort 했어도 compact는 마저). PTL 텔레메트리는 abort 시 skip. | (분기 내부 — 이어 PTL/image_error 종료) |
| 4 | tool 실행 (`gH` for-await loop) 종료 직후 | `!agentId` → `eRH(Z)`. `signal.reason !== "interrupt"` → `EHH({toolUse:true})` "Request interrupted" 메시지. `maxTurns` 초과면 `max_turns_reached` 이벤트도 yield. `mJH(Z,z)`. | `aborted_tools` |
| 5 | PostToolBatch hook (`runPostToolBatchHook`) 루프 안 + 종료 후 | `!dH.agentId` → `eRH(dH)`. `signal.reason !== "interrupt"` → `EHH({toolUse:false})` "Tools cancelled". `mJH(dH,z)`. | `aborted_tools` |

### 7.1 `EHH({toolUse})` 의 두 메시지 (확인)

[`extracted-functions.js:15505`](../../extracted-functions.js#L15505):

```js
function EHH({ toolUse: H = false, now: _, uuidFn: q }) {
  return D6({ content: [{ type: "text", text: H ? cV : hwH }], now: _, uuidFn: q })
}
```

- `cV` — tool 진행 중 interrupt 메시지 (추정 `"[Request interrupted by user for tool use]"` 또는 유사. line 12694 의 UI 컴포넌트 매핑에서 두 가지 special 텍스트가 같은 컴포넌트 `RHH` 로 렌더되는 패턴 확인.)
- `hwH` — tool 외부 interrupt 메시지 (추정 `"[Request interrupted by user]"`).
- 둘 다 `D6(...)` 로 user-role 메시지 형태. 모델 입장에선 "사용자가 끼어들었다" 표시 — 다음 턴이 있다면 모델이 그 흐름을 인식.

### 7.2 `signal.reason !== "interrupt"` 의 의미 (추정)

`signal.reason` 은 abort 호출자가 넘긴 값 (`AbortController.abort(reason)`). 코드 흐름:
- 사용자가 명시적 `interrupt` 키 (ESC 등) 누름 → `controller.abort("interrupt")` → `signal.reason === "interrupt"` → "Tools cancelled" 메시지 yield **skip**. UI 가 이미 다른 표시를 한다는 의미로 추정.
- 그 외 이유 (timeout, hook stop, subagent budget exhaustion, 등) → reason 이 `"interrupt"` 아닌 다른 값 → "Tools cancelled" / "Request interrupted" 메시지 yield (모델 context 유지용).

확인: code 에 `controller.abort("interrupt")` 명시 호출처는 `grep` 으로 다수 발견 (REPL 단축키 핸들러).

## 8. State / Schema 요약

### 8.1 술어 입력 형태

```ts
type AssistantMessage = {
  type: "assistant"
  message: {
    role: "assistant"
    content: ContentBlock[]
    usage?: TokenUsage
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "pause_turn" | null
    stop_details?: any
  }
  isApiErrorMessage?: boolean
  apiError?: "max_output_tokens" | "prompt_too_long" | "invalid_request" | string
  errorDetails?: string
  error?: string
  uuid: string
  // ...
}
```

각 술어가 보는 필드:

| 술어 | 보는 필드 |
|---|---|
| `predicateApiError` / `predicatePromptTooLong` | `type`, `isApiErrorMessage`, `message.content[].text` |
| `predicateImageError` / `ye_` / `YH5` | `type`, `isApiErrorMessage`, `errorDetails` |
| `predicateMaxOutputTokens` | `type`, `apiError` |
| `extractTokenGap` | `predicatePromptTooLong` 통과 + `errorDetails` 정규식 `actualTokens > limitTokens` |
| (malformed) | `message.stop_reason`, `_H` (parsed tool_uses), `isApiErrorMessage` |

### 8.2 stream 처리 시 술어 게이트 흐름 (확인)

```js
let B_ = false                              // "yield 보류 flag"
if (r47(J_))  B_ = true
if (rD8(J_))  B_ = true, M_.push(J_)        // 추가로 stash (M_ = image_error stash array)
if (Fa7(J_))  B_ = true
if (!B_) {
  if (M_.length > 0) yield* M_, M_.length = 0  // 직전 stash 들이 있으면 정상 메시지 직전에 release
  yield b_                                      // 그 후 현재 event yield
}
```

해석:
- 세 종류 에러 메시지는 stream 도중에 yield 하지 않고 **마지막에 (`!t` 분기에서) 한 번에** 분류/처리.
- 단 `predicateImageError` 만 별도 `M_` 에 누적: 이미지/문서 에러가 PTL 와 함께 오면 PTL 처리 후 이미지 에러도 flush 되어 사용자에게 보임 — 추정 (UX 디자인 의도).
- `B_=false` (정상 메시지) 도착 시 stash 된 image-error 들 먼저 흘리고 정상 이벤트 yield — sandwich 패턴.

### 8.3 collected* 상태 (확인)

```ts
{
  wH: Message[]                  // collectedAssistant - 이 턴의 assistant 메시지들
  JH: Message[]                  // collectedToolResults - 이 턴의 user-role tool_result 들
  _H: ContentBlock[]             // pendingToolUses - tool_use 블록 평탄화
  t:  boolean                    // sawToolUse - 이번 턴에 tool_use 블록 봤는지
  KH: string | null              // latestStopReason - 마지막 message_delta.stop_reason
  TH: gX_ | null                 // streaming tool execution 컨테이너
  G_: { src, dst }[]             // backfill 으로 만든 src→dst 메시지 쌍 큐 (message_delta 시 flush)
  M_: AssistantMessage[]         // image error stash
  T_: HintClearEvent[]           // pending hint_clears (callModel 콜백이 채움)
  H_: boolean                    // onStreamingFallback 발화 flag
  DH: boolean                    // "한 번 더 callModel 호출" flag (ANH 재시도 전용)
}
```

`FallbackTriggeredError` catch 가 리셋하는 항목 (정확히): `wH.length=0`, `JH.length=0`, `_H.length=0`, `t=false`, `TH` 재생성. `G_/M_/T_/KH/DH` 는 리셋 없음 — 그 중 `T_` 은 catch 진입 직후 `yield* T_, T_.length=0` 으로 별도 flush, `DH=true` 로 명시 설정.

## 9. v0.2.8 대비 차이 요약

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| PTL 검출 | HTTP 413 status 직접 검사 | 메시지 prefix `"Prompt is too long"` (`predicatePromptTooLong`) + `isApiErrorMessage` flag — provider-neutral |
| 이미지 에러 | image content 가 있으면 단순 throw | `predicateImageError` (errorDetails 패턴 + 키워드 리스트) + 그 위에 call-model `xT8`/`nEK` directive retry (최대 3회) |
| max_tokens 처리 | 없음 (그냥 잘림) | `predicateMaxOutputTokens` (`apiError === "max_output_tokens"`) + recovery meta inject (최대 3회, `mq3`) |
| Token gap 추정 | 없음 | `extractTokenGap` 가 errorDetails 에서 `actualTokens - limitTokens` 추출 → `o47.initialTokenGap` |
| Model fallback | 없음 | `FallbackTriggeredError` 예외 → same-turn fallback + tombstone + warning notification + ctx mutation + telemetry |
| Malformed tool_use | stop_reason="tool_use" 인데 비어있으면 무한 루프 위험 | `KH` (latest stop_reason) 추적 + `_H.length===0` 검사 + 1회 retry meta + 2회째엔 completed 로 깨끗하게 종료 |
| Partial tombstone | 없음 (도구 불일치로 다음 턴 에러) | `tombstonePartialThenError` generator 가 각 tool_use 에 대해 is_error 가짜 tool_result 생성 → 다음 턴 messages 무결성 보장 |
| Abort 분류 | 단일 reason | `aborted_streaming` / `aborted_tools` (PostToolBatch 포함) + `signal.reason !== "interrupt"` 게이트로 "Tools cancelled"/"Request interrupted" 메시지 선택 yield |
| 텔레메트리 | `tengu_query_error` 만 | `persistTurnFailure` (markApiFailure repl_main_thread 전용), `abortCleanup` (markTurnAborted), `runStopFailureHook` (StopFailure hook), `EH("model_fallback")`, `tengu_model_fallback_triggered`, `tengu_orphaned_messages_tombstoned`, `tengu_malformed_tool_use_response`, `tengu_ptl_surfaced_to_user` 등 |
| Tool-use 거부 가드 | 없음 | `Ba7?.isToolUseDeniedMessage` (현재 v2.1.143 에서는 `Ba7===null` 이라 비활성, hook 자리만 존재) |

### 9.1 확인 / 추정

- 확인: `predicateApiError`/`predicateImageError`/`predicateMaxOutputTokens`/`predicatePromptTooLong`/`extractTokenGap` 모든 정의, `FallbackTriggeredError` 클래스, throw 사이트, Bq3 catch 동작, malformed 분기, `tombstonePartialThenError`, `interruptMessage`, `persistTurnFailure`/`abortCleanup`/`runStopFailureHook`, `KH` 추적, abort 검출 지점들, 텔레메트리 호출.
- 추정: `Ba7` 의 hook 자리 의도 (현재 null), 두 번째 ANH throw 시 사이클 차단 부재, `cV`/`hwH` 정확한 텍스트 (UI 컴포넌트가 같이 렌더링하는 패턴으로 보아 interrupt 메시지 쌍).
- 확인 필요: `pause_turn` / `refusal` stop_reason 의 향후 처리 — server-side compact (`compact_20260112`) 베타가 활성화될 때 새 분기가 추가될 가능성. 현재 buffer 에서는 어느 것도 명시적 분기 없음.
