# Tool 인터페이스 계약 (v2.1.143)

v0.2.8의 `Tool`은 7개 메서드/필드(`call/validateInput/needsPermissions/isReadOnly/prompt/inputSchema/description`)로 끝났지만, v2.1.143은 30개에 가까운 표면을 노출한다. 이 문서는 `YC1` 기본값, `X9()` 래퍼, 그리고 호출 그래프(`executeToolPipeline`/`runSingleTool`/`dispatchToolBatch`/`StreamingToolExecutor`)에서 어떤 메서드가 어디서 호출되는지를 정리하고, 대표 도구 5종의 전체 구현을 인용한다.

---

## 1. 호출 그래프

**라인 참조**: `extracted-functions.js`.

### 1.1 진입 경로별 메서드 호출

| 호출자 | 호출되는 도구 메서드 | 위치 |
|---|---|---|
| `_j_(H,_,q,K)` (single-tool lookup + isolation) | `eK(..., name, aliases)` → 도구 lookup; `cA6(T,K)` → `isolation` 검사 | 13870 |
| `wrapToolWithProgressQueue` (progress queue wrapper) | `executeToolPipeline` 위임 | 13871 |
| `a63(H,_,q,K,O,T,$,z,A,Y,w)` (single-tool full pipeline) | `inputSchema.safeParse` → `validateInput` → `backfillObservableInput` → `runPreToolUseHooks` PreToolUse → `decidePermission` permission → `call(P, ctx, q, T, w)` → `mapToolResultToToolResultBlockParam(data, toolUseID)` → `runPostToolUseHooks` PostToolUse (`outputSchema?.safeParse` for updated output) | 13875 |
| `Hj_(H,_,q,K)` (batch runner, concurrent/serial 분기) | `groupByConcurrencySafe`로 그룹화 후 `runConcurrentTools`/`runSerialTools` 위임 | 10727 |
| `N05(H,_)` (concurrency batcher) | `inputSchema.safeParse(K.input)` → `isConcurrencySafe(parsed)` | 10728 |
| `runConcurrentTools` (concurrent) / `runSerialTools` (serial) | `_j_(block, asst, canUseTool, ctx)` | 10729-10730 |
| `gX_.addTool(H,_)` (streaming) | `inputSchema.safeParse(H.input)` → `isConcurrencySafe(parsed.data)` | 13878 부근 |
| `gX_.getToolInterruptBehavior(H)` | `_.interruptBehavior?.()` | 13878 부근 |

### 1.2 a63 내부 호출 순서

```
a63(tool, toolUseId, rawInput, ctx, canUseTool, assistantMsg, msgId, requestId, mcpServerType, mcpBaseUrl, onProgress)
  ├─ tool.inputSchema.safeParse(rawInput)          // 검증 1 (스키마)
  ├─ tool.validateInput?.(parsed, ctx)             // 검증 2 (의미)
  ├─ wo7(cmd, ...) if tool.name === Cq             // Bash 전용 pre-check
  ├─ backfilledInput = { ...parsed }
  │  tool.backfillObservableInput?.(backfilled)    // 입력 정규화 (절대경로 등)
  ├─ dA6(...) → PreToolUse hooks
  │   case "hookUpdatedInput": input = qH.updatedInput
  │   case "defer": ... (print-mode only)
  ├─ QA6(hookPermissionResult, tool, input, ctx, canUseTool, assistantMsg, toolUseId)
  │   → { decision: { behavior: "allow"|"ask"|"deny", updatedInput? }, input }
  ├─ tool.call(P, { ...ctx, toolUseId, userModified }, canUseTool, assistantMsg, onProgress)
  │   → { data, contextModifier?, mcpMeta?, newMessages?, structured_output?, acceptFeedback? }
  ├─ tool.mapToolResultToToolResultBlockParam(data, toolUseId)
  │   → { tool_use_id, type:"tool_result", content, is_error? }
  ├─ FA6(...) → PostToolUse hooks
  │   if "updatedToolOutput": tool.outputSchema?.safeParse(updated) → 재-mapper 호출
  ├─ acceptFeedback / contentBlocks (permission.ask 분기) → results 끝에 push
  └─ newMessages → 각각 별개 message로 push
```

### 1.3 정의 위치 (X9-wrapped 도구 객체)

| 도구 | 식별자 | 라인 | name 상수 |
|---|---|---|---|
| `Bash` | `WK` | 15307 | `Bash` |
| `Read` | `tT` | 14727 | `Read` |
| `Edit` | `$J` | 15084 | `Edit` |
| `Write` | (line 13135) | 13135 | `Write` |
| `Agent` | `Am7` | 12816 | `Agent` (alias `Task`) |
| `NotebookEdit` | (line 13195) | 13195 | `NotebookEdit` |
| `TodoWrite` | `kwH` | 10524 | `_L` |
| `StructuredOutput` | `V$8` | 8152 | `JG` |
| `listMcpResources` | `W7H` | 8283 | `rAH` |

---

## 2. 핵심 로직

### 2.1 `YC1` 기본값 (line 5748, `R9` 모듈 init)

```js
YC1 = {
  isEnabled:       () => true,
  isConcurrencySafe: (H) => false,
  isReadOnly:      (H) => false,
  isDestructive:   (H) => false,
  checkPermissions:(H, _) => Promise.resolve({ behavior: "allow", updatedInput: H }),
  toAutoClassifierInput: (H) => "",
  userFacingName:  (H) => "",
};
```

확인: `validateInput`, `isMcp`, `aliases`, `backfillObservableInput`, `parse`, `mapToolResultToToolResultBlockParam`, `maxResultSizeChars`, `persistenceThresholdCeiling`, `outputSchema`, `interruptBehavior`, `shouldDefer`, `strict`, `searchHint`, `inputsEquivalent`, `stripForStorage`, `preparePermissionMatcher`, `getPath`, `extractSearchText`, `isResultTruncated`, `getToolUseSummary`, `getActivityDescription`, 그리고 모든 `render*` 메서드는 `YC1`에 기본값이 없다 → 호출 측에서 optional chaining(`?.`)으로 감싼다.

