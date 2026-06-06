# Claude Code ↔ IDE Integration — Full Audit (reference spec)

**Status:** DRAFT / reference. Reverse-engineered from the shipping extension, not official docs.
**Subject:** How the Claude Code CLI connects to and drives a VS Code / Cursor / Windsurf editor.
**Sources (verbatim, line-anchored):**
- Extension host: `.extracted_source/claude-code-ide/extension.beautified.js` (Anthropic.claude-code **2.1.167**)
- Webview UI: `.extracted_source/claude-code-ide/webview/index.beautified.js`
- CLI side (strings): `.extracted_source/claude-code-cli/_cli-symbols.txt` (`@anthropic-ai/claude-code` 2.1.167)
- quanta target seam: [src/apps/agent/mode-presets/ide.ts](../../src/apps/agent/mode-presets/ide.ts) (ADR-0092)

Every claim below is tagged **[V]** = verified verbatim in source at the cited line, or **[I]** = inferred
(plausible from surrounding code but not a literal quote). Don't promote an [I] to fact without re-reading.

---

## 0. TL;DR topology

```
┌────────────────────────┐         WebSocket (loopback)          ┌──────────────────────────┐
│   IDE extension host    │  ◄───  MCP-over-WS, IDE = SERVER  ──► │   Claude Code CLI         │
│  (extension.js, in the  │                                       │  (native-binary `claude`, │
│   VS Code/Cursor proc)   │  ─ notifications ─►                   │   the MCP client)         │
│                         │    selection_changed                  │                           │
│  • hosts an MCP server  │    at_mentioned                       │  • discovers the IDE via  │
│    advertising 12 tools │    diagnostics_changed                │    ~/.claude/ide/*.lock   │
│  • writes lockfile      │  ◄─ tool calls ─                      │  • connects WS, calls     │
│  • spawns the CLI       │    openDiff / getDiagnostics / ...    │    mcp__ide__* tools      │
└────────────────────────┘                                       └──────────────────────────┘
        ▲  postMessage (webview protocol)
        ▼
┌────────────────────────┐
│  Webview panel (React)  │  the in-editor chat UI (separate from the WS/MCP path)
└────────────────────────┘
```

Two **independent** channels exist; don't conflate them:

1. **MCP-over-WebSocket** — the extension is the *server*, the CLI is the *client*. This is how the
   *agent* reads/acts on editor state (selection, diagnostics, open a diff, run a Jupyter cell). **[V]**
2. **Webview postMessage** — the extension ↔ the React chat panel. This is the *UI* path (render stream,
   accept/reject buttons, input box). It never touches the CLI directly; the extension bridges. **[V]**

> Correction to a common misread: for the IDE integration the transport is **WebSocket**, not stdio.
> stdio (`--input-format stream-json`) is the *separate* path used when the SDK spawns the CLI headless.
> The lockfile explicitly declares `transport: "ws"`. **[V]** (`extension.js:88657`)

---

## 1. Discovery & handshake

### 1.1 Lockfile  **[V]** (`extension.js:88644-88663`)

The extension creates `~/.claude/ide/` (`mode 0700`) and writes `<port>.lock` (`mode 0600`):

```jsonc
// ~/.claude/ide/<wsPort>.lock
{
  "pid": <process.ppid>,            // the editor's parent pid
  "workspaceFolders": ["/abs/path", ...],
  "ideName": "<vscode.env.appName>", // "Visual Studio Code" | "Cursor" | "Windsurf" | ...
  "transport": "ws",
  "runningInWindows": <bool>,
  "authToken": "<uuid>"              // == the WS auth secret, see 2.1
}
```

The CLI scans `~/.claude/ide/*.lock`, picks one matching the cwd's workspace folder, reads the port +
authToken, and dials the WebSocket. **[I]** (CLI side is compiled; the lockfile contract is the
verified half. CLI references `~/.claude/ide` discovery via the symbols dump.)

