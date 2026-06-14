/**
 * Protocol types — LOCAL COPY for the web frontend.
 *
 * Source of truth: `src/protocol/session/` in the main quanta repo
 * (commands.ts, events.ts, snapshot.ts, capabilities.ts, codec.ts).
 *
 * Why a copy and not an import?
 *   The web frontend lives OUTSIDE the bun project's `tsconfig.json#paths`
 *   (different package, different toolchain, different tsconfig). Importing
 *   from `@/protocol/session` would tightly couple the two builds and break
 *   the standalone Vite invocation. The cost is a small duplicated surface;
 *   the benefit is the frontend can be built / shipped independently and
 *   the daemon (Worker B) owns the canonical wire shape.
 *
 * Keep narrow: only the SessionCommand / SessionEvent variants and shapes
 * the UI actually reads or sends. New fields land in the upstream first
 * and get cherry-picked here when the UI starts to consume them.
 *
 * Wire shape (from `src/protocol/session/codec.ts`):
 *   { version: "<SESSION_PROTOCOL_VERSION>", kind: "command"|"event"|"snapshot", payload: <typed payload> }
 *
 * `WireEnvelope` is also used by `src/ipc/event-bridge.ts` for transport-level
 * routing — the daemon translates between the two; the frontend only ever
 * touches the session protocol envelope (one JSON object per WS frame).
 */
export const SURFACE_READ_MODEL_IDS = ["session", "agentState", "canvas", "observability"];
export const SURFACE_READ_MODEL_STATUSES = ["subscribed", "supported", "unsupported"];
export const DEFAULT_SESSION_CLIENT_SURFACE_SUBSCRIPTION = {
    session: { status: "subscribed", protocol: "session.v1" },
    agentState: { status: "subscribed", protocol: "agent-state.v1" },
    canvas: { status: "subscribed", protocol: "canvas.v1" },
    observability: { status: "subscribed", protocol: "observability.v1" },
};
