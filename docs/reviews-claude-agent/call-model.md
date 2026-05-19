# callModel layer — 단일 API 호출 + 적응형 재시도

진입점: `extracted-functions.js:19054` (`async function* DSK(...)`) 의 본문 안에서 line 19057 (단일 거대 라인, 22141 chars) 에 페이로드 빌더 `buildCreatePayload`, 외부 재시도 루프 `H:for(;;)`, 스트리밍 watchdog, error→directive 분기, non-streaming fallback 까지 전부 인라인되어 있다.

이 문서는 **한 번의 `messages.create` 호출**을 둘러싼 모든 로직을 다룬다 — 그 위에 있는 turn loop (`runTurnLoop`) 와 그 아래에 있는 SDK 클라이언트 (`xu`) 는 다른 문서에서 다룬다.

---

## 1. 호출 그래프

```
Bq3.callModel (agent loop)
  └─ DSK(messages, systemPrompt, thinkingConfig, tools, signal, options)   ← line 19054
       │
       ├─ 전처리 (한 번만, RJ6 바깥)
       │   ├─ 메시지 정규화 (i0, JM_, ez3, DM_, Y7K, OU3 ...)
       │   ├─ 시스템 프롬프트 조립 + 캐시 마커 (jU3 → wU3와 별개로 system 측)
       │   ├─ 도구 스키마 빌드 (Xj6, deferLoading 처리)
       │   ├─ sticky betas 결정 (Sk_/Ck_/Ik_, 세션 sticky)
       │   ├─ context hint controller 생성 (JH = iB3(...))
       │   └─ getEAH/effort 처리
       │
       └─ H:for(;;)                              ← outer retry/state-loop (label "H")
            │
            ├─ RJ6(clientFactory, sendFn, retryCfg)   ← line 15620, SDK-level retry generator
            │   │   • clientFactory: xu({maxRetries:0, model, fetchOverride, source})
            │   │   • sendFn(client, attempt, vq):
            │   │       1. K_(vq)              ← payload 빌더, line 19057 의 let K_=(OH)=>{...}
            │   │       2. JSK(payload)        ← verbose 로깅 (line 19045)
            │   │       3. bS_(payload, qs)    ← repl_main_thread 전용 prompt 추적 (line 3218)
            │   │       4. mq6({...payload, stream:true}, qs)  ← OTEL trace body 기록 (line 9786)
            │   │       5. CLAUDE_SLOW_FIRST_BYTE_MS setTimeout 설치 (default 30s)
            │   │       6. clientRequestId(DH) 생성 → header x-client-request-id
            │   │       7. client.beta.messages.create({...payload, stream:true},
            │   │                                      {signal, headers:{wmH:DH}}).withResponse()
            │   │
            │   ├─ RJ6 내부 재시도 (line 15620 RJ6, line 15622 Re backoff):
            │   │     • 429 → header retry-after / anthropic-ratelimit-unified-reset 반영
            │   │     • 529 overloaded → consecutive 카운터 → fallbackModel 시 ANH throw
            │   │     • stale connection (jA3) → keep-alive 해제 후 재시도
            │   │     • OAuth 401/403 → 토큰 invalidate → 재시도 (최대 TA3=2)
            │   │     • fastMode 거부 (JA3) → fastMode off
            │   │     • context overflow (f7K) → maxTokensOverride 자동 축소
            │   │     • CCR auth exhausted (KA3=2) → XS throw
            │   │     • exponential backoff Re(): base 500ms, factor 2, jitter +25%, cap 32s
            │   │     • CLAUDE_CODE_MAX_RETRIES env (default _A3=10)
            │   │
            │   └─ onError(err) → directive enum (선택):
            │         "retry:afk-beta"           ← gT8(err): afk-mode 베타 거부
            │         "retry:advisor-strip"      ← zd9(err): advisor 결과 거부
            │         "retry:media-strip:<kind>:<m>.<c>"        ← xT8(err): 특정 경로
            │         "retry:media-strip-latest:<kind>:<i>"     ← nEK fallback (최대 3회)
            │         "retry:cache-diagnosis-beta" ← Ad9(err): cache-diagnosis 베타 거부
            │         "retry:thinking-type"      ← wd9(err): thinking.type 거부
            │         "retry:mid-conv-system"    ← Yd9(err): role:"system" 거부
            │         "retry:context-hint"       ← JH.onRequestError (5xx/422/424/409)
            │         (각 directive는 J 집합에 등록되어 동일 directive 재사용 방지)
            │
            ├─ 스트리밍 watchdog (RJ6 성공 이후, do/while 로 yield 시작)
            │   ├─ event-tier idle (CLAUDE_ENABLE_STREAM_WATCHDOG): warn at j_/2, abort at j_
            │   ├─ byte-tier idle: ok1() ReadableStream wrapping (Pl_ StreamIdleTimeoutError)
            │   └─ stall detector: 30s gap → tengu_streaming_stall
            │
            ├─ stream events 소비 (zU3, ping heartbeats)
            │   • message_start / content_block_start / *_delta / *_stop / message_delta
            │   • RH (assistant messages) 누적 → yield
            │   • Aq(): SDK querySource 일 때 partial yield (abort 시 부분 결과)
            │
            ├─ 스트리밍 실패 분기
            │   • Pl_ (StreamIdleTimeoutError) → tengu_streaming_idle_timeout
            │   • XO (abort)                   → throw (또는 SDK timeout → FB)
            │   • stale-connection (Ne_)       → CH=2회까지 같은 H 루프 재실행
            │   • 404 streaming endpoint       → YSK (non-streaming fallback)
            │   • CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK 또는 partial yield → throw
            │   • 그 외                         → JH.onStreamFallback → YSK fallback
            │
            └─ finally
                ├─ dH(): NH/fH 정리 (slow-first-byte timeout + AbortController + body cancel)
                ├─ f47(): 요청 종료 텔레메트리 (tengu_api_query 등)
                └─ G_ usage merge into oH (turn 누적 토큰)
```

