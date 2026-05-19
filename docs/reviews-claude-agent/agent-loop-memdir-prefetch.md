# Agent loop — `startMemdirPrefetch` memdir prefetch (`using P` 자원)

Claude Code v2.1.143의 turn loop `runTurnLoop` (`extracted-functions.js:14057`) 가 매 호출 시작점에서 켜는 **auto-memory 디렉토리 사전조회** 메커니즘. 사용자 질문이 들어오자마자 백그라운드 LLM 호출(selector / synthesizer)을 띄워 관련 memory 파일을 미리 골라두고, 첫 도구 사이클이 끝난 직후 attachment 로 모델에 주입한다. ES2026 `using` 키워드로 자원 lifecycle 을 묶었기 때문에 `runTurnLoop` 가 어떤 reason 으로 종료되든 abort + 텔레메트리 flush 가 보장된다.

식별자: 모듈 표기는 백틱, 인용 위치는 `extracted-functions.js:LINE`. 확인되지 않은 부분은 "추정" 으로 표기.

연관 시스템:
- [agent-loop.md](agent-loop.md) — turn loop 본체와 `using P = ga7(...)` 위치
- [skill-system.md](skill-system.md) — 같은 자리에서 시작되는 `startSkillDiscoveryPrefetch` (다른 lifecycle)
- [tool-use-context.md](tool-use-context.md) — `memorySelector` / `nestedMemoryAttachmentTriggers` 필드

---

## 1. 호출 그래프

### 1.1 진입 — `runTurnLoop` turn-start

```
Bq3(H, _)                                              # line 14057
├─ X = ya7()                                           # gates 스냅샷
└─ using P = ga7(D.messages, D.toolUseContext, z)      # ★ 사전조회 시작
   │   z === querySource ("repl_main_thread" 등)
   │
   ├─ guards (모두 통과해야 prefetch 실행)
   │   ├─ _.memorySelector  truthy
   │   ├─ !_.agentId        (main thread only)
   │   ├─ b4()              (자동 메모리 켜져 있음)
   │   ├─ Z_("tengu_moth_copse", false)   (Statsig gate)
   │   ├─ J73.has(q) === false             (querySource exclude set)
   │   ├─ findLast user message 가 존재   (isMeta 아님)
   │   ├─ Nb(O)  본문이 공백 포함 (단어 2개 이상)
   │   └─ w73(H).totalBytes < MAX_SESSION_BYTES   (=61440)
   │
   ├─ z = ev(_.abortController)            # child AbortController (부모 abort 전파)
   ├─ A = Date.now()
   └─ Y = Y73(T, agentDefs, K, readFileState, z.signal, $.paths)
            .catch(...)
```

### 1.2 사전조회 본체 `Y73` ([`extracted-functions.js:14301`](../../extracted-functions.js#L14301))

```
Y73(userText, activeAgents, memorySelector, readFileState, signal, paths)
├─ It7(userText)                            # @agent-X 멘션 추출 (regex)
├─ for each agentMention:
│      ZpH(agentType, agentDef.memory)      # project|local|user 별 memory dir 경로
├─ z = mentions.length > 0 ? mentions : [U$()]   # 기본 auto-memory dir
│
└─ if (dw())                                # = Z_("tengu_billiard_aviary",false)
        SYNTHESIZE 모드:
        ├─ for each dir: E77(text, dir, memorySelector, signal)
        │    └─ VA8 (cached state) ?? dY_(dir) → NA8 (set state)
        │           └─ fz5(text, dir, memorySelector, msgs, byFilename, cache, signal)
        │                └─ Fg(model=ok(), system=Jz5, ..., querySource=kA8)
        │                  ↓
        │              { synthesis: string, citedMemories: string[] }
        ├─ jH6(uf.join(dir, citedFile))     # no-op tracking 훅
        └─ 결과: [{type:"relevant_memories", memories:[{path:"<synthesis:DIR>", content:`${synth}\nMemory: ...:`, ...}], ...}]
   else
        SELECT 모드:
        ├─ selectRelevantMemories(text, dir, memorySelector, signal)
        │   └─ Fg(model=ok(), system=Jz5, messages=multi-turn cache, output_format=json_schema)
        │       → { selected_memories: string[] }   # 파일명 배열
        └─ 결과: [{type:"relevant_memories", memories:[{path, content, mtimeMs, limit?, ...}], ...}]
```

`dw()` (`extracted-functions.js:5662`) — `tengu_billiard_aviary` gate. ON 이면 **synthesize 모드** (여러 tiny memory 를 Sonnet 으로 한 단락 압축), OFF 면 **select 모드** (LLM 이 파일 이름들을 골라 본문 그대로 반환).

### 1.3 ga7 의 반환 객체 ([`extracted-functions.js:14303`](../../extracted-functions.js#L14303))

