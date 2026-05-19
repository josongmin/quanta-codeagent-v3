# Agent loop — 매 턴 시스템 프롬프트 / 컨텍스트 주입 메커니즘

추출 대상: `extracted-functions.js` (v2.1.143). 본 문서는 [`system-prompts.md`](system-prompts.md)
(정적 섹션 조립 `assembleSystemPrompt` 담당) 와 상보적으로, **`runTurnLoop` turn loop 안에서 매 턴 system 필드와
context 가 API 호출 페이로드로 합류하는 동선** 만 다룬다. `assembleSystemPrompt` 의 섹션 인벤토리/Statsig 게이트는
중복하지 않는다.

핵심 결론 (요약):

- `assembleSystemPrompt` (full 마스터 조립) 는 **턴마다 호출되지 않는다**. SDK `submitMessage` 진입 시 `sessionPromptInit` 안에서
  **단 한 번** 호출되어 `defaultSystemPrompt` 배열을 만든다.
- `runTurnLoop` 루프 안의 `qH=H4(ca7(q,O))` 는 매 턴 재실행되지만 `q` (이미 빌드된 배열) + `O`
  (systemContext) 의 **얕은 병합** 일 뿐 — 18개 동적 섹션 재계산이 아니다.
- CLAUDE.md / memory / 날짜 변화 / critical reminder 는 **system 프롬프트가 아니라
  `<system-reminder>` attachment (user 측 메시지)** 로 매 턴 주입된다 (`makeSystemReminderAttachment` attachment 시스템).
- `dynamicBoundaryMarker` boundary 와 cache_control 분할은 `runTurnLoop` 가 아니라 그 아래 `callModelOuter`/`buildCreatePayload`/`jU3`/`zd8` 에서
  수행된다.

---

## 1. 호출 그래프 — system + context 의 합류 동선

```
m_4.submitMessage  (line 21007, SDK 진입)
├─ nr8({tools, mainLoopModel, additionalWorkingDirectories,                line 21003
│        customSystemPrompt, excludeDynamicSections, cacheBreakerPhrase})
│   └─ Promise.all([
│        customSystemPrompt!==void0 ? [] : KZ(tools,model,cwds,{excludeDynamicSections}),  ← ★ 1회
│        Kw(),                          ← userContext   (claudeMd/userEmail/currentDate)
│        customSystemPrompt!==void0 ? {} : tD(cacheBreakerPhrase),  ← systemContext (gitStatus/perforce)
│        excludeDynamicSections&&... ? fj6(model,cwds) : {}
│      ])
│   returns { defaultSystemPrompt:$, userContext:z(=Kw()), systemContext:A(=tD()) }
│
├─ KH = H4([ ...(custom ? [custom] : defaultSystemPrompt),     ← 시스템 프롬프트 배열 (1회 확정)
│            ...(memory ? [memory] : []),                       ← OO_(model) — custom set 시만
│            ...(append ? [append] : []) ])
│
└─ iI({ messages:ZH, systemPrompt:KH, userContext:_H, systemContext:JH,        line 21007
│        canUseTool, toolUseContext:TH, fallbackModel, querySource:"sdk",
│        maxTurns, taskBudget, stopHookActive })
    └─ iI  (line 14056)  →  yield* Bq3(H, _)
        └─ Bq3  (line 14057)  ─ async generator, while(!0) ─────────────── 매 턴:
           ├─ q = H.systemPrompt   (= KH, 루프 내내 reassign 없음)        ← 확인
           ├─ K = H.userContext    (= _H = {...Kw(), ...mcp})             ← 확인
           ├─ O = H.systemContext  (= JH = tD())                          ← 확인
           │
           ├─ (turn body)
           │  ├─ x = [...ZA(W)]                          # 메시지 정규화
           │  ├─ x = await J.microcompact(x,Z,z)         # tier1 (messages만)
           │  ├─ let qH = H4(ca7(q,O));                   # ★ system 합류 (매 턴, 얕은 병합)
           │  ├─ yield* J.autocompact(x, Z,                # tier2
           │  │     {systemPrompt:q, userContext:K,
           │  │      systemContext:O, ...}, ...)           # cacheSafeParams 로만 전달
           │  ├─ J.callModel({                             # ← 실제 API 호출
           │  │     messages: aY6(x, K),                   # ★ userContext 를 messages 에 주입
           │  │     systemPrompt: qH,                       # ★ system 필드 (q+O 병합본)
           │  │     userSystemPrompt: !agentId && kf()
           │  │            ? pq3(custom,append) : void 0,   # 텔레메트리 전용 (모델 미전달)
           │  │     hasAppendSystemPrompt: !!append, ... })
           │  └─ ...tool 실행... → SnH/B93 attachment drain (CLAUDE.md/date/memory reminders)
           │
           └─ continue (다음 턴) — q/K/O 동일, qH 재계산

J.callModel  (= NiH → DSK, line 19054)
└─ 전처리 (RJ6 바깥, attempt 무관 1회):
   _ = H4([ oi_(F),                                    # x-anthropic-billing-header  (cache:null)
            ri_({isNonInteractive, hasAppendSystemPrompt}),  # N98/WL9/ZL9 헤더    (cache:"org")
            ..._,                                       # ← qH (q+O 병합본)
            ...(advisor ? [w97] : []) ].filter(Boolean))
   c = jU3(_, enablePromptCaching, {skipGlobalCacheForSystemPrompt:k, cacheTtl:Q})  line 19063
       └─ zd8(_, {skipGlobalCacheForSystemPrompt})       line 18993  — eo boundary 분할
   K_(OH) → { system: c, messages: wU3(S,...), ... }     line 19057
```

