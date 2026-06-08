# Ticket 08 — web/IDE `/plugins` surface (enable · disable · list)

**Date:** 2026-06-08 · **Wave:** D (surface UX) · **Kind:** EXTEND web surface
(SlashPalette catalogue) + NEW `slash-plugins.ts` client module + NEW web-daemon
route + EXTEND the daemon facade/seam.
**Gap:** #4 (surface half, web/IDE) — the `/plugins` enable/disable UI for the
**web/IDE** surface. This is the **parallel of ticket 06** (CLI `/plugins`): the
plugin CORE (skill source 01 / activation 02 / routing 04 / capability 05 /
plugin-session 03) is minted at the **shared** assembler (`agent-config-assembler.ts`,
00-index.md:60-66 + ticket 07), so it is **already ON for the web/IDE agent runtime**
the moment 07 lands. This ticket is ONLY the **enable/disable UI** + the
**client↔server path** to read + mutate the server-side
`AgentConfig.pluginSession` (ticket 03).
**Gate:** `QUANTA_PLUGIN_MODE` (ticket 07) · default-OFF byte-identical.
**Deps:** needs **03** (`PluginSessionHandle` + the `AgentConfig.pluginSession` slot)
and **07** (shared-assembler mint that puts the handle on the live web/IDE session);
**parallels 06** (CLI half — same handle contract, different surface).
**Discipline:** default-OFF byte-identical · TDD red-first · ≥3R audit · slice-fence.

---

## TL;DR — the hard part, stated up front

**There is NO client→server channel today that can mutate `AgentConfig.pluginSession`.**

The web surface already has *one* client→server mutation channel — `POST /config`
(`src/apps/web-daemon/server.ts:744-754` → `handleConfigPost` `:335-368`). But it
writes **`process.env` only**, against a **closed 6-key allowlist**
(`CONFIG_ALLOWED_KEYS` `:308-315` = the LLM knobs `QUANTA_FAST` / `QUANTA_SERVICE_TIER`
/ `QUANTA_MODEL` / `QUANTA_REASONING_EFFORT` / `QUANTA_REASONING_SUMMARY` /
`QUANTA_REASONING_VERBOSITY`). `slash-llm-config.ts:29-55` + `slash-auth.ts` ride
this env channel exactly because the LLM adapter re-reads `process.env` per call
(`slash-llm-config.ts:11-16` header).

**`pluginSession` is NOT env state.** Per ticket 03 it is an **in-memory closure
handle** (`PluginSessionHandle`, 03-…md:46-59) seated on the **live shared
session's** `AgentConfig.pluginSession` slot (03-…md:133-148), created inside the
`runtime-factory.ts` `base` config closure (`runtime-factory.ts:206-221`). It is
**not** on `process.env`, **not** on `RuntimeSession` (the typed command surface,
`src/sdk/runtime/types.ts:50-115`, has no `pluginSession` accessor), and **not**
reachable through `/config`. Adding `QUANTA_PLUGIN_MODE` to `CONFIG_ALLOWED_KEYS`
would only flip the **gate** env var — it would **not** toggle an individual
plugin's enable-state, which lives in the handle.

**Therefore the bulk of this ticket is a NEW daemon read/mutate route + the seam
that exposes the live `pluginSession` handle to it.** The good news: the daemon
*already has* the exact seam pattern for reaching live session state from an HTTP
handler — the ADR-0415/0440 `ObservableRuntimeFacade` `Object.defineProperty`
projection (`runtime-factory.ts:78-87, 236-249` → `index.ts:85-126` →
`server.ts:581-589`). The observability/canvas wires **read** live session ports
that way; this ticket adds a **read+write** port the same way, plus the HTTP route
that calls `.enabled()/.all()/.enable()/.disable()` on it. The client side is then
a near-verbatim mirror of `slash-llm-config.ts` (a `build…SlashCommands(ep)`
factory spliced into `App.tsx:498-500`).

---

## Current — the web surface reality (file:line, all verified)

> **Path note:** the web/IDE frontend is at the **repo-root** `apps/web-frontend/`
> (NOT `src/apps/web-frontend/`). It is **import-isolated from `src/`** — it has its
> own `tsconfig.json` / `vite.config.ts` and `grep "from \"@/" apps/web-frontend/src`
> = 0 hits. The web-daemon is at `src/apps/web-daemon/` (in the main `@/` graph).
> The two halves talk **only over HTTP/WS** — that boundary is load-bearing for
> this ticket (the client can never `import` the `PluginSessionHandle` type;
> everything crosses as JSON).

### 1. The client catalogue + the splice point

