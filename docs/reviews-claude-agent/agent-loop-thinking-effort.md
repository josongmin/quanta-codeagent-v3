# Agent loop — thinking config / reasoning effort / fast mode / max_tokens 결정

`runTurnLoop` ([`extracted-functions.js:14057`](../../extracted-functions.js#L14057)) 의 turn loop 가 매 턴 `J.callModel` (= `callModelOuter`) 에 넘기는 옵션 중 **thinking / effort / fastMode / maxOutputTokensOverride** 가 어떻게 정해지고, `callModelOuter` ([`extracted-functions.js:19054`](../../extracted-functions.js#L19054)) 의 페이로드 빌더 `buildCreatePayload` ([`extracted-functions.js:19057`](../../extracted-functions.js#L19057)) 가 그것을 `thinking` / `max_tokens` / `speed` / `output_config.effort` 필드로 어떻게 굳히는지를 다룬다.

본 문서는 [`call-model.md`](call-model.md) §2.1 의 `buildCreatePayload` 의사코드를 thinking/effort/speed/max_tokens 축으로만 깊게 파고든 보강분이다. retry directive `retry:thinking-type` 의 fallback 메커니즘은 [`call-model.md`](call-model.md) §2.2 와 교차한다.

---

## 1. 호출 그래프

```
Bq3 (turn loop)
  └─ 매 turn iteration 마다 callModel 옵션 객체 재구성  (line 14057, byte ~10132100)
       options.thinkingConfig    = Z.options.thinkingConfig          # 세션 고정
       options.fastMode          = Z.getFastMode()                   # X.gates.fastModeEnabled 일 때만; 매 턴 app-state 재조회
       options.effortValue       = Z.getEffortValue()                # 매 턴 app-state 재조회
       options.maxOutputTokensOverride = v                           # caller(H.maxOutputTokensOverride)에서; 매 continue 마다 undefined 리셋
       │
       └─ DSK(H,_, q=thinkingConfig, K=tools, O=signal, T=options)   (line 19054)
            │ ── 전처리 (RJ6 바깥, 1회) ──
            │   A  = bedrock inference-profile 해소된 모델 id
            │   j  = Z7(A)               # 정규화된 모델 id (provider prefix/[1m] 제거)
            │   e  = z4()&&u2()&&!Va()&&dj(T.model)&&!!T.fastMode    # fast 가용 플래그
            │   _H = EAH(A, T.effortValue)                            # 해소된 effort level
            │   t  = QP(A)&&_H!==void 0 ? _GH(_H) : void 0            # 텔레메트리/검증용 effort 값
            │   o  = Ck_(m,kxH)          # fast sticky beta 활성 여부
            │
            ├─ M47({...thinkingType, effortValue:_H?, fastMode:e, ...})  # tengu_api_query 텔레메트리 (1회)
            │     └─ K_({model:T.model, thinkingConfig:q}) 한 번 호출해 thinking.type/output_config.effort 추출
            │
            └─ RJ6( clientFactory, sendFn(client,attempt,vq), retryCtx )   (line 15620)
                 sendFn:
                   vq.fastMode  ← RJ6 가 fastMode 거부 시 false 로 바꿔 전달
                   vq.maxTokensOverride ← RJ6 가 context-overflow 시 주입
                   _6 = K_(vq)                # ← per-attempt payload 빌드
                 retryCtx = { model, fallbackModel, thinkingConfig:q,
                              ...(z4()? {fastMode:e} : false), signal, querySource,
                              onError: directive dispatcher }
```

핵심 함수 위치 (확인):

| 함수 | 위치 | 역할 |
|---|---|---|
| `buildCreatePayload` | line 19057 (`aH=[],K_=(OH)=>{...}`) | per-attempt payload 빌더 |
| `k77(A)` | [`extracted-functions.js:9592`](../../extracted-functions.js#L9592) (byte 6435616) | 모델 thinking 지원 여부 |
| `i86(A)` | [`extracted-functions.js:9593`](../../extracted-functions.js#L9593) (byte 6435714) | adaptive thinking 기본 여부 |
| `Nj9(A)` | [`extracted-functions.js:5202`](../../extracted-functions.js#L5202) (byte 4182953) | `U$H(A).upperLimit-1` |
| `U$H(model)` | (byte 4182217) | 모델별 `{default, upperLimit}` thinking/max_tokens 표 |
| `$KH(model)` | [`extracted-functions.js:12977`](../../extracted-functions.js#L12977) (byte 12977095) | 모델 default max_tokens (+env clamp) |
| `MV6(model)` / `fV6(model,type)` | [`extracted-functions.js:1819`](../../extracted-functions.js#L1819) | 세션 per-model thinking-type override get/set |
| `zwH()` | (byte 6436076) | `alwaysThinkingEnabled` 설정 + `MAX_THINKING_TOKENS` env 체크 (thinking 전역 enable) |
| `L77(s)` / `n86(s)` | [`extracted-functions.js:9590`](../../extracted-functions.js#L9590) | `\bultrathink\b` 정규식 test / 위치 추출 |
| `o93(s)` | [`extracted-functions.js:14273`](../../extracted-functions.js#L14273) (byte ~10246460) | ultrathink → `{type:"ultrathink_effort"}` attachment |
| `EAH(model, fallback)` | (byte ~5701-region, after `Ze_`) | effort level 해소 (env + 모델 silent downgrade) |
| `QP(model)` | (byte 5698281) | 모델 effort 파라미터 지원 여부 |
| `L$_` / `k$_` | (byte 5698669 / 다음) | `max` / `xhigh` effort 모델 지원 여부 |
| `Ge_(model)` | (byte 5701773) | 모델 기본 effort (`opus-4-7`→`xhigh`, 그 외 `high`) |
| `Ze_(model)` | (byte ~5701, before EAH) | opus-4-7 + `!unpinOpus47LaunchEffort` 면 launch-default 강제 |
| `bUH()` | (byte ~5700) | `CLAUDE_CODE_EFFORT_LEVEL` env (`unset`/`auto`→null) |
| `_GH(v)` | (byte 5701042) | effort 값 정규화 (유효치 아니면 `"high"`) |
| `z4` / `u2` / `Va` / `dj` | (byte 3438028 / 3438204 / 3441777 / 3439776) | fast mode 게이트들 |
| `M47` | [`extracted-functions.js:6549907`](../../extracted-functions.js) | `tengu_api_query` 텔레메트리 |
| `gEK({hasThinking})` | (byte 12933009) | `context_management` edits 빌더 |
| `Zl_(model)` | (byte 4181744) | 1M context auto-add (sonnet-4-6 + clientData) |

---

## 2. 핵심 로직

### 2.1 Thinking 타입 결정 (`buildCreatePayload` 의 `e_`)

`buildCreatePayload` 내부 (line 19057) 그대로:

```js
let w_ = OH?.maxTokensOverride || T.maxOutputTokensOverride || $KH(T.model);
let U_ = q.type !== "disabled"
      && !xH(process.env.CLAUDE_CODE_DISABLE_THINKING);   // thinking 켜졌나
let H6 = U_ ? q.display : void 0;                          // thinking display 옵션
let e_ = void 0;

if (U_ && k77(A)) {                                        // 모델이 thinking 지원?
  let z9 = xH(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
        && (j.includes("opus-4-6") || j.includes("sonnet-4-6"));
  let i6 = MV6(T.model);                                    // 세션 per-model override
  if (i6 !== void 0 ? i6 === "adaptive"                     // override 있으면 그게 우선
                    : i86(A) && !z9)                         // 없으면 모델 기본 + env 게이트
    e_ = { type: "adaptive", display: H6 };
  else {
    let Gq = Nj9(A);                                         // = U$H(A).upperLimit - 1
    if (q.type === "enabled" && q.budgetTokens !== void 0)
      Gq = q.budgetTokens;                                   // caller budget override
    Gq = Math.min(w_ - 1, Gq);                               // max_tokens 보다 1 작게 clamp
    e_ = { budget_tokens: Gq, type: "enabled", display: H6 };
  }
}

if (e_ && H6) {                                              // thinking display 표시 시
  let z9 = LH.indexOf(xK_);                                  // redact-thinking 베타 제거
  if (z9 !== -1) LH.splice(z9, 1);
}
```

결정 트리 (확인):

1. **disabled** — `q.type === "disabled"` 거나 `CLAUDE_CODE_DISABLE_THINKING` truthy → `e_ = undefined`. 페이로드의 `thinking` 은 `undefined` (즉 키는 존재하나 값 없음 — JSON 직렬화 시 빠짐). 추가로 `!k77(A)` (모델이 thinking 미지원 = `claude-3-*`) 면 `U_` 가 true 라도 `e_` 미설정.
2. **adaptive** — `{type:"adaptive", display}`. 다음 중 하나:
   - `MV6(T.model) === "adaptive"` (세션 override 가 adaptive). `MV6`/`fV6` 는 `F_.thinkingTypeOverrides` Map get/set. `fV6` 는 retry directive `retry:thinking-type` 시에만 호출 (서버가 `enabled` 거부하면 `fV6(model,"adaptive")`, 반대도).
   - 세션 override 없고 `i86(A) === true` 이고 `z9 === false`.
3. **enabled** — `{type:"enabled", budget_tokens, display}`. adaptive 조건 미충족 시. `budget_tokens` 결정:
   - 기본 `Nj9(A)` = `U$H(A).upperLimit - 1` (모델별 thinking 상한 -1).
   - `q.type === "enabled" && q.budgetTokens !== undefined` 면 caller 의 `q.budgetTokens` 로 덮어씀.
   - 마지막에 `Math.min(w_ - 1, budget)` 로 **max_tokens 보다 반드시 1 작게** clamp (서버가 `budget_tokens >= max_tokens` 를 거부하므로).

**`k77(A)` — thinking 지원 predicate** (확인):

```js
function k77(H){ let _=Ts(H,"thinking"); if(_!==void 0) return _;
                 return !Z7(H).includes("claude-3-"); }
```

- `Ts(H,"thinking")` 는 `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` env 의 capability override (커스텀 모델용). 없으면 `claude-3-*` 만 thinking 미지원, 그 외 전부 지원.

**`i86(A)` — adaptive 기본 predicate** (확인):

```js
function i86(H){ let _=Ts(H,"adaptive_thinking"); if(_!==void 0) return _;
  let q=Z7(H);
  if(q.includes("claude-3-")||q==="claude-opus-4-0"||q==="claude-opus-4-1"
     ||q==="claude-opus-4-5"||q==="claude-sonnet-4-0"||q==="claude-sonnet-4-5"
     ||q==="claude-haiku-4-5") return !1;
  if(q==="claude-opus-4-7"||q==="claude-opus-4-6"||q==="claude-sonnet-4-6") return !0;
  return Fh(ED(H)); }
```

- **4-7 / 4-6 (opus·sonnet)** 만 adaptive 기본 `true`. 그 외 명시 모델은 `false`.
- 미명시 모델은 `Fh(ED(H))` — provider 가 `firstParty/anthropicAws/foundry/mantle/gateway` 면 `true`, bedrock/vertex 면 `false` (즉 1P 계열은 adaptive 기본).

**`z9` (adaptive 강제 비활성)** (확인):

```js
let z9 = xH(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
      && (j.includes("opus-4-6") || j.includes("sonnet-4-6"));
```

- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` 이 truthy **이면서** 모델이 `opus-4-6` 또는 `sonnet-4-6` 일 때만 adaptive 를 끄고 enabled 로 fallback. **`opus-4-7` 은 이 env 의 영향을 받지 않음** (확인) — opus-4-7 은 항상 adaptive(또는 세션 override) 경로.
- 세션 override `MV6` 가 있으면 `z9` 는 무시됨 (조건문 구조상 `i6 !== void 0` 분기가 우선).

**`Nj9(A)` / `U$H(A)` — budget 기본값 표** (확인):

```js
function Nj9(H){ return U$H(H).upperLimit - 1; }
```

`U$H(model)` → `{default, upperLimit}`:

| 모델 (`Z7` 정규화) | default | upperLimit |
|---|---|---|
| `claude-opus-4-7` | 64000 | 128000 |
| `claude-opus-4-6` | 64000 | 128000 |
| `claude-sonnet-4-6` | 32000 | 128000 |
| `claude-opus-4-5` / `claude-sonnet-4-0` / `claude-sonnet-4-5` / `claude-haiku-4-5` | 32000 | 64000 |
| `claude-opus-4-1` / `claude-opus-4-0` | 32000 | 32000 |
| `claude-3-opus` | 4096 | 4096 |
| `claude-3-sonnet` | 8192 | 8192 |
| `claude-3-haiku` | 4096 | 4096 |
| `claude-3-5-sonnet` / `claude-3-5-haiku` | 8192 | 8192 |
| `claude-3-7-sonnet` | 32000 | 64000 |
| 그 외 (미명시) | `_V1=32000` | `qV1=128000` |

추가로 `kj9(H)` (커스텀 모델 metadata) 의 `max_tokens >= 4096` 이면 `upperLimit = O.max_tokens`, `default = min(default, upperLimit)` 로 덮어쓴다. 즉 `enabled` 경로의 기본 budget 은 위 표 `upperLimit - 1` (예: opus-4-7 = 127999).

**`q.budgetTokens` override 경로** (확인): caller (turn loop → callModel) 가 thinkingConfig 를 `{type:"enabled", budgetTokens:N}` 로 넘기면 그 N 이 기본값을 대체한다. 단 항상 `Math.min(w_-1, N)` clamp 적용. adaptive 경로에는 budget 자체가 없음.

**전역 enable 게이트 `zwH()`** (확인 — `buildCreatePayload` 직접 호출 아님, thinkingConfig 가 만들어지는 상류에서 사용):

```js
function zwH(){ if(process.env.MAX_THINKING_TOKENS)
                  return parseInt(process.env.MAX_THINKING_TOKENS,10)>0;
                let {settings:H}=Tu();
                if(H.alwaysThinkingEnabled===!1) return !1;
                return !0; }
```

- `MAX_THINKING_TOKENS` env 가 있으면 그 값 > 0 여부로 thinking on/off (양수면 on).
- 없으면 `settings.alwaysThinkingEnabled === false` 일 때만 off, 기본 on. (추정: 이게 `q.type` 을 `"disabled"` vs 활성으로 가르는 상류 입력. `buildCreatePayload` 에는 이미 `q` 로 들어옴.)

### 2.2 `getMaxThinkingTokens` 트리거 워드 — v2.1.143 현황

**v0.2.8 의 "think hard / think harder / megathink / ultrathink → budget 숫자 매핑" 은 사라졌다 (확인).**

v2.1.143 에 남은 것은 `ultrathink` **한 단어뿐**이며, budget 토큰을 직접 올리지 않고 **`ultrathink_effort` attachment** 를 생성한다:

```js
function L77(H){ return /\bultrathink\b/i.test(H); }                  // 존재 검사
function n86(H){ ...matchAll(/\bultrathink\b/gi)...; }                // UI 하이라이트용 위치
function o93(H){ if(!pRH()||!H||!L77(H)) return [];
                 return d("tengu_ultrathink",{}), [{type:"ultrathink_effort"}]; }
```

- `"think"/"think hard"/"think harder"/"megathink"` 같은 v0.2.8 트리거 단어/예산 테이블은 코드베이스에 **존재하지 않음** (`grep` 결과 `ultrathink` 만 매칭).
- `o93` 는 `pRH()` ( `tengu_turtle_carbon` gate, 기본 true) 가 켜진 상태에서 사용자 메시지에 `ultrathink` 가 있으면 `{type:"ultrathink_effort"}` attachment 를 메시지에 붙이고 `tengu_ultrathink` 텔레메트리를 발사한다.
- `n86` 은 입력 박스 렌더링(`kL8`)·자동완성에서 `ultrathink` 글자를 무지개색으로 칠하는 **UI 전용** (예산과 무관).
- 즉 트리거 워드는 더 이상 `thinking.budget_tokens` 를 계산하지 않는다. effort/thinking 결정은 전적으로 `EAH`(effort) + `i86`/`Nj9`(thinking) 경로로 옮겨갔다. `ultrathink_effort` attachment 가 하류에서 effort 를 `max` 쪽으로 끌어올리는 신호로 쓰일 가능성은 **추정** (attachment → effort 매핑 코드는 본 조사 범위 밖, 별도 추적 필요).

### 2.3 Reasoning effort

DSK 전처리에서 (line 19054, 확인):

```js
let _H = EAH(A, T.effortValue);
let t  = QP(A) && _H !== void 0 ? _GH(_H) : void 0;
```

- `T.effortValue` 는 turn loop 가 매 턴 `Z.getEffortValue()` 로 app-state 에서 읽어 넘긴 값 (REPL ctx `replCtxBuilder` 의 `getEffortValue:()=>$H.getState().effortValue`, byte 14036510).
- `_H` 는 그것을 모델 능력에 맞춰 silent downgrade 한 **최종 level**. `t` 는 `_H` 를 `_GH` 로 정규화한 검증 값 (텔레메트리/에러 payload `effort:t`).

**`EAH(model, fallback)` — effort 해소 + silent downgrade** (확인):

```js
function EAH(H,_){
  if(!QP(H)) return;                       // 모델이 effort 미지원 → undefined
  let q = Ze_(H),                          // opus-4-7 launch-effort 핀 여부
      K = Ge_(H),                          // 모델 기본 effort
      O = bUH();                           // CLAUDE_CODE_EFFORT_LEVEL env
  if(O === null) return q ? K : void 0;    // env 가 "unset"/"auto" → 핀이면 K, 아니면 미설정
  let T = O ?? (q?K:void 0) ?? _ ?? K;     // 우선순위: env > 핀-기본 > caller fallback > 기본
  if(T==="max"   && !L$_(H)) return "high"; // ← silent downgrade
  if(T==="xhigh" && !k$_(H)) return "high"; // ← silent downgrade
  return T;
}
```

- `bUH()` = `CLAUDE_CODE_EFFORT_LEVEL` env. `"unset"`/`"auto"` 는 null, 그 외는 `WI()` 로 파싱 (유효 level 또는 숫자).
- 우선순위: **env (`CLAUDE_CODE_EFFORT_LEVEL`) → opus-4-7 launch 핀 기본(`Ge_`) → caller `T.effortValue` → 모델 기본 `Ge_`**.
- **silent downgrade**: 결과가 `"max"` 인데 모델이 max-effort 미지원(`!L$_`)이면 `"high"` 로, `"xhigh"` 인데 미지원(`!k$_`)이면 `"high"` 로 조용히 강등. 이게 hook payload 주석의 *"after any silent downgrade for the selected model"* 그대로다.

**level 집합** (확인): `Yg = ["low","medium","high","xhigh","max"]`.

**`QP(model)` — effort 파라미터 지원 모델** (확인):

```js
function QP(H){ if(xH(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) return !0;
  let _=Ts(H,"effort"); if(_!==void 0) return _;
  let q=Z7(H);
  if(q.includes("claude-3-")||q==="claude-opus-4-0"||q==="claude-opus-4-1"
     ||q==="claude-sonnet-4-0"||q==="claude-sonnet-4-5"||q==="claude-haiku-4-5") return !1;
  if(q==="claude-opus-4-7"||q==="claude-opus-4-6"||q==="claude-sonnet-4-6") return !0;
  return Fh(ED(H)); }
```

- effort 지원: **opus-4-7 / opus-4-6 / sonnet-4-6** 명시 true. `claude-3-*`, opus-4-0/4-1, sonnet-4-0/4-5, haiku-4-5 명시 false. 미명시는 1P 계열이면 true.
- `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` env 로 무조건 강제 가능.

**`L$_` (max 지원) / `k$_` (xhigh 지원)** (확인):

- `L$_` (max-effort): opus-4-7 / opus-4-6 / sonnet-4-6 → true. 그 외 명시 모델 false.
- `k$_` (xhigh-effort): **opus-4-7 만** true (`if(q==="claude-opus-4-7") return !0`). opus-4-6/sonnet-4-6 포함 그 외 명시 모델은 false. 즉 sonnet-4-6 에서 `xhigh` 요청 시 `EAH` 가 `"high"` 로 강등.

**`Ge_` / `Ze_`** (확인):

```js
function Ge_(H){ if(Z7(H)==="claude-opus-4-7") return "xhigh"; return "high"; }
function Ze_(H){ return Z7(H).includes("opus-4-7") && !v_().clientDataCache 류
                        ... !v_().unpinOpus47LaunchEffort; }
```

- 모델 기본 effort: **opus-4-7 = `xhigh`**, 그 외 effort-지원 모델 = `high`.
- `Ze_`: opus-4-7 이고 사용자가 아직 launch-default 를 명시적으로 unpin 하지 않았으면(`!unpinOpus47LaunchEffort`) launch effort 를 핀 → `EAH` 에서 caller 값보다 모델 기본 `Ge_` 가 우선됨 (즉 opus-4-7 신규 사용자는 명시 변경 전까지 `xhigh` 고정).

**API 매핑** (확인): effort 는 `buildCreatePayload` 의 `rB3(_H, j_, bH, LH, A)` 가 `output_config.effort` 로 박는다:

```js
function rB3(H,_,q,K,O){
  if(!QP(O)){ delete _.effort; return; }     // 모델 미지원 → effort 제거
  if("effort" in _) return;                   // EXTRA_BODY 가 이미 박았으면 보존
  if(H===void 0) K.push(RxH);                 // 값 없어도 effort 베타만 추가
  else if(typeof H==="string"){ _.effort=H; K.push(RxH); }
}
```

- 즉 effort 는 최종적으로 `output_config.effort: "low"|"medium"|"high"|"xhigh"|"max"` 필드 + `RxH` 베타 헤더로 전송된다 (`o4H` 가 아니라 `O4H` = `CLAUDE_CODE_EXTRA_BODY` merge 가 `output_config` 를 먼저 깐 뒤 `rB3` 가 채움). 요청서의 `o4H(...)` 는 `O4H` (EXTRA_BODY merge) 의 오타로 보임 — effort 자체 빌더는 `rB3`.
- `_H`(=`EAH` 결과) 가 `rB3` 의 첫 인자 `H` 로 들어가므로 silent downgrade 된 값이 그대로 `output_config.effort` 가 된다.

### 2.4 Fast mode / speed

DSK 전처리 + `buildCreatePayload` (확인):

```js
// DSK preamble:
let e = z4() && u2() && !Va() && dj(T.model) && !!T.fastMode;   // fast 가용
...
if(e) Sk_(m,kxH);                          // fast sticky beta set
let o = Ck_(m,kxH);                        // sticky 활성 여부

// K_ body:
let y8;
if(z4() && u2() && !Va() && dj(T.model) && !!OH.fastMode)  y8 = "fast";
...
if(o && !LH.includes(kxH)) LH.push(kxH);   // fast beta 헤더
...
return { ..., ...(y8!==void 0 && { speed: y8 }) };
```

**`speed` 는 API 페이로드의 `speed: "fast"` 필드** (확인). 다음 5조건 AND:

| 게이트 | 정의 | 의미 |
|---|---|---|
| `z4()` | `Jq()==="firstParty" && !CLAUDE_CODE_DISABLE_FAST_MODE` | 1P 키 + env 미차단 |
| `u2()` | `z4() && ka()===null` | fast mode 사용 불가 사유(`ka()`) 없음 (구독/플랜 체크) |
| `!Va()` | `Va()=Qi6().status==="cooldown"` | 쿨다운 아님 (서버가 `JA3` 으로 fast 거부 시 `ytq` 가 쿨다운 설정) |
| `dj(T.model)` | 아래 | 모델이 fast 지원 |
| `!!OH.fastMode` | RJ6 가 넘긴 per-attempt fastMode (거부 시 false) | `/fast` 토글 상태 |

**`dj(model)` — fast 지원 모델** (확인):

```js
function dj(H){ if(!z4()) return !1;
  let _=H??lM(), K=r7(_).toLowerCase();
  if(Qc()) return K.includes("opus-4-6");
  return K.includes("opus-4-6") || K.includes("opus-4-7"); }
```

- fast 지원: **opus-4-6, opus-4-7**. `Qc()` (추정: 특정 org/플랜) 면 opus-4-6 만.

**`/fast` 토글 → `getFastMode()`** (확인):

- REPL ctx `replCtxBuilder`: `getFastMode: () => $H.getState().fastMode` (byte 14036510). `/fast` 슬래시는 app-state 의 `fastMode` 를 토글, turn loop 가 매 턴 `X.gates.fastModeEnabled && { fastMode: Z.getFastMode() }` 로 옵션에 실어 DSK 로 넘김 → 매 턴 재평가됨 (확인).
- RJ6 가 서버에서 fast 거부(`JA3`) 받으면 retryCtx 의 `fastMode` 를 `false` 로 바꿔 다음 attempt `K_(vq)` 에 반영 (`call-model.md` §3.4) + `ytq` 가 쿨다운 latch.

**`tengu_velvet_cascade` / `tengu_vellum_lantern` / `simple_system_prompt` 상호작용** (확인 — fast 와 직접 결합 아님):

```js
function UL9(H){ let _=Z7(H), q=v_().clientDataCache?.simple_system_prompt;
  if(typeof q==="object"&&q!==null&&Object.entries(q).some(([O,T])=>T===!0&&_.includes(O))) return !0;
  let K=Z_("tengu_velvet_cascade",null);
  if(typeof K!=="object"||K===null||!("models"in K)||!Array.isArray(K.models)) return !1;
  return K.models.some((O)=>typeof O==="string"&&_.includes(O)); }
// f$ memo:
//   CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT env truthy → true
//   IC1(model) (opus-4-7 또는 -eap 등) 아니면 → false
//   UL9 (velvet_cascade / simple_system_prompt clientData) → true
//   else Z_("tengu_vellum_lantern", false)
```

- 이 게이트들은 **system prompt 를 "simple" 변형으로 줄이는 결정**(`f$`/`IC1`/`UL9`)에 쓰인다. fast mode/speed/effort 와 **별개 축** 이며, `buildCreatePayload` 의 `speed`/`thinking`/`effort` 결정에는 관여하지 않는다 (확인). 즉 fast mode 와 simple-system-prompt 는 독립이고, 요청서가 의심한 "interaction" 은 코드상 직접 결합 없음 — 다만 둘 다 동일 모델군(opus-4-6/4-7)을 타깃해 같이 켜질 확률이 높다는 정도 (추정).

### 2.5 `max_tokens` 해소

`buildCreatePayload` (확인):

```js
let w_ = OH?.maxTokensOverride          // ① RJ6 가 context-overflow(f7K) 시 주입
      || T.maxOutputTokensOverride      // ② DSK 옵션 (turn loop 의 v = D.maxOutputTokensOverride)
      || $KH(T.model);                  // ③ 모델 default
...
return { ..., max_tokens: w_, ... };
```

우선순위 (확인):

1. **`OH.maxTokensOverride`** — per-attempt. `retryHelper` 의 retryCtx (`call-model.md` §3.4). 400 메시지 `input length and 'max_tokens' exceed context limit: A + B > C` 를 `f7K` 가 파싱해 축소값 주입. 재시도 시에만 존재.
2. **`T.maxOutputTokensOverride`** — DSK 옵션. turn loop 가 `maxOutputTokensOverride: v` 로 전달. `v` 는 `runTurnLoop` 의 `D.maxOutputTokensOverride` (caller `H.maxOutputTokensOverride` 가 첫 진입에만 설정 가능; 모든 `continue` 에서 `undefined` 리셋 — agent-loop.md §3.1 확인). 즉 **caller 가 명시한 1회성 상한**.
3. **`$KH(T.model)`** — 모델 기본:

```js
function $KH(H){ let _=U$H(H);
  return gt("CLAUDE_CODE_MAX_OUTPUT_TOKENS", process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
            _.default, _.upperLimit).effective; }
```

- `gt(envName, envVal, default, upperLimit)` — `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env 가 있으면 그 값을 `[?, upperLimit]` 로 clamp 한 `effective` 를, 없으면 `_.default` 를 반환 (확인: env 가 max_tokens 의 1차 소스, §2.1 표의 `default`/`upperLimit` 사용).
- 따라서 override 둘 다 없을 때 `max_tokens` = 모델 default (예: opus-4-7 = 64000) 이되, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env 가 있으면 그 clamp 값.

(요청서의 "maxOutputTokensOverride from D state — max_output_tokens recovery 와 별개" 가 맞음: max_output_tokens recovery 는 메시지에 meta 를 주입할 뿐 `maxOutputTokensOverride` 를 건드리지 않음. agent-loop.md §3.1 — 모든 continue 에서 undefined 리셋. 확인.)

### 2.6 adaptive thinking ↔ max_tokens 상호작용

- **enabled** 경로: `budget_tokens = Math.min(w_ - 1, Gq)`. thinking 예산이 곧 `max_tokens` 의 일부를 소비하므로, 서버 제약(`budget < max_tokens`)을 클라이언트가 미리 `w_-1` 로 clamp 한다. caller 가 `q.budgetTokens` 를 크게 줘도 `w_-1` 을 못 넘는다. `w_` 자체가 §2.5 우선순위로 정해지므로 RJ6 가 context-overflow 로 `maxTokensOverride` 를 줄이면 thinking budget 도 따라 줄어든다 (같은 `w_` 참조).
- **adaptive** 경로: `budget_tokens` 필드 자체가 없음 (`{type:"adaptive", display}`). 서버가 max_tokens 안에서 동적으로 thinking 분량을 정한다. 클라이언트 clamp 없음.

### 2.7 `redactThinkingBeta` (redact-thinking) 베타 제거

```js
if (e_ && H6) { let z9 = LH.indexOf(xK_); if(z9 !== -1) LH.splice(z9,1); }
```

- `xK_ = cM("redact_thinking","redact-thinking-2026-02-12")` (확인 — byte 3437291).
- `e_` (thinking 활성) **이고** `H6` (= `q.display`, thinking 을 사용자에게 표시) 일 때 base beta 목록 `LH` 에서 `redact-thinking-2026-02-12` 베타를 제거한다.
- 의미 (추정): `redact-thinking` 베타는 응답의 thinking 블록을 redact(서버측 가림) 시키는 헤더인데, thinking display 가 켜져 있으면 UI 가 thinking 을 그대로 보여줘야 하므로 redact 와 모순 → 표시 모드에선 redact 베타를 떼서 thinking 원문을 받게 한다. (`mq6` OTEL trace 단계에서 별도로 `<REDACTED>` 치환은 여전히 함 — 그건 텔레메트리 export 한정, 모델 응답 자체와 무관.)

### 2.8 per-turn vs per-session

매 turn iteration 마다 callModel 옵션이 새로 조립된다 (`runTurnLoop`, byte ~10132100, 확인):

```js
options: {
  model: $H,                                            // iZ() plan-swap 결과 — 매 턴 재계산
  thinkingConfig: Z.options.thinkingConfig,             // 세션 고정 (ctx.options)
  ...X.gates.fastModeEnabled && { fastMode: Z.getFastMode() },  // 매 턴 app-state 재조회
  effortValue: Z.getEffortValue(),                      // 매 턴 app-state 재조회
  maxOutputTokensOverride: v,                            // D.maxOutputTokensOverride (continue 마다 undefined)
  ...
}
```

| 항목 | 재계산 단위 | 근거 |
|---|---|---|
| `thinkingConfig` (`q`) | **세션 고정** | `Z.options.thinkingConfig` — ctx options 에 박혀 턴마다 동일 (단 `MV6`/`fV6` 의 per-model thinking-type override 는 `retry:thinking-type` directive 로 세션 중 바뀔 수 있어 `buildCreatePayload` 가 매 attempt `MV6` 재조회) |
| `effortValue` | **매 턴** | `Z.getEffortValue()` = `$H.getState().effortValue`. `/effort` 슬래시로 토글 시 다음 턴부터 반영 |
| `fastMode` | **매 턴** | `Z.getFastMode()` = `$H.getState().fastMode`. `/fast` 토글 시 다음 턴 반영. 단 `X.gates.fastModeEnabled` 일 때만 옵션에 포함 |
| `maxOutputTokensOverride` | **첫 진입만** | caller 가 준 값, 모든 `continue` 에서 undefined 리셋 (agent-loop.md §3.1) |
| `model` (`$H`) | **매 턴** | `iZ({permissionMode, mainLoopModel, exceeds200kTokens})` plan/opusplan/haiku swap |

추가로 `buildCreatePayload` 자체는 RJ6 의 **매 attempt** 마다 호출되므로, 같은 턴 내 재시도에서도 `MV6`/sticky-beta(`o`)/`OH.fastMode`/`OH.maxTokensOverride` 변화가 즉시 반영된다 (확인). 결론: thinking-type 은 사실상 세션+directive 결정이지만 effort·fast 는 사용자 토글로 **턴 경계마다 바뀔 수 있다** (확인).

### 2.9 `M47` 텔레메트리

DSK 가 전처리 직후 1회 호출 (확인, line 19057):

```js
{ let OH=K_({model:T.model, thinkingConfig:q}),
      LH=OH.messages.length,
      IH=l ? OH.betas??[] : [],
      BH=OH.thinking?.type ?? "disabled",
      bH=OH.output_config?.effort;
  T.getToolPermissionContext().then((j_)=>{
    M47({ model:T.model, messagesLength:LH, temperature:T.temperatureOverride??1,
          betas:IH, permissionMode:j_.mode, querySource:T.querySource,
          messageClientPlatform:T.messageClientPlatform, queryTracking:T.queryTracking,
          thinkingType:BH, effortValue:bH, fastMode:e, previousRequestId:$ }); }); }
```

`M47` → `d("tengu_api_query", {...})` 필드 (확인):

```
model, messagesLength, temperature, provider(Uc()), buildAgeMins(D47()),
betas (join ","), permissionMode, querySource(dJ()),
messageClientPlatform?, queryChainId?, queryDepth?,
thinkingType,                 // OH.thinking?.type ?? "disabled"  → "adaptive"|"enabled"|"disabled"
effortValue,                  // OH.output_config?.effort         → rB3 가 박은 최종 effort
fastMode,                     // e (DSK 전처리 fast 가용 플래그)
previousRequestId?,
...LD8()                      // 추가 공통 필드
```

- `thinkingType` 은 **실제 페이로드의 `thinking.type`** (probe 용 `buildCreatePayload` 한 번 더 호출해 추출) — `disabled` 면 thinking 미전송.
- `effortValue` 는 `output_config.effort` (silent downgrade + `rB3` 게이트 적용 후 실제 전송값).
- `fastMode` 는 `e` (speed:"fast" 가 실제로 붙는지와 동일 조건 — `OH.fastMode` 가 아닌 DSK preamble 의 `e`).
- 에러/완료 텔레메트리(`kD8`/`f47`)에는 `effort:t` (`_GH(_H)` 정규화값) 가 별도 필드로 들어감 — `M47` 의 `effortValue` 와 소스가 다름 (하나는 페이로드 추출, 하나는 `EAH` 직결).

---

## 3. State / Schema

### 3.1 thinking 페이로드 형상 (확인)

```ts
thinking?:
  | { type: "adaptive", display?: ThinkingDisplay }
  | { type: "enabled", budget_tokens: number /* = min(max_tokens-1, Nj9(model)|q.budgetTokens) */,
      display?: ThinkingDisplay }
  | undefined   // disabled / 모델 미지원 / CLAUDE_CODE_DISABLE_THINKING
```

### 3.2 effort 페이로드 형상 (확인)

```ts
output_config?: {
  effort?: "low" | "medium" | "high" | "xhigh" | "max",   // rB3, RxH 베타 동반
  ...
}
```

해소 우선순위: `CLAUDE_CODE_EFFORT_LEVEL` env → opus-4-7 launch 핀(`Ze_`→`Ge_`) → caller `effortValue` → 모델 기본(`Ge_`). 그 뒤 `max`→미지원시`high`, `xhigh`→미지원시`high` silent downgrade.

지원 행렬 (확인):

| 모델 | `QP` effort | `L$_` max | `k$_` xhigh | `Ge_` 기본 | thinking `i86` adaptive | fast `dj` |
|---|---|---|---|---|---|---|
| claude-opus-4-7 | ✓ | ✓ | ✓ | `xhigh` | ✓ | ✓ |
| claude-opus-4-6 | ✓ | ✓ | ✗ | `high` | ✓ | ✓ |
| claude-sonnet-4-6 | ✓ | ✓ | ✗ | `high` | ✓ | ✗ |
| claude-opus-4-5 | ✗ | ✗ | ✗ | (n/a) | ✗ | ✗ |
| claude-sonnet-4-5 | ✗ | ✗ | ✗ | (n/a) | ✗ | ✗ |
| claude-haiku-4-5 | ✗ | ✗ | ✗ | (n/a) | ✗ | ✗ |
| claude-3-* | ✗ | ✗ | ✗ | (n/a) | ✗ (thinking 자체 ✗) | ✗ |
| 미명시 | `Fh(provider)` | `Fh` | `Fh` | `high` | `Fh` | ✗ |

### 3.3 speed 페이로드 형상 (확인)

```ts
speed?: "fast"   // z4()&&u2()&&!Va()&&dj(model)&&!!OH.fastMode 전부 참일 때만
```

### 3.4 max_tokens (확인)

```ts
max_tokens: number
  = OH?.maxTokensOverride                // RJ6 context-overflow 주입
 || T.maxOutputTokensOverride            // caller 1회성 (continue 마다 undefined)
 || $KH(model)                           // gt(CLAUDE_CODE_MAX_OUTPUT_TOKENS, env, U$H.default, U$H.upperLimit).effective
```

enabled thinking 동반 시 `budget_tokens = min(max_tokens - 1, budget)` 로 max_tokens 에 종속.

### 3.5 관련 env / 설정 (확인)

| 키 | 효과 |
|---|---|
| `CLAUDE_CODE_DISABLE_THINKING` | truthy → thinking 전면 비활성 (`U_=false`) |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | truthy **+ 모델이 opus-4-6/sonnet-4-6** → adaptive 끄고 enabled. opus-4-7 영향 없음 |
| `MAX_THINKING_TOKENS` | `zwH()` — 값>0 이면 thinking on, ≤0 이면 off (상류 thinkingConfig 결정) |
| `settings.alwaysThinkingEnabled` | `false` 면 thinking off (env 없을 때) |
| `CLAUDE_CODE_EFFORT_LEVEL` | effort level env. `"unset"`/`"auto"` → null. 최우선 |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `QP` 강제 true (모든 모델 effort 지원 취급) |
| `settings.unpinOpus47LaunchEffort` | true 면 opus-4-7 launch effort 핀 해제 (caller effort 존중) |
| `CLAUDE_EFFORT` (env, hook/Bash 노출) | hook payload 의 `effort.level` 과 동일값을 자식 프로세스에 노출 (silent downgrade 적용 후). 설정 소스 아님 — **출력** 채널 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `$KH` 의 `gt` clamp 입력 — 모델 default 대체 |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | `z4()` false → fast/speed 전면 비활성 |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | `Fi6()` — org check 우회 (추정) |
| `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` | `f$` — simple system prompt 강제 on/off (effort/speed 와 무관 축) |

### 3.6 hook payload `effort` 스키마 (확인 — `hookPayloadBase` 베이스)

```ts
effort?: { level: "low"|"medium"|"high"|"xhigh"|"max" }
// 주석 verbatim: "Active effort level for the current turn ...,
//  after any silent downgrade for the selected model.
//  Also exposed to hook commands and Bash as the CLAUDE_EFFORT env var."
// "Present for hooks within a tool-use context (PreToolUse, PostToolUse, Stop,
//  SubagentStop, ...) on a model that supports the effort parameter;
//  absent for session-lifecycle hooks and models without effort support."
```

→ effort-미지원 모델(`!QP`)에서는 `effort` 키 자체가 hook payload 에서 빠진다 (`EAH` 가 `undefined` 반환 → `t` undefined).

---

## 4. 차이점 (v0.2.8 → v2.1.143)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 트리거 워드 → thinking budget | `getMaxThinkingTokens()` 가 `"think"/"think hard"/"think harder"/"megathink"/"ultrathink"` 를 파싱해 단계별 budget 숫자(예: 4k/10k/31999) 반환 | **폐기**. `ultrathink` 한 단어만 남고 budget 숫자 매핑 없음 — `o93` 가 `{type:"ultrathink_effort"}` attachment + `tengu_ultrathink` 텔레메트리만 생성. `n86` 은 UI 하이라이트 전용 |
| thinking budget 소스 | 사용자 메시지 트리거 워드 | 모델별 `Nj9(model)=U$H.upperLimit-1` 기본 + caller `q.budgetTokens` override + `min(max_tokens-1, ·)` clamp |
| thinking 타입 | enabled(budget) 단일 | `adaptive` / `enabled(budget_tokens)` / disabled 3분기. 4-6/4-7 adaptive 기본. `MV6`/`fV6` 세션 per-model override + `retry:thinking-type` directive 로 enabled↔adaptive 자동 swap |
| reasoning effort | 없음 | `EAH` 5단계(`low~max`) 해소 + 모델별 silent downgrade(`max`/`xhigh`→`high`) + `output_config.effort`(`rB3`,`RxH` 베타) + `CLAUDE_CODE_EFFORT_LEVEL`/`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` env + opus-4-7 launch 핀(`Ze_`) + hook/Bash `CLAUDE_EFFORT` 노출 |
| fast mode | 없음 | `speed:"fast"` 페이로드 + `kxH` 베타. `z4&&u2&&!Va&&dj(model)&&fastMode` 5게이트, opus-4-6/4-7 한정, `/fast` 토글(app-state), 서버 거부 시 쿨다운 latch |
| max_tokens | 단일 default | `OH.maxTokensOverride` (RJ6 context-overflow) → `T.maxOutputTokensOverride` (caller 1회성) → `$KH`(모델 default + `CLAUDE_CODE_MAX_OUTPUT_TOKENS` clamp) 3단 우선순위 + `U$H` 모델별 표 |
| redact-thinking 베타 | 없음 | thinking display 시 `redactThinkingBeta`(redact-thinking-2026-02-12) 베타를 동적 제거 |
| 재계산 단위 | per-call | thinking-type 사실상 세션+directive, effort·fastMode 는 매 턴 app-state 재조회 (mid-session `/effort`·`/fast` 토글 반영) |
| 텔레메트리 | 없음/최소 | `tengu_api_query`(`M47`) 에 `thinkingType`/`effortValue`(페이로드 추출)/`fastMode`, 에러·완료 텔레메트리에 `effort:t`(`EAH` 직결) |

### 추정 / 확인 필요

- `ultrathink_effort` attachment 가 하류에서 effort 를 `max` 로 끌어올리는지: attachment → effort 변환 코드는 본 조사 범위 밖. **추정** — 별도 추적 필요 (attachment 소비 지점).
- `tengu_velvet_cascade`/`tengu_vellum_lantern`/`simple_system_prompt` 는 system prompt 축소(`f$`/`IC1`/`UL9`) 결정이며 speed/effort/thinking 와 **직접 결합 없음** (확인). 동일 모델군 타깃이라 같이 켜질 확률 높다는 정도는 **추정**.
- `Qc()` (fast `dj` 에서 opus-4-6 한정 분기 트리거): 의미 미해석 — 특정 org/플랜으로 **추정**.
- `Ze_` 의 `unpinOpus47LaunchEffort` 핀 해제 트리거(`N$_`/`LT8`)는 `/effort` 명시 변경 시점 — UI 명령 경로는 본 문서 범위 밖이나 동작 의미는 분명: opus-4-7 신규 사용자는 명시 변경 전까지 `xhigh` 고정 (확인).
- `gt()` 의 정확한 clamp 규칙(하한/반올림): `effective` 필드만 확인, 내부 산식 미검증 — **추정** (env 값을 `[?, upperLimit]` 으로 clamp).