핵심 호출 위치:

| 호출 | 위치 | 역할 |
|---|---|---|
| `sessionPromptInit` | line 21003 | `assembleSystemPrompt`+`Kw`+`tD` 1회 실행, `{defaultSystemPrompt,userContext,systemContext}` 리턴 |
| `Kw` | line 8498 (`Kw=X6(async()=>{...})`) | userContext 빌더 — CLAUDE.md / userEmail / currentDate |
| `tD` | line 8498 (`tD=X6(async(H)=>{...})`) | systemContext 빌더 — gitStatus / perforceMode |
| `wrapSystem` | line 7945 | `function H4(H){return H}` — **순수 identity** (확인) |
| `ca7(q,O)` | line 14057 내 호출만 존재 | systemPrompt 배열 + systemContext 병합 (정의는 추출 누락 — §2.1) |
| `aY6(x,K)` | line 14057 내 호출만 존재 | messages + userContext 주입 (정의는 추출 누락 — §3) |
| `resolveUserSystemPrompt` | line 14054 | userSystemPrompt 텔레메트리 빌더 (body 추출 truncate) |
| `jU3` | line 19063 | `zd8` wrapper — `{type:"text",text,cache_control?}` 매핑 |
| `zd8` | line 18993 | `dynamicBoundaryMarker` boundary 기준 cache scope 분할 |
| `makeSystemReminderAttachment` | line 14251 | attachment 시스템 — `critical_system_reminder`/`date_change`/`nested_memory` 등 |
| `s93` | line 14278 | `criticalSystemReminder_EXPERIMENTAL` → attachment |
| `r93` | (date_change) | 날짜 변경 감지 → `date_change` attachment |
| `flattenCompactionResult` | line 14736 | compact 결과 평탄화 — **messages 만** (system 무관) |
| `Xe`/`wV6` | line 9861 / 1803 | 섹션 캐시 invalidate |

---

## 2. system 프롬프트의 매 턴 합류 — `qH = H4(ca7(q, O))`

### 2.1 `ca7(systemPrompt, systemContext)` 와 `wrapSystem` wrapper

`runTurnLoop` 본문에서 (line 14057, microcompact 직후 / autocompact 직전):

```js
let qH = H4(ca7(q, O));    // q = H.systemPrompt (배열), O = H.systemContext (객체)
```

- `H4(H){return H}` — **identity 함수** (line 7945, 확인). `combineSystemAndContext` 결과를 그대로 통과시킬 뿐,
  타입 마킹/no-op wrapper 역할 (minify 전 타입 annotation 자리로 추정).
- `ca7(q,O)` 의 **정의 본문은 추출본에 존재하지 않는다**: `extracted-functions.js` 전체에서
  `combineSystemAndContext` 식별자는 line 14057 의 단일 호출 사이트 1회만 등장하며 `function ca7`/`ca7=` 정의가
  없다 (`extracted-code.js` 에도 없음). Bun lazy-init `R(()=>{...})` 모듈 내부에 minify 된
  로컬명으로만 존재해 splitter 가 잡지 못한 것으로 추정. **정의 미확인, 동작은 호출 컨텍스트로
  역추론** (아래).

`ca7(q, O)` 의 역할 (추정 — 호출 컨텍스트 + 하류 `callModelOuter` 사용 패턴 기반):

- `q` 는 `submitMessage` 의 `KH = H4([...defaultSystemPrompt|custom, ...memory, ...append])`,
  즉 **이미 완성된 system 텍스트 블록 배열**.
- `O` 는 `tD()` 가 만든 `{ gitStatus?, perforceMode? }` 객체.
- `combineSystemAndContext` 은 `O.gitStatus`/`O.perforceMode` 를 system 배열의 텍스트 블록으로 변환·append 해
  최종 system 배열을 만든다. (`O` 가 비면 `q` 그대로.) 결과는 `callModelOuter` 의 `_` 파라미터로 전달되며
  거기서 `billingHeaderBuilder`/`selectPromptHeader` 가 추가로 prepend 된다 (§4).

> 확인: `q` 가 `runTurnLoop` 루프 안에서 **재할당되지 않는다** (line 14057 전체에 `q=` 형태 재대입
> 부재 — `H.systemPrompt` 디스트럭처 후 read-only). `O` 도 동일. 따라서 `ca7(q,O)` 의 입력은
> 모든 턴에서 불변이고, 출력 `qH` 도 매 턴 동일 값이다 (단 객체 identity 는 매 턴 새로 생성).

### 2.2 매 턴 재계산 vs 메모이즈 — 비용 분석

