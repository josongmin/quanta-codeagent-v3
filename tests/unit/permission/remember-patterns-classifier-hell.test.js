/**
 * HELL-GATE for the classifier `suggested_allowlist_entry` surface and the
 * cascade-on-approval wiring (L3→L4 promotion of permission-remember-patterns).
 *
 * Coverage:
 *   C-1   No actionKey ⇒ no suggested entry (we never propose `null` patterns).
 *   C-2   Single-token actionKey ⇒ no suggestion (below the SAFE floor of 2
 *         tokens — a one-word command is too broad).
 *   C-3   `sudo` is stripped from the leading position.
 *   C-4   Flag tokens (`-x`, `--save-dev`) terminate the pattern early.
 *   C-5   Tokens are lowercased + whitespace-normalized.
 *   C-6   Pattern is capped at MAX_LEADING_TOKENS (4) — defense against
 *         classifier overfit on long literal invocations.
 *   C-7   Classified `arguments` carries every token (including flags), while
 *         `subcommandTokens` is the durable shape — they DIFFER on flagged
 *         invocations (regression guard).
 *   C-8   inferSuggestedAllowlistEntry never throws on adversarial input
 *         (control chars, unicode, very-long strings).
 */
import { describe, expect, test } from "bun:test";
import { classifyCommand, computeSubcommandTokens, inferSuggestedAllowlistEntry, } from "@/permission";
describe("classifier — inferSuggestedAllowlistEntry / classifyCommand — HELL", () => {
    test("C-1: no actionKey ⇒ null suggestion", () => {
        expect(inferSuggestedAllowlistEntry({ toolName: "bash" })).toBeNull();
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: null })).toBeNull();
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "" })).toBeNull();
    });
    test("C-2: single-token command (below SAFE floor) ⇒ null", () => {
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|ls" })).toBeNull();
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|ls", minTokens: 2 })).toBeNull();
        // Overriding the floor to 1 IS supported (caller opts into very broad).
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|ls", minTokens: 1 })).toBe("ls");
    });
    test("C-3: leading `sudo` is stripped", () => {
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|sudo npm install" })).toBe("npm,install");
    });
    test("C-4: flag tokens terminate the pattern", () => {
        // `-q` should stop the pattern at `pytest`. We need ≥ 2 non-flag tokens.
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|pytest -q tests/" })).toBeNull();
        // `--save-dev` after `install` ⇒ pattern stops at `install`.
        expect(inferSuggestedAllowlistEntry({
            toolName: "bash",
            actionKey: "bash|npm install --save-dev typescript",
        })).toBe("npm,install");
    });
    test("C-5: tokens are lowercased + whitespace-normalized", () => {
        expect(inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|  Git   Status  --short" })).toBe("git,status");
    });
    test("C-6: pattern capped at MAX_LEADING_TOKENS (4)", () => {
        expect(inferSuggestedAllowlistEntry({
            toolName: "bash",
            actionKey: "bash|a b c d e f g h",
        })).toBe("a,b,c,d");
    });
    test("C-7: classifyCommand returns arguments + subcommandTokens + suggested entry", () => {
        const c = classifyCommand({
            toolName: "bash",
            actionKey: "bash|npm install --save-dev typescript",
        });
        expect(c.name).toBe("bash");
        expect(c.arguments).toEqual(["npm", "install", "--save-dev", "typescript"]);
        expect(c.subcommandTokens).toEqual(["npm", "install"]);
        expect(c.suggestedAllowlistEntry).toBe("npm,install");
        // The two surfaces DIFFER — regression guard against future drift.
        expect(c.arguments).not.toEqual(c.subcommandTokens);
    });
    test("C-8: adversarial input is safe — never throws", () => {
        expect(() => inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|" + "\x00\x01\x02" })).not.toThrow();
        expect(() => inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: "bash|🔑 🚀 hello" })).not.toThrow();
        expect(() => inferSuggestedAllowlistEntry({ toolName: "bash", actionKey: `bash|${"x ".repeat(10_000)}` })).not.toThrow();
    });
    test("computeSubcommandTokens — public pure helper", () => {
        expect(computeSubcommandTokens(["git", "status", "--short"])).toEqual(["git", "status"]);
        expect(computeSubcommandTokens(["--help"])).toEqual([]);
        expect(computeSubcommandTokens([])).toEqual([]);
    });
});
