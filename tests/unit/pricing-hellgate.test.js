/**
 * ★ CONTRACT — G3: RFC-0002 §5.3 PRICING_VERSION (src/observability/pricing.ts)
 *   "Unknown model ⇒ null (not an error)" + cache_read billed at INPUT rate +
 *   zero-tokens known-model ⇒ 0. Structural defense: TABLE is `Object.create(
 *   null)` (no prototype chain) + call-site `Object.hasOwn` guard — prototype-
 *   named models (constructor/__proto__/toString/hasOwnProperty/valueOf) are
 *   genuinely unknown → null, NOT NaN (the original silent bug this fixed).
 *
 * G3 — cost / pricing boundaries (HELLGATE).
 *
 * Locks the pinned price table against silent drift, asserts the EXACT
 * documented cache_read posture (see note below), and stresses the numeric
 * path with degenerate / huge inputs that classically yield NaN, Infinity,
 * float-overflow, or negative cost.
 *
 * IMPORTANT — cache_read pricing (read this before "fixing" a failure):
 *   As of `pricing.v2` cache_read IS discounted and PROVIDER-AWARE (the v1
 *   "billed at full input rate, additive for all providers" posture was a
 *   double-count bug for OpenAI, whose `prompt_tokens` already includes
 *   `cached_tokens`). These tests now pin the corrected behavior:
 *     - OpenAI: cached portion carved OUT of input, re-priced at cacheReadPerM.
 *     - Anthropic: cacheRead additive at the discounted cacheReadPerM rate.
 */