`retryHelper` 자체는 generator: `yield HI8(err, delay, attempt, max)` 로 외부에 retry status 메시지를 흘려보내고, 외부 do/while 은 그 메시지를 user 에게 yield 한다 (`do if(LH=await OH.next(),!("controller"in LH.value))yield LH.value;while(!LH.done)`). 마지막 `LH.value` (done) 가 SDK Response body 가 되어 stream 소비 단계로 넘어간다.

---

## 2. 핵심 로직

### 2.1 페이로드 빌더 `K_(OH)`  (line 19057)

```js
// pseudocode — minified ids 그대로 보존, 의미는 주석으로 표기
let K_ = (OH) => {                                  // OH: per-attempt overrides
  let LH = [...w];                                  // base betas (uu(model) + SDK extras)

  // 1M context auto-add
  if (!LH.includes(pU) && Zl_(model) !== null) LH.push(pU);

  // provider-scoped extras (Bedrock inference-profile 등) → output_config로 분리
  let BH = ED(model) === "bedrock" ? [...W68(model), ...P ? [P] : []] : [];
  let bH = O4H(BH);                                 // CLAUDE_CODE_EXTRA_BODY merge
  let j_ = { ...bH.output_config ?? {} };
  delete bH.output_config;

  // output_config 가공: effort / task_budget / format
  rB3(_H, j_, bH, LH, A);                            // effort beta 추가
  oB3(T.taskBudget, j_, LH);                         // task_budget 빔
  aB3(T.outputFormat, j_, LH, T.model);              // structured outputs

  // max_tokens 결정: override 우선
  let w_ = OH?.maxTokensOverride                     // RJ6 가 context-overflow 시 주입
        || T.maxOutputTokensOverride
        || $KH(T.model);                             // 모델 default upper-1

  // thinking block 결정
  let U_ = q.type !== "disabled"
        && !xH(process.env.CLAUDE_CODE_DISABLE_THINKING);
  let H6 = U_ ? q.display : undefined;
  let e_;
  if (U_ && k77(A)) {                                // 모델이 thinking 지원
    let z9 = xH(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
          && (j.includes("opus-4-6") || j.includes("sonnet-4-6"));
    let i6 = MV6(T.model);                           // 세션 per-model override
    if (i6 !== undefined ? i6 === "adaptive"
                          : i86(A) && !z9)            // 4-6/4-7 → adaptive 기본
      e_ = { type: "adaptive", display: H6 };
    else {
      let Gq = Nj9(A);                               // model upper-1
      if (q.type === "enabled" && q.budgetTokens !== undefined)
        Gq = q.budgetTokens;
      Gq = Math.min(w_ - 1, Gq);
      e_ = { budget_tokens: Gq, type: "enabled", display: H6 };
    }
  }

  // thinking → redact_thinking 베타 제거
  if (e_ && H6) {
    let z9 = LH.indexOf(xK_);
    if (z9 !== -1) LH.splice(z9, 1);
  }

  // context_management (clear_thinking edits)
  let L6 = gEK({ hasThinking: U_ });                 // { edits: [{type:"clear_thinking_20251015", keep:"all"}] }

  // prompt caching 설정 (line 19029 ASK)
  let a8 = T.enablePromptCaching ?? ASK(OH.model);

  // speed: "fast"
  let y8;
  if (z4() && u2() && !Va() && dj(T.model) && !!OH.fastMode)
    y8 = "fast";                                     // 1P + 모드 가용 + 쿨다운 없음 + Opus-4-6/4-7

  // sticky beta 마커 추가 (fast / afk / cache_editing / 1h cache)
  if (o && !LH.includes(kxH)) LH.push(kxH);          // fast 베타
  if (CC && HH && CR() && Y && !LH.includes(CC)) LH.push(CC);  // afk-mode
  let T8 = Z && Jq() === "firstParty" && T.querySource === "repl_main_thread";
  if (W && s && Jq() === "firstParty" && ...) LH.push(W);      // cache-edit beta
  if (Q === "1h" && CR() && !LH.includes(T2H)) LH.push(T2H);   // extended-cache-ttl

  // context-hint controller 가 베타 + body 주입
  let f8 = null, vq = JH?.buildRequestParams(S);
  if (vq) { LH.push(vq.beta); f8 = vq.body; }

  // cache-diagnosis 베타
  if (wH && !LH.includes(zqH)) LH.push(zqH);

  // CLAUDE_CODE_SIMULATE_PROXY_USAGE → 모든 betas 제거
  let _6 = xH(process.env.CLAUDE_CODE_SIMULATE_PROXY_USAGE);

  // temperature: thinking 비활성 + 모델이 temperature 지원 시에만
  let D8 = !U_ && kl_(A) ? T.temperatureOverride ?? 1 : undefined;

  aH = _6 ? [] : kP(LH);                             // 텔레메트리용 betas 캡처

  return {
    model: XX(T.model),                              // provider별 id 변환
    messages: wU3(S, a8, Q, T8,                       // 캐시 마커 부착
                  gH, rH, T.skipCacheWrite, T.forkPointUuid),
    system: c,                                       // 시스템 프롬프트 array
    tools: qH,
    tool_choice: T.toolChoice,
    ...(l && !_6 && { betas: kP(Ij9(LH)) }),         // dedup + provider 필터
    metadata: IAH(),                                 // user_id JSON-stringified
    max_tokens: w_,
    thinking: e_,
    ...(D8 !== undefined && { temperature: D8 }),
    ...(L6 && l && LH.includes(O2H)
       && { context_management: L6 }),               // 베타가 있어야만
    ...(!_6 && f8 ? f8 : {}),                        // context_hint body
    ...bH,                                           // CLAUDE_CODE_EXTRA_BODY 잔여
    ...(Object.keys(j_).length > 0 && { output_config: j_ }),
    ...(y8 !== undefined && { speed: y8 }),
    ...(wH && Y && l && !_6
        && { diagnostics: { previous_message_id: z ?? null } })
  };
};
```

