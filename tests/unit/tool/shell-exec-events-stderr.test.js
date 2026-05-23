import { describe, expect, test } from "bun:test";
import { runShell } from "@/runtime";
/** PR-5 / ADR-0081 — stderr stream: a command that writes to stderr produces
 *  `stderr` events whose concatenated bytes match `result.stderr`, with a
 *  separate per-stream byte offset starting at 0. */
describe("shell exec events — stderr stream", () => {
    test("stderr deltas concatenate to result.stderr and exit code is propagated", async () => {
        const events = [];
        // `1>&2` redirects stdout to stderr; then `exit 3` so the exit code is
        // non-zero and observable in both `result.exitCode` and the `exit` event.
        const r = await runShell("echo err-line 1>&2; exit 3", {
            onShellEvent: (e) => events.push(e),
        });
        expect(r.exitCode).toBe(3);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("err-line\n");
        // First event is start, last is exit.
        expect(events[0]?.kind).toBe("start");
        const last = events[events.length - 1];
        if (last?.kind !== "exit")
            throw new Error("expected exit terminal");
        expect(last.code).toBe(3);
        // Collect stderr chunks, verify offset accounting + byte concatenation.
        const stderrChunks = [];
        let expectedOffset = 0;
        let sawStdout = false;
        for (const e of events) {
            if (e.kind === "stdout")
                sawStdout = true;
            if (e.kind === "stderr") {
                expect(e.offset).toBe(expectedOffset);
                expectedOffset += e.chunk.byteLength;
                stderrChunks.push(e.chunk);
            }
        }
        expect(sawStdout).toBe(false);
        expect(stderrChunks.length).toBeGreaterThanOrEqual(1);
        const total = stderrChunks.reduce((n, c) => n + c.byteLength, 0);
        const concatenated = new Uint8Array(total);
        let off = 0;
        for (const c of stderrChunks) {
            concatenated.set(c, off);
            off += c.byteLength;
        }
        const decoded = new TextDecoder("utf-8").decode(concatenated);
        expect(decoded).toBe(r.stderr);
    });
});