- **`apps/web-frontend/src/components/SlashPalette.tsx`** — the palette + the
  default catalogue.
  - `SlashCommand` shape (`:13-26`): `{ slug; description; aliases?; action(rest)
    → string | Promise<string> }`. `action`'s return value **replaces the draft**
    (empty string clears). There is **no** structured "ctx slot" like the CLI's
    `SlashContext.plugins` — a web slash command is just a closure that may do I/O
    and append a client message.
  - Header (`:4-12`) states the load-bearing rule, verbatim: *"the server-side
    `/<cmd>` slash protocol is out of scope; these commands are affordances over
    local state … and over the daemon's well-known facets"*.
  - `buildDefaultSlashCommands(deps)` (`:231-445`) returns the **client-side**
    catalogue. Header (`:198-209`): *"mirrors the CLI `BUILTINS` registry
    (ADR-0306)"*; three classes — **client-only**, **prefill** (insert `/<cmd> `,
    daemon forwards raw text to its slash router *if one exists*, else the LLM sees
    raw text), **deferred**.
  - **How a command renders a reply (client-side resolution):** `clientSystem`
    (`:252-257`) calls `deps.appendClientMessage("system", build(getContext(), rest))`
    then `return ""` (clears draft). `getContext()` (`:240`) returns a
    `SlashCommandContext` snapshot (`:213-229`) — a pure pull of UI state
    (modelSlug / sessionId / sessionStatus / permissionMode / messageCount /
    tokenUsage …). **There is no plugin field on that snapshot today.**
- **`apps/web-frontend/src/App.tsx:482-508`** — the splice point:
  ```ts
  const base = buildDefaultSlashCommands({ … openKnobsPanel })   // :483
  if (resolvedConnection === null) return base                   // :490 (no daemon ⇒ client-only)
  const sharedEndpoint = {                                       // :491-497
    httpUrl: httpUrlFromWsUrl(resolvedConnection.url),
    ...(token !== undefined ? { token } : {}),
    onResult: (msg, kind) => appendClientMessage(kind === "err" ? "error" : "system", msg),
  }
  const llmCommands  = buildLlmConfigSlashCommands(sharedEndpoint)  // :498
  const authCommands = buildAuthSlashCommands(sharedEndpoint)       // :499
  return [...base, ...llmCommands, ...authCommands]                 // :500
  ```
  This is the exact pattern a new `buildPluginsSlashCommands(sharedEndpoint)`
  splices into (`return [...base, …llm, …auth, …plugins]`). The endpoint
  `{ httpUrl, token, onResult }` is already the shared shape every server-touching
  slash module consumes.

### 2. The existing client→server control channels (the crux — what we can / can't reuse)

| Channel | Handler | What it mutates | Reusable for `/plugins`? |
|---|---|---|---|
| `POST /config` | `server.ts:744-754` → `handleConfigPost` `:335-368` | **`process.env`** keys (closed allowlist `CONFIG_ALLOWED_KEYS` `:308-315`, value-pattern `:316`, security carve-out `configKeyWriteRejection` `:329-333`) | **NO** — env-only; `pluginSession` is in-memory session state, not env. |
| `GET /api/knobs` | `server.ts:704-725` → `buildWebKnobCatalog` (`knob-catalog-wire.ts`) | read-only knob *inventory* from the registry (NOT live session handles) | **NO** for plugin LIST — it reads the knob registry, not the discovered/enabled plugin set. |
| `POST /auth/*` | `server.ts:758-765` → `auth-routes.ts` | on-disk OAuth token (process-global) | **NO** — not session-scoped. |
| WS `SessionTransport` | `server.ts:564-571`, `wrapWebSocketLikeAsSessionTransport` | the typed `SessionCommand` set (`input.append`/`turn.run`/`identity.set`/`toolProfile.set`/…) | **NO existing command** for plugin enable/disable. `SessionCommand` is a closed protocol (`@/protocol/session`); adding a `plugin.enable` command would be a much larger cross-cutting change (protocol + bridge + every client). Out of scope — see Risks. |

**Client-side mirror of each channel:** `slash-llm-config.ts` (`postConfig` `:29-55`
→ `POST /config`), `slash-auth.ts` (`POST /auth/login|logout`, `GET /auth/status`),
`slash-knobs.ts` (`fetchKnobs` `:78-93` → `GET /api/knobs`; `postKnobValue` `:136-155`
→ `POST /config`). All share: `{ httpUrl, token }` endpoint, `authHeaders` Bearer,
`baseUrl` trailing-slash strip, `onResult?` toast, **fetch-not-throw** (resolve to
`{ok,error?}` or call `onResult(…, "err")`). The new module copies this shape exactly.

**Conclusion:** no existing route mutates session state — `/config` is env, the WS
protocol is closed. **A NEW daemon HTTP route is required** (mirroring `/config`'s
auth + CORS + JSON shape but calling a *live handle method* instead of writing
`process.env`). LIST likewise needs a NEW read route (there is no session-state
snapshot the daemon streams that carries the discovered/enabled plugin set — the
observability emitter streams Objective/RunLedger/Approvals only,
`observability-emitter.ts:1-43`; the canvas emitter streams usage/diff only).

### 3. How the daemon reaches live session state (the seam to copy — verified)