**`wU3(H, _, q, K, O, T, $, z)` — 캐시 마커 부착** (line 19062)
- `H`: messages array
- `_`: enablePromptCaching
- `q`: ttl (`"1h"` or undefined → 5min default)
- `K`: isReplMainThread (cache-editing 활성 분기 표식)
- `O = gH`: pendingCacheEdits — `Ji9()` 가 microcompact 가 남긴 1회용 `cache_edits` 블록을 꺼냄 (소비 시 null)
- `T = rH`: pinnedEdits — `Di9()` 가 세션 동안 누적 핀된 cache_edits (재시도 시에도 보존)
- `$`: skipCacheWrite — 캐시 마커 한 칸 위로 밀어 새 라인 marker 생성 방지
- `z`: forkPointUuid — fork 시 fork point 메시지에도 추가 marker 핀
- 마지막 user 메시지(들)에 `cache_control: {type:"ephemeral", ttl?}` 부착
- `ciH()` 결과에 따라 두 번째 marker 추가 (multi-tier caching)
- tool_result 에 `cache_reference: tool_use_id` 자동 부여 (재시도 시 referential cache lookup)

**`Ij9(betas)` — dedup + provider 필터** (line 5217)
- `X68()` (experimental betas 허용) 이면 그대로 반환
- 아니면 `Cj9` allowlist 통과 항목만 (`K2H, GxH, pU, O2H, La, IK_, RxH, $F_, LxH, T2H, kxH, xK_, CC, zF_, zqH, Ci6, ...`)
- `kP(...)` 는 `{name, header}` 객체 배열에서 header 문자열만 추출

**`IAH()` — metadata 빌더** (line 19035)
```js
return { user_id: JSON.stringify({
  ...processEnvCustom,
  device_id: pu(),
  account_uuid: TO()?.accountUuid ?? "",
  session_id: k_()
}) };
```
`user_id` 한 필드에 device/account/session 을 JSON-stringify 해서 박는다 (서버는 자유롭게 파싱).

**`bS_(payload, querySource)` — repl_main_thread 추적** (line 3218)
- `querySource` 가 `"repl_main_thread"` 로 시작할 때만 동작
- `messages` 빼고 나머지 페이로드 메타를 `pk6(...)` 에 등록, `Uk6(null)` 로 prev-trace clear
- 텔레메트리/디버그용 (전송 직전 페이로드 스냅숏)

**`JSK(payload)` — verbose 로깅** (line 19045)
- `Z__() === "verbose"` 일 때만 `[API REQUEST DETAIL]` 한 줄을 SH(JSON-stringify) 로 찍는다.

