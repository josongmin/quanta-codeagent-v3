# `@/runner` Surface Integration Blueprint

- **Status**: Draft (companion to [RFC may-22 unified-agent-runtime](../rfc/may-22-unified-agent-runtime/00-rfc.md))
- **Date**: 2026-05-23
- **Audience**: anyone adding a new surface (CLI / Web / Tauri / cron / RPC / …)
- **Scope**: how surfaces enter the surface-agnostic Layer-2 `@/runner` slice
- **Non-goals**: re-deriving RFC may-22 §3 design; introducing new ADRs; presuming the in-flight `OAuthCallbackProvider` / `SessionRootProvider` PRs have landed
- **Predecessors**: ADR-0024 (CLI export-gap closure), ADR-0094 (ChatGPT OAuth Phase 1), [RFC §3.1 slice isolation](../rfc/may-22-unified-agent-runtime/00-rfc.md#41-의미론적-축-5개)

> The `@/runner` slice exists so a future `apps/web/` or `apps/tauri/` can be assembled in **hours, not weeks** — by consuming the same orchestration primitives `apps/cli` already drives, without copying argv parsing, env reads, or readline plumbing into a surface that has none of them. This document is the contract every new surface promises to honour.

---

## 1. Slice contract diagram

```
                       ┌──────────────────────────────────────────────────────┐
   Layer 3   apps/cli  │  apps/web   │  apps/tauri │  apps/agent │  apps/bench │  apps/eval
   (surface entry)     │             │             │  (unified)  │             │
                       └──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┴──────┬──┘
                              │             │             │             │             │
                              │   argv/HTTP/IPC → typed AgentConfig + ports
                              ▼             ▼             ▼             ▼             ▼
                       ┌──────────────────────────────────────────────────────────────┐
   Layer 2   @/runner  │   assemble/     │   orchestrate/   │   session-ops/          │
   (surface-agnostic)  │   ENV-free      │   runOnce        │   list/show/delete      │
                       │   typed config  │   runInteractive │   io as injected port   │
                       │   → built deps  │   resume FSM     │                          │
                       └──────────┬──────────────────┬──────────────────┬─────────────┘
                                  │                  │                  │
                                  ▼                  ▼                  ▼
                       ┌──────────────────────────────────────────────────────┐
   Layer 1.5 @/ui      │   format helpers · color · ui-helpers · status bar   │
                       └──────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────────────────────────────────────┐
   Layer 0  library    │  @/agent  @/llm  @/memory  @/mcp  @/lsp  @/permission│
                       │  @/observability @/session @/skill @/stream @/storage│
                       │  @/tool  @/auth  @/shared  @/security                │
                       └──────────────────────────────────────────────────────┘
```

**Arrow meaning**:

| Arrow | Meaning | Enforced by |
|---|---|---|
| `Layer 3 → Layer 2` | surface entry **owns** argv/HTTP/IPC parsing, then calls `@/runner` with a *typed* config + concrete *ports* | manual code review + per-surface tests |
| `Layer 2 → Layer 1.5` | `@/runner` may use UI helpers (color, format) **as long as they accept an injected sink** — no direct `process.stdout` | biome rule on `@/runner` (anti-`apps/**`) + 10-invariant test |
| `Layer 2 → Layer 0` | `@/runner` is a *cross-slice composer*; may import every library slice EXCEPT `@/rules` / `@/patch` / `@/migration` | [biome.json:625-654](../../biome.json) (`@/runner/**` override) |
| `Layer 0 → Layer 0` | library slices stay decoupled; cross-slice composition is the runner's job | RFC §3.1 + per-slice biome overrides |

**What `@/runner` is NOT**:

- Not a transport — it never opens an HTTP listener, never `process.stdin.on('data')`, never spawns a Tauri window. Surfaces do.
- Not a config parser — it takes typed objects. Surfaces parse argv / HTTP body / IPC payload first.
- Not a renderer — it emits typed `AgentEvent`s through `StreamPort`. The surface decides how they become ANSI, JSON, SSE, postMessage, etc.

---

## 2. CLI entry — the reference implementation

> The CLI is the *only* surface today. It is the **reference implementation** for how a surface adapts the runner contract.

### 2.1 Call graph

```
quanta <argv>
   │
   ▼
src/apps/cli/index.ts::main                                    (Layer 3)
   ├── argv[2] === "session"  ──► runSessionMain()                ─┐
   ├── argv[2] is "/<slash>" ──► runSlashMain(tok)                 │── short-circuit, no LLM
   ├── argv has --help/-h    ──► topLevelUsage() + exit            ─┘
   └── else                  ──► runRepl()
                                    │
                                    ▼
                          src/apps/cli/repl.ts::runRepl           (Layer 3 orchestrator)
                                    │
                                    ├── env reads (QUANTA_*) via ./internal::env()
                                    ├── argv reads (--image, --resume, …)
                                    ├── buildLLM / buildTooling / buildStreaming   ─► Layer 0 ports
                                    │
                                    ├── one-shot:   runAgent(assembleConfig(history, deps))
                                    │                       ▲
                                    │                       └─ @/runner/assemble (FUTURE; today inlined)
                                    │
                                    └── interactive: runReplLoopRaw({ … turn(input) … })
                                                                            │
                                                                            ▼
                                                               turn() → runAgent(assembleConfig(…))
```

Today `assembleConfig` lives at [src/apps/cli/config-assemble.ts:91](../../src/apps/cli/config-assemble.ts) and `SessionDeps` at [src/apps/cli/config-assemble.ts:25](../../src/apps/cli/config-assemble.ts). The migration target is to lift the **pure-composition core** of `assembleConfig` into `@/runner/assemble/` and leave only the CLI-specific *port constructors* (`buildLLM` reading `QUANTA_MODEL`, `buildTooling` reading `QUANTA_MCP_*`, etc.) in `apps/cli/`.

### 2.2 Three example invocations

#### One-shot: `quanta "hello world"`

```
1. index.ts::main         no session/slash/help → runRepl()
2. repl.ts::runRepl       argv[2] = "hello world" → positional prompt branch
3. repl.ts::loadFeatures  env knobs → planMode/metrics/mcp/lsp/git config
4. repl.ts::buildTooling  registry + memory store + skills config
5. repl.ts::turn("hello world")
   ├── persona = pickPersona()      (QUANTA_PERSONA, default "default")
   ├── system  = buildSystemPrompt(cwd, { persona })
   ├── cfg     = assembleConfig([userMsg], turnDeps)
   ├── outcome = await runAgent(cfg)                ──► @/agent loop
   └── persistTurn(sessionId, …)                    ──► @/session
6. process.exit(outcome.exitCode)
```

#### Interactive: `quanta`

```
1. index.ts::main         → runRepl()
2. repl.ts::runRepl       no positional prompt → runReplLoopRaw branch
3. raw-line-reader hooks  process.stdin in raw mode + keypress events
4. for-each input:
   ├── if startsWith("/")        → tryRunReplSlash(input, slashCtx)
   ├── elif "/exit"|"/quit"      → break
   └── else                      → turn(input)
5. SIGINT / EOF                  → graceful shutdown, flush session
```

#### Session subcommand: `quanta session list`

```
1. index.ts::main → argv[2] === "session" → runSessionMain()
2. runSessionMain (repl.ts:260-276) constructs SessionCommandDeps:
     out:     (s) => process.stdout.write(s)
     err:     (s) => process.stderr.write(s)
     confirm: async (p) => rl.question(p) === "y"
3. runSessionCommand(argv.slice(3), deps)            ──► session-commands.ts
4. dispatcher matches "list" → list-mode handler
5. exit(code)
```

The session sub-tree is *already runner-shaped*: a typed `SessionCommandDeps` port at [src/apps/cli/session-commands.ts:38-46](../../src/apps/cli/session-commands.ts) with `out/err/confirm` and an optional `homeDir` for hermetic tests. This is the pattern every surface will mirror.

---

## 3. Web entry — `apps/web/` (planned)

> **Status**: not in tree. This section is the *blueprint* the first `apps/web/` PR follows.

### 3.1 Server choice

Recommendation: **`Bun.serve` + minimal router** (the project already runs on Bun; zero new deps; matches the no-install constraint). Hono / Fastify are acceptable but add transitive surface — defer until the routing footprint outgrows `~30 routes`.

### 3.2 `POST /api/turn` — one-shot HTTP entry

```ts
// apps/web/server.ts (illustrative — NOT in tree)
import { runOnce } from "@/runner/orchestrate"          // FUTURE export
import { assembleAgentConfig } from "@/runner/assemble" // FUTURE export
import { httpBodyToTypedConfig } from "./adapters/config"
import { sseStreamPort } from "./adapters/stream"
import { httpConfirmStub } from "./adapters/confirm"
import { tenantSessionRoot } from "./adapters/session-root"

Bun.serve({
  port: 8787,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "POST" && url.pathname === "/api/turn") {
      // 1) parse + validate HTTP body → typed config (NEVER inside @/runner)
      const body = await req.json()
      const typed = httpBodyToTypedConfig(body)        // throws 400 on bad shape

      // 2) per-tenant session root (blocker #2 — see §6)
      const sessionRoot = tenantSessionRoot(body.tenantId)

      // 3) SSE response — StreamPort writes into ReadableStream controller
      const { readable, port: stream } = sseStreamPort()

      // 4) fire-and-forget runOnce — does NOT await before returning the
      //    SSE response; events stream live to the client.
      runOnce({
        ...typed,
        stream,
        sessionRoot,
        onConfirm: httpConfirmStub(body.sessionId),    // §3.5 below
      }).catch((e) => {
        stream.emit({ type: "error", message: String(e) })
      }).finally(() => stream.emit({ type: "done" }))

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      })
    }
    return new Response("not found", { status: 404 })
  },
})
```

### 3.3 SSE `StreamPort` adapter

```ts
// apps/web/adapters/stream.ts (illustrative)
import type { AgentEvent, StreamPort } from "@/stream"

export const sseStreamPort = (): { readable: ReadableStream; port: StreamPort } => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const enc = new TextEncoder()
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => { controller = c },
  })
  const port: StreamPort = {
    emit: (event: AgentEvent) => {
      // SSE frame: one `event:` + one `data:` line per AgentEvent
      controller.enqueue(enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      if (event.type === "done" || event.type === "error") {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  }
  return { readable, port }
}
```

**Contract**: `StreamPort.emit` is **synchronous** and **never throws**. Bursty events (per-token streaming) MUST not block — back-pressure is the surface's problem. `ReadableStream`'s built-in queueing handles single-client SSE up to ~MB/s; for higher rates use a `WritableStream` pump with `desiredSize` checks.

### 3.4 Authentication: per-tenant `SessionRootProvider` (BLOCKER #2)

The CLI uses `runtimeConfig().sessionsDir ?? ~/.quanta/sessions` — a single global path. A multi-tenant web surface MUST scope by `userId` to prevent cross-tenant leakage. The in-flight `SessionRootProvider` port (see §6) gives:

```ts
// FUTURE — track-SessionRoot PR
export interface SessionRootProvider {
  resolve(ctx: { userId?: string; tenantId?: string }): Promise<string>
}

// apps/web/adapters/session-root.ts (consumer)
export const tenantSessionRoot = (tenantId: string): SessionRootProvider => ({
  resolve: async (ctx) => `/var/quanta/sessions/${tenantId}/${ctx.userId ?? "anon"}`,
})
```

Until that port lands, web surfaces MUST NOT call `runOnce` with sessions enabled (or must monkey-patch `runtimeConfig` per-request, which is unsafe in a long-running server). The first `apps/web/` PR depends on the SessionRoot track.

### 3.5 OAuth: `OAuthCallbackProvider` (BLOCKER #1)

The CLI's [browser-flow.ts:158+](../../src/auth/chatgpt-oauth/browser-flow.ts) opens an **HTTP listener on a loopback port** and waits for the IDP to redirect. That contract is fundamentally CLI-shaped — a server can't bind another server for each user. The pending `OAuthCallbackProvider` port abstracts the wait:

```ts
// FUTURE — track-OAuth PR
export interface OAuthCallbackProvider {
  /** Returns the redirect URL the IDP should call back. */
  redirectUri(): string
  /** Resolves when the IDP callback arrives with this `state`. */
  waitForCode(state: string, opts: { timeoutMs?: number }): Promise<{ code: string }>
}
```

**Per-surface implementations**:

| Surface | `redirectUri()` | `waitForCode()` |
|---|---|---|
| CLI | `http://127.0.0.1:<port>/callback` (loopback bind) | `await listener; resolve on /callback` |
| Web | `https://<origin>/oauth/callback` (existing route) | resolve from a per-state map populated by the existing `GET /oauth/callback` handler |
| Tauri | `quanta://oauth/callback` (deep-link, OS-registered) | resolve when the OS dispatches the URL to the running app via `tauri::Manager` |

### 3.6 MCP pool — `per-request fresh` vs `per-session pool`

The CLI spawns MCP stdio clients **once per process** (long-lived). A web surface has two options:

| Pattern | Pros | Cons | Recommendation |
|---|---|---|---|
| **per-request fresh** | hermetic, no leakage across tenants | spawn cost ~50–200ms per turn; multiplies MCP server cold-start | dev / low-QPS only |
| **per-session pool** | warm spawns, isolated per user-session | needs LRU + idle-eviction + crash recovery | production, requires `McpPool` (see §6) |

The Audit-W flag recommends a `McpPool` slice (TBD). Until it exists, web demos should hard-code per-request and document the cost.

### 3.7 `onConfirm` async modal — the hardest port

CLI uses synchronous readline `await rl.question(...)`. Web/Tauri can't block a turn waiting for human keystrokes synchronously across an HTTP round-trip. The pattern:

```ts
// apps/web/adapters/confirm.ts (illustrative)
const pendingConfirms = new Map<string, (allow: boolean) => void>()

export const httpConfirmStub = (sessionId: string) =>
  async (action: ToolAction): Promise<boolean> => {
    const actionId = crypto.randomUUID()
    const promise = new Promise<boolean>((resolve) => {
      pendingConfirms.set(`${sessionId}:${actionId}`, resolve)
    })
    // Emit a confirm-request event via the SSE stream the client is reading;
    // the client renders a modal and POSTs the answer to a separate endpoint.
    stream.emit({
      type: "confirm-request",
      actionId,
      summary: summarizeAction(action),
    })
    // 30s timeout → auto-deny
    return Promise.race([
      promise,
      new Promise<boolean>((r) => setTimeout(() => r(false), 30_000)),
    ])
  }

// Separate endpoint:
// POST /api/turn/:sessionId/confirm  { actionId, allow: true }
//   → pendingConfirms.get(...)?.(body.allow)
```

**Watch-outs**: turn-level wall-clock budgets are still enforced inside `@/runner` via `AbortSignal`; a 30s confirm hold may exceed `wallClockMs`. The web surface SHOULD pass `signal` from a `setTimeout(() => abortCtl.abort(), wallClockMs)` AND extend it whenever a `confirm-request` is emitted (UX: spinner with countdown).

---

## 4. Tauri entry — `apps/tauri/` (planned)

> **Status**: not in tree. The web blueprint covers most of this; below are Tauri-specific differences.

### 4.1 IPC command shape

```rust
// src-tauri/src/main.rs (illustrative)
#[tauri::command]
async fn run_turn(window: tauri::Window, req: TurnReq) -> Result<(), String> {
    // Spawn the JS-side runOnce via the existing bundled sidecar (Bun build),
    // or — if running the JS in-process — invoke a JS helper through the
    // tauri::Manager event channel.
    invoke_run_once(req, move |event| {
        window.emit("agent-event", event).ok();
    }).await
}
```

JS-side wrapper (renderer process):

```ts
// apps/tauri/src/agent-client.ts (illustrative)
import { invoke } from "@tauri-apps/api/tauri"
import { listen } from "@tauri-apps/api/event"

export const startTurn = async (req: TurnReq, onEvent: (e: AgentEvent) => void) => {
  const un = await listen<AgentEvent>("agent-event", (e) => onEvent(e.payload))
  try { await invoke("run_turn", { req }) }
  finally { un() }
}
```

The IPC channel replaces SSE; otherwise the adapters mirror §3 1:1.

### 4.2 Deep-link OAuth callback

Tauri supports custom protocol registration (`quanta://`). The flow:

```
1. user clicks "Sign in"               → window.invoke("start_oauth")
2. apps/tauri opens browser to IDP     → tauri::shell::open("https://idp/authorize?...")
3. IDP redirects to quanta://oauth/callback?code=…
4. OS hands URL to running app         → tauri::Manager::on_protocol_event("oauth")
5. handler resolves the OAuthCallbackProvider's waitForCode pending promise
6. token exchange continues as normal  (existing pkce.ts / refresh.ts unchanged)
```

Note: deep-link registration requires `tauri.conf.json` `bundle.identifier` configuration AND OS-level setup (Info.plist on macOS, Registry on Windows, .desktop file on Linux). This is `apps/tauri/`'s problem, not `@/runner`'s.

### 4.3 `onConfirm` via native dialog

```ts
// apps/tauri/src/adapters/confirm.ts (illustrative)
import { ask } from "@tauri-apps/api/dialog"

export const nativeConfirm = (action: ToolAction): Promise<boolean> =>
  ask(`Allow ${action.tool} on ${summarizePath(action)}?`, {
    title: "Quanta — Tool Confirmation",
    type: "warning",
  })
```

This is the simplest implementation — Tauri's `dialog::ask` is synchronous from JS perspective (returns a Promise but blocks the renderer modally). No `pendingConfirms` map needed.

### 4.4 `SessionRootProvider`: app-data-dir

```ts
// apps/tauri/src/adapters/session-root.ts (illustrative)
import { appDataDir } from "@tauri-apps/api/path"

export const tauriSessionRoot: SessionRootProvider = {
  resolve: async () => `${await appDataDir()}/sessions`,
}
```

Single-user per-OS-account → no tenancy concerns. Matches the CLI semantics exactly, only the root differs.

---

## 5. Bench / Eval / Probe entries

### 5.1 Current state

| App | Path | Current assemble | Calls `runAgent` directly? |
|---|---|---|---|
| `apps/agent` | [src/apps/agent/](../../src/apps/agent/) | [assemble.ts](../../src/apps/agent/assemble.ts) (unified, RFC may-22 Phase 4) | yes — via mode-presets |
| `apps/bench` | [src/apps/bench/](../../src/apps/bench/) | [bench/runner.ts#buildConfig](../../src/apps/bench/) | yes — directly |
| `apps/eval` | [src/apps/eval/](../../src/apps/eval/) | observation pipeline — does NOT run the agent, ingests trajectories | n/a |
| `apps/probe` | [src/apps/probe/](../../src/apps/probe/) | post-run trajectory triage | n/a |
| `apps/cli` | [src/apps/cli/](../../src/apps/cli/) | [config-assemble.ts#assembleConfig](../../src/apps/cli/config-assemble.ts) | yes — directly |

### 5.2 ROI of routing bench/cli through `@/runner/assemble`

| Aspect | If we keep duplicate assemblers | If we unify on `@/runner/assemble` |
|---|---|---|
| Lines saved | 0 | ~120 (overlap between `apps/cli/config-assemble.ts:91-145` and `apps/agent/assemble.ts:134-159`) |
| Tool-wiring drift risk | HIGH (RFC may-22 §2.1 LSP-nav case) | LOW (single composition site) |
| Mode-matrix invariant | enforced only in `apps/agent` | enforced everywhere (`@/runner` calls `assertModeMatrix`) |
| Test surface | per-app | one `runner/assemble.test.ts` covers all |
| Migration risk | n/a (status quo) | bench `predictions.jsonl` MUST stay byte-identical (RFC §3.2 N3) |

**Recommendation**: do the route-through in **two PRs**:

1. **PR-A** (low risk): move the *pure composition* (the `assembleConfig` body — combining `messages + sessionDeps → AgentConfig`) into `@/runner/assemble/from-deps.ts`. `apps/cli/config-assemble.ts` becomes a re-export shim. Bench/agent unaffected.
2. **PR-B** (higher risk): lift `apps/agent/assemble.ts::assembleAgentConfig` into `@/runner/assemble/with-mode.ts` so `apps/agent` and `apps/bench` share it. Bench predictions regression run required (RFC §3.2 N3).

PR-A is "Audit-W ready"; PR-B is gated on the McpPool/SessionRoot tracks (changing bench's port surface would force a flag-day rather than incremental adoption).

---

## 6. Port inventory (in/out)

> Concrete ports the runner consumes (in) or emits (out). "**FUTURE**" = pending track listed in Audit-W §5 blockers. "**in main**" = already exported from a library slice today.

| Port | Defined at | CLI impl | Web impl (planned) | Tauri impl (planned) | Entry PR |
|---|---|---|---|---|---|
| `StreamPort` | [src/stream/ports.ts:3](../../src/stream/ports.ts) — `{ emit(event: AgentEvent): void }` | `JsonlRecorder + StdoutStream` (see `repl.ts::buildStreaming` at [internal.ts](../../src/apps/cli/internal.ts)) | SSE `WritableStream` writer (§3.3) | Tauri `window.emit("agent-event", e)` (§4.1) | in main |
| `OAuthCallbackProvider` | FUTURE — `@/auth/chatgpt-oauth/callback-port` | loopback HTTP bind ([browser-flow.ts:158](../../src/auth/chatgpt-oauth/browser-flow.ts)) | per-origin redirect + per-state map | OS deep-link (`quanta://oauth/callback`) | **Track-OAuth** |
| `SessionRootProvider` | FUTURE — `@/session/root-port` | `runtimeConfig().sessionsDir ?? ~/.quanta/sessions` (see [runtime-config.ts:117](../../src/shared/runtime-config.ts)) | `/var/quanta/sessions/<tenantId>/<userId>` | `appDataDir()/sessions` | **Track-SessionRoot** |
| `PromptSource` | FUTURE — `@/runner/orchestrate/prompt-source` | `raw-line-reader` ([src/apps/cli/raw-line-reader.ts](../../src/apps/cli/raw-line-reader.ts)) | WebSocket message stream | Tauri IPC `prompt` event | **Track-RunInteractive** |
| `onConfirm` | `AgentConfig.onConfirm: (action: ToolAction) => Promise<boolean>` (see [config-assemble.ts:37](../../src/apps/cli/config-assemble.ts)) | readline `rl.question` ([repl.ts](../../src/apps/cli/repl.ts)) | async modal + `pendingConfirms` map (§3.7) | native `dialog::ask` (§4.3) | in main |
| `SessionDeps.out` / `err` | [config-assemble.ts:38](../../src/apps/cli/config-assemble.ts) on `SessionCommandDeps`; on `SessionDeps` indirectly through `stream` | `process.stdout.write` / `process.stderr.write` | `Response.write` (SSE frame) | `invoke_send_event` | in main |
| `McpClient[]` (per-turn lifecycle) | `@/mcp` `McpClientPool` (planned) — today inlined in `apps/cli` | local stdio spawn at REPL boot, cleaned at shutdown | per-session pool with LRU eviction (§3.6) | local spawn (single-user, single-process) | **Track-McpPool** (future) |
| `permission` | `PermissionContext` from [src/permission/types.ts](../../src/permission/) | env-driven (`QUANTA_PERMISSION`) | per-request `mode` from auth-scope | per-window setting | in main |
| `BudgetMeter` | [src/agent/budget/meter.ts](../../src/agent/) (via `assembleAgentConfig`) | RFC may-22 preset clamped to dial | same | same | in main |

### 6.1 Port maturity legend

- **in main** — port + at least one production consumer exists; safe to depend on now
- **Track-XXX** — RFC accepted, code in flight; reference the track PR before importing
- **future** — discussed, not RFC'd; do not pre-build

---

## 7. Slice isolation invariants (10 lint guards)

Two-layer enforcement: TypeScript path constraints + biome `noRestrictedImports`. Both files are live in main (commit `5c1668b`, runner scaffold).

| # | Guard | Mechanism | Location |
|---|---|---|---|
| 1 | `@/runner` may NOT import `@/rules` | biome `noRestrictedImports` | [biome.json:636](../../biome.json) |
| 2 | `@/runner` may NOT import `@/patch` | biome `noRestrictedImports` | [biome.json:637](../../biome.json) |
| 3 | `@/runner` may NOT import `@/migration` | biome `noRestrictedImports` | [biome.json:638](../../biome.json) |
| 4 | `@/runner` may NOT import any `apps/**` | biome `noRestrictedImports.patterns` | [biome.json:642-647](../../biome.json) |
| 5 | `@/runner` may NOT touch `process.stdin/stdout/stderr` directly | tests/unit/runner-slice-boundary.test.ts (FUTURE) | (planned with first runner module) |
| 6 | `@/runner` may NOT use `console.*` (must go through StreamPort or injected sink) | biome `noConsole` (project default) | [biome.json](../../biome.json) |
| 7 | `@/runner` may NOT read `process.env` / `process.argv` directly | runner-slice-boundary test scans AST | (planned) |
| 8 | `@/runner` may NOT import `node:readline` / `node:tty` / `node:repl` | biome `noRestrictedImports` (planned extension) | (planned) |
| 9 | `@/runner` public API goes through `src/runner/index.ts` barrel only | `noBarrelBypass` lint rule + path alias `@/runner` only | [tsconfig.json:68-69](../../tsconfig.json) |
| 10 | Public `@/runner` exports must keep shim signatures byte-identical (132+ existing consumers) | export-shape diff test (FUTURE; baseline = empty barrel today) | (planned) |

Guards #5, #7, #8, #10 land with the first concrete `@/runner` submodule (`assemble/` or `orchestrate/`). Today the barrel is empty (`export {}` at [src/runner/index.ts:23](../../src/runner/index.ts)) so guards #1–#4, #6, #9 are sufficient.

---

## 8. New-surface checklist

When adding `apps/<surface>/`, verify each item below before merging:

- [ ] **Input adapter**: argv / HTTP / IPC parser maps to a *typed* config object (no `any`, no `unknown` past the parse boundary)
- [ ] **Call site**: `runOnce({...})` (one-shot) or `runInteractive({...})` (interactive); never reach into `@/agent` directly from the surface
- [ ] **`StreamPort` adapter**: synchronous `emit` that never throws; back-pressure handled at the surface
- [ ] **`onConfirm` adapter**: surface-native UX (readline / SSE modal / native dialog); honours `AbortSignal`
- [ ] **`SessionRootProvider`**: tenant-scoped if multi-user; single global for single-user surfaces
- [ ] **`OAuthCallbackProvider`**: only if OAuth login is exposed in this surface — otherwise skip
- [ ] **`PromptSource`**: only for interactive surfaces; one-shot surfaces pass the prompt in the initial config
- [ ] **Integration test**: at minimum one end-to-end `runOnce` test with fake LLM + fake MCP, asserting `AgentEvent` ordering
- [ ] **UI primitive isolation**: any surface-specific renderer (ANSI / HTML / React component) lives under `apps/<surface>/` — never in `@/runner` or `@/ui`
- [ ] **Lint**: `bun run lint` passes the new surface against the `@/runner` biome overrides
- [ ] **Doc**: append a row to §6 port inventory with the new surface's column populated

---

## 9. Anti-patterns and traps

| Anti-pattern | Why it breaks | Caught by |
|---|---|---|
| `process.env.X` inside `@/runner/**` | couples runner to a transport (env vars are surface input) | guard #7 (planned) + manual review |
| `process.argv` inside `@/runner/**` | same as above; argv is CLI-shaped | guard #7 (planned) |
| `console.log` / `console.error` in `@/runner/**` | bypasses StreamPort; events never reach surface consumers | guard #6 (biome) |
| Raw `process.stdin.on('data')` in `@/runner/**` | locks runner to a TTY surface | guard #5 (planned) |
| `import "node:readline"` in `@/runner/**` | TTY-only API; web/tauri have no readline | guard #8 (planned) |
| `import "../apps/cli/internal"` (or any `apps/**`) from a library slice | inverts the dependency arrow (Layer 0 → Layer 3) | guard #4 (biome, already live) |
| Changing the byte-shape of a shim re-export (e.g. renaming a field on `SessionDeps`) | 132+ downstream consumers break silently if test coverage is thin | guard #10 (planned) + grep audit before any rename |
| Bypassing `runOnce` and calling `runAgent` directly from a new surface | skips the resume-FSM + budget meter + per-turn save plumbing | code review (no lint can catch this — it's *what* you import) |
| Synchronous `onConfirm` in web (e.g. `confirm()` browser API) | blocks the entire renderer; doesn't compose with SSE | runtime spec: `onConfirm` returns `Promise<boolean>` |
| Spawning fresh MCP clients per-request without caching | 100–500ms tax per turn; user-visible jank | metric: turn-latency p95 budget |

---

## 10. Future evolution

### 10.1 First `apps/web/` PR breakdown (Audit-W recommendation)

| Sub-PR | Scope | Depends on |
|---|---|---|
| **W-1** | `apps/web/server.ts` with `GET /healthz` only — wires `Bun.serve` and the `apps/web/` slice biome override | none |
| **W-2** | `POST /api/turn` (no auth, no sessions) — proves `runOnce` is callable from HTTP | W-1 |
| **W-3** | SSE `StreamPort` adapter + integration test | W-2 |
| **W-4** | `OAuthCallbackProvider` Web impl + `/oauth/callback` route | W-3, **Track-OAuth** |
| **W-5** | per-tenant `SessionRootProvider` + persistence | W-4, **Track-SessionRoot** |
| **W-6** | `pendingConfirms` map + `POST /api/turn/:id/confirm` | W-5 |
| **W-7** | per-session MCP pool | W-6, **Track-McpPool** |

W-1 through W-3 are unblocked TODAY. W-4+ wait on parallel tracks.

### 10.2 `McpPool` refactor

Today MCP clients are spawned once at REPL boot in [apps/cli/repl.ts::loadFeatures](../../src/apps/cli/repl.ts). A web surface needs per-session pooling with idle-eviction. The refactor moves spawn/cleanup into a `@/mcp/pool` module that:

- accepts a `key: string` (e.g. `sessionId` or `userId`) and a `McpServerConfig`
- returns an `McpClient` from a warm pool or spawns a new one
- evicts clients idle > N seconds (LRU)
- handles spawn-time crash with a circuit-breaker (don't hammer a broken server)

CLI consumes the pool with `key = "single"` (single-process semantics); web consumes with `key = sessionId`. Tauri matches CLI.

### 10.3 `runInteractive` over WebSocket

For web parity with the CLI REPL, a future `runInteractive` consumer needs a `PromptSource`:

```ts
// FUTURE — @/runner/orchestrate/prompt-source
export interface PromptSource {
  next(signal: AbortSignal): Promise<string | "EOF">
}
```

WebSocket impl:

```ts
const wsPromptSource = (ws: WebSocket): PromptSource => ({
  next: (signal) => new Promise((res, rej) => {
    const onMsg = (ev: MessageEvent) => { cleanup(); res(String(ev.data)) }
    const onClose = () => { cleanup(); res("EOF") }
    const onAbort = () => { cleanup(); rej(new DOMException("aborted", "AbortError")) }
    const cleanup = () => {
      ws.removeEventListener("message", onMsg)
      ws.removeEventListener("close", onClose)
      signal.removeEventListener("abort", onAbort)
    }
    ws.addEventListener("message", onMsg)
    ws.addEventListener("close", onClose)
    signal.addEventListener("abort", onAbort)
  }),
})
```

### 10.4 Multi-modal input — port extension vs new port

Current text-only assumption: `PromptSource.next` returns `string`. Adding image / voice input is a design fork:

| Option | Pros | Cons |
|---|---|---|
| **Extend `PromptSource`**: change return to `string \| Message[]` (with `ImageBlock`s) | one port, one consumer | breaking change; every PromptSource impl updates; "voice" doesn't fit text shape |
| **New `MultiModalPromptSource`**: discriminated union of `text \| image \| audio` blocks | clean per-modality typing; can mix-and-match | two ports for surfaces that do both; `@/runner` decides which to consume per call |

**Recommendation**: defer until a second modality (image) actually ships in a surface. Today `apps/cli` accepts `--image <path>` and inlines `ImageBlock` into the first user message ([apps/cli/image-loader.ts](../../src/apps/cli/image-loader.ts)) — same pattern is fine for web file-upload until interactive multi-modal turns are needed.

### 10.5 RPC service-ization (deferred per RFC §3.2 N1)

If 3+ surfaces ship, the cost of keeping each surface's `apps/<surface>/` thin wrapper in sync may justify extracting `@/runner` behind a JSON-RPC service (OpenHands pattern). RFC may-22 §3.2 N1 explicitly defers this; the `@/runner` slice is **shaped to make that extraction easy** (typed config + typed ports + no transport coupling), but does not perform it. Re-open the RFC if/when the third surface is on the roadmap.

---

## 11. Audit-W blocker traceability

The Audit-W pass (73% ready for `apps/web/` extraction) called out **5 blockers + 3 recommended ports**. This document covers each:

| Blocker | Covered in | Status in this doc |
|---|---|---|
| #1 OAuth callback Web-shape | §3.5, §4.2, §6 row "OAuthCallbackProvider" | port specified; impls described per surface; marked FUTURE / Track-OAuth |
| #2 SessionRoot per-tenant | §3.4, §4.4, §6 row "SessionRootProvider" | port specified; impls described per surface; marked FUTURE / Track-SessionRoot |
| #3 MCP per-session pool | §3.6, §10.2, §6 row "McpClient[]" | refactor blueprint documented; marked future / Track-McpPool |
| #4 Async confirm modal | §3.7, §4.3, §6 row "onConfirm" | pattern + back-pressure trap documented; in-main today (sync impl), web pattern is FUTURE |
| #5 Interactive PromptSource over WebSocket | §10.3, §6 row "PromptSource" | port shape specified; WebSocket impl sketched; marked FUTURE / Track-RunInteractive |

Recommended ports (Audit-W §6, beyond blockers): `OAuthCallbackProvider`, `SessionRootProvider`, `McpPool` — all named in §6 with current/planned impls.

---

## 12. References

- RFC may-22: [docs/rfc/may-22-unified-agent-runtime/00-rfc.md](../rfc/may-22-unified-agent-runtime/00-rfc.md) — §3 design, §4.5 single wiring point, §6 anti-regression invariants
- RFC may-22 plan: [docs/rfc/may-22-unified-agent-runtime/01-implementation-plan.md](../rfc/may-22-unified-agent-runtime/01-implementation-plan.md) — §1.1 slice topology, §1.2 biome boundaries
- ADR-0024: CLI export-gap closure (origin of `apps/cli/internal.ts`)
- ADR-0094: ChatGPT OAuth Phase 1 ([commits log search for "0094"](../decisions/))
- Runner barrel: [src/runner/index.ts](../../src/runner/index.ts) (currently `export {}`, scaffolded at commit `5c1668b`)
- Biome `@/runner` overrides: [biome.json:625-654](../../biome.json)
- Reference CLI entry: [src/apps/cli/index.ts](../../src/apps/cli/index.ts), [src/apps/cli/repl.ts](../../src/apps/cli/repl.ts)
- Reference unified entry: [src/apps/agent/index.ts](../../src/apps/agent/index.ts), [src/apps/agent/assemble.ts](../../src/apps/agent/assemble.ts)
- Reference port: [src/stream/ports.ts](../../src/stream/ports.ts)
- Reference SessionDeps: [src/apps/cli/config-assemble.ts](../../src/apps/cli/config-assemble.ts)

---

## 13. Change log

| Date | Change |
|---|---|
| 2026-05-23 | Initial blueprint — CLI reference, Web/Tauri/Bench blueprints, 10-guard inventory, Audit-W blocker mapping |
