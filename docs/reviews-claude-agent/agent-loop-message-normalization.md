# Agent loop — 메시지 배열 정규화 / content-replacement 파이프라인

`runTurnLoop` ([extracted-functions.js:14057](../../extracted-functions.js#L14057)) 의 매 턴 시작 부분에서, 저장된 `D.messages`(`W`)가 API로 가기 전에 거치는 변환 사슬을 추적한다.

```
W (D.messages, persisted form)
  └─ x = [...ZA(W)]                       // 마지막 compact_boundary 이후만 슬라이스
  └─ x = await cr9(x, ctx.contentReplacementState, persistCb, unlimitedToolNames)
  └─ x = (await J.microcompact(x,...)).messages   // tier1 (실질 no-op)
  └─ x = AKH(autocompactResult)           // tier2 성공 시 전면 교체
  └─ x = Nz_(x, ids, contentById)         // (stream 중) onHintCleared 콜백
  └─ x = AKH(reactiveResult)              // tier3 성공 시 (D.messages 로 store 후 continue)
  └─ callModel({ messages: aY6(x, K), ... })   // API 입력 시점에만 userContext 머지
```

핵심 결론 (확인): `x`는 **턴-로컬 작업 사본**이고 `D.messages`(persist 대상)와 분리된다. `aY6(x,K)`는 **callModel 입력에서만** userContext를 머지하며 그 결과는 어디에도 저장되지 않는다. content-replacement는 **API에는 트리밍본**을, **transcript 파일에는 원본 매핑**을 남기는 dual-track.

이 문서는 [agent-loop.md](agent-loop.md) §2 의 `let x=[...ZA(W)]` 한 줄과 [agent-loop-stream-events.md](agent-loop-stream-events.md) 부록의 "`mergeUserContext` 정의 위치 미해석" 항목을 메우는 보강분이다.

---

## 1. 호출 그래프

```
Bq3 (turn-start, char-offset ~10131600~10132100)
│
├─ x = [...ZA(W)]                                   # 15593
│   └─ az3(W)                                       # 15592 — 마지막 compact_boundary index
│       └─ BX(msg)  msg.type==="system" && subtype==="compact_boundary"   # 15591
│   → q===-1 ? W : W.slice(q)   (boundary 없으면 전체, 있으면 그 마커부터)
│
├─ g = Z.precomputeSourceKey!==void 0 && F?.compacted!==true && !mD8(z)
├─ Q = z.startsWith("agent:") || z.startsWith("repl_main_thread")    # persist 자격
├─ x = await cr9(x,
│        Z.contentReplacementState,                 # ToolUseContext 필드
│        Q ? (T_)=>void YNH(T_, Z.agentId).catch(vH) : void 0,
│        new Set( Z.options.tools
│                  .filter(t => !Number.isFinite(t.maxResultSizeChars))
│                  .map(t => t.name) ))              # 무제한 결과 도구 = 면제
│   cr9 (8561)
│   └─ if(!state) return H                           # 상태 없으면 무변환
│   └─ O75(H, state, unlimitedSet)                   # 8559 — 실제 워커
│   │    ├─ dr9(H)        # 8552 — assistant id 경계로 tool_result 그룹핑
│   │    │   └─ e95(msg)  # 8551 — user 메시지의 tool_result 추출(이미 persisted/이미지 제외)
│   │    ├─ t95(H)        # 8550 — tool_use_id → tool_name 맵 (unlimited 판정용)
│   │    ├─ H75(grp,state)# 8553 — mustReapply / frozen / fresh 분류
│   │    ├─ _75(W,G,Xc9)  # 8554 — 200000 byte 초과분만 큰 것부터 골라냄
│   │    ├─ K75(item)     # 8557 — 디스크 persist + placeholder content 생성
│   │    │   ├─ DYH(content, toolUseId)  # 8531 — .claude/tool-results/<id>.{txt,json} 기록
│   │    │   ├─ fYH(r)    # 8543 — "error" in r
│   │    │   └─ MYH(r)    # 8532 — `<persisted-output>\n</persisted-output>` 래퍼
│   │    └─ q75(H, map)   # 8555 — messages 안 tool_result.content 를 placeholder 로 치환(immutable)
│   └─ if(newlyReplaced.length>0) persistCb(newlyReplaced)
│       persistCb = YNH(replaced, agentId)           # 18527
│       └─ O1().insertContentReplacement(replaced, agentId)   # 18507
│           └─ appendEntry({type:"content-replacement", sessionId, agentId, replacements})
│   → return O.messages
│
├─ x = (await J.microcompact(x,Z,z)).messages        # pt(8419) = 실질 no-op
├─ {compactionResult:e,...} = yield* J.autocompact(x, Z, {... forkContextMessages:x}, z, F, c)
│   └─ if(e) x = AKH(e)                               # tier2 전면 교체
├─ if(b47(...)) x47({... forkContextMessages:x})      # precompute fork 입력 = 정규화된 x
├─ Z = {...Z, messages:x, turnStartIndex:Uq3(x)}      # 14058 Uq3 = 마지막 진짜 user idx
│
└─ for await(... J.callModel({ messages: aY6(x,K), ... }))   # aY6 = userContext 머지
    └─ onHintCleared(ids,map): x = Nz_(x, ids, map)   # 8422 — tool_result → placeholder
```

| 식별자 | 위치 | 역할 |
|---|---|---|
| `sliceAtCompactBoundary` | [15593](../../extracted-functions.js#L15593) | `slice(az3(H))` — 마지막 compact_boundary 이후만 |
| `az3` | [15592](../../extracted-functions.js#L15592) | 뒤에서부터 `BX` 만족하는 첫 index, 없으면 `-1` |
| `BX` | [15591](../../extracted-functions.js#L15591) | `type==="system" && subtype==="compact_boundary"` |
| `replaceOversizedResults` | [8561](../../extracted-functions.js#L8561) | content-replacement 패스 진입 (state 없으면 패스) |
| `replaceOversizedImpl` | [8559](../../extracted-functions.js#L8559) | per-message tool-result budget 워커 |
| `dr9` | [8552](../../extracted-functions.js#L8552) | assistant id 경계로 tool_result 그룹화 |
| `e95` | [8551](../../extracted-functions.js#L8551) | user 메시지에서 비-persisted/비-이미지 tool_result 추출 |
| `t95` | [8550](../../extracted-functions.js#L8550) | tool_use_id→name 맵 (unlimited 면제 판정) |
| `H75` | [8553](../../extracted-functions.js#L8553) | mustReapply/frozen/fresh 3분류 |
| `_75` | [8554](../../extracted-functions.js#L8554) | 그룹 budget 초과 시 큰 것부터 제거 대상 선정 |
| `K75` | [8557](../../extracted-functions.js#L8557) | 디스크 persist + placeholder 생성 |
| `DYH` | [8531](../../extracted-functions.js#L8531) | `.claude/tool-results/<id>.{txt,json}` 기록 |
| `MYH` | [8532](../../extracted-functions.js#L8532) | `<persisted-output>…</persisted-output>` placeholder |
| `q75` | [8555](../../extracted-functions.js#L8555) | messages 안 tool_result content 치환 (immutable) |
| `oz_` / `cloneContentReplacement` / `X_6` / `Fr9` | [8544](../../extracted-functions.js#L8544)/[8545](../../extracted-functions.js#L8545)/[8562](../../extracted-functions.js#L8562)/[8546](../../extracted-functions.js#L8546) | contentReplacementState 생성/복제/재구성/게이트 |
| `persistToolResultDualTrack` | [18527](../../extracted-functions.js#L18527) | `insertContentReplacement` transcript 기록 |
| `replaceClearedHints` | [8422](../../extracted-functions.js#L8422) | hint-clear: tool_result → placeholder 리매핑 |
| `lastTurnBoundaryIndex` | [14058](../../extracted-functions.js#L14058) | 마지막 진짜 user 메시지 index (turnStartIndex) |
| `expandAttachments` | [15542](../../extracted-functions.js#L15542) | attachment expansion (이미지/문서/메타 평탄화) |
| `Zz3` | [15529](../../extracted-functions.js#L15529) | i0 입력 평탄화 |
| `enforceBase64Limit` | [7870](../../extracted-functions.js#L7870) | base64 size guard → `mUH` throw |
| `mUH` | [7870](../../extracted-functions.js#L7870) | `ImageSizeError` |
| `perModelLimits` | [7176](../../extracted-functions.js#L7176) | per-model `maxBase64Size` |
| `mergeUserContext` | (미추출 — lazy module) | callModel 직전 userContext 머지 — **추정** |
| `mapResultBlock`/`UFH`/`pr9` | [8540](../../extracted-functions.js#L8540)/[8535](../../extracted-functions.js#L8535)/[8537](../../extracted-functions.js#L8537) | per-tool-result persist (별 경로, fc9 임계) |

핵심 상수 ([8106](../../extracted-functions.js#L8106) 부근):

| ID | 값 | 의미 |
|---|---|---|
| `persistedOutputCap` | `200000` | per-message tool_result budget (byte) — `replaceOversizedImpl` 임계 |
| `a$_` | `4` | byte→token 추정 계수 (`Math.ceil(size/4)`) |
| `resultSizeCapDefault` | `400000` | 단일 tool_result persist 기본 임계 (`mapResultBlock`) |
| `resultSizeCapMid` | `50000` | (관련 size 상수) |
| `R$8` | `500000` | (관련 size 상수) |
| `transcriptChunk` | `2000` | persist preview 길이 |
| `f_6` | `"<persisted-output>"` | placeholder 여는 태그 |
| `SA8` | `"</persisted-output>"` | placeholder 닫는 태그 |
| `i95` | `"[Old tool result content cleared]"` | (= `clearedHintPlaceholder`) hint-clear placeholder |
| `clearedHintPlaceholder` | `"[Old tool result content cleared]"` | `replaceClearedHints` 기본 placeholder |
| `EA8` | `"tool-results"` | persist 디렉토리 이름 |
| `r95` | `"tengu_velvet_ibis"` | (관련 게이트) |
| Gate | `"tengu_hawthorn_steeple"` | content-replacement 활성 게이트 (`Fr9`) |

---

## 2. 핵심 로직

### 2.1 `x = [...ZA(W)]` — compact-boundary 슬라이스 (확인)

```js
function ZA(H,_){let q=az3(H);return q===-1?H:H.slice(q)}
function az3(H){for(let _=H.length-1;_>=0;_--){let q=H[_];if(q&&BX(q))return _}return -1}
function BX(H){return H?.type==="system"&&H.subtype==="compact_boundary"}
```

- `ZA(W)`는 `W` 안에서 **가장 마지막 `compact_boundary` 마커 위치를 찾아 그 마커 포함부터 끝까지** 잘라낸다. boundary가 없으면 `W` 전체 (참조 그대로) 반환.
- `[...ZA(W)]` — Bq3 는 결과를 spread 해서 **새 배열**로 복사. 이후 `x`에 대한 mutation 이 `D.messages`(`W`)에 새지 않게 하는 첫 격리 지점. (단 메시지 객체 자체는 shared reference — shallow copy.)
- 의도: autocompact/reactive compact 가 만든 boundary 이전의 메시지(이미 요약된 원본)는 다음 모델 호출에서 제외. `AKH(result)` 가 만든 평탄화 배열의 0번 원소가 `boundaryMarker` 이므로, 그 이후로 누적된 모든 메시지에 boundary 가 항상 prefix 로 남아 ZA 가 정확히 "compact 이후" 만 통과시킨다.
- **요청서 §1 (hook_progress 제거?)**: `sliceAtCompactBoundary` 는 hook_progress/tombstone/meta 필터링을 **하지 않는다**. `_zH` ([5744](../../extracted-functions.js#L5744), `H.filter(_=>_.data?.type!=="hook_progress")`) 는 **별 함수**로, progress-stream 항목 필터용이며 `sliceAtCompactBoundary` 와 호출 관계 없음. `sliceAtCompactBoundary` 의 유일한 책임은 boundary 슬라이스 (확인).

### 2.2 `replaceOversizedResults` — content-replacement 패스 (확인)

```js
function cr9(H,_,q,K){
  if(!_) return H;                         // state 없으면 무변환 (gate off)
  let O = await O75(H,_,K);
  if(O.newlyReplaced.length>0) q?.(O.newlyReplaced);   // persist 콜백
  return O.messages;
}
```

- `H` = `x` (정규화 중 메시지), `_` = `ctx.contentReplacementState`, `q` = persist 콜백, `K` = unlimited 도구 이름 Set.
- 무엇이 치환되나 (확인): **시크릿 redaction 도 `[[memory]]` 확장도 아니다.** 오로지 **너무 큰 tool_result 텍스트를 디스크로 빼내고 `<persisted-output></persisted-output>` placeholder 로 대체**하는 per-message budget 강제. (이미지/문서 블록, 이미 persisted 된 것은 `e95` 단계에서 제외 — `s95`/`gr9` 검사.)

#### `replaceOversizedImpl` 워커 단계 (확인)

```js
function O75(H,_,q=new Set){
  let K=dr9(H),                                  // assistant-경계 tool_result 그룹들
      O=q.size>0?t95(H):void 0,                  // unlimited 판정용 id→name
      T=(M)=>O!==void 0 && q.has(O.get(M)??""),   // 이 tool_use_id 가 unlimited 도구냐
      $=Xc9 /*200000*/, z=new Map, A=[], Y=0, w=0;
  for(let M of K){                               // 그룹 단위
    let {mustReapply:f, frozen:X, fresh:P}=H75(M,_);
    f.forEach(E=>z.set(E.toolUseId,E.replacement)); Y+=f.length;   // 이미 치환된 것 재적용
    if(P.length===0){ M.forEach(E=>_.seenIds.add(E.toolUseId)); continue; }
    P.filter(E=>T(E.toolUseId)).forEach(E=>_.seenIds.add(E.toolUseId));  // unlimited 면제
    let W=P.filter(E=>!T(E.toolUseId));            // 면제 제외한 fresh
    let G=X.reduce((a,h)=>a+h.size,0),             // frozen 누적 byte
        L=W.reduce((a,h)=>a+h.size,0);             // fresh 누적 byte
    let k = G+L>$ ? _75(W,G,$) : [];               // 그룹이 200KB 초과 시 큰 것부터 제거대상
    let v=new Set(k.map(E=>E.toolUseId));
    M.filter(E=>!v.has(E.toolUseId)).forEach(E=>_.seenIds.add(E.toolUseId));
    if(k.length===0) continue;
    w++; A.push(...k);
  }
  if(z.size===0&&A.length===0) return {messages:H, newlyReplaced:[]};
  let j=await Promise.all(A.map(async M=>[M, await K75(M)]));   // 디스크 persist
  let J=[],D=0;
  for(let [M,f] of j){
    _.seenIds.add(M.toolUseId);
    if(f===null) continue;                         // persist 실패 → 원본 유지
    D+=M.size;
    z.set(M.toolUseId, f.content);
    _.replacements.set(M.toolUseId, f.content);     // state 에 영구 기록
    J.push({kind:"tool-result", toolUseId:M.toolUseId, replacement:f.content});
    d("tengu_tool_result_persisted_message_budget", {...});
  }
  if(z.size===0) return {messages:H, newlyReplaced:[]};
  if(J.length>0) d("tengu_message_level_tool_result_budget_enforced", {...});
  return {messages:q75(H,z), newlyReplaced:J};      // immutable rebuild
}
```

판단 요지 (확인):

1. **그룹 단위**: `dr9` 가 assistant 메시지 id 경계로 tool_result 들을 묶는다 — 한 assistant 응답에 딸린 tool_result 들이 한 그룹.
2. **3분류 `H75`**: `state.replacements` 에 이미 있으면 `mustReapply`(같은 placeholder 재적용 — idempotent), `state.seenIds` 에 있으면 `frozen`(이미 본 적 있으나 치환 안 함 — 크기만 합산), 그 외 `fresh`.
3. **unlimited 면제**: 도구의 `maxResultSizeChars` 가 `!Number.isFinite(...)` (= 무제한, e.g. Infinity) 이면 그 도구의 tool_result 는 budget 대상에서 제외하고 `seenIds` 에만 등록 → 이후 절대 치환 안 됨 (확인). Bq3 가 넘기는 Set 은 `Z.options.tools.filter(t=>!Number.isFinite(t.maxResultSizeChars)).map(t=>t.name)`.
4. **임계**: 그룹의 frozen+fresh byte 합이 `Xc9=200000` 초과일 때만, `_75` 로 큰 것부터 골라 200KB 이하로 떨굴 만큼 제거 대상 선정.
5. **persist**: `K75` 가 `DYH` 로 디스크에 원본을 쓰고 `MYH` 로 placeholder 텍스트를 만든다. 실패(`fYH`) 시 `null` → 그 항목은 원본 유지.
6. **결과**: `q75` 가 messages 를 immutable 하게 다시 짜서 해당 tool_result 의 `content` 만 placeholder 로 교체. 나머지 메시지 객체는 동일 참조.

`contentReplacementState` 형상 (확인):

```ts
{ seenIds: Set<toolUseId>, replacements: Map<toolUseId, placeholderContent> }
```

- 생성: `oz_()` = `{seenIds:new Set, replacements:new Map}`.
- 게이트: `Fr9(H,_)` — `Z_("tengu_hawthorn_steeple",false)` 가 off 면 `undefined` 반환 → `replaceOversizedResults` 가 즉시 패스. on 이면 `X_6(H,_)` (메시지에서 재구성) 또는 `oz_()`.
- ToolUseContext 필드. ED8 fork ([6560221](../../extracted-functions.js#L6560221)) 시 `_?.contentReplacementState ?? (H.contentReplacementState ? Ur9(H.contentReplacementState) : undefined)` — `cloneContentReplacement` 가 `{new Set(...), new Map(...)}` 깊은 복제. 즉 서브에이전트는 부모 state 의 스냅샷을 받는다 (share-by-ref 아님). REPL `replCtxBuilder` ([14038646](../../extracted-functions.js#L14038646)) 에서는 `contentReplacementState: A7.current` 로 ref 공유 (메인 세션 within-process 누적).

#### persist 콜백 & dual-track (확인 — 요청서 §2/§10)

`runTurnLoop` 가 넘기는 콜백: `Q ? (T_)=>void YNH(T_, Z.agentId).catch(vH) : void 0` (단 `Q = z.startsWith("agent:")||z.startsWith("repl_main_thread")` 일 때만).

```js
function YNH(H,_){ await O1().insertContentReplacement(H,_) }
// O1().insertContentReplacement (18507):
async insertContentReplacement(H,_){
  return this.trackWrite(async()=>{
    let q={ type:"content-replacement", sessionId:k_(), agentId:_, replacements:H };
    await this.appendEntry(q);
  });
}
```

- **API 가 보는 것** = `replaceOversizedImpl` 가 만든 트리밍본 (`q75` 결과 = `x`). placeholder `<persisted-output></persisted-output>`.
- **transcript/세션 파일이 보는 것** = `appendEntry` 로 기록된 `{type:"content-replacement", replacements:[{kind:"tool-result", toolUseId, replacement}], ...}` 레코드 + 원본은 별도로 `.claude/tool-results/<toolUseId>.{txt|json}` 파일 (`DYH`).
- 따라서 **resume/transcript 는 full fidelity 복원 가능**(어떤 id 가 어떤 placeholder 로 바뀌었는지 + 원본 파일 존재), API 는 컨텍스트 절약 트리밍본만 본다 — dual-track 확인. `X_6`/`Fr9` 는 이 레코드들로 다음 세션에서 `replacements` Map 을 재구성 (`lr9` 도 동일).
- `Q` 조건: SDK/hook agent 등 비-REPL/비-subagent querySource 에서는 콜백 자체가 `undefined` → 디스크엔 쓰지만 transcript 레코드는 안 남김 (확인).

`MYH` placeholder (확인):

```js
function MYH(H){ let _=`${f_6}\n`, _+=SA8, _ }
// → "<persisted-output>\n</persisted-output>"
```

(minify 산물로 filepath/preview 보간이 본문에서 잘려 보이나, 구조상 `DYH` 가 반환한 `{filepath, preview, hasMore}` 를 태그 사이에 끼우는 형태로 **추정**. 확정 본문은 추출 한계.)

### 2.3 `aY6(x, K)` — userContext 머지 (추정)

- 호출: `J.callModel({messages: aY6(x,K), ...})` — `runTurnLoop` 안 **유일 use site** (offset 10132071). 그 외 어떤 추출 파일에도 `mergeUserContext` 정의/참조 없음.
- callModel 진입(`NiH`→`callModelOuter`, [19054](../../extracted-functions.js#L19054)) 의 `H` 파라미터가 곧 `aY6(x,K)` 결과. `DSK(H,_,q,K,O,T)` 내부의 `K` 는 **tools** 이지 userContext 가 아님 (시그니처 `UvH({messages:H,...,tools:K,...})` 확인) — 즉 userContext 는 callModel 시그니처로 따로 들어가지 않고 **`mergeUserContext` 가 메시지 배열 안에 미리 접어넣는다**.
- `runTurnLoop` 의 `K` = `H.userContext`. fork 빌더들 (`jY3` [15736](../../extracted-functions.js#L15736), `cg` [9839](../../extracted-functions.js#L9839)) 에서 `userContext` 는 `Kw()` 가 만든 별도 값이고 `systemContext`(`tD(...)`), `systemPrompt`(`assembleSystemPrompt`) 와 동급 분리 필드.
- 따라서 `aY6(x, userContext)` 는 **userContext 를 messages 앞쪽에 user-role 컨텍스트 메시지(혹은 첫 user 메시지에 합성)로 prepend/머지** 하는 함수로 **추정**. 정의가 lazy-init 모듈(`var X=R(()=>{...})`) 안에 있어 함수-분할 추출에서 누락. 정확한 형태(전용 user 메시지인지 `<context>` 블록인지, isMeta 여부)는 본 추출본으로 확정 불가 — **확인 필요**.
- **주입 시점은 매 턴** (callModel 호출마다 `aY6(x,K)` 재평가). 그러나 결과는 `x` 에도 `D.messages` 에도 store 안 됨 — callModel 인자에서만 1회용. 즉 userContext 는 디스크/transcript 에 누적되지 않고 **매 API 호출 시 fresh 합성** (확인 — store 경로 부재로 역추론).
- userContext 내용물 (CLAUDE.md / 디렉토리 구조 / git status 등) 은 `Kw()` 소관이며 본 추출본에 `Kw` 정의 없음 — system-prompts.md / tool-use-context.md 의 userContext 항목 교차참조 필요 (**확인 필요**).

### 2.4 system-reminder 주입 (확인)

`<system-reminder>…</system-reminder>` 블록은 **중앙 한 곳(aY6 같은)에서 일괄 주입되지 않는다.** 각 attachment/tool-result/hook 빌더가 자기 출력 안에 인라인으로 박는다:

- 빈/짧은 파일 Read 경고 ([10452306](../../extracted-functions.js#L10452306)): `"<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"` 등 — Read tool-result 빌더 내부.
- recalled-memory 안내 (`jk9`, [4503876](../../extracted-functions.js#L4503876)): `"Tool results may include additional \`<system-reminder>\` blocks…"` — system-prompt 정적 섹션.
- hook `rewakeMessage` ([2392952](../../extracted-functions.js#L2392952)): asyncRewake hook 이 exit 2 일 때 model 에 보일 system-reminder prefix.
- `Sy8(H)` ([10099804](../../extracted-functions.js#L10099804)): `H.lastIndexOf("</system-reminder>")` 로 user 메시지 본문에서 system-reminder **뒤쪽** 실제 발화만 추출 (intent 캡처용) — 즉 system-reminder 는 user 메시지 content 의 앞부분에 prepend 되는 관례.
- TodoWrite/Skill/"verified vs assumed" 류 리마인더: 각 도구/세션 attachment 빌더가 만든 `D6({content, isMeta:true})` 또는 user content prefix. `expandAttachments` 의 `system` case 가 `D6({content, isMeta:!0})` 로 평탄화하며 직전 user 메시지와 `PJ6` 로 병합.
- role: 대부분 **user-role + `isMeta:true`** 또는 `type:"system"`(`api_system` 으로 평탄화). `expandAttachments` 의 `Gz3`/`sC8`/`uz3` 분기가 meta user 와 일반 user 를 구분 처리.
- 주입 함수: **per-turn 단일 함수 없음**. attachment 재투입은 compaction(`xw5`/`A96`…), tool-result 는 도구 mapper, memdir 는 `transformMemdirResults`, skill discovery 는 `Uy8().collectSkillDiscoveryPrefetch` 가 각자 `T9(...)` 로 메시지화 → `JH`(collectedToolResults) 에 push → 다음 턴 `D.messages` 에 누적. 따라서 system-reminder 는 "이미 메시지 배열에 들어있는" 상태로 `runTurnLoop` 에 도착하며 `sliceAtCompactBoundary`/`replaceOversizedResults` 는 이를 특별 취급하지 않는다 (확인).

### 2.5 `x` 작업 사본 lifecycle (확인 — 요청서 §5)

한 턴 안에서 `x` 변이 전부:

| 순서 | 연산 | mutation 방식 | `D.messages` 영향 |
|---|---|---|---|
| 1 | `x=[...ZA(W)]` | 새 배열 (spread, shallow) | 없음 (복사) |
| 2 | `x=await cr9(x,...)` | 새 배열 (`q75` immutable rebuild) 또는 동일 참조 | 없음 |
| 3 | `x=(await J.microcompact(x,Z,z)).messages` | `microcompactNoop` 는 `{messages:H}` 그대로 (no-op) | 없음 |
| 4 | `x=AKH(e)` (autocompact 성공) | 새 배열 (5-field concat) | 없음 (단 이후 `D` 재구성 시 반영) |
| 5 | `x=Nz_(x,ids,map)` (stream 중 onHintCleared) | 새 배열 (immutable map) | 없음 |
| 6 | reactive compact 성공 시 `D={messages:AKH(c_),...}` 후 `continue` | `x` 자체 변이 아님 — 다음 턴 `W` 가 됨 | **store** (다음 턴) |
| 7 | `aY6(x,K)` | callModel 인자에서만, 반환값 미저장 | 없음 |

- `runTurnLoop` 는 `x`를 **재할당(`x = ...`)으로만** 갱신 — in-place `x.push(...)` 없음 (확인). 메시지 누적은 `wH`/`JH`(별 배열)에 모았다가 턴 끝에서 `D = {messages:[...x,...wH,...JH], ...}` 로 **새 배열** 합성.
- 따라서 `x` ≠ persist 대상. persist 되는 것은 `D.messages` (다음 턴 `W`) 이며, 그것도 `[...x, ...wH, ...JH]` — `replaceOversizedResults` 가 트리밍한 `x` 가 그대로 다음 턴 baseline 이 된다. 즉 **한 번 placeholder 로 바뀐 tool_result 는 그 트리밍 상태로 누적**되고(원본은 디스크/transcript 레코드에만), `state.replacements` 의 idempotent 재적용(`H75` mustReapply)으로 매 턴 동일 placeholder 유지.
- `structuredClone` 미사용 (확인). SDK `BetaToolRunner` ([1942](../../extracted-functions.js#L1942)) 는 `structuredClone(messages)` 로 deep copy 하지만 `runTurnLoop` 는 spread/immutable-map 기반 shallow 격리만 한다 — 메시지 객체 참조는 공유, 배열만 새로. content-replacement·hint-clear 가 전부 `{...obj}` immutable rebuild 라 깊은 복제 없이도 원본 메시지 객체가 보존됨.

### 2.6 attachment expansion `i0(msgs, tools, model)` (확인 — 요청서 §6)

```js
function i0(H,_=[],q){
  let K=q!==void 0&&Ll_(q),               // model 이 image 지원?
      O=new Set(_.map(Z=>Z.name)),         // tool name set
      T=Zz3(H,true), ...                    // 평탄화
  ...
  // attachment case: let W=S8(Z.attachment);
  //   if(K){ let k=mz3(W); if(k!==null){Y.push(k);continue} }   // 이미지/문서 inline 블록
  //   else if gate tengu_chair_sermon: W.map(Lz3)               // 미지원 모델 → 텍스트 대체
  //   직전 A 의 user 메시지에 yz3 로 병합 or A.push(...W)
  // system case: D6({content,...}) → 직전 user 와 PJ6 병합
  // user case:  meta 면 Gz3/sC8, vz3 binding, v9K 안내 텍스트 append
  // assistant:  tool_use input 을 j7K(tool,input) 로 정규화, 같은 message.id 끼리 hz3 병합
  // 끝: DM_→tz3→JM_→ez3 정리, K?Ez3(f):f, kz3(X) 반환
}
```

- 역할 (확인): 내부 attachment 메시지(이미지·파일 content reference·메모리 recall 등)를 API content 블록(`type:"image"`/`document`/`text`)으로 expand. 멀티모달 미지원 모델(`!Ll_(q)`)이면 이미지를 텍스트 대체/제거.
- 호출 시점: **tool-result 후처리** — `StreamingToolExecutor` 스트리밍 결과 및 tool batch 결과 각각에 대해 `i0([msg], refreshTools()??tools, mainLoopModel)` (stream-events.md §2.8 확인). 즉 `replaceOversizedResults`/`sliceAtCompactBoundary` 와 별 단계로, 도구 결과가 `JH`(collectedToolResults)에 들어가기 직전.
- `runTurnLoop` 본체의 `x` 정규화 사슬에는 `expandAttachments` 가 직접 끼어있지 않다 — `x` 는 이미 직전 턴에서 `expandAttachments` 처리된 메시지를 누적한 상태. `expandAttachments` 는 "이번 턴 새로 생긴 도구 결과" 전용 expand.

#### `enforceBase64Limit` base64 guard + `mA(model).maxBase64Size` (확인)

```js
function y$_(H,_){
  let q=[],K=0;
  for(let O of H){ /* user role + content array 검사 */
    for(let $ of O.message.content){
      if(FQ9($)) gQ9($,++K,_,q);                    // 단일 image/document
      else if(ne1($)) for(let z of $.content) if(FQ9(z)) gQ9(z,++K,_,q);  // nested tool_result
    }
  }
  if(q.length>0) throw new mUH(q,_);                 // ImageSizeError
}
```

- `i0([msg],...)` 직후 `y$_(p_, mA(mainLoopModel).maxBase64Size)` 호출 — expand 결과의 base64 블록이 모델별 한도 초과면 `mUH` throw.
- `mUH` 메시지: 1개면 `"Image base64 size (X) exceeds API limit (Y). Please resize the image before sending."`, N개면 `"N images exceed the API limit (Y): Image 1: X1, … Please resize these images before sending."` (확인).
- overflow 처리: `runTurnLoop` outer catch 가 `mUH`/`iF` 받으면 즉시 `{reason:"image_error"}` 종료 ([call-model.md](call-model.md)/[agent-loop.md](agent-loop.md) §2). 이건 **클라이언트 사전 검증 실패** — API 측 413/이미지거절(reactive compact 경로)과 별개. (요청서가 언급한 "image-strip retry" 는 callModel 내부 `retry:media-strip` directive 로, `enforceBase64Limit` throw 와는 다른 layer — `enforceBase64Limit` 는 retry 없이 종료.)

### 2.7 `turnStartIndex = Uq3(x)` (확인 — 요청서 §7)

```js
function Uq3(H){
  for(let _=H.length-1;_>=0;_--){
    let q=H[_];
    if(q.type==="user"&&!q.isMeta&&!q.toolUseResult&&!q.isCompactSummary) return _;
  }
  return 0;
}
```

- `x` 정규화 완료 후 `Z={...Z,messages:x,turnStartIndex:Uq3(x)}` 로 ToolUseContext 에 실린다.
- 의미: **마지막 "진짜 사용자 발화" 메시지의 index** — meta/tool-result/compact-summary 가 아닌 user. UI 가 현재 턴 시작 위치로 스크롤하거나 도구가 "이번 사용자 요청 이후 메시지"를 식별하는 데 쓰는 마커.
- content-replacement 와의 관계 (확인): `replaceOversizedResults`/`replaceOversizedImpl` 는 `turnStartIndex` 를 **참조하지 않는다** — turn 경계와 무관하게 모든 그룹의 큰 tool_result 를 budget 기준으로 치환 대상에 넣는다. `turnStartIndex` 는 `replaceOversizedResults` 이후에 계산되어 ToolUseContext 로만 흘러가며 정규화 로직에 피드백되지 않음. 즉 "turn-start 이전만 치환" 같은 게이팅은 없다 — budget(`Xc9=200000`) 과 `seenIds`/`replacements` state 만 기준 (확인).

### 2.8 `forkContextMessages: x` (확인 — 요청서 §8)

`autocompact` / `startPrecomputeFork`(precompute fork) 둘 다 `cacheSafeParams` 에 `forkContextMessages: x` 를 넘긴다 (raw `W` 아님):

```js
yield* J.autocompact(x, Z, {systemPrompt:q, userContext:K, systemContext:O,
                             toolUseContext:Z, forkContextMessages:x}, z, F, c);
... b47(...) → x47({querySource:z, messages:x,
                     cacheSafeParams:{... forkContextMessages:x}});
```

- 왜 post-normalization `x` 인가 (확인): compaction fork(요약 생성)는 **메인 API 호출과 동일한 prompt prefix** 를 써야 prompt-cache hit (`tengu_compact_cache_prefix`) 가 난다. `sliceAtCompactBoundary`(boundary slice)+`replaceOversizedResults`(트리밍)+microcompact 를 모두 거친 `x` 가 실제 API 가 보는 형태이므로, fork 도 동일 `x` 를 base 로 해야 cache prefix 가 일치. raw `W` 는 boundary 이전 + 미트리밍 tool_result 를 포함해 prefix 불일치 → cache miss.
- `jY3`([15736](../../extracted-functions.js#L15736)) 의 fork 빌더도 `ZA(wY3(H.messages))` 로 동일하게 boundary-slice 한 메시지를 `forkContextMessages` 로 쓴다 — 일관 (확인).

### 2.9 `replaceClearedHints` — hint-clear 리매핑 (확인)

```js
function Nz_(H,_,q){
  if(_.size===0) return [...H];
  return H.map(K=>{
    if(K.type!=="user"||!Array.isArray(K.message.content)) return K;
    let O=false, T=K.message.content.map($=>{
      if($.type!=="tool_result"||!_.has($.tool_use_id)) return $;
      let z=q?.get($.tool_use_id) ?? lz8;          // "[Old tool result content cleared]"
      if($.content===z) return $;
      return O=true, {...$, content:z};
    });
    return O ? {...K, message:{...K.message, content:T}} : K;
  });
}
```

- callModel 의 `onHintCleared(ids,map)` 콜백 안에서 `x = Nz_(x, ids, map)` — 서버 context-hint directive 가 "이 tool_use_id 들 strip" 지시 시 해당 tool_result content 를 placeholder 로 immutable 치환.
- `replaceOversizedImpl`/`replaceOversizedResults` 의 디스크-persist placeholder(`<persisted-output>`) 와 **별개 placeholder**(`clearedHintPlaceholder`). 둘 다 immutable rebuild, 빈 set 이면 `[...H]` (얕은 복사) 반환. `timeBasedMicrocompact`(time-based microcompact, [8424](../../extracted-functions.js#L8424)) 도 `replaceClearedHints` 를 재사용.
- `replaceClearedHints` 결과는 `x` 에만 반영(다음 callModel attempt 입력), `D.messages` 에는 턴 끝 `[...x,...]` 합성으로 전파 — 즉 hint-clear 도 누적된다.

---

## 3. State / Schema

### 3.1 contentReplacementState

```ts
type ContentReplacementState = {
  seenIds:      Set<string>;             // 처리(치환 or 면제)된 tool_use_id
  replacements: Map<string, string>;     // tool_use_id → placeholder content
}
```

| 함수 | 동작 |
|---|---|
| `oz_()` | 빈 state |
| `Ur9(s)` | `{new Set(s.seenIds), new Map(s.replacements)}` deep copy (ED8 fork) |
| `X_6(msgs, records, prevMap?)` | transcript content-replacement 레코드 → state 재구성 |
| `lr9(state, msgs, records)` | `X_6(msgs, records, state.replacements)` |
| `Fr9(s,_)` | `tengu_hawthorn_steeple` off → undefined; on → `X_6` or `oz_` |

전이 (확인): `H75` 가 `replacements` 보유분을 `mustReapply`(idempotent), `seenIds` 보유분을 `frozen`, 미지를 `fresh` 로 분류. persist 성공한 fresh 항목만 `replacements.set` + `seenIds.add`. unlimited 도구 결과는 `seenIds` 에만 추가(영구 면제). 한번 `replacements` 에 들어간 id 는 매 턴 같은 placeholder 재적용 — 멱등.

### 3.2 transcript content-replacement 레코드

```ts
{ type: "content-replacement",
  sessionId: string,
  agentId?: string,
  replacements: Array<{ kind:"tool-result", toolUseId:string, replacement:string }> }
```

- `O1().appendEntry` 로 세션 jsonl 에 append. 원본 tool_result 는 `.claude/tool-results/<toolUseId>.{txt|json}` 별 파일 (`DYH`/`iz_`).
- resume 시 `X_6`/`Fr9` 가 이 레코드 + (필요시) 파일 로 state 복원 → API 트리밍 일관 유지하면서 transcript 뷰어는 원본 표시 가능.

### 3.3 dual-track 요약

| 채널 | 보는 내용 |
|---|---|
| API 입력 (`aY6(x,K)`) | `replaceOversizedResults`/`replaceClearedHints` 트리밍본 — `<persisted-output></persisted-output>` / `[Old tool result content cleared]` placeholder |
| `D.messages` (다음 턴 baseline, persist) | 트리밍본 누적 (멱등 재적용) |
| `.claude/tool-results/<id>` 파일 | tool_result **원본 전문** |
| 세션 jsonl `content-replacement` 레코드 | id→placeholder 매핑 (복원용) |

→ "API 는 트리밍, 로그는 풀" 확인.

### 3.4 size 상수 정리

| 상수 | 값 | 적용 함수 |
|---|---|---|
| `persistedOutputCap` | 200000 byte | `replaceOversizedImpl` per-message(per-group) budget |
| `resultSizeCapDefault` | 400000 byte | `mapResultBlock`/`pr9` 단일 tool_result persist 기본 임계 |
| `a$_` | 4 | byte/4 ≈ token (텔레메트리 추정) |
| `transcriptChunk` | 2000 | persist preview char |
| model `maxBase64Size` | per-model (`perModelLimits`) | `enforceBase64Limit` 이미지 base64 한도 |

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| boundary slice | 없음 (전체 history 전송) | `sliceAtCompactBoundary`=`slice(az3)` — 마지막 `compact_boundary` 이후만 |
| 큰 tool_result | 그대로 전송 (PTL 위험) | `replaceOversizedResults`/`replaceOversizedImpl` per-message 200KB budget → 디스크 persist + `<persisted-output>` placeholder |
| 치환 멱등성 | N/A | `contentReplacementState`(seenIds/replacements) — `H75` mustReapply 로 매 턴 동일 placeholder |
| unlimited 도구 면제 | N/A | `maxResultSizeChars` 무한대 도구는 budget 제외 |
| transcript fidelity | API==로그 동일 | dual-track: API 트리밍 / `content-replacement` 레코드+원본파일 로 복원 |
| hint-clear | 없음 | `replaceClearedHints` server context-hint placeholder 리매핑 |
| userContext 머지 | `getSystemPrompt` 일부 | `aY6(x,K)` — callModel 입력에서만 매 턴 fresh 합성, 미저장 (추정) |
| 작업 사본 격리 | query() 인자 전달 | `x` 재할당 사슬 (spread/immutable rebuild), `structuredClone` 미사용 |
| fork cache prefix | N/A | `forkContextMessages: x`(정규화본) 로 prompt-cache hit 정렬 |
| attachment expand | 단순 | `expandAttachments`+`enforceBase64Limit`(모델별 base64 cap, `mUH` 즉시 종료) |

---

## 5. 추정 / 확인 필요

- **`mergeUserContext` 정의**: 추출 한계로 미확보 (lazy-init 모듈). userContext 를 messages 앞에 머지하는 함수로 **추정**. user-role/`<context>`/`isMeta` 여부, CLAUDE.md·git status 포함 여부는 `Kw()` 와 함께 **확인 필요** (system-prompts.md / tool-use-context.md 교차참조).
- **`MYH` placeholder 본문**: minify 로 filepath/preview 보간이 잘림. `<persisted-output>…</persisted-output>` 래퍼 구조는 확인, 내부에 `DYH` 의 `{filepath, preview, hasMore}` 가 들어가는 것으로 **추정**.
- **`aq6`/`Kw` 본문**: 추출 JS 외부 (compaction-system.md §3.3 와 동일 한계).
- `tengu_hawthorn_steeple` off 시 `replaceOversizedResults` 전체 패스 → budget 미적용. 기본값 `Z_(...,false)` 라 게이트 on 여부는 런타임 Statsig 의존 (코드상 default off).