**`mq6(payload, querySource)` — OTEL trace export** (line 9786)
- `gK7()` (`ENABLE_BETA_TRACING_DETAILED` + `BETA_TRACING_ENDPOINT`) 활성 시 동작
- assistant content 의 `thinking`/`redacted_thinking` 블록을 `<REDACTED>` 로 치환 후
- `QK7("api_request_body", body, {model, query_source})` 로 OTEL 이벤트 발사
- 파일 모드면 `<dir>/<request_id>.request.json` 에 raw body 저장 (60KB 초과 시 별도 파일)

### 2.2 재시도 state-machine

세 층의 재시도가 중첩되어 있다:

1. **outer `H:for(;;)` loop** — context-hint / stale-connection / 404→non-streaming fallback / 모든 directive 회수 후 재진입 (RJ6 generator 가 매번 새로 호출됨)
2. **`retryHelper` inner loop** (line 15620) — backoff 기반 SDK-level retry (429, 529, 5xx, 408, 409, fastMode 거부, OAuth, context overflow)
3. **stale-stream retry** (`__ < CH(=2)`) — body 받기 시작 전에 conn close → 짧은 backoff (`100 * __ ms`) 후 outer 루프 재진입

**directive 라우팅** (RJ6 의 `onError` async 함수, line 19057 chunk2):

```js
onError: async (T8) => {
  // ── 1. afk-beta (CC=afk-mode 베타) ────────────
  if (HH && gT8(T8)) {
    HH = false;
    if (CC) Ik_(m, CC);                          // sticky beta 제거
    Jd8?.setAutoModeActive(false);
    Jd8?.setAutoModeCircuitBroken(true);          // 세션 단위 latch
    return "retry:afk-beta";
  }

  // ── 2. advisor-strip ─────────────────────────
  if (zd9(T8)) {                                  // "Advisor tool result content could not be processed"
    S = qI8(S);                                   // assistant 콘텐츠에서 advisor_tool_result 제거
    gH = null;                                    // pending cache edits drop
    d("tengu_advisor_strip_retry", ...);
    return "retry:advisor-strip";
  }

  // ── 3. media-strip (targeted 또는 broad) ────
  {
    let f8 = xT8(T8);                             // 400 + image/document path 추출
    if (f8) {
      let vq = T8.message;
      if (f8.messageIdx !== undefined && f8.contentIdx !== undefined) {
        // 정확한 path → 해당 블록만 placeholder text 로 교체
        let D8 = lEK(S, {messageIdx, contentIdx, kind}, vq);
        if (D8 !== S) {
          S = D8; gH = null;
          u_.set(f8.kind, vq);                    // user 에게 errorDetails yield 할 메시지 보관
          return `retry:media-strip:${kind}:${m}.${c}`;
        }
      }
      // 정확한 path 없음 → 가장 최근 base64 carrier 의 미디어 전부 제거
      // 최대 c_=3 회까지
      let _6 = WH.value < c_ ? nEK(S, f8.kind, vq) : undefined;
      if (_6) {
        WH.value++;
        S = _6.messages; gH = null;
        u_.set(f8.kind, vq);
        return `retry:media-strip-latest:${kind}:${carrierIdx}`;
      }
    }
  }

  // ── 4. cache-diagnosis-beta ──────────────────
  if (wH && Ad9(T8)) {
    wH = false;
    Ik_(m, zqH);                                  // sticky beta 제거
    return "retry:cache-diagnosis-beta";
  }

  // ── 5. thinking-type fallback ────────────────
  {
    let f8 = wd9(T8);                             // "enabled" or "adaptive"
    if (f8) {
      let vq = f8 === "enabled" ? "adaptive" : "enabled";
      fV6(T.model, vq);                           // 세션 per-model override
      return "retry:thinking-type";
    }
  }

  // ── 6. mid-conv-system fallback ──────────────
  if (x && Yd9(T8)) {
    w = w.filter((f8) => f8 !== Zv);              // beta 제거
    S = x; x = null;                              // 시스템 메시지를 <system-reminder> 본문 포맷으로 fallback
    if (Zv) Ik_(m, Zv);                           // sticky beta 제거 (/clear /compact 시까지)
    return "retry:mid-conv-system";
  }

  // ── 7. context-hint ──────────────────────────
  {
    let f8 = await JH?.onRequestError(T8, S);
    if (f8) {
      S = f8.messages; gH = null;
      if (f8.clearedIds.size > 0) T.onHintCleared?.(...);
      return "retry:context-hint";               // microcompact (mc) 적용 + 베타 strip
    }
  }

  return;                                         // → RJ6 의 일반 backoff 경로로 빠짐
}
```