```js
let w = {
  promise: Y,                       // Promise<MemDirResult[]>
  settledAt: null,                  // settle 직후 Date.now() 로 설정
  consumedOnIteration: -1,          // -1 = 아직 소비 안 함
  [Symbol.dispose]() {              // using 으로 자동 호출
    z.abort()                       // child AbortController 종료
    let j = K.lastUsage              // selector 가 마지막에 쓴 토큰 stats
    d("tengu_memdir_prefetch_collected", {
      hidden_by_first_iteration: w.settledAt !== null && w.consumedOnIteration === 0,
      consumed_on_iteration:     w.consumedOnIteration,
      latency_ms:                (w.settledAt ?? Date.now()) - A,
      cache_read_input_tokens:   j?.cacheReadInputTokens,
      cache_creation_input_tokens: j?.cacheCreationInputTokens,
      selector_turn_count:       j?.turnCount
    })
  }
}
Y.finally(() => { w.settledAt = Date.now() })
return w
```

### 1.4 Bq3 안의 소비 지점 ([`extracted-functions.js:14057`](../../extracted-functions.js#L14057) chunk 19400)

매 iteration 의 후반부 — tool 실행 끝나고 message queue 처리 직후, refresh-tools 직전:

```js
if (P && P.settledAt !== null && P.consumedOnIteration === -1) {
  let T_ = Qa7(await P.promise, Z.readFileState)
  for (let H_ of T_) {
    let G_ = T9(H_)                  // {attachment:H_, type:"attachment", uuid, timestamp}
    yield G_
    JH.push(G_)                      // collectedToolResults
  }
  P.consumedOnIteration = C - 1     // C = turnCount, 이전 iter index 로 기록
}
if (Uy8 && m) {                      // skill discovery prefetch (자매 메커니즘)
  ...
}
```

핵심 특징:
- **non-blocking 가드**: `settledAt !== null` — promise 가 이미 settle 됐을 때만 소비. settle 안 됐으면 이번 턴 패스, 다음 턴에 다시 검사.
- **단발성**: `consumedOnIteration === -1` 가드로 `runTurnLoop` 한 호출 lifetime 동안 정확히 한 번만 inject.
- **위치**: tool 실행 (`dispatchToolBatch`/`StreamingToolExecutor`) **AFTER**, 다음 `callModel` **BEFORE**. 즉 사용자 첫 응답을 모델이 듣고 도구를 부른 직후, 그 도구 결과와 함께 모델에게 attachment 로 합쳐서 보낸다.

### 1.5 `transformMemdirResults` 변환 ([`extracted-functions.js:14306`](../../extracted-functions.js#L14306))

```js
function Qa7(H, _) {                  // H = MemDirResult[], _ = readFileState Map
  return H.map((q) => {
    if (q.type !== "relevant_memories") return q
    let K = q.memories.filter((O) => !_.has(O.path))
    for (let O of K)
      _.set(O.path, {
        content: O.content,
        timestamp: O.mtimeMs,
        offset: void 0,
        limit: O.limit
      })
    return K.length > 0 ? {...q, memories: K} : null
  }).filter((q) => q !== null)
}
```

- `readFileState` 에 이미 등록된 memory 파일은 제외 — 같은 세션 내에서 중복 inject 방지.
- 새 항목은 즉시 `readFileState` 에 등록되어 이후 Read 도구가 같은 파일을 다시 읽지 않게 (`{offset:undefined, limit:O.limit}` 형태로 — Read 가 본문을 memdir 출처에서 가져왔다고 인식).
- 모든 항목이 이미 본 거면 그 attachment 는 통째로 drop.
- `relevant_memories` 외 타입은 통과 (현재는 Y73 가 그 한 타입만 emit 하지만 union 형태로 둠).

---

## 2. 핵심 로직

### 2.1 guards 평가 — querySource 제외 목록

