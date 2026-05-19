# Subagent system — `Agent` / `Task` / `TaskOutput` / `TaskStop`

v2.1.143 의 서브에이전트 시스템은 v0.2.8의 단일 `AgentTool`(fire-and-forget) 모델을 완전히 재설계하여 **하나의 spawn 도구 (`Agent`)** 와 **세 개의 background 라이프사이클 도구 (`Task`/`TaskOutput`/`TaskStop`)** 로 분할되었다 — 다만 `Task`는 별개의 도구가 아니라 `Agent` 의 alias 이고, 동기 / 비동기 분기는 `run_in_background` 입력 또는 agent 정의의 `background:true` 로 결정된다. 식별자/문자열 단서:

- `J7 = "Agent"` (line 5758, `WY` 모듈)
- `Fu = "Task"` (line 5758, 같은 모듈) — `Agent` 의 alias
- `Dn = "TaskOutput"` (line 8330)
- `Mm = "TaskStop"` — 상수 값은 `extracted-functions.js` 에 직접 보이지 않지만 (`name:Mm` line 13551 만 등장) legacy alias 매핑이 `KillShell → TaskStop` 임을 확정한다 (line 3600, `Wm6`):
  ```
  Wm6 = {Task:"Agent", KillShell:"TaskStop",
         AgentOutputTool:"TaskOutput", BashOutputTool:"TaskOutput",
         ListPeers:"ListAgents", Brief:"SendUserMessage"};
  ```
- `IX = "Monitor"` — `TaskStop` 도 stop 대상으로 사용
- `FL9 = new Set(["Explore","Plan"])` (line 5758, `WY`) — built-in 서브에이전트 타입 이름 집합

---

## 1. 호출 그래프

```
[Bq3 turn loop]   ← parent
  └ tool_use{name:"Agent"|"Task"}
        └ Agent.call({prompt, subagent_type, model, run_in_background, name, team_name, mode, isolation, cwd})
            ├ 1. 권한·팀·격리 검증, agent_type 검색 (활성 목록에서 매칭)
            ├ 2. 모델 결정 ujH(v.model, mainLoopModel, override, perm.mode)
            ├ 3. agent_type.getSystemPrompt({toolUseContext}) → system prompt 문자열
            ├ 4. 도구 필터링: hHH(...) — agent.tools / agent.disallowedTools 적용
            ├ 5. worktree isolation 이면 Jf_() 로 임시 git worktree 생성
            ├ 6. taskRegistry.register(...)  ← TaskCreated 이벤트 source
            │     knH(...) (background) 또는 Ym7(...) (foreground, auto-bg timer 포함)
            ├ 7. 자식 query 시작
            │     elH({taskId, makeStream:(p,q) => Sb({...JH, override:{agentId, abortController}, ...})})
            │       └ Sb(...) — `runTurnLoop`(...) 호출의 SDK-측 wrapper. 자식 Bq3 가 동작.
            │       └ ED8(parent ctx, {agentId, agentType, ...}) → child ToolUseContext
            │           (queryTracking.chainId 새로 생성, queryTracking.depth = parent+1)
            ├ 8a. (background = run_in_background || agent.background || auto-bg timer 만료)
            │     ├ 결과를 await 하지 않고 즉시 반환:
            │     │   { status:"async_launched", agentId, description, prompt, outputFile, canReadOutputFile }
            │     └ 비동기 결과 누적은 lw_(...) 가 ToolUseContext.taskRegistry 에 push
            └ 8b. (foreground, default)
                  ├ 자식 stream 소비 → message 누적, progress 발행
                  ├ vT6() 가 최종 message 들을 합쳐 ToolResultBlockParam 으로 변환
                  ├ ST6() 또는 SM_() 가 taskRegistry 에 status:"completed"/"failed" 기록
                  └ TaskCompleted 이벤트, hook fire, EH("subagent_complete")
                  최종 반환: { status:"completed", prompt, ...result, ...worktreeInfo }

[ separately ]
TaskOutput.call({task_id, block, timeout})
  └ q.getAppState().tasks[task_id] 조회
     └ block=true → yH3(task_id, getAppState, timeout, abortCtrl) 폴링
        → status 가 "running"/"pending" 아니면 retrieval_status:"success" + task 객체
        → 시간초과시 retrieval_status:"timeout"

TaskStop.call({task_id})
  └ EA6(task_id, {taskRegistry, setAppState, callerAgentId})
     ├ taskRegistry.get(task_id)
     ├ owner 검증 (Mc7), status==="running" 검증
     ├ task type 별 kill: Jc7(type).kill(id, registry, setAppState)
     │     local_agent → A4H(taskId, registry) — abortController.abort()
     │     local_bash  → lVH(taskId, registry) — child kill + cleanup
     │     monitor     → 동일 (lVH)
     └ 결과: { taskId, taskType, command }
```

`Sb(...)` 는 추출본에서 명시적으로 정의되지 않지만 (line 12816 의 `Agent.call` 내부에서 호출), `elH/makeStream` 시그니처와 `forkToolUseContext` 호출 패턴을 보면 **상위 `runTurnLoop` 와 동일한 generator 를 새로운 ToolUseContext 로 실행** 함이 확정적이다 (확인 — line 12816 의 `dH=Sb({...JH, override:{...JH.override,agentId:KH}})[Symbol.asyncIterator]()` 가 stream 으로 소비됨).

---

## 2. 핵심 로직 — 의사코드

### 2.1 `Agent` (= `Task` alias) — line 12816 `Am7 = X9({...})`

