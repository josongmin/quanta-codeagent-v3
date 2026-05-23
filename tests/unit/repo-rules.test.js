import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoRules, REPO_RULE_CANDIDATES, renderRepoRulesBlock } from "@/agent";
describe("loadRepoRules", () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "qct-repo-rules-"));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    test("returns undefined when no rule file is present (byte-identical default)", async () => {
        const out = await loadRepoRules(cwd);
        expect(out).toBeUndefined();
    });
    test("loads AGENTS.md when present", async () => {
        await writeFile(join(cwd, "AGENTS.md"), "no heuristics\nfail-closed\n", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out).toBeDefined();
        expect(out?.entrypoint).toBe("AGENTS.md");
        expect(out?.sourcePath).toBe(join(cwd, "AGENTS.md"));
        expect(out?.body).toContain("no heuristics");
        expect(out?.loadedAt).toBeGreaterThan(0);
    });
    test("falls back to CLAUDE.md when AGENTS.md absent", async () => {
        await writeFile(join(cwd, "CLAUDE.md"), "claude rules go here", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out?.entrypoint).toBe("CLAUDE.md");
        expect(out?.body).toBe("claude rules go here");
    });
    test("prefers AGENTS.md over CLAUDE.md when both present (SSOT priority)", async () => {
        await writeFile(join(cwd, "AGENTS.md"), "primary", "utf8");
        await writeFile(join(cwd, "CLAUDE.md"), "secondary", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out?.entrypoint).toBe("AGENTS.md");
        expect(out?.body).toBe("primary");
    });
    test("falls back to .codex/CODEX-RULES.md as last resort", async () => {
        await mkdir(join(cwd, ".codex"), { recursive: true });
        await writeFile(join(cwd, ".codex/CODEX-RULES.md"), "codex legacy", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out?.entrypoint).toBe(".codex/CODEX-RULES.md");
        expect(out?.body).toBe("codex legacy");
    });
    test("skips empty (whitespace-only) files and continues to the next candidate", async () => {
        await writeFile(join(cwd, "AGENTS.md"), "   \n  \n", "utf8");
        await writeFile(join(cwd, "CLAUDE.md"), "real content", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out?.entrypoint).toBe("CLAUDE.md");
    });
    test("returns undefined when all candidates are empty", async () => {
        await writeFile(join(cwd, "AGENTS.md"), "", "utf8");
        await writeFile(join(cwd, "CLAUDE.md"), "\n", "utf8");
        const out = await loadRepoRules(cwd);
        expect(out).toBeUndefined();
    });
    test("REPO_RULE_CANDIDATES priority order is stable contract", () => {
        expect(REPO_RULE_CANDIDATES).toEqual(["AGENTS.md", "CLAUDE.md", ".codex/CODEX-RULES.md"]);
    });
    // Security: symlinked rule files MUST NOT be loaded. An attacker can replace
    // AGENTS.md with a symlink to ~/.ssh/id_rsa (or any sensitive file) and have
    // the contents ride into the LLM prompt every turn as repo authority. We
    // refuse to follow the link entirely — the next candidate (or undefined)
    // is the correct outcome.
    describe("symlink rejection (security)", () => {
        test("symlink to a regular file is skipped (no body read)", async () => {
            const target = join(cwd, "actual-secret.txt");
            await writeFile(target, "SECRET CONTENT", "utf8");
            await symlink(target, join(cwd, "AGENTS.md"));
            const out = await loadRepoRules(cwd);
            expect(out).toBeUndefined();
        });
        test("symlink to a missing file is skipped (no error)", async () => {
            await symlink(join(cwd, "does-not-exist"), join(cwd, "AGENTS.md"));
            const out = await loadRepoRules(cwd);
            expect(out).toBeUndefined();
        });
        test("symlink AGENTS.md skips to next candidate (CLAUDE.md regular file wins)", async () => {
            const target = join(cwd, "actual-secret.txt");
            await writeFile(target, "SECRET CONTENT", "utf8");
            await symlink(target, join(cwd, "AGENTS.md"));
            await writeFile(join(cwd, "CLAUDE.md"), "legitimate rules", "utf8");
            const out = await loadRepoRules(cwd);
            expect(out?.entrypoint).toBe("CLAUDE.md");
            expect(out?.body).toBe("legitimate rules");
            // The symlinked secret never appears in the rendered body.
            expect(out?.body).not.toContain("SECRET");
        });
    });
    describe("size cap (DOS / prompt-budget protection)", () => {
        test("32 KiB file is loaded entirely (under cap)", async () => {
            const body = "a".repeat(32 * 1024);
            await writeFile(join(cwd, "AGENTS.md"), body, "utf8");
            const out = await loadRepoRules(cwd);
            expect(out?.body.length).toBe(32 * 1024);
            expect(out?.body).not.toContain("[truncated");
        });
        test("100 KiB file is truncated with a marker showing first 64 KiB", async () => {
            const body = "a".repeat(100 * 1024);
            await writeFile(join(cwd, "AGENTS.md"), body, "utf8");
            const out = await loadRepoRules(cwd);
            expect(out).toBeDefined();
            // 64 KiB body + marker line; check the marker is present and the visible
            // body is exactly 64 KiB of original content.
            expect(out?.body).toContain("[truncated:");
            expect(out?.body).toContain("64 KiB");
            expect(out?.body).toContain(`${100 * 1024} bytes total`);
            const upTo = out?.body.indexOf("\n\n[truncated:") ?? -1;
            expect(upTo).toBe(64 * 1024);
        });
        test("non-ENOENT errors (EACCES) silently fall through to next candidate", async () => {
            // Simulate EACCES by writing the file then revoking read permission.
            // Skip on platforms where chmod has no real effect (e.g. CI containers
            // that run as root); the contract is "any error ⇒ skip", and any of
            // the next-candidate fallbacks is correct.
            const agents = join(cwd, "AGENTS.md");
            await writeFile(agents, "forbidden", "utf8");
            await chmod(agents, 0o000);
            try {
                await writeFile(join(cwd, "CLAUDE.md"), "fallback", "utf8");
                const out = await loadRepoRules(cwd);
                // Either we got CLAUDE.md (the EACCES skipped AGENTS.md as designed),
                // or — on root — AGENTS.md remained readable and won. Both are
                // acceptable; the contract is no throw and a valid result.
                expect(out).toBeDefined();
                expect(["AGENTS.md", "CLAUDE.md"]).toContain(out?.entrypoint ?? "");
            }
            finally {
                // Restore so cleanup can rm the dir.
                await chmod(agents, 0o644);
            }
        });
    });
});
describe("renderRepoRulesBlock", () => {
    test("renders with entrypoint citation header + trimmed body", () => {
        const block = renderRepoRulesBlock({
            sourcePath: "/x/AGENTS.md",
            entrypoint: "AGENTS.md",
            body: "\n\n  rule one\n  rule two\n  \n",
            loadedAt: 0,
        });
        expect(block).toContain("## Repo-local rules (from AGENTS.md)");
        expect(block).toContain("rule one");
        expect(block).toContain("rule two");
        // Trailing/leading whitespace from the body is stripped so the block has a
        // predictable footprint regardless of repo formatting.
        expect(block.endsWith("rule two")).toBe(true);
    });
    test("each entrypoint cites its own name", () => {
        const block = renderRepoRulesBlock({
            sourcePath: "/x/CLAUDE.md",
            entrypoint: "CLAUDE.md",
            body: "body",
            loadedAt: 0,
        });
        expect(block).toContain("(from CLAUDE.md)");
    });
});
