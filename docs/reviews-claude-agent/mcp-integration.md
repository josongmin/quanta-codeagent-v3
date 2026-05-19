# MCP integration (Model Context Protocol)

외부 도구/서버 프로토콜 통합. v0.2.8에는 stdio/SSE만 있었으나, v2.1.143은 9개 transport, scope-aware persistence, server-side tools (web_search, advisor), URL elicitation, XAA (cross-app access) OAuth 등을 추가.

## 호출 그래프

### 부팅 시 MCP 클라이언트 로드

```
ENH(setClient, serverConfigs)                       (line 15048)
  ├─ jW(scope)                                       — scope별 .mcp.json/settings 로딩 (line 11807)
  │     scope ∈ {project, user, local, enterprise}
  ├─ for each serverConfig:
  │     Cy(serverName, config, stats)               — connect with cache (line 15050+)
  │       ├─ transport 분기 (Ha schema):
  │       │     stdio    → rP_(spawn + StdioClientTransport)
  │       │     sse      → CH6 (SSEClientTransport) + yNH OAuth provider
  │       │     sse-ide  → CH6 (no auth, IDE bridge)
  │       │     ws       → Uj6 (WebSocket + Bearer auth)
  │       │     ws-ide   → Uj6 (with X-Claude-Code-Ide-Authorization)
  │       │     http     → bH6 (StreamableHTTPClientTransport) + yNH OAuth
  │       │     sdk      → in-process (print.ts)
  │       │     claudeai-proxy → bH6 to S.MCP_PROXY_URL
  │       ├─ new DH6 Client({name:"claude-code", version:"2.1.143", capabilities:{roots, elicitation, tasks?}})
  │       ├─ Y.connect(transport)                   — __H() timeout
  │       ├─ getServerCapabilities() / getServerVersion() / getInstructions()
  │       └─ return {type:"connected", name, capabilities, client, config, cleanup, transportErrorState}
  │
  ├─ Np(client)                                      — tools/list (line 15072)
  │     for each tool:
  │       name = XU(serverName, toolName) = "mcp__{a1(serverName)}__{a1(toolName)}"
  │       mcpInfo = {serverName, serverInfoName, toolName, execution, role, effectiveMaxPermission}
  │       isConcurrencySafe ← annotations.readOnlyHint
  │       inputJSONSchema ← tool.inputSchema (JSON Schema, not Zod)
  │       maxResultSizeChars ← _meta["anthropic/maxResultSizeChars"] | default
  │       alwaysLoad ← config.alwaysLoad ∨ _meta["anthropic/alwaysLoad"]
  │       checkPermissions: passthrough → addRules suggestion
  │
  ├─ a4H(client)                                     — prompts/list → slash commands
  └─ Jn(client)                                      — resources/list (if capabilities.resources)
```

### 도구 실행 (MCP tool via local toolRunner)

```
Bq3 (turn loop)                                      (line 14057)
  └─ for content_block_start type="tool_use":
        _j_(toolUseBlock, ...)                       (line 13870)
          └─ a63(tool, toolUseId, input, ctx, ...)   (line 13875)
                ├─ inputSchema.safeParse(input)      — Zod (MCP는 ZodAny passthrough)
                ├─ dA6 (PreToolUse hooks)
                ├─ QA6 (permission decision)
                ├─ tool.call(input, ctx)             ← MCP tool 구현
                │     └─ mS8 → B6K({client, tool, args, _meta:{"claudecode/toolUseId":id}, ...})
                │           └─ client.callTool() with timeout(r33()), 90s watchdog,
                │              progress callback → mcp_progress notification
                │              wO3() throws if isError, with mcpMeta
                ├─ FA6 (PostToolUse hooks)
                └─ returns {data, mcpMeta:{_meta?, structuredContent?}}
```

### Server-side tool (`server_tool_use`) — Anthropic API 자체 실행