Lifecycle: lockfile is rewritten when workspace folders change (`extension.js:88661`), deleted on
teardown (`lme`, `extension.js:88665`). **[V]**

### 1.2 Port selection  **[V]** (`extension.js:88641-88692`)
- Random port in **[10000, 65535]** (`Jit`: `Math.floor(random()*55536)+1e4`).
- Probes up to **50** candidates with a throwaway `http.createServer().listen()` until one binds free.

### 1.3 Terminal env handoff  **[V]** (`extension.js:88693-88698`)
The extension injects env into the integrated-terminal collection (so `claude` launched from the
editor terminal auto-finds the IDE). Secret-looking keys (`KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`) are
redacted in logs. (CLI reads a port/enable env var — exact name lives compiled-in.)

---

## 2. Transport: MCP over WebSocket

### 2.1 Auth  **[V]** (`extension.js:88916-88926`)
- The extension stands up a `ws` server and a per-session `randomUUID()` secret (`f`).
- On connect it checks header `x-claude-code-ide-authorization === <secret>`; mismatch → `close(1008, "Unauthorized")`.
- The same secret is the `authToken` in the lockfile, so only a process that can read the user's
  `~/.claude/ide/` can connect. Single active client: a new connection evicts the previous one.

### 2.2 Framing  **[V]** (`extension.js:88699-88763`, class `U4`)
- Newline/whole-message JSON over WS; each message parsed and validated against a JSON-RPC schema (`P$.parse`).
- Standard JSON-RPC 2.0 envelopes: `{ jsonrpc: "2.0", method, params }` for notifications,
  request/response with `id` for tool calls.

### 2.3 MCP server identity  **[V]** (`extension.js:88765-88782`, `Yit`)
Server name is per-host: `"Claude Code VSCode MCP"` / `"Claude Code Cursor MCP"` /
`"Claude Code Windsurf MCP"` / `"Claude Code <appName> MCP"`.

---

## 3. The IDE MCP tool surface (server → exposed to the agent)

12 tools, registered at `extension.js:88790-88915`. The CLI calls these as `mcp__ide__<name>`
(the dump explicitly references `mcp__ide__getDiagnostics` and `mcp__ide__executeCode`). **[V]**

| Tool | Purpose | Input schema (verbatim) |
|---|---|---|
| `openDiff` | Open a git diff for a file (blocking accept/reject) | `old_file_path, new_file_path, new_file_contents, tab_name` (all strings) |
| `getDiagnostics` | Get language diagnostics from VS Code | `uri?` (optional; omit → all files) |
| `close_tab` | Close a tab by name | `tab_name` |
| `closeAllDiffTabs` | Close all diff tabs | `{}` → `CLOSED_<n>_DIFF_TABS` |
| `openFile` | Open file + optionally select a text range | `filePath, preview=false, startText, endText, selectToEndOfLine=false, makeFrontmost=true` (`readOnlyHint`) |
| `getOpenEditors` | List currently open editors | `{}` |
| `getWorkspaceFolders` | List workspace folders | `{}` |
| `getCurrentSelection` | Current selection in active editor | `{}` |
| `checkDocumentDirty` | Has unsaved changes? | `filePath` |
| `saveDocument` | Save a dirty document | `filePath` |
| `getLatestSelection` | Most recent selection even if editor inactive | `{}` |
| `executeCode` | Run Python in the current notebook's Jupyter kernel (persists across calls) | `code` |

Note `openDiff` is the **edit-application primitive**: the agent proposes new contents, the IDE shows a
native diff, the user accepts/rejects, and the call resolves accordingly (see §5). `executeCode` +
Jupyter and `getDiagnostics` are the two the CLI binary names directly.

---

## 4. Notifications (server → client; extension pushes editor state to the agent)

Three notifications, all `{ jsonrpc:"2.0", method, params }`:

