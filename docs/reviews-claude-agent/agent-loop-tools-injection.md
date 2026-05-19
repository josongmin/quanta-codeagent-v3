# Agent loop — 매 턴 API `tools` 배열 조립 (`runTurnLoop` → `callModelOuter`/`buildCreatePayload`)

`runTurnLoop` 메인 루프(`extracted-functions.js:14057`)가 `J.callModel(...)`를 부를 때 실제 `tools` 배열을 만드는 곳은 **`buildCreatePayload` payload builder가 아니라 그 enclosing 함수 `callModelOuter` (`extracted-functions.js:19054`)의 preamble**이다. 작업 지시서가 `buildCreatePayload`(line 19057)를 진입점으로 잡았으나, line 19057은 `callModelOuter` 본문의 한 줄(`function dH(){...} ... K_=(OH)=>{...}`)일 뿐이고 `buildCreatePayload` 화살표 함수는 closure 변수 `qH`(완성된 tool 스키마 배열)를 그대로 `tools:qH`로 꽂는다. tool 조립의 실로직은 `callModelOuter` 시작부(line 19054)에 모두 있다.

또한 지시서가 "`SH(...)` 직렬화"를 가정했으나, **`jsonStringify`(`extracted-functions.js:1998`)는 `JSON.stringify` 래퍼**(`function SH(H,_,q){using K=Sw\`JSON.stringify(...)\`;return JSON.stringify(H,_,q)}`)일 뿐이며 tool 스키마 직렬화기가 아니다. 도구→API 스키마 변환기는 **`serializeToolsApi`(`extracted-functions.js:18989`)**다. `jsonStringify`가 도구와 닿는 유일한 지점은 (a) 캐시 키 해시(`BB3`가 `SH(inputJSONSchema)`로 해시), (b) 텔레메트리 `tools:SH(qH)` 직렬화 두 군데뿐 — 확인.

---

## 1. 호출 그래프

```
Bq3 (turn loop, line 14057)
└─ J.callModel({ messages, systemPrompt, tools:Z.options.tools, thinkingConfig, signal,
                 options:{ model, fallbackModel, toolChoice:void 0,
                           agents:Z.options.agentDefinitions.activeAgents,
                           allowedAgentTypes:Z.options.agentDefinitions.allowedAgentTypes,
                           refreshTools, refreshMcpClients, hasPendingMcpServers,
                           extraToolSchemas, advisorModel, ... } })
   └─ DSK(H=messages, _, q=thinkingConfig, K=tools, O=signal, T=options)   (line 19054)
        │  ── preamble: tools 배열 qH 조립 ──
        ├─ v5("query_tool_schema_build_start")
        ├─ pP_(model, K=tools, getToolPermissionContext, agents, "query")   (line 14827)
        │     → D = ToolSearch 활성 여부 (boolean)
        │     ├─ KLH(model)        — 모델이 tool_reference 지원? (Sonnet4+/Opus4+)
        │     ├─ sVH(tools)        — ToolSearch 도구가 disallowedTools에 안 막혔나
        │     └─ iE8() mode: "tst" | "tst-auto"(P53 토큰 임계) | "standard"
        ├─ M = new Set();  for (OH of K) if (Xm(OH)) M.add(OH.name)         (line 8354)
        │     → M = "deferred 후보" 이름 집합
        ├─ if (D && M.size===0 && !T.hasPendingMcpServers) D=false
        ├─ f = (D)
        │     ? K.filter(t => !M.has(t.name) || P1(t,d$) || Pe(H).has(t.name))
        │     : K.filter(t => !P1(t,d$))                                    (deferred OFF시 ToolSearch만 제외)
        ├─ Pe(H)                                                            (line 14832)
        │     → 메시지 히스토리(+compact boundary)에서 발견된 tool_reference 이름 집합
        ├─ E = await Promise.all( f.map(t => Xj6(t, {getToolPermissionContext,
        │              tools:K, agents:T.agents, allowedAgentTypes:T.allowedAgentTypes,
        │              model:T.model, deferLoading:L(t)}) ))                 (line 18989)
        │     → 각 도구를 {name, description, input_schema, ...} API 스키마로
        ├─ v5("query_tool_schema_build_end")
        ├─ r = [...T.extraToolSchemas??[]];  if (J) r.push({type:"advisor_20260301",name:"advisor",model:J})
        ├─ let qH = [...E, ...r]            ← 최종 tools 배열 (closure)
        ├─ if (Pg()) Ti9({system:c, toolSchemas:qH필터(defer_loading제거), ...})  — prompt-cache prewarm
        └─ K_=(OH)=>({ model, messages:wU3(...), system:c, tools:qH,
                       tool_choice:T.toolChoice, ... })                      (line 19057 내 화살표)
              → RJ6(...) 안에서 K_(vq) 호출 → beta.messages.create({...,stream:true})
```