The daemon mints **ONE shared session** at boot:
`server.ts:596` `const sharedSession = await runtime.createSession(config.sessionConfig)`.
The `AgentConfig` that carries `pluginSession` is built inside the runtime-factory
closure (`runtime-factory.ts:206-221` `base`) and is **not** exposed on
`RuntimeSession` (`src/sdk/runtime/types.ts:50-115`). The **established** way to
surface live session state to a daemon HTTP/WS handler is the
`ObservableRuntimeFacade` `Object.defineProperty` projection:

1. `runtime-factory.ts` mints the source/handle and pins it onto the facade via
   `Object.defineProperty(facade, "<port>", { get: …, enumerable: true })`
   (`:236-249` for `canvasUsage`/`canvasToolDiff`; `:78-87`
   `attachObservabilityPorts` for the four observability ports).
2. `index.ts` projects the facade port into a per-server bundle
   (`buildObservabilityPorts` `:85-106`, `buildCanvasPorts` `:117-126`) and passes
   it into `startWebDaemon(config)` via `WebDaemonServerConfig`
   (`server.ts:581-589`).
3. `server.ts` reads it off `config` in a handler (the observability/canvas sinks
   attach per-connection `:786-800`; an HTTP route reads it off the same `config`).

**This ticket adds a `pluginSession` port to that same facade** (read+write — the
first *mutating* port, since enable/disable writes), and a NEW HTTP route
(`/api/plugins` GET + `/api/plugins/enable` `/api/plugins/disable` POST, or a single
`/api/plugins` GET + `POST /api/plugins` with an `{op,id}` body — see Design) that
calls `.enabled()/.all()/.enable()/.disable()` on it.

### 4. Default-OFF reality (verified)

- Gate `QUANTA_PLUGIN_MODE` OFF (or zero plugins discovered) ⇒ ticket 03's
  `mintPluginSession` returns `undefined` (03-…md:121-129) ⇒
  `AgentConfig.pluginSession === undefined` ⇒ the runtime-factory exposes **no**
  `pluginSession` facade port ⇒ `index.ts` builds **no** plugin port bundle ⇒
  `server.ts` `config.pluginPorts === undefined` ⇒ the route returns a stable
  "not enabled" shape (`200 { enabled:false, plugins:[] }`, see Design) ⇒ the
  client renders `"/plugins: plugin host mode not enabled"`. **Byte-identical UX**:
  with the gate off the route is inert and the slash command degrades to a single
  read-only message, exactly like `/model: not wired` does on the CLI.

---

## Design

Mirror the `slash-llm-config.ts` client factory + the ADR-0440 facade-port seam.
Five edits: one NEW client module, one EXTEND to `App.tsx`'s splice, one NEW
daemon route + handler, one EXTEND to the runtime-factory facade, one EXTEND to
`index.ts`'s port projection.

### Client — NEW `apps/web-frontend/src/components/slash-plugins.ts`

A pure helper module (no React imports — unit-testable with mocked `fetch`, exactly
like `slash-knobs.ts` / `slash-llm-config.ts`). Exports a `PluginsEndpoint`
(structural twin of `LlmConfigEndpoint` `slash-llm-config.ts:20-27`) and a
`buildPluginsSlashCommands(ep)` factory returning `readonly SlashCommand[]`:

```ts
import type { SlashCommand } from "./SlashPalette"

export interface PluginsEndpoint {
  readonly httpUrl: string
  readonly token?: string
  /** Toast/transcript hook — host passes App's appendClientMessage adapter. */
  readonly onResult?: (msg: string, kind: "ok" | "err") => void
}

/** One plugin row as returned by `GET /api/plugins` (server-projected from the
 *  discovery-side PluginManifest + the live enable-state). JSON-only — the client
 *  never imports the @/agent PluginManifest type (web-frontend is src-isolated). */
export interface PluginRow {
  readonly id: string
  readonly description?: string
  readonly capabilities?: readonly string[]   // ["Interactive","Read","Write"] subset
  readonly enabled: boolean
}
export interface PluginsListResponse {
  readonly enabled: boolean                    // false ⇒ gate off / no plugin-session (host mode not enabled)
  readonly plugins: readonly PluginRow[]
}
```

Two server round-trips (both mirror the `slash-knobs.ts` fetch helpers):

- `fetchPlugins(ep, signal?) → Promise<PluginsListResponse>` — `GET ${baseUrl}/api/plugins`
  with `authHeaders`; tolerant `parsePluginsResponse(json)` narrowing (mirror
  `parseKnobsResponse` `slash-knobs.ts:97-128`): a non-object / `enabled:false`
  payload ⇒ `{ enabled:false, plugins:[] }`; bad rows dropped.
- `postPluginToggle(ep, id, op: "enable" | "disable") → Promise<{ ok; error? }>` —
  `POST ${baseUrl}/api/plugins` with body `{ op, id }`; resolves `{ok,error?}`
  rather than throwing (mirror `postKnobValue` `slash-knobs.ts:136-155`).

The `/plugins` slash command (single command with sub-verbs, mirroring the CLI's
`/plugins [enable|disable] <id>`):

