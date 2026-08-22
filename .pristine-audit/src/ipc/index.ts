/**
 * `@/ipc` — surface-agnostic CLI ↔ Web ↔ Tauri event bridge (Claude A11
 * deep-dive absorption).
 *
 * Two contracts:
 *   1. `EventBridge` — high-level publish/subscribe over typed
 *      `BridgePayload` events. Loopback delivery to local subscribers,
 *      transport-agnostic wire encoding.
 *   2. `BridgeTransport` — low-level byte shuttle. Four implementations
 *      ship with this slice:
 *        - `in-memory`  (test fixture, fully working)
 *        - `stdio`      (line-delimited JSON over Node Readable/Writable —
 *                        used by CLI ↔ daemon — fully working)
 *        - `uds`        (Unix Domain Socket; framing reused from stdio,
 *                        listener/connect helpers in a follow-up PR)
 *        - `websocket`  (interface + adapter only; real server in a
 *                        follow-up PR pending lib choice)
 *
 * Default-OFF / byte-identical: nothing in `@/ipc` runs unless a surface
 * constructs a bridge. The CLI does NOT wire this slice in this PR — a
 * follow-up PR adds the opt-in flag.
 *
 * Session export/import: portable v1 schema (snake_case wire) for round-
 * tripping a saved session across surfaces. Read-only on storage; import
 * mints a fresh id by default to avoid collisions.
 *
 * SLICE BOUNDARY:
 *   - May import: `@/agent`, `@/llm`, `@/session`, `@/stream`, `@/shared`.
 *   - MUST NOT import: any `apps/**` (would couple to a specific surface),
 *     `@/rules`, `@/patch`, `@/migration`.
 *   - stdio transports legitimately frame `process.stdin/stdout` — but the
 *     slice takes them as INJECTED PORTS, never reads `process` directly.
 */

export type {
  BridgeEvent,
  BridgeOutcomeSummary,
  BridgePayload,
  BridgePermissionPreview,
  BridgeSessionMeta,
  BridgeTransport,
  CreateEventBridgeOpts,
  EventBridge,
  WireEnvelope,
} from "./event-bridge"
export { createEventBridge, isoNow, isWireEnvelope } from "./event-bridge"
export type { PortableSessionV1 } from "./session-export"
export { exportSession, metaToPortable, PORTABLE_SESSION_VERSION } from "./session-export"
export type {
  ImportError,
  ImportErrorKind,
  ImportSessionOpts,
} from "./session-import"
export {
  importSession,
  PortableSessionImportError,
  parsePortableSession,
} from "./session-import"

export {
  createInMemoryHub,
  createInMemoryTransport,
  type InMemoryHub,
} from "./transports/in-memory"
export {
  type CreateStdioTransportOpts,
  createStdioTransport,
  type StdioReader,
  type StdioWriter,
} from "./transports/stdio"
export { udsSocketPath, udsSocketSuffix, wrapDuplexAsUdsTransport } from "./transports/uds"
export {
  createWebSocketServerTransport,
  type WebSocketLike,
  wrapWebSocketLikeAsTransport,
} from "./transports/websocket"