```
DSK (query streaming, line 19054)
  └─ K_(builder):
        tools = [...localToolSchemas, ...extraToolSchemas, ...advisor?]
        if (gI() && CR()) → push w97 (advisor system prompt)
        if (J = z97(advisorModel, mainModel)) → push {type:"advisor_20260301", name:"advisor", model:J}
        WebSearch tool 내부 호출 시: bH3() → {type:"web_search_20250305", name:"web_search", max_uses:8}
  └─ stream content_block_start:
        case "server_tool_use":
          if block.name === "advisor": d("tengu_advisor_tool_call"), p_=true (in-progress flag)
        case "advisor_tool_result": p_=false
        case "web_search_tool_result" / "web_fetch_tool_result" / ...: O("tool-input")
  → 모든 server_tool_use는 API가 서버 측에서 실행. 클라이언트는 결과만 수신 (assistant message에 그대로 포함).
```

### Refresh (mid-turn pending → connected)

```
Bq3 loop, after tool_result yielded:
  if (dH.options.refreshTools) {
    let newTools = dH.options.refreshTools()
    let oldMcpCount = i0([msg], H_, model)에서 MCP tool 수
    let newMcpCount = i0([msg], newTools, model)
    if (H_ !== G_)
      d("tengu_mcp_tools_refreshed_mid_turn", {oldMcpCount, newMcpCount, recovered: H_===0 && G_>0})
  }
```

→ `hasPendingMcpServers = mcp.clients.some(c => c.type==="pending")`가 true이면 `buildCreatePayload` 빌더가 `defer_loading` 플래그를 살려 다음 턴에 재시도.

## 핵심 로직

### Message type dispatcher (`se8`, `wHq`)

```js
se8(H)   // tool-use 통합 검사
  H.type === "tool_use" || H.type === "server_tool_use" || H.type === "mcp_tool_use"
wHq(H)   // server/local만 (mcp 제외)
  H.type === "tool_use" || H.type === "server_tool_use"
```

세 종류의 의미:

| Type | 누가 실행? | 결과 type | mcpMeta |
|---|---|---|---|
| `tool_use` | 로컬 `tool.call` (MCP도 local toolRunner 경유) | `tool_result` (`user` role) | 결과에 첨부 (`D6({mcpMeta})`) |
| `server_tool_use` | API 서버 측 (Anthropic 인프라) | `web_search_tool_result` / `web_fetch_tool_result` / `advisor_tool_result` / `code_execution_tool_result` / `bash_code_execution_tool_result` / `text_editor_code_execution_tool_result` / `tool_search_tool_result` (assistant content) | (해당 없음) |
| `mcp_tool_use` | API 서버가 직접 MCP 호출 (managed agents 경로?) — 추정 | `mcp_tool_result` | (해당 없음) |

→ 일반적인 MCP 도구는 `tool_use`로 모델이 호출하고, 클라이언트가 `mS8`/`B6K`로 MCP 서버에 RPC. `mcp_tool_use`/`mcp_tool_result`는 Anthropic API가 서버 측에서 MCP를 호출한 경우의 전사 마커 (managed-agents beta header 환경) — 확인 필요.

### Server-side tool 종류 (`server_tool_use`)

콘텐츠 타입 리터럴 (line 9742, 15566):

```
web_search_tool_result
web_fetch_tool_result
code_execution_tool_result
bash_code_execution_tool_result
text_editor_code_execution_tool_result
tool_search_tool_result
advisor_tool_result        ← v2 신규 (v0.2.8엔 없음)
mcp_tool_result            ← managed MCP 경로
container_upload
compaction                 ← server-side reactive compaction
```

도구 정의 schema 타입 리터럴:
- `web_search_20250305` (line 13681, `bH3()`)
- `advisor_20260301` (line 19054, K_ builder)
- 그 외 `bash_20250124`, `text_editor_20250728` 등은 미확인. extracted-functions.js에는 result type만 보이고 tool type 정의는 `extraToolSchemas`로 외부 주입 가능.

### Advisor model fork (`gI`, `z97`, `A97`)

조건 (line 9435):
```js
gI() = !DISABLE_ADVISOR_TOOL && Jq()==="firstParty" && CR()
       && (CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL || Statsig.tengu_sage_compass2)
```

활성화 조건 (line 9438):
- `Y` (agentic query: repl_main_thread / agent: / sdk / hook_agent / verification_agent)일 때만
- 메인 모델이 `opus-4-7`, `opus-4-6`, `sonnet-4-6` 중 하나 (`tYH`)
- advisor 모델은 `opus`/`sonnet` 계열만 허용 (`agH=["opus","sonnet"]`, `RY_`)