핵심 식별자:

| 식별자 | 위치 | 역할 |
|---|---|---|
| `callModelOuter` | 19054 | query streaming 함수 — tool 배열 조립 + 스트림 |
| `buildCreatePayload` | 19057 내부 화살표 | `messages.create` payload 빌더 (`tools:qH`, `tool_choice:T.toolChoice`) |
| `pP_` | 14827 | ToolSearch(deferred-loading) 활성 판정 |
| `tE` | 14821 | ToolSearch optimistic gate (env/host/model) |
| `Xm` | 8354 | 도구가 deferred 후보인가 (`isMcp` / `shouldDefer` …) |
| `P1` | 5745 | `tool.name===_ \|\| aliases.includes(_)` |
| `Pe` | 14832 | 메시지 히스토리에서 `tool_reference` 발견 도구 이름 추출 |
| `serializeToolsApi` | 18989 | 도구 → `{name,description,input_schema,...}` API 스키마 (memoized) |
| `mB3` | 18986 | description 텍스트 빌더 (`searchHint` 또는 `prompt(_)`) |
| `tJH` | 14812 | Zod → JSON Schema (`oB`, WeakMap memo) |
| `gj9`/`memoizeToolSchema` | 5227/5228 | `serializeToolsApi` 스키마 결과 Map 캐시 (`vl_`가 clear) |
| `BB3`/`bEK` | 18991/18999 | `inputJSONSchema` 해시 캐시 (`jsonStringify`=JSON.stringify) |
| `eB3` | 19043 | LSP 도구 pending → deferred 취급 |
| `Sj9` | 5211 | tool-search beta header 상수 선택 |
| `expandAttachments` | 15542 | 메시지 정규화 (tool_reference 매핑) — tools 배열 자체는 안 만듦 |
| `Y64` | 21062 | headless MCP prewait (`tengu_headless_mcp_prewait`) |
| `stainlessHelperHeader`/`stainlessHelperHeader` | 1931/1930 | `x-stainless-helper` 헤더 도구 목록 (API tools 아님) |
| `lookupTool`/`buildAliasMap` | 5747/5746 | 도구 lookup + alias map (로컬 전용) |

---

## 2. 핵심 로직

### 2.1 도구 조립 (`callModelOuter` preamble) — 확인

`Z.options.tools`(= caller가 넘긴 전체 도구 객체 배열, 인자 `K`)에서 출발한다.

1. **ToolSearch(deferred) 활성 판정** — `D = await pP_(model, K, getToolPermissionContext, agents, "query")`.
   - `tE()`(14821)가 optimistic gate: `iE8()` mode가 `standard`면 false; `ENABLE_TOOL_SEARCH` 미설정 + firstParty non-Anthropic host면 false; Vertex면 false.
   - `pP_`(14827)가 실판정: `KLH(model)`(tool_reference 지원 모델: Sonnet 4+/Opus 4+), `sVH(_)`(ToolSearch 도구가 `disallowedTools`로 안 막혔나), `iE8()` mode 분기 — `tst`면 무조건 활성, `tst-auto`면 `P53(...)`이 MCP 도구 토큰 수 임계 초과 시만 활성, `standard`면 비활성. 각 결정마다 `tengu_tool_search_mode_decision` emit.