```ts
export const buildPluginsSlashCommands = (ep: PluginsEndpoint): readonly SlashCommand[] => [
  {
    slug: "plugins",
    aliases: ["plugin"],
    description: "List / enable / disable discovered plugins",
    action: async (rest) => {
      const parts = rest.trim().split(/\s+/).filter(Boolean)
      // no args ⇒ LIST
      if (parts.length === 0) {
        const res = await fetchPlugins(ep).catch((e) => null)
        if (res === null) { ep.onResult?.("plugins: fetch failed", "err"); return "" }
        if (!res.enabled) { ep.onResult?.("plugins: plugin host mode not enabled (set QUANTA_PLUGIN_MODE)", "ok"); return "" }
        ep.onResult?.(renderPluginList(res.plugins), "ok")   // pure formatter (below)
        return ""
      }
      const [verb, id] = parts
      if ((verb === "enable" || verb === "disable") && id !== undefined) {
        const r = await postPluginToggle(ep, id, verb)
        if (!r.ok) { ep.onResult?.(`plugins ${verb} ${id} failed: ${r.error ?? "?"}`, "err"); return "" }
        // Re-read so the message reflects SERVER truth, not an optimistic client guess.
        const after = await fetchPlugins(ep).catch(() => null)
        const row = after?.plugins.find((p) => p.id === id)
        ep.onResult?.(
          row === undefined
            ? `plugins: ${verb}d ${id}`
            : `plugins: ${id} is now ${row.enabled ? "enabled" : "disabled"}`,
          "ok",
        )
        return ""
      }
      ep.onResult?.("usage: /plugins  |  /plugins enable <id>  |  /plugins disable <id>", "err")
      return ""
    },
  },
]
```