```js
Am7 = X9({
  name: J7,                                          // "Agent"
  aliases: [Fu],                                     // "Task"
  searchHint: "delegate work to a subagent",
  maxResultSizeChars: 1e5,
  async description() { return "Launch a new agent" },
  get inputSchema() { return pL8() },                // ← Zod, 아래 §3
  get outputSchema() { return Sn5() },               // ← Zod, async_launched | completed | teammate_spawned

  async prompt({agents, tools, getToolPermissionContext, allowedAgentTypes, model}) {
    // 메인 prompt 빌더 — 활성 agent 들의 whenToUse 를 합쳐 description 작성
    let T = await getToolPermissionContext();
    let availableMcpServers = [...];                 // tools 에서 e7H 로 추출
    let z = wY_(agents, $);                          // requiredMcpServers 만족 필터
    let A = LnH(z, T, J7);                           // permission rule (Agent(type)) 필터
    return await g97(A, model, false, allowedAgentTypes);
  },

  async call({prompt:H, subagent_type:_, description:q, model:K, run_in_background:O,
              name:T, team_name:$, mode:z, isolation:A, cwd:Y}, w, j, J, D) {
    let M = Date.now();
    let f = OYH() ? undefined : K;                   // model override
    let X = w.getAppState();
    let P = w.getToolPermissionContext();
    let { taskRegistry: W } = w;                     // ← parent ctx 의 registry

    // ── 팀 / 격리 / 재귀 fork 등 거부 케이스 ──
    if ($ && !K7())  throw "Agent Teams not available";
    if (KO() && G && T) throw "Teammates cannot spawn teammates";
    if (X0() && G && O===true) throw "in-process teammate cannot spawn background";

    // ── teammate (named, with team_name) 분기 ──
    if (G && T) {
      let teammate = await FS7({name:T, prompt:H, ...}, w);
      return { data: { status:"teammate_spawned", prompt:H, ...teammate.data } };
    }

    // ── agent_type 결정 ──
    let L = _ ?? (XG() ? undefined : _e.agentType);   // _e = built-in 기본 (general-purpose)
    let k = L === undefined;                          // fork 모드 여부
    let v;
    if (k) {
      // fork 가능 여부 검증, FORK_AGENT (mE) 사용
      v = mE;                                          // bn9="fork", mE = FORK_AGENT
    } else {
      // 활성 agent 목록에서 검색, normalize, permission rule 확인, deny 처리
      let KH = w.options.agentDefinitions.activeAgents;
      let YH = w.options.agentDefinitions.allowedAgentTypes;
      let TH = LnH(YH ? KH.filter(x => YH.includes(x.agentType)) : KH, P, J7);
      v = TH.find(x => x.agentType === L);
      if (!v) { /* fuzzy match by zm7-normalize, throw with suggestions */ }
    }

    // ── MCP 요구사항 대기 (최대 30초) ──
    if (v.requiredMcpServers?.length) {
      while (Date.now() < deadline) {
        if (모든 required server 가 connected/failed) break;
        await r6(500);
      }
      if (!z86(v, availableMcpTools))
        throw "Agent '...' requires MCP servers matching: ...";
    }

    // ── 모델·시스템 prompt 결정 ──
    let I = ujH(v.model, w.options.mainLoopModel, k?undefined:f, P.mode);
    w.agentLifecycle.markTypeInvoked(v.agentType);
    let C = v.getSystemPrompt({toolUseContext: w});

    // ── 텔레메트리 ──
    d("tengu_agent_tool_selected", {agent_type:v.agentType, model:I,
       is_built_in_agent: HM(v), is_async: (O||v.background) && !RnH, is_fork:k, ...});

    let p = A ?? v.isolation;                          // "worktree" 또는 undefined
    let S, x, F;                                       // S=systemPromptArr, x=forkSystemPrompt, F=initialMsgs

    if (k) {
      // FORK — parent system prompt + 직전 conversation 을 그대로 상속
      x = (w.renderedSystemPrompt) || Gb({...});
      F = Ez8(H, J);                                   // forked context 마커 메시지 (mt.ts)
    } else {
      S = await Df_([C], I, additionalDirs);            // 시스템 prompt 조립
      F = [D6({content: H})];
    }

    // ── permission/도구 필터링 ──
    let qH = {...P, mode: v.permissionMode ?? "acceptEdits"};
    let HH = hHH(qH, mcpAndCustom, {skipReplFilter:true, skillTools:appState.skillTools});

    let o = pm();                                      // 새 agentId 생성
    let s = CJ()?.agentId;                             // parent agentId

    // ── worktree 격리 ──
    let wH = (p === "worktree") ? await Jf_(gL8(o)) : null;
    if (k && wH) F.push(D6({content: Sz8(E_(), wH.worktreePath)}));

    let JH = {
      agentDefinition: v, promptMessages: F, toolUseContext: w, canUseTool: j,
      name: T, isAsync: r, querySource: w.options.querySource ?? qdH(v.agentType, HM(v)),
      spawnedBySkill: w.options.spawnedBySkill ?? w.options.activeSkill,
      model: k ? undefined : f,
      override: k
        ? { systemPrompt: x, replHydration:{kind:"fork", log:[...parentReplLog]} }
        : (S && !wH && !Y) ? { systemPrompt: H4(S) } : undefined,
      availableTools: k ? w.options.tools : HH,
      forkContextMessages: k ? w.messages : undefined,
      ...(k && { useExactTools: true }),
      worktreePath: wH?.worktreePath, cwd: Y, description: q,
    };

    let _H = Y ?? wH?.worktreePath;                    // child cwd

    let r = (O===true || v.background===true) && !RnH; // async 여부

    if (r) {
      // ─────── BACKGROUND PATH ───────
      let YH = knH({ agentId:o, description:q, prompt:H, selectedAgent:v,
                     taskRegistry:W, toolUseId:w.toolUseId, cwd:_H });
      if (T) w.agentLifecycle.registerName(T, WT(o));
      let TH = { agentId:o, parentAgentId:s, parentSessionId:dU(),
                 agentType:"subagent", subagentName:v.agentType, isBuiltIn:HM(v),
                 invokingRequestId:J?.requestId, invocationKind:"spawn",
                 invocationEmitted:false };
      QU(TH, () => kq_(_H, () => elH({
        taskId: YH.agentId,
        abortController: YH.abortController,
        makeStream: (cacheParams, onProgress) =>
          Sb({...JH, override:{...JH.override, agentId:WT(YH.agentId),
                                abortController:YH.abortController},
              onCacheSafeParams:cacheParams, onQueryProgress:onProgress}),
        metadata: g, description:q, toolUseContext:w, taskRegistry:W,
        agentIdForCleanup: o, enableSummarization: XG() || Mo(),
        getWorktreeResult: t,
      })));
      EH("subagent_launch");
      return { data: { isAsync:true, status:"async_launched", agentId:YH.agentId,
                       description:q, prompt:H, outputFile:hz(YH.agentId),
                       canReadOutputFile: hasReadOrBash } };
    } else {
      // ─────── FOREGROUND PATH ───────
      // 1) Ym7(...) 로 taskRegistry 에 등록 + auto-background timer (yn5() ms 후 자동 백그라운드화)
      let { taskId:fH, backgroundSignal:GH, cancelAutoBackground:kH } =
        Ym7({agentId:KH, description:q, prompt:H, selectedAgent:v,
             taskRegistry:W, toolUseId:w.toolUseId,
             autoBackgroundMs: yn5() || undefined, cwd:_H});
      let dH = Sb({...JH, override:{...JH.override, agentId:KH}})[Symbol.asyncIterator]();
      let TH = [];   // 자식이 emit 한 모든 메시지 수집

      try {
        while (true) {
          // 2sec 이상 진행 안 되면 setToolJSX 로 "백그라운드 hint" UI 표시
          let eH = backgroundSignal awaited ? Promise.race(...) : await dH.next();

          if (eH.type === "background" && fH) {
            // ── auto-background 트리거! ──
            // → return Sb(...) 의 나머지 stream 을 background QU 컨텍스트에서 계속 실행
            //   이후 taskRegistry update + EH("subagent_complete") + task_notification
            //   동기 호출자에게는 즉시 status:"async_launched" 반환
            return { data: { isAsync:true, status:"async_launched", ... } };
          }

          let { result:oH } = eH;
          if (oH.done) break;
          let O_ = oH.value;
          TH.push(O_);
          cjH(jH, O_, ...);                            // 누적 stats
          if (fH) {
            let G_ = yT6(O_);
            if (G_) { hT6(jH, fH, w.toolUseId, q, zH, G_, v.agentType);
                      if (Mo()) IM_(fH, z4H(jH), W) }
          }

          // progress 발행
          if (O_.type==="progress" && (O_.data.type==="bash_progress"||...)) D({...});
          if (O_.type==="assistant" || O_.type==="user") {
            for (let G_ of a0([O_]))
              D({ type:"progress", toolUseID:`agent_${J.message.id}`,
                  data:{ message:G_, type:"agent_progress", prompt:"",
                         agentId:KH, agentType:v.agentType, description:q } });
          }
        }
      } catch (pH) { if (pH instanceof PO) throw rH=true, pH; gH = N8(pH); }
      finally {
        if (w.setToolJSX) w.setToolJSX(null);
        if (fH) {
          wm7(fH, W);   // task 정리
          if (!ZH) tv({type:"system", subtype:"task_notification",
                       task_id:fH, status: gH ? "failed" : rH ? "stopped" : "completed",
                       output_file:"", summary:q, usage:{...}});
        }
        if (!ZH) Bw_(KH);            // SubagentStop hook 의 트리거 측 정리
        if (kH) kH(); if (!ZH) aH = await t();         // worktree 정리
      }

      // 최종 result 생성
      let RH = vT6(TH, KH, g);                          // collect → ToolResultBlockParam
      let pH = await ET6({agentMessages:TH, tools, ...}); // 옵션: hook 으로 finalize text
      if (pH) RH.content = [{type:"text", text:pH}, ...RH.content];

      if (!gH) EH("subagent_complete");
      return { data: { status:"completed", prompt:H, ...RH, ...aH } };
    }
  },

  isReadOnly() { return true },
  isConcurrencySafe() { return true },
  async checkPermissions(H, _) { return { behavior:"allow", updatedInput:H } },
  ...
});
```