### 2.2 `X9()` 래퍼 (line 5748)

```js
function X9(H){
  return Object.defineProperties(
    { ...YC1, userFacingName: () => H.name },
    Object.getOwnPropertyDescriptors(H)
  );
}
```

요점:
- `YC1`의 8개 기본을 spread로 깔고, `userFacingName: () => H.name`을 디폴트로 덮어쓴다 (도구가 미정의시 fallback은 `name`).
- `Object.getOwnPropertyDescriptors`로 복사 → **getter 보존**. (`get inputSchema(){...}` 같은 lazy schema는 그대로 살아남아 매 접근마다 `hH(()=>...)` 메모를 통과한다.)
- `searchHint`, `maxResultSizeChars`, `strict`, `isMcp` 같은 v0.2.8엔 없던 평범한 필드도 전부 그대로 보존된다.

### 2.3 TypeScript-스타일 인터페이스 (역추정)

```ts
type ToolResult<T> = {
  data: T;                                    // 내부 표현 (mapper 입력)
  contextModifier?: (ctx: ToolUseContext) => ToolUseContext;
  mcpMeta?: McpMeta;                          // MCP 서버 메타
  newMessages?: Message[];                    // 부수적으로 발행되는 메시지들
  structured_output?: unknown;                // StructuredOutput 도구의 종결 페이로드
  acceptFeedback?: string;                    // 사용자가 승인하며 남긴 코멘트 (대안)
};

interface Tool<TIn = any, TData = any> {
  // ─── 식별 ────────────────────────────────
  name: string;                               // 상수 ID (Cq/pq/k7/...)
  aliases?: string[];                         // 예: Agent의 [Fu] (Task)
  isMcp?: boolean;                            // YC1 default 없음. RG(t) 분기에 사용
  isOpenWorld?: () => boolean;                // 사용처 좁음
  searchHint: string;                         // ToolSearch가 keyword 매칭

  // ─── 표시/UI ─────────────────────────────
  description: string | ((input?: TIn) => Promise<string>);  // SDK용 description
  prompt: string | ((args: { model, ...}) => Promise<string>); // 시스템 프롬프트용
  userFacingName: (input?: TIn) => string;    // YC1 default: () => H.name
  userFacingNameBackgroundColor?: ...;        // (Agent)
  getToolUseSummary?: (input: TIn) => string|null;
  getActivityDescription?: (input?: TIn) => string;
  shouldDefer?: boolean;                      // ToolSearch/listMcp 전용 (lazy schema 전달)
  strict?: boolean;                           // API 측 strict schema 모드

  // ─── 스키마 (Zod) ────────────────────────
  inputSchema: ZodType<TIn>;                  // getter — safeParse가 호출됨
  outputSchema?: ZodType<TData>;              // PostToolUse hook updatedToolOutput 재검증

  // ─── 입력 변형 ───────────────────────────
  parse?: (raw: unknown) => unknown;          // (확인 필요 — 거의 미사용)
  backfillObservableInput?: (input: TIn) => void;  // in-place mutate (Read/Edit/Write: file_path → H9 절대화)
  inputsEquivalent?: (a: TIn, b: TIn) => boolean;  // Edit: same edit detection

  // ─── 검증 ────────────────────────────────
  validateInput?: (parsed: TIn, ctx: ToolUseContext) => Promise<{
    result: boolean;
    behavior?: "ask";                          // result:false + behavior:"ask" = 권한 대화로 이동
    message?: string;
    errorCode?: number;
    meta?: Record<string, unknown>;
  }>;

  // ─── Permission / 분류 ───────────────────
  isEnabled: () => boolean;                    // YC1 default: () => true
  isConcurrencySafe: (parsed: TIn) => boolean; // YC1 default: () => false
  isReadOnly: (parsed?: TIn) => boolean;       // YC1 default: () => false
  isDestructive: (parsed?: TIn) => boolean;    // YC1 default: () => false
  toAutoClassifierInput: (parsed: TIn) => string;  // YC1 default: () => ""
  checkPermissions: (input: TIn, ctx: ToolUseContext) => Promise<{
    behavior: "allow"|"ask"|"deny";
    updatedInput?: TIn;
    message?: string;
    decisionReason?: any;
  }>;
  preparePermissionMatcher?: (input: TIn) => Promise<(rule: any) => boolean>;
  getPath?: (input: TIn) => string;            // permission rule key용 (Read/Edit)
  interruptBehavior?: () => "cancel"|"block";  // Esc 처리 (default block)

  // ─── 실행 ────────────────────────────────
  call: (
    input: TIn,
    ctx: ToolUseContext & { toolUseId: string; userModified: boolean },
    canUseTool: CanUseToolFn,
    assistantInfo: { message: AssistantMsg; uuid: string; ... },
    onProgress?: (e: { type, toolUseID, data }) => void,
  ) => Promise<ToolResult<TData>>;

  // ─── 결과 매핑 ───────────────────────────
  mapToolResultToToolResultBlockParam: (
    data: TData, toolUseID: string,
  ) => ToolResultBlockParam;                   // { tool_use_id, type:"tool_result", content, is_error? }
  isResultTruncated?: (data: TData) => boolean;
  extractSearchText?: (data: TData) => string;  // /search 인덱싱용
  stripForStorage?: (data: TData) => TData;     // 전사본 저장시 base64/내용 제거
  maxResultSizeChars: number;                   // v0.2.8엔 없던 필드. Infinity 허용
  persistenceThresholdCeiling?: number;         // 결과 크기 임계 위면 디스크로 spill

  // ─── 렌더링 ──────────────────────────────
  renderToolUseMessage?: (input: TIn, ...) => any;
  renderToolUseProgressMessage?: (...) => any;
  renderToolUseQueuedMessage?: (...) => any;
  renderToolUseTag?: (...) => any;
  renderToolResultMessage?: (data: TData, ...) => any;
  renderToolUseErrorMessage?: (...) => any;
  renderToolUseRejectedMessage?: (...) => any;
  renderGroupedToolUse?: (...) => any;
}
```

