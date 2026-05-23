import { toError } from "@/shared";
/**
 * Pure fan-out `StreamPort`. Forwards every event to every wrapped port in
 * order. In non-strict mode one faulty port can never starve the others: its
 * error is swallowed and remembered (per-port count keyed by reason) so the
 * caller can emit an `observability_degraded` trajectory event. In strict
 * mode the first failure rethrows. No IO, deterministic.
 */
export class TeeStream {
    ports;
    strict;
    failures = new Map();
    constructor(ports, opts = {}) {
        this.ports = ports;
        this.strict = opts.strict ?? false;
    }
    emit(event) {
        for (let i = 0; i < this.ports.length; i++) {
            this.forward(this.ports[i], i, event);
        }
    }
    forward(port, index, event) {
        if (port === undefined)
            return;
        try {
            port.emit(event);
        }
        catch (e) {
            if (this.strict)
                throw e;
            this.track(index, toError(e).message);
        }
    }
    track(index, reason) {
        const key = `${index}:${reason}`;
        const existing = this.failures.get(key);
        if (existing) {
            existing.count += 1;
            return;
        }
        this.failures.set(key, { component: "TeeStream", reason, count: 1 });
    }
    /** Snapshot of degraded ports (one record per port+reason). */
    degraded() {
        return [...this.failures.values()].map((r) => ({ ...r }));
    }
}