### 2.2 `TaskOutput` — line 13673 `sA6 = X9({...})`

```js
sA6 = X9({
  name: Dn,                                            // "TaskOutput"
  aliases: ["AgentOutputTool", "BashOutputTool"],      // legacy
  searchHint: "read output/logs from a background task",
  maxResultSizeChars: 1e5,
  shouldDefer: true,
  userFacingName() { return "Task Output" },
  get inputSchema() { return vH3() },                  // ← {task_id, block?, timeout?}
  async description() {
    return "[Deprecated] — for bash and remote_agent tasks, prefer Read on the output file path; "
         + "for local_agent tasks, use the Agent tool result directly";
  },
  isReadOnly() { return true },

  async validateInput({task_id:H}, {getAppState:_}) {
    if (!H) return {result:false, message:"Task ID is required", errorCode:1};
    if (!_().tasks?.[H]) return {result:false, message:`No task found with ID: ${H}`, errorCode:2};
    return {result:true};
  },

  async call({task_id:T, block:$, timeout:z}, _, q, K, O) {
    let Y = _.getAppState().tasks?.[T];
    if (!Y) throw Error(`No task found with ID: ${T}`);

    if (!$) {
      // non-blocking: 단일 snapshot
      if (Y.status !== "running" && Y.status !== "pending") {
        _.taskRegistry.update(T, j => ({...j, notified:true}));
        return { data: { retrieval_status:"success", task: await aA6(Y) } };
      }
      return { data: { retrieval_status:"not_ready", task: await aA6(Y) } };
    }

    // blocking: 폴링
    if (O) O({type:"progress", toolUseID:`task-output-waiting-${Date.now()}`,
              data:{type:"waiting_for_task", taskDescription:Y.description,
                    taskType:Y.type}});
    let w = await yH3(T, _.getAppState, z, _.abortController);
    //          ↑ 100ms 간격 폴링, deadline 또는 status 변경시 반환
    if (!w) return { data: { retrieval_status:"timeout", task:null } };
    if (w.status==="running" || w.status==="pending")
      return { data: { retrieval_status:"timeout", task: await aA6(w) } };
    _.taskRegistry.update(T, j => ({...j, notified:true}));
    return { data: { retrieval_status:"success", task: await aA6(w) } };
  },

  mapToolResultToToolResultBlockParam(H, _) {
    // <retrieval_status>...</retrieval_status>
    // <task_id>...</task_id>
    // <task_type>...</task_type>
    // <status>...</status>
    // <exit_code>...</exit_code>
    // <output>...</output>
  },
});
```