### 2.4 대표 도구 5종 구현 요약

#### A) `Bash` — `WK` (line 15307)

```js
WK = X9({
  name: Cq, searchHint:"execute shell commands",
  maxResultSizeChars: 30000, strict: true,

  // 스키마
  get inputSchema(){ return PqK(); },         // command, description, timeout, run_in_background,
                                              // dangerouslyDisableSandbox, _simulatedSedEdit
  get outputSchema(){ return K$3(); },        // stdout/stderr/interrupted/isImage/backgroundTaskId/
                                              // persistedOutputPath/persistedOutputSize/staleReadFileStateHint/...

  // 분류 — KX8/P05/$05 분석기 결과로 결정
  isConcurrencySafe(H){ return this.isReadOnly?.(H) ?? false; },
  isReadOnly(H){
    let _ = zj_(H.command);                   // 명령어 트리 파싱
    return k76(H, _).behavior === "allow";    // read-only 패턴 화이트리스트 통과시 allow
  },
  toAutoClassifierInput(H){ return H.command; },

  // userFacingName: command가 `sed -i .../_simulatedSedEdit` 형태면 "Edit" 표시 (line 15307)
  userFacingName(H){ /* SandboxedBash 분기 포함 */ },

  // 추가 분석 (다른 모듈에서 호출됨)
  isSearchOrReadCommand(H){ ... },
  preparePermissionMatcher({ command }){ ... },

  // validateInput — sleep block (Mg() && !run_in_background → T$3로 sleep N 감지)
  async validateInput(H){
    if (Mg() && !X2_ && !H.run_in_background) {
      let _ = T$3(H.command);
      if (_ !== null) return {
        result: false,
        message: `Blocked: ${_}. To wait for a condition, use Monitor with an until-loop...`,
        errorCode: 10,
      };
    }
    return { result: true };
  },

  // checkPermissions — dangerouslyDisableSandbox 일 때 sandbox-on 일반 결정과 비교, sandbox-off가 새 결정이면 ask
  async checkPermissions(H, _){
    let q = await CX_(H, _);
    if (H.dangerouslyDisableSandbox && q.behavior !== "deny" && q.behavior !== "ask"
        && !ZqK(q.decisionReason) && !mL(H) && mL({...H, dangerouslyDisableSandbox:false}))
      return { behavior:"ask", decisionReason:{type:"sandboxOverride", reason:"dangerouslyDisableSandbox"},
               message:"Run outside of the sandbox" };
    return q;
  },

  // call
  async call(H, _, q, K, O){
    // === _simulatedSedEdit 특수 분기 ===
    if (H._simulatedSedEdit) return $$3(H._simulatedSedEdit, _, K);

    // 1. Y$3로 자식 generator 얻기 (sandbox/timeout/output capture 처리)
    let F = Y$3({ input:H, abortController, taskRegistry, ..., extraEnv: QP(model) ? { CLAUDE_EFFORT } : void 0 });
    let g, D = 0;
    do {
      g = await F.next();
      if (!g.done && O) O({
        type:"progress",
        toolUseID:`bash-progress-${D++}`,
        data:{type:"bash_progress", output, fullOutput, elapsedTimeSeconds, totalLines, totalBytes, taskId, timeoutMs}
      });
    } while (!g.done);
    let f = g.value;  // {stdout, stderr, code, interrupted, outputFilePath, outputTaskId, preSpawnError, ...}

    // 2. 결과 가공 — readFileState mtime delta 감지, gh rate-limit 힌트, persisted output path
    return { data: {
      stdout: m, stderr: j, interrupted: M, isImage: C,
      returnCodeInterpretation, noOutputExpected,
      backgroundTaskId, backgroundedByUser, assistantAutoBackgrounded,
      dangerouslyDisableSandbox, persistedOutputPath: L, persistedOutputSize: k,
      staleReadFileStateHint: S, ghRateLimitHint: p,
    }};
  },

  // mapper — 우선순위: structuredContent > isImage > 일반 text
  mapToolResultToToolResultBlockParam({ interrupted, stdout, stderr, isImage, backgroundTaskId,
    backgroundedByUser, assistantAutoBackgrounded, structuredContent, persistedOutputPath,
    persistedOutputSize, staleReadFileStateHint, ghRateLimitHint }, J){
    if (structuredContent?.length > 0) return { tool_use_id:J, type:"tool_result", content: structuredContent };
    if (isImage) { let X = Rz6(stdout, J); if (X) return X; }
    // ... persistedOutputPath면 MYH(...)로 file-ref preview 포맷, 백그라운드면 안내 메시지 append
    return { tool_use_id:J, type:"tool_result", content:[D, M, f, w, j].filter(Boolean).join("\n"), is_error:interrupted };
  },

  isResultTruncated(H){ return Ym(H.stdout) || Ym(H.stderr); }
});
```

**핵심 포인트**:
- **`_simulatedSedEdit`** (input 옵션) — sed 명령을 진짜로 실행하지 않고 preview 단계에서 계산한 결과를 그대로 적용. `executeToolPipeline`은 이 키를 본 즉시 logging 직전에 input에서 제거(`{ _simulatedSedEdit, ...e } = X; X = e`)하지만, `tool.call`은 원본 `H`를 받기 때문에 분기가 살아있다.
- `isConcurrencySafe`가 *입력 의존*. v0.2.8의 `static isReadOnly`와 결정적 차이.
- `staleReadFileStateHint` — Bash가 readFileState에 캐시된 파일을 수정했으면 model에게 reminder를 흘려준다 (write-after-read 감지).
- 30000자 한도. 그 이상은 `persistedOutputPath`로 디스크로 spill하고 inline preview만 반환.

#### B) `Read` — `tT` (line 14727)