**dedup 가드**: RJ6 자체가 `J = new Set` 으로 동일 directive 가 두 번 반환되면 그대로 throw 한다 (`if (P && !J.has(P)) { J.add(P); D--; continue }`). 각 directive 는 첫 번째 등장 시에만 적용된다. 다만 `media-strip-latest:<kind>:<carrierIdx>` 는 carrierIdx 가 매번 다르므로 최대 3회 (`c_=3`) 까지 새 directive 로 계속 인정된다.

### 2.3 스트리밍 watchdog

이중 tier:

```js
let bH = xH(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG);  // event-tier opt-in
let j_ = j68();                                          // CLAUDE_STREAM_IDLE_TIMEOUT_MS or 300000
let w_ = j_ / 2;                                         // warning at half
// e_, L6 = setTimeout handles

let y8 = function() {
  a8();                                                  // clear both
  if (!bH) return;                                       // event-tier opt-in only
  let T8 = performance.now();
  e_ = setTimeout((f8, vq) => {
    if (performance.now() - vq < f8) return;             // suspend-resume guard
    N(`Streaming idle warning: no chunks received for ${f8/1000}s`, {level:"warn"});
    G6("warn", "cli_streaming_idle_warning");
  }, w_, w_, T8);

  L6 = setTimeout(() => {
    let f8 = performance.now() - T8;
    if (f8 < j_/2) {                                     // suspend re-arm
      N(`Stream watchdog fired after suspend ... re-arming`);
      y8(); return;
    }
    U_ = true; H6 = performance.now();
    d("tengu_streaming_idle_timeout", {
      model, request_id, timeout_ms: j_, tier: "event"
    });
    dH();                                                // abort + cleanup
  }, j_);
};
```

**byte-tier watchdog** (`ok1`, line 5183): SDK fetch wrapper 가 ReadableStream 을 감싸서 byte 단위 idle 검사. 기본 ON (`ak1()` 가 `true` 반환 — `tengu_stream_watchdog_default_on` gate). `Pl_(StreamIdleTimeoutError)` 가 발생하면 catch 절에서 `tengu_streaming_idle_timeout` (tier: "byte") 텔레메트리 + bytesReceived/ttfbMs/bodyReadPending/cfRay 까지 보고.

**slow first-byte warning** (line 19057 chunk2): `parseInt(process.env.CLAUDE_SLOW_FIRST_BYTE_MS) || 30000` ms 후 한 번 발사. `tengu_api_slow_first_byte` 이벤트 (model, provider, attempt, elapsed_ms). 실제 abort 는 하지 않음 — 텔레메트리/UX 경고용. 첫 chunk 도착 시 `yH()` 가 timeout 취소.

**stream stall detector** (chunk3): event 간 30s 이상 갭이 생기면 `tengu_streaming_stall` 발사 (누적 stall count + total stall time). 종료 시 `tengu_streaming_stall_summary` 발사.

### 2.4 `clientRequestId` (DH) 생성 조건

```js
let z9 = Jq();
DH = (z9 === "firstParty" && bT())               // bT(): ANTHROPIC_BASE_URL 미설정 or api.anthropic.com
   || (z9 === "anthropicAws" && !process.env.ANTHROPIC_AWS_BASE_URL)
   ? SsH.randomUUID()
   : undefined;
```

해당하면 매 attempt 마다 새 UUID 생성, header `wmH = "x-client-request-id"` 로 전송. 서버측 멱등 (retry 시 동일 요청 dedup) — 다만 attempt 별로 UUID 가 다르므로 directive-driven 재시도는 매번 새 ID 가 된다. 추정: 서버는 **rate-limit 카운팅 dedup** + **billing dedup** 용으로 사용.

**fetch 레이어에서도 동일 헤더 보장**: `sk1()` 어댑터 (line 5185) 가 보낸 fetch 가 header 에 `x-client-request-id` 가 없으면 직접 채워 넣는다 (안전망).

3P provider 분기: bedrock/vertex/foundry/mantle/gateway 는 ID 미발급 (서버측 dedup 없음).

### 2.5 non-streaming fallback (`nonStreamingFallback`, line 19046)

stream 실패 (또는 404) 시:
1. `kH = GH` (직전 streaming attempt 의 request_id 보존)
2. `YSK(...)` 가 `retryHelper` 를 한 번 더 돌리되 `stream: false` + `timeout: HU3()` (env `API_TIMEOUT_MS` 또는 remote=120s/일반=300s)
3. `xu({maxRetries:0})` 새 클라이언트, `DU3(payload, JU3)` 가 payload 에서 streaming-only 필드 제거
4. 응답 비어있으면 (`$d9` 검사 실패) "API returned an empty or malformed response — check for a proxy" 예외 — 프록시가 SSE 를 가로채는 경우 대응