발화 단위: **모델이 명시적으로 호출** — 자동 발화 아님. 시스템 프롬프트(`w97`, line 9440)가 "복잡한 결정 / 모호한 실패 / 진전 없는 순환"에서 escalate 하라고 안내. API가 `advisor_20260301` 도구를 서버 측에서 실행하여 별도 모델에 위임, 결과를 `advisor_tool_result`로 회신.

스트리밍 처리 (line 19054, `case "server_tool_use"` 안):
```js
if (i6.content_block.name === "advisor") {
  p_ = true  // advisor 진행 중 플래그
  d("tengu_advisor_tool_call", {model, advisor_model:J})
}
// content_block_start type="advisor_tool_result": p_=false, log "[AdvisorTool] result received"
```

에러 처리: `zd9(err)` (advisor strip) → `gH=null; S=qI8(S)` 후 `retry:advisor-strip` (line 19054).

### MCP server scope (`mcp_server_scope`, `EZ8`)

```
function EZ8(H) {
  if (!RG({name:H})) return null;
  let _ = Eh(H);                      // {serverName, toolName}
  if (!_) return null;
  let q = jb(_.serverName);           // lookup with priority
  if (!q && _.serverName.startsWith("claude_ai_")) return "claudeai";
  return q?.scope ?? null;
}

function jb(name) {
  let {servers:e} = jW("enterprise");
  if (Gf("mcp")) return e[name] ?? null;   // strictPluginOnlyCustomization
  let {servers:u} = jW("user"),
      {servers:p} = jW("project"),
      {servers:l} = jW("local");
  return e[name] || l[name] || p[name] || u[name] || null;
}
```

scope 우선순위 (덮어쓰기 방향):
1. **enterprise** (`Cm6.json` 정책 파일 경로 `h36()`)
2. **local** (이 머신·이 프로젝트 한정, `Xz().mcpServers`)
3. **project** (체크인된 `.mcp.json`, 디렉토리 트리 순회)
4. **user** (`~/.claude.json`의 `mcpServers`)
5. **claudeai** (`claude_ai_` 접두 가상 scope, claude.ai 연결 서버)
6. **dynamic** (런타임 SDK 동적 추가, `config.scope="dynamic"`)
7. **agent** (서브에이전트 정의에 인라인된 MCP — `Hm6` enum)
8. **managed** (관리형 플러그인이 가져온 서버)

Zod enum (`Hm6`, line 3572):
```
["local", "user", "project", "dynamic", "enterprise", "claudeai", "managed", "agent"]
```

`Y1("tool_result", {..., mcp_server_scope})` (line 13875) — telemetry로 어느 scope에서 도구가 실행되었는지 추적.

### 권한 (MCP 도구)

a63의 `decidePermission` 권한 결정 경로는 로컬/MCP 동일. MCP 도구는 `checkPermissions`가 항상 `passthrough` 반환:

```js
async checkPermissions() {
  return {
    behavior: "passthrough",
    message: "MCPTool requires permission.",
    suggestions: [{
      type: "addRules",
      rules: [{ toolName: "mcp__github__create_issue", ruleContent: undefined }],
      behavior: "allow",
      destination: "localSettings"
    }]
  }
}
```

→ 결정은 항상 permission rule 매칭에 위임. Auto-mode classifier(`decisionClassificationEnum`)도 MCP 도구 처리 — `toAutoClassifierInput`이 `zO3(args, toolName)`을 반환 (인자 직렬화).

`claudeai-proxy` 전용: `config.toolPermissions` 가 `{toolName: "allow"|"ask"|"blocked"}` 매핑을 제공 → `mcpInfo.effectiveMaxPermission`으로 상한 부과.

### URL elicitation 재시도 (`mS8`)

`B6K` 호출 시 서버가 `-32042 UrlElicitationRequired` 반환하면 (line 15063):
```
mS8 loop (X<3 retries):
  try B6K → catch c9 UrlElicitationRequired:
    for each elicitation in err.data.elicitations:
      hook 시도 (oP_) → 없으면 requestDialog(fFH) UI
      if action !== "accept": return synthetic isError result
      else retry callTool
```

### MCP 연결 재사용 / 캐시 무효화 (`DN`)