```js
tT = X9({
  name: pq, searchHint:"read files, images, PDFs, notebooks",
  maxResultSizeChars: 1/0,                     // Infinity
  strict: true,
  get inputSchema(){ return I13(); },          // { file_path, offset?, limit?, pages? }
  get outputSchema(){ return b13(); },         // 6-way discriminated union
                                               //   type: "text"|"image"|"notebook"|"pdf"|"parts"|"file_unchanged"

  isConcurrencySafe(){ return true; },         // 입력 무관 — 항상 safe
  isReadOnly(){ return true; },
  toAutoClassifierInput(H){ return H.file_path; },
  isSearchOrReadCommand(){ return { isSearch:false, isRead:true }; },
  getPath({ file_path }){ return file_path || E_(); },

  // 핵심: file_path 절대경로화 (in-place)
  backfillObservableInput(H){
    if (typeof H.file_path === "string") H.file_path = H9(H.file_path);
  },

  async preparePermissionMatcher({ file_path:H }){ return (_) => yV(_, H); },
  async checkPermissions(H, _){ return djH(tT, H, _.getToolPermissionContext()); },

  // validateInput — pages 형식, 거부 디렉토리, UNC, 바이너리/디바이스 차단
  async validateInput({ file_path:H, pages:_ }, q){
    if (_ !== undefined) {
      let z = b98(_);
      if (!z) return { result:false, message:`Invalid pages parameter: "${_}"...`, errorCode:7 };
      if ((z.lastPage === Infinity ? GZH+1 : z.lastPage - z.firstPage + 1) > GZH)
        return { result:false, message:`Page range "${_}" exceeds maximum of ${GZH} pages...`, errorCode:8 };
    }
    let K = H9(H);
    if (CX(K, q.getToolPermissionContext(), "read", "deny") !== null)
      return { result:false, message:"File is in a directory that is denied...", errorCode:1 };
    if (K.startsWith("\\\\") || K.startsWith("//")) return { result:true };
    let $ = VNH.extname(K).toLowerCase();
    if (uq_(K) && !YpH($) && !gHK.has($.slice(1)))
      return { result:false, message:`This tool cannot read binary files...`, errorCode:4 };
    if (h13(K))                                  // /dev/* 등
      return { result:false, message:`Cannot read '${H}': this device file would block...`, errorCode:9 };
    return { result:true };
  },

  // call — dedup 검사 → FHK로 분기 (text/image/notebook/pdf/parts 결정)
  async call({ file_path:H, offset:_=1, limit:q=void 0, pages:K }, O, T, $){
    let { readFileState, fileReadingLimits } = O;
    // readFileState에 동일 offset/limit으로 캐시된 경우 + mtime 동일 → { type:"file_unchanged" } 반환
    let X = Z_("tengu_read_dedup_killswitch", false) ? void 0 : readFileState.get(D);
    if (X && !X.isPartialView && X.offset === _ && X.limit === q && (await KPH(D)) === X.timestamp)
      return { data: { type:"file_unchanged", file:{ filePath:H }} };
    // 정상 경로: FHK가 실제 IO
    return await FHK(H, D, D, J, _, q, K, w, j, readFileState, O, $?.message.id);
  },

  // mapper — type별 분기. text는 line-numbered cat -n 포맷 + system-reminder
  mapToolResultToToolResultBlockParam(H, _){
    switch (H.type) {
      case "image":  return { ..., content: [{ type:"image", source:{ type:"base64", data, media_type }}] };
      case "notebook": return TF7(H.file.cells, _);                      // 셀별 출력 블록 구성
      case "pdf":    return { ..., content: `PDF file read: ${path} (${size})` };
      case "parts":  return { ..., content: `PDF pages extracted: ${count} page(s)...` };
      case "file_unchanged": return { ..., content: dL9() };             // "File has not been modified since last read" 류
      case "text":   { /* m13 헤더 + u13 본문 cat -n; 비어있으면 system-reminder warning */ }
    }
  },

  stripForStorage(H){ /* content/base64 비우기 */ },
});
```

**핵심 포인트**:
- `maxResultSizeChars: Infinity` — 큰 파일도 한도 없이 통과 (오프셋/limit으로 제어).
- `readFileState` 통합: Edit/Write의 "read first" 가드와 짝. Read는 `set`하고, Edit/Write는 `get`하여 mtime/contents 일치를 본다.
- `backfillObservableInput`이 `executeToolPipeline`에서 호출되며, 그 시점 이후의 input이 transcript/logging/hook에 보이는 절대경로 형태가 된다 (관측가능 입력 = observable input).

#### C) `Edit` — `$J` (line 15084)

