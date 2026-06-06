# Claude Code ↔ IDE Integration — Full Audit (reference spec)

**Status:** DRAFT / reference. Reverse-engineered from the shipping extension, not official docs.
**Subject:** How the Claude Code CLI connects to and drives a VS Code / Cursor / Windsurf editor.
**Rev:** 3 (2026-06-07) — rev2 + PART 4: channel/session model, terminal integration, OAuth/credentials,
checkpoint/rewind/fork/storage, browser/remote-control/teleport/SSH/deeplinks, elicitation &
plugin/marketplace flow. Control-request shapes verified. Most PART 4 claims are extension-source [V].

**Sources (line-anchored):**
- Extension host: `.extracted_source/claude-code-ide/extension.beautified.js` (Anthropic.claude-code **2.1.167**)
- Webview UI: `.extracted_source/claude-code-ide/webview/index.beautified.js`
- Manifest + schema: `.extracted_source/claude-code-ide/package.json`, `claude-code-settings.schema.json`
- CLI side (strings): `.extracted_source/claude-code-cli/_cli-symbols.txt` (`@anthropic-ai/claude-code` 2.1.167)
- quanta target seam: [src/apps/agent/mode-presets/ide.ts](../../src/apps/agent/mode-presets/ide.ts) (ADR-0092)

**Tagging:** **[V]** = quoted verbatim from the cited file:line. **[I]** = inferred (consistent with code but
not a literal quote — re-read before trusting). Strings-dump (CLI-side) claims are inherently lower
confidence than extension-source claims; treated as [V] only when the literal string is present.

---

## 0. TL;DR — there are TWO connection topologies (don't conflate them)

The earlier draft said "the IDE link is WebSocket, not stdio." That was wrong. **Both exist**, for two
different entry points:

### Topology A — Extension-driven (the chat panel). **stdio + Agent SDK.**
The extension imports `@anthropic-ai/claude-agent-sdk` **0.3.167** **[V]** (`extension.js:42760, 62932`)
and **spawns the native CLI binary** as a subprocess with
`--output-format stream-json --verbose --input-format stream-json` over **stdio** **[V]** (`42454`).
The agent's editor-awareness in this mode is delivered via **in-process hook closures** (diagnostics)
and **`canUseTool`** (permission) — see §3-5. This is what the in-editor chat panel uses.

### Topology B — Terminal-driven (`claude` in the integrated terminal). **WebSocket + MCP.**
A `claude` started in a terminal discovers the IDE through `~/.claude/ide/<port>.lock`, dials a loopback
**WebSocket MCP server** the extension hosts, and gets 12 `mcp__ide__*` tools plus push notifications
(selection/diagnostics). See §6.

### Plus: an SDK-injected MCP server (debugger + Jupyter)
In Topology A the extension also injects an in-process SDK MCP server named **`claude-vscode-extension`**
(`Tde`, `extension.js:81263, 85188`) carrying debugger/Jupyter state into the spawned CLI. See §7.

```
TOPOLOGY A (chat panel)                          TOPOLOGY B (terminal claude)
┌────────────────────┐                           ┌────────────────────┐
│ extension host      │  spawn (stdio            │ extension host      │  ~/.claude/ide/<port>.lock
│  + claude-agent-sdk │  stream-json) ──────────►│  + WS MCP server    │◄── discover + WS dial
│                     │  ◄── stream events       │  (12 tools)         │     (terminal `claude`)
│  hooks: diagnostics │                          │                     │ ──► selection_changed
│  canUseTool: perms  │  ◄── control_request ──► │                     │     diagnostics_changed
│  +SDK MCP (dbg/jup) │                          └────────────────────┘
└──────────┬─────────┘
           │ postMessage  (webview UI protocol — §10)
           ▼
┌────────────────────┐
│ webview panel (React)│
└────────────────────┘
```

---

## 0.5 ⚠️ IDE-coupling vs general capability (read this before treating anything as an "IDE gap")

Most of what this extension exposes is **NOT an IDE feature** — it's a **general agent/CLI capability** that
quanta should (and mostly does) own regardless of surface. The extension just *surfaces* them. Don't read
PART 4 as an IDE gap list. Classification (general-capability present/absent checked against `src` by grep
— coarse; "present" = an impl exists, mechanism parity still needs a real read, per the false-parity rule):

| Subsystem | Class | quanta today |
|---|---|---|
| Lockfile + WS MCP server + 12 `mcp__ide__*` tools (§6) | **IDE-coupling** | n/a — only if quanta ships its own extension |
| `selection_changed`/`at_mentioned`/editor-LSP push (§4.5,§5-src,§9) | **IDE-coupling** | n/a |
| native `vscode.diff` accept/reject UI (§8) | **IDE-coupling** | reviewer `onConfirm` is the analog |
| debugger/Jupyter MCP from editor (§7) | **IDE-coupling** | no |
| webview UI protocol + VS Code manifest/keybindings (§10,§11) | **IDE-coupling** | n/a |
| terminal shell-integration exec (§14) | **IDE-coupling** (VS Code terminal API) | n/a (quanta *is* the terminal) |
| SDK-spawn-as-subprocess topology (§1) | **IDE-coupling** (host pattern) | `ide.ts` host seam |
| — | | |
| OAuth / credentials (§15) | **general** | ✅ chatgpt-oauth + provider seam |
| /rewind file checkpoints + snapshots (§17) | **general** | ✅ session/store + Shadow ODB (ADR-0108) — reconcile |
| conversation fork (§17) | **general** | ✅ present (verify algorithm parity) |
| session storage `.jsonl` + titles (§17) | **general** | ✅ session/store |
| permission modes / canUseTool (§4) | **general** | ✅ permission subsystem |
| hooks engine + 30 events + 5 types (§3,§12) | **general** | ✅ hooks engine |
| MCP lifecycle + elicitation + MCP-OAuth (§19) | **general** | ✅ present (elicitation in permission/types) |
| control-request runtime vocab (§2) | **general** (host↔agent control) | partial — see §21 |
| per-edit diagnostic-delta inject (§5 mechanism) | **general** (run checker after edit, inject only-new) | ❌ has turn-level verify, not per-edit |
| push notifications (§18) | **general** | ✅ cli/notify port |
| remote-control / teleport (§18) | **general / claude.ai-specific** | remote runner ✅; teleport ❌ (probably skip) |
| plugins / marketplace (§19) | **general** | thin — verify |
| compaction / worktree / advisor | **general** | ✅ already |