2. **deferred 후보 집합** `M` — `for (OH of K) if (Xm(OH)) M.add(OH.name)`. `Xm`(8354):
   ```
   Xm(H): if H.alwaysLoad===true → false           // 항상 로드 강제
          if H.isMcp===true → true                 // 모든 MCP 도구는 deferred 후보
          if H.name===d$ (ToolSearch) → false
          if H.name===J7 (Agent): fork-subagent 활성이면 false
          if H.name===y85 → false; if H.name===h85 → false
          if H.name===az && aAH() → false           // (cron/TaskStop류, 추정)
          return H.shouldDefer===true               // 그 외엔 shouldDefer 플래그
   ```
   → MCP 도구 전부 + `shouldDefer:true` 도구(`TodoWrite`/`ToolSearch`-제외/`listMcpResources` 등)가 후보.

3. **`D && M.size===0 && !hasPendingMcpServers`** 이면 `D=false` ("deferred 도구가 없으니 ToolSearch 무의미"). 단 **`hasPendingMcpServers`가 true면 D를 유지** — 아직 안 붙은 MCP가 deferred로 들어올 수 있으므로 ToolSearch를 살려둔다 (확인).

4. **필터** `f`:
   - **deferred ON (`D`)**: `f = K.filter(t => !M.has(t.name) || P1(t,d$) || Pe(H).has(t.name))`
     - 즉 deferred 후보(`M`)는 **API tools 배열에서 제외**. 단 (a) ToolSearch 도구 자체(`P1(t,d$)`)는 유지, (b) **메시지 히스토리에 이미 `tool_reference`로 펼쳐진 이름**(`Pe(H)` 집합에 든 것)은 다시 포함.
   - **deferred OFF**: `f = K.filter(t => !P1(t,d$))` — ToolSearch 도구만 빼고 전부 그대로 보냄(deferred 개념 없음).

5. **스키마화** `E = await Promise.all(f.map(t => Xj6(t, opts)))` — 도구마다 `{name, description, input_schema, ...}` 생성. `deferLoading:L(t)`는 `L = (t)=> D && (M.has(t.name) || eB3(t))` — deferred 후보거나 LSP-pending이면 `defer_loading:true` 필드를 단다. (`f`엔 `Pe(H)`로 다시 들어온 도구가 있을 수 있는데, 그 경우도 `M.has` 면 `defer_loading`이 붙음 — 서버가 이미 펼친 도구를 인지하도록 신호하는 것으로 추정.)

6. **server tool / advisor 합류** `r = [...extraToolSchemas??[]]`; advisor 모델 `J` 있으면 `r.push({type:"advisor_20260301",name:"advisor",model:J})`. WebSearch의 `web_search_20250305` 등은 도구 자체 구현(`bH3()`)이 `extraToolSchemas`로 외부 주입되거나 도구의 `inputJSONSchema`에 들어온다 — `callModelOuter`에서 직접 push하는 server tool은 advisor뿐 (확인).

7. **최종** `let qH = [...E, ...r]`. 이 `qH`가 `buildCreatePayload`의 `tools:qH`로 그대로 전달. 순서는 **로컬 도구(필터된 순서 유지) → extraToolSchemas → advisor**.

### 2.2 `serializeToolsApi` — 도구 → API 스키마 (확인)

`extracted-functions.js:18989`:

```
Xj6(H, _):
  q=Jq(); K = _.model ? IB3(_.model) : undefined
  cache key $ = (L: prefix)+(F: prefix)+(inputJSONSchema ? `${H.name}:${BB3(H.inputJSONSchema)}` : H.name)
  z = gj9() (Fj9 Map)
  A = z.get($)
  if (!A) {
    J = ("inputJSONSchema" in H && H.inputJSONSchema) ? H.inputJSONSchema : tJH(H.inputSchema)  // Zod→JSONSchema
    if (!K7()) J = uB3(H.name, J)                       // 도구별 schema patch
    A = { name:H.name, description: await mB3(H,_), input_schema:J }
    if (pear gate && H.strict===true && model 지원) A.strict=true
    if (fine-grained-streaming 조건) A.eager_input_streaming=true
    z.set($, A)
  }
  Y = { name, description, input_schema, ...strict, ...eager_input_streaming }
  if (_.deferLoading) Y.defer_loading=true
  if (_.cacheControl) Y.cache_control=_.cacheControl
  if (DISABLE_EXPERIMENTAL_BETAS) → name/description/input_schema/cache_control만 남김
  return Y
```