### 4.1 `selection_changed`  **[V]** (`extension.js:88562-88625`)
Debounced **300ms** on `onDidChangeTextEditorSelection`; skips `comment`/`output` schemes; only fires
when the selection actually changed. Params:
```jsonc
{ "text": "<selected text>", "filePath": "/abs", "fileUrl": "file://...",
  "selection": { "start": {"line","character"}, "end": {"line","character"}, "isEmpty": bool } }
```
On (re)connect the extension replays the last selection after a 500ms settle. **[V]** (`88950-88956`)

### 4.2 `at_mentioned`  **[V]** (`extension.js:88571-88635`)
Fired when the user runs the "add to Claude" command on a file/range. Params:
`{ filePath, lineStart?, lineEnd? }`. The webview-facing form is the `@path#Lx-Ly` string (§6).

### 4.3 `diagnostics_changed`  **[V]** (`extension.js:88943-88947`)
A diagnostics client registered on connect fires `{ uris: string[] }` whenever VS Code diagnostics
change for any file. This is the *push* signal; the *pull* is the `getDiagnostics` tool.

---

## 5. Diff / accept-reject flow  **[V]** (`extension.js:28910-29054`, invoked by `openDiff`→`Vfe`)

1. Extension materializes original + proposed contents behind temp-file URI providers.
2. `vscode.commands.executeCommand("vscode.diff", left, right, "✻ [Claude Code] <a> → <b>", {preview:false, preserveFocus:true})`.
3. It then races three promises: an `acceptOrRejectDiffs` event (buttons), a document save (when
   `files.autoSave === "off"`), and a tab-close (dismiss). The tab is identified by its `✻ [Claude Code]` label.
4. Commands `claude-code.acceptProposedDiff` / `claude-code.rejectProposedDiff` fire the event; the tool
   call resolves with the accepted contents or a rejection. **[V]** (`29043-29054`, `87109-87118`)

Why it matters: edit application is **user-gated inside the native diff editor**, not a blind write.
The agent never touches the filesystem for IDE edits — it asks the IDE to apply, with human consent.

---

## 6. @-mention / "add to context"  **[V]** (`extension.js:87127-87143`)

Command `claude-code.insertAtMentioned`:
- empty selection → `@<relPath>`
- single line → `@<relPath>#L<n>`
- range → `@<relPath>#L<start>-<end>` (1-indexed)

Inserted into the webview input via a native callback, or, if absent, routed as the `at_mentioned`
notification (§4.2). One keystroke turns the current focus into a precise file reference.

---

## 7. ⭐ Diagnostics feedback loop (#2 — the high-value, IDE-specific mechanism)

**[V]** (`extension.js:80949-81048`, class `R2`, wired as Pre/PostToolUse **hooks** into the CLI)

This is the auto-injection loop that makes the agent *see compile/lint fallout of its own edits*:

1. **`PreToolUse`** on `Edit | MultiEdit | Write` → `captureBaseline(filePath)`: snapshot current
   diagnostics for that file into `baselineDiagnostics[path]`.
2. **`PostToolUse`** on the same → `findDiagnosticsProblems`:
   - If the file is in a **visible** editor → poll twice with waits **`[750, 750]`** ms (≤1.5s total).
   - If **hidden** → single wait **`[1000]`** ms.
   - On each tick, diff current vs baseline via `findNewDiagnostics` → keep **only NEW** problems.
   - First non-empty result returns:
     ```jsonc
     { "continue": true,
       "hookSpecificOutput": { "hookEventName": "PostToolUse",
         "additionalContext": "<ide_diagnostics>...formatted...</ide_diagnostics>" } }
     ```
   - Baseline is deleted after read (one-shot).

Key noteworthy details: the poll timing exists to let async linters/LSP catch up; the **baseline-diff
("only new")** prevents drowning the agent in pre-existing problems; delivery is via the **hook
`additionalContext`** channel, so it lands as turn context, not a tool result.