| 단계 | 호출 빈도 | 비용 |
|---|---|---|
| `assembleSystemPrompt` (full 마스터, 18 동적 섹션) | **세션당 1회** (`sessionPromptInit`, submitMessage 진입) | 큼 — 단, `sectionCacheHelper`/`sectionCacheHelper` 섹션 캐시 적용 |
| `KH` 조립 (`H4([...])`) | 세션당 1회 (submitMessage) | 무시 가능 (배열 spread) |
| `qH = H4(ca7(q,O))` | **턴마다 1회** (`runTurnLoop` while body 진입) | 작음 — `q`(완성 배열) + `O`(작은 객체) 얕은 병합 |
| `callModelOuter` 전처리 (`billingHeaderBuilder`/`selectPromptHeader` prepend + `jU3`/`zd8`) | **API attempt 마다** | 중간 — string join + boundary split |

결론 (확인): **시스템 프롬프트의 비싼 ~18 동적 섹션 재조립은 매 턴 일어나지 않는다.** `assembleSystemPrompt` 는
세션 1회. `runTurnLoop` 의 `qH=H4(ca7(q,O))` 는 매 턴 재실행이지만 입력 불변 + 얕은 병합이라 사실상
no-op 수준. 진짜 "매 턴/매 attempt" 반복 비용은 `callModelOuter` 의 `jU3→zd8` boundary 분할
(string concat)인데, 이것이 곧 prompt cache 가 보호하려는 대상이다 (§4).

> 추정: `combineSystemAndContext` 가 매 턴 새 배열 객체를 만들어도 텍스트 내용이 동일하므로, 하류
> `insertCacheMarkers`/`zd8` 가 부여하는 `cache_control` 의 cache hit 에는 영향 없음 (Anthropic prompt
> cache 는 객체 identity 가 아닌 prefix 텍스트 동일성으로 hit). 따라서 매 턴 새 객체 생성이
> 캐시를 깨지 않는다.

### 2.3 동적 섹션 캐시 `sectionCacheHelper`/`sectionCacheHelper`/`systemPromptSectionCache` — 무엇이 invalidate 하나

(`assembleSystemPrompt` 내부 메커니즘이지만 "매 턴 재조립 비용" 질문과 직결되므로 여기서 invalidation 만 정리.)

```js
function kG(H,_){ return {name:H, compute:_, cacheBreak:!1} }                    // line 9858
function v47(H){ let _=K3H();                                                     // line 9860
  return Promise.all(H.map(async q=>{
    if(!q.cacheBreak && _.has(q.name)) return _.get(q.name)??null;                // ← 캐시 hit
    let K=await q.compute(); return YV6(q.name,K), K }))}
function K3H(){ return F_.systemPromptSectionCache }                              // line 1801
function YV6(H,_){ F_.systemPromptSectionCache.set(H,_) }                         // line 1802
function wV6(){ F_.systemPromptSectionCache.clear() }                            // line 1803
function Xe(){ wV6(), ZV6() }                                                     // line 9861
```

`F_.systemPromptSectionCache` (Map) 는 프로세스 전역. `assembleSystemPrompt` 가 세션당 1회만 호출되므로
**정상 흐름에선 이 캐시가 거의 invalidate 되지 않는다**. 그러나 `assembleSystemPrompt` 가 재호출되는 시점
(다음 `submitMessage`, fork, subagent 등)에 대비해 다음 이벤트가 `Xe()`/`wV6()` 로
캐시를 비운다 (확인 — 호출 사이트):

| invalidation 사이트 | 함수 | 무엇을 비우나 |
|---|---|---|
| post-compact cleanup | `sn(...)` (`q96(...,"post_compact_cleanup")`) | `Kw.cache.clear()` (CLAUDE.md) + `Xe()` (섹션) + `Fz_("compact")` + `iD8()` |
| worktree enter | `EnterWorktree.call` (`process.chdir`+`pb`+`Xe()`+`SY.cache.clear`) | 섹션 캐시 + git 캐시 (cwd 변경) |
| worktree exit / restore | `JR_`/`FQK` (`process.chdir`+`Xe()`+`SY.cache.clear`) | 동일 |
| init/reset | `Xe()` via `wV6()+ZV6()` | 전체 |

즉 **cwd 변경(worktree)** 과 **compaction** 이 섹션 캐시를 무효화하는 주된 트리거다. 그 외에는
세션 동안 동적 섹션이 동일하게 캐시된 값을 재사용한다.

---

## 3. context (CLAUDE.md / env / git) 의 매 턴 주입 — 두 경로

v2.1.143 에는 **`<context name="...">...</context>` 리터럴이 추출본 어디에도 없다**
(`grep` 결과 0건 — `all-big-strings.txt`/`cstring.bin` 포함). v0.x 의 context-XML 포맷은
폐기되었고, 컨텍스트는 두 갈래로 나뉘어 주입된다:

### 3.1 systemContext (`tD`) — `system` 필드로 (`combineSystemAndContext` 경유)

```js
tD = X6(async (H) => {                                                   // line 8498
  let q = (xH(process.env.CLAUDE_CODE_REMOTE) || !dz_()) ? null : await GA8();  // git status
  return { ...q && { gitStatus:q },
           ...xH(process.env.CLAUDE_CODE_PERFORCE_MODE) && { perforceMode:`...` } };
});
```

