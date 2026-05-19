# Skill System

Claude Code v2.1.143의 plugin-like 확장 메커니즘. v0.2.8의 정적 슬래시-커맨드 시스템을 대체하여 다음 4축으로 확장됨:

1. **Skill 도구 (`ff`)** — 명명된 skill을 invoke해서 instructions + tool 권한 + 모델 override를 동시 주입
2. **ToolSearch 도구 (`d$`)** — deferred tool 정의를 on-demand로 펼쳐서 컨텍스트 절약
3. **Skill discovery prefetch** — turn 시작 시 cwd 기반으로 dynamic skill dir 스캔
4. **Skill listing attachment** (`cy8`) — 모델에게 "사용 가능한 skill 목록"을 attachment 형태로 noise 없이 전달

식별자: 모듈 표기는 백틱, 파일은 `extracted-functions.js:LINE` 참조.

---

## 1. 호출 그래프

### 1.1 슬래시 커맨드 (`/skill-name`) 진입 → Skill 실행

```
REPL input "/init"
  └─ Px (line 20706: input submit)
       └─ slash 파싱: f_.trim().startsWith("/")
            ├─ 로컬 JSX 커맨드 (clear, theme, …) → 즉시 실행
            └─ 그 외 → NY({value:f_, mode:"prompt", ...})
                 └─ tx7K queued_command attachment 로 enq

→ Bq3 (turn loop, line 14057) 다음 iteration
   └─ messages 에 user-prompt block "<command-name>init</command-name>"
   └─ 모델이 다음 tool call로 `Skill({skill:"init"})` 를 emit

→ Hj_ tool batch
   └─ a63 single tool pipeline
        └─ InHq (Skill tool .call, line 12888)
             ├─ q.options.activeSkill = "init"
             ├─ slash 처리: processPromptSlashCommand(z, _, A, q)
             │    └─ Zf_/EnH.js path:
             │         1. skill loadup (l0(F4()) → bundled + plugin + user skills)
             │         2. resolve skill object Y
             │         3. getPromptForCommand(args, ctx)
             │         4. messages = [user prompt, command/expansion meta, ...]
             ├─ context 분기:
             │    ├─ Y.context === "fork" → en5(): Sb subagent + activeSkill 전파
             │    └─ default(inline) → 현 턴 inject + contextModifier 적용
             └─ data: {success, commandName, allowedTools?, model?}
```

### 1.2 Skill 도구 (모델이 자발적으로 호출)

모델이 skill listing attachment(아래 1.4)나 `ToolSearch` 결과를 보고 직접 `Skill({skill:"frontend-design", args:"..."})` 을 발행. 슬래시 파싱이 없으므로 `validateInput` 에서 `H.startsWith("/")` 분기로 알아냄 (`d("tengu_skill_tool_slash_prefix", {})` 텔레메트리만 차이).

### 1.3 다음 턴 priming

`q.options.activeSkill` 은 `buildCreatePayload` (line 19057, messages.create payload builder) 가 다음 `callModel` 호출 시 함께 전송하는 옵션 — `runTurnLoop` 의 `callModel({…, activeSkill: Z.options.activeSkill, spawnedBySkill: A, …})` (line 14057).

`spawnedBySkill` 은 fork 컨텍스트에서 subagent 가 자기 부모 skill 이름을 들고 가는 별도 필드 (`Sb` 옵션). `activeSkill` 은 inline 실행 시 현재 턴에서 사용 중인 skill 이름.

### 1.4 Skill listing attachment (`cy8`)

`runTurnLoop` 의 turn-start attachment 빌드 (`makeSystemReminderAttachment`, line 14251) 에서 호출. 첫 turn 에 한 번, 그리고 이후 새 skill 이 발견될 때마다 delta 형태로 추가:

```
cy8(H):
  if isSkillsAsToolsEnabled() → []
  if Skill 도구가 H.options.tools 에 없으면 → []
  let q = await l0(F4())          // 디스크에서 skill 발견
  let K = yw6(H.getMcp().commands) // MCP 노출 prompt
  let O = q + K dedup by name
  if H.agentId === undefined: o7H(O, pB())  // 세션 allowlist 필터
  
  let $ = kw6.get(agentId ?? "") ?? new Set
  if Vw6 && main-thread: 강제 refresh
  let z = O.filter(skill => !$.has(skill.name))  // 새 것만
  if z.length === 0: return []
  
  $.add(...z.map(s => s.name))
  return [{
    type: "skill_listing",
    content: Xj8(z, modelHeader, t7H, modelTokenizer),
    skillCount: z.length,
    isInitial: $.size === 0
  }]
```

→ 모델이 보는 형태: 표 또는 bullet 리스트. 각 항목 = `name + 짧은 description + when_to_use`.

`pB()` = `getSessionSkillAllowlist` — `--skills foo,bar` CLI 플래그가 만든 Set. `Skill(skill_name)` 형태로 allowedTools 에 들어감 (`yLK` SDK transport, line 17825).

---

## 2. 핵심 로직

### 2.1 Skill tool (`Skill`, line 12888 — `extracted-functions.js:12888`)