### Quanta mapping
- quanta's [ide.ts](../../src/apps/agent/mode-presets/ide.ts) declares "full LSP tools" available to the
  host but has **no** auto post-edit diagnostic-delta injection (verified: 0 hits for
  `ide_diagnostics` / `diagnosticsDelta` in `src`).
- quanta already has PreToolUse/PostToolUse hooks and an Edit/Write tool table → the loop is wireable as
  a hook pair without new core surgery. A diagnostics source is the only new dependency:
  - **IDE surface:** consume the host's LSP (mirror `getDiagnostics`).
  - **CLI surface:** substitute a `tsc --noEmit` / eslint runner scoped to the touched file. quanta's
    turn-level verify/closeout already covers correctness coarsely; this adds **per-edit** tightness.
- Reusable constants to copy: visible `[750,750]`, hidden `[1000]`, only-new diff, `<ide_diagnostics>` envelope.

---

## 8. ⭐ thinClientDispatch routing (#3 — multi-surface command correctness)

**[V]** Each slash-command definition in the CLI carries an optional `thinClientDispatch` tag telling a
**thin client** (IDE/web host that isn't a full TTY) *how* to run that command. Verified values
(`_cli-symbols.txt`): only **two** appear literally —

| value | meaning (from usage) | example commands |
|---|---|---|
| `"control-request"` | host issues a control RPC; result rendered by the host UI | `usage` (aliases `cost`/`stats`) |
| `"post-text"` | host posts text into the conversation stream | `toggle-memory`, `reload-skills`, `goal` |

Commands **without** the field default to normal/local execution. **[I]** The Explore pass also guessed
`local-then-rpc` / `unavailable`, but those were **not** found as `thinClientDispatch:` values — treat
as unconfirmed.

### Quanta mapping
- 0 hits for `thinClientDispatch` in `src` — the vocabulary is absent.
- quanta is multi-surface (CLI / Web-Tauri / embedded) and the `ide` preset has the **host driving the
  conversation**, so this is the missing "define a command once → it runs correctly on a thin host"
  descriptor. Without it, a command that assumes an interactive TTY breaks under the IDE/web host.
- Cheap shape: add an optional `thinClientDispatch?: "control-request" | "post-text"` field to quanta's
  command descriptor; the IDE/web adapter reads it to decide RPC vs stream-post; CLI ignores it.
- Slightly preemptive — full value lands when quanta ships a thin IDE/web client.

---

## 9. Webview ↔ extension protocol (the UI path)

**[V]** (`extension.js:85271, 86534`; `webview/index.beautified.js:141500-142650`)
postMessage, request/response matched by `requestId`. Not on the agent's critical path but defines the
panel UX.

Webview → extension: `launch_claude {channelId,resume,cwd,permissionMode,thinkingLevel}`, `io_message`,
`interrupt_claude`, `request`/`response`/`cancel_request`, `start/stop_speech_to_text`, `close_channel`.
Extension → webview: `io_message` (stream events), `request`/`response`, `speech_to_text_message`,
`speech_audio_level`, `file_updated {filePath,oldContent,newContent}`, `plan_comment`, `close_channel`.

Streaming model **[V]** (`webview index.js:142320-142410`, class `TCe`): SDK stream events
(`message_start` → `content_block_start/delta/stop` → `message_stop`) are reassembled into content-block
objects with `.updated()` / `.complete()` callbacks for incremental render. `thinking_delta` carries
`estimated_tokens` (cumulative) for a live thinking-token meter. Permission requests come over the same
RPC with a `suggestions[]` array (fast "always allow this tool"). Multiple user inputs queue FIFO in the
extension (`Hu`, `extension.js:68022`) so the user can type ahead mid-turn.

quanta likely already has equivalents (streaming, permission RPC, follow-up queue) — listed here for
completeness, not as a gap.

---

## 10. Auth / login  **[V]** (`extension.js:27495-27623, 88659`)
OAuth 2.0 with env-aware endpoints (prod `platform.claude.com`, local `localhost:3000`, custom via
`CLAUDE_CODE_CUSTOM_OAUTH_URL` allowlist). Credentials in OS keychain (macOS `security` CLI / Windows
secure storage). The lockfile `authToken` lets the spawned CLI validate the IDE session without
re-auth. Workspace-scoped via `workspaceFolders`.

(quanta already has ChatGPT-OAuth + provider seam — reference only.)

---

## 11. Registered commands  **[V]** (`extension.js:87091-89268`)
`editor.open`, `primaryEditor.open`, `editor.openLast`, `newConversation`, `reopenClosedSession`,
`toggleDictation`, `sidebar.open`, `window.open`, `logout`, `showLogs`, `openWalkthrough`,
`terminal.open`, `acceptProposedDiff`, `rejectProposedDiff`, `insertAtMentioned`.
URI handlers: `claude://install-plugin?plugin=&marketplace=`, `claude://open?session=&prompt=`.

---

## 12. ⭐ #4 — quanta IDE host-adapter blueprint

quanta's [ide.ts](../../src/apps/agent/mode-presets/ide.ts) explicitly says the editor adapter "lives
outside this repo" and must seed `req.base.{messages,stream,onConfirm,permission}`. This extension is a
**working reference** for that out-of-repo adapter. To build quanta's own VS Code/Cursor extension,
mirror:

1. **Discovery:** write `~/.<app>/ide/<port>.lock` with the §1.1 schema (rename namespace for quanta).
2. **Transport:** loopback WS server, per-session UUID in `x-...-ide-authorization`, single active client.
3. **MCP server:** advertise the §3 tool set (start with `openDiff`, `getDiagnostics`, `openFile`,
   `getCurrentSelection`, `getWorkspaceFolders`) so quanta's agent can act on editor state.
   → feeds `req.base.stream` (events) + `onConfirm` (the diff accept/reject becomes the reviewer modal).
4. **Notifications:** `selection_changed` (300ms debounce) + `diagnostics_changed` → drive §7.
5. **Diff flow:** `vscode.diff` + tab-label poll for accept/reject = quanta's `onConfirm` reviewer lever.
6. **Dispatch:** read `thinClientDispatch` (§8) to route slash commands on the thin host.

This is a **build-when-roadmap'd** item (own extension = large), but the protocol no longer needs
0-from-scratch design — it's specified above.

---

## 13. Gap summary vs quanta (verified)

| Item | In Claude Code | In quanta today | Action |
|---|---|---|---|
| Compaction security-constraint verbatim preserve | yes | **added 2026-06-07** (SUMMARY_SYSTEM + CONTINUATION_SYSTEM) | ✅ done |
| Diagnostics Pre/Post-edit delta inject (§7) | yes | no (LSP tools exposed only) | wire as hook pair; pick diagnostics source |
| `thinClientDispatch` routing (§8) | yes (2 values) | no (0 hits) | add optional descriptor field; adapter reads it |
| IDE host adapter (§1-6, §12) | yes (this ext) | designed seam only (ide.ts, "out of repo") | build when own-extension roadmap'd; use this as spec |
| advisor / loop / schedule / hooks / MCP / multi-scope memory / streaming / permission RPC / follow-up queue | yes | **already present** | none (not gaps) |

---

## 14. Source anchors (re-read before trusting any [I])
- Lockfile/port/WS/auth/tools/notifications: `extension.beautified.js:88560-89000`
- Diagnostics loop: `extension.beautified.js:80949-81048`
- Diff flow: `extension.beautified.js:28910-29054`, `87109-87143`
- Commands: `extension.beautified.js:87091-89268`
- Webview/streaming: `webview/index.beautified.js:141500-142650`
- thinClientDispatch values + mcp__ide__ tools: `claude-code-cli/_cli-symbols.txt` (grep `thinClientDispatch:"`, `mcp__ide__`)