**Net:** the doc's durable value is the **IDE-coupling** rows (a real spec for an own-extension build) +
the **control-request vocabulary** (§2). The general rows are a **parity checklist**, not a backlog — only
two stand out as genuinely worth absorbing: **per-edit diagnostic-delta injection** (§5, the one true
"new" item) and tightening the **control-request runtime surface** (§2). Everything else: quanta has it;
verify mechanism parity if a specific behavior matters, don't reimplement.

---

# PART 1 — TOPOLOGY A (extension-driven, SDK over stdio)

## 1. CLI spawn  **[V]** (`extension.js:42389-42541`)

Base argv **[V]** (`42454`):
```
--output-format stream-json --verbose --input-format stream-json
```
Then conditionally pushed **[V/I]** (`42455-42531`): `--thinking <adaptive|enabled|disabled>`,
`--max-thinking-tokens`, `--effort`, `--max-turns`, `--max-budget-usd`, `--task-budget`, `--model`,
`--agent`, `--betas`, `--json-schema`, `--permission-prompt-tool stdio` (when a `canUseTool` cb is set),
`--permission-mode <default|acceptEdits|plan|bypassPermissions>`, `--allow-dangerously-skip-permissions`,
`--fallback-model`, `--continue`, `--resume <id>`, `--allowedTools`, `--disallowedTools`, `--tools`,
`--mcp-config <json>`, `--setting-sources user,project,local`, `--strict-mcp-config`,
`--include-hook-events`, `--include-partial-messages`, `--session-mirror`, `--add-dir`, `--plugin-dir`,
`--fork-session`, `--resume-session-at`, `--session-id`, `--no-session-persistence`, `--managed-settings`.

Binary resolution **[V]** (`42534`): `GRe(path)` decides standalone-exe vs node/bun-wrapped script.
stdio **[V]** (`42391`): `["pipe","pipe", DEBUG?"pipe":"ignore"]`, `windowsHide:true`.
Env **[V]** (`42424, 62932`): inherits `process.env`; sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`,
`CLAUDE_AGENT_SDK_VERSION="0.3.167"`, deletes `NODE_OPTIONS`; injects OTel `TRACEPARENT/TRACESTATE`.

> Net: the extension is an **SDK host**, not a thin wrapper. quanta's `ide.ts` already models this exact
> shape ("the HOST drives the conversation… seeds `req.base.{messages,stream,onConfirm}`").

## 2. Control-request protocol (runtime control of the running CLI)

Sent as `{ type:"control_request", request_id, request:{ subtype, ... } }` over stdin; replies matched by
`request_id` **[I]** (`extension.js:43287-43309`). Subtypes found **[I]** (`43223-43465`):

| subtype | params | purpose |
|---|---|---|
| `interrupt` | — | abort current turn |
| `set_permission_mode` | `mode` | switch default/acceptEdits/plan/bypass mid-session |
| `set_model` | `model` | swap model |
| `set_max_thinking_tokens` | `max_thinking_tokens` | retune thinking budget |
| `apply_flag_settings` / `get_settings` | `settings` / — | push/read runtime settings |
| `rewind_files` | `user_message_id, dry_run` | /rewind checkpoint restore |
| `cancel_async_message` | `message_uuid` | cancel a queued async message |
| `seed_read_state` | `path, mtime` | prime the read-dedup cache from the IDE |
| `remote_control` | `enabled, name?` | claude.ai/code bridge |
| `generate_session_title` | `description, persist?` | auto-title |
| `side_question` | `question` | ask a side question mid-turn |
| `ultrareview_launch` | `args, confirm?` | cloud reviewer |
| `message_rated` / `submit_feedback` | rating/feedback | telemetry |
| `mcp_status` / `mcp_reconnect` / `mcp_toggle` / `mcp_authenticate` / `mcp_clear_auth` / `mcp_oauth_callback_url` / `mcp_set_servers` / `mcp_message` | server name + payload | full MCP lifecycle control |
| `claude_authenticate` / `claude_oauth_callback` / `claude_oauth_wait_for_completion` | OAuth | login |
| `get_context_usage` | — | token-usage snapshot |
| `read_file` | `path, max_bytes?, encoding?` | host-mediated read |
| `reload_plugins` / `reload_skills` | — | hot-reload |
| `hook_callback` | `callback_id, input, tool_use_id` | invoke a registered hook (see §3) |

CLI→extension control requests **[V]** (`43140-43171`) with verified shapes:
- `can_use_tool` → `{behavior:"allow"|"deny"|"ask", updatedInput?, message?}` (§4).
- `oauth_token_refresh {signal?}` → `{accessToken: string|null}` (`43166`).
- `host_auth_token_refresh {signal?}` → `{authToken: string|null}` (`43169`).
- `elicitation {mcp_server_name,message,mode:"url"|"form",url,elicitation_id,requested_schema,title,…}`
  → `{action:"accept"|"decline"|"cancel", content?}` (default `decline`) (`43140-43157`).
- `request_user_dialog {dialog_kind,payload,tool_use_id}` → `{behavior:"cancelled"|…}` (default `cancelled`) (`43158-43164`).

Selected request→response shapes (extension→CLI) verified: `rewind_files {user_message_id,dry_run}` →
`{canRewind,filesChanged,insertions,deletions}` (§17); `remote_control {enabled,name?}` →
`{session_url,connect_url}` (§18).

> This subtype table is the **runtime control surface** quanta's IDE host would mirror. quanta has 0 hits
> for this protocol; it's the concrete "host drives a live agent" vocabulary.

## 3. Hook bridge (how editor hooks run as in-process closures)

The SDK registers hooks as **JS closures**, serializes them to opaque ids, and the CLI calls back:

**[V]** (`extension.js:85360-85366`):
```js
hooks: {
  PreToolUse: [
    { matcher: "Edit|Write|MultiEdit", hooks: [(w) => l.captureBaseline(w)] },
    { matcher: "Edit|Write|Read",      hooks: [(w) => this.saveFileIfNeeded(w)] },
  ],
  PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [(w) => l.findDiagnosticsProblems(w)] }],
}
```
Serialization → `initialize` **[I]** (`43181-43219`): each closure gets `hook_${n}`; the CLI receives
`{ subtype:"initialize", hooks:{ PreToolUse:[{matcher, hookCallbackIds, timeout}], ... } }`.
Invocation **[I]** (`43433-43436`): CLI sends `{subtype:"hook_callback", callback_id, input, tool_use_id}`;
extension runs `hookCallbacks.get(id)(input, tool_use_id, {signal})`; closure returns
`{ continue:bool, hookSpecificOutput?:{ hookEventName, additionalContext } }`.

> Key: in Topology A the IDE doesn't run hooks "via settings.json" — it passes **live functions** and the
> CLI RPCs back. This is the mechanism that makes §5 (diagnostics) work.

## 4. Permission flow (`canUseTool`)

Spawn sets `--permission-prompt-tool stdio` when a `canUseTool` cb exists **[I]** (`42484`). On a gated
tool the CLI sends `{subtype:"can_use_tool", tool_name, input, permission_suggestions, blocked_path,
decision_reason, title, display_name, description, tool_use_id, agent_id}` **[I]** (`43113-43127`);
the extension forwards to the webview as `tool_permission_request` and returns
`{ behavior:"allow"|"deny"|"ask", updatedInput?, message? }` **[V]** (`68264-68269`, webview `142002`).
Chrome-MCP tools auto-allow when the chrome channel is connected **[V]** (`68265`).

## 5. ⭐ Diagnostics feedback loop (the high-value, IDE-specific mechanism)

Class `R2` **[V]** (`extension.js:80949-81051`), wired as the §3 hooks.

1. **`captureBaseline`** (PreToolUse, Edit|MultiEdit|Write) → `baselineDiagnostics[file] = f_(file)` **[V]** (`80955`).
2. **`findDiagnosticsProblems`** (PostToolUse) **[V]** (`80969`):
   - visible editor → poll **`[750, 750]`** ms; hidden → **`[1000]`** ms (`80977`).
   - each tick: `findNewDiagnostics(baseline, f_(file))`; first non-empty wins.
   - returns `{ continue:true, hookSpecificOutput:{ hookEventName:"PostToolUse",
     additionalContext:"<ide_diagnostics>"+JSON+"</ide_diagnostics>" } }` (`80989-80992`); baseline deleted.

**`f_(path)`** **[V]** (`80875`) → `[{ uri, linesInFile, diagnostics:[{message, severity, range{start,end},
source, code}] }]`; severity is the VS Code enum **name** (`"Error"|"Warning"|"Information"|"Hint"`) **[V]** (`80866`).

**`findNewDiagnostics`** "new" key = 8-tuple equality **[V]** (`81011-81039`): `message` ∧ `severity` ∧
`source` ∧ `code` ∧ start/end **line within tolerance** (tolerance = `abs(Δ linesInFile)`, absorbs shifts
from the edit) ∧ start/end **character exact**. A diagnostic is new iff no baseline entry matches all 8.

**`formatDiagnosticsSummary`** **[V]** (`81040`) → `JSON.stringify` of
`[{ filePath, line(1-indexed), column(1-indexed), message, code, severity }]`. (So the payload inside
`<ide_diagnostics>` is **JSON**, not prose — corrects rev 1.)

`extractFilePath` handles Edit|MultiEdit|Write via `tool_input.file_path` **[V]** (`81004`).

### Quanta mapping (unchanged conclusion, now precise)
- 0 hits for `ide_diagnostics`/`diagnosticsDelta` in `src`; quanta's `ide.ts` exposes LSP tools but has no
  auto delta-injection.
- Wireable as a PreToolUse/PostToolUse hook pair (quanta already has both). New dep = a diagnostics
  source: IDE LSP (Topology A/B) or, on CLI surface, a scoped `tsc --noEmit`/eslint runner.
- Copy verbatim: timing `[750,750]`/`[1000]`, the **8-tuple "new" key** with line-shift tolerance, the
  1-indexed JSON shape, the `<ide_diagnostics>` envelope via hook `additionalContext`.

---

# PART 2 — TOPOLOGY B (terminal `claude`, WebSocket MCP)

## 6.1 Lockfile  **[V]** (`extension.js:88644-88663`)
`~/.claude/ide/` (`0700`); file `<wsPort>.lock` (`0600`):
```jsonc
{ "pid": <ppid>, "workspaceFolders": ["/abs", ...], "ideName": "<appName>",
  "transport": "ws", "runningInWindows": <bool>, "authToken": "<uuid>" }