- `X6(...)` = 메모이즈 wrapper. `tD` 는 `sessionPromptInit` 에서 **세션 1회** 호출 → `systemContext` (`O`).
- `O` 는 `runTurnLoop` 의 `ca7(q,O)` 를 통해 매 턴 **system 텍스트 블록으로 합류** (§2.1).
- 따라서 **git status 는 캐시된 1회 스냅샷** — 매 턴 재실행되지 않는다 (`tD` 메모이즈 +
  `sessionPromptInit` 1회). 갱신은 `tD` 캐시 무효화(=`Kw.cache.clear`/`SY.cache.clear` 와 함께
  worktree·compact 시) 후 다음 `submitMessage` 의 `sessionPromptInit` 재호출에서만.

> 확인: `tD` 의 `X6` 메모이즈 + `sessionPromptInit` 의 1회 호출 ⇒ git/perforce 컨텍스트는 turn-static.
> "매 턴 git status 재계산" 은 **아님** (추정성 우려 해소: `tD` 자체에 turn-hook 없음).

### 3.2 userContext (`Kw`) — messages 로 (`aY6(x,K)` 경유)

```js
Kw = X6(async () => {                                                    // line 8498
  let _ = xH(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) || (G4()&&gN().length===0),
      q = _ ? null : DA8(gz_(await bX()));        // ← CLAUDE.md 로드
  Fk6(q||null);
  let K = process.env.ANTHROPIC_UNIX_SOCKET ? void 0 : TO()?.emailAddress;
  return { ...q && { claudeMd:q },
           ...K && { userEmail:`The user's email address is ${K}.` },
           currentDate: Wi9(QAH()) };
});
```

`Kw` 리턴 `{ claudeMd, userEmail, currentDate }` 가 `sessionPromptInit` 의 `userContext` (`K`). `runTurnLoop` 는
매 턴 `callModel({ messages: aY6(x, K), ... })` 로 호출 — **`aY6(x,K)` 가 userContext 를
messages 배열에 주입**한다.

- `mergeUserContext` 의 정의 본문도 추출 누락 (`combineSystemAndContext` 와 동일하게 line 14057 단일 호출만 존재). 동작은
  "현 메시지 배열 `x` 에 CLAUDE.md/userEmail/currentDate 를 메시지(들)로 합류" 로 추론
  (`messages:` 인자에 직접 들어가므로 user-role 컨텐츠 또는 system-reminder 형태). **추정.**
- `Kw` 도 `X6` 메모이즈 + `sessionPromptInit` 1회 → CLAUDE.md 는 세션당 1회 로드. `Kw.cache.clear()` 가
  post-compact (`sn`) 에서 호출되므로, **compaction 후 다음 턴에 CLAUDE.md 재로드** (확인).

### 3.3 동적 컨텍스트의 진짜 경로 — `makeSystemReminderAttachment` attachment 시스템

매 턴 변하는 컨텍스트(날짜, CLAUDE.md 변경, nested memory, todo, plan/auto 모드,
critical reminder 등)는 system 도 `Kw`/`tD` 도 아닌 **`makeSystemReminderAttachment` attachment 파이프라인** 으로
주입된다 (line 14251 `makeSystemReminderAttachment`, tool 실행 후 `SnH`/message-queue drain 단계에서 합류):

```js
function B93(H,_,q,K,O,T,$){ ...
  let M = [ o$("queued_commands", ...), o$("date_change", ()=>Promise.resolve(r93(O))),
            o$("ultrathink_effort",...), o$("deferred_tools_delta",...),
            o$("changed_files",()=>z73(w)), o$("nested_memory",()=>A73(w)),
            o$("dynamic_skill",...), o$("skill_listing",...),
            o$("plan_mode",...), o$("plan_mode_exit",...),
            o$("auto_mode",...), o$("auto_mode_exit",...),
            o$("todo_reminders",()=>rj()?V73(O,_):L73(O,_)),
            o$("agent_pending_messages",()=>F93(_)),
            o$("critical_system_reminder",()=>Promise.resolve(s93(_))) ],
      f = j ? [ o$("memory_update",()=>Promise.resolve(v73(_))),
                o$("token_usage",...), o$("budget_usd",...), ... ] : [];
  ...
}
function T9(H){ return {attachment:H, type:"attachment", uuid:..., timestamp:...} }  // line 14331
```

- 각 `o$(label, computeFn)` 가 attachment 객체를 만들고 `T9(...)` 로 `{type:"attachment"}`
  메시지로 래핑되어 다음 턴 messages 에 들어간다 → 모델에는 `<system-reminder>...</system-reminder>`
  텍스트로 렌더된다 (tool_result/user 컨텐츠 측, `# System` 프롬프트의 "Tool results and
  user messages may include <system-reminder>" 규약과 일치).
- 즉 **CLAUDE.md 변경분(`memory_update`/`nested_memory`), 날짜 변경, todo, plan/auto 모드
  전이, critical reminder 는 전부 system 프롬프트가 아니라 user 측 attachment 메시지** 다.
  이것이 "재조립 비용 없이 매 턴 갱신" 을 가능케 하는 핵심 설계 — system prefix 는
  불변(=cache hit) 유지, 변하는 정보는 messages 꼬리에 append.