```js
let InHq = X9({
  name: ff,                          // "Skill"
  isEnabled: () => true,
  maxResultSizeChars: 1e5,
  inputSchema: y.object({
    skill: y.string().describe("The name of a skill from the available-skills list. Do not guess names."),
    args:  y.string().optional().describe("Optional arguments for the skill")
  }),
  outputSchema: y.union([
    // inline
    y.object({success, commandName, allowedTools?, model?, status:"inline"?}),
    // forked
    y.object({success, commandName, status:"forked", agentId, result})
  ]),
  description: async ({skill:H}) => `Execute skill: ${H}`,
  prompt: async () => Y86(F4()),    // 등록된 skill 카탈로그를 prompt 로
  toAutoClassifierInput: ({skill}) => skill,

  async validateInput({skill:H}, _) {
    let q = H.trim();
    if (!q) → errorCode:1 "Invalid skill format"
    let K = q.startsWith("/");
    if (K) d("tengu_skill_tool_slash_prefix", {})
    let O = K ? q.slice(1) : q;
    let $ = await oL8(_);            // load full skill catalog
    let z = Gy(O, $);                // resolve by name/alias
    if (!z) {
      // suggest near-match via Levenshtein (maxEditDistance:2)
      let Y = VnH(O, $.map(...), {maxEditDistance:2});
      return {result:false, message: Y ? `Unknown skill: ${O}. Did you mean ${Y}?` : ...}
    }
    if (z.disableModelInvocation && !im7(O, _))    → "skill_invoke_model_disabled"
    if (T !== undefined && o7H([z], T).length===0) → "skill_invoke_not_allowlisted"
    let A = qe(z);                   // skillOverrides setting (on / name-only / user-invocable-only / off)
    if (A === "off" || (A === "user-invocable-only" && !im7(O,_))) → "skill_invoke_override_disabled"
    if (z.type !== "prompt")         → "${O} is a ${UI|built-in CLI} command, not a skill."
    return {result:true}
  },

  async checkPermissions({skill, args}, q) {
    let O = q.getToolPermissionContext()
    // matcher: "Skill(name)" or "Skill(name:*)"
    let match = (rule) => rule === O || (rule.endsWith(":*") && O.startsWith(rule.slice(0,-2)))
    
    let denyRules = SQ(O, InHq, "deny");
    for (rule of denyRules) if (match(rule)) → {behavior:"deny", ...}
    
    let allowRules = SQ(O, InHq, "allow");
    for (rule of allowRules) if (match(rule)) → {behavior:"allow", ...}
    
    // skill 객체에 자기 frontmatter 외에 아무 것도 안 정의돼 있으면 자동 allow
    // (Ki5: 21개 metadata 키만 있는지 검사 — qi5 화이트리스트)
    if (z?.type === "prompt" && Ki5(z))
      return {behavior:"allow", ...}
    
    return {
      behavior:"ask",
      message: `Execute skill: ${O}`,
      suggestions:[
        {type:"addRules", rules:[{toolName:ff, ruleContent:O}], behavior:"allow", destination:"localSettings"},
        {type:"addRules", rules:[{toolName:ff, ruleContent:`${O}:*`}], behavior:"allow", destination:"localSettings"},
      ]
    }
  },

  async call({skill:H, args:_}, q, K, O, T) {
    let $ = H.trim(), z = $.startsWith("/") ? $.slice(1) : $;
    q.options.activeSkill = z;
    let A = await oL8(q), Y = Gy(z, A);
    if (Y) q.options.activeSkill = Y.name;
    C86(z);                          // mark invoked-skill telemetry (per-agent)
    
    if (Y?.type === "prompt" && Y.context === "fork")
      return en5(Y, z, _, q, K, O, T);     // → Sb subagent fork (1.5)
    
    let {processPromptSlashCommand} = await import(EnH);
    let j = await processPromptSlashCommand(z, _ || "", A, q);
    if (!j.shouldQuery) → error "skill_invoke_process_failed"
    
    let J = j.allowedTools || [], D = j.model;
    let M = (Y?.type==="prompt") ? Y.effort : undefined;
    
    d("tengu_skill_tool_invocation", {
      command_name, _PROTO_skill_name, execution_context:"inline",
      invocation_trigger: queryDepth>0 ? "nested-skill" : "claude-proactive",
      ... plugin/skill attribution
    });
    qA_(z, Y, trigger);              // emit "skill_activated" OTEL event
    
    return {
      data: {success:true, commandName:z, allowedTools:J?, model:D?},
      newMessages: Wm7(j.messages.filter(...), toolUseId),
      contextModifier(ctx) {
        // 1) allowedTools 가 있으면 ctx 의 permission alwaysAllowRules.command 에 union
        // 2) D (model override) 가 있으면 ctx.options.mainLoopModel 교체
        // 3) M (effort override) 가 있으면 ctx.getEffortValue() 교체
        return ctx_modified
      }
    }
  },
  ...
})
```

`processPromptSlashCommand` (`EnH` module, line 12880) 가 핵심: skill 의 `getPromptForCommand(args, ctx)` 를 실행해 텍스트 prompt 를 만들고, frontmatter 의 `allowed-tools`, `model`, `effort`, `hooks`, `paths`, `argument-hint` 등을 메시지에 첨부. 결과로 모델은 다음 턴에 그 prompt 를 user message 로 보고 작업 시작.

### 2.2 Skill 의 fork 모드 (`en5`, line 12886)

`frontmatter: context: fork` 인 skill 은 subagent 컨테이너에 격리 실행:

