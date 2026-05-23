import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeatureSchema, loadFeatures, loadFeaturesStrict, SECTION_NAMES, } from "../../tools/feature-catalog/schema";
describe("FeatureSchema — direct zod validation", () => {
    test("accepts a minimal valid feature", () => {
        const r = FeatureSchema.safeParse({
            id: "verify-guard",
            title: "Verify-guard",
            section: 1,
            subsystem: "1.4",
            maturity: "L4",
            purpose: "Block finish-without-verify",
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.order).toBe(0);
            expect(r.data.status).toBe("stable");
            expect(r.data.evidence.code).toEqual([]);
            expect(r.data.evidence.adrs).toEqual([]);
            expect(r.data.evidence.tests.unit).toEqual([]);
            expect(r.data.knobs).toEqual([]);
            expect(r.data.deliberate_hold).toBeNull();
        }
    });
    test("rejects missing required fields", () => {
        const r = FeatureSchema.safeParse({ id: "x" });
        expect(r.success).toBe(false);
    });
    test("rejects bad id (non-kebab-case)", () => {
        const r = FeatureSchema.safeParse({
            id: "BadID",
            title: "x",
            section: 1,
            subsystem: "1.1",
            maturity: "L1",
            purpose: "x",
        });
        expect(r.success).toBe(false);
    });
    test("rejects bad maturity", () => {
        const r = FeatureSchema.safeParse({
            id: "x",
            title: "x",
            section: 1,
            subsystem: "1.1",
            maturity: "L6",
            purpose: "x",
        });
        expect(r.success).toBe(false);
    });
    test("rejects out-of-range section", () => {
        const r = FeatureSchema.safeParse({
            id: "x",
            title: "x",
            section: 0,
            subsystem: "1.1",
            maturity: "L1",
            purpose: "x",
        });
        expect(r.success).toBe(false);
    });
    test("accepts deliberate_hold as null and as object", () => {
        const a = FeatureSchema.safeParse({
            id: "a",
            title: "a",
            section: 1,
            subsystem: "1.1",
            maturity: "L1",
            purpose: "x",
            deliberate_hold: null,
        });
        expect(a.success).toBe(true);
        const b = FeatureSchema.safeParse({
            id: "b",
            title: "b",
            section: 1,
            subsystem: "1.1",
            maturity: "L1",
            purpose: "x",
            deliberate_hold: { reason: "advisory only" },
        });
        expect(b.success).toBe(true);
        if (b.success) {
            expect(b.data.deliberate_hold?.reason).toBe("advisory only");
            expect(b.data.deliberate_hold?.promotion_path).toBeUndefined();
        }
    });
    test("applies defaults for evidence and knobs", () => {
        const r = FeatureSchema.safeParse({
            id: "x",
            title: "x",
            section: 2,
            subsystem: "2.1",
            maturity: "L3",
            purpose: "x",
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.evidence).toEqual({
                code: [],
                adrs: [],
                tests: { unit: [], integration: [], contract: [] },
            });
            expect(r.data.knobs).toEqual([]);
        }
    });
    test("accepts evidence with partial test buckets", () => {
        const r = FeatureSchema.safeParse({
            id: "x",
            title: "x",
            section: 2,
            subsystem: "2.1",
            maturity: "L4",
            purpose: "x",
            evidence: {
                code: ["src/x.ts"],
                adrs: [11],
                tests: { unit: ["tests/unit/x.test.ts"] },
            },
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.evidence.tests.integration).toEqual([]);
            expect(r.data.evidence.tests.contract).toEqual([]);
        }
    });
    test("rejects bad ADR type (string)", () => {
        const r = FeatureSchema.safeParse({
            id: "x",
            title: "x",
            section: 1,
            subsystem: "1.1",
            maturity: "L1",
            purpose: "x",
            evidence: { adrs: ["13"] },
        });
        expect(r.success).toBe(false);
    });
});
describe("SECTION_NAMES — canonical mapping", () => {
    test("includes 1..10", () => {
        for (let n = 1; n <= 10; n++) {
            expect(typeof SECTION_NAMES[n]).toBe("string");
        }
    });
    test("section 1 is agent core loop", () => {
        expect(SECTION_NAMES[1]).toContain("ReAct");
    });
});
describe("loadFeatures / loadFeaturesStrict — filesystem", () => {
    let tmp = "";
    beforeAll(async () => {
        tmp = await mkdtemp(join(tmpdir(), "fc-schema-"));
    });
    afterAll(async () => {
        if (tmp)
            await rm(tmp, { recursive: true, force: true });
    });
    test("loadFeatures returns empty array when dir absent", async () => {
        const got = await loadFeatures(join(tmp, "missing"));
        expect(got).toEqual([]);
    });
    test("loadFeatures parses one yaml file", async () => {
        const dir = join(tmp, "ok");
        await mkdir(dir, { recursive: true });
        const yaml = [
            "id: my-feature",
            "title: My Feature",
            "section: 1",
            "subsystem: '1.1'",
            "maturity: L3",
            "purpose: do a thing",
            "",
        ].join("\n");
        await writeFile(join(dir, "f.yaml"), yaml, "utf8");
        const got = await loadFeatures(dir);
        expect(got.length).toBe(1);
        const first = got[0];
        expect(first?.feature.id).toBe("my-feature");
    });
    test("loadFeaturesStrict throws on duplicate id", async () => {
        const dir = join(tmp, "dup");
        await mkdir(dir, { recursive: true });
        const yaml = (title) => [
            "id: dup",
            `title: ${title}`,
            "section: 1",
            "subsystem: '1.1'",
            "maturity: L1",
            "purpose: x",
            "",
        ].join("\n");
        await writeFile(join(dir, "a.yaml"), yaml("A"), "utf8");
        await writeFile(join(dir, "b.yaml"), yaml("B"), "utf8");
        await expect(loadFeaturesStrict(dir)).rejects.toThrow(/Duplicate feature id/);
    });
    test("loadFeatures surfaces parse errors with file path", async () => {
        const dir = join(tmp, "broken");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "broken.yaml"), "not a key line\n", "utf8");
        await expect(loadFeatures(dir)).rejects.toThrow(/broken\.yaml/);
    });
});