### 2.3 `TaskStop` — line 13551 `SA6 = X9({...})`

```js
SA6 = X9({
  name: Mm,                                            // "TaskStop"
  aliases: ["KillShell"],                              // legacy
  searchHint: "kill a running background task",
  maxResultSizeChars: 1e5,
  userFacingName: () => "Stop Task",
  get inputSchema() { return Ze5() },                  // ← {task_id?, shell_id?}
  get outputSchema() { return Ge5() },                 // ← {message, task_id, task_type, command?}
  shouldDefer: true,
  isConcurrencySafe() { return true },

  async validateInput({task_id:H, shell_id:_}, {taskRegistry:q}) {
    let K = H ?? _;
    if (!K) return {result:false, message:"Missing required parameter: task_id", errorCode:1};
    let O = q.get(K);
    if (!O) return {result:false, message:`No task found with ID: ${K}`, errorCode:1};
    if (O.status !== "running")
      return {result:false, message:`Task ${K} is not running (status: ${O.status})`, errorCode:3};
    return {result:true};
  },

  async description() { return "Stop a running background task by ID" },

  async call({task_id:H, shell_id:_}, q) {
    let T = H ?? _;
    let $ = await EA6(T, {taskRegistry:q.taskRegistry, setAppState:q.setAppState,
                          callerAgentId:LA6(q)});
    return { data: { message:`Successfully stopped task: ${$.taskId} (${$.command})`,
                     task_id:$.taskId, task_type:$.taskType, command:$.command } };
  },
});
```

`EA6` (line 13547) — 실제 stop 디스패처:

```js
async function EA6(H, {taskRegistry:q, setAppState:K, callerAgentId:O}) {
  let T = q.get(H);
  if (!T)                          throw new MX_(`No task found with ID: ${H}`, "not_found");
  if (T.status !== "running")      throw new MX_(`Task ${H} is not running ...`, "not_running");
  if (!Mc7(O, T.agentId))          throw new MX_(`Task ${H} is owned by ... agent ${O} cannot stop it.`, "not_owner");
  let $ = Jc7(T.type);             // type-별 stopper 등록부
  if (!$)                          throw new MX_(`Unsupported task type: ${T.type}`, "unsupported_type");
  await $.kill(H, q, K);           // ex) GA6.kill = A4H (local_agent)
                                   //     local_bash → lVH
                                   //     monitor    → lVH
  if (QV(T)) {
    // 알림 디듀프
    q.update(H, Y => Y.notified ? Y : {...Y, notified:true});
    ow(H, "stopped", {toolUseId:T.toolUseId, summary:T.description});
  }
  if (QV(T) && T.agentId !== undefined && O !== T.agentId)
    Wc7({taskId:H, toolUseId:T.toolUseId, description:T.description, ownerAgentId:T.agentId});
  let z = QV(T) ? T.command : T.description;
  return { taskId:H, taskType:T.type, command:z };
}
```

`local_agent` kill 은 `A4H(taskId, registry)` — taskRegistry 의 abortController 를 발화시켜 child `runTurnLoop` 의 `signal.aborted` 분기 (line 14057 `if (Z.abortController.signal.aborted) ...`) 가 reason `"aborted_tools"` / `"aborted_streaming"` 으로 종료. `local_bash` / `monitor` 는 `lVH` 가 `shellCommand.kill()` + `cleanup()` 호출.

---

## 3. State / Schema

### 3.1 Agent 입력 스키마 — `hn5` / `En5` / `pL8` (line 12816)