확인 사항:
- **`description`은 `mB3(H,_)`**(18986): `qd8()`가 false면 `H.prompt(_)`(전체 prompt 텍스트)를 그대로 description으로. true면 `H.searchHint`(짧은 키워드 한 줄)를 description으로, 그리고 `prompt(_)`는 별도로 가져와 `m7(...)`로 합성(축약 모드). 즉 `serializeToolsApi`가 도구의 **`prompt`/`searchHint`를 호출**해 description 생성 — 확인.
- **`input_schema`는 `tJH(H.inputSchema)`** = Zod 스키마를 `oB(H)`로 JSON Schema 변환, `J_K` WeakMap 메모. MCP 도구는 `inputJSONSchema`(이미 JSON Schema)를 그대로 사용. 즉 도구의 `inputSchema` getter가 호출됨 — 확인.
- **`serializeToolsApi` 자체가 `gj9()`(Fj9 Map)로 메모이즈** — 같은 `(prefix+name+schemaHash)` 키면 `{name,description,input_schema}` 재사용. 단 `description=await mB3(...)`가 미스 시에만 실행되므로 **27개 도구를 매 턴 재직렬화하지 않는다**(첫 턴 빌드 후 캐시 히트). `vl_()`가 캐시 clear. `defer_loading`/`cache_control`은 캐시 후 매번 새로 덧붙여 per-turn 가변성 보존 — 확인.

### 2.3 ToolSearch within-loop 동작 (확인)

- `ToolSearch` 도구(`ToolSearch`, skill-system.md §2.3) `.call`이 결과로 `{type:"tool_reference", tool_name:X}` 블록 배열을 tool_result content에 넣는다.
- 다음 턴 `callModelOuter`가 `Pe(H)`(14832)로 **메시지 히스토리를 스캔**: `user` 메시지 content의 `tool_result`(`X53`) 안 `tool_reference`(`f53`) 블록에서 `tool_name`을 수집. 추가로 **compact boundary** 메시지의 `compactMetadata.preCompactDiscoveredTools`도 합산(compact를 거쳐도 펼쳐진 도구가 유지됨 — 확인).
- 그 이름들이 `f` 필터의 `Pe(H).has(t.name)` 조건으로 **deferred 후보였더라도 API tools 배열에 다시 포함**.
- 결론: **ToolSearch를 호출한 그 턴 안에서는 도구가 늘지 않고, 다음 턴(`Pe`가 히스토리를 본 뒤)에 펼쳐진다.** `refreshTools`로 펼치는 것이 아니라 메시지 히스토리 기반(`Pe`)으로 펼침 — 확인. `ToolSearch.call` 내부에서 `refreshTools?.()??tools`를 쓰는 것은 검색 대상 풀(특히 늦게 붙은 MCP)을 최신화하기 위함이지, API tools 배열을 그 턴에 바꾸기 위한 게 아님.
- 서버 측: 클라이언트는 `tool_reference`만 emit하면 API가 `tools` 파라미터에 X의 full def를 합성(`<functions>` 블록으로 system에 인라인). 단 위 `Pe` 경로는 클라이언트도 다음 턴부터 X의 full schema를 `qH`에 직접 넣어줌(서버·클라 양쪽 보강) — 확인.

### 2.4 `tool_choice` (확인)

- `buildCreatePayload`는 `tool_choice:T.toolChoice`를 그대로 꽂는다. `T.toolChoice`는 caller 옵션.
- **메인 루프(`runTurnLoop`, 14057)·subagent(15769)·기타(14749/18767) 모든 callModel 사이트가 `toolChoice:void 0`** — 즉 메인 에이전트 턴은 **항상 API default(auto)**, 강제 도구 없음. plan mode에서도 `toolChoice`를 바꾸지 않는다(plan은 permission `behavior:"ask"`로 차단; plan-mode.md와 일치) — 확인.
- 강제 `tool_choice:{type:"tool",name:NM_}`는 **auto-mode permission classifier**(`querySource:"auto_mode"`, line 12391, `tools:[ZQ5]`)에서만 — 별도 단발 모델 호출이며 `runTurnLoop` 턴 루프 밖. line 13682의 `type:"tool"`도 동류의 보조 호출. 즉 turn loop의 `tools` 배열과 무관 — 확인.