```
DN(serverName, config):
  let key = drH(serverName, config);
  let cached = Cy.cache?.get?.(key);
  if (cached) await cached.cleanup();
  Cy.cache.delete(key);
  Np.cache.delete(name); Jn.cache.delete(name);
  hNH.cache.delete(name); a4H.cache.delete(name);
```

세션 만료 (HTTP/proxy의 404 / `-32001`) → `C6K(err)` true → `DN()` 호출 → 다음 호출 시 재연결 (line 15067).

## State / Schema

### MCP client 상태 (`mcp.clients` 항목)

```ts
type MCPClientState =
  | { type: "pending"; name; config }                          // not yet attempted
  | { type: "connected"; name; client; capabilities;
       serverInfo?; instructions?; config; cleanup;
       transportErrorState: {                                  // line 15048+
         consecutiveErrors: number;
         activeCallWatchdogs: Set<{armedAt:number}>;
       };
       toolsListError?: string;                                // last tools/list error
     }
  | { type: "failed"; name; config; error?; errorCode? }
  | { type: "needs-auth"; name; config }                       // OAuth required
  | { type: "disabled"; name; config }                         // rV(name) returned true
```

### mcpMeta (`UX_` McpToolCallError`, ToolResult.mcpMeta`)

`executeToolPipeline` line 13875–13877:
```js
// success 경로:
let $H = qH.mcpMeta;
f.push({ message: D6({content:..., mcpMeta: K.agentId ? void 0 : $H, ...}) });

// error 경로:
f.push({ message: D6({..., mcpMeta: qH instanceof UX_ ? qH.mcpMeta : undefined}) });
```

`Np`의 `call()` (line 15072) 결과:
```js
return {
  data: result.content,
  ...(result._meta || result.structuredContent) && {
    mcpMeta: {
      ...(result._meta && { _meta: result._meta }),
      ...(result.structuredContent && { structuredContent: result.structuredContent })
    }
  }
};
```

→ `mcpMeta`에 들어가는 것:
- `_meta` (MCP 서버가 응답에 첨부한 자유 메타 — 자주 `anthropic/maxResultSizeChars` 등)
- `structuredContent` (스키마 검증 가능한 구조화된 출력)

용도: 디버깅·텔레메트리·재생성. **subagent 안에서는 mcpMeta를 미보존** (`K.agentId ? void 0 : $H`) — 부모 컨텍스트로 새지 않게.

### MCP server 설정 schema (`Ha`, line 3572)

discriminated union (8 transport):

```ts
type McpServerConfig =
  | { type: "stdio"; command; args:string[]; env?; alwaysLoad?; role? }
  | { type: "sse"; url; headers?; headersHelper?; oauth?; alwaysLoad?; role? }
  | { type: "sse-ide"; url; ideName; ideRunningInWindows?; alwaysLoad?; role? }
  | { type: "ws-ide"; url; ideName; authToken?; ideRunningInWindows?; alwaysLoad?; role? }
  | { type: "http"|"streamable-http" → "http"; url; headers?; headersHelper?; oauth?; alwaysLoad?; role? }
  | { type: "ws"; url; headers?; headersHelper?; alwaysLoad?; role? }
  | { type: "sdk"; name; alwaysLoad? }
  | { type: "claudeai-proxy"; url; id; alwaysLoad?;
      toolPermissions?: Record<string, "allow"|"ask"|"blocked"> };
```

`oauth` 서브스키마 (`Ujq`):
```ts
{
  clientId?, callbackPort?, authServerMetadataUrl?, scopes?,
  xaa?: boolean    // cross-app access (CLAUDE_CODE_ENABLE_XAA)
}
```

`role` 필드는 `"comms"` literal만 허용 — 통신용 MCP 서버 마킹.

### Tool name 인코딩 / 디코딩

```js
function a1(H) {                                    // sanitize (line 3584)
  let _ = H.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (H.startsWith("claude.ai ")) _ = _.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return _;
}
function Ou(H) { return `mcp__${a1(H)}__`; }       // prefix
function XU(H, _) { return `${Ou(H)}${a1(_)}`; }   // full name

function Eh(H) {                                    // parse (line 3585)
  let [q, K, ...O] = H.split("__");
  if (q !== "mcp" || !K) return null;
  return { serverName: K, toolName: O.join("__") || undefined };
}
function uq8(H) {                                   // telemetry-friendly (line 5577)
  if (!H.startsWith("mcp__")) return;
  let _ = H.split("__");
  if (_.length < 3) return;
  return { serverName: _[1], mcpToolName: _.slice(2).join("__") };
}
```