```ts
// base shared (hn5)
{
  description: string         // 3–5 word summary
  prompt:      string         // task body for the subagent
  subagent_type?: string      // 미지정시: fork (XG() true) | _e.agentType (기본)
  model?: "sonnet" | "opus" | "haiku"
  run_in_background?: boolean // true → status:"async_launched" 즉시 반환
}

// + teammate extension (En5)
{
  name?:      string          // SendMessage({to:name}) 로 주소 지정 가능하게
  team_name?: string          // 팀 컨텍스트 (생략시 현재)
  mode?:      PermissionMode  // "plan" 등
  isolation?: "worktree"
  cwd?:       string          // absolute, isolation:"worktree" 와 상호배타
}

// final input schema (pL8)
//   = En5().omit({cwd})  → RnH(BG disabled) 또는 XG()(fork SDK) 이면 추가로 omit run_in_background
```

### 3.2 Agent 출력 스키마 — `Sn5` (line 12816)

```ts
type AgentOutput =
  | { status: "completed", prompt: string, ...result }
  | { status: "async_launched",
      agentId: string,            // task_id
      description: string,
      prompt: string,
      outputFile: string,         // hz(agentId) — transcript path
      canReadOutputFile?: boolean } // caller 가 Read/Bash 권한이 있는지
  | { status: "teammate_spawned", prompt: string, ... }    // 팀 모드
```

### 3.3 TaskOutput 입력 — `vH3` (line 13673)

```ts
{
  task_id: string,
  block?:  boolean = true,      // 폴링/blocking 여부
  timeout?: number = 30000,     // ms, [0, 600000]
}
```

### 3.4 TaskStop 입력/출력 — `Ze5` / `Ge5`

```ts
// input
{ task_id?: string, shell_id?: string }   // shell_id 는 deprecated alias

// output
{
  message: string,                        // "Successfully stopped task: ..."
  task_id: string,
  task_type: string,                      // "local_agent" | "local_bash" | "monitor" | ...
  command?: string                        // bash 면 명령, agent 면 description
}
```

### 3.5 `taskBudget` — line 14057 (`runTurnLoop`) + line 19033 (`oB3`)

`runTurnLoop` 함수 시그니처에 `taskBudget?: {total, remaining?}` 가 들어있고, ent ry 시점에 `f = undefined`. 매 컴팩션 직후 (reactive 또는 autocompact 성공시) **남은 budget 을 마지막 assistant turn 의 토큰 사용량 만큼 감소** 시킨다:

```js
if (H.taskBudget) {
  let B_ = RA8(x);                            // 마지막 assistant message 의
                                              // (input_tokens + output_tokens) — line 8504
  f = Math.max(0, (f ?? H.taskBudget.total) - B_);
}
```

매 API 요청마다 `options.taskBudget = {total, remaining: f}` 로 페이로드에 첨부되며 (line 14057, query-loop options), `oB3(H, _, q)` 가 **server-side body 의 `task_budget` 필드와 beta header `$F_` 를 더한다** — 즉 task budget 은 **서버가 강제**한다:

```js
// oB3
if (!H || "task_budget" in _ || !CR()) return;
_.task_budget = { type: "tokens", total: H.total,
                  ...(H.remaining !== undefined && { remaining: H.remaining }) };
if (!q.includes($F_)) q.push($F_);            // beta header (값은 추출본에 미노출)
```

budget 소진시 거동: `oB3` 자체는 단순 첨부이며 클라이언트 측에 `if (budget===0) abort` 같은 코드는 보이지 않는다. 서버가 응답에서 stop signal 또는 prompt_too_long 류 에러로 처리한다고 **추정**. `runTurnLoop` 의 `reason: "max_turns"` / `"completed"` 분기 외에 별도 budget exhausted 분기는 없다.

### 3.6 `RA8(messages)` — line 8504

```js
function RA8(H) {                              // last-assistant turn token count
  let _ = H.length - 1;
  while (_ >= 0) {
    let q = H[_], K = q ? wYH(q) : undefined;
    if (K) {
      let O = K.iterations;
      if (O && O.length > 0) {
        let T = O.at(-1);
        return T.input_tokens + T.output_tokens;  // 직전 iteration usage
      }
      return K.input_tokens + K.output_tokens;
    }
    _--;
  }
  return 0;
}
```

`wYH` 는 message → usage object 추출기. 즉 RA8 은 **마지막 assistant 메시지 한 턴의 in+out 토큰**만 본다 (cache 토큰 제외).

### 3.7 `taskRegistry` — line 9522 `$y`

`ToolUseContext.taskRegistry` 의 형태:

```ts
type TaskRegistry = {
  register(task: TaskState): void
  update(id: string, fn: (t: TaskState) => TaskState): void
  remove(id: string): void
  evictTerminal(predicate): void
  applyOffsetsAndEvict(...): void
  get(id: string): TaskState | undefined
  all(): Record<string, TaskState>
}
```

실제 저장소: `appState.tasks: Record<string, TaskState>` — `getAppState/setAppState` 가 in-memory Zustand-style store 를 갱신. **파일/SQLite 미사용** (확인 — `appState.tasks` 외 별도 persistence layer 가 추출본에서 보이지 않음. 단 transcript / output file (`hz(taskId)`) 은 `~/.claude/` 하위 디스크에 기록 — line 13138 `Ww` 클래스 의 `this.path` ).

`update` 가 변경하면 자동으로 `tv({type:"system", subtype:"task_updated", task_id, patch})` 가 stdout 으로 송출되어 외부 SDK 호스트가 동기화 — line 9523 `c$5`.