```js
$J = X9({
  name: k7, searchHint:"modify file contents in place",
  maxResultSizeChars: 1e5, strict: true,
  get inputSchema(){ return s$6(); },          // { file_path, old_string, new_string, replace_all? }
  get outputSchema(){ return uk8(); },

  toAutoClassifierInput(H){ return `${H.file_path}: ${H.new_string}`; },
  getPath(H){ return H.file_path; },
  backfillObservableInput(H){ if (typeof H.file_path === "string") H.file_path = H9(H.file_path); },
  async preparePermissionMatcher({ file_path:H }){ return (_) => yV(_, H); },
  async checkPermissions(H, _){ return kVH($J, H, _.getToolPermissionContext()); },

  // inputsEquivalent — 동일 edit 재시도 검출 (permission persist 판단용)
  inputsEquivalent(H, _){
    return U97({ file_path:H.file_path, edits:[{old_string:H.old_string, new_string:H.new_string,
                  replace_all:H.replace_all??false}]},
               { file_path:_.file_path, edits:[{...}] });
  },

  // validateInput — 6단 게이트
  async validateInput(H, _){
    // 1. agent별 file lock (lnH)
    let z = lnH($, _.agentId);              if (z) return {result:false, message:z, errorCode:12};
    // 2. c$6 — old/new가 같지 않은지, 빈 new_string 검증
    let A = c$6($, O);                       if (A) return {result:false, message:A, errorCode:0};
    if (K === O) return {result:false, behavior:"ask", message:"No changes to make: old_string and new_string are exactly the same.", errorCode:1};
    // 3. permission deny dir
    if (CX($, _.getToolPermissionContext(), "edit", "deny") !== null)
      return {result:false, behavior:"ask", message:"File is in a directory that is denied...", errorCode:2};
    // 4. size + mode (1GB 한도)
    if (size > 1073741824) return {result:false, behavior:"ask", message:"File is too large...", errorCode:10};
    if (lCH(mode)) return {result:false, behavior:"ask", message:cCH, errorCode:11};
    // 5. 파일 없을 때: old_string === "" 이면 create로 허용
    if (j === null) { /* didYouMean 분기 후 file-not-found */ }
    if (K === "" && j.trim() !== "")
      return {result:false, behavior:"ask", message:"Cannot create new file - file already exists.", errorCode:3};
    // 6. .ipynb 차단 — NotebookEdit 권유
    if ($.endsWith(".ipynb"))
      return {result:false, behavior:"ask", message:`File is a Jupyter Notebook. Use the ${CP} to edit this file.`, errorCode:5};
    // 7. **readFileState 가드** — Read 안 했으면 거부
    let J = _.readFileState.get($);
    if (!J || J.isPartialView)
      return {result:false, behavior:"ask", message:"File has not been read yet. Read it first before writing to it.",
              meta:{isFilePathAbsolute: String(_DH.isAbsolute(q))}, errorCode:6};
    if (qv($) > J.timestamp && !((J.offset??1)<=1 && J.limit===undefined && Ut(J, j)))
      return {result:false, behavior:"ask", message:"File has been modified since read...", errorCode:7};
    // 8. old_string match 검증, "actualOldString" meta로 표준화된 매칭본 반환
    let M = xRH(j, K); if (!M) return {result:false, ...errorCode:9};
    return {result:true, meta:{actualOldString:M}};
  },

  // call — 실제 디스크 쓰기 + structuredPatch 계산
  async call(H, {readFileState, userModified, getFileHistoryState, applyFileHistoryOp,
                  dynamicSkillDirTriggers, setAppState, agentId}, A, Y){
    let f = H9(file_path);
    await N4H.beforeFileEdited(f);                              // FileChanged hook
    await mkdir(dirname(f));
    if (EY()) await CjH(getFileHistoryState, applyFileHistoryOp, f, Y.uuid);  // ESC undo log

    let { originalFileContents, fileExists, actualOldString, updatedFile, patch }
      = await OOH(f, async () => {
          let { content, encoding, lineEndings, fileExists } = PO3(f);
          // race 재검사
          let p = xRH(content, old_string) || old_string;
          let S = b97(old_string, p, qQH(old_string, p, new_string));
          let x = uY_({ filePath:f, fileContents:content, oldString:p, newString:S, replaceAll });
          let F = wH6(f, x.updatedFile);                        // 외부 hook (LSP/formatter)
          let g = F === x.updatedFile ? x.patch : qwH({...convertTabs:true});
          await TOH(f, F, encoding, lineEndings);                // write
          readFileState.set(f, { content:F, timestamp: qv(f), offset:undefined, limit:undefined });
          return { originalFileContents:content, fileExists, actualOldString:p, updatedFile:F, patch:g };
        });

    // LSP 알림, /tmp git diff 캡처 (CLAUDE_CODE_REMOTE), memory queue
    let k = JJH(); if (k) k.changeFile(f, updatedFile).catch(...).saveFile(f).catch(...);
    if (f.endsWith(`${sep}CLAUDE.md`)) d("tengu_write_claudemd", {});
    bY_(patch);                                                  // 텔레메트리 emit

    return {
      data: {
        filePath, oldString: actualOldString, newString,
        originalFile: originalFileContents, structuredPatch: patch,
        userModified: userModified ?? false, replaceAll,
        ...(gitDiff && { gitDiff }),
      },
    };
  },

  mapToolResultToToolResultBlockParam(H, _){
    let { filePath:q, userModified:K, replaceAll:O } = H;
    let T = K ? ".  The user modified your proposed changes before accepting them. " : "";
    let $ = K ? "" : qr_;
    if (O) return { tool_use_id:_, type:"tool_result",
                    content:`The file ${q} has been updated${T}. All occurrences were successfully replaced.${$}` };
    return { tool_use_id:_, type:"tool_result", content:`The file ${q} has been updated successfully${T}.${$}` };
  },

  stripForStorage(H){ if (!H.originalFile) return H; return {...H, originalFile: ""}; },  // 전사본 비대화 방지
});
```

**핵심 포인트**:
- `validateInput`이 8단 게이트. 일부 에러는 `result:false`이지만 `behavior:"ask"`를 함께 반환하여 권한 ask UI로 분기 (예: 거부 디렉토리, "No changes", 너무 큰 파일 등).
- **readFileState 가드**: Read 없이 Edit 불가. v0.2.8엔 동일 정책이 있지만, v2는 `isPartialView`와 `(offset?? 1)<=1 && limit===undefined && Ut(...)` 같은 부분-view 케이스를 명시적으로 다룬다.
- `structuredPatch` — `data` 필드로 노출되어 PostToolUse hook이나 텔레메트리에서 diff 분석 가능.
- `userModified` 플래그는 `executeToolPipeline`이 permission 결과의 `userModified`를 `ctx`에 넘겨 받음.

#### D) `Agent` — `Am7` (line 12816, alias `Task` = "Task")

