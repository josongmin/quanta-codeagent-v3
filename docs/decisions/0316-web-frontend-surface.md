# ADR-0316 — Web frontend surface (Vite + React + Tailwind SPA)

- **Status**: accepted (2026-05-26)
- **Related**: [[0303-thin-surface-headless-core]] (the headless core that
  hosts the daemon), [[0309-surface-wire-r2]] (the surface composition
  contract this slice plugs into), [[0310-surface-composition-wire-r1]]
  (REPL parity reference), [[surface-model]] (quanta is multi-surface —
  do NOT gate ROI by surface availability)
- **References**:
  - Claude Code A11 — bridge between CLI and Web surfaces over a shared
    `WireEnvelope`
  - Codex desktop devtools bridge — single WebSocket per session, typed
    command/event envelopes, JSON-RPC-ish ergonomics
  - `src/protocol/session/codec.ts` — canonical wire shape (this slice
    keeps a narrow LOCAL COPY in `apps/web-frontend/src/types/protocol.ts`)

## Problem

quanta has been CLI-only. The plan is multi-surface (CLI / Web /
CLI-embedded browser / Tauri shell), and the daemon track (Worker B)
ships a long-lived WebSocket on `ws://127.0.0.1:4096/` that speaks the
session protocol. We need a UI that can drive it.

Constraints:

- The frontend must NOT be part of the bun-managed `src/` build graph —
  React / JSX / Vite plugins do not belong in the agent's tsconfig
  paths, and the parent biome scope is `src/` + `tests/`.
- The frontend must be runnable standalone (`npm install && npm run dev`)
  AND embeddable inside Tauri (Worker D's shell points its `distDir` at
  the Vite build output).
- It must NOT install ANY package manager dep in the worktree where it
  is built — see project memory `worktree-node-modules-hazard` for the
  incident that motivated the rule. The slice ships package.json + lock-
  ready dep list ONLY; the operator runs install locally.
- Surface code MUST NOT import from `@/protocol/session` or any other
  bun project path — the alias does not resolve in the standalone Vite
  build. We carry a narrow LOCAL COPY of the wire types instead.

## Decision

Ship `apps/web-frontend/` as a fully self-contained Vite + React + TS +
Tailwind SPA. Stack pinned to the boring-default versions:

- Vite 5.x, React 18.x, TypeScript 5.x strict
- Tailwind CSS **3.4.x** (NOT v4 — keep it boring; v4 PostCSS pipeline
  changes are not stable across our Tauri-embed target)
- `react-markdown` + `remark-gfm` for assistant rendering, Prism via
  `react-syntax-highlighter` for code blocks
- **No state management library** — `useState` + `useReducer` only.
  Transcript fits in one reducer; status fits in one `useState`.

### Files (boundary-respecting)

```
apps/web-frontend/
├── package.json               # private:true, name "quanta-web-frontend"
├── tsconfig.json              # strict, noUncheckedIndexedAccess on
├── vite.config.ts             # React plugin + co-located vitest config
├── tailwind.config.js         # dark mode = class strategy
├── index.html
├── public/.gitkeep
└── src/
    ├── main.tsx               # React mount
    ├── App.tsx                # SessionClient + UI shell
    ├── components/            # ChatPanel / MessageBubble / InputBar /
    │                          # StatusBar / HotkeyToast
    ├── ws/                    # SessionClient (FakeWebSocket-testable),
    │                          # envelope encode/decode, pure reconnect
    │                          # backoff, React hooks
    ├── types/protocol.ts      # local copy of upstream session types
    ├── styles/index.css       # tailwind directives
    └── lib/classnames.ts      # tiny cx() helper (no clsx dep)
```

### Wire integration

- **Envelope** — every WS frame is a `SessionWireEnvelope<TKind, TPayload>`
  (mirror of `src/protocol/session/codec.ts`). Outbound commands are
  encoded by `encodeCommandFrame`; inbound events are decoded by
  `decodeEventFrame` with defensive shape checks (drops malformed /
  unknown-type frames silently with a warn log).
- **Connection lifecycle** — `SessionClient` auto-reconnects with
  exponential backoff 500ms → 30s cap (`src/ws/reconnect.ts`). No
  jitter — the surface is single-tenant, jitter would only hurt the
  deterministic test surface.
- **Auth** — bearer token passed via `?token=<value>` query string at
  handshake (browsers cannot set arbitrary headers on `new WebSocket()`).
  Subprotocol-shaped auth (`["bearer", token]`) is also supported via the
  `AuthCredential.subprotocols` field for daemons that prefer that arm.

### UI behaviour (v1 minimal viable)

- Connect on mount to `VITE_QUANTA_WS_URL` (default
  `ws://127.0.0.1:4096/`), optionally with `VITE_QUANTA_AUTH_TOKEN`.
- Status bar: connection dot (connected/connecting/disconnected with
  retry hint) + session-status pill once `session.state.updated` arrives.
- Composer: textarea + Send button. Enter (or Cmd+Enter / Ctrl+Enter)
  sends — emits `input.append` + `turn.run` back-to-back, each with a
  fresh `commandId`. Shift+Enter inserts a newline. Cmd+K clears.
- Markdown rendering with GFM + Prism code highlight, role-coloured
  bubbles, ISO-timestamp metadata, auto-scroll-to-bottom on append.