### 3.8 TaskState 모양 — line 18755 `OW` + line 15151 `knH`

```ts
type TaskState =
  | LocalAgentTask {
      // base (OW)
      id: string                  // = agentId
      type: "local_agent"
      status: "pending" | "running" | "completed" | "failed" | "killed" | "paused"
      description: string
      toolUseId: string
      startTime: number
      outputFile: string          // hz(agentId)
      outputOffset: number
      notified: boolean
      // local_agent extras (knH/Ym7)
      agentId: string
      prompt: string
      cwd?: string
      selectedAgent: AgentDefinition
      agentType: string           // selectedAgent.agentType ?? "general-purpose"
      abortController: AbortController
      retrieved: boolean
      lastReportedToolCount: number
      lastReportedTokenCount: number
      isBackgrounded: boolean
      pendingMessages: any[]
      retain: boolean
      diskLoaded: boolean
      keepaliveReasons: Set<string>
      result?: ToolResult         // completed 시 채워짐 (ST6)
      error?: string              // failed 시 (SM_)
      endTime?: number
      evictAfter?: number
    }
  | LocalBashTask  { type: "local_bash", command: string, shellCommand: ChildProcess, ... }
  | MonitorTask    { type: "monitor", command: string, ... }
  | RemoteAgentTask{ type: "remote_agent", ... }
  | InProcessTeammateTask { type: "in_process_teammate", isIdle: boolean, ... }
  | LocalWorkflowTask     { type: "local_workflow", ... }
  | DreamTask             { type: "dream", ... }
```

terminal status 집합: `dI(s) = s === "completed" || "failed" || "killed"` (line 18750).
ID prefix 매핑 — `fp3` (line 18755):
- `local_bash → "b"`,  `local_agent → "a"`,  `remote_agent → "r"`,
- `in_process_teammate → "t"`,  `local_workflow → "w"`,  `monitor_mcp → "m"`,
- `mcp_task → "k"`,  `dream → "d"`.

### 3.9 Hook 페이로드 — agent_id / agent_type — line 9615

기본 hook envelope `hookPayloadBase`:

```ts
{
  session_id: string,
  transcript_path: string,
  cwd: string,
  permission_mode?: string,
  agent_id?:   string,    // "Subagent identifier. Present only when the hook
                          //  fires from within a subagent (e.g., a tool called
                          //  by an AgentTool worker). Absent for the main thread,
                          //  even in --agent sessions."
  agent_type?: string,    // "Agent type name (e.g., 'general-purpose',
                          //  'code-reviewer'). Present when the hook fires from
                          //  within a subagent (alongside agent_id), or on the
                          //  main thread of a session started with --agent
                          //  (without agent_id)."
  effort?: { level: "low"|"medium"|"high"|"xhigh"|"max" }
}
```

서브에이전트 라이프사이클 hook 페이로드:

| hook | 추가 필드 |
|---|---|
| `SubagentStart` (`cz5`) | `agent_id`, `agent_type` |
| `SubagentStop`  (`lz5`) | `agent_id`, `agent_transcript_path`, `agent_type`, `stop_hook_active`, `last_assistant_message?` |
| `TaskCreated`   (`oz5`) | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
| `TaskCompleted` (`az5`) | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |

**TaskCreated / TaskCompleted 는 팀 또는 background 라이프사이클** 이며, `teammate_name?` 를 갖는 점으로 보아 teammate / cron / monitor 등을 포함하는 범용 task 이벤트. 서브에이전트 spawn 시점의 hook 은 `SubagentStart`이며, **TaskCreated 가 spawn 시 같이 발화되는지는 추출본에서 명시적으로 확인 안 됨** (추정 — `taskRegistry.register` 시점에 `tv({type:"system", subtype:"task_started", ...})` SDK 이벤트는 발화되지만 그것은 stdout 메시지일 뿐 hook 은 아니다. TaskCreated/TaskCompleted hook 의 fire site 는 다른 모듈에 있어 본 그렙으로는 미확정).

### 3.10 자식 ToolUseContext 분기 — `forkToolUseContext` (line 9845)

```js
function ED8(parent, opts) {
  return {
    ...parent (대부분 공유),
    abortController: opts.abortController ?? (opts.shareAbortController ? parent.abortController : ev(parent.abortController)),
    getAppState:     opts.getAppState ?? (opts.shareAbortController ? parent.getAppState : wrapped),
    ...
    isolationLatch:  opts.isolationLatch ?? parent.isolationLatch,
    taskRegistry:    parent.taskRegistry,       // ← 부모와 공유
    sessionHooksRegistry: parent.sessionHooksRegistry,
    agentLifecycle:  parent.agentLifecycle,     // ← 부모와 공유 (markTypeInvoked 등)
    abortSpeculation: parent.abortSpeculation,
    teammateColors:  parent.teammateColors,
    options:         opts.options ?? parent.options,
    messages:        opts.messages ?? parent.messages,
    turnStartIndex:  0,
    agentId:         opts.agentId ?? pm(),       // ← 자식 agentId 새로 생성
    agentType:       opts.agentType,             // ← 자식 agentType
    precomputeSourceKey: opts.precomputeSourceKey,
    queryTracking: {
      chainId: R47.randomUUID(),                 // ← 새 chainId
      depth:   (parent.queryTracking?.depth ?? -1) + 1,  // ← depth +1
    },
    requireCanUseTool: opts.requireCanUseTool,
    criticalSystemReminder_EXPERIMENTAL: opts.criticalSystemReminder_EXPERIMENTAL,
  };
}
```

