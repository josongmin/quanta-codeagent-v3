# quanta-web-frontend

Vite + React + Tailwind SPA — the web surface of quanta. Connects via
WebSocket to the daemon (`apps/web-daemon/`, Worker B) and renders a
minimal chat-style UI for an agent session.

This package is **standalone** — its own `package.json`, its own
`tsconfig.json`, its own toolchain. It is NOT part of the parent bun
project's build graph and does NOT participate in the parent's biome
lint (the parent's `biome.json` scopes to `src/` + `tests/`).

## Stack

- Vite 5.x + React 18.x + TypeScript 5.x (strict)
- Tailwind CSS 3.4.x (NOT v4) + PostCSS + autoprefixer
- `react-markdown` + `remark-gfm` for response rendering
- `react-syntax-highlighter` (Prism) for fenced code blocks
- **No state-management library** — plain `useState` + `useReducer`

## Setup

```bash
cd apps/web-frontend
npm install           # or pnpm install / yarn install / bun install
npm run dev           # Vite dev server on http://localhost:5173
npm run build         # output → apps/web-frontend/dist/
npm run preview       # serve the production build
npm run typecheck     # tsc --noEmit (strict)
npm run test          # vitest run
npm run test:watch    # vitest watch
```

> **Install hazard** — the parent repo intentionally does NOT install
> npm deps in CI worktrees (see project memory `worktree-node-modules-hazard`).
> Run `npm install` only in this directory and only on your local machine.
> Never commit `apps/web-frontend/node_modules/`.

## Build output

`vite build` writes to `apps/web-frontend/dist/`. The Tauri shell
(`apps/tauri-shell/tauri.conf.json`, Worker D) should point its `distDir`
at this path so the bundled binary serves the same SPA the dev server
does.

For the Tauri dev workflow, point Tauri's `devPath` at
`http://localhost:5173` and run `npm run dev` here in parallel.

## Configuration (build-time env)

| env var | default | purpose |
| --- | --- | --- |
| `VITE_QUANTA_WS_URL` | `ws://127.0.0.1:4096/` | daemon WebSocket URL |
| `VITE_QUANTA_AUTH_TOKEN` | _(none)_ | bearer token (appended as `?token=…`) |

Vite picks these up at build time. To change at deploy time, rebuild
with the new env values.

## Protocol

Wire frames are JSON-encoded `SessionWireEnvelope<TKind, TPayload>` shapes
matching the canonical definition in
`src/protocol/session/codec.ts` (parent repo). Frontend ships a narrow
LOCAL COPY of the types in `src/types/protocol.ts` to keep the bundle
self-contained — see the header comment in that file for the rationale.

The client (`src/ws/client.ts`):

- auto-reconnects with exponential backoff (500ms → 30s cap; see
  `src/ws/reconnect.ts` for the pure math + table of values)
- adds `?token=<value>` to the URL when an auth token is provided
  (browsers can't set arbitrary headers on `new WebSocket()`)
- decodes incoming frames via `decodeEventFrame` and dispatches to
  type-tagged handlers or a wildcard subscriber

## Hotkey integration (for Worker D)

The frontend listens for `window.postMessage` events of the shape:

```ts
{ kind: "quanta:hotkey-capture", text: "<captured text>" }
```

When the Tauri shell intercepts a global hotkey (screen capture, voice
transcript, etc.) it should `postMessage` this payload to the webview.
The frontend will:

1. Append `[Screen captured at HH:MM] <text>` to the current draft
2. Focus the input bar
3. Flash a small toast (`HotkeyToast`) for ~2.5s

## File layout

```
apps/web-frontend/
├── package.json               # private; standalone deps
├── tsconfig.json              # strict, react-jsx, bundler resolution
├── tsconfig.node.json         # for vite.config.ts
├── vite.config.ts             # React plugin + co-located vitest config
├── tailwind.config.js         # dark mode = class strategy
├── postcss.config.js
├── index.html                 # adds class="dark" on <html>
├── README.md                  # this file
├── public/                    # static assets (currently empty)
└── src/
    ├── main.tsx               # React mount
    ├── App.tsx                # top-level layout + lifecycle
    ├── components/
    │   ├── ChatPanel.tsx      # scrollable message list + input
    │   ├── MessageBubble.tsx  # markdown render + code highlight
    │   ├── InputBar.tsx       # textarea + Enter / Cmd+K hotkeys
    │   ├── StatusBar.tsx      # connection + session status dot
    │   └── HotkeyToast.tsx    # postMessage-driven transient toast
    ├── ws/
    │   ├── client.ts          # SessionClient (WS lifecycle)
    │   ├── envelope.ts        # encode/decode wire frames
    │   ├── reconnect.ts       # pure backoff math (tested)
    │   └── session-hooks.ts   # React hooks: connection / events / sendTurn
    ├── types/
    │   └── protocol.ts        # local copy of upstream session types
    ├── styles/
    │   └── index.css          # tailwind directives
    └── lib/
        └── classnames.ts      # tiny cx() helper (no clsx dep)
```

## Tests

Pure-TS logic has `*.test.ts` siblings:

- `src/lib/classnames.test.ts` — cx behavior
- `src/ws/reconnect.test.ts` — exponential-backoff math + cap
- `src/ws/envelope.test.ts` — encode / decode / validate
- `src/ws/client.test.ts` — SessionClient with a FakeWebSocket harness

Run with `npm run test` once deps are installed. The tests are
node-only (no DOM) and do NOT require a Vite build — vitest's vite-less
entry handles them.

## What this surface deliberately does NOT do (v1)

- No slash commands (CLI parity is a future slice)
- No cost / token dashboard
- No diff preview for tool calls
- No approval response UI (the daemon's auto-approval mode is assumed
  today; explicit approve/deny UI lands when the daemon emits
  `approval.requested` events that the user can act on)
- No multi-session list
- No theme toggle (dark-only)
- No state management lib (Redux/Zustand) — `useReducer` covers the
  transcript well enough at v1 size

Each of these is a deliberate boundary, not an oversight.