```
en5(H, _, q, K, O, T, $):
  let A = pm()                          // new agentId
  d("tengu_skill_tool_invocation", {execution_context:"fork", ...})
  qA_(_, H, trigger)
  let {modifiedGetAppState, modifiedGetToolPermissionContext, baseAgent,
       promptMessages, skillContent} = await iq6(H, q||"", K)
  let k = H.effort !== undefined ? {...W, effort:H.effort} : W
  
  for await (let I of Sb({
    agentDefinition: k,
    promptMessages: G,
    toolUseContext: {...K, getAppState:P, getToolPermissionContext:Z},
    canUseTool: O,
    isAsync: false,
    querySource: "agent:custom",
    spawnedBySkill: H.name,                // ← 부모 skill 이름 propagate
    model: H.model,
    availableTools: K.options.tools,
    override: {agentId: A}
  })) {
    v.push(I)
    if (assistant/user message && $)
      $(progress event with toolUseID=`skill_${T.message.id}`)
  }
  return {data: {success, commandName, status:"forked", agentId:A, result}}
```

→ Sb (`extracted-functions.js:14063`) 는 subagent 실행기. `spawnedBySkill` 은 그 안에서 `buildCreatePayload` 페이로드 빌더로 전달되어 서버 측 텔레메트리/라우팅에 영향.

### 2.3 ToolSearch tool (`ToolSearch`, line 13750 — `extracted-functions.js:13750`)

deferred tool 정의를 inline 으로 펼쳐 컨텍스트 토큰 절약 (LSP, ToolSearch 자체, MCP 도구 등 `shouldDefer:true` 인 도구는 일반 turn 의 도구 목록에서 빠지고 이름만 존재).

```js
let yX_ = X9({
  name: d$,                          // "ToolSearch"
  isEnabled: () => tE(),            // gate by ENABLE_TOOL_SEARCH env + model support
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: y.object({
    query: y.string().describe('Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.'),
    max_results: y.number().optional().default(5).describe("Maximum number of results to return (default: 5)")
  }),
  outputSchema: y.object({
    matches: y.array(y.string()),
    query: y.string(),
    total_deferred_tools: y.number(),
    pending_mcp_servers: y.array(y.string()).optional()
  }),

  async call(H, {options:{tools, refreshTools, mcpClients, refreshMcpClients}, abortController}) {
    let {query, max_results=5} = H;
    let A = refreshTools?.() ?? tools;
    let Y = A.filter(Xm);           // Y = deferred tools list
    Nn7(Y);                          // invalidate description cache if list changed

    // mode 1: select:Tool1,Tool2,Tool3
    let Z = query.match(/^select:(.+)$/i);
    if (Z) {
      let k = Z[1].split(",").map(s => s.trim()).filter(Boolean);
      let v = [], E = [];
      for (let name of k) {
        let C = eK(Y, name) ?? eK(A, name);
        if (C) v.push(C.name); else E.push(name);
      }
      // missing → poll MCP up to 5s for late-arriving servers
      if (E.length > 0) {
        let result = await f(async (deferred, allTools) => {
          let p = []
          for (let name of E) {
            let x = eK(deferred, name) ?? eK(allTools, name)
            if (x) p.push(x.name)
          }
          return p
        }, "select", E)
        if (result) return hiH([...v, ...result.matches], ...)
      }
      return hiH(v, query, ...)
    }

    // mode 2: keyword search (with optional + prefix for required terms)
    let W = await yn7(query, Y, A, max_results);
    if (W.length === 0) {
      // retry after MCP refresh
      let k = await f((v, E) => yn7(query, v, E, max_results), "keyword", query)
      if (k && k.matches.length > 0) W = k.matches
    }
    return hiH(W, query, deferred.length, pending_mcp_servers);
  },

  // 결과 → inline tool_reference blocks
  mapToolResultToToolResultBlockParam(H, _) {
    if (H.matches.length === 0) {
      let q = "No matching deferred tools found"
      if (H.pending_mcp_servers?.length > 0)
        q += `. Some MCP servers are still connecting: ${list}...`
      return {type:"tool_result", tool_use_id:_, content:q}
    }
    return {
      type:"tool_result", tool_use_id:_,
      content: H.matches.map(q => ({type:"tool_reference", tool_name: q}))
    }
  }
})
```

#### Keyword 매칭 (`yn7`, line 13740)

1. **exact name 매칭** (대소문자 무시) → 즉시 반환
2. **MCP 접두사**: `mcp__server` 로 시작하면 prefix match
3. **`+keyword` 필수** + 일반 키워드 분리
4. **점수 매기기**:
   - `tokenize(toolName)`: camelCase / snake_case / dot 로 split → parts + coarseParts
   - 토큰 일치 = 10점, MCP 도구는 12점 (boost)
   - 부분 포함 = 5–6점
   - prompt 내 단어 정규식 매치 = 2점
   - searchHint 매치 = 4점
5. score > 0 만 정렬해서 `max_results` 개 반환

#### Deferred tool inline 주입

핵심 매커니즘 — 호출 결과 `content` 가 string 이 아니라 **`{type:"tool_reference", tool_name:X}` 블록 배열**. 모델은 이 블록을 보면 다음 턴에 X 의 full schema 를 `<function>{description, name, parameters:{…}}</function>` 형식으로 시스템 프롬프트에 인라인 받음. 즉 **"필요한 도구만 지연 로딩"**.

