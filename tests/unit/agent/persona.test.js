/**
 * Persona slot (ADR-0068) — closed enum + body + env resolver tests.
 *
 * Covers the four invariants of ADR-0068:
 *   1. closed 3-value enum, byte-stable iteration order
 *   2. `default` ⇒ empty body (byte-identical to pre-ADR base prompt)
 *   3. non-default bodies END WITH the guardrail line (re-binds tone to
 *      the honesty/evidence/trust ladders that follow in the base prompt)
 *   4. `resolvePersona` throws `PersonaInvalidError` on unknown env value
 *      (no silent fallback, ADR-0067 §C)
 */
import { describe, expect, test } from "bun:test";
import { ALL_PERSONAS, isPersonaKind, PersonaInvalidError, personaLines, renderPersonaBlock, resolvePersona, } from "@/agent/persona";
describe("ALL_PERSONAS + isPersonaKind", () => {
    test("ALL_PERSONAS contains exactly the closed enum", () => {
        expect([...ALL_PERSONAS].sort()).toEqual(["default", "friendly", "pragmatic"]);
    });
    test("ALL_PERSONAS iteration order is stable (default → friendly → pragmatic)", () => {
        expect(ALL_PERSONAS).toEqual(["default", "friendly", "pragmatic"]);
    });
    test("isPersonaKind narrows valid strings", () => {
        expect(isPersonaKind("default")).toBe(true);
        expect(isPersonaKind("friendly")).toBe(true);
        expect(isPersonaKind("pragmatic")).toBe(true);
    });
    test("isPersonaKind rejects unknown strings (case-sensitive)", () => {
        expect(isPersonaKind("")).toBe(false);
        expect(isPersonaKind("DEFAULT")).toBe(false);
        expect(isPersonaKind("Default")).toBe(false);
        expect(isPersonaKind("formal")).toBe(false);
        expect(isPersonaKind("none")).toBe(false);
    });
    test("isPersonaKind rejects non-strings", () => {
        expect(isPersonaKind(undefined)).toBe(false);
        expect(isPersonaKind(null)).toBe(false);
        expect(isPersonaKind(42)).toBe(false);
        expect(isPersonaKind({})).toBe(false);
        expect(isPersonaKind([])).toBe(false);
        expect(isPersonaKind(true)).toBe(false);
    });
});
describe("renderPersonaBlock", () => {
    test("default returns empty string (byte-identical preservation)", () => {
        expect(renderPersonaBlock("default")).toBe("");
    });
    test("friendly body carries the collaborative-partner cues", () => {
        const body = renderPersonaBlock("friendly");
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain("Persona: collaborative partner");
        expect(body).toContain('"we"');
        expect(body).toContain("let's");
        expect(body).toContain("intellectually engaged");
    });
    test("pragmatic body carries the terse-engineering cues", () => {
        const body = renderPersonaBlock("pragmatic");
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain("Persona: deeply pragmatic software engineer");
        expect(body).toContain("No cheerleading");
        expect(body).toContain("Clarity > Pragmatism > Rigor");
    });
    test("non-default bodies END WITH a guardrail line (ADR-0068 §Rationale)", () => {
        expect(renderPersonaBlock("friendly")).toMatch(/Warmth never overrides the honesty rail below\.$/);
        expect(renderPersonaBlock("pragmatic")).toMatch(/Clarity > Pragmatism > Rigor\.$/);
    });
    test("renderPersonaBlock output has NO trailing newline (caller controls join)", () => {
        expect(renderPersonaBlock("friendly").endsWith("\n")).toBe(false);
        expect(renderPersonaBlock("pragmatic").endsWith("\n")).toBe(false);
    });
});
describe("personaLines spread helper", () => {
    test("default ⇒ empty array (no extra lines spliced into base prompt)", () => {
        expect(personaLines("default")).toEqual([]);
    });
    test("friendly ⇒ [body, ''] (one blank-line separator before Policy stack)", () => {
        const lines = personaLines("friendly");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("collaborative partner");
        expect(lines[1]).toBe("");
    });
    test("pragmatic ⇒ [body, ''] (same shape)", () => {
        const lines = personaLines("pragmatic");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("pragmatic software engineer");
        expect(lines[1]).toBe("");
    });
    test("personaLines result is byte-stable across calls (same shape, same content)", () => {
        expect(personaLines("friendly")).toEqual(personaLines("friendly"));
        expect(personaLines("pragmatic")).toEqual(personaLines("pragmatic"));
        expect(personaLines("default")).toEqual(personaLines("default"));
    });
});
describe("resolvePersona (env → PersonaKind)", () => {
    test("absent QUANTA_PERSONA ⇒ 'default' (explicit choice, not heuristic)", () => {
        expect(resolvePersona({})).toBe("default");
    });
    test("each valid persona kind passes through", () => {
        expect(resolvePersona({ QUANTA_PERSONA: "default" })).toBe("default");
        expect(resolvePersona({ QUANTA_PERSONA: "friendly" })).toBe("friendly");
        expect(resolvePersona({ QUANTA_PERSONA: "pragmatic" })).toBe("pragmatic");
    });
    test("unknown value ⇒ PersonaInvalidError throw (no silent fallback)", () => {
        expect(() => resolvePersona({ QUANTA_PERSONA: "formal" })).toThrow(PersonaInvalidError);
        expect(() => resolvePersona({ QUANTA_PERSONA: "Default" })).toThrow(PersonaInvalidError);
        expect(() => resolvePersona({ QUANTA_PERSONA: "DEFAULT" })).toThrow(PersonaInvalidError);
        expect(() => resolvePersona({ QUANTA_PERSONA: "" })).toThrow(PersonaInvalidError);
    });
    test("PersonaInvalidError carries received value + names all valid kinds", () => {
        try {
            resolvePersona({ QUANTA_PERSONA: "formal" });
            expect.unreachable("resolvePersona should have thrown on unknown value");
        }
        catch (e) {
            expect(e).toBeInstanceOf(PersonaInvalidError);
            const err = e;
            expect(err.name).toBe("PersonaInvalidError");
            expect(err.received).toBe("formal");
            expect(err.message).toContain("default");
            expect(err.message).toContain("friendly");
            expect(err.message).toContain("pragmatic");
            expect(err.message).toContain("formal");
        }
    });
    test("unrelated env keys do not interfere", () => {
        expect(resolvePersona({ OTHER_KEY: "anything", FOO: "bar" })).toBe("default");
    });
});