import { describe, expect, test } from "bun:test";
import { costUsd, PRICING_VERSION } from "@/observability";
/* ------------------------------------------------------------------ */
/* 1. pinned table — exact $/1M, catch silent drift                    */
/* ------------------------------------------------------------------ */
describe("G3 pinned price table (exact cost at 1M in / 1M out)", () => {
    // Each entry: [model, inPerM, outPerM]. costUsd at 1M/1M = inPerM + outPerM.
    const PINNED = [
        ["gpt-4o", 2.5, 10],
        ["gpt-4o-mini", 0.15, 0.6],
        ["claude-opus-4-7", 15, 75],
        ["claude-sonnet-4-6", 3, 15],
        ["claude-haiku-4-5", 1, 5],
    ];
    for (const [model, inPerM, outPerM] of PINNED) {
        test(`${model}: 1M in + 1M out === ${inPerM} + ${outPerM}`, () => {
            expect(costUsd(model, 1_000_000, 1_000_000)).toBe(inPerM + outPerM);
        });
        test(`${model}: input-only and output-only isolate the two rates`, () => {
            expect(costUsd(model, 1_000_000, 0)).toBe(inPerM);
            expect(costUsd(model, 0, 1_000_000)).toBe(outPerM);
        });
    }
    test("PRICING_VERSION is the pinned table key", () => {
        expect(PRICING_VERSION).toBe("pricing.v2");
    });
});
/* ------------------------------------------------------------------ */
/* 2. cache_read posture (documented: input rate, NO discount)         */
/* ------------------------------------------------------------------ */
describe("G3 cache_read pricing (pricing.v2: provider-aware, discounted)", () => {
    test("OpenAI: cached portion carved out of prompt_tokens at the cache rate", () => {
        // gpt-4o: in $2.5/1M, cached $1.25/1M (0.5×), out $10/1M.
        // prompt_tokens (1M) ALREADY includes the 1M cache_read, so cache is NOT
        // added on top — it is re-priced: (1M−1M)*2.5 + 1M*1.25 + 1M*10 = 11.25.
        const base = costUsd("gpt-4o", 1_000_000, 1_000_000); // 12.5, no cache
        const withCache = costUsd("gpt-4o", 1_000_000, 1_000_000, 1_000_000);
        expect(withCache).toBe(11.25);
        // A cache hit LOWERS cost vs an all-fresh prompt of the same size (discount).
        expect(withCache).toBeLessThan(base);
        // Carve-out identity: fully-cached 1M prompt == pricing 1M purely at cache rate.
        expect(costUsd("gpt-4o", 1_000_000, 0, 1_000_000)).toBe((1_000_000 * 1.25) / 1_000_000);
    });
    test("Anthropic: cacheRead additive at the discounted cache-read rate", () => {
        // claude-opus-4-7: in $15/1M, cache-read $1.5/1M (0.1×), out $75/1M.
        // input_tokens EXCLUDES cache → 1M*15 + 1M*1.5 + 1M*75 = 91.5.
        const base = costUsd("claude-opus-4-7", 1_000_000, 1_000_000); // 90
        const withCache = costUsd("claude-opus-4-7", 1_000_000, 1_000_000, 1_000_000);
        expect(withCache).toBe(91.5);
        expect(withCache - base).toBe(1.5); // delta == discounted cache-read rate
    });
    test("omitting cacheReadTokens equals passing 0 (default-arg parity)", () => {
        expect(costUsd("claude-opus-4-7", 1234, 5678)).toBe(costUsd("claude-opus-4-7", 1234, 5678, 0));
    });
});
/* ------------------------------------------------------------------ */
/* 3. unknown / degenerate model → typed fallback, never NaN/crash     */
/* ------------------------------------------------------------------ */
describe("G3 unknown / degenerate model → null fallback (not NaN, not throw)", () => {
    test("unknown model → null", () => {
        expect(costUsd("totally-made-up", 100, 100)).toBeNull();
    });
    test("empty-string model → null (not a crash)", () => {
        expect(costUsd("", 100, 100)).toBeNull();
    });
    test("case-sensitive: a near-miss casing is unknown → null", () => {
        // The table key is exact; 'GPT-4O' is not 'gpt-4o'.
        expect(costUsd("GPT-4O", 100, 100)).toBeNull();
    });
    // REGRESSION: prototype-named models must hit the unknown-model contract.
    //
    // `costUsd` looks up an untrusted external `model` string. The hellgate run
    // originally caught a silent-NaN bug: a plain-object `TABLE` resolved
    // `TABLE["constructor"]` / `["toString"]` / `["__proto__"]` etc. to INHERITED
    // Object.prototype members (not undefined), the `=== undefined` guard missed,
    // and `price.inPerM` was undefined → NaN, violating "Unknown model ⇒ null".
    //
    // Fixed structurally: TABLE is now a null-prototype object (no inherited
    // members) plus an explicit `Object.hasOwn` guard at the call site. These
    // keys must therefore return `null`, exactly like any other unknown model.
    const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];
    for (const key of PROTO_KEYS) {
        test(`prototype-key "${key}" → null (unknown model, never NaN)`, () => {
            const r = costUsd(key, 1000, 1000);
            expect(r).toBeNull();
        });
    }
    test("known model + zero tokens → 0 (not null, not NaN)", () => {
        const r = costUsd("gpt-4o", 0, 0);
        expect(r).toBe(0);
        expect(Number.isNaN(r)).toBe(false);
    });
});
/* ------------------------------------------------------------------ */
/* 4. huge token counts — no float overflow / wrong cost               */
/* ------------------------------------------------------------------ */
describe("G3 huge token counts stay finite + correct", () => {
    test("1e12 (trillion) input tokens → finite, exact multiple of the rate", () => {
        // 1e12 input @ $2.5/1M = 2.5e12 / 1e6 = 2_500_000 USD.
        const r = costUsd("gpt-4o", 1_000_000_000_000, 0);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBe(2_500_000);
    });
    test("near MAX_SAFE_INTEGER tokens → finite (no Infinity), monotonic", () => {
        const big = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
        const r = costUsd("claude-opus-4-7", big, big);
        expect(Number.isFinite(r)).toBe(true);
        expect(Number.isNaN(r)).toBe(false);
        expect(r).toBeGreaterThan(0);
        // Monotonic: doubling output never lowers the cost.
        const r2 = costUsd("claude-opus-4-7", big, big * 2);
        expect(r2).toBeGreaterThanOrEqual(r);
    });
    test("huge cacheRead does not overflow and is priced at the cache rate", () => {
        // OpenAI carve-out clamps cached to input (0 here), so a cacheRead with no
        // matching prompt_tokens contributes nothing — no overflow, no NaN.
        const clamped = costUsd("gpt-4o", 0, 0, 1_000_000_000_000);
        expect(Number.isFinite(clamped)).toBe(true);
        expect(clamped).toBe(0); // cached clamped to input(0); nothing to re-price
        // With matching prompt_tokens the 1e12 cached tokens price at $1.25/1M.
        const priced = costUsd("gpt-4o", 1_000_000_000_000, 0, 1_000_000_000_000);
        expect(Number.isFinite(priced)).toBe(true);
        expect(priced).toBe(1_250_000); // 1e12 @ $1.25/1M cache rate
    });
    test("Infinity / NaN token inputs do not silently produce a bogus finite cost", () => {
        // These are programmer-error inputs; the contract we assert is that the
        // result is NOT a misleading finite number for a KNOWN model. With IEEE-754
        // arithmetic, Infinity*rate = Infinity and NaN*rate = NaN — both are
        // non-finite, so a downstream check can detect them rather than trusting a
        // wrong dollar figure.
        expect(Number.isFinite(costUsd("gpt-4o", Number.POSITIVE_INFINITY, 0))).toBe(false);
        expect(Number.isNaN(costUsd("gpt-4o", Number.NaN, 0))).toBe(true);
    });
});
/* ------------------------------------------------------------------ */
/* 5. ordering / monotonicity invariants                               */
/* ------------------------------------------------------------------ */
describe("G3 cost ordering invariants", () => {
    test("output tokens are at least as expensive as the same input tokens (every model)", () => {
        for (const m of [
            "gpt-4o",
            "gpt-4o-mini",
            "claude-opus-4-7",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ]) {
            const inOnly = costUsd(m, 500_000, 0);
            const outOnly = costUsd(m, 0, 500_000);
            expect(outOnly).toBeGreaterThanOrEqual(inOnly);
        }
    });
    test("cost is strictly increasing in each token axis for opus", () => {
        const a = costUsd("claude-opus-4-7", 1000, 1000);
        const b = costUsd("claude-opus-4-7", 2000, 1000);
        const c = costUsd("claude-opus-4-7", 2000, 2000);
        expect(b).toBeGreaterThan(a);
        expect(c).toBeGreaterThan(b);
    });
});