- **`renderPluginList(rows)`** — a pure exported formatter (unit-testable without
  fetch, mirror `slash-knobs.ts`'s pure helpers): a header line plus one row per
  plugin — `${enabled ? "*" : " "} ${id}${description ? "  — " + description : ""}${
  capabilities?.length ? "  [" + capabilities.join("/") + "]" : ""}`. Zero plugins
  ⇒ `"plugins: none discovered"`. The enabled-marker `*` column is the same legible
  convention as the CLI's `formatPluginLine` (ticket 06).
- **No `SlashCommandContext` field is added.** The list is fetched live per
  invocation (no stale snapshot), exactly as `slash-auth.ts`'s `/whoami` fetches
  `/auth/status` live. (Reason: the enable-state is server-owned and can change from
  another client — see multi-client Risk; a cached client snapshot would lie.)

### Transport — NEW daemon route `GET /api/plugins` + `POST /api/plugins`

A NEW route in `server.ts`'s `fetch(req, srv)` handler, sited next to
`/api/knobs` (`:704-725`) and `/config` (`:744-754`), behind the **same**
`requireAuth(url, req)` gate (`server.ts:627-634`) and `corsHeaders` (`:375-381`)
+ `jsonResponse` (`:386-393`) envelopes. Mirrors `/config`'s auth+CORS exactly; the
ONLY difference is it calls a **live handle** instead of writing `process.env`.

```ts
// GET /api/plugins  → list (read-only)
if (url.pathname === "/api/plugins" && req.method === "GET") {
  const denied = requireAuth(url, req); if (denied !== null) return denied
  return jsonResponse(200, projectPluginsList(config.pluginPorts), req)
}
// POST /api/plugins → { op:"enable"|"disable", id } (mutate the live handle)
if (url.pathname === "/api/plugins" && req.method === "POST") {
  const denied = requireAuth(url, req); if (denied !== null) return denied
  return handlePluginToggle(req, config.pluginPorts)   // pure-ish, calls handle.enable/disable
}
```

- **`config.pluginPorts`** — a NEW optional field on `WebDaemonServerConfig`
  (mirror `observabilityPorts?` / `canvasPorts?` `server.ts:581-589`). Shape:
  `{ readonly session: PluginSessionHandle }` (the live handle off the facade —
  see facade EXTEND below). Absent ⇒ gate off / no plugins ⇒ the route returns the
  inert shape.
- **`projectPluginsList(ports)`** (pure, exported for the hellgate, mirror
  `configKeyWriteRejection` being exported `:329`): `ports === undefined` ⇒
  `{ enabled:false, plugins:[] }`; else map `ports.session.all()`
  (`PluginManifest[]`, 03-…md:56-57) → `PluginRow[]`, marking `enabled` from
  `ports.session.isEnabled(m.id)` (03-…md:50-51), projecting
  `description = m.description` (discovery-side `PluginManifest.description?`,
  see ticket 06 reference shape) + `capabilities = m.capabilities`.
- **`handlePluginToggle(req, ports)`** (mirror `handleConfigPost` `:335-368`):
  parse JSON body (400 `invalid_json` / `body_must_be_object`); require `op ∈
  {enable,disable}` + string `id` (400 `invalid_op` / `id_must_be_string`);
  `ports === undefined` ⇒ `409 { error:"plugin_mode_disabled" }` (the toggle has
  no handle — a deliberate not-found-ish so the client renders "not enabled");
  else call `ports.session.enable(id)` / `.disable(id)` (NO-THROW per 03-…md:52-55
  — unknown id is a no-op, NOT an error) and respond
  `200 { ok:true, id, enabled: ports.session.isEnabled(id) }`. **The response
  echoes the post-mutation `isEnabled(id)`** so the client's re-read and the
  toggle response agree on server truth.
- **Value safety:** unlike `/config` there is no `process.env` splice, so the
  `CONFIG_VALUE_PATTERN` shell-injection concern (`:316`) does not apply; still
  cap `id` length (e.g. ≤256) defensively before handing it to the handle.

### Server seam — EXTEND `runtime-factory.ts` (expose the live handle on the facade)

Mirror `canvasUsage`/`canvasToolDiff` exposure (`:236-249`). After ticket 07 puts
`pluginSession` into the `base` AgentConfig (`:206-221`), capture the same handle
and pin it on the facade:

```ts
// ticket-08 — expose the live plugin-session handle so the daemon's /api/plugins
// route can read+mutate enable-state. Gate OFF / no plugins ⇒ base.pluginSession
// is undefined (ticket 03 mint) ⇒ no facade port ⇒ no route data (byte-identical).
if (base.pluginSession !== undefined) {
  Object.defineProperty(facade, "pluginSession", {
    get: () => base.pluginSession, enumerable: true,
  })
}
```

…and widen `ObservableRuntimeFacade` (`:50-68`) with
`readonly pluginSession?: import("@/agent/plugin-session").PluginSessionHandle`
(inline import — keeps the eager dep graph unchanged, mirroring the slot's own
inline-import discipline 03-…md:147,150).

> **Mint location caveat (cross-ticket):** ticket 03/07 must actually *place*
> `pluginSession` into `runtime-factory.ts`'s `base` for the web/IDE surface. 07's
> plan mints at the **shared** `agent-config-assembler.ts` (00-index.md:60-66), and
> the web-daemon's `base` is assembled via `buildInteractiveTurnAssembler` →
> `assembleAgentConfig` (`runtime-factory.ts:130-131, 222`,
> 00-index.md:62). If 07's shared mint already seats `pluginSession` on the
> assembled config, this ticket reads it off that assembled config rather than the
> hand-built `base` literal — **confirm the exact field source against 07 at impl
> time** (the `Object.defineProperty` target is the same either way; only the
> `get: () => …` source expression changes). This is the single cross-ticket
> coupling and is called out in Deps + Risks.

### Server seam — EXTEND `index.ts` (project the facade port into the server bundle)

Mirror `buildCanvasPorts` (`:117-126`) + the config spread (`:149-163`):

```ts
const buildPluginPorts = (facade: ObservableRuntimeFacade | undefined):
  { session: PluginSessionHandle } | undefined => {
  if (facade?.pluginSession === undefined) return undefined
  return { session: facade.pluginSession }
}
// in main(): const pluginPorts = buildPluginPorts(observableFacade)
// …config: { …, ...(pluginPorts !== undefined ? { pluginPorts } : {}) }
```

**Eager-facade caveat:** `index.ts`'s `resolveObservableFactory` (`:59-74`) only
mints the facade EAGERLY when `QUANTA_OBSERVABILITY` **or** `QUANTA_WEB_CANVAS` is
on (`:69`). With **only** `QUANTA_PLUGIN_MODE` on, `observableFacade` is `undefined`
(the lazy factory passes through and the facade is minted *inside* `startWebDaemon`
at `server.ts:592`), so `buildPluginPorts(undefined)` returns `undefined` and the
route would be inert **even though plugins are live in the session**. **Fix
(required):** add `|| gateOn(process.env, "QUANTA_PLUGIN_MODE")` to the
`resolveObservableFactory` gate (`:69`) so the facade is minted eagerly when plugin
mode is on too — then `buildPluginPorts` sees the `pluginSession` port. This is a
**one-line gate widen** but it is **load-bearing** and easy to miss; the hellgate
asserts the route is live with **only** `QUANTA_PLUGIN_MODE` set (no observability/
canvas). Gate off ⇒ unchanged ⇒ byte-identical.

### Default-OFF / byte-identity

- `QUANTA_PLUGIN_MODE` off ⇒ ticket-03 `pluginSession` absent ⇒ facade port absent
  ⇒ `pluginPorts` undefined ⇒ `GET /api/plugins` returns `{enabled:false,plugins:[]}`
  ⇒ client renders "plugin host mode not enabled". `POST /api/plugins` ⇒ 409. The
  route is **always registered** (like `/config`), but **inert** without the port —
  matching how `/config` ships and how the CLI `/plugins` ships always-registered.
- The `/plugins` slash command is in the catalogue **only when
  `resolvedConnection !== null`** (it is spliced like `llmCommands` after the
  `App.tsx:490` guard) — with no daemon there is no plugin surface at all, same as
  `/login` today.

---

## Files

| Action | Path | What |
|---|---|---|
| **NEW** | `apps/web-frontend/src/components/slash-plugins.ts` | `PluginsEndpoint` + `PluginRow`/`PluginsListResponse` + `fetchPlugins`/`parsePluginsResponse`/`postPluginToggle`/`renderPluginList` + `buildPluginsSlashCommands(ep)` (mirror `slash-llm-config.ts` + `slash-knobs.ts`) |
| **EXTEND** | `apps/web-frontend/src/App.tsx` | import `buildPluginsSlashCommands`; splice `[...base, …llm, …auth, …plugins]` (mirror `:498-500`) |
| **EXTEND** | `src/apps/web-daemon/server.ts` | NEW `GET /api/plugins` (list) + `POST /api/plugins` (toggle) routes next to `/api/knobs` `:704` / `/config` `:744`; exported pure `projectPluginsList(ports)` + `handlePluginToggle(req, ports)`; add `pluginPorts?: { session: PluginSessionHandle }` to `WebDaemonServerConfig` (mirror `observabilityPorts?` `:581-589`) |
| **EXTEND** | `src/apps/web-daemon/runtime-factory.ts` | widen `ObservableRuntimeFacade` with `pluginSession?`; `Object.defineProperty(facade,"pluginSession",…)` when present (mirror `canvasUsage` `:236-241`) |
| **EXTEND** | `src/apps/web-daemon/index.ts` | `buildPluginPorts(facade)` + config spread (mirror `buildCanvasPorts` `:117-126`); **widen `resolveObservableFactory` gate `:69`** to include `QUANTA_PLUGIN_MODE` (eager-facade fix) |

NEW path coverage: `apps/web-frontend/**` is its own tsconfig project (no `@/`
alias needed); `src/apps/web-daemon/**` is already in the main `@/` graph. No new
`tsconfig.base` `paths` entry.

---

## TDD — red-first

Two suites (the two halves cannot share a runner — frontend is `vitest`,
daemon is `bun test`):

### A. Client — `apps/web-frontend/src/components/slash-plugins.test.ts` (vitest, mocked `fetch`)

Mirror `slash-knobs.test.ts` (`vi.spyOn(globalThis,"fetch")`, `afterEach
vi.restoreAllMocks()`). Each case **red before `slash-plugins.ts` exists**:

1. **`parsePluginsResponse` narrowing** — well-formed payload parses; non-object ⇒
   `{enabled:false,plugins:[]}`; `enabled:false` payload ⇒ empty list; a row missing
   `id` is dropped; `capabilities`/`description` optional-tolerant.
2. **`renderPluginList` (pure)** — 2 plugins, 1 enabled ⇒ output has both ids, the
   enabled row carries a leading `*` and is the **only** `*` row, capabilities
   rendered `[Read/Write]`; empty list ⇒ `"none discovered"`. (No fetch.)
3. **client renders enabled list** — mock `GET /api/plugins` → `{enabled:true,
   plugins:[{id:"a",enabled:true},{id:"b",enabled:false}]}`; invoke
   `/plugins` (no args) ⇒ `onResult` called once with `"ok"` and a string containing
   both ids + an `*` on `a` only.
4. **enable → server mutates → list reflects** — invoke `/plugins enable b`; assert
   the `POST /api/plugins` fetch body is `{op:"enable",id:"b"}`; mock the toggle
   `{ok:true,id:"b",enabled:true}` AND the **follow-up** `GET` →
   `…b enabled:true`; assert `onResult` says `"b is now enabled"`. **The re-read is
   the point** — the message reflects the server's post-mutation `isEnabled`, not an
   optimistic client flip.
5. **disable mirror** — symmetric; body `{op:"disable",id:"b"}`; follow-up `GET`
   shows `b enabled:false`; message `"b is now disabled"`.
6. **gate-off empty** — `GET /api/plugins` → `{enabled:false,plugins:[]}` ⇒
   `/plugins` ⇒ `onResult` "plugin host mode not enabled", kind `"ok"`, NO toggle
   fetch issued.
7. **bad usage** — `/plugins frob x` ⇒ `onResult` usage line, kind `"err"`, no fetch.
8. **fetch failure resilient** — `GET` rejects ⇒ `onResult` "fetch failed" `"err"`,
   `action` resolves (never throws — the palette `accept` awaits it, `SlashPalette.tsx:91-94`).

### B. Daemon — `tests/unit/apps/web-daemon/plugins-route.test.ts` (bun test)

Boot `startWebDaemon` with a stub factory whose facade carries a **fake
`PluginSessionHandle`** (the existing `tests/unit/apps/web-daemon/fixture.ts`
`createStubRuntimeFactory` returns a facade with NO `pluginSession` — extend it /
add a variant that `Object.defineProperty`s a fake handle recording
`enable`/`disable` calls over an in-memory enabled-`Set`). Drive the routes with
real `fetch` against `handle.port` (the suite already does this for `/config` and
`/api/knobs` — mirror `server.test.ts`).

1. **list (gate on)** — facade with a fake handle (`all()=[a,b]`, `a` enabled) ⇒
   `GET /api/plugins` ⇒ 200 `{enabled:true, plugins:[{id:"a",…,enabled:true},
   {id:"b",…,enabled:false}]}`.
2. **enable → handle mutates → list reflects** — `POST /api/plugins {op:"enable",
   id:"b"}` ⇒ 200 `{ok:true,id:"b",enabled:true}`, fake handle's `enable("b")`
   recorded; a subsequent `GET` shows `b` enabled. **(round-trips to the server
   plugin-session, not a client toggle.)**
3. **disable mirror** — `POST {op:"disable",id:"a"}` ⇒ `a` disabled in the next GET.
4. **gate-off / no port** — facade WITHOUT `pluginSession` (or no facade — the
   `resolveObservableFactory` lazy path) ⇒ `GET /api/plugins` ⇒ 200
   `{enabled:false,plugins:[]}`; `POST` ⇒ 409 `plugin_mode_disabled`. **(byte-identical
   inert surface.)**
5. **auth** — with `authToken` set, both routes 401 without the Bearer token
   (mirror the `/config` auth test) — same `requireAuth` gate.
6. **bad body** — `POST` non-JSON ⇒ 400 `invalid_json`; `{op:"frob",id:"x"}` ⇒
   400 `invalid_op`; `{op:"enable"}` (no id) ⇒ 400 `id_must_be_string`.
7. **eager-facade gate (the easy-to-miss wire)** — boot with **only**
   `QUANTA_PLUGIN_MODE=1` (NOT observability/canvas); assert
   `resolveObservableFactory` minted the facade eagerly so `GET /api/plugins` is
   **live** (`enabled:true`). A regression that forgets to widen the `index.ts:69`
   gate turns this **red** (the route would report `enabled:false`).
8. **🔴 red-on-injection (the invariant)** — the surface analogue of gap #3
   ("mention-only, no enabled-state"): `POST /api/plugins {op:"disable",id:"X"}`
   then `GET /api/plugins` **MUST** show `X` with `enabled:false` AND `X` MUST still
   be listed (`all()` still contains it). A regression that (a) drops the
   disable-write, or (b) recomputes the list's `enabled` flags from the stateless
   **discovery** registry instead of the live `pluginSession.isEnabled`, turns this
   **red** — proving the route reads/writes the **session** truth, not a client- or
   discovery-derived flag. **Pair it cross-process:** a SECOND `fetch` client
   issuing a `disable` must be observed as disabled by the FIRST client's next `GET`
   (multi-client consistency — both hit the one shared handle).

---

## Slice-fence

- **web-frontend is `@/`-isolated.** `slash-plugins.ts` MUST NOT (and structurally
  cannot — separate tsconfig) `import` anything from `src/` (`@/agent`,
  `PluginSessionHandle`, `PluginManifest`). All plugin data crosses as JSON
  (`PluginRow`). Its only local import is `import type { SlashCommand } from
  "./SlashPalette"` — identical to `slash-llm-config.ts:18` / `slash-auth.ts:16`.
  (A guard test can assert `grep "from \"@/"` over `slash-plugins.ts` = 0, matching
  the rest of `web-frontend`.)
- **web-daemon slice fence:** `server.ts` already imports `@/agent` types
  (`ContextUsageBreakdown` `:19`) and is in the main graph — adding the
  `PluginSessionHandle` **type** import is consistent. The handle is reached only
  through the injected `config.pluginPorts` object (never constructed in `server.ts`)
  — lifetime stays at the runtime-factory/index comp-root, mirroring how the
  observability/canvas ports are injected (`server.ts:581-589`), never built in the
  server.
- `projectPluginsList` / `handlePluginToggle` are exported pure-ish helpers (the
  pattern of `configKeyWriteRejection` `:329` / `_serveStaticSpaForTest` `:485`)
  so the security/shape branches have direct unit teeth without booting `Bun.serve`.

---

## Risks

1. **NEW control-message surface (the bulk of the ticket).** This is the *first*
   client→server route that **mutates live in-memory session state** (every prior
   route writes `process.env`, on-disk tokens, or reads). The route gets the same
   `requireAuth` + CORS + closed-shape discipline as `/config`, but the blast radius
   differs: a bad actor with the bearer token can flip plugin enable-state for the
   shared session. **Mitigation:** identical auth gate (`requireAuth` `:627-634`);
   the toggle only flips *enable-state of already-discovered plugins* (the handle's
   `enable` is a no-op for unknown ids, 03-…md:52-55 — no arbitrary plugin
   injection); capabilities remain advertise-only (ticket 05 owns enforcement) so
   enabling a plugin grants no permission by itself.
2. **Cross-ticket mint coupling (the `pluginSession` field source).** This ticket
   reads `pluginSession` off the runtime-factory config, but ticket 07 owns *where*
   it's seated (hand-built `base` literal vs the shared `assembleAgentConfig`
   output, 00-index.md:60-66). If 07 seats it only on the assembled config and not
   the `base` literal, the `Object.defineProperty` `get` source must point at the
   assembled config. **Mitigation:** the `defineProperty` target (the facade) is
   invariant; only the `get: () => …` expression changes. Confirm against 07 at impl
   time (called out in Deps). Until 03+07 land, this ticket's daemon tests inject a
   **fake** handle directly onto the facade, so they are not blocked on the mint
   wiring.