서버 측 (Anthropic API) 가 `tool_reference` 블록을 인식해서 `tools` 파라미터에 X 의 full def 를 합성해줌. 클라이언트는 그저 reference 만 emit 하면 됨.

`tE()` (line 14821) — optimistic gate:
- `ENABLE_TOOL_SEARCH=auto[:N]` / `auto` / `false` env
- model 이 `tool_reference` 지원 (Sonnet 4+, Opus 4+, …) — `KLH` 검사
- 첫 호출 시 캐시되어 후속 호출 모두 동일 결과

`pP_` (line 14827) — 실제 활성화:
- `iE8()` 의 mode: `tst | tst-auto | standard`
- `tst-auto`: MCP 도구 토큰 수가 threshold 초과 시에만 활성화 (`f_K`/`M_K`)

### 2.4 Skill discovery prefetch (`startSkillDiscoveryPrefetch`)

`runTurnLoop` (`extracted-functions.js:14057`) 의 매 iteration 시작점에서:

```js
let m = Uy8?.().startSkillDiscoveryPrefetch(null, W, Z);
```

→ async prefetch 시작 (handle `m` 만 보관). turn 끝나기 직전에 결과 회수:

```js
if (Uy8 && m) {
  let attachments = await Uy8().collectSkillDiscoveryPrefetch(m);
  for (let H_ of attachments) {
    let G_ = T9(H_);          // wrap as system block
    yield G_; JH.push(G_);    // add to next-turn user messages
  }
}
```

prefetch 가 무엇을 스캔하는지는 minified 함수가 lazy-init 으로 가려져 추정만 가능. 단, 결과물은 `M73(H)` (line 14308) 의 **dynamic_skill attachment** 와 동일 형태:

```js
async function M73(H) {
  let _ = [];
  if (H.dynamicSkillDirTriggers && H.dynamicSkillDirTriggers.size > 0) {
    let q = await Promise.all(Array.from(H.dynamicSkillDirTriggers).map(async (K) => {
      let entries = (await readdir(K, {withFileTypes:true}))
        .filter(z => z.isDirectory() || z.isSymbolicLink())
        .map(z => z.name)
      let names = await Promise.all(entries.map(async name => {
        try { await stat(resolve(K, name, "SKILL.md")); return name; }
        catch { return null; }
      }))
      return {skillDir:K, skillNames: names.filter(z => z !== null)};
    }));
    for (let {skillDir:K, skillNames:O} of q) {
      if (O.length > 0)
        _.push({
          type: "dynamic_skill",
          skillDir: K,
          skillNames: O,
          displayPath: relative(cwd, K)
        });
    }
    H.dynamicSkillDirTriggers.clear();
  }
  return _;
}
```

→ **확인**: prefetch 는 `ToolUseContext.dynamicSkillDirTriggers: Set<string>` 에 쌓인 디렉토리 — 모델/사용자가 파일을 만지거나 읽을 때 `Read.call` (line 14727) 이 `snH([D], P)` 를 호출하여 `<readPath>/../.claude/skills`, `<readPath>/../../.claude/skills`, …처럼 cwd 까지 거슬러 올라가며 발견된 dir 을 등록.

```js
// snH (line 14689) — file-touch 시 위로 거슬러 .claude/skills 후보 모음
async function snH(H, _) {
  let q = x_(), K = _.endsWith(sep) ? _.slice(0,-1) : _, O = [];
  for (let T of H) {
    let $ = dirname(T);
    while ($.startsWith(K + sep)) {
      let z = join($, ".claude", "skills");
      if (!mf.dynamicSkillDirs.has(z)) {
        mf.dynamicSkillDirs.add(z);
        try {
          await q.stat(z);            // exists?
          if (await bu6($, K)) {       // gitignored?
            N(`[skills] Skipped gitignored skills dir: ${z}`); continue;
          }
          O.push(z);
        } catch {}
      }
      let A = dirname($);
      if (A === $) break;
      $ = A;
    }
  }
  return O.sort((T,$) => $.split(sep).length - T.split(sep).length);
}
```

→ Read 가 `O.length > 0` 이면 그 dir 들을 `ctx.dynamicSkillDirTriggers.add()` + `tnH(O)` 로 즉시 로드, `enH([D], P)` 로 **conditional skill** (frontmatter `paths:` 매칭) 활성화. 다음 턴의 `M73` (또는 prefetch) 가 dynamic_skill attachment 로 모델에 알림.

**추정**: `Uy8().startSkillDiscoveryPrefetch` 는 같은 cwd 스캔 + remote(skill provider) 조회를 turn 처리 동안 백그라운드로 돌리는 wrapper. `discoveredSkillNames` / `discoveredRemoteSkills` 는 그 결과 저장소 (ED8 builder, line 9845 가 매 ctx 마다 새 Set/Map 생성).

`runTurnLoop` 시작 시점에 `startSkillDiscoveryPrefetch` → turn 마지막에 `collectSkillDiscoveryPrefetch` 로 yield 하는 패턴이라, **턴 안의 모델 추론과 디스크/네트워크 I/O를 병렬화하는 게 목적**.

### 2.5 Conditional skill 활성화 (`enH`, line 14693)

skill frontmatter 에 `paths:` 가 있으면 conditional 로 보관, 매칭 파일이 접촉될 때만 활성화:

```js
function enH(H, _) {
  if (mf.conditionalSkills.size === 0) return [];
  let q = [];
  for (let [K, O] of mf.conditionalSkills) {
    if (O.type !== "prompt" || !O.paths || O.paths.length === 0) continue;
    let T = ignore().add(O.paths);            // gitignore-style matcher
    for (let $ of H) {                         // H = recently-touched paths
      let z = isAbsolute($) ? relative(_, $) : $;
      if (T.ignores(z)) {                       // = "matches"
        mf.dynamicSkills.set(K, O);
        mf.conditionalSkills.delete(K);
        mf.activatedConditionalSkillNames.add(K);
        q.push(K);
        N(`[skills] Activated conditional skill '${K}' (matched path: ${z})`);
        break;
      }
    }
  }
  if (q.length > 0) d("tengu_dynamic_skills_changed", {source:"conditional_paths", ...});
  return q;
}
```

→ `paths` 는 gitignore-style 패턴 (`**/*.tf` 등). 매칭 파일을 모델이 Read 하면 자동 활성화 → 다음 턴 listing 에 포함.

### 2.6 Skill 로드 (디스크 스캔, `NE8` / `hrH` / `LE8` / `kE8`)

```
NE8 (line 14695) — top-level loader, memo:
  ├─ policy skills:   <managedDir>/skills/
  ├─ user skills:     ~/.claude/skills/
  ├─ project skills:  <cwd>/.claude/skills/ + each --add-dir
  └─ legacy commands: <cwd>/.claude/commands/*.md (V13)

  for each dir:
    hrH(dir, source) — readdir, each entry:
      └─ SKILL.md (or *.md for commands)
           ├─ frontmatter: yaml parse (eY)
           ├─ LE8: extract fields (name/description/when_to_use/allowed-tools/model/effort/hooks/paths/agent/context/argument-hint/arguments/disable-model-invocation/user-invocable/created_by/fallback/shell)
           └─ kE8: build skill object with getPromptForCommand(args, ctx)
                  └─ ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}/${CLAUDE_EFFORT} 치환
                  └─ allowedTools 의 ${CLAUDE_SKILL_DIR} 치환 (skill 의 baseDir 로)
                  └─ argumentHint, argNames 지원 (positional args)

  dedup by realpath, conditional path 분리, return List<Skill>
```

**Bundled (built-in) skills** — `HA_` module (line 8595, `mA8` Map). `pA8()` 가 모든 enabled bundled plugins 의 skill 을 반환. 동적 등록:

```
ieK (line 20917) — bundled skill init:
  UsK(), RsK(), ssK(), XsK(), NsK(), bsK(),
  EsK(), ysK(), CsK(), jsK(), usK(), ZsK()  ← 12개 default 등록자
  + registerDreamSkill()
  + registerLoopSkill()      (line 20883)
  + registerScheduleRemoteAgentsSkill()
  + registerClaudeApiSkill() (line 20905, h9O — line 20915)
  + iaH() ? DsK() : ()
```

**Plugin skills** — `q86` (line 9219) 가 `<plugin>/skills/` 또는 manifest `skills:` 필드를 읽어 plugin object 의 `skillsPath` / `skillsPaths` 에 채움. 후에 `c$()` enabled plugins 순회로 합산.

**Skills-as-plugins** (`@skills-dir` marketplace) — `HT5` (line 9237). `<cwd>/.claude/skills/<name>/` 자체를 plugin 으로 인식 (`SKILL.md` + 옵셔널 `.claude-plugin/`). project-scope 라면 MCP/LSP/monitors 는 strip 됨 (개별 승인 불가).

---

## 3. State / Schema

### 3.1 Skill object (`kE8`, line 14672)

```ts
type Skill = {
  type: "prompt",                              // 항상 prompt; local-jsx/built-in 은 별도
  name: string,                                // 파일명/디렉토리명, slash 접두 없음
  description: string,
  hasUserSpecifiedDescription: boolean,
  allowedTools: string[],                      // frontmatter "allowed-tools"
  argumentHint?: string,
  argNames?: string[],                         // positional args
  whenToUse?: string,
  version?: string,
  model?: string,                              // "inherit" → inherit, 아니면 r7(name)
  disableModelInvocation: boolean,             // model 이 skill 도구로 호출 못 함
  userInvocable: boolean,                      // 사용자가 /name 으로 호출 가능
  context?: "fork",                            // 없으면 inline
  agent?: string,                              // fork 시 어떤 agent 로
  effort?: "low"|"medium"|"high"|"max"|number,
  paths?: string[],                            // conditional 활성화 globs
  declaredFields: Set<string>,                 // frontmatter 명시 필드만
  contentLength: number,                       // markdown body 크기
  isHidden: boolean,                           // !userInvocable
  progressMessage: "running",
  userFacingName(): string,                    // displayName || name
  source: "bundled" | "plugin" | "policySettings" | "userSettings" | "projectSettings" | "mcp",
  loadedFrom: "skills" | "commands_DEPRECATED" | "mcp" | "bundled",
  createdBy?: "dream-proposal",
  fallback?: boolean,                          // 동명 plugin/MCP skill 있으면 양보
  hooks?: HookConfig,
  skillRoot?: string,                          // baseDir
  shell?: string,
  pluginInfo?: { pluginManifest, repository },
  async getPromptForCommand(args, ctx): TextBlock[]
}
```

