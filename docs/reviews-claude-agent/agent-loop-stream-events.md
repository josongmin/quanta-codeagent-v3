# Agent loop — stream event 인터페이스 (`runTurnLoop` ↔ `callModel`)

`runTurnLoop` ([extracted-functions.js:14057](../../extracted-functions.js#L14057))의 inner-stream 단계 (`for await (let J_ of J.callModel(...))`)에 집중한 분석. `J.callModel = NiH`(= `callModelOuter`의 wrapper, [extracted-functions.js:19042](../../extracted-functions.js#L19042) — see [call-model.md](call-model.md)) 가 yield하는 이벤트 집합과, 각각이 `runTurnLoop` 안에서 어떻게 가공·필터·축적되는지를 추적한다.

이 문서는 [agent-loop.md](agent-loop.md) §2 inner stream loop와 [call-model.md](call-model.md) §2 `callModelOuter` body 사이의 빈 줄을 메우는 보충 자료다.

---

## 1. 호출 그래프

```
Bq3 inner-stream-loop (extracted-functions.js:14057, 약 char-offset 10131000–10134900)
│
├─ for await (J_ of J.callModel({ messages: aY6(x,K), ..., options:{
│      onStreamingFallback : () => { H_ = true },          # 플래그만 설정
│      onHintCleared       : (b_, B_) => {                  # context-hint controller가 호출
│         T_.push({type:"hint_clears", ids:[...b_], contentById: Object.fromEntries(B_) })
│         for (l_ of fi9(x, b_)) Z.readFileState.delete(H9(l_))
│         x = Nz_(x, b_, B_)
│      },
│      ...
│   } }))
│   │
│   ├─ T_.length > 0 ? yield* T_; T_.length = 0                        # 콜백 누적분 flush
│   │
│   ├─ if (H_) {                                                        # 비스트림 fallback 발동
│   │     for (l_ of wH) yield {type:"tombstone", message:l_}
│   │     wH.length=0; JH.length=0; _H.length=0; G_.length=0; t=false
│   │     if (TH) { TH.discard(); TH = new gX_(...) }
│   │  }
│   │
│   ├─ ── ev 가공 패스 1: assistant 메시지 backfillObservableInput ──
│   │   if (J_.type === "assistant") {
│   │      for (p_ in J_.message.content) {
│   │         u_ = J_.message.content[p_]
│   │         if (u_.type === "tool_use" && u_.input != null) {
│   │            c_ = eK(toolDefs, u_.name, toolAliases)
│   │            if (c_?.backfillObservableInput) {
│   │               CH = {...u_.input}; c_.backfillObservableInput(CH)
│   │               if (CH 에 새 key가 추가됐다면) {
│   │                  l_ ??= [...J_.message.content]                  # lazy copy
│   │                  l_[p_] = {...u_, input: CH}
│   │               }
│   │            }
│   │         }
│   │      }
│   │      if (l_) {
│   │         b_ = {...J_, message:{...J_.message, content:l_}}        # 패치본
│   │         G_.push({src:J_.message, dst:b_.message})                # 추후 usage/stop_reason 역주입용
│   │      } else b_ = J_
│   │   }
│   │
│   ├─ ── ev 가공 패스 2: message_delta로 latestStopReason 추적 ──
│   │   if (J_.type === "stream_event" && J_.event.type === "message_delta") {
│   │      KH = J_.event.delta.stop_reason                              # latestStopReason
│   │      for ({src, dst} of G_) {                                     # 누적된 패치본 동기화
│   │         dst.usage        = src.usage
│   │         dst.stop_reason  = src.stop_reason
│   │         dst.stop_details = src.stop_details
│   │      }
│   │      G_.length = 0
│   │   }
│   │
│   ├─ ── ev 가공 패스 3: 오류성 메시지 yield 지연 ──
│   │   B_ = false
│   │   if (r47(J_)) B_ = true                                          # PTL detector
│   │   if (rD8(J_)) B_ = true, M_.push(J_)                             # image error detector
│   │   if (Fa7(J_)) B_ = true                                          # max_output_tokens detector
│   │   if (!B_) {
│   │      if (M_.length > 0) yield* M_; M_.length = 0
│   │      yield b_                                                     # ← 컨슈머에 전달
│   │   }
│   │
│   ├─ ── 축적 ──
│   │   if (J_.type === "assistant") {
│   │      wH.push(J_)                                                  # collectedAssistant (원본)
│   │      l_ = J_.message.content.filter(c => c.type === "tool_use")
│   │      if (l_.length > 0) _H.push(...l_), t = true                  # _H = pendingToolUses, t=sawToolUse
│   │      if (TH && !aborted) for (p_ of l_) TH.addTool(p_, J_)
│   │   }
│   │
│   └─ ── streaming tool exec 결과 회수 ──
│       if (TH && !aborted) for (l_ of TH.getCompletedResults()) {
│          if (dm(l_)) { yield l_; continue }                           # bridge 이벤트
│          if (l_.message) {
│             yield l_.message
│             if (!_P_(l_.message)) {                                   # virtual 메시지 제외
│                p_ = i0([l_.message], refreshTools(), mainLoopModel)   # 이미지/첨부 expand
│                y$_(p_, mA(mainLoopModel).maxBase64Size)               # base64 사이즈 검증
│                JH.push(...p_.filter(u_ => u_.type === "user"))        # collectedToolResults
│             }
│          }
│       }
```

| 식별자 | 위치 | 역할 |
|---|---|---|
| `runTurnLoop` | [extracted-functions.js:14057](../../extracted-functions.js#L14057) | turn loop (`for await` 본체는 이 라인 내부) |
| `NiH` / `callModelOuter` | [extracted-functions.js:19042](../../extracted-functions.js#L19042) / [19054](../../extracted-functions.js#L19054) | callModel 진입점 (wrapper / 본체) |
| `mergeUserContext` | (in Bq3 호출) | `messages` 전처리; 정의 위치 미해석 — `K`(=`userContext`)를 messages에 머지하는 역할 **추정** |
| `lookupTool` | [extracted-functions.js:5747](../../extracted-functions.js#L5747) | tool name → tool definition resolver (alias 처리) |
| `extractReadPaths` | [extracted-functions.js:8417](../../extracted-functions.js#L8417) | hint id 세트로부터 영향받는 `Read` 도구 file_path 목록 추출 |
| `replaceClearedHints` | [extracted-functions.js:8422](../../extracted-functions.js#L8422) | hint id 세트의 tool_result content를 placeholder로 교체 |
| `clearedHintPlaceholder` | [extracted-functions.js:8424](../../extracted-functions.js#L8424) | `"[Old tool result content cleared]"` — Nz_ default placeholder |
| `toAbsolutePath` | [extracted-functions.js:3290](../../extracted-functions.js#L3290) | 상대경로 → 절대경로 정규화 (readFileState key 생성) |
| `isVirtualMessage` | [extracted-functions.js:15495](../../extracted-functions.js#L15495) | virtual user/assistant 메시지 predicate |
| `expandAttachments` | [extracted-functions.js:15542](../../extracted-functions.js#L15542) | attachment/image expansion (모델별 caps 적용) |
| `enforceBase64Limit` | [extracted-functions.js:7870](../../extracted-functions.js#L7870) | base64 이미지 크기 검증 → `mUH` (ImageSizeError) throw |
| `perModelLimits` | [extracted-functions.js:7176](../../extracted-functions.js#L7176) | per-model image limits (`maxBase64Size`, `targetRawSize`, `maxWidth/Height`) |
| `StreamingToolExecutor` | [extracted-functions.js:13877](../../extracted-functions.js#L13877) (`class gX_`) | streaming tool exec container — see [streaming-tool-execution.md](streaming-tool-execution.md) |
| `tombstonePartialThenError` | [extracted-functions.js:14050](../../extracted-functions.js#L14050) | 미완료 assistant tool_use에 대응하는 가짜 `is_error` tool_result 생성 |
| `Jd9` | [extracted-functions.js:7943](../../extracted-functions.js#L7943) | refusal 처리 (`stop_reason === "refusal"` 시 사용자에 안내 메시지) |
| `Aq` (callModel local) | [extracted-functions.js:19057](../../extracted-functions.js#L19057) (char 7710) | SDK querySource 용 partial-text 메시지 합성기 (abort 시) |
| `MwH` | [extracted-functions.js:19059](../../extracted-functions.js#L19059) | usage 객체 누적 머지 |

---

## 2. 핵심 로직

### 2.1 `callModel` 이 yield하는 이벤트 카탈로그 (확인)

callModel 본체 `callModelOuter`의 stream 소비 loop ([extracted-functions.js:19057](../../extracted-functions.js#L19057), 약 char 11500+)에서 발사된다. `event.type` switch 와 함께 외부에 다음을 yield:

| Bq3가 받는 `J_.type` | 발생 시점 | 페이로드 / 필드 | 처리 |
|---|---|---|---|
| `stream_event` (`event.type = "message_start"`) | API 응답 첫 chunk | `{type:"stream_event", event:{type:"message_start", message:{id, role, model, content:[], stop_reason:null, usage}}, ttftMs: number}` | UI에 그대로 yield. `ttftMs`는 콜모델이 추가한 메타. Bq3 측에선 특별 처리 없음. |
| `stream_event` (`content_block_start`) | 각 content block 시작 (text/tool_use/thinking/server_tool_use/advisor_tool_result) | `{type:"stream_event", event:{type:"content_block_start", index, content_block}}` | 그대로 yield. callModel은 내부에서 `eH[index] = {...content_block, input:""|text:""|thinking:""}` 누적 시작 |
| `stream_event` (`content_block_delta`) | text_delta / input_json_delta / thinking_delta / signature_delta / citations_delta | `{type:"stream_event", event:{type:"content_block_delta", index, delta:{type:"text_delta", text} | {type:"input_json_delta", partial_json} | {type:"thinking_delta", thinking} | {type:"signature_delta", signature}}}` | 그대로 yield. callModel은 `eH[index]`의 누적 필드에 `+=`. **순수 stream 보조 이벤트**: Bq3에서 추가 가공 없음. |
| `stream_event` (`content_block_stop`) | 각 content block 종료 | `{type:"stream_event", event:{type:"content_block_stop", index}}` | 그대로 yield. **별도로 callModel은 이 시점에 `assistant` 메시지를 한 번 더 yield** (아래 행). |
| **`assistant`** | content_block_stop 직후 (block마다 1회) | `{type:"assistant", message:{...UH/* message_start의 message */, content: N2_([eH[index]], userContext, agentId, {requestId, messageId})}, requestId, querySource, spawnedBySkill, activeSkill, type:"assistant", uuid, timestamp, advisorModel?}` | **(1) backfillObservableInput 패치** (§2.2), **(2) `wH`/`_H`/`t` 누적**, **(3) `TH.addTool` 등록** |
| `stream_event` (`message_delta`) | usage/stop_reason/stop_details 업데이트 (API SSE 표준) | `{type:"stream_event", event:{type:"message_delta", delta:{stop_reason, stop_details, diagnostics?}, usage}}` | **(1) `KH = delta.stop_reason`** (latestStopReason), **(2) `G_` 패치본에 usage/stop_reason/stop_details 역주입**, **(3) yield** (기본). callModel 측에선 동시에 `egH(...)` 텔레메트리 / `Jd9(stop_reason, ...)` refusal 처리 / `tengu_max_tokens_reached` & `tengu_context_window_exceeded` 분기 + API error 메시지 직접 yield. |
| `stream_event` (`message_stop`) | 전체 응답 종료 | `{type:"stream_event", event:{type:"message_stop"}}` | 그대로 yield. callModel은 이 시점에 stream-end. |
| `stream_event` (`ping`) | heartbeat | `{type:"stream_event", event:{type:"ping"}}` | callModel이 watchdog reset 후 그대로 yield. Bq3 측 무처리. |
| `user` (`type:"user"`, API error 형식) | callModel이 `message_delta` 처리 중 `stop_reason === "max_tokens"` 또는 `"model_context_window_exceeded"` 직접 yield | `y1({content:"<오류 메시지>", apiError:"max_output_tokens", error:"max_output_tokens"})` → `{type:"user", message:{role:"user", content:"..."}, isApiErrorMessage:true, apiError, error, uuid, timestamp}` | `Fa7(J_)` true → `B_=true`로 표시하고 **이번 turn yield 보류**. stream 종료 후 별도 분기에서 처리 (max_output_tokens recovery). |
| `user` (refusal 형식) | callModel `Jd9(...)` — `stop_reason === "refusal"` | API error 메시지 (`Y`) yield | Bq3 측 동일 — `r47/rD8/Fa7` 중 어떤 predicate에도 매칭되지 않는 경우 정상 yield, 매칭되면 보류 |
| `user` (advisor strip / media strip 결과) | callModel `H:for(;;)` 재시도 후 `u_` Map flush — strip된 이미지/도큐먼트당 `gUH(kind)` 메시지를 user에게 알림 | `y1({content: gUH(kind), error:"invalid_request", errorDetails})` | 동일하게 ev pass-through |

callModel은 위 외에 자체 코드 ([extracted-functions.js:19057](../../extracted-functions.js#L19057) `Aq` helper) 에서 `T.querySource === "sdk"` 인 경우 abort 시 **partial assistant 메시지를 합성해 yield** 할 수 있다 — Bq3는 outer abort 분기에서 별도로 `tombstonePartialThenError`을 통해 partial tool_use에 대응하는 가짜 tool_result를 생성하므로 SDK 경로는 다른 처리.

추가로 retry status는 callModel 외부 wrapper `retryHelper` 이 generator로 yield한다 ([call-model.md](call-model.md) §1):

| `J_.type` (recap) | 발생 시점 |
|---|---|
| `HI8(err, delayMs, attempt, maxRetries)` 결과 메시지 | RJ6 backoff 중간에 yield — 사용자에게 "API error … retrying in N s" 안내 |

(`do if(LH=await OH.next(), !("controller" in LH.value)) yield LH.value;` — callModel이 generator 결과의 `value`가 SDK controller 객체가 아닐 때만 통과시키는 방식. 컨슈머 입장에선 일반 `J_` 와 동일하게 처리됨)

#### callModel은 **`stream_request_start`를 yield하지 않는다** (확인)

`stream_request_start`는 **Bq3가 turn 진입 시 직접 1회 yield** ([extracted-functions.js:14057](../../extracted-functions.js#L14057) chunk1 — `if (yield {type:"stream_request_start"}, v5("query_fn_entry"), ...)`). callModel의 매 attempt마다 발사되는 게 아니라 매 turn 마다 1회. inner-stream loop의 `FallbackTriggeredError` fallback 재시도나 streaming fallback (`H_=true`) 재진입에선 발사되지 않는다 — 즉 컨슈머 입장에선 **turn 경계 표식**.

#### Bq3가 자체적으로 yield하는 이벤트 (확인)

| `type` | 발사 위치 | 페이로드 |
|---|---|---|
| `stream_request_start` | turn 진입 직후 | `{type:"stream_request_start"}` |
| `tombstone` | streaming fallback OR `FallbackTriggeredError` fallback 시 | `{type:"tombstone", message: <원본 assistant msg>}` |
| `hint_clears` (via `T_` buffer) | `onHintCleared` 콜백 (callModel→Bq3) | `{type:"hint_clears", ids:[...], contentById:{tool_use_id → placeholder}}` |
| `max_turns_reached` | `nextTurnCount > maxTurns` | `T9({type:"max_turns_reached", maxTurns, turnCount})` |
| `compact_progress`, `sdk_status`, `notification`, `response_length` | autocompact / reactive compact의 `compactProgressQueue` wrapper 경로 (callModel과 무관) | see [compaction-system.md](compaction-system.md) |
| `set_in_progress_tool_use_ids` | `StreamingToolExecutor`가 도구 완료 시 (`getCompletedResults` 안에서) — see [streaming-tool-execution.md](streaming-tool-execution.md) | — |
| warning notification (`VO(...)`) | model fallback 발생 / Stop hook cap 초과 | `{type:"notification", notification:{key, text, priority:"warning", ...}}` |

### 2.2 `backfillObservableInput` 패칭 (확인)

[extracted-functions.js:14057](../../extracted-functions.js#L14057) char-offset 약 10133900–10134200:

```js
if (J_.type === "assistant") {
  let l_;
  for (let p_ = 0; p_ < J_.message.content.length; p_++) {
    let u_ = J_.message.content[p_];
    if (u_.type === "tool_use" && typeof u_.input === "object" && u_.input !== null) {
      let c_ = eK(Z.options.tools, u_.name, Z.options.toolAliases);
      if (c_?.backfillObservableInput) {
        let WH = u_.input, CH = {...WH};
        c_.backfillObservableInput(CH);
        if (Object.keys(CH).some((X_) => !(X_ in WH))) {
          l_ ??= [...J_.message.content];          // lazy copy
          l_[p_] = {...u_, input: CH};
        }
      }
    }
  }
  if (l_) {
    b_ = {...J_, message: {...J_.message, content: l_}};
    G_.push({src: J_.message, dst: b_.message});
  }
}
```

**의도** (확인):
- 모델이 `Read({file_path: "./foo"})` 라고 호출했을 때, 도구의 `backfillObservableInput(input)`이 `input.file_path` 를 **현재 cwd 기준 절대경로 (`/Users/.../foo`)**로 in-place rewrite 한다 (또는 `Bash({command:"..."})` 의 `description` 자동 채우기 등 — 정확한 행동은 도구별 contract, [tool-interface.md](tool-interface.md) 참조).
- 새 key가 **추가되었을 때만** (즉 모델의 원본 input에 없던 key가 backfilled되었을 때만) lazy copy + 컨슈머에 패치본 yield. 단순히 기존 key 값이 바뀌는 경우엔 패치 안 함 — **확인 필요** (코드의 `Object.keys(CH).some((X_) => !(X_ in WH))` 는 신규 키만 검사).
- 패치본은 컨슈머 (UI/transcript) 에 정규화된 form으로 표시. 원본 (`J_.message`) 은 `wH` (collectedAssistant)에 push되어 다음 모델 호출 시 그대로 messages에 들어간다 — 즉 모델이 본인 originally 출력한 form은 보존, 컨슈머만 augmented view 받음.

**`G_` 배열의 의미** (확인):
```js
G_.push({src: J_.message, dst: b_.message})
```
- `src` = 모델 원본 assistant message 객체 (참조)
- `dst` = backfilled 패치본 message 객체 (참조)
- 같은 stream 안에서 이후 `message_delta` ev가 도착하면, callModel이 **`src`에는** `usage`/`stop_reason`/`stop_details`를 in-place mutate한다 ([extracted-functions.js:19057](../../extracted-functions.js#L19057) char ~11900 — `for (let hK of RH) hK.message.usage = oH, hK.message.stop_reason = T_, ...`). `dst`는 별도 객체이므로 동일 mutation을 받지 못함 — Bq3가 직접 해줘야 한다:

```js
if (J_.type === "stream_event" && J_.event.type === "message_delta") {
  KH = J_.event.delta.stop_reason;
  for (let {src: l_, dst: p_} of G_) {
    p_.usage        = l_.usage;
    p_.stop_reason  = l_.stop_reason;
    p_.stop_details = l_.stop_details;
  }
  G_.length = 0;
}
```

`G_.length = 0` — 한 message_delta 가 통과한 이후엔 다음 패치 사이클까지 비워둠. 즉 `G_`는 **현재 stream 진행 중 아직 message_delta를 받지 않은 패치본들의 보류 리스트**.

**왜 이렇게 하는가** (추정):
- callModel은 SDK가 표준 SSE 시퀀스대로 발사하는 stream을 그대로 통과시키기 때문에, message_delta는 모든 content_block_stop (= `assistant` 이벤트) 이후 한 번에만 도착. 그 사이의 모든 assistant 메시지에 retroactive하게 usage/stop_reason을 채워야 일관된 transcript가 된다.
- 패치본을 만든 시점에는 usage가 부분 정보만 있음 (`message_start`의 초기 usage). 최종값은 `message_delta`에서만 확정된다.

### 2.3 `onStreamingFallback` 콜백 (`H_` 플래그) (확인)

```js
options: {
  ...
  onStreamingFallback: () => { H_ = true },
  ...
}
```

callModel ([call-model.md](call-model.md) §2.5 `nonStreamingFallback`)는 stream이 idle timeout / 404 / `JH.classifyStreamError` / 일반 stream 실패 시 `T.onStreamingFallback?.()` 를 invoke한 뒤 non-streaming 단일 POST로 재요청한다. Bq3는 단순히 `H_=true` flag만 켜고, **다음 yield된 이벤트 도착 시점**에 반응:

```js
for await (let J_ of J.callModel(...)) {
  if (T_.length > 0) yield* T_, T_.length = 0;
  if (H_) {
    for (let l_ of wH) yield {type: "tombstone", message: l_};
    d("tengu_orphaned_messages_tombstoned", {
       orphanedMessageCount: wH.length,
       queryChainId: S, queryDepth: p.depth
    });
    wH.length = 0;
    JH.length = 0;
    _H.length = 0;
    G_.length = 0;
    t = false;                    // sawToolUse 리셋
    if (TH) {
       TH.discard();
       TH = new gX_(Z.options.tools, T, Z);
    }
    // ↑ H_ 플래그 리셋 코드는 없음 — 추정으로는 다음 iteration이 정상 stream-event를 받으면 자동으로 다음 분기로 흘러가고, 이번 turn 안에서 H_가 다시 true가 되는 시나리오는 없으므로 (한 번의 callModel 호출당 onStreamingFallback은 0 또는 1회) 무방.
  }
  let b_ = J_;
  // ... 이후 보통 처리 ...
}
```

**의미** (확인):
- callModel은 streaming이 망가졌을 때 같은 페이로드를 non-stream으로 재호출 — 즉 응답이 **처음부터** 다시 도착한다. 따라서 이번 attempt 이전에 컨슈머가 받은 partial assistant chunks는 모두 **무효**.
- `tombstone` 메시지로 UI에 "이 message는 무효화됨" 신호를 보낸다 (UI는 회색 처리 / 사라지게 / undo).
- `TH` (streaming tool execution container)도 discard — 이미 실행된 도구가 있다면 그 결과는 모델이 다시 받아볼 메시지에 포함되지 않으므로 의미 없어짐 + 새로 시작될 stream에서 다시 tool_use가 올 수 있으므로 새 컨테이너 필요.
- `t` (sawToolUse) 리셋 — 다음 stream에서 새로 결정.
- 텔레메트리: `tengu_orphaned_messages_tombstoned` (개수 / chainId / depth).

`onStreamingFallback`이 invoke되는 시나리오 자체는 callModel 내부 ([call-model.md](call-model.md) §2.5 `nonStreamingFallback` 진입):
1. streaming endpoint 404 (`f7K` 분기 외 다른 경로)
2. `JH?.classifyStreamError(T8)` (context-hint SSE 분류)
3. 그 외 stream 실패 + `partial_yield` 아님 + `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 미설정

이 콜백은 callModel 안에서 fallback 진입 직전에 호출되어 Bq3가 다음 yield 받았을 때 "이전 partial은 죽었음" 을 인지할 수 있게 만드는 신호. **확인 필요**: 콜백이 실제로 호출되는 callModel 코드 라인 — `JH.onStreamFallback` 호출은 [call-model.md](call-model.md) §1에서 언급되었으나 정확한 명칭이 `options.onStreamingFallback`인지 다른 hook인지 미확인. **추정**: callModel 본체에 `T.onStreamingFallback?.()` 호출이 있을 것이라고 보지만 본 추출본에서는 명시 호출 grep으로 찾지 못함 (`grep onStreamingFallback`은 옵션 객체 선언만 매치). 동작 의미는 명확.

### 2.4 `onHintCleared` 콜백 (확인)

```js
options: {
  ...
  onHintCleared: (b_, B_) => {
    T_.push({
       type: "hint_clears",
       ids: [...b_],                            // Set → array
       contentById: Object.fromEntries(B_)      // Map → plain object
    });
    for (let l_ of fi9(x, b_)) Z.readFileState.delete(H9(l_));
    x = Nz_(x, b_, B_);                          // messages 리매핑
  },
  ...
}
```

`b_` 는 `Set<toolUseId>`, `B_` 는 `Map<toolUseId, placeholderContent>`. callModel 내부 `RJ6.onError`의 `retry:context-hint` directive 경로에서 호출 ([call-model.md](call-model.md) §2.2):

```js
let f8 = await JH?.onRequestError(T8, S);
if (f8) {
  S = f8.messages;
  gH = null;
  if (f8.clearedIds.size > 0)
    T.onHintCleared?.(f8.clearedIds, f8.clearedContent);
  return "retry:context-hint";
}
```

**"hint"의 의미** (확인):
- context-hint controller (`iB3` — [call-model.md](call-model.md) 부록)가 관리하는 "이전 tool_result block 캐시 hint"의 단위.
- 5xx/422/424/409 등 서버측 일시 오류 시 controller가 "이 hint들 (tool_use_id 단위) 을 stripping 하고 재시도하면 통과할 가능성" 을 평가, 통과시 stripping 적용.
- `clearedIds`는 stripping된 tool_use_id 집합, `clearedContent`는 각 id에 대해 어떤 placeholder text로 치환할지의 Map.

**`fi9(x, b_)`** ([extracted-functions.js:8417](../../extracted-functions.js#L8417), 확인):

```js
function fi9(H, _) {
  let q = [];
  for (let K of H) {
    if (K.type !== "assistant" || !Array.isArray(K.message.content)) continue;
    for (let O of K.message.content)
      if (O.type === "tool_use" && O.name === pq /* "Read" */ && _.has(O.id)) {
        let T = O.input.file_path;
        if (typeof T === "string") q.push(T);
      }
  }
  return q;
}
```

→ **clearing되는 hint 중 `Read` 도구로 file을 읽은 것들의 `file_path` 목록을 추출**.

**`readFileState.delete(H9(l_))`** ([extracted-functions.js:3290](../../extracted-functions.js#L3290) `toAbsolutePath`는 path 정규화 — relative→absolute, `~` 해석, null-byte 검증, NFC normalize):

- `readFileState`는 Read 도구가 "이 파일을 마지막으로 읽었을 때의 timestamp"를 추적하는 Map. Edit/Write 시 "마지막 Read 이후 외부 수정 있으면 stale" 검사에 사용된다.
- hint가 cleared되면 모델은 그 Read의 내용을 더 이상 알지 못한다 → 다음에 같은 파일을 Edit 하려면 다시 Read해야 함 → readFileState에서 제거하여 모델이 다음에 그 파일에 접근하기 위해 다시 Read하도록 유도.

**`Nz_(x, b_, B_)`** ([extracted-functions.js:8422](../../extracted-functions.js#L8422), 확인):

```js
function Nz_(H, _, q) {
  if (_.size === 0) return [...H];
  return H.map((K) => {
    if (K.type !== "user" || !Array.isArray(K.message.content)) return K;
    let O = false;
    let T = K.message.content.map(($) => {
      if ($.type !== "tool_result" || !_.has($.tool_use_id)) return $;
      let z = q?.get($.tool_use_id) ?? lz8;   // lz8 = "[Old tool result content cleared]"
      if ($.content === z) return $;
      return O = true, {...$, content: z};
    });
    return O ? {...K, message: {...K.message, content: T}} : K;
  });
}
```

→ `messages` 안의 user role tool_result block들 중 cleared id에 해당하는 것을 `B_`가 제공한 placeholder content로 in-place 치환 (immutable shallow re-build). 매핑이 없으면 기본 `"[Old tool result content cleared]"` (`clearedHintPlaceholder` [extracted-functions.js:8424](../../extracted-functions.js#L8424)).

**`hint_clears` 이벤트를 `T_` (pending events) buffer에 push하는 이유** (확인):
- 콜백은 callModel 내부에서 동기 호출되지만, 이때는 Bq3의 `for await` body 한가운데이므로 직접 yield 할 수 없다.
- `T_.push({type:"hint_clears", ...})` 로 보관 후, **다음 iteration 시작 시** `if (T_.length > 0) yield* T_, T_.length = 0` 로 flush.
- catch (`FallbackTriggeredError` fallback) 진입 시에도 `if (T_.length > 0) yield* T_` — 즉 fallback으로 inner-loop 재진입 직전에도 flush.

**왜 콜백이 Bq3 (옵션)이고 callModel 안에 직접 박혀있지 않은가** (추정):
- `runTurnLoop`만 `messages` (`x`), `readFileState` (`Z.readFileState`) 같은 turn-level 상태에 접근 가능.
- callModel은 stateless API caller에 가깝게 설계되어, "이 retry directive의 부수효과로 메시지를 어떻게 정규화할지" 는 caller 책임.
- 결과적으로 `runTurnLoop` 만 알고 있어야 할 정보 (`messages` 변수, `readFileState`) 가 callModel 클로저에 들어가지 않도록 분리.

### 2.5 `latestStopReason` (`KH`) 누적 (확인)

```js
let KH = null;       // turn-level latestStopReason
...
if (J_.type === "stream_event" && J_.event.type === "message_delta") {
  KH = J_.event.delta.stop_reason;
  // ... G_ 동기화 ...
}
```

stream 끝난 뒤 malformed tool_use 판정에 사용:

```js
if ((T_?.message.stop_reason ?? KH) === "tool_use" && _H.length === 0 && !T_?.isApiErrorMessage) {
  // "stop_reason은 tool_use라고 했는데 실제 tool_use block은 0개" → 모델이 parse-fail
  let b_ = D.transition?.reason !== "malformed_tool_use_retry";
  if (b_) {
    // "Your tool call was malformed..." meta 주입 후 retry
    ...
    transition: {reason: "malformed_tool_use_retry"}
  } else {
    // 재시도도 실패 — 종료
    yield buildErrMsg("The model's tool call could not be parsed (retry also failed).")
    return {reason: "completed"}
  }
}
```

**왜 마지막 assistant 메시지의 `stop_reason`만으로는 부족한가**:
- `T_` (위 코드의 변수, `wH.at(-1)`) 가 undefined일 수 있다 (예: 모델이 한 줄도 응답 안 한 경우 — `RH.length === 0` 에 가까운 케이스).
- 또는 마지막 assistant 메시지의 `stop_reason` 필드가 callModel의 in-place mutate (`hK.message.stop_reason = T_`) 가 일어나기 전에 yield 됐을 가능성 (race) — **추정**.
- `KH`는 `message_delta`에서 직접 캡처되므로 **반드시 최신 stop_reason 보유** (확인).
- `T_?.message.stop_reason ?? KH` — fallback chain.

### 2.6 `T_` (pending events) buffer (확인)

선언: `let T_ = [];` — inner-loop iteration 시작 시 매번 새로 만들어진다 (`try { while(DH) { DH=false; let T_=[]; try { ... } } }`).

채워지는 시점:
- `onHintCleared` 콜백 (위 §2.4)

flush되는 시점:
1. **`for await` body 진입 직후 매 iteration 시작** — `if (T_.length > 0) yield* T_, T_.length = 0`
2. **`FallbackTriggeredError` catch 직후** — fallback inner-loop 재시도 진입 직전 `if (T_.length > 0) yield* T_, T_.length = 0`
3. **try 본체 정상 종료 후** — `if (T_.length > 0) yield* T_, T_.length = 0` (callModel stream이 normal end로 끝났을 때 잔여 flush)

**왜 `T_`가 필요한가**:
- callModel의 `for await`은 next event를 await하는 동안 `onHintCleared` 콜백이 동기 invoke될 수 있다.
- 콜백 안에서 직접 `yield`를 부를 수 없으므로 (generator suspend 위치는 `for await`의 await 지점), buffer 후 다음 resume 시 flush.

**관찰**: 현재 코드에서 `T_`에 push되는 건 `hint_clears`뿐. `compact_progress`/`sdk_status`/`notification`/`response_length` 등은 `compactProgressQueue` queue를 통해 별도 경로로 흘러나옴 ([compaction-system.md](compaction-system.md)). 요청서가 언급한 "T_가 그것들도 포함한다" 는 일부 부정확 — **확인**: 코드 검사 결과 T_는 hint_clears 전용. (compact류 이벤트는 turn loop의 다른 단계에서 발사됨)

### 2.7 `wH`, `JH`, `_H` 누적기 lifecycle (확인)

`runTurnLoop`의 turn body 시작점에서 선언:

```js
let wH = [],   // collectedAssistant — 모든 모델 응답 (assistant role) 원본
    JH = [],  // collectedToolResults — 도구 실행 결과 (user role, tool_result 포함)
    _H = [],  // pendingToolUses — 이번 stream에서 도착한 tool_use block들
    t = false, // sawToolUse — _H에 한 번이라도 push된 적 있나
    KH = null; // latestStopReason
```

#### `wH` (collectedAssistant)

채워지는 시점 (확인):
```js
if (J_.type === "assistant") {
  wH.push(J_);
  // ... _H 누적 ...
}
```
**원본 `J_` 를 push** — backfill 패치본 `b_`가 아니다. 다음 모델 호출 시 messages에 그대로 들어간다 (`D.messages = [...x, ...wH, ...JH]`).

리셋 시점 (확인):
1. `onStreamingFallback` (`H_=true`) 직후: `wH.length = 0`
2. `FallbackTriggeredError` catch (model fallback) 직후: `wH.length = 0`

읽히는 시점:
- stream 끝에서 `wH.at(-1)` 로 마지막 assistant (`T_` 로컬 변수 — Stop hook 분기 / Fa7 분기 / malformed 분기 등의 분기 결정)
- `Ua7(wH, errMsg, J)` 로 partial tool_use에 대한 가짜 tool_result 생성 (모델 에러 시)
- `wH.some(...)` 로 키워드 검출 텔레메트리
- `wH.flatMap(...).length` 로 tool_use 개수 (텔레메트리)
- `T57([...x, ...wH], ...)` — 다음 turn 메시지 준비
- `D = {messages: [...x, ...wH, ...JH], ...}` — next_turn / max_output_tokens_recovery / malformed retry / stop_hook_blocking 모든 분기

#### `JH` (collectedToolResults)

채워지는 시점 (확인):
```js
// 1. gX_ 도구 결과 (stream 중)
if (TH && !aborted) for (let l_ of TH.getCompletedResults()) {
  ...
  if (l_.message) {
    if (yield l_.message, !_P_(l_.message)) {
      let p_ = i0([l_.message], refreshTools(), mainLoopModel);
      y$_(p_, mA(mainLoopModel).maxBase64Size);
      JH.push(...p_.filter((u_) => u_.type === "user"));
    }
  }
}

// 2. tool batch 결과 (stream 끝 후)
for await (let T_ of toolStream) {
  ...
  if (T_.message) {
    if (yield T_.message, T_.message.type === "attachment" && ...) ...
    if (!_P_(T_.message)) {
      let H_ = i0([T_.message], dH.options.refreshTools()??tools, mainLoopModel);
      y$_(H_, mA(mainLoopModel).maxBase64Size);
      JH.push(...H_.filter((G_) => G_.type === "user"));
    }
  }
}

// 3. PostToolBatch hook의 additional context
if (J_.additionalContexts && J_.additionalContexts.length > 0) {
  let b_ = T9({type:"hook_additional_context", ...});
  yield b_, JH.push(b_);
}

// 4. SnH (message queue) 처리 결과
for await (let T_ of SnH(...)) yield T_, JH.push(T_);

// 5. memdir prefetch flush
if (P && P.settledAt !== null && P.consumedOnIteration === -1) {
  let T_ = Qa7(await P.promise, Z.readFileState);
  for (let H_ of T_) { let G_ = T9(H_); yield G_, JH.push(G_); }
  P.consumedOnIteration = C - 1;
}

// 6. Skill discovery prefetch
if (Uy8 && m) {
  let T_ = await Uy8().collectSkillDiscoveryPrefetch(m);
  for (let H_ of T_) { let G_ = T9(H_); yield G_, JH.push(G_); }
}
```

리셋 시점:
1. `onStreamingFallback`: `JH.length = 0`
2. `FallbackTriggeredError` catch: `JH.length = 0`

읽히는 시점:
- `D = {messages: [...x, ...wH, ...JH], ...}` next_turn에서만
- `JH.find(...)` PostToolBatch payload에서 tool_response lookup

#### `_H` (pendingToolUses)

채워지는 시점 (확인):
```js
if (J_.type === "assistant") {
  wH.push(J_);
  let l_ = J_.message.content.filter((p_) => p_.type === "tool_use");
  if (l_.length > 0) _H.push(...l_), t = true;
  if (TH && !Z.abortController.signal.aborted) for (let p_ of l_) TH.addTool(p_, J_);
}
```

리셋: `wH`와 동일 (1) onStreamingFallback (2) ANH catch.

읽히는 시점:
- `_H.length === 0` → malformed tool_use 분기 판정
- `_H.length === 1 && _H[0].name === az` → loop dynamic wakeup 분기
- tool 실행: `Hj_(_H, wH, T, Z)` (non-streaming 분기) 또는 `TH.getRemainingResults()` (streaming 분기 — _H은 이미 `TH.addTool` 으로 enqueue됨)
- PostToolBatch hook payload 빌더가 `_H.map(...)` 로 tool_name/tool_input/tool_use_id 트리오 생성

#### 누적기 vs `G_` (backfill patch list)

`G_`는 **현재 stream 도중에만 살아있는 mini-buffer** — message_delta 도착 시마다 비워짐. 누적기와 다른 lifecycle.

### 2.8 도구 결과 후처리 — `isVirtualMessage` + `expandAttachments` + `enforceBase64Limit` (확인)

```js
if (!_P_(l_.message)) {                                     // (a)
  let p_ = i0([l_.message],                                  // (b)
              Z.options.refreshTools?.() ?? Z.options.tools,
              Z.options.mainLoopModel);
  y$_(p_, mA(Z.options.mainLoopModel).maxBase64Size);        // (c)
  JH.push(...p_.filter((u_) => u_.type === "user"));         // (d)
}
```

#### (a) `_P_(msg)` — virtual 메시지 predicate (확인)

```js
function _P_(H) {
  return (H.type === "user" || H.type === "assistant") && H.isVirtual === true;
}
```

`isVirtual: true`로 마킹된 메시지는 **permission system이 합성한 가짜 메시지** ([extracted-functions.js:13614](../../extracted-functions.js#L13614) 근처에서 `hf({content:[{type:"tool_use", ...}], isVirtual:true})` 형태로 생성 — `decidePermission` permission orchestrator의 hook payload 빌드용). 이런 메시지는 컨슈머에 yield는 되지만 (UI는 보여줄 수 있음) 다음 모델 호출의 messages에 들어가서는 안 됨. **확인**.

`isVirtualMessage`가 true인 경우 `JH`에 들어가지 않으므로 `D.messages = [...x, ...wH, ...JH]` 다음 턴 빌드에서 제외된다. (또한 i0/y$_ 처리도 우회 — 최적화)

#### (b) `i0(msgs, tools, model)` — attachment expansion (확인)

[extracted-functions.js:15542](../../extracted-functions.js#L15542). 의사코드 발췌:

```js
function i0(H, _ = [], q) {
  let K = q !== undefined && Ll_(q),               // model이 image 지원하는지
      O = new Set(_.map((Z) => Z.name)),           // tool name set
      T = Zz3(H, true),                            // 메시지 평탄화
      $, z = new Map;
  // ... attachment 매칭 + 직전 user 메시지에 binding 정보 누적 ...
  // ... iCachedAttachments / inline-image / context block 빌드 ...
  // (이하 본 추출본에서는 첫 ~1000자만 분석)
}
```

**역할** (확인 — 함수명과 호출 패턴에서 추정):
- 도구 결과 메시지 안의 attachment block (이미지/file content reference 등)을 모델이 받아볼 수 있는 inline form (`type:"image"`, `type:"document"` content block 등)으로 expand.
- `Ll_(model)` 검사로 multimodal 미지원 모델인 경우 이미지를 dropped/placeholder 처리.
- `tools` 인자는 `mcpInfo` 같은 도구별 메타정보를 받아서 expansion 규칙에 활용 (예: 어떤 도구의 결과는 첨부로 처리할지).

상세 의사코드 분석은 본 분량을 벗어남 — 본 문서는 흐름만 다룬다.

#### (c) `y$_(msgs, maxBytes)` — base64 사이즈 enforcement (확인)

```js
function y$_(H, _) {
  let q = [], K = 0;
  for (let O of H) {
    // user role, content array 인지 검증
    if (...) continue;
    for (let $ of O.message.content) {
      if (FQ9($)) gQ9($, ++K, _, q);        // 단일 image/document block — base64 검사
      else if (ne1($)) for (let z of $.content) if (FQ9(z)) gQ9(z, ++K, _, q);  // nested tool_result content
    }
  }
  if (q.length > 0) throw new mUH(q, _);     // ImageSizeError
}
```

`mUH = class extends Error` (line 7870 근처) — 메시지 형식: `"Image base64 size (X) exceeds API limit (Y). Please resize the image before sending."` 또는 N개 초과 시 `"N images exceed the API limit (Y): Image 1: X1, Image 2: X2, ... Please resize these images before sending."` (확인).

`mUH` 가 throw되면 Bq3의 outer catch가 받아서:
```js
if (T_ instanceof mUH || T_ instanceof iF) {
  N(`Query image error: ${H_}`, {level: "error"});
  let M_ = y1({content: T_.message, error: "invalid_request", errorDetails: T_.message, ...});
  return yield M_, pJH(Z, z, M_), {reason: "image_error"};
}
```
→ 즉시 turn 종료 (reason: `image_error`). PTL/이미지 reactive compact 경로와 다름 — 이건 **클라이언트 측 사전 검증 실패**, 후자는 **API가 거절**.

#### (d) `mA(model).maxBase64Size` — 모델별 제한 (확인)

```js
function mA(H) {
  let _ = Fn1(),                                // env 또는 default cap
      q = vm9(H)?.imageLimits ?? Un1[Z7(H)];    // model-specific limits
  if (!q) {
    if (_ === Hn.maxBase64Size) return Hn;      // default
    return {...Hn, maxBase64Size: _, targetRawSize: _ * 3 / 4};
  }
  let K = q.maxBase64Size ?? _;
  return {
    maxWidth:       q.maxWidth   ?? Hn.maxWidth,
    maxHeight:      q.maxHeight  ?? Hn.maxHeight,
    maxBase64Size:  K,
    targetRawSize:  q.targetRawSize ?? K * 3 / 4
  };
}
```

`maxBase64Size`는 base64 인코딩 후 bytes 기준. `targetRawSize = maxBase64Size * 3/4` = raw bytes 권장 상한 (base64는 ~33% 오버헤드). 모델별로 Anthropic API 측 제한이 다를 수 있어 (`Un1[Z7(model)]`), 클라이언트가 사전에 거절. `Fn1()` env (`CLAUDE_CODE_*` 류로 추정) 로 오버라이드 가능.

---

## 3. State / Schema

### 3.1 callModel → Bq3 이벤트 union (확인)

```ts
type CallModelEvent =
  | { type: "stream_event"; event: SseEvent; ttftMs?: number /* message_start만 */ }
  | { type: "assistant"; message: AssistantMessage; requestId: string; uuid: string;
      timestamp: string; querySource, spawnedBySkill, activeSkill /* Gg() 결과 */;
      advisorModel?: string }
  | { type: "user"; message: { role:"user"; content: string | ContentBlock[] };
      isApiErrorMessage?: boolean; apiError?: "max_output_tokens"; error?: string;
      errorDetails?: string; uuid, timestamp }
  | RetryStatusMessage   /* RJ6 generator가 yield — HI8(err, delayMs, attempt, max) */

type SseEvent =
  | { type:"ping" }
  | { type:"message_start"; message: { id, role:"assistant", model, content:[],
        stop_reason: null, usage, diagnostics? } }
  | { type:"content_block_start"; index: number;
      content_block: { type:"text"|"tool_use"|"thinking"|"server_tool_use"|"advisor_tool_result"; ... } }
  | { type:"content_block_delta"; index: number;
      delta: { type:"text_delta"; text: string }
           | { type:"input_json_delta"; partial_json: string }
           | { type:"thinking_delta"; thinking: string }
           | { type:"signature_delta"; signature: string }
           | { type:"citations_delta"; citations: any } }
  | { type:"content_block_stop"; index: number }
  | { type:"message_delta";
      delta: { stop_reason: StopReason; stop_details?: any; diagnostics?: { cache_miss_reason?: string } };
      usage: PartialUsage }
  | { type:"message_stop" }

type StopReason =
  "end_turn" | "max_tokens" | "stop_sequence" | "tool_use"
  | "model_context_window_exceeded" | "refusal" | "pause_turn" | ...
```

### 3.2 `runTurnLoop` inner-stream-loop 로컬 변수 (확인)

| 변수 | 타입 | 의미 | scope |
|---|---|---|---|
| `H_` | `boolean` | onStreamingFallback flag | inner try block (turn) |
| `G_` | `Array<{src: AssistantMsg, dst: AssistantMsg}>` | backfill 패치 쌍, message_delta 도착 시 동기화 후 비움 | inner try block |
| `M_` | `AssistantMsg[]` | image error용 deferred yield buffer | inner try block |
| `T_` | `Array<{type:"hint_clears",...}>` | onHintCleared pending events | inner iteration |
| `KH` | `string \| null` | latestStopReason | turn body (전체) |
| `wH` | `AssistantMsg[]` | collectedAssistant 원본 | turn body |
| `JH` | `UserMsg[]` | collectedToolResults (i0/y$_ post-processed) | turn body |
| `_H` | `ToolUseBlock[]` | pendingToolUses | turn body |
| `t` | `boolean` | sawToolUse | turn body |
| `TH` | `gX_ \| null` | streaming tool exec container | turn body (gate에 따라 생성) |
| `DH` | `boolean` | inner-loop run flag | turn body — `false` 로 시작 후 분기에서 `true` 로 셋해서 재진입 |

### 3.3 yield 지연 분기 — `predicateApiError` / `predicateImageError` / `predicateMaxOutputTokens` (확인)

| predicate | 위치 | 매칭 조건 | 의미 |
|---|---|---|---|
| `r47(msg)` | [extracted-functions.js:9891](../../extracted-functions.js#L9891) | API error 메시지 중 PTL (prompt too long, `predicatePromptTooLong` 결과) | PTL/413 응답 → 이번 turn 끝에 reactive compact 처리 |
| `rD8(msg)` | [extracted-functions.js:9892](../../extracted-functions.js#L9892) | API error 메시지 중 image error (image_too_large 류) | image 에러 → 별도 분기 (image_error) |
| `Fa7(msg)` | [extracted-functions.js:14053](../../extracted-functions.js#L14053) | `msg.apiError === "max_output_tokens"` | max_output_tokens recovery 후보 |

세 가지 모두 callModel이 `message_delta` 처리 중 직접 `y1({content:"...", apiError:"max_output_tokens"})` 또는 `y1({content: errorMsg, error:"invalid_request"})` 형태로 yield한 user role 메시지. **stream 진행 중에는 yield 보류**, stream 끝난 뒤의 별도 분기에서 처리.

`M_` (image error 전용 buffer)는 좀 다르다 — `predicateImageError` 매치 시 `M_.push(J_)` 후 보류했다가, **그 다음에 non-error 이벤트가 오면 그 직전에 `yield* M_`** 으로 flush. 즉 normal 이벤트가 또 오는 경우 (드물지만) image error도 흘려보낸 뒤 normal 이벤트 yield. **확인 필요**: 이 로직이 실제로 normal 이벤트가 후속 도착할 시나리오가 있는지 — **추정**으로는 image error 후엔 message_stop만 남기 때문에 거의 영향 없음.

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| stream event 타입 | `message_*` / `content_block_*` SSE 단순 통과 | + `assistant` 메시지 자체 yield (block_stop마다 1회), `user` API error yield, retry status yield |
| backfillObservableInput | 없음 (도구가 input mutate를 직접) | 인터페이스 명시화 — 도구가 declarative method 노출, Bq3가 lazy copy & message_delta로 usage 역주입 |
| streaming fallback | 없음 | `onStreamingFallback` 콜백 → tombstone + 누적기 리셋 + gX_ 재생성 |
| hint clearing | 없음 | context-hint controller (`iB3`) + `onHintCleared` → messages 리매핑 + readFileState invalidate + pending event |
| latestStopReason | 없음 (마지막 assistant만 검사) | `KH` 누적 — `message_delta`에서 직접 캡처, race 회피 |
| malformed tool_use 검출 | 없음 | `stop_reason === "tool_use"` + `_H.length === 0` → meta 주입 후 1회 retry |
| 도구 결과 post-process | 단순 append | `isVirtualMessage` virtual 제외 + `expandAttachments` attachment expansion + `enforceBase64Limit` base64 size 검증 (모델별 cap) |
| pending events buffer | 없음 | `T_` inner-iteration buffer + `G_` backfill patch list |

---

## 5. Examples

### 5.1 `backfillObservableInput` 실제 흐름 (확인 — 코드 추론)

모델이 `Read({file_path: "./src/foo.ts"})` 호출:

1. callModel이 SSE 통해 `content_block_start` (tool_use, index=0) → 여러 `input_json_delta` → `content_block_stop` 발사 → 마지막에 `assistant` 이벤트 합성:
   ```js
   { type: "assistant",
     message: { id:"msg_abc", role:"assistant", model:"claude-opus-4-7",
                content: [{type:"tool_use", id:"toolu_1", name:"Read",
                           input:{file_path:"./src/foo.ts"}}],
                stop_reason: null, usage: {input_tokens: N, ...} },
     requestId, uuid, ... }
   ```
2. Bq3 backfillObservableInput 패스:
   - `eK(tools, "Read", aliases)` → Read tool definition
   - `tool.backfillObservableInput({file_path:"./src/foo.ts"})` 가 in-place mutate
   - mutate 결과: `{file_path:"./src/foo.ts", absolute_path:"/Users/.../src/foo.ts"}` ← 신규 key `absolute_path` 추가 (**예시; 실제 key 명칭은 도구 contract**)
   - `Object.keys(CH).some(X_ => !(X_ in WH))` true (absolute_path가 새로 추가됨) → lazy copy
   - `b_` = patched 사본, `G_.push({src: J_.message, dst: b_.message})`
3. `yield b_` → UI는 `{file_path:"./src/foo.ts", absolute_path:"/Users/.../src/foo.ts"}` 가 보이는 사본을 받음
4. `wH.push(J_)` → 다음 모델 호출 messages에 들어가는 건 **원본** (`absolute_path` 없는 form)
5. 잠시 후 `message_delta` 도착, `KH = delta.stop_reason`, `G_`의 dst에 `usage`/`stop_reason` 역주입, `G_.length = 0`

**효과**:
- 컨슈머 (transcript renderer)는 모델 의도와 실제 도구 실행 대상 경로를 모두 본다.
- 모델 history에는 원본 form 유지 — 다음 턴에 같은 메시지를 다시 평가할 때 일관성.

### 5.2 `onHintCleared` 실제 흐름 (확인 — 코드 추론)

모델이 이전 턴에 `Read("foo.ts")` 와 `Read("bar.ts")` 를 호출하고 결과를 받았다고 하자. messages는:

```
[..., {role:"assistant", content:[{type:"tool_use", id:"toolu_A", name:"Read", input:{file_path:"foo.ts"}},
                                 {type:"tool_use", id:"toolu_B", name:"Read", input:{file_path:"bar.ts"}}]},
      {role:"user", content:[{type:"tool_result", tool_use_id:"toolu_A", content:"<foo.ts 내용>"},
                             {type:"tool_result", tool_use_id:"toolu_B", content:"<bar.ts 내용>"}]},
      ...]
```

이번 턴에 callModel이 5xx 오류 받음 → context-hint controller가 "이 두 tool_result를 strip하면 통과할 가능성 있음" 판정 → `onHintCleared(new Set(["toolu_A","toolu_B"]), new Map([["toolu_A","<stripped>"], ["toolu_B","<stripped>"]]))` 호출.

1. `T_.push({type:"hint_clears", ids:["toolu_A","toolu_B"], contentById:{toolu_A:"<stripped>", toolu_B:"<stripped>"}})`
2. `fi9(x, Set(["toolu_A","toolu_B"]))` → `["foo.ts", "bar.ts"]`
3. 각각에 대해:
   - `H9("foo.ts")` → `"/Users/.../foo.ts"` (정규화)
   - `Z.readFileState.delete("/Users/.../foo.ts")` — 다음에 Edit("foo.ts") 시 "Read 안한 파일" 오류 또는 자동 Read 트리거
4. `x = Nz_(x, ...)` → messages 안의 두 tool_result content가 `"<stripped>"` 로 교체된 새 array

5. callModel은 directive `"retry:context-hint"` 리턴 → RJ6가 `J.add("retry:context-hint")` 후 attempt 1회 차감, **새 페이로드** (`x` = updated messages) 로 K_ 재호출 → 재요청 → 성공.

6. Bq3는 다음 iteration 시작 시 `yield* T_` → 컨슈머 (UI) 가 hint_clears 이벤트 받음 → "두 파일의 캐시된 read 결과가 정리되었습니다" 류 표시 가능.

---

## 부록: 미확인 / 추정

- `aY6(messages, userContext)` 정의 위치 — grep으로 단 한 곳의 use site만 발견. 정의가 lazy-init 모듈 안에 숨어있거나 minifier가 inline해서 사라진 것으로 **추정**. 역할은 user context 머지로 추정.
- `onStreamingFallback` 콜백이 callModel 본체 어디서 호출되는지 grep에서 정확히 매치되지 않음 — 옵션 객체 선언 외 사용처가 minify로 숨겨졌을 가능성. 동작은 `tombstone` + 누적기 리셋 패턴에서 명확히 역추론됨.
- `expandAttachments` 함수의 정확한 attachment expansion rule — 본 분석에서는 함수 시작 부분만 확인. tools 인자가 어떤 메타정보를 어떻게 활용하는지 상세는 별도 분석 필요.
- `Aq` (callModel 내부 helper) 의 SDK querySource 시 partial-text 합성이 Bq3의 `tombstonePartialThenError` partial-tool_use 합성과 어떻게 겹치거나 분리되는지 — 두 경로가 동시에 발사될 수 있는지 **확인 필요**. **추정**: `Aq`는 `querySource === "sdk"` 일 때만, `tombstonePartialThenError`은 outer catch 또는 abort 분기에서만 — 서로 다른 시점이라 충돌 없을 것.
- `T_`가 hint_clears 외 다른 이벤트도 받는지 — 코드상 hint_clears만 push되지만, callModel이 다른 콜백 (예: `addNotification`) 을 통해 동기 시그널을 줄 가능성. `addNotification`은 `Z.addNotification` 으로 callModel 옵션에 전달되며 별도 채널 — **확인 필요**.