3. **Eager-facade gate omission (silent-inert failure).** If `index.ts:69`
   (`resolveObservableFactory`) is not widened to include `QUANTA_PLUGIN_MODE`, the
   facade is minted lazily inside `startWebDaemon` and the `pluginSession` port is
   never projected ⇒ the route reports `enabled:false` **even with plugins live** —
   a silent half-wire. **Mitigation:** hellgate case B7 asserts the route is live
   with **only** `QUANTA_PLUGIN_MODE` set; it goes red on the omission.
4. **Client/server enable-state drift.** A client that caches the list and toggles
   optimistically would diverge from server truth. **Mitigation (designed in):** the
   slash command **re-reads** `GET /api/plugins` after every toggle and renders the
   server's post-mutation `enabled` (no optimistic client flip, no client-side cache
   — mirrors `/whoami` fetching `/auth/status` live). Hellgate A4/A5 assert the
   message reflects the re-read.
5. **Multi-client consistency.** The daemon serves ONE shared session
   (`server.ts:548-557, 596`), so all connected clients (Tauri + a phone on the LAN)
   hit the **same** `pluginSession` handle — a toggle from one is visible to all on
   their next `GET`. This is the *correct* behaviour (one session = one enable-set),
   but it means client B sees client A's toggles without a push — acceptable for v1
   (the list is pull-on-open + pull-after-toggle). A push channel (reuse the
   observability emitter to broadcast a `plugins.changed` frame) is a **follow-up**
   (feature: live plugin-state push · why: client B's stale list until it re-opens
   `/plugins` · ROI: low until multi-operator web use is common — the pull model is
   correct, just not live; sequence after this ticket). Hellgate B8 asserts the
   cross-client toggle is observed on the next GET.