### 3.2 ToolUseContext skill 필드 (`forkToolUseContext`, line 9845)

```ts
interface ToolUseContext {
  ...
  dynamicSkillDirTriggers: Set<string>          // 매 ctx 새로 (empty)
  discoveredSkillNames: Set<string>             // 매 ctx 새로 (empty)
  discoveredRemoteSkills: Map<string, ...>      // parent 상속 또는 신규
  ...
  options: {
    activeSkill?: string                        // 현재 inline 진행 중 skill
    spawnedBySkill?: string                     // subagent 가 부모 skill 이름 보유
    ...
  }
}
```

세션 글로벌 (`mf`, line 14685, `vE8()`):
```ts
{
  dynamicSkillDirs: Set<string>          // snH 가 등록한 후보 dir
  dynamicSkills: Map<name, Skill>        // 활성화된 dynamic skill
  conditionalSkills: Map<name, Skill>    // paths 매칭 대기 중
  activatedConditionalSkillNames: Set<string>  // 활성화 한 번이라도 된 이름
}
```

### 3.3 Skill frontmatter (`LE8`, line 14671 — 인식 키)

```yaml
name: my-skill                          # displayName (별도, 디렉토리명이 실제 id)
description: short desc
when_to_use: longer guidance
allowed-tools: ["Read", "Bash(git *)"]
disable-model-invocation: false         # true → model 이 못 부름
user-invocable: true                    # /name 으로 호출 가능
model: inherit | claude-opus-4-7 | ...
effort: low | medium | high | max | <int>
shell: /bin/bash
argument-hint: "<file>"
arguments: ["file", "lineno"]            # positional
paths: ["src/**/*.ts", "**/*.tf"]       # conditional 활성화
context: inline | fork
agent: general-purpose
hooks: {PreToolUse: [...], ...}
version: 1.2.3
fallback: true                          # 동명 plugin/mcp skill 우선
created_by: dream-proposal
improved_by: dream-proposal
```

### 3.4 Skill discovery telemetry

```
tengu_skill_tool_invocation:
  command_name: <name|"custom">
  _PROTO_skill_name: <actual name>
  execution_context: "inline" | "fork"
  invocation_trigger: "claude-proactive" | "nested-skill"
  query_depth: number
  parent_agent_id?, skill_source?, skill_loaded_from?, skill_kind?, skill_created_by?
  attribution_shown: boolean
  skill_content_chars: number
  plugin_name?, plugin_repository?

tengu_skill_tool_slash_prefix: {}      # 모델이 / 를 prefix 로 붙였을 때
tengu_dynamic_skills_changed:
  source: "file_operation" | "conditional_paths"
  previousCount, newCount, addedCount, directoryCount
tengu_plugin_skills_dir_loaded: {count, user_count, project_count, project_suppressed_count, error_count}

# OTEL
skill_activated: {
  "skill.name", invocation_trigger, "skill.source"?, "skill.kind"?,
  "plugin.name"?, "marketplace.name"?
}

# ToolSearch
tengu_tool_search_outcome: {query, queryType:"select"|"keyword", matchCount, totalDeferredTools, maxResults, hasMatches, mcpServersConfigured, mcpServersConnected, mcpServersPending}
tengu_tool_search_mode_decision: {enabled, mode, reason, checkedModel, mcpToolCount, mcpNonBlocking}
tengu_tool_search_mcp_wait: {queryType, refreshOnly, waitedMs, pendingBefore, pendingAfter, matchesAfterWait, ...}
tengu_sdk_mcp_false_unavailable: {queryType, pendingServers, targetedPendingServers}
```

### 3.5 `mq8` — skill name extraction (line 5578)

```js
function mq8(H, _, q) {
  if (H !== "Skill") return;
  if (typeof _ === "object" && _ !== null && "skill" in _ && typeof _.skill === "string")
    return _.skill;
  return;
}
```

→ tool result 텔레메트리에 `skill_name` 필드 채우기 용. `Skill` 도구의 input.skill 만 봄. `pq8` 는 같은 패턴으로 `Agent`/`Task` 의 `subagent_type` 추출.

### 3.6 Skill 카탈로그 dedup (`tn5`, line 12881)

같은 이름 skill 이 여러 소스에서 발견될 때:
- 첫 등록자 유지
- 단, 새 entry 가 `disableModelInvocation:false` (=invokable) 이고 기존이 true 면 교체

→ bundled < plugin < user < project 우선순위는 호출 순서에 의존 (`l0` aggregator).

### 3.7 `qe` (skillOverrides setting per-skill)

`settings.json` 의 `skillOverrides: {[skillName]: "on"|"name-only"|"user-invocable-only"|"off"}`:
- `"on"` (또는 미설정): 정상 listing + 모델 호출 가능
- `"name-only"`: listing 에 description 빼고 이름만 (토큰 절약)
- `"user-invocable-only"`: listing 에 안 들어감 (사용자 `/name` 만 됨)
- `"off"`: 양쪽 다 차단

`validateInput` 에서 `qe(z) === "off" | "user-invocable-only" && !im7(...)` 면 `skill_invoke_override_disabled` 에러.

### 3.8 Plugin tip / "cooldownSessions"