### 2.5 Agent definitions → tools

- `runTurnLoop`가 `agents:Z.options.agentDefinitions.activeAgents`, `allowedAgentTypes:Z.options.agentDefinitions.allowedAgentTypes`를 `callModel` 옵션으로 전달 (확인, line 14057 내).
- 이들은 **별도 도구로 노출되지 않는다.** `serializeToolsApi`의 `_.agents`/`_.allowedAgentTypes`는 `mB3→H.prompt(_)`로 흘러 들어가, `Agent` 도구(`Am7`, tool-interface.md §2.4-D)의 `prompt({agents,tools,allowedAgentTypes,model})`가 사용 가능한 subagent 정의를 **`Agent` 도구의 description/prompt 텍스트(및 input schema의 `subagent_type` 설명)**로 합성한다. 즉 subagent 타입은 별개 도구가 아니라 단일 `Agent` 도구 description 안에 enumerate — subagent-system.md와 일치, 확인.

### 2.6 MCP pending

- `hasPendingMcpServers`(= `zH.mcp.clients.some(c=>c.type==="pending")`)는 caller가 옵션으로 `callModelOuter`에 전달.
- 효과는 **§2.1-3 한 곳뿐**: `D && M.size===0 && !hasPendingMcpServers` → `D=false`. 즉 "지금은 deferred 도구가 0이지만 pending MCP가 있으니 ToolSearch는 살려둔다". `callModelOuter`는 MCP 연결을 **기다리지 않는다** (확인).
- 연결 안 된 MCP의 도구는 애초에 `Z.options.tools`(`K`)에 없으므로 자연 누락. 나중에 붙으면 `refreshTools()`로 `K`가 갱신되고 다음 턴 `qH`에 등장.
- headless/print 모드 한정으로 **부트 단계**(turn loop 진입 전)에서 `Y64`(21062)가 최대 `_=2000ms`까지 pending MCP를 폴링 대기하고 `tengu_headless_mcp_prewait` emit (확인). 이는 `runTurnLoop`/`callModelOuter` 내부 동작이 아니라 세션 셋업 단계. `remote_baku` 엔트리포인트면 `$2_(config)` 필터로 일부만 대기.

### 2.7 `refreshTools?.()` — `buildCreatePayload` 시점이 아닌 곳

- `buildCreatePayload`/`callModelOuter` 자체는 `refreshTools`를 **호출하지 않는다.** `callModelOuter`의 `tools`(인자 `K`)는 caller가 그 턴에 넘긴 스냅샷 그대로.
- `refreshTools?.()`는 (a) `runTurnLoop` 턴 끝에서 tool_result post-process 후 다음 턴 `dh`를 갱신할 때(message-queue.md / mcp-integration.md), (b) `ToolSearch.call` 내부에서 검색 풀 최신화 시 사용. mid-turn refresh 시 `i0([msg], 신/구tools, model)`로 MCP 도구 수 delta를 계산해 `tengu_mcp_tools_refreshed_mid_turn` emit (mcp-integration.md와 일치). `expandAttachments`(15542)는 메시지 정규화 + tool_reference 해소용이지 **tools 배열 자체를 만들지 않는다** — 확인.

### 2.8 `stainlessHelperHeader`/`stainlessHelperHeader` — `x-stainless-helper` (API tools 아님) — 확인

`rV6(H,_)`(1930): 메시지/도구에서 `IV_` 통과하는 항목의 `[CH_]` 키를 Set으로 모아 배열화. `bV_(H,_)`(1931): `stainlessHelperHeader` 결과를 `{"x-stainless-helper": q.join(", ")}` **HTTP 헤더**로 만든다. 이는 SDK BetaToolRunner가 어떤 helper 도구를 썼는지 Anthropic에 알리는 텔레메트리 헤더이며 **API request body의 `tools` 필드와 완전 별개** — 확인.

