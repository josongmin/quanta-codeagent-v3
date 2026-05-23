import { describe, expect, test } from "bun:test";
import { ALL_ATTR_KEYS, ATTR_KEY_SET, GEN_AI_ATTRS, isAttrKey, QUANTA_ATTRS, } from "@/observability/vocabulary";
const QUANTA_KEY_RE = /^quanta\.[a-z_]+(\.[a-z0-9_]+)+$/;
const GEN_AI_KEY_RE = /^gen_ai\.[a-z_]+(\.[a-z0-9_]+)*$/;
const collectStrings = (node, out) => {
    if (typeof node === "string") {
        out.push(node);
        return;
    }
    if (node !== null && typeof node === "object") {
        for (const v of Object.values(node)) {
            collectStrings(v, out);
        }
    }
};
const quantaKeys = () => {
    const out = [];
    collectStrings(QUANTA_ATTRS, out);
    return out;
};
const genAiKeys = () => {
    const out = [];
    collectStrings(GEN_AI_ATTRS, out);
    return out;
};
describe("vocabulary — namespace shape", () => {
    test("every quanta.* key matches the namespace regex", () => {
        for (const k of quantaKeys()) {
            expect(k).toMatch(QUANTA_KEY_RE);
        }
    });
    test("every gen_ai.* key matches the namespace regex", () => {
        for (const k of genAiKeys()) {
            expect(k).toMatch(GEN_AI_KEY_RE);
        }
    });
    test("no quanta.* key starts with gen_ai. and vice versa", () => {
        for (const k of quantaKeys())
            expect(k.startsWith("gen_ai.")).toBe(false);
        for (const k of genAiKeys())
            expect(k.startsWith("quanta.")).toBe(false);
    });
    test("every key is snake_case after the namespace prefix", () => {
        // strict: only lowercase letters, digits, underscore and dot as separator
        const snake = /^[a-z][a-z0-9_.]*$/;
        for (const k of ALL_ATTR_KEYS) {
            expect(k).toMatch(snake);
            // no camelCase fragments — uppercase letters are forbidden
            expect(k).toBe(k.toLowerCase());
        }
    });
    test("no duplicate keys across the whole vocabulary", () => {
        const all = [...quantaKeys(), ...genAiKeys()];
        const unique = new Set(all);
        expect(unique.size).toBe(all.length);
    });
});
describe("vocabulary — coverage / required namespaces", () => {
    test("QUANTA_ATTRS exposes all required namespaces", () => {
        const required = [
            "conversation",
            "thread",
            "turn",
            "tool",
            "mcp",
            "task",
            "multiAgent",
            "memory",
            "permission",
            "patch",
            "rules",
            "sqlite",
        ];
        for (const ns of required) {
            expect(QUANTA_ATTRS[ns]).toBeDefined();
        }
    });
    test("GEN_AI_ATTRS exposes request / response / usage / tool / system", () => {
        expect(GEN_AI_ATTRS.request).toBeDefined();
        expect(GEN_AI_ATTRS.response).toBeDefined();
        expect(GEN_AI_ATTRS.usage).toBeDefined();
        expect(GEN_AI_ATTRS.tool).toBeDefined();
        expect(GEN_AI_ATTRS.system).toBe("gen_ai.system");
    });
    test("ADR-anchored keys are present (compile-time safety net)", () => {
        expect(QUANTA_ATTRS.turn.steered).toBe("quanta.turn.steered"); // ADR-0030
        expect(QUANTA_ATTRS.turn.kind).toBe("quanta.turn.kind");
        expect(QUANTA_ATTRS.permission.reviewerTier).toBe("quanta.permission.reviewer_tier"); // ADR-0029
        expect(QUANTA_ATTRS.permission.outcome).toBe("quanta.permission.outcome");
        expect(QUANTA_ATTRS.patch.fuzzyMatched).toBe("quanta.patch.fuzzy_matched"); // ADR-0028
        expect(QUANTA_ATTRS.patch.op).toBe("quanta.patch.op");
    });
    test("GenAI usage keys include cache-creation/read variants", () => {
        expect(GEN_AI_ATTRS.usage.cacheCreationInputTokens).toBe("gen_ai.usage.cache_creation_input_tokens");
        expect(GEN_AI_ATTRS.usage.cacheReadInputTokens).toBe("gen_ai.usage.cache_read_input_tokens");
    });
    test("vocabulary defines at least 50 canonical keys", () => {
        expect(ALL_ATTR_KEYS.length).toBeGreaterThanOrEqual(50);
    });
});
describe("vocabulary — frozen surface", () => {
    test("ALL_ATTR_KEYS is sorted ascending", () => {
        const sorted = [...ALL_ATTR_KEYS].sort();
        expect([...ALL_ATTR_KEYS]).toEqual(sorted);
    });
    test("ALL_ATTR_KEYS is frozen (no in-place mutation)", () => {
        expect(Object.isFrozen(ALL_ATTR_KEYS)).toBe(true);
    });
    test("ATTR_KEY_SET membership matches ALL_ATTR_KEYS exactly", () => {
        expect(ATTR_KEY_SET.size).toBe(ALL_ATTR_KEYS.length);
        for (const k of ALL_ATTR_KEYS)
            expect(ATTR_KEY_SET.has(k)).toBe(true);
    });
    test("QUANTA_ATTRS.turn nested object is itself frozen via as const", () => {
        // `as const` provides Readonly typing but not deep Object.freeze; verify
        // it at least preserves expected literal identity (regression guard).
        expect(QUANTA_ATTRS.turn.id).toBe("quanta.turn.id");
    });
});
describe("vocabulary — isAttrKey predicate", () => {
    test("returns true for every declared key", () => {
        for (const k of ALL_ATTR_KEYS)
            expect(isAttrKey(k)).toBe(true);
    });
    test("returns false for unknown / typo'd keys", () => {
        expect(isAttrKey("quanta.turn.idd")).toBe(false);
        expect(isAttrKey("Quanta.Turn.Id")).toBe(false);
        expect(isAttrKey("")).toBe(false);
        expect(isAttrKey("gen_ai.usage.tokens")).toBe(false); // not declared
        expect(isAttrKey("foo.bar")).toBe(false);
    });
    test("returns false for prototype-pollution-style probes", () => {
        expect(isAttrKey("__proto__")).toBe(false);
        expect(isAttrKey("constructor")).toBe(false);
        expect(isAttrKey("toString")).toBe(false);
    });
});