```
Rewritten on workspace change, deleted on teardown (`88661, 88665`).

## 6.2 Port + WS server  **[V]** (`88641-88692, 88916-88926`)
Random port **[10000,65535]**, up to 50 probes. WS server checks header
`x-claude-code-ide-authorization === <session uuid>`; mismatch → `close(1008,"Unauthorized")`. Single
active client (new connection evicts previous). Server name per host (`88765`): `"Claude Code VSCode MCP"`
/ `"… Cursor MCP"` / `"… Windsurf MCP"`.

## 6.3 CLI-side discovery & transport  **[V from strings]** (`_cli-symbols.txt`)
- Scans lockfiles; "Failed to read IDE lockfile", "Failed to remove stale IDE lockfile" (`~126537-126548`);
  WSL-aware path detection (`126545`). Picks the lock whose `workspaceFolders` matches cwd **[I]**.
- Env vars: `CLAUDE_CODE_SSE_PORT` (`111130`), `CLAUDE_CODE_IDE_HOST_OVERRIDE` (`111179`),
  `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` (`110935`), `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` (`110936`).
- Transports referenced: "Initializing WebSocket transport", "Setting up SSE-IDE transport", HTTP
  (`241159-241162`); auth header `X-Claude-Code-Ide-Authorization` (`241232`). **Note:** the VS Code
  extension advertises `transport:"ws"` in its lockfile; the CLI *also* supports an **SSE** IDE transport
  (likely JetBrains/other hosts). Ordering of "primary vs fallback" is **[I]/uncertain** — don't quote it.
- Reconnect: auto on disconnect, capped attempts, scheduled retries, stale-lock cleanup
  (`147271-147284, 130200`). Telemetry: `ide_connect`, `ide_connect_timeout`, `ide_disconnect`,
  `ide_detect`, `ide_connected`, `tengu_ext_installed` (`146842-146854, 126550-126560`).
- IDE tools the binary names directly: `mcp__ide__getDiagnostics`, `mcp__ide__executeCode`
  (`141161, 241140`). Model-callable, not auto-invoked **[I]**.

## 6.4 IDE MCP tool surface (12 tools) + return shapes  **[V]** (`extension.js:88790-88915` + handlers)

The MCP server class `O4.tool(name, desc?, schema?, annotations?, handler)` supports a
`{readOnlyHint:true}` annotation (used on `openFile`) **[V]** (`87953, 88870`). Inputs validated via Zod;
all returns are MCP `{content:[{type:"text"|"image", text?|data?, mimeType?}]}`.

| Tool | Handler | Return (success) |
|---|---|---|
| `openDiff` | `Vfe` (`88082`) | **accept:** `[{text:"FILE_SAVED"},{text:<modified contents>}]` · **reject/close:** `[{text:"DIFF_REJECTED"},{text:<tab_name>}]` (Promise.race of accept-event / tab-close / save) |
| `getDiagnostics` | `Xfe`→`f_` (`88319`) | `[{text: JSON([{uri,linesInFile,diagnostics[]}]) }]` |
| `openFile` | `Yfe` (`88327`) | text msg ("Opened file and selected text from X to Y") or JSON `{success,filePath,fileUrl,languageId,lineCount,isDirty,…}`; startText/endText drive range select |
| `getOpenEditors` | `Qfe` (`88385`) | `[{text: JSON({tabs:[{uri,isActive,isPinned,isPreview,isDirty,label,groupIndex,viewColumn,fileName?,languageId?,lineCount?,selection?}]}) }]` |
| `getWorkspaceFolders` | `tme` (`88462`) | `[{text: JSON({success,folders:[{name,uri,path,index}],rootPath,workspaceFile}) }]` |
| `getCurrentSelection` | `eme` (`88426`) | `[{text: JSON({success,text,filePath,fileUrl,selection{start,end,isEmpty}}) }]` or `{success:false,message:"No active editor found"}` |
| `checkDocumentDirty` | `rme` (`88491`) | `[{text: JSON({success,filePath,isDirty,isUntitled}) }]` or `{success:false,message:"Document not open"}` |
| `saveDocument` | `nme` (`88523`) | `[{text: JSON({success,filePath,saved,message}) }]` |
| `getLatestSelection` | inline (`88888`) | `[{text: JSON(lastSelection or {success:false}) }]` |
| `close_tab` | `Zfe` (`88827`) | `[{text:"TAB_CLOSED"}]` |
| `closeAllDiffTabs` | `yC` (`88836`) | `[{text:"CLOSED_<n>_DIFF_TABS"}]` |
| `executeCode` | `Jfe` (`88251`) | Jupyter outputs as mixed `{type:"text"}` / `{type:"image",data:<b64>,mimeType}`; requires active notebook + python kernel + user confirm |

## 6.5 Notifications (server→client)  **[V]**
- `selection_changed` — debounce **300ms**, skips comment/output schemes, fires only on real change;
  params `{text,filePath,fileUrl,selection{start,end,isEmpty}}` (`88562-88625`). Replayed 500ms post-connect.
- `at_mentioned` — `{filePath, lineStart?, lineEnd?}` (`88571-88635`).
- `diagnostics_changed` — `{uris:[...]}`, pushed by the diagnostic client registry (`88943`).
- `log_event` — `{eventName, eventData}`, telemetry passthrough; queued in `j4[]` pre-connect, flushed on
  connect via `gme()` (`89023-89030, 88953`).

## 6.6 Diagnostic client registry  **[V]** (`extension.js:80892-80947`)
Singleton `gd` (`DiagnosticStreamManager`); `registerClient(cb)→"client_N"`, `unregisterClient(id)`.
`startStreaming` subscribes `languages.onDidChangeDiagnostics(e => notify(e.uris))`; **no debounce/coalescing**
— direct fan-out to all clients; `stopStreaming` when last client leaves. The WS connection registers a
client whose cb sends `diagnostics_changed` (§6.5).

## 7. SDK-injected MCP server: debugger + Jupyter  **[V]** (`81263, 85188, 86178-86211`)
`Tde` → server `claude-vscode-extension` (v2.1.167) with `debuggerController` + `jupyterController`. Starts
tool-less; tools registered when debugger/Jupyter activate. Added to the **running** CLI via
`query.setMcpServers({...mcpServers, "claude-vscode-extension": createServerConfig()})` when a debug
session is active, removed when not (`86188, 86211`). Type `"sdk"` → instance stays in-process (not sent
over `--mcp-config`).

## 8. Diff / accept-reject internals  **[V]** (`Vfe@88082`, cmds `87109-87143`)
Opens `vscode.diff(left, right, "✻ [Claude Code] …", {preview:false, preserveFocus:true})`; if the doc is
dirty it diffs against on-disk contents via a temp file. Races: accept/reject event, tab-close (→reject),
and (when `files.autoSave==="off"`) save (→accept). Returns the §6.4 shapes. Commands
`claude(-code|-vscode).{accept,reject}ProposedDiff` fire the event; tab identified by the `✻ [Claude Code]`
label.

## 9. @-mention  **[V]** (`87127-87143`)
`insertAtMentioned`: empty→`@rel`, line→`@rel#Ln`, range→`@rel#Lstart-end` (1-indexed); inserted via native
callback or routed as `at_mentioned`. Keybindings: `Alt+K` (`insertAtMention`) / `Cmd|Ctrl+Alt+K`
(`insertAtMentioned`).