```js
Am7 = X9({
  name: J7, aliases: [Fu],
  searchHint:"delegate work to a subagent",
  maxResultSizeChars: 1e5,
  get inputSchema(){ return pL8(); },          // (En5 + omit) — { description, prompt, subagent_type?,
                                               // model?, run_in_background?, name?, team_name?, mode?,
                                               // isolation?, cwd? }
  get outputSchema(){ return Sn5(); },         // union: { status:"completed", content:..., usage:..., prompt }
                                               //        | { status:"async_launched", agentId, outputFile, ... }

  isReadOnly(){ return true; },                // 자기 자신은 read-only (실제 작업은 자식이 함)
  isConcurrencySafe(){ return true; },         // 부모-자식 모델에서 동시 실행 안전
  toAutoClassifierInput(H){
    let q = [H.subagent_type, H.mode ? `mode=${H.mode}` : undefined].filter(Boolean);
    return `${q.length ? `(${q.join(", ")}): ` : ": "}${H.prompt}`;
  },

  userFacingName: uL8,
  userFacingNameBackgroundColor: mL8,
  getActivityDescription(H){ return H?.description ?? "Running task"; },

  async checkPermissions(H, _){ return { behavior:"allow", updatedInput:H }; },  // 권한은 자식 도구들이 검사

  // prompt — 사용 가능한 agent 정의를 system prompt로 합성
  async prompt({ agents, tools, getToolPermissionContext, allowedAgentTypes, model }){
    let T = await getToolPermissionContext(), $ = [];
    for (let w of tools) { let j = e7H(w); if (j && !$.includes(j)) $.push(j); }
    let z = wY_(agents, $);
    let A = LnH(z, T, J7);                     // 권한으로 필터된 active set
    return await g97(A, model, false, allowedAgentTypes);
  },

  // call — 매우 길다. 분기:
  //   1. team_name 지정 → teammate spawn (split pane)
  //   2. fork (subagent_type === main agent type) → 같은 컨텍스트 fork
  //   3. 일반 subagent → 새 worker + worktree 옵션 처리
  //   4. run_in_background 또는 agent.background → async_launched 반환 (output 파일로 진척 추적)
  //   5. 동기 → for-await 자식 stream 소비, 2초 후 BackgroundHint UI 표시,
  //              autoBackgroundMs 초과 시 background로 승격, 결과 메시지 vT6로 합산
  async call({ prompt, subagent_type, description, model, run_in_background, name, team_name, mode, isolation, cwd },
             w, j, J, D){
    // (생략 — 약 200줄. 핵심:)
    // - taskRegistry 등록
    // - QU({ agentId, parentAgentId, parentSessionId, agentType, subagentName, isBuiltIn,
    //        invokingRequestId, invocationKind:"spawn", invocationEmitted:false })
    // - 워크트리 생성 if isolation === "worktree"   → Jf_(gL8(o))
    // - Sb(...) 호출로 자식 query stream 생성
    // - 동기: 자식 메시지 forward 후 vT6로 최종 합성 + content 반환
    // - 비동기: hz(agentId)에 파일 경로, async_launched 즉시 반환
    return { data: { status:"completed", prompt, ...vT6result } };
    // 또는
    return { data: { isAsync:true, status:"async_launched", agentId, description, prompt, outputFile, canReadOutputFile }};
  },

  mapToolResultToToolResultBlockParam(H, _){
    if (H.status === "teammate_spawned")
      return { tool_use_id:_, type:"tool_result", content:[{type:"text", text:`Spawned successfully.\n...`}]};
    if (H.status === "async_launched")
      return { tool_use_id:_, type:"tool_result", content: `Agent launched in background. Agent ID: ${H.agentId}. ...` };
    if (H.status === "completed")
      return { tool_use_id:_, type:"tool_result", content: H.content };  // sub-transcript 합성본
    throw Error(`Unexpected agent tool result status: ${H.status}`);
  },
});
```

**핵심 포인트**:
- v0.2.8엔 없던 도구. `subagent-system.md` 참조.
- `isolation: "worktree"` — `EnterWorktree` 호출 후 자식 cwd로 사용.
- `team_name` (Teammate, splitpane) / 일반 subagent / fork (자기 자신 fork) 세 경로.
- async 모드: `taskRegistry`에 `Sf`(Subagent Future) 등록 → 부모는 `outputFile`(=`hz(agentId)`)만 받고 `TaskOutput`/`TaskStop`으로 polling.

#### E) `TodoWrite` — `kwH` (line 10524)

```js
kwH = X9({
  name: _L, searchHint:"manage the session task checklist",
  maxResultSizeChars: 1e5, strict: true,
  get inputSchema(){ return AW5(); },          // { todos: Array<{ content, status, activeForm }> }
  get outputSchema(){ return YW5(); },         // { oldTodos, newTodos }
  userFacingName(){ return ""; },              // UI에 도구명 숨김 (별도 렌더)
  shouldDefer: true,                           // ToolSearch가 스키마 lazy 전달 가능
  isEnabled(){ return !rj(); },                // rj()가 true면 비활성 (Task tool로 대체)
  toAutoClassifierInput(H){ return `${H.todos.length} items`; },

  async checkPermissions(H){ return { behavior:"allow", updatedInput:H }; },
  renderToolUseMessage(){ return null; },      // 별도 UI 컴포넌트가 처리

  // call — 단순 상태 저장
  async call({ todos:H }, _){
    let q = _.getAppState();
    let K = _.agentId ?? k_();                  // agentId별로 분리된 todo 리스트
    let O = q.todos[K] ?? [];                   // oldTodos
    let $ = H.every(z => z.status === "completed") ? [] : H;  // 모두 완료면 리스트 클리어
    _.setAppState(z => ({ ...z, todos: { ...z.todos, [K]: $ }}));
    return { data: { oldTodos: O, newTodos: H } };
  },

  mapToolResultToToolResultBlockParam(H, _){
    return {
      tool_use_id: _, type: "tool_result",
      content: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
    };
  },
});
```

**핵심 포인트**:
- `isEnabled` 분기로 Task tool(v2 신규)이 활성 시 TodoWrite 비활성. 두 도구가 같은 목적이라 상호배제.
- `shouldDefer: true` — ToolSearch가 풀스키마 지연 로드.
- `appState.todos[agentId]`로 agent별 분리 → subagent가 별도 todo 리스트를 가짐.
- 결과 메시지가 사실상 모델용 reminder (실 데이터는 UI가 appState에서 직접 읽음).

---

## 3. State / Schema

### 3.1 메서드 시그니처 일람