### 3.4 env `<env>` / 날짜 refresh — 매 턴 재계산되나?

| 항목 | 위치 | 매 턴 갱신? |
|---|---|---|
| `<env>` cwd/git/platform/model (`ZB3`) | `assembleSystemPrompt` 동적 섹션 `env_info_simple` | **아니오** — `sectionCacheHelper`/`sectionCacheHelper` 캐시 + `assembleSystemPrompt` 1회. cwd 변경 시 `Xe()` (worktree) 로만 무효화 |
| `Date: ...` (DB3 끝, `HFH()`) | `assembleSystemPrompt` `session_guidance` 섹션 | **아니오** — 섹션 캐시. 단 `r93` 가 보조 |
| 날짜 변경 (`date_change`) | `makeSystemReminderAttachment` attachment `r93(O)` | **예** — 매 턴 attachment drain 시 |

`r93` (date_change attachment 생성):

```js
function r93(H){
  let _ = QAH(), q = jV6();        // 현재 날짜, 캐시된 날짜
  if (q !== _) jH_(_);             // 캐시 갱신
  if (HFH() === _) return [];      // system prompt 의 날짜와 동일하면 attachment 불필요
  for (let K of ZA(H??[]))         // 이미 같은 date_change attachment 있으면 skip
    if (K.type==="attachment" && K.attachment.type==="date_change" && K.attachment.newDate===_) return [];
  return [{ type:"date_change", newDate:_ }];
}
```

해석 (확인): `<env>`/`Date:` 의 날짜는 **system 프롬프트에 박혀서 갱신 안 됨** (cache hit 보존
목적). 자정을 넘겨 날짜가 바뀌면 `r93` 가 그 사실을 감지해 `date_change` **attachment** 로
모델에 알린다 (system prompt 의 `HFH()` 와 실제 `QAH()` 가 불일치할 때만 1회 발행, 중복 방지
가드 포함). 즉 **env 정보 자체는 turn-static, "변했다"는 신호만 attachment 로 동적 전달**.