---

# PART 3 — UI + MANIFEST + SETTINGS

## 10. Webview ↔ extension protocol (the chat-panel UI path)

postMessage with request/response matched by `requestId`; extension→webview wrapped as
`{type:"from-extension", message}` **[V]** (`webview 141801`, `extension 85269`).

**Webview→extension top-level** **[V/I]**: `launch_claude {channelId,cwd?,resume?,permissionMode,
thinkingLevel}`, `io_message {channelId,message,done}`, `interrupt_claude`, `start/stop_speech_to_text`,
`request {channelId,requestId,request}`, `response`, `cancel_request {targetRequestId}`.

**Extension→webview direct** **[I]**: `io_message` (stream), `file_updated {filePath,oldContent,newContent}`,
`plan_comment`, `speech_to_text_message`, `speech_audio_level`, `close_channel {error?}`, `cancel_request`.

**RPC `request.type` catalog (~60)** — the agent enumerated the full set (`extension 68747-69031`,
`webview 141645-142021`); highlights grouped:
- *lifecycle/config:* `init`, `get_claude_state`, `set_permission_mode {mode,userInitiated}`,
  `set_model {model}`, `set_thinking_level`, `apply_settings {settings,flagsOnly?}`.
- *files/editor:* `open_file {filePath,location?}`, `open_diff {originalFilePath,newFilePath,edits[],
  supportMultiEdits?}`→`{newEdits}`, `open_file_diffs {fileDiffs[]}`, `open_content {content,fileName,
  editable}`, `open_markdown_preview {channelId,content,title,enableComments}`, `get_current_selection`,
  `exec {command,params}`, `list_files_request {pattern}`, `get_terminal_contents {terminalName}`.