6. **`SessionCommand` road-not-taken.** An alternative transport is a new
   `plugin.enable` `SessionCommand` over the WS protocol (`@/protocol/session`)
   instead of an HTTP route. **Rejected for v1:** that touches the closed session
   protocol, the transport bridge, and every client/SDK consumer — far larger than
   an HTTP route that mirrors `/config`. The HTTP route is the house style for
   web-surface config mutation (`/config`, `/auth/*`, `/api/knobs` are all HTTP
   side-channels, not WS commands). If a future need requires the toggle to be part
   of the event-sourced transcript, promote it to a `SessionCommand` then.
7. **default-OFF byte-identity.** The two new routes are always registered but inert
   without `config.pluginPorts`; the slash command is only present when connected.
   Ticket 07's default-OFF byte-identity matrix (00-index.md:95) must include the
   web surface: gate off ⇒ `GET /api/plugins` → `{enabled:false,plugins:[]}`, `POST`
   → 409, no facade port, no eager-facade change — assert the only delta is the two
   inert route registrations (same posture `/config` already ships with).

---

## Deps

- **Upstream — ticket 03 (`plugin-session/`)** — provides `PluginSessionHandle`
  (`enabled()`/`isEnabled(id)`/`enable(id)`/`disable(id)`/`all()`, 03-…md:46-59,
  all sync NO-THROW) + the `AgentConfig.pluginSession?` slot (03-…md:133-148).
  **Blocking** for the real wire (the daemon route's `projectPluginsList`/
  `handlePluginToggle` call these methods). Not blocking for TDD: the daemon tests
  inject a fake handle of this exact shape.