> 이 대화에서 실제로 관측된 system-reminder ("The date has changed. Today's date is now
> 2026-05-19. DO NOT mention this...") 가 정확히 `r93`→`date_change` attachment 의
> 산출물이다 — 문서 작성 중 라이브 확인.

---

## 4. `dynamicBoundaryMarker` boundary 와 cache_control 분할 — `runTurnLoop` 가 아닌 `callModelOuter`/`jU3`/`zd8`

매 턴 system 합류(`qH`)는 `runTurnLoop` 에서 끝나고, **cache 경계 부여는 `callModelOuter` (callModel) 전처리에서**
일어난다. `runTurnLoop` 는 cache_control 을 직접 만지지 않는다 (확인 — `runTurnLoop` 본문에 `cache_control`
부재; system 측 분할은 `jU3`/`zd8`, messages 측은 `insertCacheMarkers`).

### 4.1 `callModelOuter` 전처리에서 헤더 prepend

```js
// DSK (line 19054) — RJ6 바깥, 1회:
_ = H4([ oi_(F),                                                  // billing 헤더
         ri_({ isNonInteractive:T.isNonInteractiveSession,
               hasAppendSystemPrompt:T.hasAppendSystemPrompt }),   // N98/WL9/ZL9
         ..._,                                                      // ← qH (q+O 병합본)
         ...(J ? [w97] : []) ].filter(Boolean));                    // advisor 노트
uEK(_);
let g = T.enablePromptCaching ?? ASK(T.model),
    Q = ikH(T.querySource) ? "1h" : void 0;                         // repl/sdk → 1h TTL
let c = jU3(_, g, { skipGlobalCacheForSystemPrompt:k, cacheTtl:Q });
```

- `_` 는 `runTurnLoop` 가 넘긴 `qH`. 여기에 `billingHeaderBuilder` (billing) + `selectPromptHeader` (CLI/SDK 헤더) 가 **앞에** 붙는다.
- `Q` = `"1h"` (repl_main_thread / sdk) 또는 undefined(5분 기본).

### 4.2 `jU3` → `zd8` — boundary 기준 cache scope

```js
function jU3(H,_,q){                                               // line 19063
  return zd8(H,{skipGlobalCacheForSystemPrompt:q?.skipGlobalCacheForSystemPrompt})
    .map(K => ({ type:"text", text:K.text,
                 ..._ && K.cacheScope!==null && { cache_control:hi({scope:K.cacheScope, ttl:q?.cacheTtl}) } }));
}

function zd8(H,_){                                                 // line 18993
  let q = F$H(),                                                    // 1P/AWS + 1h cache 활성
      K = H.findIndex(Y => Y === eo);                                // eo boundary 위치
  if (q && _?.skipGlobalCacheForSystemPrompt && K===-1){
    d("tengu_sysprompt_using_tool_based_cache",{promptBlockCount:H.length});
    let Y,w,j=[];
    for (let M of H){
      if (!M || M===eo) continue;
      if (M.startsWith("x-anthropic-billing-header")) Y=M;          // billing  → cacheScope:null
      else if (ii_.has(M))                            w=M;          // 등록 헤더 → cacheScope:"org"
      else                                            j.push(M);    // 본문 누적
    }
    let J=[];
    if (Y) J.push({ text:Y, cacheScope:null });                     // ① billing  — 캐시 안 함
    if (w) J.push({ text:w, cacheScope:"org" });                    // ② 헤더     — org-scope 캐시
    let D = j.join("\n");
    // ... 이후 본문(static prefix) / boundary 이후(dynamic suffix) 분할 →
    //     ③ static prefix (joined, 별도 cache_control)
    //     ④ eo 이후 dynamic 부분 (별도 cache_control)
  }
  ...
}
```

(④ 이후 본문은 추출 splitter 가 `j.join("\n")` 의 개행에서 함수 경계를 잘못 끊어 `zd8` 의
나머지가 다른 함수와 뒤섞임 — [`system-prompts.md`](system-prompts.md) §3.4 의 분석과 동일
한계. 읽힌 분기까지는 확인.)

**4개 cache_control breakpoint 전략 (확인 — 읽힌 분기 + system-prompts.md 교차):**

| # | 블록 | `cacheScope` | cache_control | 의미 |
|---|---|---|---|---|
| ① | `oi_(F)` billing 헤더 | `null` | **없음** | `cc_version`/`cc_entrypoint` — 매 호출 가변 가능, 캐시 제외 |
| ② | `ri_(...)` 인증 헤더 (`headerMain`/`headerSdkAppend`/`headerSdkAgent`) | `"org"` | 있음 | 조직 단위 공유 캐시 (모든 사용자 동일) |
| ③ | static prefix (헤더 後 ~ `dynamicBoundaryMarker` 前) | (scope) | 있음 | `# System`/`# Doing tasks`/도구 등 — 세션 불변, 가장 큰 cache hit 대상 |
| ④ | `dynamicBoundaryMarker` 이후 dynamic suffix | (scope) | 있음 | env/memory/session-guidance 등 동적 섹션 — 별도 breakpoint |

- `eo = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` (line 3565) 는 **API 로 전송되지 않는다**
  (`if (M===eo) continue;`). 순수 분할 마커.
- 효과: ④(dynamic suffix)가 바뀌어도 ①②③ prefix 의 cache hit 가 보존된다. 동적 섹션이
  자주 안 바뀌면 ④까지 hit. 이것이 "18 동적 섹션을 매 턴 재조립해도 캐시로 흡수" 의 실체 —
  정확히는 *재조립을 안 하고*(§2.2) + *바뀌어도 prefix 캐시 보존*(여기) 이중 방어.
- `F$H()` = `CR() && bT() && (provider==="firstParty"||"anthropicAws")` (line 5214 확인) —
  1P/AWS + 직결 host 일 때만 tool-based cache 분할 발동. 그 외 provider 는 단순 경로.

### 4.3 messages 측 cache marker — `insertCacheMarkers` (별개)

`buildCreatePayload` 의 `messages: wU3(S, a8, Q, T8, gH, rH, skipCacheWrite, forkPointUuid)` 은 system 과
**독립적으로** 마지막 user 메시지(들)에 `cache_control` 부착 (자세히는
[`call-model.md`](call-model.md) §2.1 `insertCacheMarkers`). 즉 한 요청에 system 측(`jU3`/`zd8`) +
messages 측(`insertCacheMarkers`) 두 종류 cache breakpoint 가 공존한다.

---

## 5. userSystemPrompt — `pq3(customSystemPrompt, appendSystemPrompt)`

### 5.1 replace vs append (확인 — `system-prompts.md` §4 와 일치, 여기선 turn 관점)

`submitMessage` (line 21007):

```js
let t = (M!==void 0 && Bi_()) ? await OO_(HH) : null;     // M = customSystemPrompt
KH = H4([ ...(typeof M==="string" ? [M]
              : Array.isArray(M) ? M
              : s),                                        // s = defaultSystemPrompt (KZ 결과)
          ...(t ? [t] : []),                               // 메모리 (OO_) — custom set 시만
          ...(f ? [f] : []) ]);                            // f = appendSystemPrompt
```

- `customSystemPrompt` 미지정 → `assembleSystemPrompt` 의 `defaultSystemPrompt` 전체 사용.
- `customSystemPrompt` 지정 (string/array) → **default 전체를 replace** + `Bi_()` 시
  메모리(`OO_`) 자동 add + append. (이때 `sessionPromptInit` 는 `assembleSystemPrompt`/`tD` 를 아예 호출 안 함:
  `customSystemPrompt!==void0 ? Promise.resolve([]) : KZ(...)`, `tD` 도 `{}`.)
- `appendSystemPrompt` → 항상 끝에 추가 (replace 와 무관).

이 `KH` 가 `runTurnLoop` 의 `q` 가 되어 **모든 턴 동일** 하게 system 으로 합류 (§2.2).

### 5.2 `userSystemPrompt` — 모델 미전달, 텔레메트리 전용

`runTurnLoop` 의 `callModel` 호출 인자:

```js
hasAppendSystemPrompt: !!Z.options.appendSystemPrompt,
userSystemPrompt: !Z.agentId && kf() ? pq3(Z.options.customSystemPrompt,
                                            Z.options.appendSystemPrompt) : void 0,
```

```js
function pq3(H,_){                                                  // line 14054 (body truncate)
  let K=[ typeof H==="string" ? H : Array.isArray(H) ? H.join("\n") : void 0 ];
  // ... return 부 추출 누락
}
```

- `kf()` = beta tracing endpoint 설정 시만 true ([`system-prompts.md`](system-prompts.md)
  §4.2). 따라서 `userSystemPrompt` 는 **모델 API body 가 아니라 추적/로깅 채널 전용** —
  `buildCreatePayload` 페이로드의 `system` 필드와 무관. customSystemPrompt 원본을 텔레메트리에 남기는 용도.
- `!Z.agentId` 가드 → subagent 에선 미전송.

---

## 6. CLAUDE.md / memory 의 주입 지점 정리

| 무엇 | 어디로 | 언제 refresh |
|---|---|---|
| CLAUDE.md (`Kw().claudeMd`) | `userContext` → `aY6(x,K)` → **messages** | `Kw` 메모이즈 + `sessionPromptInit` 1회. compaction 후 `Kw.cache.clear()`(`sn`) → 다음 턴 재로드 |
| auto memory 섹션 (`OO_`/`kG("memory")`) | **system** (`assembleSystemPrompt` 동적 섹션 또는 custom 시 SDK push) | 섹션 캐시. compaction `Xe()` 후 다음 `assembleSystemPrompt` 에서만 |
| memory 변경분 (`memory_update` `v73`) | `makeSystemReminderAttachment` attachment → **`<system-reminder>` user msg** | **매 턴** drain |
| nested memory (`nested_memory` `A73`) | `makeSystemReminderAttachment` attachment → user msg | 매 턴 (trigger 시) |
| userEmail / currentDate | `userContext` → `mergeUserContext` → messages | `Kw` 1회 |
| critical reminder | `makeSystemReminderAttachment` attachment (`s93`) → user msg | 매 턴 |

핵심: **정적 memory 가이드는 system 프롬프트**(turn-static), **실제 memory 내용 변경/추가는
attachment**(turn-dynamic). `InstructionsLoaded` hook 관계는 본 추출 범위에서 직접 호출
사이트 미확인 — CLAUDE.md 로드(`Kw`→`bX`) 경로와 hook registry 의 연결은 **확인 필요**.

---

## 7. `criticalSystemReminder_EXPERIMENTAL` 주입 메커니즘

agent 정의 Zod 스키마 필드 (line 9615):

```js
criticalSystemReminder_EXPERIMENTAL: y.string().optional()
  .describe("Experimental: Critical reminder added to system prompt")
```

(스키마 설명문은 "added to system prompt" 라 쓰여 있으나 **실제 구현은 attachment** — 설명과
구현 불일치, 구현 우선.)

전파 경로 (확인):

```
agent def.criticalSystemReminder_EXPERIMENTAL
  └─ ED8 류 ctx fork (line 9845): ctx.criticalSystemReminder_EXPERIMENTAL = _?.criticalSystemReminder_EXPERIMENTAL
       └─ B93 attachment list (line 14251):
            o$("critical_system_reminder", () => Promise.resolve(s93(_)))
              └─ s93(ctx) (line 14278):
                   let _ = ctx.criticalSystemReminder_EXPERIMENTAL;
                   return _ ? [{ type:"critical_system_reminder", content:_ }] : [];
                     └─ T9(...) 래핑 → {type:"attachment", attachment:{type:"critical_system_reminder",...}}
                          └─ 다음 턴 messages 에 <system-reminder> 로 합류
```

- `critical_system_reminder` 는 `LR3` attachment-type Set (line 17058) 의 등록 멤버 —
  `hook_additional_context`/`todo_reminder`/`date_change` 등과 동일 클래스.
- 즉 caller 가 agent 정의에 `criticalSystemReminder_EXPERIMENTAL` 을 주면, **system 프롬프트
  재조립 없이** 매 턴 `makeSystemReminderAttachment` attachment drain 단계에서 user-측 `<system-reminder>` 로
  높은-우선 리마인더가 주입된다. system prefix cache 를 깨지 않는 설계.

---

## 8. compaction 과의 관계 — system 프롬프트는 불변

`flattenCompactionResult` (compact 결과 평탄화, line 14736):

```js
function AKH(H){
  return [ H.boundaryMarker, ...H.summaryMessages, ...H.messagesToKeep,
           ...H.attachments, ...H.hookResults ];
}
```

(확인) `flattenCompactionResult` 의 5-field concat 은 **전부 messages 도메인** — `boundaryMarker`/요약/유지메시지/
attachment/hook 결과. **system 프롬프트는 등장하지 않는다.** `runTurnLoop` 의 compaction 분기
(autocompact/reactive)는 `x` (messages) 만 `AKH(result)` 로 교체할 뿐 `q`/`qH` 를 건드리지
않는다 (§2.1 의 `q` read-only 확인과 일치).

- 단, **post-compact 정리(`sn`)** 가 `Kw.cache.clear()` + `Xe()` 를 호출하므로, *그 다음에*
  `assembleSystemPrompt`/`Kw`/`tD` 가 재호출되는 경로(다음 submitMessage 등)에서는 CLAUDE.md·동적 섹션이
  fresh 하게 다시 빌드된다. 그러나 **현재 진행 중인 `runTurnLoop` 루프 자체의 `q`/`O`/`K` 는 불변** —
  compaction 직후에도 같은 system 프롬프트로 모델 호출이 이어진다.
- 결론 (확인): compaction 은 messages 만 바꾼다. system 프롬프트는 동일 `runTurnLoop` 호출
  생애 동안 turn-invariant. cache_control 분할(④ dynamic suffix)도 그대로 hit 유지.

---

## 9. 종합 — "매 턴 무엇이 새로 들어가나" 한 장 요약

| 데이터 | 도메인 | 매 턴 재계산 | 캐시/불변성 |
|---|---|---|---|
| 헤더 (`headerMain`/`headerSdkAppend`/`headerSdkAgent`) | system ② | `selectPromptHeader` 호출 1회/attempt | `cacheScope:"org"`, 텍스트 불변 |
| `# System`/`# Doing tasks`/도구 등 static | system ③ | 재계산 안 함 (`assembleSystemPrompt` 1회) | prefix cache hit |
| env/memory/session-guidance 동적 섹션 | system ④ (`dynamicBoundaryMarker` 後) | 재계산 안 함 (`sectionCacheHelper`/`sectionCacheHelper` 캐시) | 별도 cache breakpoint |
| `ca7(q,O)` 병합 | system | 매 턴 (얕은 병합, 내용 불변) | 캐시 영향 없음 |
| gitStatus / perforce (`tD`) | system (`O`→`combineSystemAndContext`) | 재계산 안 함 (`X6` 메모이즈+`sessionPromptInit`1회) | turn-static |
| CLAUDE.md / userEmail (`Kw`) | messages (`mergeUserContext`) | 재계산 안 함 (`X6`+`sessionPromptInit`1회) | compact 시 무효화 |
| date_change / memory_update / todo / critical reminder | messages (`makeSystemReminderAttachment` attachment) | **매 턴 drain** | `<system-reminder>` user msg |
| 마지막 user msg cache marker (`insertCacheMarkers`) | messages | 매 attempt | system 과 독립 |

**설계 요지**: 비싼 system 조립은 세션 1회 + 섹션 캐시, 매 턴 변하는 정보는 system 이 아닌
attachment(messages 꼬리)로 흘려 prompt-cache prefix(`dynamicBoundaryMarker` 기준 4 breakpoint)를 깨지 않는다.
`runTurnLoop` 의 `qH=H4(ca7(q,O))` 는 이 불변 prefix 를 매 턴 동일하게 재제시할 뿐인 저비용 연산이다.

---

## 부록: 추출 한계 / 확인·추정 표기

| 항목 | 상태 |
|---|---|
| `wrapSystem` = identity (`function H4(H){return H}`) | 확인 (line 7945) |
| `qH=H4(ca7(q,O))` 가 `runTurnLoop` while-body 매 턴 실행 | 확인 (line 14057) |
| `q`/`K`/`O` 가 `runTurnLoop` 루프 내 재할당 없음 | 확인 (`q=`/`K=`/`O=` 재대입 부재) |
| `combineSystemAndContext` 본문 정의 | **추출 누락** — 호출 1회만 존재. 동작은 추정 (systemContext→system 블록 병합) |
| `mergeUserContext` 본문 정의 | **추출 누락** — 호출 1회만 존재. 동작은 추정 (userContext→messages 주입) |
| `resolveUserSystemPrompt` 본문 | 추출 truncate (return 부 누락) — 텔레메트리 전용은 호출 컨텍스트로 확인 |
| `zd8` 본문 후반(③④ 분할 상세) | splitter 가 `join("\n")` 개행에서 끊음 — 읽힌 ①②까지 확인, ③④는 `system-prompts.md` §3.4 교차로 추정 |
| `Kw`/`tD` 본문 + `X6` 메모이즈 + `sessionPromptInit` 1회 호출 | 확인 (line 8498, 21003) |
| `makeSystemReminderAttachment` attachment 시스템 + `s93`/`r93`/`makeAttachmentMessage` | 확인 (line 14251/14278/14331) |
| `flattenCompactionResult` 5-field 가 system 무관 | 확인 (line 14736) |
| `Xe`/`wV6` invalidation 사이트 (compact `sn`, worktree `JR_`) | 확인 |
| `dynamicBoundaryMarker` 가 API 미전송 | 확인 (`if(M===eo)continue`) |
| `oneHourCacheGate` 게이트 정의 | 확인 (line 5214: `CR()&&bT()&&(firstParty|anthropicAws)`) |
| `InstructionsLoaded` hook ↔ `Kw`(CLAUDE.md 로드) 연결 | **확인 필요** — 본 추출 범위에서 직접 호출 사이트 미발견 |
| `criticalSystemReminder_EXPERIMENTAL` 스키마 설명("system prompt") vs 구현(attachment) 불일치 | 확인 — 구현이 attachment (`s93`) |