- *sessions:* `list_sessions_request`, `get_session_request {sessionId}`, `fork_conversation
  {forkedFromSession,resumeSessionAt}`→`{sessionId}`, `rewind_code {userMessageId,dryRun?}`,
  `generate_session_title`, `rename_session`, `delete_session`, `open_in_editor {sessionId}`,
  `list_remote_sessions`, `teleport_session`.
- *git:* `checkout_branch {branch}`, `check_git_status`, `create_worktree {name}`, `update_skipped_branch`.
- *auth:* `login {method}`→`{auth}`, `submit_oauth_code {code}`, `auth_url {url,method}`.
- *MCP:* `get_mcp_servers`, `set_mcp_server_enabled`, `reconnect_mcp_server`, `authenticate_mcp_server`,
  `clear_mcp_server_auth`, `submit_mcp_oauth_callback_url`, `ensure_chrome_mcp_enabled`/`disable_chrome_mcp`,
  `ask_debugger_help`, `enable_jupyter_mcp`/`disable_jupyter_mcp`, `toggle_remote_control`,
  `create_new_browser_tab`.
- *plugins:* `list_plugins`, `list_marketplaces`, `install_plugin {pluginId,scope}`, `uninstall_plugin`,
  `set_plugin_enabled`, `add/remove/refresh_marketplace`.
- *tabs/UI:* `new_conversation_tab {initialPrompt?,sessionId?}`, `rename_tab {title,hasPendingPermissions,
  hasUnseenCompletion}`, `show_notification {message,severity,buttons?,onlyIfNotVisible}`→`{buttonValue}`,
  `open_url`, `open_terminal {executable,args[],cwd,location}`, `open_claude_in_terminal {prompt,args[],
  location}`, `open_config(_file)`, `open_help`, `open_output_panel`, `open_folder(_in_new_window)`,
  banners/onboarding dismissals, `log_event`, `request_usage_update`, `get_asset_uris`.
- *plan preview:* `get_plan_comments`, `remove_plan_comment {commentId}`, `close_plan_preview`.

### 10.1 Permission rendering  **[V]** (`webview 141404-142021`)
`tool_permission_request {toolName,inputs,suggestions[]}` → `wY` object with `accept(updatedInput,
updatedPermissions)` / `reject(message, interrupt)` → reply `tool_permission_response {result:{behavior,
updatedInput?,message?,interrupt?}}`. `suggestions[]` powers the "always allow this tool" fast-path.

### 10.2 Plan / markdown-preview webview  **[V/I]** (`extension 83784-83810`)
Separate webview. ext→view: `updateContent {html}`, `setCommentsEnabled {enabled}`, `removeComment
{commentId}`. view→ext: `ready`, `comment {id,selectedText,sectionHeading?,comment}`. Enables async review
comments on a plan, distinct from chat.

### 10.3 Streaming render  **[V]** (`webview 142341-142402`, class `TCe`)
SDK events `message_start → content_block_start/delta/stop → message_stop` reassembled into `Yp` content
blocks with `partial/startTime/endTime/lastModifiedTime/durationMillis` and `.complete()`. `thinking_delta`
carries cumulative `estimated_tokens` → live thinking meter (`142381`). `usage_update {utilization,error}`
carries `input/output/cache_creation/cache_read` tokens + `fiveHour/sevenDay` utilization (`143809`).
Session sync: `session_states_update {sessions:[{sessionId,state,title}],activeSessionId}` broadcast to all
webviews (`86655`).

### 10.4 Not found / out of scope
No protocol-level todo/checklist panel, image-paste message, or slash-command RPC — those are handled as
plain message content or webview-local UI **[I]**.

## 11. Manifest surface (`package.json` `contributes`)  **[V]**

- **Commands (22):** open variants (`editor.open`, `primaryEditor.open`, `sidebar.open`, `window.open`,
  `editor.openLast`), `newConversation`, `reopenClosedSession`, `createWorktree`, `update`, `installPlugin`,
  `focus`/`blur`, `logout`, `terminal.open`, `accept/rejectProposedDiff` (×2 namespaces),
  `insertAtMention`/`insertAtMentioned`, `showLogs`, `openWalkthrough`, `toggleDictation`.
- **Keybindings (8):** `Alt+K` insertAtMention; `Cmd/Ctrl+Esc` focus/blur (gated on `!useTerminal`);
  `Cmd/Ctrl+Shift+Esc` open new tab; terminal-mode toggle when `useTerminal`; `Cmd/Ctrl+Alt+K`
  insertAtMentioned; `Cmd/Ctrl+N` newConversation (gated); `Cmd/Ctrl+Shift+T` reopenClosedSession (gated).
- **Menus:** `editor/title` accept/reject diff (when `viewingProposedDiff`) + openLast/terminal;
  `commandPalette` gated entries.
- **Views:** activitybar `claude-sidebar` + `claude-sessions-sidebar`, secondary-sidebar
  `claude-sidebar-secondary`; webview views switch on `claude-code:doesNotSupportSecondarySidebar`.
- **Walkthrough:** 4 steps (welcome / open / chat / sessions).
- **Activation:** `onStartupFinished`, `onWebviewPanel:claudeVSCodePanel`. **Untrusted workspaces: not
  supported.**

### 11.1 Extension config (`claudeCode.*`, 14 keys)  **[V]**
`environmentVariables[]`, `useTerminal`(false), `allowDangerouslySkipPermissions`, `claudeProcessWrapper`,
`respectGitIgnore`(true), `initialPermissionMode`(default|acceptEdits|plan|bypassPermissions),
`disableLoginPrompt`(false), `autosave`(true), `useCtrlEnterToSend`(false), `preferredLocation`
(sidebar|panel=panel), `enableNewConversationShortcut`(false), `enableReopenClosedSessionShortcut`(true),
`hideOnboarding`(false), `usePythonEnvironment`(true).

