import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypescriptAdapter } from "@/lsp";
import { requireContract } from "./_guard";
const COMMAND = ["typescript-language-server", "--stdio"];
/** Probe whether typescript-language-server is actually launchable in this
 *  environment. The whole suite must stay 0-fail when it is absent, so this
 *  gates the real round-trip tests. */
const tsServerAvailable = async () => {
    try {
        const proc = Bun.spawn([COMMAND[0], "--version"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const exit = await Promise.race([
            proc.exited,
            new Promise((resolve) => setTimeout(() => resolve(-1), 5_000)),
        ]);
        try {
            proc.kill();
        }
        catch {
            // already exited
        }
        // `--version` exits non-zero on some builds but still proves the binary
        // resolves and runs; -1 means our timeout fired (treat as unavailable).
        return exit !== -1;
    }
    catch {
        return false;
    }
};
const available = requireContract("typescript-language-server", await tsServerAvailable());
const tmpDirs = [];
const makeTmpDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-lsp-ts-"));
    tmpDirs.push(dir);
    return dir;
};
afterAll(() => {
    for (const dir of tmpDirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            // best effort
        }
    }
});
describe("TypescriptAdapter (integration)", () => {
    if (!available) {
        test.skip("typescript-language-server not installed — skipping real round trip", () => {
            // biome-ignore lint/suspicious/noConsole: intentional skip signal for CI
            console.log("[lsp-typescript.test] typescript-language-server unavailable; tests skipped");
        });
        return;
    }
    test("reports an error diagnostic for a type-mismatched file", async () => {
        const dir = makeTmpDir();
        const file = join(dir, "bad.ts");
        writeFileSync(file, 'const n: number = "s"\nexport { n }\n');
        const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 9_000 });
        try {
            await adapter.start();
            const diags = await adapter.diagnostics(file);
            const errors = diags.filter((d) => d.severity === "error");
            expect(errors.length).toBeGreaterThan(0);
            const first = errors[0];
            expect(first).toBeDefined();
            if (first) {
                expect(first.uri).toContain("bad.ts");
                expect(typeof first.message).toBe("string");
                expect(first.message.length).toBeGreaterThan(0);
                // The error is on line 0 (zero-based LSP coords).
                expect(first.range.start.line).toBe(0);
                expect(first.range.end.character).toBeGreaterThanOrEqual(first.range.start.character);
            }
        }
        finally {
            await adapter.stop();
        }
    }, 15_000);
    test("reports no error diagnostics for a clean file", async () => {
        const dir = makeTmpDir();
        const file = join(dir, "good.ts");
        writeFileSync(file, "export const add = (a: number, b: number): number => a + b\n");
        const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 9_000 });
        try {
            await adapter.start();
            const diags = await adapter.diagnostics(file);
            expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
        }
        finally {
            await adapter.stop();
        }
    }, 15_000);
    test("stop() terminates the server process and is idempotent", async () => {
        const dir = makeTmpDir();
        const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 6_000 });
        await adapter.start();
        await adapter.stop();
        // W1-A audit fix: previous `expect(true).toBe(true)` was vapor — it
        // passed without expressing intent. `resolves.toBeUndefined()` makes the
        // idempotent contract explicit at the assertion site (second `stop()`
        // settles cleanly and returns `void`).
        await expect(adapter.stop()).resolves.toBeUndefined();
    }, 15_000);
});
