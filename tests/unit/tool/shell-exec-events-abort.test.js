import { describe, expect, test } from "bun:test";
import { runShell } from "@/runtime";
/** PR-5 / ADR-0081 — abort path: a long-running `sleep` aborted via the
 *  caller's `AbortSignal` produces an `aborted` terminal with reason
 *  `user_abort` (NOT `timeout`). */
describe("shell exec events — abort", () => {
    test("user-initiated abort emits an aborted event with reason=user_abort", async () => {
        const events = [];
        const ctrl = new AbortController();
        // Abort after 100ms — well before the default 120s timeout.
        setTimeout(() => ctrl.abort(), 100);
        const r = await runShell("sleep 10", {
            signal: ctrl.signal,
            onShellEvent: (e) => events.push(e),
        });
        // Process was killed; exit code is non-zero, timedOut is false (timeout
        // is reserved for the internal timer firing).
        expect(r.exitCode).not.toBe(0);
        expect(r.timedOut).toBe(false);
        // First event is start, last is aborted.
        expect(events[0]?.kind).toBe("start");
        const last = events[events.length - 1];
        if (last?.kind !== "aborted")
            throw new Error(`expected aborted terminal, got ${last?.kind}`);
        expect(last.reason).toBe("user_abort");
        expect(typeof last.abortedAt).toBe("number");
    });
    test("internal timeout emits an aborted event with reason=timeout", async () => {
        const events = [];
        const r = await runShell("sleep 10", {
            timeoutMs: 100,
            onShellEvent: (e) => events.push(e),
        });
        expect(r.timedOut).toBe(true);
        const last = events[events.length - 1];
        if (last?.kind !== "aborted")
            throw new Error(`expected aborted terminal, got ${last?.kind}`);
        expect(last.reason).toBe("timeout");
    });
});
