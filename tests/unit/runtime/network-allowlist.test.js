import { describe, expect, test } from "bun:test";
import { CI_BOT_DEFAULT_ALLOWLIST, denialReason, isHostAllowed, } from "@/../src/runtime/network-allowlist";
describe("isHostAllowed — exact host match", () => {
    const allowlist = ["api.github.com", "registry.npmjs.org"];
    test("exact match (URL)", () => {
        expect(isHostAllowed("https://api.github.com/repos/x/y", allowlist)).toBe(true);
    });
    test("exact match (bare host)", () => {
        expect(isHostAllowed("api.github.com", allowlist)).toBe(true);
    });
    test("non-listed host denied", () => {
        expect(isHostAllowed("https://evil.example.com/exfil", allowlist)).toBe(false);
    });
    test("scheme-stripped match (case-insensitive)", () => {
        expect(isHostAllowed("HTTPS://API.GITHUB.COM/x", allowlist)).toBe(true);
    });
    test("subdomain NOT allowed by exact entry", () => {
        expect(isHostAllowed("https://sub.api.github.com/x", allowlist)).toBe(false);
    });
});
describe("isHostAllowed — wildcard suffix", () => {
    const allowlist = ["*.githubusercontent.com"];
    test("subdomain matches wildcard", () => {
        expect(isHostAllowed("https://raw.githubusercontent.com/x", allowlist)).toBe(true);
        expect(isHostAllowed("https://objects.githubusercontent.com/x", allowlist)).toBe(true);
    });
    test("bare apex NOT matched by wildcard (audit R2: strict subdomains only)", () => {
        // `*.githubusercontent.com` matches subdomains but NOT the bare apex —
        // matching the apex would broaden the allowlist beyond intent. To permit
        // the apex too, it must be listed explicitly.
        expect(isHostAllowed("githubusercontent.com", allowlist)).toBe(false);
    });
    test("non-matching suffix denied", () => {
        expect(isHostAllowed("https://example.com/x", allowlist)).toBe(false);
    });
});
describe("isHostAllowed — edge cases", () => {
    test("empty allowlist denies everything", () => {
        expect(isHostAllowed("https://api.github.com/x", [])).toBe(false);
    });
    test("empty input denied", () => {
        expect(isHostAllowed("", ["api.github.com"])).toBe(false);
    });
    test("unparseable URL denied", () => {
        expect(isHostAllowed("http://", ["api.github.com"])).toBe(false);
    });
});
describe("CI_BOT_DEFAULT_ALLOWLIST", () => {
    test("contains api.github.com and npm registry", () => {
        expect(CI_BOT_DEFAULT_ALLOWLIST).toContain("api.github.com");
        expect(CI_BOT_DEFAULT_ALLOWLIST).toContain("registry.npmjs.org");
    });
    test("frozen (no operator-side mutation)", () => {
        expect(Object.isFrozen(CI_BOT_DEFAULT_ALLOWLIST)).toBe(true);
    });
    test("a typical CI install (npm registry) is allowed", () => {
        expect(isHostAllowed("https://registry.npmjs.org/foo", CI_BOT_DEFAULT_ALLOWLIST)).toBe(true);
    });
    test("an exfil-shaped URL is denied", () => {
        expect(isHostAllowed("https://attacker.example.org/collect?k=…", CI_BOT_DEFAULT_ALLOWLIST)).toBe(false);
    });
});
describe("denialReason — diagnostic surface", () => {
    test("includes the host and allowlist size", () => {
        const msg = denialReason("https://evil.example.com/x", ["api.github.com"]);
        expect(msg).toContain("evil.example.com");
        expect(msg).toContain("size=1");
    });
    test("unparseable input is reported as <unparseable>", () => {
        const msg = denialReason("not-a-url", []);
        expect(msg).toContain("not-a-url"); // bareHost branch keeps it
    });
});
