/**
 * Nearest-rank percentile on a sorted ascending sample.
 *
 * rank = ceil(p/100 * n), 1-indexed, clamped to [1, n]. For values 1..100 this
 * yields p50 = sample[ceil(50)-1] = 50, p95 = sample[ceil(95)-1] = 95. (The
 * "≈51 / ≈96" wording in the spec accounts for off-by-one across percentile
 * definitions; nearest-rank lands on the lower of the pair.) Returns 0 for an
 * empty sample.
 */
const percentile = (sortedAsc, p) => {
    const n = sortedAsc.length;
    if (n === 0)
        return 0;
    const rank = Math.ceil((p / 100) * n);
    const idx = Math.min(Math.max(rank, 1), n) - 1;
    return sortedAsc[idx] ?? 0;
};
const summarize = (samples) => {
    const count = samples.length;
    if (count === 0) {
        return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    let sum = 0;
    for (const v of samples)
        sum += v;
    return {
        count,
        min: sorted[0] ?? 0,
        max: sorted[count - 1] ?? 0,
        mean: sum / count,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
    };
};
class CounterImpl {
    n = 0;
    inc(delta = 1) {
        this.n += delta;
    }
    value() {
        return this.n;
    }
}
class GaugeImpl {
    v = 0;
    set(value) {
        this.v = value;
    }
    value() {
        return this.v;
    }
}
class TimerImpl {
    clock;
    samples = [];
    constructor(clock) {
        this.clock = clock;
    }
    start() {
        const begin = this.clock();
        return () => {
            const elapsed = this.clock() - begin;
            this.record(elapsed);
            return elapsed;
        };
    }
    record(ms) {
        this.samples.push(ms);
    }
    stats() {
        return summarize(this.samples);
    }
}
/**
 * Lightweight in-process metrics registry: counters, gauges, timers.
 *
 * Instantiable and isolated — no global mutable singleton, so tests use fresh
 * instances. A shared default (`metrics`) is exported for app wiring only.
 * The monotonic clock is injectable for deterministic timer tests.
 */
export class Metrics {
    counters = new Map();
    gauges = new Map();
    timers = new Map();
    clock;
    constructor(clock = () => performance.now()) {
        this.clock = clock;
    }
    counter(name) {
        let c = this.counters.get(name);
        if (c === undefined) {
            c = new CounterImpl();
            this.counters.set(name, c);
        }
        return c;
    }
    gauge(name) {
        let g = this.gauges.get(name);
        if (g === undefined) {
            g = new GaugeImpl();
            this.gauges.set(name, g);
        }
        return g;
    }
    timer(name) {
        let t = this.timers.get(name);
        if (t === undefined) {
            t = new TimerImpl(this.clock);
            this.timers.set(name, t);
        }
        return t;
    }
    snapshot() {
        const counters = {};
        for (const [name, c] of this.counters)
            counters[name] = c.value();
        const gauges = {};
        for (const [name, g] of this.gauges)
            gauges[name] = g.value();
        const timers = {};
        for (const [name, t] of this.timers)
            timers[name] = t.stats();
        return { counters, gauges, timers };
    }
}
/** Shared default registry for app wiring. Tests construct fresh instances. */
export const metrics = new Metrics();
