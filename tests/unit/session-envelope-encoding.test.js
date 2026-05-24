import { describe, expect, test } from "bun:test";
import { decodeSessionLine, encodeSessionLine, SESSION_ENVELOPE_VERSION, } from "@/session";
const meta = () => ({
    type: "session_meta",
    schema_version: SESSION_ENVELOPE_VERSION,
    session_id: "s-1",
    started_at: "2026-05-21T00:00:00.000Z",
    cwd: "/tmp",
    cli_version: "0.1.0",
    model: "gpt-5",
});
const turnContext = () => ({
    type: "turn_context",
    schema_version: SESSION_ENVELOPE_VERSION,
    turn_id: "t-1",
    cwd: "/tmp",
    current_date: "2026-05-21T00:00:00.000Z",
    timezone: "America/Los_Angeles",
    approval_policy: "on-request",
    sandbox_policy: "workspace-write",
    permission_profile: "default",
    model: "gpt-5",
    personality: "default",
    collaboration_mode: "solo",
    realtime_active: false,
    effort: "medium",
    summary: "",
    user_instructions: "",
    truncation_policy: "none",
    parent_thread_id: null,
    thread_role: "root",
});
describe("encodeSessionLine", () => {
    test("ends with exactly one newline", () => {
        const line = encodeSessionLine(meta());
        expect(line.endsWith("\n")).toBe(true);
        expect(line.endsWith("\n\n")).toBe(false);
    });
    test("emits keys in alphabetical order", () => {
        const line = encodeSessionLine(meta());
        const trimmed = line.slice(0, -1);
        // Strip the leading `{` and trailing `}` then look at the order keys
        // appear before each `:`.
        const inner = trimmed.slice(1, -1);
        const keys = inner.split(",").map((p) => {
            const colon = p.indexOf(":");
            return p.slice(1, colon - 1);
        });
        const sorted = [...keys].sort();
        expect(keys).toEqual(sorted);
    });
    test("round-trips byte-identically", () => {
        const r1 = meta();
        const w1 = encodeSessionLine(r1);
        const decoded = decodeSessionLine(w1);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok)
            throw new Error("unreachable");
        expect(encodeSessionLine(decoded.value)).toBe(w1);
    });
    test("two semantically-equal records with different key insertion orders produce identical wire forms", () => {
        const a = meta();
        // Build b with reverse iteration order to defeat any insertion-order
        // bias in the encoder.
        const flipped = {};
        for (const k of Object.keys(a).reverse()) {
            flipped[k] = a[k];
        }
        const b = flipped;
        expect(encodeSessionLine(b)).toBe(encodeSessionLine(a));
    });
    test("UTF-8 byte length is stable for a fixed fixture", () => {
        const line = encodeSessionLine(meta());
        const bytes = new TextEncoder().encode(line);
        // The fixture is fully ASCII so byte length == char length. Pin both.
        expect(bytes.length).toBe(line.length);
        expect(line.length).toBeGreaterThan(0);
        // Pin the canonical encoding so any change to key ordering / quoting
        // shows up as a deliberate test update.
        expect(line).toBe(`{"cli_version":"0.1.0","cwd":"/tmp","model":"gpt-5","schema_version":2,"session_id":"s-1","started_at":"2026-05-21T00:00:00.000Z","type":"session_meta"}\n`);
    });
    test("handles unicode in user-content fields without corruption", () => {
        const r = {
            ...turnContext(),
            summary: "한글 ✅ 🚀",
            user_instructions: "emoji: 😀 — newline embedded\\n",
        };
        const line = encodeSessionLine(r);
        const decoded = decodeSessionLine(line);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok)
            throw new Error("unreachable");
        expect(encodeSessionLine(decoded.value)).toBe(line);
    });
    test("throws on schema-invalid record (programmer error)", () => {
        expect(() => encodeSessionLine({
            ...meta(),
            session_id: "",
        })).toThrow();
    });
});
describe("decodeSessionLine", () => {
    test("rejects empty line", () => {
        const r = decodeSessionLine("");
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("unreachable");
        expect(r.error.kind).toBe("empty_line");
    });
    test("rejects whitespace-only line as parse_json (not empty)", () => {
        const r = decodeSessionLine("   ");
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("unreachable");
        expect(r.error.kind).toBe("parse_json");
    });
    test("rejects malformed JSON", () => {
        const r = decodeSessionLine("{not json");
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("unreachable");
        expect(r.error.kind).toBe("parse_json");
    });
    test("rejects valid JSON with wrong shape", () => {
        const r = decodeSessionLine('{"type":"unknown"}');
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("unreachable");
        expect(r.error.kind).toBe("schema");
    });
    test("strips a leading BOM", () => {
        const line = encodeSessionLine(meta());
        const withBom = `﻿${line.slice(0, -1)}`; // BOM + no trailing newline
        const r = decodeSessionLine(withBom);
        expect(r.ok).toBe(true);
    });
    test("strips a trailing CR (CRLF source)", () => {
        const line = encodeSessionLine(meta());
        const withCr = `${line.slice(0, -1)}\r`;
        const r = decodeSessionLine(withCr);
        expect(r.ok).toBe(true);
    });
});
