import { describe, expect, test } from "bun:test";
import { buildEvidenceSummary, renderCatalog } from "../../tools/feature-catalog/render";
function makeFeature(over = {}) {
    const base = {
        id: "x",
        title: "X",
        section: 1,
        subsystem: "1.1",
        order: 0,
        maturity: "L3",
        status: "stable",
        purpose: "do a thing",
        evidence: {
            code: [],
            adrs: [],
            tests: { unit: [], integration: [], contract: [] },
        },
        knobs: [],
        deliberate_hold: null,
    };
    return { ...base, ...over };
}
function asLoaded(f) {
    return { feature: f, path: `mem://${f.id}` };
}
describe("buildEvidenceSummary — thin summary line", () => {
    test("renders code + ADR + tests + knobs", () => {
        const f = makeFeature({
            evidence: {
                code: ["src/runtime/sandbox.ts", "src/runtime/policy.ts"],
                adrs: [6, 11],
                tests: {
                    unit: ["tests/unit/a.test.ts"],
                    integration: ["tests/integration/b.test.ts", "tests/integration/c.test.ts"],
                    contract: ["tests/contract/d.test.ts"],
                },
            },
            knobs: ["QUANTA_DOCKER"],
        });
        expect(buildEvidenceSummary(f)).toBe("src/runtime/sandbox.ts, src/runtime/policy.ts · ADR-6,11 · 1u/2i/1c · ⚙️QUANTA_DOCKER");
    });
    test("skips empty buckets", () => {
        const f = makeFeature({
            evidence: {
                code: ["src/a.ts"],
                adrs: [],
                tests: { unit: ["tests/unit/a.test.ts"], integration: [], contract: [] },
            },
        });
        expect(buildEvidenceSummary(f)).toBe("src/a.ts · 1u");
    });
    test("emits empty string when nothing", () => {
        const f = makeFeature();
        expect(buildEvidenceSummary(f)).toBe("");
    });
});
describe("renderCatalog — full output structure", () => {
    test("emits header + auto-gen comment + intro prose", () => {
        const md = renderCatalog({
            features: [],
            prose: { intro: "Some intro paragraph.", trailers: [] },
            baseline: null,
        });
        expect(md.startsWith("<!-- AUTO-GENERATED")).toBe(true);
        expect(md).toContain("# 10. 기능 카탈로그");
        expect(md).toContain("Some intro paragraph.");
        expect(md).toContain("## E2E 통합 커버리지");
        expect(md).toContain("## 등급 분포 요약");
        expect(md).toContain("## 잔류 deliberate-boundary");
    });
    test("groups features by section into tables, hides repeating subsystem", () => {
        const features = [
            asLoaded(makeFeature({
                id: "loop-fsm",
                section: 1,
                subsystem: "1.1 턴 상태머신",
                title: "단일 while 루프",
                maturity: "L5",
            })),
            asLoaded(makeFeature({
                id: "loop-maxturns",
                section: 1,
                subsystem: "1.1 턴 상태머신",
                title: "maxTurns",
                maturity: "L5",
            })),
            asLoaded(makeFeature({
                id: "tool-dispatch",
                section: 2,
                subsystem: "2.1 코어 도구",
                title: "9종 코어 도구",
                maturity: "L5",
            })),
        ];
        const md = renderCatalog({
            features,
            prose: { intro: "", trailers: [] },
            baseline: null,
        });
        expect(md).toContain("## 대 1. 에이전트 코어 루프 (ReAct)");
        expect(md).toContain("## 대 2. 도구 시스템");
        // Second entry in section 1 should have empty subsystem cell (collapse)
        const sec1 = md.split("## 대 2.")[0] ?? "";
        expect(sec1).toContain("| 1.1 턴 상태머신 | 단일 while 루프 |");
        expect(sec1).toContain("|  | maxTurns |");
    });
    test("E2E coverage section collects integration tests ending in -e2e.test.ts", () => {
        const features = [
            asLoaded(makeFeature({
                id: "feat-a",
                title: "Feature A",
                evidence: {
                    code: [],
                    adrs: [],
                    tests: {
                        unit: [],
                        integration: [
                            "tests/integration/closeout-e2e.test.ts",
                            "tests/integration/other.test.ts",
                        ],
                        contract: [],
                    },
                },
            })),
        ];
        const md = renderCatalog({
            features,
            prose: { intro: "", trailers: [] },
            baseline: null,
        });
        expect(md).toContain("- closeout · Feature A");
        expect(md).not.toContain("- other ·");
    });
    test("maturity distribution counts and lists titles", () => {
        const features = [
            asLoaded(makeFeature({ id: "a", title: "A", maturity: "L5" })),
            asLoaded(makeFeature({ id: "b", title: "B", maturity: "L5" })),
            asLoaded(makeFeature({ id: "c", title: "C", maturity: "L3" })),
        ];
        const md = renderCatalog({
            features,
            prose: { intro: "", trailers: [] },
            baseline: null,
        });
        // Thin distribution: L5/L4 show count only (long tail noise); L3/L2/L1
        // show counts + titles + section tag (the "what's not finished" set).
        expect(md).toContain("- **L5** (2)");
        expect(md).toContain("- **L3** (1): C (대 1)");
        expect(md).toContain("- **L4** (0)");
    });
    test("deliberate_hold section lists held features only", () => {
        const features = [
            asLoaded(makeFeature({
                id: "a",
                title: "Active",
                deliberate_hold: null,
            })),
            asLoaded(makeFeature({
                id: "h",
                title: "Held One",
                maturity: "L2",
                deliberate_hold: { reason: "advisory only", promotion_path: "ship after benchmark" },
            })),
        ];
        const md = renderCatalog({
            features,
            prose: { intro: "", trailers: [] },
            baseline: null,
        });
        expect(md).toContain("- **Held One** (L2) — advisory only → ship after benchmark");
        expect(md).not.toContain("**Active**");
    });
    test("footer includes baseline numbers when provided", () => {
        const md = renderCatalog({
            features: [],
            prose: { intro: "", trailers: [] },
            baseline: {
                pass: 1952,
                fail: 0,
                skip: 2,
                expect: 5624,
                files: 154,
                generated_at: "2026-05-21",
            },
        });
        expect(md).toContain("1952/0/2/5624 (154 files). 최종 빌드: 2026-05-21.");
    });
    test("trailer prose is inserted before footer", () => {
        const md = renderCatalog({
            features: [],
            prose: {
                intro: "INTRO_HEADER",
                trailers: [
                    { name: "50-x.md", content: "TRAILER_FIFTY" },
                    { name: "99-y.md", content: "TRAILER_NINETYNINE" },
                ],
            },
            baseline: null,
        });
        const introIdx = md.indexOf("INTRO_HEADER");
        const fiftyIdx = md.indexOf("TRAILER_FIFTY");
        const ninetyIdx = md.indexOf("TRAILER_NINETYNINE");
        const footerIdx = md.indexOf("검증 베이스라인");
        expect(introIdx).toBeGreaterThan(0);
        expect(fiftyIdx).toBeGreaterThan(introIdx);
        expect(ninetyIdx).toBeGreaterThan(fiftyIdx);
        expect(footerIdx).toBeGreaterThan(ninetyIdx);
    });
    test("golden snapshot — small fixtures set", () => {
        const features = [
            asLoaded(makeFeature({
                id: "loop-fsm",
                section: 1,
                subsystem: "1.1 턴 상태머신",
                title: "단일 while 루프",
                maturity: "L5",
                purpose: "ReAct 루프 진입점. 단일 while로 모든 분기를 표현.",
                evidence: {
                    code: ["src/agent/loop.ts"],
                    adrs: [4, 11],
                    tests: { unit: ["tests/unit/loop.test.ts"], integration: [], contract: [] },
                },
            })),
            asLoaded(makeFeature({
                id: "verify-guard",
                section: 1,
                subsystem: "1.4 Verify-guard",
                title: "변경 후 검증 강제",
                maturity: "L4",
                purpose: "mutating 도구 후 verify 없이 finish 시 1턴 강제.",
                evidence: {
                    code: ["src/agent/verify-guard.ts"],
                    adrs: [13],
                    tests: {
                        unit: ["tests/unit/verify-guard.test.ts"],
                        integration: ["tests/integration/verify-guard-e2e.test.ts"],
                        contract: [],
                    },
                },
                knobs: ["QUANTA_VERIFY_GUARD"],
            })),
        ];
        const md = renderCatalog({
            features,
            prose: {
                intro: "Round-1 baseline.",
                trailers: [{ name: "99-policy.md", content: "Policy." }],
            },
            baseline: { pass: 10, fail: 0, skip: 0, expect: 30, files: 3, generated_at: "2026-01-01" },
        });
        const expected = [
            "<!-- AUTO-GENERATED from tools/feature-catalog/. Do not edit. Run `bun fc build`. -->",
            "",
            "# 10. 기능 카탈로그 (Feature Catalog)",
            "",
            "Round-1 baseline.",
            "",
            "---",
            "",
            "## 대 1. 에이전트 코어 루프 (ReAct)",
            "",
            "| 중 | 소 | 등급 | 핵심 |",
            "|---|---|---|---|",
            "| 1.1 턴 상태머신 | 단일 while 루프 | **L5** | ReAct 루프 진입점. 단일 while로 모든 분기를 표현. · src/agent/loop.ts · ADR-4,11 · 1u |",
            "| 1.4 Verify-guard | 변경 후 검증 강제 | **L4** | mutating 도구 후 verify 없이 finish 시 1턴 강제. · src/agent/verify-guard.ts · ADR-13 · 1u/1i · ⚙️QUANTA_VERIFY_GUARD |",
            "",
            "---",
            "",
            "## E2E 통합 커버리지",
            "",
            "- verify-guard · 변경 후 검증 강제",
            "",
            "## 등급 분포 요약",
            "",
            "- **L5** (1)",
            "- **L4** (1)",
            "- **L3** (0)",
            "- **L2** (0)",
            "- **L1** (0)",
            "",
            "## 잔류 deliberate-boundary",
            "",
            "_(없음)_",
            "",
            "---",
            "",
            "Policy.",
            "",
            "---",
            "",
            "> 검증 베이스라인: tsc 0 · biome clean · 10/0/0/30 (3 files). 최종 빌드: 2026-01-01.",
            "",
        ].join("\n");
        expect(md).toBe(expected);
    });
});