| 메서드/필드 | 시그니처 | 기본값 출처 | 호출처 |
|---|---|---|---|
| `name` | `string` | — | `lookupTool`, `a7`, 모든 텔레메트리 |
| `aliases` | `string[]?` | — | `eK(tools, name, aliases)` |
| `isMcp` | `boolean?` | — | `RG(tool)` 검사 |
| `isOpenWorld` | `() => boolean?` | — | (확인 필요 — 좁은 사용처) |
| `searchHint` | `string` | — | ToolSearch keyword 매칭 |
| `description` | `string \| (input?) => Promise<string>` | — | `buildCreatePayload` (messages.create payload builder) |
| `prompt` | `string \| ((args) => Promise<string>)` | — | tool 설명을 system prompt에 합성 |
| `userFacingName` | `(input?) => string` | `() => ""`. `X9`가 `() => H.name`으로 덮어씀 | UI 표시 |
| `userFacingNameBackgroundColor` | `(input?) => string?` | — | (Agent only) |
| `getToolUseSummary` | `(input) => string \| null` | — | UI |
| `getActivityDescription` | `(input?) => string` | — | UI "Running ..." |
| `shouldDefer` | `boolean` | — | ToolSearch가 inputSchema lazy 처리 |
| `strict` | `boolean` | — | API strict-schema 모드 |
| `inputSchema` | `ZodType` (getter) | — | `safeParse`로 a63에서 호출 |
| `outputSchema` | `ZodType?` (getter) | — | PostToolUse `updatedToolOutput` 재검증 |
| `parse` | `(raw) => unknown?` | — | (선택적 pre-Zod 변환. 거의 미사용) |
| `backfillObservableInput` | `(input) => void` (in-place) | — | a63: `Z={...X}; tool.backfillObservableInput(Z); X=Z` |
| `inputsEquivalent` | `(a, b) => boolean?` | — | Edit에서 동일 edit 감지 |
| `validateInput` | `(parsed, ctx) => Promise<{result, behavior?, message?, errorCode?, meta?}>` | — | a63 (단계 2) |
| `isEnabled` | `() => boolean` | `() => true` | tool registry 필터 |
| `isConcurrencySafe` | `(parsed) => boolean` | `() => false` | `groupByConcurrencySafe`/`gX_.addTool` |
| `isReadOnly` | `(parsed?) => boolean` | `() => false` | 권한 추론, isolation 분류 |
| `isDestructive` | `(parsed?) => boolean` | `() => false` | (외부 분류기) |
| `toAutoClassifierInput` | `(parsed) => string` | `() => ""` | auto-mode classifier 입력 |
| `checkPermissions` | `(input, ctx) => Promise<PermissionDecision>` | `(H,_) => allow{updatedInput:H}` | `decidePermission` |
| `preparePermissionMatcher` | `(input) => Promise<(rule) => boolean>?` | — | rule key matching |
| `getPath` | `(input) => string?` | — | Read/Edit: permission rule path |
| `interruptBehavior` | `() => "cancel" \| "block"?` | (없으면 "block") | `gX_.getToolInterruptBehavior` |
| `call` | `(input, ctx & {toolUseId, userModified}, canUseTool, asst, onProgress?) => Promise<ToolResult>` | — | a63 (단계 5) |
| `mapToolResultToToolResultBlockParam` | `(data, toolUseID) => ToolResultBlockParam` | — | a63 + PostToolUse re-mapper |
| `isResultTruncated` | `(data) => boolean?` | — | UI hint |
| `extractSearchText` | `(data) => string?` | — | /search 인덱싱 |
| `stripForStorage` | `(data) => data?` | — | 전사본 보관 시 페이로드 축소 |
| `maxResultSizeChars` | `number` (Infinity 허용) | — | `pr9` (persistence 결정) |
| `persistenceThresholdCeiling` | `number?` | — | `pr9` |
| `renderToolUseMessage` | `(input, ...) => any?` | — | UI |
| `renderToolUseProgressMessage` | `(...) => any?` | — | UI streaming |
| `renderToolUseQueuedMessage` | `(...) => any?` | — | UI |
| `renderToolUseTag` | `(...) => any?` | — | UI |
| `renderToolResultMessage` | `(data, ...) => any?` | — | UI |
| `renderToolUseErrorMessage` | `(...) => any?` | — | UI |
| `renderToolUseRejectedMessage` | `(...) => any?` | — | UI |
| `renderGroupedToolUse` | `(...) => any?` | — | UI (Agent의 group) |

### 3.2 `ToolResult` (= `tool.call` 반환값) 필드별 의미

| 필드 | 타입 | 사용처 (`executeToolPipeline` 라인 13877 부근) | 설명 |
|---|---|---|---|
| `data` | `any` | `mapToolResultToToolResultBlockParam(data, _)` | 도구 내부 표현. PostToolUse hook으로 `updatedToolOutput`이 들어오면 `outputSchema.safeParse` 후 mapper 재호출. |
| `contextModifier` | `(ctx) => ctx` | `dispatchToolBatch`: concurrent batch에선 일괄 적용, serial은 즉시 적용. `StreamingToolExecutor`에선 non-concurrency-safe 도구만 즉시 적용 | 도구가 `ToolUseContext`를 변경할 수 있는 명시적 경로. v0.2.8은 직접 mutate. |
| `mcpMeta` | `McpMeta` | message에 `mcpMeta` 첨부 (subagent 컨텍스트에선 제외: `K.agentId ? void 0 : ...`) | MCP 서버 식별 메타 (server name 등). |
| `newMessages` | `Message[]` | `for (let yH of qH.newMessages) f.push({message:yH})` | 도구가 부가로 발행하는 side message. Agent가 자식 transcript를 부모 transcript에 inject할 때 사용. |
| `structured_output` | `unknown` | `if ("structured_output" in qH) f.push({message: T9({type:"structured_output", data: ...})})` | `StructuredOutput` 도구 전용. SDK가 종료 시 typed JSON으로 반환. attachment 메시지로 별도 발행됨. |
| `acceptFeedback` | `string` | `if ("acceptFeedback" in S && S.acceptFeedback) rH.push({type:"text", text:S.acceptFeedback})` | **permission 결정**에서 오는 필드 (`S = decision`). 사용자가 권한 승인 시 남긴 코멘트가 tool_result 다음 text 블록으로 append. — auto-mode UI에서 사용자가 "approve & add note" 했을 때 흘러들어옴. |

