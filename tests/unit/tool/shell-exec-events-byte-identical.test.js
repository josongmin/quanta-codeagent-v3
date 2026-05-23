import { describe, expect, test } from "bun:test";
import { runShell } from "@/runtime";
/** PR-5 / ADR-0081 — byte-identical guarantee: a session that omits the
 *  observer sees exactly the buffered legacy behavior. A session that PROVIDES
 *  the observer additionally receives the typed event stream — but the FINAL
 *  `ShellResult` (stdout/stderr/exitCode/timedOut) is identical. This is what
 *  lets the streaming feature ship default-OFF with zero risk to existing
 *  consumers. */
describe("shell exec events — byte-identical with/without observer", () => {
    test("same command, observer-present vs observer-absent ⇒ identical ShellResult", async () => {
        const command = 'printf "line1\\nline2\\n"; printf "err\\n" 1>&2; exit 0';
        const events = [];
        const withObs = await runShell(command, {
            onShellEvent: (e) => events.push(e),
        });
        const withoutObs = await runShell(command);
        expect(withObs.stdout).toBe(withoutObs.stdout);
        expect(withObs.stderr).toBe(withoutObs.stderr);
        expect(withObs.exitCode).toBe(withoutObs.exitCode);
        expect(withObs.timedOut).toBe(withoutObs.timedOut);
        // The streamed-chunk concatenation also matches.
        const stdoutBytes = [];
        const stderrBytes = [];
        for (const e of events) {
            if (e.kind === "stdout")
                stdoutBytes.push(e.chunk);
            if (e.kind === "stderr")
                stderrBytes.push(e.chunk);
        }
        const decode = (chunks) => {
            const total = chunks.reduce((n, c) => n + c.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
            }
            return new TextDecoder("utf-8").decode(out);
        };
        expect(decode(stdoutBytes)).toBe(withObs.stdout);
        expect(decode(stderrBytes)).toBe(withObs.stderr);
    });
    test("observer-absent path emits no events (callback never invoked)", async () => {
        // Sanity: if a caller never wires an observer, nothing in `runShell` is
        // allowed to allocate or fire one. We can't directly assert on an absent
        // callback, but we can confirm the public surface is unchanged: the
        // returned ShellResult shape stays exactly `{stdout,stderr,exitCode,timedOut}`.
        const r = await runShell("echo ok");
        expect(Object.keys(r).sort()).toEqual(["exitCode", "stderr", "stdout", "timedOut"]);
        expect(r.stdout).toBe("ok\n");
        expect(r.exitCode).toBe(0);
    });
});