`J73` ([`extracted-functions.js:14352`](../../extracted-functions.js#L14352)):

```js
J73 = new Set([
  "extract_memories",
  "auto_dream",
  "prompt_suggestion",
  "speculation",
  "compact"
])
```

이 querySource 들은 자기 자신이 백그라운드 LLM 작업이거나(compact, extract_memories), 모델 turn 의 본류가 아니거나(prompt_suggestion, speculation), recursion 방지(auto_dream) 이유로 prefetch 를 스킵. `repl_main_thread` 와 `agent:*` (주 thread), `query`, `prompt` 등은 통과.

확인 — task 설명의 "auxiliary 모드" 와는 다른 이름. `J73` 가 실제 차단 목록.

### 2.2 `b4()` — auto-memory 활성 검사 ([`extracted-functions.js:5657`](../../extracted-functions.js#L5657))

```js
function b4() {
  if (gd()) return false                                  // 무언가 disable 모드
  let H = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (xH(H)) return false                                  // 명시적 disable
  if (EK(H)) return true                                   // 명시적 enable
  if (xH(process.env.CLAUDE_CODE_SIMPLE)) return false    // simple mode → off
  if (xH(process.env.CLAUDE_CODE_REMOTE) &&
      !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) return false   // remote 면 dir override 필요
  if (mi_()) return false
  let _ = C8()                                             // 설정 객체
  if (_.autoMemoryEnabled !== void 0) return _.autoMemoryEnabled
  return true                                              // 기본 on
}
```

→ "auth" 보다는 **feature-flag 체인**. env / settings.json / 빌드 모드를 모두 합쳐 결정.

### 2.3 `Nb(message)` — 본문 텍스트 추출

`findLast((j) => j.type==="user" && !j.isMeta)` 로 가장 최근 진짜 사용자 메시지를 잡고, `Nb(O)` 로 텍스트만 뽑아낸 뒤 `/\s/.test(text.trim())` 검사. 즉 단어 한 개짜리 ("ls", "/help", "y") 짧은 입력은 prefetch 안 함 — recall 가치가 낮고 노이즈를 키우기 때문. 확인.

`Nb` 자체는 모듈 임포트 식별자 — `function Nb` 정의는 안 보이고 호출만 다수 — content-extraction utility (`message.message.content` 의 text 블록을 합쳐 string 반환). 추정.

### 2.4 `w73(messages)` — session-bytes / paths 계산

`w73(H)` 는 유일 호출 사이트가 ga7 안 (`extracted-functions.js:10255334`). 반환 `{totalBytes, paths}`:
- `totalBytes` — `MAX_SESSION_BYTES = 61440` (60 KiB) 와 비교. 세션이 너무 길어지면 prefetch 안 함 (이미 모델이 충분한 컨텍스트를 가지고 있으므로 비용 대비 효과 낮음, 추정).
- `paths` — `Y73` 에 전달되어 selector LLM 이 "이미 본 파일들" 을 알게끔 메타로 같이 보냄. 추정.

`w73` 의 본체는 minified 식별자만 노출되고 정의 라인을 못 찾음 — Bun lazy-init 으로 가려진 모듈 export. 동작은 호출 사이트와 시그니처로 추론.

### 2.5 `ev(parentAbortController)` ([`extracted-functions.js:8159`](../../extracted-functions.js#L8159))

```js
function ev(H, _) {
  let q = xK(_)                                  // new AbortController
  if (H.signal.aborted) return q.abort(H.signal.reason), q
  let K = new WeakRef(q), O = new WeakRef(H), T = H65.bind(O, K)
  H.signal.addEventListener("abort", T, {once: true})       // parent → child
  q.signal.addEventListener("abort", _65.bind(O, new WeakRef(T)), {once: true})  // listener cleanup
  return q
}
```

→ 부모 abort 시 child 도 abort, child 자체 abort 시 부모 리스너 떼기. `using P` dispose 가 `z.abort()` 부르면 자식 controller 만 끊겨서 ga7 의 background `Fg(...)` LLM 호출도 같이 abort. WeakRef 로 GC 친화적.

### 2.6 Selector 의 LLM 본체 — `selectRelevantMemories`

`extracted-functions.js:9610` 근처:

```js
async function selectRelevantMemories(text, dir, memorySelector, signal) {
  ...
  let A = await Fg({
    model: ok(),                          // = Haiku 4.5 (작고 빠른 모델)
    system: [{type:"text", text: Jz5, cache_control:{type:"ephemeral"}}],
    skipSystemPromptPrefix: true,
    messages: [
      ...K,                                // 이전 턴 stateByDir.get(dir).messages
      {role:"user", content:[{type:"text", text:z /*=prompt*/, cache_control:{type:"ephemeral"}}]}
    ],
    max_tokens: 256,
    output_format: {
      type: "json_schema",
      schema: { type:"object",
                properties:{selected_memories:{type:"array",items:{type:"string"}}},
                required:["selected_memories"], additionalProperties:false }
    },
    signal: $,
    querySource: kA8                     // 별도 querySource (telemetry attribution)
  })
  ...
  memorySelector.lastUsage = {
    cacheReadInputTokens, cacheCreationInputTokens, turnCount: (K.length+1)/2
  }
  EH("memory_recall_select")              // OTel "success" 마커
  return w.selected_memories.filter((name) => O.has(name))   // 실재 파일명만
}
```

핵심 디자인:
- **빠른 모델**: `ok()` → Haiku, 본 모델과 병렬 실행해도 비용 작음.
- **multi-turn cache 재사용**: `memorySelector.stateByDir.get(dir)` 에 이전 selector 호출의 message 시퀀스를 보관 → `cache_control:"ephemeral"` 로 prompt cache hit. 같은 dir 을 매 턴 다시 부르되 메모리 목록은 한 번만 캐시.
- **JSON schema strict output**: `selected_memories: string[]` 만 받음.
- **fail-soft**: 예외 발생 시 `lastUsage = null`, `[]` 반환. ga7 가 catch 에서 추가로 squash.

`Jz5` — selector system prompt. 추출본의 별도 큰 문자열 상수. 확인 필요 — 모델에게 "다음 사용자 질문에 관련된 memory 파일명을 고르라" 명령.

### 2.7 Synthesize 모드 — `fz5` / `E77`

`E77` ([`extracted-functions.js:9612`](../../extracted-functions.js#L9612)):

```js
async function E77(text, dir, memorySelector, signal) {
  memorySelector.lastUsage = null
  let cacheCtl = {type:"ephemeral"}
  let state = VA8(memorySelector, dir)        // = stateByDir.get(dir)
        ?? await dY_(dir, signal).then(scan => {
             return scan.length > 0 && !signal.aborted
               ? NA8(memorySelector, dir, scan, cY_(scan), cacheCtl)  // 새 state
               : void 0
           })
  if (!state) return null
  return fz5(text, dir, memorySelector, state.messages, state.byFilename, cacheCtl, signal)
}
```

`dY_` ([`extracted-functions.js:9608`](../../extracted-functions.js#L9608)) — 디스크 스캔:
- `readdir(H, {recursive:true})` 모든 `.md` (단 `MEMORY.md` 제외)
- 각 파일 frontmatter 파싱 (`DpH`): `description`, `created`, `last_read`, `type` 메타 추출
- synthesize 모드면 본문도 trim 해서 보관 (`Az5` 한도 — 상수, slice).
- mtime 으로 정렬, 상위 N 개 (`Az5`=synthesize, `zz5`=select) 만 반환.
- 에러시 빈 배열 + `M6("memory_scan", "memory_scan_readdir_failed")` OTel error.

`fz5` (`extracted-functions.js:9614`) 의 본체는 `let z = \`Extract facts relevant to:\n${H}\`` 로 시작. Sonnet 에게 "이 메모리 인덱스 + 본문에서 사용자 질문 ${H} 와 관련된 사실들을 한 단락으로 합쳐줘" 시킴. 출력 `{synthesis: string, citedMemories: string[]}`. 확인 — `Y73` 가 그걸 그대로 받아 `<synthesis:DIR>` 가짜 path 로 포장.

### 2.8 attachment 의 최종 모양

`relevant_memories` attachment 의 페이로드 ([`extracted-functions.js:9615`](../../extracted-functions.js#L9615) Zod 스키마 `wY5` 와 [`extracted-functions.js:14306`](../../extracted-functions.js#L14306) `transformMemdirResults` 변환):

```ts
{
  type: "relevant_memories",
  memories: Array<{
    path: string,            // 실제 파일 경로 OR "<synthesis:DIR>" 가짜 경로
    scope: "personal" | "team",
    content?: string,        // synthesize 모드에서만 본문 포함;
                             // select 모드는 path 만 (consumer 가 lazy load)
    mtimeMs: number,
    limit?: number
  }>,
  // CLI 만의 추가 필드 ↓ (SDK 미러는 path/scope/content 만)
  ...
}
```

`T9(attachment)` 가 감싸서 yield:
```ts
{ type:"attachment", attachment, uuid: yt7.randomUUID(), timestamp: new Date().toISOString() }
```

REPL 렌더러 (`Ub7` / `Bb7`) 는 이 attachment 를 보고:
- 본문 (`scope==="personal" → "Recalled from memory"` 표시),
- synthesize 모드(`uc5 = /^<synthesis:(.+)>$/` 매칭) → 단락 그대로 출력
- select 모드 → 파일명 리스트 출력, path 클릭하면 본문 표시

`b_4(memories)` ([`extracted-functions.js:21007`](../../extracted-functions.js#L21007)) 가 SDK 출력으로 변환 — `{type:"system", subtype:"memory_recall", mode:"select"|"synthesize", memories:[...]}` 이벤트 emit.

### 2.9 `[[name]]` 크로스링크 — 쓰기 측만 정의

`B98` ([`extracted-functions.js:5795`](../../extracted-functions.js#L5795)):

```js
B98 = [
  "In the body, link to related memories with `[[name]]`, where `name` is " +
  "the other memory's `name:` slug. Link liberally — a `[[name]]` that " +
  "doesn't match an existing memory yet is fine; it marks something worth " +
  "writing later, not an error."
]
```

`Yr_(types)` (`extracted-functions.js:5795` 근처) 가 **memory 작성 템플릿**:
```
\`\`\`markdown
---
name: {{short-kebab-case-slug}}
description: ...
metadata:
  type: {{user|feedback|project|reference}}
---

{{... [[their-name]] ...}}
\`\`\`
```

- `cC1(name)`: `[a-z0-9_-]+` 이외 문자를 `-` 로 치환해 slug 화.
- 본문에 `[[name]]` 작성을 모델에게 권장.

**읽기 측 자동 해소 코드는 추출본에 안 보임**:
- `[[name]]` regex parse 가 `Y73` / `selectRelevantMemories` / `fz5` / `dY_` 경로 어디에도 없음.
- `jH6(filepath)` 는 `$l9 = async () => {}` 빈 함수 (`extracted-functions.js:8180`) — 텔레메트리/observability 자리만 남고 실제 동작 없음.
- "broken-wikilink" 문자열은 **plugin loader** 의 wikilink 검증이지 memdir 이 아님.

→ **확인된 동작**: `[[name]]` 은 markdown 컨벤션. 모델이 memory 본문에서 `[[name]]` 을 보면 다음 턴에 (또는 자기 결정으로) 그 이름의 memory 파일을 Read 도구로 직접 읽는다. CLI 코드가 자동으로 따라가서 inject 하지는 않는다. 추정으로는 selector LLM 이 본문의 `[[X]]` 를 보고 X 도 같이 `selected_memories` 에 포함시켜 효과를 내는 수준.

---

## 3. State / Schema

### 3.1 `memorySelector` 객체 ([`extracted-functions.js:8517`](../../extracted-functions.js#L8517))

```ts
type MemorySelector = {
  stateByDir: Map<string /*dir path*/, {
    memories: MemoryFileMeta[],          // dY_ 가 스캔한 파일 메타
    byFilename: Map<string, MemoryFileMeta>,
    messages: ApiMessage[]                // selector 와의 다중-턴 대화 누적 (cache 재사용)
  }>,
  lastUsage: null | {
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
    turnCount: number                     // (messages.length+1)/2
  }
}
```

`jYH()` 가 `{stateByDir:new Map, lastUsage:null}` 빈 인스턴스 생성. `BGH(memorySelector)` 가 reset (clear).

ToolUseContext 빌더 `forkToolUseContext` ([`extracted-functions.js:9845`](../../extracted-functions.js#L9845)) 가 **매 fork 마다 새로**:
```js
memorySelector: jYH()
```
→ subagent / 새 turn loop 호출 마다 selector state 초기화. 부모로부터 상속하지 않음.

### 3.2 ga7 가 반환하는 핸들

```ts
type MemdirPrefetchHandle = {
  promise: Promise<MemDirResult[]>,
  settledAt: number | null,                    // Date.now() | null
  consumedOnIteration: number,                 // -1 = 미소비
  abort: () => void,                            // = z.abort (child controller)
  [Symbol.dispose](): void                      // using 시 자동 호출
}
```

`abort` 는 코드상 명시적 프로퍼티가 아니라 `[Symbol.dispose]` 안의 `z.abort()` 호출로만 노출. caller 가 dispose 외 다른 시점에 강제 abort 하고 싶으면 `z`(child controller) 를 잡지 못해서 못 함 — using 패턴이라 의도된 설계. 확인.

### 3.3 telemetry 이벤트 `tengu_memdir_prefetch_collected`

`[Symbol.dispose]()` 가 `runTurnLoop` 종료 시점에 정확히 한 번 emit:

```js
d("tengu_memdir_prefetch_collected", {
  hidden_by_first_iteration:    settledAt !== null && consumedOnIteration === 0,
  consumed_on_iteration:        consumedOnIteration,    // -1 | 1 | 2 | ...
  latency_ms:                   (settledAt ?? Date.now()) - A,
  cache_read_input_tokens:      lastUsage?.cacheReadInputTokens,
  cache_creation_input_tokens:  lastUsage?.cacheCreationInputTokens,
  selector_turn_count:          lastUsage?.turnCount
})
```

필드 의미:
- `hidden_by_first_iteration` — promise 가 settle 됐지만 첫 iteration (`C===1`, 즉 `consumedOnIteration === C-1 === 0`) 에 소비됐다는 뜻. UI 상 사용자에게 "도구 결과 + memory" 가 한 묶음으로 보여서 memory 영향이 안 보일 수 있음을 server-side 가 알 수 있게.
- `consumed_on_iteration` — `-1` 이면 아예 소비 안 됨 (settle 못 했거나 모델이 첫 응답에 도구를 안 부르고 끝).
- `latency_ms` — ga7 호출 시점부터 settle (혹은 dispose) 까지 걸린 시간. selector LLM 호출 시간 + 디스크 스캔.
- `cache_*_input_tokens` — selector LLM 의 마지막 호출 token usage. 캐시 효과 측정용.
- `selector_turn_count` — selector LLM 과의 multi-turn 대화에서 몇 번째 turn 이었는지 (`stateByDir` 재사용 누적).

**다른 이름의 이벤트 (`tengu_memdir_prefetch_started` / `_skipped`) 는 추출본에 없음**. ga7 의 prefetch 단계에서는 단일 이벤트만 emit. 확인.

`memory_recall_select` / `memory_recall_select_query_failed` OTel 이벤트 (selector LLM 성공/실패 마커) 는 별도 OTEL 채널 — `EH(...)` / `M6(...)` 호출.

### 3.4 querySource exclude 셋 `J73`

```js
J73 = new Set([
  "extract_memories",   // memory 발견을 위한 background 작업 자체
  "auto_dream",         // dream proposal pipeline
  "prompt_suggestion",  // 다음 prompt 예측 - 가벼운 query
  "speculation",        // speculative decoding 류
  "compact"             // compaction 자체
])
```

`runTurnLoop` 가 받는 일반 querySource 들 (`repl_main_thread`, `agent:custom`, `agent:general-purpose`, `query`, ...) 은 통과. 확인.

### 3.5 상수 `m93.MAX_SESSION_BYTES = 61440`

`extracted-functions.js:14352`:

```js
m93 = { MAX_SESSION_BYTES: 61440 }      // 60 KiB
```

ga7 가 `w73(messages).totalBytes >= 61440` 이면 즉시 return — 세션이 길어졌으면 prefetch skip. 확인.

`Rw6` / `Vt7` / `Nt7` 같은 다른 const 들은 todo-reminder / agent-listing 의 turn-가격 임계치, 무관.

### 3.6 ToolUseContext 의 memory 관련 필드 ([`extracted-functions.js:9845`](../../extracted-functions.js#L9845))

```ts
interface ToolUseContext {
  ...
  readFileState:                  Map<path, FileReadCache>,    // 매 ctx 새로
  nestedMemoryAttachmentTriggers: Set<string>,                  // Read 도구가 push, A73 가 consume+clear
  loadedNestedMemoryPaths:        Set<string>,                  // 이미 inject 된 nested memory 파일 path
  memorySelector:                 MemorySelector,                // jYH() 새 instance
  dynamicSkillDirTriggers:        Set<string>,                  // skill 시스템 (별개)
  discoveredSkillNames:           Set<string>,
  discoveredRemoteSkills:         Map<string, ...>,
  ...
}
```

### 3.7 `nestedMemoryAttachmentTriggers` ↔ `loadedNestedMemoryPaths` ↔ `A73` 의 별도 lifecycle

memdir prefetch 와 **다른 시스템**:

- **Trigger 등록**: Read 도구 (`extracted-functions.js:14725` 부근) 가 어떤 파일이든 읽으면:
  ```js
  w.nestedMemoryAttachmentTriggers?.add(normalizedPath)
  ```
  pdf/image/notebook/text 모두 동일. 확인.

- **Consume**: `A73` ([`extracted-functions.js:14299`](../../extracted-functions.js#L14299)) — `makeSystemReminderAttachment` attachment builder (`extracted-functions.js:14251`) 가 `o$("nested_memory", () => A73(w))` 로 매 턴 호출:
  ```js
  function A73(H) {
    if (!H.nestedMemoryAttachmentTriggers ||
        H.nestedMemoryAttachmentTriggers.size === 0) return []
    let _ = H.getToolPermissionContext()
    let q = []
    for (let K of H.nestedMemoryAttachmentTriggers) {
      let O = await St7(K, H, {toolPermissionContext:_})   // K 주변에 .claude/CLAUDE.md 등 nested memory 검색
      q.push(...O)
    }
    H.nestedMemoryAttachmentTriggers.clear()
    return q
  }
  ```
  `St7` 가 읽힌 파일 주변의 `CLAUDE.md` / `.claude/CLAUDE.md` 같은 nested memory 파일을 찾아 `Project|Local|User|Managed` 메모리 attachment 로 반환. 매 턴 끝에 trigger set 은 비워짐 — 다음 턴 새로 등록 받음.

- **Dedup**: `loadedNestedMemoryPaths: Set<string>` 가 이미 inject 한 nested memory path 를 기억해서 동일 파일 재주입 막음. 추정 — `St7` 안에서 `loadedNestedMemoryPaths` 를 검사하는 부분이 직접 보이진 않으나 ED8 ctx 빌더가 빈 Set 으로 초기화한다는 점에서 그 용도.

→ **memdir prefetch (`startMemdirPrefetch`) vs nested memory (`A73`)** 정리:

| 측면 | `startMemdirPrefetch` memdir prefetch | `A73` nested memory |
|---|---|---|
| 트리거 | turn 시작 (`using P = ga7(...)`) | 매 턴 attachment 빌드 (`makeSystemReminderAttachment`) |
| 입력 | 사용자 마지막 message 텍스트 | `nestedMemoryAttachmentTriggers` (Read 도구가 push) |
| 백엔드 | Selector / Synthesizer LLM 호출 (Haiku / Sonnet) | 디스크 스캔 (`St7` + `MA8`/`fA8`/`XA8`) |
| 출력 attachment 타입 | `relevant_memories` (LLM 가 고른 memory) | `nestedMemoryFile` 류 (Read 인접 CLAUDE.md) |
| State 키 | `memorySelector.stateByDir` (multi-turn cache) | `nestedMemoryAttachmentTriggers` / `loadedNestedMemoryPaths` |
| Lifecycle | `using` (Bq3 종료 시 dispose) | 매 턴 consume+clear |
| Statsig gate | `tengu_moth_copse` | `tengu_paper_halyard` (Project/Local 필터) |

---

## 4. `startSkillDiscoveryPrefetch` 와의 비교

같은 turn 시작점에서 켜지는 자매 메커니즘 ([skill-system.md](skill-system.md) §2.4):

```js
// Bq3 매 iteration 시작
let m = Uy8?.().startSkillDiscoveryPrefetch(null, W, Z)
```

| 측면 | `startMemdirPrefetch` memdir | `Uy8().startSkillDiscoveryPrefetch` |
|---|---|---|
| 위치 | `using P = ga7(...)` — outer (turn loop 진입 직후, while 밖) | iteration body 안 (`let m = ...`) — 매 turn-iter 마다 새로 |
| 자원 lifecycle | `using` (ES2026 disposable) → Bq3 종료시 자동 dispose | 그냥 변수 — 매 iter 끝에 `collectSkillDiscoveryPrefetch(m)` 명시 호출 |
| 가드 | `memorySelector`, `b4()`, `tengu_moth_copse`, 세션 바이트, 단어 1개 이상 | 별개 — `startSkillDiscoveryPrefetch호출자` accessor 가 lazy-init (없을 수도 있음, `Uy8?.()`) |
| 결과 형태 | `relevant_memories` attachment | `dynamic_skill` attachment ([skill-system.md](skill-system.md) `M73`) |
| ToolUseContext 갱신 | 안 함 (attachment 만 inject) | `discoveredSkillNames` / `discoveredRemoteSkills` 채움 (추정) |
| 소비 조건 | `settledAt !== null` (non-blocking) | `await Uy8().collectSkillDiscoveryPrefetch(m)` (blocking) |
| 소비 위치 | tool 실행 후, refresh-tools 전 | 같은 위치 (memdir 직후 곧바로) |

핵심 차이는 **lifecycle binding**:
- memdir 은 `runTurnLoop` 호출 한 번 전체에 한 prefetch (한 번만 consume).
- skill discovery 는 **매 iteration 마다** 새 prefetch (skill 발견은 도구 결과로 cwd 가 바뀔 수 있어 매 iter 새로).

`startSkillDiscoveryPrefetch호출자` 의 내부 동작은 lazy-init module accessor 라 코드상 확인 불가. 추정으로는 ([skill-system.md](skill-system.md) §2.4) cwd 기반 `.claude/skills` 디스크 스캔 + remote skill registry 조회.

---

## 5. 차이점 (v0.2.8 → v2.1.143)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| Auto memory | 없음 | turn 시작 시 prefetch + selector/synthesizer LLM + `relevant_memories` attachment |
| 자원 관리 | manual | ES2026 `using` 키워드로 disposable 패턴 |
| Memory state | 없음 | `memorySelector.stateByDir` multi-turn cache 재사용 |
| nested CLAUDE.md | 시스템 prompt 에 정적 포함 | Read 도구가 trigger → `A73` 가 인접 디렉토리 동적 스캔 → 매 턴 inject |
| Memory crosslinks | 없음 | `[[name]]` markdown 컨벤션 (쓰기 측만 정의, 읽기는 모델 재량) |
| Memory dir | 없음 | `~/.claude/projects/<slug>/auto-memory/` (default) + agent-specific `<scope>/agent-memory/<type>/` + env override `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` |
| Statsig gates | 없음 | `tengu_moth_copse` (master), `tengu_billiard_aviary` (synthesize vs select), `tengu_paper_halyard` (Project/Local 필터) |
| Telemetry | 없음 | `tengu_memdir_prefetch_collected`, `tengu_memdir_loaded`, `tengu_memdir_accessed/file_{read,edit,write}`, `tengu_team_mem_*`, OTel `memory_recall_select` / failure |

### v2.1.143 신규 식별자 요약

| Minified | 의미 | 라인 |
|---|---|---|
| `startMemdirPrefetch` | memdir prefetch 진입 — `using` disposable 반환 | 14303 |
| `transformMemdirResults` | prefetch 결과 → readFileState dedup 변환 | 14306 |
| `Y73` | 실제 prefetch 본체 (synthesize / select 분기) | 14301 |
| `E77` | per-dir synthesizer 실행 (state caching 포함) | 9612 |
| `fz5` | synthesizer LLM 호출 (Sonnet) | 9614 |
| `selectRelevantMemories` (anon 직전 9610) | selector LLM 호출 (Haiku, JSON schema) | 9610 |
| `dY_` | 디스크 스캔 — `.md` 파일 + frontmatter 파싱, mtime 정렬 | 9608 |
| `cY_` | 스캔 결과를 indexed 한 줄씩 포매팅 (selector input) | 9609 |
| `NA8` / `VA8` | memorySelector.stateByDir set/get | 8520 / 8519 |
| `jYH` | memorySelector 빈 인스턴스 생성 (`{stateByDir:Map, lastUsage:null}`) | 8517 |
| `BGH` | memorySelector reset | 8518 |
| `It7` | 사용자 텍스트에서 `@agent-X` 멘션 추출 | 14316 |
| `ZpH` | agent-specific memory dir 경로 빌더 (project/local/user 스코프) | 5827 |
| `U$` | default auto-memory dir (`X6` memoized) | 4437 부근 |
| `b4` | auto-memory feature flag 체인 | 5657 |
| `dw` | synthesize gate (`tengu_billiard_aviary`) | 5662 |
| `evalStatsigGate` | Statsig gate 평가 (memoized) | 5634 |
| `ev` | child AbortController 생성 + parent-cascade | 8159 |
| `J73` | querySource exclude set (5종) | 14352 |
| `m93.MAX_SESSION_BYTES` | `61440` (60 KiB) | 14352 |
| `makeAttachmentMessage` | attachment 를 turn event 로 wrap | 14331 |
| `A73` | nested memory attachment 빌더 (`makeSystemReminderAttachment` 가 호출) | 14299 |
| `St7` | Read 인접 디렉토리에서 CLAUDE.md 류 찾기 | 14287 |
| `nestedMemoryAttachmentTriggers` | Read 도구가 push 하는 path Set (ToolUseContext) | 9845 / 14725 |
| `loadedNestedMemoryPaths` | 이미 inject 된 nested memory 중복 방지 Set | 9845 |
| `b_4` | `relevant_memories` attachment → SDK `system/memory_recall` 이벤트 변환 | 21007 |
| `uc5` | `/^<synthesis:(.+)>$/` synthesize sentinel regex | (DL8 모듈) |
| `T8K` | "전부 synthesis 형식인가" 검사 | 15102 |
| `JL8` | "전부 team/personal 매칭인가" 검사 | 12646 |
| `Bb7` | memories 의 cited/private 카운트 (텔레메트리용) | 12647 |
| `B98` | memory 작성 가이드 (`[[name]]` 컨벤션 포함) | 5795 |
| `Yr_` | memory 작성 markdown 템플릿 빌더 | 5795 |
| `cC1` | name slug 정규화 (`[a-z0-9_-]+`) | 5795 |
| `tengu_moth_copse` | master memdir gate | (gate name) |
| `tengu_billiard_aviary` | synthesize-vs-select gate | (gate name) |
| `tengu_paper_halyard` | Project/Local memory 필터 gate | (gate name) |

### 미확인 / 추정

- `w73(messages)` 의 본체 — Bun lazy-init 으로 가려져 호출 시그니처(`{totalBytes, paths}` 반환)만 추론. 정확한 `paths` 계산 로직은 미확인.
- `Y73` 함수 본체의 후반부 — extracted-functions.js 의 함수 splitter 가 template literal 안의 `\n` 에서 함수를 잘랐기 때문에 `let X=...,P=X?...:...}` 이후가 끊긴 형태로 나옴. select 모드 분기와 최종 `{type:"relevant_memories", memories:...}` 객체 조립 코드가 함수 안에 있을 텐데 directly 못 봄. select-vs-synthesize 모드 모두 동일하게 `relevant_memories` attachment 를 반환한다는 점은 `transformMemdirResults` 변환과 `wY5` Zod 스키마로 확인.
- `[[name]]` 자동 해소 — 추출본의 모든 코드 경로를 훑었으나 `[[ ... ]]` regex 가 memdir 컨텍스트에서 등장 안 함. 모델이 자체적으로 본문의 `[[X]]` 를 보고 다음 turn 에 Read 도구 호출하거나 selector LLM 이 cited 처리할 가능성. 자동 follow 코드는 **없는 것으로 확인**.
- `jH6(path)` — `$l9 = async () => {}` 빈 implementation. 빌드 시 stub 처리됐을 가능성, 또는 production 환경에서만 동작하는 OTel emitter. 본 추출본에서는 no-op.
- `startSkillDiscoveryPrefetch호출자` 모듈 — lazy accessor 의 실제 구현은 별도 모듈로 가려짐. memdir 과 같은 자리에서 시작되지만 lifecycle / state 모두 독립. ([skill-system.md](skill-system.md) 참조).
- task 설명의 텔레메트리 이벤트 `tengu_memdir_prefetch_started` / `_skipped` — 추출본엔 **없음**. 단일 `_collected` 이벤트만 dispose 시점에 발생.
- `kA8` 상수 — selector LLM 호출의 querySource 값. 단일 호출 사이트라 정확한 문자열은 별도 모듈에서 정의됨. 추정: `"memdir_relevance"` (allowlist 토큰 중 하나).
- task 설명의 `MemDirResult.kind` 필드 — Zod 스키마 `wY5` 에 없음. 실제 필드는 `{path, scope, content?, mtimeMs, limit?}`.