## 12. Settings schema (`claude-code-settings.schema.json`) — host-relevant keys  **[I]**

Validated for `**/.claude/settings.json`, `settings.local.json`, `**/{ClaudeCode,claude-code}/managed-settings.json` **[V]**.

- **permissions:** `allow[]`, `deny[]`, `ask[]`, `defaultMode`, `disableBypassPermissionsMode`,
  `additionalDirectories`, `allowManagedPermissionRulesOnly`.
- **sandbox:** `enabled`, `network{allowedDomains,deniedDomains,httpProxyPort,socksProxyPort,…}`,
  `filesystem{allowWrite,denyWrite,denyRead,allowRead}`, `failIfUnavailable`, `excludedCommands`,
  bwrap/socat paths (Linux/WSL).
- **hooks:** map of **event → handlers**; 5 handler **types** = `command | prompt | agent | http | mcp_tool`;
  controls `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars`.
- **hook events enum (30+):** PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
  UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart,
  SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle,
  TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
  InstructionsLoaded, CwdChanged, FileChanged, MessageDisplay.
- **model:** `model`, `fallbackModel[]`, `availableModels[]`, `modelOverrides`, `advisorModel`, `agent`.
- **mcp/plugins:** `enableAllProjectMcpServers`, `enabled/disabledMcpjsonServers`,
  `allowed/deniedMcpServers`, `enabledPlugins`, `skillOverrides`, marketplace allow/block lists.
- **worktree:** `symlinkDirectories`, `sparsePaths`, `baseRef`, `bgIsolation`.
- **memory/compaction:** `autoCompactWindow`(100K–1M), `autoCompactEnabled`, `cleanupPeriodDays`(30),
  `autoMemoryEnabled`, `autoMemoryDirectory`, `autoDreamEnabled`.
- **misc host gates:** `disableAgentView`, `disableRemoteControl`, `disableWorkflows`, `effortLevel`,
  `ultracode`, `fileCheckpointingEnabled`(for /rewind), `todoFeatureEnabled`, `statusLine`, `sshConfigs[]`.

> Many of these are already separate quanta features (permissions, sandbox, mcp gating, worktree, compaction,
> memory). The schema is a useful **completeness checklist** for quanta's settings vocabulary, not a gap list.

---

# PART 4 — Peripheral subsystems

## 13. Channel / session / multi-window model  **[V]** (`extension.js`)

The foundational abstraction. **A channel = one spawned CLI + its SDK `query` + comms/MCP state**;
`channelId` == `sessionId` (synonymous here).

- **Channel object** (`68171-68183`): `{ in:Hu, query, pid, vscodeMcpServer, mcpServers:{},
  chromeMcpState:{status:"disconnected"}, debuggerMcpState, jupyterMcpState,
  remoteControlState:{status:"disconnected"} }`, stored in `channels: Map` (`68019`).
- **Input queue `Hu`** (`66729-66779`): single-consumer async-iterable FIFO; `enqueue` wakes a pending
  `next()` or pushes; `done()` ends. The SDK loop `for await (… of query)` drains it. Webview `io_message`
  → `transportMessage` → `Hu.enqueue` (`68350`).
- **Session states** (`86460`): `Map<sessionId,{sessionId,state,title}>`; `updateSessionState` →
  `broadcastSessionStates()` pushes `{sessions,activeSessionId}` to **all** comms (`allComms:Set`,
  `86457, 86653`). Observed states: `waiting_input`, `running`, `idle` **[I]** (`86660`).
- **Tab binding**: `sessionPanels: Map<sessionId,panel>`; panel `onDidDispose` → delete state +
  `pushRecentlyClosedSession` (`86766-86775`).
- **Teardown** `closeChannel` (`68328-68348`): `in.done()` → `query.return()` (kills subprocess/generator)
  → `channels.delete`; drains pending ops.
- **Reopen** (`86585-86609`): `recentlyClosedSessions` stack (dedup + cap `Uit`); pop → `createPanel`;
  sets context key `claude-vscode.lastClosedWasSession` for the keybinding.

> quanta parallel: the `ide` preset's `req.base.{stream,messages}` is the channel; this is the missing
> **multi-channel manager** (concurrent conversations, FIFO input, broadcast sync) for a host UI.

## 14. Terminal integration  **[V]** (`extension.js`)

- **`useTerminal` mode** (`claudeCode.useTerminal`): chat runs in a terminal instead of the webview;
  `open_claude_in_terminal` → command `claude-vscode.terminal.open` (`68955, 85634, 87091`).
- **createTerminal** (`85646, 87046`): `{name:"Claude Code"|$CLAUDE_CODE_TERMINAL_TITLE,
  iconPath, location(Beside|One), isTransient:true, env:{...process.env}, strictEnv:true}`.
- **Shell-integration exec (the key pattern)** (`85659-85673, 87061-87075`): subscribe
  `onDidChangeTerminalShellIntegration` → `shellIntegration.executeCommand(vf(argv))`; **3000ms** timeout
  fallback to `terminal.sendText(vf(argv))`; guard flag prevents double-run; completion via
  `onDidEndTerminalShellExecution` (auto-dispose when the `claude ` command ends).
- **Shell escaping `vf`** (`63425-63433`): `""`→`''`; `[A-Za-z0-9_./:=@+,-]+`→unquoted; else single-quote
  wrap with `'"'"'` for embedded quotes.
- **Env handoff `dme`** (`88693-88698, 89005`): `environmentVariableCollection.replace`; injects
  `CLAUDE_CODE_SSE_PORT` so a terminal `claude` discovers the IDE WS server; redacts
  `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` in logs.
- **`get_terminal_contents`** (`86132-86152`): show → selectAll → copySelection → read clipboard → keep
  **last 100 lines** → restore clipboard (clipboard round-trip, not a buffer API).
- **`Io()`** (`87021`): focus active terminal; called after diff accept/reject and notification replay.

## 15. Auth / OAuth  **[V]** (`extension.js`)