`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 또는 partial yield 발생 시엔 fallback 금지 (이미 사용자에게 일부 응답을 yield 한 상태이므로 중복 응답을 막기 위함).

---

## 3. State / Schema

### 3.1 페이로드 shape (확인)

```ts
{
  model: string,                                 // XX(T.model) → provider-prefixed
  messages: Array<{
    role: "user" | "assistant" | "system",
    content: string | Array<ContentBlock>,
  }>,
  system: Array<{type:"text", text:string, cache_control?: ...}>,
  tools: Array<ToolSchema>,
  tool_choice?: { type: "auto" | "any" | "tool" | "none", name?:string },
  betas?: string[],                              // dedup + 1P/3P 필터
  metadata: { user_id: string /* JSON stringified */ },
  max_tokens: number,
  thinking?:
    | { type: "adaptive", display?: ThinkingDisplay }
    | { type: "enabled", budget_tokens: number, display?: ThinkingDisplay },
  temperature?: number,                          // thinking 비활성 + 모델 지원 시
  context_management?: {                         // O2H 베타 + 시뮬레이션 off 시
    edits: Array<{ type: "clear_thinking_20251015", keep: "all" }>
  },
  // CLAUDE_CODE_EXTRA_BODY (사용자 주입) ↓
  anthropic_beta?: string[],                     // env path
  // context-hint controller body ↓
  context_hint?: { enabled: true, target_tokens_saved?: number },
  // provider extras (bedrock output_config 등) ↓
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max",
    task_budget?: { type: "tokens", total: number, remaining?: number },
    format?: any,                                // structured outputs
    ...
  },
  speed?: "fast",                                // firstParty + Opus-4-6/4-7 + fastMode on
  diagnostics?: { previous_message_id: string | null },  // cache_diagnosis 베타 + repl_main_thread
}
```

### 3.2 retry directive enum (확인 — 문자열 그대로)

```
"retry:afk-beta"
"retry:advisor-strip"
"retry:media-strip:<kind>:<msgIdx>.<contentIdx>"
"retry:media-strip-latest:<kind>:<carrierIdx>"
"retry:cache-diagnosis-beta"
"retry:thinking-type"
"retry:mid-conv-system"
"retry:context-hint"
```

추가로 RJ6 가 자체 발사하는 status 메시지 (사용자에게 yield):
- `HI8(err, delayMs, attempt, maxRetries)` — api_error_status 메시지
- 외부 `T.onRetry?.({retryInMs, attempt, maxRetries, error})` — connection bar 갱신용

### 3.3 watchdog state (확인)

```ts
{
  // event-tier
  e_: NodeJS.Timeout | null,   // warning timer (j_/2)
  L6: NodeJS.Timeout | null,   // abort timer (j_)
  U_: boolean,                  // watchdog-tripped flag
  H6: number | null,            // performance.now() at trip — exit-delay 측정
  bH: boolean,                  // CLAUDE_ENABLE_STREAM_WATCHDOG opt-in

  // byte-tier (in ok1 wrapper)
  bytesReceived: number,
  ttfbMs: number | null,
  bodyReadPending: boolean,
  cfRay: string | undefined,

  // first-byte
  NH: NodeJS.Timeout | null,   // slow-first-byte warn timer

  // stale-stream retry
  __: number,                   // attempt count
  CH: 2,                        // max stale retries (constant)

  // media-strip-latest
  WH: { value: number },        // attempt counter
  c_: 3,                        // hard cap
  u_: Map<kind, message>,       // strip 결과 yield 페이로드 보관
}
```

### 3.4 RJ6 retry context (line 15620, 확인)

```ts
{
  model: string,
  thinkingConfig: ThinkingConfig,
  fastMode?: boolean,           // RJ6 가 거부 시 false 로 변경 → K_ 재호출 시 반영
  maxTokensOverride?: number,   // f7K context-overflow 시 RJ6 가 주입
}
```

RJ6 는 이 객체를 sendFn(client, attempt, **ctx**) 의 세 번째 인자로 매번 전달. K_ 는 `OH.maxTokensOverride` / `OH.fastMode` 를 읽어 새 페이로드를 만든다. 즉 RJ6 의 결정이 다음 attempt 의 페이로드에 즉시 반영된다.

### 3.5 sticky betas (확인 — `WV6()` 가 반환하는 `m`)

세션 내 영속화되는 beta latch — `Sk_/Ck_/Ik_(m, beta)` 로 set/check/clear.
- `kxH` (fast) — fastMode active 시 sticky
- `afkBetaFlag` (afk-mode) — auto-mode active 시 sticky, afk-beta directive 시 영구 해제
- `zqH` (cache-diagnosis) — `KU3()` (`Z_("tengu_prompt_cache_diagnostics", false)`) gate
- `Zv` (mid-conversation-system) — `/clear` `/compact` 까지 sticky-reject

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 (`querySonnet`) | v2.1.143 (`callModelOuter` + `buildCreatePayload` + `retryHelper`) |
|---|---|---|
| 호출 구조 | 단일 함수 `querySonnet(messages, ...)` | DSK generator (~3000 라인 인라인) + K_ payload builder + RJ6 retry generator |
| 재시도 | exponential backoff + fallbackModel | 3계층: RJ6 backoff (429/529/5xx/network) + directive (7종 의미적) + outer `H:for(;;)` (404/stale/context-hint) |
| Directive | 없음 (모든 에러를 throw 또는 backoff) | `retry:afk-beta`/`advisor-strip`/`media-strip[:targeted\|latest]`/`cache-diagnosis-beta`/`thinking-type`/`mid-conv-system`/`context-hint` 7종 + dedup Set |
| Media handling | image 거부 시 그냥 throw | 400 메시지에서 `messages[m].content[c]` path 정규식 추출 → 정확히 그 블록만 placeholder 로 치환. path 없으면 latest carrier 의 base64 media 전부 제거 (최대 3회) |
| Thinking | 없음 (Claude 3 기준) | `{type:"adaptive"}` / `{type:"enabled", budget_tokens}` 분기, 모델별 fV6 세션 override, 거부 시 enabled↔adaptive 자동 swap |
| Cache markers | `cache_control: ephemeral` 단순 부착 | wU3 가 pendingCacheEdits + pinnedEdits + forkPointUuid + skipCacheWrite 까지 처리, multi-tier (5m/1h), tool_result 자동 cache_reference 부여 |
| Watchdog | 없음 (SDK timeout 만) | 이중 tier: event-tier (opt-in, `CLAUDE_ENABLE_STREAM_WATCHDOG`) + byte-tier (`ok1` ReadableStream wrapper, default on via `tengu_stream_watchdog_default_on`), suspend-resume re-arm, stall detector (30s gap), slow-first-byte warn (default 30s) |
| Streaming fallback | `stream: true` 만 | 404 streaming endpoint → YSK (non-streaming) 자동 fallback, stream stale-conn → CH=2회 짧은 backoff 재시도, partial yield 시 fallback 금지 |
| Client request ID | 없음 | `x-client-request-id` UUID per attempt (1P + bT() / anthropicAws 기본 host), 서버 dedup 용. `sk1` fetch adapter 가 누락 시 자동 보충 |
| Beta 헤더 | 고정 list | sticky 세션 latch (`m` via Sk_/Ck_/Ik_), per-attempt 동적 조립, `dedupBetas` dedup + provider 필터, `serializeBetas` header 추출, `O4H` CLAUDE_CODE_EXTRA_BODY merge |
| Fast mode | 없음 | `speed: "fast"` (firstParty + Opus-4-6/4-7 + 쿨다운 없음), 거부 시 RJ6 가 ctx.fastMode=false 로 자동 전환 |
| Context management | 없음 | `contextMgmtBetaHeader` 베타 + `clear_thinking_20251015` edit 자동 부착 (CLAUDE_CODE_SIMULATE_PROXY_USAGE off 시) |
| Diagnostics | 없음 | `wH && Y && l && !_6` 일 때 `diagnostics: {previous_message_id}` — 서버측 cache-miss-reason 상관관계 추적 (추정), 응답의 `diagnostics.cache_miss_reason` 을 `zi9` 로 학습 데이터 회수 |
| Metadata | `user_id: <session>` | `user_id: JSON({device_id, account_uuid, session_id, ...env extra})` |
| Output config | 없음 | effort / task_budget / format 을 별도 `output_config` 객체로 묶고 각자 베타 헤더 자동 부여 (`RxH`/`$F_`/`La`) |
| Context overflow | 명시 처리 없음 | RJ6 가 400 메시지 정규식 (`input length and 'max_tokens' exceed context limit: A + B > C`) 으로 파싱 → `maxTokensOverride` 주입 후 재시도 |
| OAuth handling | 401 → throw | 401/403 / OAuth revoked → token invalidate → 재시도 (최대 TA3=2), CCR auth 분리 카운터 (KA3=2) |
| Telemetry | 최소 | per-attempt: `tengu_api_retry` / `tengu_api_slow_first_byte` / `tengu_streaming_idle_timeout` (event/byte 별) / `tengu_streaming_stall[_summary]` / `tengu_streaming_fallback_to_non_streaming` / `tengu_media_block_strip_retry` (targeted vs broad) / `tengu_advisor_strip_retry` / `tengu_advisor_tool_interrupted` / `tengu_stream_loop_exited_after_watchdog` / `tengu_stream_no_events` |

---

## 부록: 주요 식별자 (검증)

| Minified | 위치 | 역할 |
|---|---|---|
| `buildCreatePayload` | line 19057 (`let K_=(OH)=>{...}` 안) | per-attempt payload builder. T (호출 옵션) 와 `w`/`m`/`S`/`c`/`qH`/`gH`/`rH` 등 클로저 변수를 캡처 |
| `retryHelper` | line 15620 | SDK-level retry async generator. backoff + auth refresh + onError directive dispatch |
| `insertCacheMarkers` | line 19062 | cache marker placement (pendingCacheEdits + pinnedEdits + fork point) |
| `dedupBetas` | line 5217 | beta dedup + 3P provider 필터 (Cj9 allowlist) |
| `serializeBetas` | line 4153 | `{name, header}[]` → `header[]` |
| `IAH` | line 19035 | metadata builder (user_id JSON stringify) |
| `buildContextMgmtParam` | line 19003 | context_management edits builder (`clear_thinking_20251015`) |
| `O4H` | line 19028 | `CLAUDE_CODE_EXTRA_BODY` env JSON merge + anthropic_beta append |
| `ASK` | line 19029 | enablePromptCaching 결정 (env disable 체크) |
| `bS_` | line 3218 | repl_main_thread 페이로드 trace (analytics) |
| `JSK` | line 19045 | `[API REQUEST DETAIL]` verbose log |
| `mq6` | line 9786 | OTEL `api_request_body` trace (thinking 블록 redact) |
| `gT8` | line 7933 | afk-mode beta 거부 detector (400 + beta header 메시지) |
| `zd9` | line 7934 | advisor 결과 거부 detector |
| `xT8` | line 7919 | 400 메시지에서 media path 추출 |
| `bT8` | line 7918 | 정규식 `messages[N].content[N]...image\|document\|pdf` |
| `Ad9` | line 7935 | cache-diagnosis beta 거부 detector |
| `wd9` | line 7937 | thinking.type 거부 detector → "enabled"/"adaptive" 반환 |
| `Yd9` | line 7936 | mid-conv-system 거부 detector (Zv beta header) |
| `lEK` | line 19007 | 타겟된 media 블록 placeholder 치환 |
| `nEK` | line 19010 | latest carrier 의 base64 media 전부 placeholder 치환 (carrierIdx 반환) |
| `qI8` | line 15611 | assistant content 에서 advisor_tool_result 제거 |
| `iB3` | line 19027 | context-hint controller 생성 (microcompact + cache-hint beta) |
| `fV6` | line 1820 | `F_.thinkingTypeOverrides.set(model, type)` — 세션 per-model thinking 강제 |
| `MV6` | line 1819 | 위의 get |
| `clientRequestIdHeader` | line 5186 | `"x-client-request-id"` 헤더명 상수 |
| `Pl_` | line 5186 | `StreamIdleTimeoutError` class (idleMs / bytesReceived / ttfbMs / bodyReadPending / cfRay) |
| `j68` | line 5182 | `Math.max(Number(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS)\|\|0, 300000)` |
| `ok1` | line 5183 | byte-tier watchdog ReadableStream wrapper |
| `ak1` | line 5184 | byte-watchdog default-on gate (`tengu_stream_watchdog_default_on`) |
| `sk1` | line 5185 | fetch adapter (`x-client-request-id` 자동 보충 + ok1 wrapping) |
| `nonStreamingFallback` | line 19046 | non-streaming fallback generator (`stream:false`, HU3 timeout) |
| `HU3` | line 19044 | `parseInt(env.API_TIMEOUT_MS)` or remote=120s / 일반=300s |
| `bT` | line 4060 | ANTHROPIC_BASE_URL 가 api.anthropic.com 또는 미설정 |
| `apiProvider` | line 4052 | provider 결정 (bedrock/foundry/anthropicAws/mantle/vertex/firstParty) |
| `afkBetaFlag` | line 4153 | `cM("afk_mode", "afk-mode-2026-01-31")` |
| `zqH` | line 4153 | `cM("cache_diagnosis", "cache-diagnosis-2026-04-07")` |
| `Zv` | line 4153 | `cM("mid_conversation_system", "mid-conversation-system-2026-04-07")` |
| `Ci6` | line 4153 | `cM("context_hint", "context-hint-2026-04-09")` |
| `kxH` | line 4153 | `cM("speed", "fast-mode-2026-02-01")` |
| `contextMgmtBetaHeader` | line 4153 | `cM("context_management", "context-management-2025-06-27")` |
| `pU` | line 4153 | `cM("long_context", "context-1m-2025-08-07")` |
| `T2H` | line 4153 | `cM("extended_cache_ttl", "extended-cache-ttl-2025-04-11")` |

미확인 / 추정:
- `diagnostics.previous_message_id` 의 서버측 의미는 cache-miss-reason 상관관계 추적으로 **추정** (`zi9(B_, {previousMessageId, ...})` 호출이 응답의 `cache_miss_reason` 을 학습 시그널로 다시 보내는 패턴에서 역추정).
- `clientRequestId` 의 서버측 dedup 의미는 **추정** — 동일 ID 재전송 시 idempotent 처리한다는 가정.
- `x` 변수 (mid-conv-system fallback 시 `S = x` 로 복원): 미확인. `S` 의 시스템-메시지 미포함 버전을 보관하는 것으로 **추정**.