### 3.3 PermissionDecision schema (Zod `permissionDecisionSchema`, 0-overview에서 인용)

```
{ behavior:"allow", updatedInput?, updatedPermissions?, toolUseID?, decisionClassification?, acceptFeedback?, contentBlocks? }
| { behavior:"ask",  message?, contentBlocks?, ... }
| { behavior:"deny", message,  interrupt?, toolUseID?, decisionClassification? }
```

`acceptFeedback`은 permission decision의 필드. `tool.call` 반환에는 없다 (`Tool.call`은 `data/contextModifier/mcpMeta/newMessages/structured_output`까지만).

### 3.4 `data` 형태 (도구별)

| 도구 | `data` 키 |
|---|---|
| Bash | `stdout, stderr, interrupted, isImage, returnCodeInterpretation, noOutputExpected, backgroundTaskId, backgroundedByUser, assistantAutoBackgrounded, dangerouslyDisableSandbox, persistedOutputPath, persistedOutputSize, staleReadFileStateHint, ghRateLimitHint, structuredContent?` |
| Read | `{ type:"text"\|"image"\|"notebook"\|"pdf"\|"parts"\|"file_unchanged", file: {...} }` (discriminated union) |
| Edit | `{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll, gitDiff? }` |
| Write | (유사 Edit) `{ filePath, content, originalFile?, structuredPatch }` |
| Agent | `{ status:"completed", prompt, content, usage, ...worktreeResult }` 또는 `{ status:"async_launched", agentId, description, prompt, outputFile, canReadOutputFile, isAsync:true }` 또는 `{ status:"teammate_spawned", ... }` |
| TodoWrite | `{ oldTodos, newTodos }` |
| StructuredOutput | `{ data:"Structured output provided successfully", structured_output: <user JSON> }` |

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 메서드 수 | 7 (call, validateInput, needsPermissions, isReadOnly, prompt, inputSchema, description) | ~30 |
| 권한 검사 | `needsPermissions(input)` | `checkPermissions(input, ctx) => Promise<PermissionDecision>` (3-way: allow/ask/deny + updatedInput) + `preparePermissionMatcher` |
| 동시성 | `static isReadOnly` (도구 단위) | `isConcurrencySafe(parsed)` — **입력 의존**. Bash가 read-only 패턴이면 safe, 아니면 unsafe. (`KX8/P05/$05` 명령 분류기 결과) |
| 입력 정규화 | 없음 | `backfillObservableInput(input)` — in-place. transcript/hook에 보이는 입력을 절대화 등으로 표준화. |
| 출력 스키마 | 없음 | `outputSchema` (Zod). PostToolUse hook이 `updatedToolOutput`을 반환할 때 재검증 후 mapper 재호출 |
| 결과 매핑 | 도구가 직접 `tool_result` content block 생성 | `data` (내부) → `mapToolResultToToolResultBlockParam(data, toolUseID)` (API용) **분리** |
| 컨텍스트 변경 | 도구가 ctx mutate | `contextModifier` 명시적 반환. 동시 배치는 일괄 적용 (race 회피) |
| 결과 크기 | 한도 없음/하드코딩 | `maxResultSizeChars` (Infinity 허용), `persistenceThresholdCeiling` (디스크 spill) |
| Inputs equivalence | 없음 | `inputsEquivalent(a, b)` — Edit이 동일 edit 재시도 식별 |
| Interrupt 정책 | 없음 | `interruptBehavior() => "cancel"\|"block"` — Esc로 중단 가능 여부 |
| `aliases` | 없음 | Agent: `[Fu]` ("Task") |
| `searchHint` | 없음 | ToolSearch가 keyword 매칭에 사용 |
| `shouldDefer` | 없음 | ToolSearch가 풀스키마를 lazy 전달 (`ToolSearch`, `listMcpResources`, `listMcpPrompts` 등) |
| `strict` | 없음 | API strict-schema 모드 |
| `toAutoClassifierInput` | 없음 | auto-mode classifier의 분류 input (예: Bash → command, Edit → `"path: new_string"`) |
| `stripForStorage` | 없음 | 전사본 보관 시 base64/content 비우기 (메모리 절감) |
| Tool 부수 반환 | 없음 | `newMessages` (Agent → 자식 transcript), `structured_output` (StructuredOutput → 종결 페이로드) |
| User feedback | 없음 | `acceptFeedback` — permission ask 단계에서 사용자가 남긴 코멘트가 tool_result 옆 text 블록으로 inject |
| readFileState 통합 | 유사 정책 | v2: `isPartialView`/부분-view 케이스 명시, `staleReadFileStateHint` (Bash가 readFileState 캐시된 파일을 수정시 model에게 reminder) |
| 기본값 (`YC1`) | 개별 도구가 각자 정의 | 8개 기본 (`isEnabled/isConcurrencySafe/isReadOnly/isDestructive/checkPermissions/toAutoClassifierInput/userFacingName` + `userFacingName`은 `X9`가 도구명으로 덮어쓰는 두 번째 default) |
| 도구 정의 패턴 | export const tool = { ... } | `tool = X9({ ... })` — getter 보존 + YC1 spread |

### 비고

- `parse(input)`은 인터페이스에 존재 가능하나 (`executeToolPipeline`이 `inputSchema.safeParse` 후 결과를 그대로 사용), **현재 검토한 도구 중 자체 `parse`를 가진 사례는 없다** (확인 필요).
- `isOpenWorld()`는 `StructuredOutput` 같은 곳에 `false`로 발견 — MCP 서버 미연결 도구에서 추가 행동 가능성 신호로 추정.
- `interruptBehavior()`는 도구가 선언 시 "cancel"이면 Esc로 즉시 중단 가능; 기본 "block"이면 안전한 중단 지점까지 대기. `StreamingToolExecutor`만 사용하는 것으로 보인다.
