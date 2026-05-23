import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import * as repl from "../../../src/apps/cli/repl";
import * as sessionIo from "../../../src/apps/cli/session-io";
/**
 * Phase-3 split shape test (RFC may-22-unified-agent-runtime §3).
 *
 * Asserts the surface contract of the structural refactor: the REPL loop +
 * main-orchestration body now live in `apps/cli/repl.ts`, the session
 * cwd-switch + per-turn save plumbing in `apps/cli/session-io.ts`, and
 * `apps/cli/index.ts` delegates to them instead of owning the loop inline.
 *
 * Pure shape checks — no agent / LLM wiring is exercised here. The behavior
 * contract is covered by the existing CLI integration tests
 * (`tests/integration/session-cli-subprocess.test.ts`,
 * `tests/integration/resume-e2e.test.ts`) which already drive the binary
 * end-to-end and continue to pass UNCHANGED post-split.
 */
describe("apps/cli/repl + session-io extract shape", () => {
    test("repl.ts exports the entry function runRepl", () => {
        expect(typeof repl.runRepl).toBe("function");
    });
    test("repl.ts exports the REPL loop, session subcommand and slash dispatchers", () => {
        expect(typeof repl.runReplLoop).toBe("function");
        expect(typeof repl.runSessionMain).toBe("function");
        expect(typeof repl.runSlashMain).toBe("function");
        expect(typeof repl.topLevelUsage).toBe("function");
    });
    test("session-io.ts exports switchToSessionCwd and persistTurn", () => {
        expect(typeof sessionIo.switchToSessionCwd).toBe("function");
        expect(typeof sessionIo.persistTurn).toBe("function");
    });
    test("index.ts delegates to repl.runRepl (no inline REPL loop body)", () => {
        const indexPath = join(import.meta.dir, "../../../src/apps/cli/index.ts");
        const src = readFileSync(indexPath, "utf8");
        // The delegate call is present.
        expect(src).toContain("runRepl()");
        // The REPL loop body has been moved out of index.ts: the question prompt
        // string only exists in `repl.ts` now.
        expect(src).not.toContain("quanta›");
        // The cwd-switch helper is in session-io, not inlined here.
        expect(src).not.toContain("switchToSessionCwd");
    });
});