- **Endpoints + client ids** (`27499-27574`): **prod** `platform.claude.com/oauth/authorize`,
  token `…/v1/oauth/token`, CLIENT_ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`; **local** (`CLAUDE_LOCAL_OAUTH_*`)
  CLIENT_ID `22422756-60c9-4084-8eb7-27705fd5cf9a`; **custom** via `CLAUDE_CODE_CUSTOM_OAUTH_URL` restricted
  to a 3-domain allowlist (`beacon.claude-ai.staging.ant.dev`, `claude.fedstart.com`,
  `claude-staging.fedstart.com`) else throws; client id override `CLAUDE_CODE_OAUTH_CLIENT_ID`.
- **Login flow** (`68368-68400`): `login{method}` → SDK `claude_authenticate{loginWithClaudeAi}` →
  `{manualUrl,automaticUrl}` → webview `auth_url{url,method}` + `openURL(automaticUrl)` → user →
  `submit_oauth_code{code}` (supports `code#state`) → `claude_oauth_callback{authorizationCode,state}` →
  `claude_oauth_wait_for_completion`.
- **Credential storage** (`27617-27635, 27735-27825, 8029-8079`): macOS keychain via `security`
  (`add/find/delete-generic-password`), service `Claude Code${OAUTH_FILE_SUFFIX}-credentials${hash}`,
  account `$USER`|`claude-code-user`; payload `{type:"oauth_token", access_token, refresh_token,
  expires_at, scopes[], subscriptionType, rateLimitTier}`; 30s cache.
- **Refresh** (`28232-28267, 43165-43170, 63018`): local `grant_type:refresh_token` to token URL; OR CLI
  asks host via `oauth_token_refresh`/`host_auth_token_refresh` control requests (advertised by env flags
  `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`/`_HOST_AUTH_REFRESH`).
- **Token handoff to CLI**: lockfile `authToken` is the **WS** secret (not OAuth); the model token reaches
  the CLI via the SDK `getOAuthToken` callback or env `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` (`62878`).
- **Gates**: `disableLoginPrompt`, `forceLoginMethod (claudeai|console|gateway)`, `forceLoginOrgUUID`,
  `forceLoginGatewayUrl`; logout = `claude auth logout` (`68402`).

## 17. Checkpoint / rewind / fork / session storage  **[V]**

- **/rewind** (`43245, 68999-69011`): `rewind_files{user_message_id, dry_run}` →
  `{canRewind, filesChanged, insertions, deletions}`. Gated by `fileCheckpointingEnabled` +
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` (`62429, 63017`).
- **File snapshots** (`67088, 67473-67499`): `file-history-snapshot` records reference backups at
  `~/.claude/file-history/{sessionId}/{backupFileName}`; copied between sessions via **hard-link** (fallback
  `copyFile`). `snapshot.trackedFileBackups` = file→backup map. `--rewind-files` requires `--resume`.
- **Fork** (`67359-67449, 68992`): `fork_conversation{forkedFromSession, resumeSessionAt}` → new `sessionId`.
  Algorithm: load source, optional truncate at `resumeSessionAt`, mint new UUIDs for every message, rewalk
  `parentUuid` (skipping `progress`), remap, copy file-history snapshots (new messageId + hard-link
  backups), write new `<sessionId>.jsonl`. Telemetry `tengu_conversation_forked`.
- **Storage** (`28135, 67082-67240`): root `~/.claude` (`CLAUDE_CONFIG_DIR`); sessions at
  `~/.claude/projects/<sanitized-cwd-key>/<sessionId>.jsonl`. Record types: `user`, `assistant`,
  `progress`, `summary{leafUuid,summary}`, `custom-title`, `ai-title`, `teleported-from`,
  `teleport-skipped-branch`, `file-history-snapshot`.
- **Resume/continue** (CLI strings, [I]): `--resume <id>`, `--continue`, `--resume-session-at <msg>`,
  `--fork-session` (new id from resumed), `--no-session-persistence`, `--session-mirror`. Retention default
  **30 days**. Titles via `generate_session_title` (`ai-title` vs user `custom-title`).

## 18. Browser / remote-control / teleport / SSH / deep links  **[V]**

- **Chrome MCP** (`68178, 68265, 68626-68678, 85417`): per-channel `chromeMcpState`; `ensure_chrome_mcp_enabled`
  / `disable_chrome_mcp` / `create_new_browser_tab`; server config `claude --claude-in-chrome-mcp` (stdio);
  **auto-allow** when `tool.startsWith("mcp__claude-in-chrome__")` and chrome connected. Tools (CLI strings):
  `gif_creator`, `read_console_messages`, `javascript_tool`, `tabs_context_mcp`, `tabs_create_mcp`, etc.
- **Remote Control bridge (claude.ai/code)** (`43254, 68705-68729, 68207`): `toggle_remote_control{enable}`
  → SDK `remote_control{enabled,name?}` → `{session_url, connect_url}`; live `system/bridge_state` events
  flip `remoteControlState`. Settings `remoteControlAtStartup`, `disableRemoteControl`.
- **Teleport** (`69119-69168`): `list_remote_sessions` + `teleport_session{sessionId}` — fetch a remote
  session's messages/branch and **import as a new local session** (UUID-remapped), enabling local checkout.
- **SSH** (`62244, 62354-62377`): `sshConfigs[{id,name,sshHost,sshPort,sshIdentityFile,startDirectory}]`,
  `remote.defaultEnvironmentId` — enterprise-preset remote environments; `claude ssh <config> [dir]`.
- **Deep links** (`89244-89268, 61297`): URI handler `claude-cli://` (or `claude://`) →
  `/install-plugin?plugin=&marketplace=` (default `anthropics/claude-plugins-official`),
  `/open?session=&prompt=`; `disableDeepLinkRegistration` opts out.
- **Push/notif** (`60054, 62413-62466`): `inputNeededNotifEnabled`, `agentPushNotifEnabled`,
  `preferredNotifChannel (auto|iterm2|iterm2_with_bell|terminal_bell|kitty|ghostty|notifications_disabled)`.

## 19. Elicitation, dialogs & plugin/marketplace flow  **[V]**

- **Elicitation / user dialog**: §2 shapes. Notably these are **host callbacks**, not built-in rendering —
  the host decides modal/quickpick/webview. quanta's `onConfirm` reviewer is the analogous single seam;
  elicitation generalizes it to arbitrary MCP-driven prompts.
- **MCP-server OAuth** (`43335-43342, 68563-68625`): `authenticate_mcp_server` → SDK `mcp_authenticate
  {serverName,redirectUri}` → `{authUrl,requiresUserAction}` → `openURL` → `submit_mcp_oauth_callback_url
  {serverName,callbackUrl}` → `mcp_oauth_callback_url`; `clear_mcp_server_auth` (sse/http only).