⚠ `Eh`와 `uq8`은 비슷하지만 다름:
- `Eh`: `__` 첫 등장으로 분리 — toolName이 `__`를 포함 가능
- `uq8`: serverName/toolName 모두 비어 있을 때 거부

### MCP 서버 이름 lookup (`n63`, `i63`)

```js
function n63(toolName, mcpClients) {
  let q = Yo7(toolName, mcpClients);
  return q?.type === "connected" ? (q.config.type ?? "stdio") : undefined;
}
function i63(toolName, mcpClients) {
  let q = Yo7(toolName, mcpClients);
  return q?.type === "connected" ? KS(q.config) : undefined;
}
function Yo7(toolName, _) {
  if (!toolName.startsWith("mcp__")) return;
  let q = Eh(toolName);
  return _.find(K => a1(K.name) === q.serverName);
}
function KS(H) {                                    // strip URL credentials (line 11777)
  if (!("url" in H)) return;
  let _ = new URL(H.url);
  _.search = ""; _.username = ""; _.password = ""; _.hash = "";
  return _.toString().replace(/\/$/, "");
}
```

### 텔레메트리 attributes (Wl, HDH, E3_)

```js
function Wl(toolName, transport, baseUrl) {
  let K = uq8(toolName);
  if (!K) return {};
  // mcpServerName/mcpToolName 외부 노출은:
  // - xq8 = new Set([aC]) = new Set(["computer-use"])  → built-in MCP만, 또는
  // - E3_(transport, baseUrl):
  //     CLAUDE_CODE_ENTRYPOINT==="local-agent" || transport==="claudeai-proxy"
  //     || yR9(baseUrl)  (Anthropic 도메인 화이트리스트)
  if (!xq8.has(K.serverName) && !E3_(transport, baseUrl)) return {};
  return { mcpServerName: K.serverName, mcpToolName: K.mcpToolName };
}
```

→ 외부 사용자 데이터 보호: 일반 user MCP 서버 이름/도구 이름은 텔레메트리에 안 들어감, 단 1P MCP·claude.ai proxy·Anthropic 호스트만 plaintext 전송. 이외는 `mcp_server_type` (`"stdio"|"sse"|"http"|...`)·`mcp_server_base_url` (sanitized)·`mcp_server_scope`만.

### 주요 텔레메트리 이벤트

| 이벤트 | 발생 위치 | 의미 |
|---|---|---|
| `tengu_mcp_server_connection_succeeded` | `Cy` (line 15050) | 연결 성공, durationMs, transportType, scope, isPlugin |
| `tengu_mcp_server_connection_failed` | 동 | 실패, errorCode, transportType |
| `tengu_mcp_tools_listed` | `Np` | tools/list 응답, listDurationMs, toolCount, alwaysLoadCount |
| `tengu_mcp_degraded` | `Np`, connect 후 | tools=0이거나 list 실패 |
| `tengu_mcp_tools_refreshed_mid_turn` | `runTurnLoop` (line 14057) | 턴 중간 refresh — oldMcpCount, newMcpCount, recovered |
| `tengu_mcp_tools_commands_loaded` | `A2_` (line 15049) | 전체 prefetch 완료 |
| `tengu_mcp_elicitation_shown` / `_response` | `q6K` (line 14955) | URL/form elicitation, mode∈{url,form}, action |
| `tengu_mcp_tool_call_auth_error` | `B6K` 401 catch | 토큰 만료 — `tVH` McpAuthError 발생 |
| `tengu_mcp_session_expired` | `B6K` 404/-32001 catch | 세션 expired → `DN` 후 reconnect |
| `tengu_mcp_oauth_flow_start/success/failure/error` | `tHH`, `_doRefresh` | OAuth 플로우 |
| `tengu_mcp_oauth_refresh_success/failure` | `_doRefresh` | refresh_token 사용 |
| `tengu_mcp_oauth_token_persist_failed` | `l_K` | 토큰 저장 실패 |
| `tengu_mcp_oauth_revoke` | `cP_` | 토큰 revoke |
| `tengu_mcp_elicitation_complete` (notification) | `q6K` | URL elicitation 완료 |
| `tengu_mcp_ide_server_connection_succeeded/failed` | `Cy` (sse-ide/ws-ide) | IDE bridge 연결 |
| `tengu_mcp_resource_templates_fetched` | `hNH` | resources/templates/list |
| `tengu_mcp_large_result_handled` | `YO3` (line 15059) | 큰 결과 파일로 persist or truncate |
| `tengu_mcp_singleton_unwrap` (Statsig gate) | `YO3` | 단일 text 블록 언래핑 |
| `tengu_mcp_server_config_invalid` | `Cy` | invalid URL |
| `tengu_headless_mcp_prewait` | (allowlist) | headless 모드 MCP prefetch 대기 |
| `tengu_sdk_mcp_false_unavailable` | (allowlist) | SDK MCP false report |
| `tengu_advisor_tool_call` / `_interrupted` | `callModelOuter` (line 19054) | advisor 사용 |
| `tengu_advisor_dialog_shown` | `Wh3` (line 17632) | `/advisor` 다이얼로그 |
| `tengu_advisor_strip_retry` | `DSK onError` | API가 advisor block 거부 → strip & retry |

