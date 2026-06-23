/**
 * `@/apps/web-daemon/server/ws-data` — per-connection `ServerWebSocket` state.
 *
 * Extracted so the `fetch`/`websocket` handler factories (`./fetch-handler`,
 * `./ws-handlers`) and the parent `../server` module share ONE `WSData` shape
 * without a circular import back through `../server`.
 */

import type { CanvasEmitterHandle } from "../canvas-emitter"
import type { ObservabilityEmitterHandle } from "../observability-emitter"
import type { BunWebSocketAdapter } from "../ws-adapter"

/**
 * Per-connection state attached to `ServerWebSocket<WSData>`. Holds the
 * adapter object — `open()` overwrites the `adapter` slot with the real
 * adapter after upgrade. We use a mutable container (object reference) so
 * the upgrade-time stub is the same object the open-time wiring fills in.
 */
export interface WSData {
  /** Filled in by `open()` after upgrade. */
  adapter: BunWebSocketAdapter | undefined
  /**
   * ADR-0420 — per-connection observability emitter (gate ON only). `open()`
   * attaches one bridging this socket to the daemon's live ports; `close()`
   * stops it so we never emit to a dead socket. `undefined` ⇒ gate OFF
   * (byte-identical: no sink, no frames).
   */
  observability: ObservabilityEmitterHandle | undefined
  /**
   * ADR-0440 — per-connection canvas emitter (gate ON only). `open()` attaches
   * one bridging this socket to the daemon's canvas data source; `close()`
   * stops it + unsubscribes. `undefined` ⇒ gate OFF (byte-identical: no sink,
   * no frames). The detach closure unsubscribes from the shared usage source.
   */
  canvas: { handle: CanvasEmitterHandle; detach: () => void } | undefined
  /**
   * QUANTA_WEB_AGENT_STATE — per-connection agent-state forwarder (gate ON
   * only). `open()` subscribes this socket to the daemon's agent-state source;
   * `close()` unsubscribes so we never forward to a dead socket. `undefined` ⇒
   * gate OFF (byte-identical: no sink, no frames). The detach closure
   * unsubscribes from the shared agent-state source.
   */
  agentState: { detach: () => void } | undefined
}