문서 prompt 가 언급한 `cooldownSessions: 3` — 이건 **skill** 의 필드가 아니라 **spinner-tip** (작업 대기 중 보여주는 hint) 의 필드 (line 20514). 예를 들어 `frontend-design-plugin` tip:

```js
{
  id: "frontend-design-plugin",
  priority: 1,
  providerAgnostic: true,
  content: async (H) => `Working with HTML/CSS? Install the frontend-design plugin:
${suggestion(`/plugin install stripe@${Zf}`)}`,
  cooldownSessions: 3,            // 마지막 표시 후 N 세션 동안 다시 안 보임
  isRelevant: async (H) => tZ6("stripe", H, {
    cli: ["stripe"],
    manifestDep: [
      {file: /(?:^|[/\\])package\.json$/i, pattern: /"stripe"\s*:|"@stripe\//},
      {file: /(?:^|[/\\])(?:requirements[^/\\]*\.txt|Pipfile)$/i, pattern: /^\s*stripe\b/im},
      {file: /(?:^|[/\\])pyproject\.toml$/i, pattern: /(?:^|[\s"',[])stripe["']?\s*[=>~]/im},
      {file: /(?:^|[/\\])Gemfile$/i, pattern: /gem\s+['"]stripe['"]/},
      {file: /(?:^|[/\\])go\.mod$/i, pattern: /github\.com\/stripe\/stripe-go/},
      {file: /(?:^|[/\\])composer\.json$/i, pattern: /"stripe\/stripe-php"/},
      {file: /(?:\.csproj|...)$/i, pattern: /Include="Stripe\.net"/i},
      {file: /(?:^|[/\\])(?:pom\.xml|build\.gradle(?:\.kts)?)$/i, pattern: /com\.stripe/}
    ]
  })
}
```

#### `pluginRelevance` (relevance helper, line 20506)

```js
async function tZ6(H, _, q) {        // (pluginName, sessionCtx, signals)
  if (!await ClK()) return false;
  if (mQ(`${H}@${Zf}`)) return false;            // 이미 설치돼 있으면 skip
  let {bashTools:K} = _ ?? {};
  // 1) cli 시그널 — 최근 실행된 bash 도구에 매칭되는 binary 있는지
  if (q.cli && K?.size) {
    if (q.cli.some($ => K.has($))) return true;
  }
  let O = _?.readFileState, T = O ? IFH(O) : [];
  // 2) filePath 시그널 — 최근 읽은 파일 경로가 regex 매칭
  if (q.filePath && T.some($ => q.filePath.test($))) return true;
  // 3) manifestDep 시그널 — 매니페스트 파일 내용 패턴 매칭 (최대 50ms timeout)
  if (q.manifestDep && O && T.length > 0) {
    let $ = new Map(O.entries());
    let z = (async () => {
      for (let {file:A, pattern:Y} of q.manifestDep)
        for (let w of T) {
          if (!A.test(w)) continue;
          try {
            let j = $.get(w);
            // 캐시된 본문 사용, 없으면 디스크 (>512KB 스킵)
            let J = j && j.limit === undefined && (j.offset ?? 1) <= 1 && !j.isPartialView
                    ? j.content : undefined;
            if (!J) {
              if ((await stat(w)).size > 524288) continue;
              J = await readFile(w, "utf8");
            }
            if (Y.test(J)) return true;
          } catch {}
        }
      return false;
    })();
    if (await fT(z, 50, "manifestDep scan").catch(() => false)) return true;
  }
  return false;
}
```

→ `Se3` (line 20507) 가 marketplace plugin 카탈로그를 fetch (`d7H(Zf)`) 해서 `plugin.relevance.signals` 가 있는 각 plugin 마다 동적으로 `{id, providerAgnostic, cooldownSessions:3, content, isRelevant: ctx => tZ6(pluginName, ctx, signals)}` 형태의 tip 을 생성.

**핵심 차이점**: `cooldownSessions` 는 plugin install **suggestion** (spinner tip) 의 빈도 제어이지, skill 실행의 cooldown 이 아님. `ytH(tipId) >= cooldownSessions` 이어야 다시 보임. `xe3` 가 sessions 횟수가 클수록 우선순위 가산.

### 3.9 Bundled skill 목록 (확인된 것)

slash command tab-completion 컨텍스트 + bundled skill 등록자에서:
- `claude-api` — Anthropic SDK 작성/마이그레이션 도우미 (line 20915, `h9O`)
- `init` — CLAUDE.md 초기화
- `review` — PR 리뷰
- `security-review` — 보안 리뷰 (line 17312)
- `update-config` — settings.json 설정 도우미 (line 20881)
- `fewer-permission-prompts` — transcript 분석 후 allowlist 추가
- `keybindings-help` — ~/.claude/keybindings.json 커스터마이즈
- `simplify` — 코드 리뷰
- `loop` — 슬래시/프롬프트 반복 실행 (`registerLoopSkill`, line 20883)
- `schedule` — 원격 cron agent (`registerScheduleRemoteAgentsSkill`)
- `dream` (registerDreamSkill, line 20917) — proposal 메커니즘