### Connection cache key (`drH`, `vf`)

```js
function vf(H, _) {                                  // line 11746
  let q = SH({ type: _.type, url: _.url, headers: _.headers || {} });
  let K = crypto.createHash("sha256").update(q).digest("hex").substring(0, 16);
  return `${H}|${K}`;                                // serverName|hash16
}
```

→ 동일 이름 서버라도 transport·url·headers가 바뀌면 다른 cache 슬롯. OAuth 토큰도 이 키로 저장 (`mcpOAuth[`{name}|{hash}`]`).

## v0.2.8 대비 차이

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| Transport | stdio, sse | stdio, sse, sse-ide, ws, ws-ide, http (alias streamable-http), sdk, claudeai-proxy |
| Server-side tools | 없음 | `server_tool_use` 통합 (web_search, advisor, code_execution, bash_code_execution, text_editor_code_execution, tool_search) |
| Advisor 패턴 | 없음 | `advisor_20260301` server tool + `agH=["opus","sonnet"]` 모델 화이트리스트 + Statsig gate `tengu_sage_compass2` |
| Scope enum | 없음 | `["local","user","project","dynamic","enterprise","claudeai","managed","agent"]` + 우선순위 lookup `jb` |
| OAuth | 없음 | full PKCE flow + DCR + revocation + step-up scope + XAA (cross-app access via IdP) |
| 토큰 저장 | 없음 | `mcpOAuth[serverKey]` (`vf` hash) + per-process refresh lock |
| URL elicitation | 없음 | `-32042 UrlElicitationRequired` 재시도 (`mS8`, 3회) + hook + UI dialog |
| Tool-list 캐시 무효화 | 없음 | 세션 expired (404 / -32001) 자동 `DN()` 후 재연결 |
| Mid-turn refresh | 없음 | `refreshTools()` + `tengu_mcp_tools_refreshed_mid_turn` |
| Pending state | 없음 | `pending` clients가 `buildCreatePayload` builder에 `hasPendingMcpServers=true` 전달 → `defer_loading` |
| In-process MCP | 없음 | `computer-use`, `claude-in-chrome` 등을 transport pair로 in-process 실행 |
| `mcpMeta` 보존 | 없음 | tool_result에 mcpMeta 첨부, 단 subagent는 제외 (`K.agentId ? undefined : ...`) |
| Tool 이름 인코딩 | `mcp__server_tool` 단순 | `XU(H,_)=mcp__${a1(H)}__${a1(_)}`, claude.ai 접두 특별 처리 |
| 권한 | 명시 deny/allow | `passthrough` + `addRules` suggestion + claudeai-proxy의 `toolPermissions` 상한 |
| Stdio overflow 보호 | 없음 | `e_K` 16 MB cap, `iP_` StdoutOverflowError로 강제 종료 |
| HTTP body overflow | 없음 | `P33` TransformStream + `H6K` HttpBodyOverflowError |
| Watchdog | 없음 | 30 s 진행 로그 + 90 s 후 transport-dropped 추정 abort (`activeCallWatchdogs`) |
| Elicitation | 없음 | form 모드 + URL 모드 + completion notification + hook 우선 |
| Managed-agents | 없음 | `managed-agents-2026-04-01` beta header로 서버 측 MCP 호출 — `mcp_tool_use`/`mcp_tool_result` 전사 마커 (확인 필요) |