### 2.9 `lookupTool`/`buildAliasMap` alias — 로컬 lookup 전용 — 확인

`AC1(H)`(5746): 도구 배열 → `Map<name|alias, tool>` (이름과 모든 alias를 같은 도구로). `eK(H,_,q)`(5747): alias map(`GL9`/`RL9` 캐시) + `q` redirect 테이블로 이름/alias를 도구로 resolve. 이는 **tool_use 디스패치 시 이름→구현 찾기** 전용. API `tools` 배열엔 `serializeToolsApi`가 `H.name`만 emit하므로 **alias는 별도 도구로 전송되지 않고 로컬에서만 해소**된다(`Agent`의 `Task`="Task" alias도 API엔 `Agent` 하나만 — tool-interface.md와 일치) — 확인.

### 2.10 `toAutoClassifierInput` — API tools 배열 아님 — 확인

`serializeToolsApi`/`mB3`/`callModelOuter` 어디서도 `toAutoClassifierInput`을 호출하지 않는다. 이 메서드는 auto-mode permission classifier(`runAutoModeClassifier`, querySource `"auto_mode"`, §2.4의 강제 tool_choice 호출)가 **per tool-use 1회** 입력 문자열을 만들 때만 쓰임(permission-system.md). API `tools` 스키마와 무관 — 확인.

---

## 3. State / Schema

### 3.1 `qH` (API `tools` 배열) 원소 형태

각 원소는 `serializeToolsApi` 산출물:

```ts
type ApiToolSchema =
  | { name:string; description:string; input_schema:JSONSchema;
      strict?:true; eager_input_streaming?:true;
      defer_loading?:true; cache_control?:{...} }            // 로컬/MCP 도구
  | { type:"advisor_20260301"; name:"advisor"; model:string } // server-side advisor
  | (...extraToolSchemas 원소: web_search_20250305 등)          // 외부 주입 server tool
```

`DISABLE_EXPERIMENTAL_BETAS` env면 `{name,description,input_schema,cache_control}`로 축소(strict/eager/defer 제거) — 확인.

### 3.2 ToolSearch 결정 텔레메트리 (`tengu_tool_search_mode_decision`)

`pP_`의 `$(...)` 클로저가 emit: `{ enabled, mode("tst"|"tst-auto"|"standard"), reason("model_unsupported"|"mcp_search_unavailable"|"tst_enabled"|"auto_above_threshold"|"auto_below_threshold"|"standard_mode"), checkedModel, mcpToolCount, mcpNonBlocking, userType }` — 확인.

### 3.3 deferred 후보 판정 (`Xm`) 진리표 (확인)

| 조건 | 결과 |
|---|---|
| `alwaysLoad===true` | 후보 아님 (항상 풀로드) |
| `isMcp===true` | **후보** (모든 MCP 도구) |
| `name===ToolSearch(d$)` | 후보 아님 |
| `name===Agent(J7)` & fork-subagent 활성 | 후보 아님 |
| `name===y85` 또는 `h85` | 후보 아님 |
| `name===az` & `aAH()` | 후보 아님 |
| 그 외 | `shouldDefer===true` 이면 후보 |

### 3.4 `Pe(H)` 입력 — 발견된 tool_reference

- 소스 1: `system`+`subtype:"compact_boundary"` 메시지의 `compactMetadata.preCompactDiscoveredTools` (compact 전 펼쳐졌던 이름들).
- 소스 2: `user` 메시지 content의 `tool_result`(`X53`) → 그 안 `tool_reference`(`f53`) 블록의 `tool_name`.
- 로그: `"Dynamic tool loading: found N discovered tools in message history (M carried from compact boundary)"`.

### 3.5 prompt cache 관계 (`Ti9`, `Pg()`)