- **Upstream — ticket 07 (gate + shared-assembler mint)** — owns `QUANTA_PLUGIN_MODE`
  (knob-inventory) and **seats `pluginSession` on the live web/IDE session** via the
  shared `agent-config-assembler.ts` mint (00-index.md:60-66, 86) — which is what
  makes the facade `get` return a real handle. **Blocking** for the route to carry
  real data; confirm the exact field source (Risk 2) against 07.
- **Parallels — ticket 06 (CLI half)** — same `PluginSessionHandle` contract,
  different surface (CLI `SlashContext.plugins` slot + adapter vs web HTTP route +
  fetch module). 06's `runtimeContext.pluginSession()` accessor and this ticket's
  facade `pluginSession` port are **two surface-specific exposures of the same
  ticket-03 handle** — neither blocks the other (00-index.md:96: "CLI(06) is wave-B;
  web/IDE(08) is wave-D; both are UX-only on top of the wave-C core").
- **Reuse (no new core):** `slash-llm-config.ts` / `slash-auth.ts` / `slash-knobs.ts`
  (verbatim client-factory + fetch-helper shape); the ADR-0415/0440
  `ObservableRuntimeFacade` `Object.defineProperty` seam
  (`runtime-factory.ts:78-87, 236-249` → `index.ts:85-126` → `server.ts:581-589`);
  `/config`'s auth + CORS + JSON envelopes (`server.ts:335-393, 627-634`);
  `App.tsx:482-508` splice; `tests/unit/apps/web-daemon/fixture.ts` stub-factory
  harness.