## 보조 식별자 색인

| Minified | 역할 | line |
|---|---|---|
| `Cy` | connect (memoized) | 15050 |
| `Np` | tools/list (memoized) | 15072 |
| `Jn` | resources/list | 15072 |
| `hNH` | resources/templates/list | 15072 |
| `a4H` | prompts/list | 15072 |
| `BQ` | reconnect | 15042 |
| `DN` | invalidate connection caches | 15030 |
| `ENH` | prefetch all servers | 15048 |
| `A2_` | wrap ENH as `{clients,tools,commands}` Promise | 15049 |
| `B6K` | low-level callTool with watchdog/timeout | 15067 |
| `mS8` | callTool + URL elicitation retry | 15063 |
| `YO3` | result content normalizer (large result persist) | 15059 |
| `IS8` | MCP content block → API content block | 15051 |
| `AO3` | MCP result → unified content/schema | 15056 |
| `Yo7` | toolName → mcpClient lookup | 13867 |
| `n63` | toolName → transport type | 13868 |
| `i63` | toolName → sanitized baseUrl | 13869 |
| `Eh` | parse `mcp__server__tool` | 3585 |
| `uq8` | parse for telemetry (strict) | 5577 |
| `Ou`/`XU` | encode prefix / full name | 3586/3587 |
| `a1` | sanitize segment | 3584 |
| `RG` | isMcp(tool) | 9519 |
| `EZ8` | toolName → mcp_server_scope | 11770 |
| `jb` | serverName → ServerConfig (scope resolution) | 11808 |
| `jW` | scope → `{servers, errors}` from filesystem | 11807 |
| `vf` | cache key `name\|sha256(config)[:16]` | 11746 |
| `KS` | sanitize url (credentials/path strip) | 11777 |
| `HDH` | `{mcpServerBaseUrl}` for telemetry | 15015 |
| `Wl` | conditional name/tool disclosure (1P only) | 5576 |
| `E3_` | is-1P-transport check | 5575 |
| `xq8` | built-in MCP server whitelist (`{"computer-use"}`) | 5589 |
| `Ha` | MCP server config Zod (discriminated union) | 3572 |
| `Hm6` | scope enum Zod | 3572 |
| `dbO` | transport type enum Zod | 3572 |
| `yNH` | OAuthClientProvider implementation | 14928 |
| `tHH` | run OAuth flow | 14927 |
| `$33` | XAA OAuth (token exchange w/ IdP) | 14925 |
| `cP_` | revoke tokens | 14920 |
| `gI` | advisor enabled? | 9435 |
| `z97` | resolve advisor model (validate) | 9438 |
| `A97` | get advisor model from config | 9439 |
| `tYH` | base-model supports advisor? | 9436 |
| `RY_` | model is valid advisor? | 9437 |
| `yRH` | isAdvisorContent | 9434 |
| `agH` | `["opus","sonnet"]` advisor allowlist | 9440 |
| `w97` | advisor system-prompt addendum | 9440 |
| `bH3` | WebSearch tool schema (`web_search_20250305`) | 13681 |
| `Uj6` | WebSocket transport wrapper | 14948 |
| `rP_` | StdioClientTransport w/ overflow protection | 14950 |
| `q6K` | elicitation request/notification handlers | 14955 |
| `jS8`/`JS8` | virtual `authenticate`/`complete_authentication` MCP tools (when needs-auth) | 14943/14945 |
| `UX_` | McpToolCallError (carries mcpMeta) | 15071 |
| `tVH` | McpAuthError (401 → reauth) | 15071 |
| `crH` | McpSessionExpiredError | 15071 |
| `iP_` | StdoutOverflowError (stdio cap) | 14950 |
| `H6K` | HttpBodyOverflowError (HTTP cap) | 14952 |