- `turn.failed` events render as inline red error bubbles; `session.created`
  / `session.closed` / `approval.requested` render as italic system rows.

### HotkeyToast — Tauri shell integration seam (for Worker D)

The frontend listens for `window.postMessage` of the shape
`{ kind: "quanta:hotkey-capture", text: string }`. When the native
Tauri shell intercepts a global hotkey (screen capture, voice etc.) it
should `postMessage` this payload to the webview. The frontend then:

1. Appends `[Screen captured at HH:MM] <text>` to the current draft
2. Focuses the input
3. Flashes a small toast for ~2.5s

This is a placeholder seam — full computer-use / screen capture lands in
a follow-up ADR when the Tauri shell ships its native side.

## Alternatives considered

- **Svelte / SvelteKit** — smaller bundle, fewer abstractions; rejected
  because react+tailwind is the team-wide boring-correct default and
  Worker D's Tauri shell will not gain anything from a non-React choice.
- **SolidJS** — best raw perf for this surface; rejected for the same
  reason. The surface is small enough that the difference is invisible
  to a user.
- **Next.js / Remix** — SSR / routing we don't need. This is a 1-page
  chat embedded in a Tauri shell; SSR is dead weight.
- **Vue 3** — viable but adds a second template language to the org for
  zero functional gain.
- **Tailwind v4** — too new; v4's PostCSS pipeline rewrite has not
  stabilised across our embed target. Stick with v3.4.x.
- **Redux / Zustand / Jotai** — the transcript reducer + 3 connection
  states fit in one component without leaking; adding a store would be
  premature.
- **uuid npm package** — `crypto.randomUUID()` is in every browser we
  target. Adding a dep for one function call is wasteful.
- **clsx npm package** — same logic; `cx()` is 12 LOC.

## Consequences

- `apps/web-frontend/` becomes the canonical web surface. Worker D's
  Tauri shell points `distDir` at `apps/web-frontend/dist/`; Worker B's
  daemon at `apps/web-daemon/` is the WS host.
- Type drift between `src/protocol/session/` (canonical) and
  `apps/web-frontend/src/types/protocol.ts` (local copy) is possible. The
  copy is narrow (only UI-consumed variants). A follow-up CI gate can
  diff the two — not in scope for this slice.
- Standalone install: `cd apps/web-frontend && npm install && npm run dev`.
  The parent repo's `bun.lock` is untouched.
- Build artefacts (`dist/`) and `node_modules/` are gitignored both at
  the parent (root `.gitignore`) and locally (`apps/web-frontend/.gitignore`)
  for belt-and-braces.

Default-OFF byte-identical (RFC §1.2): absent this directory + absent
the daemon (Worker B), the CLI surface continues unchanged. The frontend
is a sibling, not a dependency.

## Negative invariants

- DO NOT bundle this frontend into the main bun project's tsconfig
  paths. The parent's biome scope deliberately excludes `apps/`.
- DO NOT import from `@/...` inside `apps/web-frontend/src/` — the
  alias does not resolve in the Vite build context and would silently
  break the production bundle.
- DO NOT mutate the parent `package.json` / `tsconfig.json` /
  `biome.json` to add this directory. Its tooling is self-contained.
- DO NOT add a state-management library (Redux / Zustand / Jotai) to
  v1. The transcript fits in `useReducer`; adding a store now would
  ossify a too-small surface around a too-big abstraction.
- DO NOT add jitter to the reconnect backoff in the SPA. The surface is
  single-tenant — jitter only sabotages the deterministic test surface
  for no reliability gain.
- DO NOT `npm install` inside an automated worktree. See project memory
  `worktree-node-modules-hazard` — symlinked node_modules can poison the
  parent install. Install only on the operator's local machine.

## Test plan

Pure-TS tests sibling to the source (no DOM, no React render):

- `src/lib/classnames.test.ts` — cx() join / falsy-drop / nested array
  / empty / whitespace preservation (5 cases)
- `src/ws/reconnect.test.ts` — base 500ms, doubling, 30s cap, non-finite
  / non-positive clamps (5 cases + constants assertion)
- `src/ws/envelope.test.ts` — encode wraps in versioned envelope,
  decode rejects non-string / bad JSON / wrong kind / unknown type tag /
  non-finite seq; peek + predicate edge cases (~13 cases)
- `src/ws/client.test.ts` — `SessionClient` with a `FakeWebSocket`
  harness: connect → open transitions, `?token=` query construction
  (incl. existing `?x=1` arm), unexpected close schedules reconnect
  via injected timer, intentional `disconnect()` does NOT reconnect,
  send encodes a versioned command frame, decoded events fan out to
  typed subscribers, unrecognised frames don't throw, send pre-connect
  doesn't throw, attempt counter increments and retry delay doubles
  (~9 cases)

Run with `npm run test` once `npm install` has populated
`apps/web-frontend/node_modules/`. The tests do NOT require a built
bundle and run in vitest's node environment.

Manual / visual verification (deferred — daemon not yet running):

- `npm run dev` boots Vite at http://localhost:5173 and renders the
  shell with a red disconnected dot (no daemon).
- Once Worker B ships, dev-loop is `npm run dev` here +
  `bun run apps/web-daemon` in the parent — the dot flips green, status
  pill paints, and Enter on a prompt drives a turn round-trip.