`Pg()`(prefetch/prewarm gate)면 `Ti9({system:c, toolSchemas: qH.filter(t=>!t.defer_loading), querySource, model, agentId, ...})` 호출 — **`defer_loading` 도구를 제외한 tool 스키마 + system을 prompt-cache prefix로 미리 warm**. tools는 캐시 prefix의 일부이므로 `qH`가 턴마다 동일해야 캐시 히트(§2.2의 `serializeToolsApi` 메모가 이를 안정화). deferred 도구가 들고나면 prefix가 바뀌어 cache miss — `defer_loading` 제외로 변동을 격리 — 확인/추정 혼재(제외 이유는 추정).

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| tools 배열 생성 위치 | `getTools()` 단순 필터 후 SDK가 Zod→schema | `callModelOuter` preamble (`pP_`→`Xm`→`f` 필터→`serializeToolsApi` map→`+extra+advisor`) |
| 직렬화기 | SDK 내부 zodToJsonSchema | `serializeToolsApi`(18989) — `memoizeToolSchema` Map 메모 + `tJH`(Zod→JSON, WeakMap) + `mB3`(prompt/searchHint) |
| deferred tools | 없음 | `Xm` 후보 → API 배열에서 제외, `ToolSearch`+`Pe(히스토리)`로 재포함, `defer_loading` 플래그 |
| ToolSearch gate | 없음 | `tE`(env/host/model) + `pP_`(`KLH`/`sVH`/`iE8` tst·tst-auto·standard) |
| MCP pending | 없음 | `hasPendingMcpServers`로 ToolSearch 유지, 부트 `Y64` prewait(headless) |
| tool_choice | (auto 고정) | turn loop 전부 `void 0`, 강제는 auto-mode classifier 단발 호출만 |
| Agent 정의 | AgentTool description 정적 | `agents/allowedAgentTypes` → `Agent.prompt()`가 동적 합성, 별도 도구 아님 |
| server tool | 없음 | `advisor_20260301`(DSK push) + `extraToolSchemas`(web_search_20250305 등), 같은 `tools` 배열 |
| 스키마 캐싱 | 없음 | `memoizeToolSchema`/`bEK` 캐시로 27도구 매턴 재직렬화 회피, prompt-cache prefix 안정화 |
| alias | 별도 노출 가능 | `lookupTool`/`buildAliasMap` 로컬 lookup만, API엔 `name` 하나 |
| helper 헤더 | 없음 | `stainlessHelperHeader`/`stainlessHelperHeader` `x-stainless-helper` (body tools와 별개) |

### 추정 / 확인 필요

- **확인**: `buildCreatePayload`는 `tools:qH`를 그대로 꽂기만 함. tool 조립은 `callModelOuter` preamble. `jsonStringify`=`JSON.stringify`(직렬화기 아님), 실직렬화기는 `serializeToolsApi`.
- **확인**: turn loop의 모든 callModel이 `toolChoice:void 0` (강제 도구 없음).
- **확인**: ToolSearch는 같은 턴이 아니라 **다음 턴**에 `Pe(H)`(메시지 히스토리)로 펼쳐짐. `refreshTools`로 펼치는 게 아님.
- **확인**: `hasPendingMcpServers`는 ToolSearch 비활성화를 막는 한 곳에만 영향, 루프는 MCP를 안 기다림(prewait는 부트 단계 `Y64`).
- **추정**: `Pe(H)`로 다시 포함된 도구에 `L(t)`로 `defer_loading:true`가 여전히 붙는 케이스 — 서버가 "이미 펼쳐졌음"을 인지하도록 한 신호로 보이나 서버 측 해석 미확인.
- **추정**: `Ti9`가 `defer_loading` 도구를 prewarm에서 제외하는 이유(cache prefix 안정화)는 합리적 해석이나 명시 주석 없음.
- **추정**: `Xm`의 `y85`/`h85`/`az`(+`aAH()`) — 각각 특정 내장 도구(예: TaskOutput/TaskStop/cron Wakeup류) 강제-풀로드 예외로 보이나 상수 미해석. 0-overview의 `PowerShell계열`/`az` 매핑과 교차검증 필요.
- **추정**: `extraToolSchemas`로 들어오는 server tool(web_search 등)의 정확한 주입 경로는 caller 옵션 — `callModelOuter`는 advisor만 직접 push.