→ 모든 bundled skill 은 `pz({name, description, allowedTools, userInvocable, getPromptForCommand})` 로 `mA8` Map 에 등록 (path:`builtin`, source:`bundled`).

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 슬래시 커맨드 | 하드코딩 static (`/clear`, `/login`, …) | filesystem-discovered skill + bundled register + plugin/marketplace + MCP commands |
| 모델 자발적 호출 | 불가 (slash 만) | `Skill({skill, args?})` 도구 |
| 컨텍스트 모드 | inline 만 | `inline` + `fork` (subagent isolation, separate model/effort/agent) |
| Tool 권한 격리 | 없음 | skill 의 `allowed-tools` → `contextModifier` 가 turn-scope alwaysAllowRules.command 에 union |
| 모델 override | 없음 | skill frontmatter `model:` (`inherit` 옵션 포함) |
| Effort override | 없음 | skill frontmatter `effort:` (low/med/high/max/int) |
| 조건부 활성화 | 없음 | `paths:` gitignore-style glob + Read 시 자동 활성화 |
| 동적 발견 | 없음 | `dynamicSkillDirTriggers` Set + `.claude/skills/` upward search on file touch |
| Listing 전달 | 시스템 프롬프트 정적 | `skill_listing` attachment + delta (`cy8`) |
| Deferred tool | 없음 | `ToolSearch(query, max_results)` + `shouldDefer:true` + `tool_reference` 블록 |
| MCP slash command | 없음 | MCP server `prompts/list` → `loadedFrom:"mcp"` skill 로 합쳐짐 (`tn5`) |
| Permission rules | tool-level | `Skill(<name>)` / `Skill(<name>:*)` 매칭 |
| 텔레메트리 attribution | 없음 | `_PROTO_skill_name`, `_PROTO_plugin_name`, `_PROTO_marketplace_name` (proto-only, server scrub) |
| skillsAsTools (실험) | 없음 | `isSkillsAsToolsEnabled()` gate — skill 을 도구로 직접 노출하면 listing 생략 |

### v2.1.143 신규 식별자 요약

| Minified | 의미 | 라인 |
|---|---|---|
| `ff` | `"Skill"` 도구명 상수 | 8334 |
| `d$` | `"ToolSearch"` 도구명 상수 | 8329 |
| `Skill` | Skill tool definition | 12888 |
| `ToolSearch` | ToolSearch tool definition | 13750 |
| `Hi5` | Skill input Zod | 12888 |
| `_i5` | Skill output Zod (inline\|forked union) | 12888 |
| `en5` | fork-context skill 실행 | 12886 |
| `mq8` | Skill input → skill name extraction (텔레메트리용) | 5578 |
| `cy8` | skill_listing attachment 생성기 | 14313 |
| `M73` | dynamic_skill attachment (트리거 dir → skillNames) | 14308 |
| `snH` | file-touch 시 .claude/skills 후보 dir 등록 | 14689 |
| `tnH` | dynamic skill dir 로드 | 14691 |
| `enH` | conditional skill `paths` 매칭 활성화 | 14693 |
| `kE8` | skill object 빌더 (getPromptForCommand 포함) | 14672 |
| `LE8` | frontmatter parser | 14671 |
| `hrH` | 디렉토리에서 skill 들 로드 | 14675 |
| `NE8` | top-level skill aggregator (memo) | 14695 |
| `mf` | global skill state (dynamicSkillDirs/dynamicSkills/conditionalSkills/activated) | 14685 |
| `vE8` | mf 초기 state | 14685 |
| `qi5` | skill metadata key 화이트리스트 (auto-allow 검사) | 12889 |
| `Ki5` | "필드 다 metadata 뿐인가?" 검사 | 12887 |
| `startSkillDiscoveryPrefetch호출자` | skill discovery prefetch module accessor (lazy) | 14057 |
| `Vw6` / `kw6` | listing dedup state (per-agent sent set) | 14309-14313 |
| `pA8` | bundled plugin enabled/disabled split | 8594 |
| `mA8` | bundled plugin registry Map | 8596 |
| `pluginRelevance` | plugin install relevance helper (cli/filePath/manifestDep) | 20506 |
| `Se3` | marketplace plugin → tip 동적 생성 | 20507 |
| `yn7` | ToolSearch keyword scoring | 13740 |
| `Nn7` | ToolSearch description cache invalidation | 13735 |
| `hiH` | ToolSearch 결과 wrapping | 13737 |
| `vn7` | tool name tokenization (camel/snake → parts) | 13738 |

### 미확인 / 추정

- `Uy8?.().startSkillDiscoveryPrefetch` 의 정확한 내부 작업 — minified module accessor 만 노출. **추정**: `M73` 와 유사한 dir 스캔 + remote registry fetch 를 turn 추론과 병렬화. `discoveredRemoteSkills: Map` 은 그 결과 (org-wide guide / marketplace tip / curated skill set 등). 부모→자식 agent 로 전파됨 (`forkToolUseContext` 의 `H.discoveredRemoteSkills ?? new Map`).
- skill 의 `fallback: true` 동작 — frontmatter parser 가 boolean 으로 보관만 하고, `tn5` dedup 시 같은 이름의 plugin/mcp skill 이 있으면 양보. 확인되지 않은 부분: `<plugin>:<name>` / `<server>:<name>` 명명 규약 매칭.
- "skills-as-tools" 실험 (`x93?.isSkillsAsToolsEnabled()`) — skill 을 정식 tool 로 노출하는 모드. 활성화되면 `cy8` 이 빈 배열 반환 → listing 생략. 모델은 도구 카탈로그에서 skill 을 봄.
