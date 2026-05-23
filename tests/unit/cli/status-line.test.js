/**
 * CLI status-line — surface-agnostic context-usage formatter (Claude Desktop
 * 1.7196.3 `getContextUsage` parity).
 *
 * The helper renders a single-line "[bar] used/max (pct%) · model" string
 * suitable for a CLI prompt prefix, a Tauri sidebar, or a future REPL header.
 * Pure function, no I/O, no `@/agent` import — the only allowed import scope
 * is `node:*`, so a future Tauri / Web surface can call it verbatim.
 *
 * Bar contract:
 *   - Exactly 20 cells wide (`█` filled, `░` empty).
 *   - 5% per cell ⇒ 0% = 20 empty, 100% = 20 filled.
 *   - Oversized (>100%) ⇒ bar saturates at 20 filled and a trailing `!`
 *     indicator follows the percentage.
 *   - Model name is the last segment, after `·`. Missing/blank ⇒ "unknown".
 */
import { describe, expect, test } from "bun:test";
import { formatContextUsage } from "../../../src/apps/cli/status-line";
describe("formatContextUsage — bar shape", () => {
    test("0% ⇒ fully empty bar (20 empty cells)", () => {
        const out = formatContextUsage(0, 200_000, "claude-sonnet-4-5");
        expect(out).toContain("[░░░░░░░░░░░░░░░░░░░░]");
        expect(out).toContain("0/200k");
        expect(out).toContain("(0%)");
        expect(out).toContain("claude-sonnet-4-5");
    });
    test("100% ⇒ fully filled bar (20 filled cells), no oversize marker", () => {
        const out = formatContextUsage(200_000, 200_000, "claude-sonnet-4-5");
        expect(out).toContain("[████████████████████]");
        expect(out).toContain("(100%)");
        expect(out).not.toContain("!");
    });
    test("25% ⇒ exactly 5 filled + 15 empty", () => {
        const out = formatContextUsage(50_000, 200_000, "claude-sonnet-4-5");
        expect(out).toContain("[█████░░░░░░░░░░░░░░░]");
        expect(out).toContain("50.0k/200k");
        expect(out).toContain("(25%)");
    });
    test("50% ⇒ 10 filled + 10 empty", () => {
        const out = formatContextUsage(100_000, 200_000, "claude-sonnet-4-5");
        expect(out).toContain("[██████████░░░░░░░░░░]");
        expect(out).toContain("(50%)");
    });
});
describe("formatContextUsage — oversize / clamp behaviour", () => {
    test(">100% ⇒ bar saturates at full and `!` marker is appended to pct", () => {
        const out = formatContextUsage(250_000, 200_000, "claude-sonnet-4-5");
        expect(out).toContain("[████████████████████]");
        expect(out).toContain("(125%!)");
    });
    test("exactly 100% does NOT show the `!` marker", () => {
        const out = formatContextUsage(200_000, 200_000, "claude-sonnet-4-5");
        expect(out).not.toContain("(100%!)");
        expect(out).toContain("(100%)");
    });
});
describe("formatContextUsage — model fallback", () => {
    test("missing model ⇒ trailing segment is `unknown`", () => {
        const out = formatContextUsage(50_000, 200_000);
        expect(out).toContain("· unknown");
    });
    test("empty-string model ⇒ trailing segment is `unknown`", () => {
        const out = formatContextUsage(50_000, 200_000, "");
        expect(out).toContain("· unknown");
    });
    test("whitespace-padded model is trimmed", () => {
        const out = formatContextUsage(50_000, 200_000, "  claude-sonnet-4-5  ");
        expect(out).toContain("· claude-sonnet-4-5");
    });
});
describe("formatContextUsage — number rendering", () => {
    test("k-suffix for thousands, no decimal when round", () => {
        const out = formatContextUsage(50_000, 200_000, "m");
        expect(out).toContain("50.0k/200k");
    });
    test("under 1000 ⇒ raw integer rendering", () => {
        const out = formatContextUsage(523, 200_000, "m");
        expect(out).toContain("523/200k");
    });
    test("rounds percent to integer", () => {
        const out = formatContextUsage(23_456, 200_000, "m"); // 11.728%
        expect(out).toContain("(12%)");
    });
});
describe("formatContextUsage — invariants", () => {
    test("negative used clamps to 0%", () => {
        const out = formatContextUsage(-100, 200_000, "m");
        expect(out).toContain("(0%)");
        expect(out).toContain("[░░░░░░░░░░░░░░░░░░░░]");
    });
    test("zero/negative max ⇒ degraded `unknown context size` form", () => {
        const out = formatContextUsage(100, 0, "m");
        // Bar still renders (empty), pct is "?" — we never divide by zero.
        expect(out).toContain("(?)");
        expect(out).not.toContain("NaN");
        expect(out).not.toContain("Infinity");
    });
    test("output is a single line — no embedded newlines", () => {
        const out = formatContextUsage(50_000, 200_000, "claude-sonnet-4-5");
        expect(out.includes("\n")).toBe(false);
    });
});