즉 **자식 Bq3 는 부모와 `taskRegistry`, `sessionHooksRegistry`, `agentLifecycle`, `isolationLatch` 를 공유**하지만 `agentId`/`agentType` 은 다르며, `queryTracking` 은 새 chain 이 시작된다 (chainId 새로, depth +1). 텔레메트리 (`tengu_query_*`) 의 모든 이벤트에 `queryChainId` / `queryDepth` 가 첨부되어 부모-자식 관계가 추적 가능.

### 3.11 Built-in agent 정의

#### `Explore` — line 9266 `He`

```ts
{
  agentType: "Explore",
  whenToUse: "Fast read-only search agent for locating code...",
  disallowedTools: [J7 /*Agent*/, E0, k7 /*Edit*/, _4 /*Write*/, CP /*NotebookEdit*/],
  source: "built-in",
  baseDir: "built-in",
  model: "haiku",                      // 기본 모델
  omitClaudeMd: true,
  getSystemPrompt: () => YT5(),         // YT5: "You are an agent for Claude Code, ...
                                       //   Complete the user's search request efficiently
                                       //   and report your findings clearly."
}
```

#### `Plan` — line 9267 `$86`

```ts
{
  agentType: "Plan",
  whenToUse: "Software architect agent for designing implementation plans...",
  disallowedTools: [J7, E0, k7, _4, CP],
  source: "built-in",
  tools: He.tools,                      // Explore 와 동일 도구셋
  baseDir: "built-in",
  model: "inherit",                     // 부모 모델 상속
  omitClaudeMd: true,
  getSystemPrompt: () => DT5(),         // DT5: "...REMEMBER: You can ONLY explore and plan.
                                       //   You CANNOT and MUST NOT write, edit,
                                       //   or modify any files. You do NOT have
                                       //   access to file editing tools."
}
```

#### Built-in 목록 빌더 — `pgH()` (line 9271)

```js
function pgH() {
  if (xH(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) && R8()) return [];
  let H = [_e, c87];                                 // _e = general-purpose, c87 = statusline-setup
  if (!amH()) H.push(CLAUDE_AGENT);                  // claude-agent (SDK)
  if (AY_()) H.push(He, $86);                        // Explore, Plan  (← FL9 와 일치)
  if (entrypoint !== "sdk-*") H.push(Q87);          // claude-code-guide
  return H;
}
```

확인 — `FL9 = new Set(["Explore","Plan"])` 는 단지 이 둘이 **사용자가 disable 할 수 없는 (always-active when AY_() returns true) lock-in built-ins** 라는 표시로 추정. `general-purpose` (`_e`) 와 `claude-code-guide` 도 built-in 이지만 별도 정의.

### 3.12 User-defined agent 정의 로딩 — `lE` (line 9287)

```js
lE = X6(async (H /* permissionContext */) => {
  if (xH(process.env.CLAUDE_CODE_SIMPLE)) {
    let _ = pgH();
    return { activeAgents:_, allAgents:_ };          // built-ins only
  }
  // 1. .md frontmatter 파일 로드 — ym("agents", H)
  //    sources: userSettings (~/.claude/agents/), projectSettings (.claude/agents/),
  //             localSettings (.claude/agents-local/), policySettings (managed)
  let _ = await ym("agents", H);
  let q = [];                                        // failedFiles
  let K = _.map(({filePath, baseDir, frontmatter, content, source}) =>
    s87(filePath, baseDir, frontmatter, content, source) || /* push to q */ null
  ).filter(Boolean);

  // 2. plugin agents
  let T = await TY_().catch(_ => []);                 // plugin agents (TY_)

  // 3. 합치고 priority 머지
  let z = [...pgH(), ...T, ...K];
  let A = UI(z);                                      // built-in < plugin < userSettings
                                                      //   < projectSettings < flagSettings
                                                      //   < policySettings (마지막이 우선)
                                                      // 동일 agentType 시 후순위가 덮어씀
  // 4. 색깔 등록, 자료 반환
  for (let Y of A) if (Y.color) rYH(Y.agentType, Y.color);
  return { activeAgents: A, allAgents: z, failedFiles: q.length > 0 ? q : undefined };
});
```

각 agent .md 파일은 frontmatter (`o87` Zod schema, line 9287) 로 정의:

```yaml
---
name: code-reviewer
description: "Reviews TypeScript code for type safety..."
tools: [Read, Grep, Glob]            # 미지정시 모든 도구 상속
disallowedTools: [Bash]
model: opus                          # "inherit" 가능
permissionMode: dontAsk
maxTurns: 50
memory: project                      # user | project | local
background: true                     # run_in_background=true 강제
isolation: worktree
mcpServers: ["my-server", {custom: {...}}]
hooks: { ... }
skills: ["..."]
initialPrompt: "..."
effort: high
---
<system prompt body>
```

`baseDir` 후보: `~/.claude/agents/`, `<project>/.claude/agents/`, `<project>/.claude/agents-local/`, policy/managed.

### 3.13 `agentLifecycle`

`ToolUseContext.agentLifecycle` 는 부모와 공유되는 객체로 다음 메서드를 가짐 (호출 사이트에서 역추론):

- `markTypeInvoked(agentType: string)` — 텔레메트리/UI용. 어떤 agent type 들이 이번 세션에 invoke 되었는지 기록 (line 12816).
- `registerName(name, agentId)` — `name` 으로 spawn 된 teammate 를 `SendMessage` addressable map 에 등록 (line 12816).

