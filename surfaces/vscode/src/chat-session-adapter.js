/**
 * T07 — PURE session.v1 ↔ VS Code `chatSessions` adapter.
 *
 * This module has ZERO `vscode` import. It maps the session.v1 protocol
 * (`@/protocol/session` + `@/ipc/session`) onto a structural
 * {@link ChatSessionItemView} that the thin `provider.ts` shell re-shapes into
 * a concrete `vscode.ChatSessionItem`. Keeping the projection here (a) makes it
 * unit-testable against a REAL session transport without a VS Code host, and
 * (b) enforces the core-decoupling invariant: no VS Code symbol ever reaches
 * `src/` (proved by `core-no-vscode-leak-ratchet.test.ts`).
 *
 * Status is derived from the SERVER's turn lifecycle ONLY — the adapter never
 * optimistically flips to in-progress on submit (that would be a UI-lie if the
 * turn were rejected). It listens on BOTH the fine `turn.*` events and the
 * coarse `session.state.updated` view so it works against the CLI/headless
 * (turn.*) and web/daemon (state.updated) emitters alike.
 */
import { CHAT_SESSION_STATUS, statusForStateView } from "./status";
const DEFAULT_LABEL = "quanta thread";
const LABEL_MAX = 80;
const deriveLabel = (text) => {
    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0)
        return DEFAULT_LABEL;
    const firstLine = trimmed.split("\n", 1)[0] ?? trimmed;
    return firstLine.length > LABEL_MAX ? `${firstLine.slice(0, LABEL_MAX - 1)}…` : firstLine;
};
/** ISO-8601 → epoch ms; undefined when unparseable (never NaN — a NaN timing
 *  would render as 1970/garbage in the editor). */
const isoToMs = (iso) => {
    if (iso === undefined)
        return undefined;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms;
};
const sameItem = (a, b) => a.id === b.id &&
    a.label === b.label &&
    a.status === b.status &&
    a.timing?.startTime === b.timing?.startTime &&
    a.timing?.endTime === b.timing?.endTime;
/**
 * Projects ONE session.v1 thread into a `ChatSessionItemView`, and translates
 * editor actions (submit / cancel) into session commands. A change listener
 * fires only when the projected item actually changes (de-duped) so the editor
 * does not re-render on no-op events.
 */
export class ChatSessionProjection {
    port;
    label = DEFAULT_LABEL;
    status = CHAT_SESSION_STATUS.Idle;
    startTime;
    endTime;
    commandSeq = 0;
    listeners = new Set();
    unsubscribe;
    now;
    constructor(port, opts = {}) {
        this.port = port;
        this.now = opts.now ?? (() => new Date().toISOString());
        this.unsubscribe = port.onMessage((m) => this.ingest(m));
    }
    get id() {
        return this.port.sessionId;
    }
    current() {
        const timing = this.startTime === undefined && this.endTime === undefined
            ? undefined
            : {
                ...(this.startTime !== undefined ? { startTime: this.startTime } : {}),
                ...(this.endTime !== undefined ? { endTime: this.endTime } : {}),
            };
        return {
            id: this.port.sessionId,
            label: this.label,
            status: this.status,
            ...(timing !== undefined ? { timing } : {}),
        };
    }
    onDidChange(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** UC: submit a prompt — append input, then run the turn. Status is NOT
     *  flipped here; the server's `turn.started` drives it (no UI-lie). */
    async submitMessage(text) {
        await this.port.sendCommand(this.envelope("input.append", { text }));
        await this.port.sendCommand(this.envelope("turn.run", {}));
    }
    async cancel() {
        await this.port.sendCommand(this.envelope("turn.cancel", {}));
    }
    dispose() {
        this.unsubscribe();
        this.listeners.clear();
    }
    envelope(type, rest) {
        this.commandSeq += 1;
        return {
            sessionId: this.port.sessionId,
            commandId: `${this.port.sessionId}-c${this.commandSeq}`,
            issuedAt: this.now(),
            type,
            ...rest,
        };
    }
    applyStateView(state) {
        this.status = statusForStateView(state.status);
        if (state.lastUserText !== undefined)
            this.label = deriveLabel(state.lastUserText);
    }
    ingest(message) {
        const before = this.current();
        switch (message.kind) {
            case "snapshot": {
                if (message.snapshot.sessionId !== this.port.sessionId)
                    break;
                this.applyStateView(message.snapshot.state);
                break;
            }
            case "event": {
                const event = message.event;
                switch (event.type) {
                    case "session.state.updated":
                        this.applyStateView(event.state);
                        break;
                    case "turn.started":
                        this.status = CHAT_SESSION_STATUS.InProgress;
                        this.startTime = isoToMs(event.emittedAt) ?? this.startTime;
                        this.endTime = undefined;
                        if (event.prompt.trim().length > 0)
                            this.label = deriveLabel(event.prompt);
                        break;
                    case "turn.completed":
                        this.status = CHAT_SESSION_STATUS.Idle;
                        this.endTime = isoToMs(event.emittedAt) ?? this.endTime;
                        break;
                    case "turn.failed":
                        this.status = CHAT_SESSION_STATUS.Failed;
                        this.endTime = isoToMs(event.emittedAt) ?? this.endTime;
                        break;
                    case "session.closed":
                        this.status = CHAT_SESSION_STATUS.Idle;
                        break;
                    default:
                        break;
                }
                break;
            }
            default:
                // connect / command / rejected / heartbeat carry no projection state.
                break;
        }
        if (!sameItem(before, this.current()))
            this.fire();
    }
    fire() {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                // A faulty editor listener must not poison sibling subscribers.
            }
        }
    }
}
/**
 * Aggregates the live quanta threads the editor knows about into the list a
 * `vscode.ChatSessionItemProvider` returns from `provideChatSessionItems`, and
 * fires a single coalesced change event on membership OR any per-item change.
 */
export class ChatSessionRegistry {
    opts;
    projections = new Map();
    perItemUnsub = new Map();
    listeners = new Set();
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** Begin projecting an already-connected session port. */
    track(port) {
        const existing = this.projections.get(port.sessionId);
        if (existing !== undefined)
            return existing;
        const projection = new ChatSessionProjection(port, {
            ...(this.opts.now ? { now: this.opts.now } : {}),
        });
        this.projections.set(port.sessionId, projection);
        this.perItemUnsub.set(port.sessionId, projection.onDidChange(() => this.fire()));
        this.fire();
        return projection;
    }
    /** UC3 — editor "new session" → create + track a new quanta thread. */
    async createNew() {
        if (this.opts.createSession === undefined) {
            throw new Error("ChatSessionRegistry.createNew: no createSession factory was injected");
        }
        const port = await this.opts.createSession();
        return this.track(port);
    }
    get(id) {
        return this.projections.get(id);
    }
    items() {
        return [...this.projections.values()].map((p) => p.current());
    }
    onDidChangeItems(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    remove(id) {
        this.perItemUnsub.get(id)?.();
        this.perItemUnsub.delete(id);
        const projection = this.projections.get(id);
        if (projection === undefined)
            return;
        projection.dispose();
        this.projections.delete(id);
        this.fire();
    }
    dispose() {
        for (const id of [...this.projections.keys()])
            this.remove(id);
        this.listeners.clear();
    }
    fire() {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                // isolate faulty listeners
            }
        }
    }
}