- **Plugins** (`66887-66929, 69017-69032`): `install_plugin{pluginId,scope}` / `uninstall_plugin` /
  `set_plugin_enabled` all shell out to `claude plugin {install|uninstall|enable|disable}` and return
  `needsRestart:true`. Marketplaces: `list/add/remove/refresh_marketplace`; source types
  `github|git|url|directory|file|npm|inline` (`66869-66885`).
- **`show_notification`** (`85308-85325`): `{message,severity:error|warning|info,buttons?,onlyIfNotVisible?}`
  → `{buttonValue?}` via native `show{Error|Warning|Information}Message`. The host notification primitive.
- **Debugger/Jupyter toggle** (`86230-86274`): `enable_jupyter_mcp`/`disable_jupyter_mcp`/`ask_debugger_help`
  add/remove the `claude-vscode-extension` SDK MCP server (§7) via `query.setMcpServers` at runtime.
- **Settings write** (`68915, 69329-69359, 85499-85538`): `apply_settings{settings,flagsOnly?}` writes
  `~/.claude/settings.json` + `query.applyFlagSettings`; `open_config_file{mcp-local|mcp-user|mcp-project}`
  opens `.claude.json`/`.mcp.json`; `open_config{searchString?}` opens the VS Code settings UI.

## 20. The three agent-facing surfaces (summary)

| Surface | Topology | Transport | Carries |
|---|---|---|---|
| Hooks (diagnostics, file-save) | A | stdio control_request `hook_callback` | post-edit `<ide_diagnostics>`, autosave |
| `canUseTool` | A | stdio control_request `can_use_tool` | permission prompts |
| SDK MCP `claude-vscode-extension` | A | in-process (`setMcpServers`) | debugger + Jupyter tools |
| WS MCP `Claude Code <IDE> MCP` (12 tools) | B | WebSocket | editor read/act tools + selection/diagnostics notifications |

---

## 21. Quanta mapping & gap table (verified)

Split by class (see §0.5). Don't conflate "in the extension" with "missing from quanta."

### A. Genuinely worth absorbing now (general capability quanta lacks or only partly has)
| Item | quanta today | Action |
|---|---|---|
| Compaction security-constraint verbatim preserve | **added 2026-06-07** | ✅ done |
| **Per-edit diagnostic-delta inject (§5 mechanism)** — run checker after each edit, inject only-NEW (8-tuple key, JSON) | turn-level verify/closeout only, not per-edit | wire Pre/PostToolUse hook pair; source = LSP (IDE) or `tsc --noEmit`/eslint (CLI) |
| **Control-request runtime surface (§2)** — uniform mid-session `set_model`/`set_permission_mode`/`get_context_usage`/`interrupt`/`rewind` over one channel | partial / scattered | consolidate as the `ide`-preset host↔agent control vocab |
| `thinClientDispatch` command routing across surfaces | 0 hits | add optional descriptor (`control-request`/`post-text`) |
| Elicitation generalized (vs binary `onConfirm`) (§19) | `onConfirm` only | generalize reviewer seam to arbitrary MCP-driven prompts |

### B. IDE-coupling — only when quanta ships its own editor extension (use this doc as the spec)
| Item | Source section |
|---|---|
| Lockfile discovery + WS MCP server + 12 `mcp__ide__*` tools (return shapes) | §6 |
| selection/at-mention notifications + editor-LSP diagnostics push | §4.5, §6.5, §9 |
| native `vscode.diff` accept/reject → reviewer `onConfirm` | §8 |
| webview UI protocol (~60 RPCs) + VS Code manifest/keybindings | §10, §11 |
| SDK-spawn-as-subprocess host topology | §1 |
| debugger/Jupyter MCP, terminal shell-integration exec | §7, §14 |

### C. General capabilities quanta ALREADY has (parity reference — NOT gaps; verify mechanism only if a specific behavior matters)
OAuth/credentials (§15) · /rewind file checkpoints + Shadow ODB (§17, reconcile ADR-0108) · conversation fork (§17) · session `.jsonl` storage + titles (§17) · permission modes/canUseTool (§4) · hooks engine + events (§3,§12) · MCP lifecycle + elicitation + MCP-OAuth (§19) · push notifications (§18) · remote runner (§18) · plugins (thin — verify) · compaction · worktree · advisor · streaming · follow-up queue.
(Skip: teleport — claude.ai-specific.)

**Build order recommendation:** (1) diagnostics hook pair [done-able now, CLI+IDE], (2) control-request +
thinClientDispatch vocab [unlocks the `ide` preset host contract], (3) full IDE adapter [own-extension
roadmap], with §6/§7 as the copy-from spec.

---

## 22. Source anchors & confidence
- **High confidence (extension source, [V]):** §1 spawn (42389-42541), §3 hooks (85360), §5 diagnostics
  (80875-81051), §6 lockfile/WS/tools (88082-88965), §7 Tde (81263-86211), §8 diff (Vfe@88082), §9 @-mention
  (87127), §11 manifest (package.json), §10.1/10.3 webview core. **PART 4:** §13 channel/Hu
  (66729-68348, 86457-86660), §14 terminal (63425, 85646-86152, 88693), §15 OAuth (27499-27825, 43165, 8029),
  §17 rewind/fork/storage (43245, 67082-67499, 68999), §18 chrome/remote/teleport/ssh/deeplink
  (68265-68729, 69119, 62354, 89244), §19 elicitation/plugins/notify (43140, 66869-66929, 85308, 86230).
- **Medium ([I], cross-agent synthesis):** §2 control subtypes, §4 can_use_tool shape, §10 full RPC catalog
  (some line refs unverified), §12 schema groupings.
- **Lower (strings dump only):** §6.3 CLI-side discovery/transport/reconnect/env — line refs in the 110k-,
  126k-, 146k-, 241k-line ranges of `_cli-symbols.txt`; the **SSE-vs-WS ordering is uncertain** — verify
  against a live `claude --debug` IDE connect before relying on it.
- Re-grep anchors: `thinClientDispatch:"`, `mcp__ide__`, `x-claude-code-ide-authorization`,
  `findDiagnosticsProblems`, `claude-vscode-extension`, `"--input-format"`.