저장소 — `appState.agentNameRegistry: Map<string, agentId>` (line 9522 의 `remove` 가 이 map 도 같이 정리).

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 `AgentTool` | v2.1.143 `Agent`/`Task`/`TaskOutput`/`TaskStop` |
|---|---|---|
| 도구 수 | 1 (`Task`) | 4 (`Agent`, `TaskOutput`, `TaskStop` + `Monitor`/`Cron` 류) |
| 모드 | fire-and-forget, 동기 결과만 | foreground (default) / background (`run_in_background`) / auto-bg-after-2s |
| 결과 채널 | tool_result block 만 | sync → tool_result, async → `outputFile` (디스크) + `task_notification` 이벤트 |
| 출력 polling | 없음 (sidechain log 만) | `TaskOutput(task_id, block, timeout)` polling 도구 |
| 취소 | 없음 (수동 Ctrl-C) | `TaskStop(task_id)` (owner 검증, abortController) |
| Agent 타입 | 1종 (`general-purpose`) | built-in `Explore`/`Plan`/`general-purpose`/`statusline-setup`/`claude-code-guide` + plugin/user `.claude/agents/*.md` |
| Fork | 없음 | `FORK_AGENT` (`mE`, `bn9="fork"`) — `subagent_type` 생략시 (`XG()` true 일 때) 부모 컨텍스트를 통째로 자식이 상속 (Ez8 가 fork marker 메시지를 prepend) |
| 격리 | cwd 만 부모와 공유 | `isolation:"worktree"` 시 임시 git worktree 자동 생성 (`Jf_`, `gL8`), 자식이 다른 working tree 에서 작업 |
| Teammate | 없음 | `name`+`team_name` 시 `teammate_spawned` 경로 (FS7) — split-pane UI, named addressing via `SendMessage` |
| Token budget | 없음 | `taskBudget: {total, remaining}` — 매 컴팩션마다 RA8 로 차감, API body 의 `task_budget` 필드 + beta header (`$F_`) 로 서버에 전달 |
| Hook | 없음 | `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` 4종. payload 에 `agent_id`/`agent_type`/`agent_transcript_path` |
| Chain 추적 | 없음 | `queryTracking { chainId, depth }` — 자식마다 chainId 새로 발급, depth +1. 모든 텔레메트리에 첨부 |
| MCP 요구사항 | 없음 | `requiredMcpServers` — spawn 전 최대 30 초 대기, `z86` 로 검증, 미충족시 throw |
| 모델 override | 없음 | `model` 입력 또는 agent definition `model` (해상도: 입력 > frontmatter > parent main) |
| Tool 필터 | 없음 | agent definition `tools`/`disallowedTools` + 글로벌 permission rule `Agent(type)` |
| Permission mode | 부모 상속 | agent definition `permissionMode` 우선 (없으면 `acceptEdits` 강제) |
| Aliases | — | `Task → Agent`, `KillShell → TaskStop`, `AgentOutputTool/BashOutputTool → TaskOutput` (legacy 호환, line 3600 `Wm6`) |
| Anthropic API beta | — | `task_budget` 전송시 `$F_` beta header. **별개**: Anthropic SDK 의 `managed-agents-2026-04-01` (line 1928) 는 Claude Code 본 도구와 무관, 번들된 SDK 가 외부 호스트에게 제공하는 API 표면. CC 의 서브에이전트는 모두 in-process `runTurnLoop` 호출 |
| Result 저장 | tool_result content (in-memory) | sync 도 동일, async 는 `outputFile = hz(agentId)` (~/.claude/...) 에 transcript 저장. taskRegistry 자체는 `appState.tasks` (in-memory). 디스크 persistence 없음 — 프로세스 종료시 task 정보 휘발 (transcript 만 잔존) |

---

## 5. 부록 — 확인 / 추정 표시

- **확인**: 도구 4종의 name/aliases/schema/call body 위치, `taskBudget` 차감 식, `estimateMessageTokens` 의 동작, `forkToolUseContext` 의 자식 ctx 생성 방식, `EA6`/`Ze5`/`Ge5`, `Explore`/`Plan` 정의, `pgH` built-in 빌더, `lE` user agent 로더, legacy alias 매핑 `Wm6`, `taskRegistry` shape, hook 페이로드 Zod, queryTracking propagation.
- **추정**:
  - `TaskCreated` / `TaskCompleted` hook 의 발화 사이트가 본 그렙으로 명확히 잡히지 않음 — 페이로드 schema 는 있으나, 발화 함수는 별도 모듈 (확인 필요).
  - `taskBudget` 소진시 클라이언트가 명시적으로 abort 하는 코드 부재 — 서버가 stop_reason 으로 처리할 것으로 추정 (오직 `oB3` 이 body 에 첨부할 뿐).
  - `Sb()` 함수 (자식 `runTurnLoop` 실행) 의 정의 자체는 본 그렙에서 직접 잡지 않음. 호출 시그니처 (`{...JH, override:{agentId,...}, onCacheSafeParams, onQueryProgress}`) 와 `[Symbol.asyncIterator]()` 사용으로 보아 `runTurnLoop` 의 SDK-wrapper 임을 추정.
  - `taskRegistry` 의 디스크 persistence 부재 추정 — `appState.tasks` 외의 sqlite/file write 가 본 그렙 범위에서 안 보임. 단 transcript (`Ww` class, line 13138) 는 `~/.claude/.../bash-*.txt` / `agent-*.jsonl` 에 별도 저장.

