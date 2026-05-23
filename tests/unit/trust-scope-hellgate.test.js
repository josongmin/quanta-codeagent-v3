/**
 * ★ CONTRACT — B6: ADR-0050 5-tier TrustScope (always_allow / project /
 *   workspace / session / once_only / deny) as 2D space×time matrix.
 *   src/permission/trust-scope.ts: once_only consumed exactly once (first hit
 *   admits, second re-prompts); grants never leak across projectKey/tool/
 *   actionKey; deny is sticky and never reported as a positive grant.
 *
 * HELLGATE — trust-scope race / double-consume / cross-scope leak proofs (B6).
 *
 * Security invariants under attack:
 *
 *  1. once_only is consumed EXACTLY once. A first hit allows (no consume left),
 *     the immediate second hit re-prompts (consumed), and a THIRD hit also
 *     re-prompts — no resurrection of a spent grant.
 *
 *  2. Space × time isolation: a grant seeded under one projectKey MUST NOT
 *     satisfy a lookup under a DIFFERENT projectKey (the registry partitions
 *     by key). A `session`-scoped grant for project A cannot authorize a
 *     `project`-scoped check for a different project path; a `workspace` grant
 *     does not leak across workspaces. We assert the full 2D matrix.
 *
 *  3. A `deny`-scoped record is sticky and is NEVER reported as a positive
 *     grant — even when a positive grant for the same key co-exists, hasGrant
 *     must not flip a deny into an allow via the wire-up's positive-only path.
 *
 * Source under test: src/permission/trust-scope.ts
 * (createInMemoryTrustScopeRegistry). The gate wire-up only ever calls
 * hasGrant; these tests exercise that exact contract.
 */
import { describe, expect, test } from "bun:test";
import { createInMemoryTrustScopeRegistry, } from "@/permission";
const reg = () => createInMemoryTrustScopeRegistry();
describe("HELLGATE B6 — once_only is consumed EXACTLY once (no double-spend)", () => {
    test("first hit allows; second AND third hits re-prompt (grant gone for good)", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "once_only" });
        // 1st: present ⇒ true, consumed inline.
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true);
        // 2nd: consumed ⇒ false (re-prompt).
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(false);
        // 3rd: still false (no resurrection).
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(false);
    });
    test("two stacked once_only grants are consumed independently (one per hit)", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "once_only" });
        r.grant("p1", { tool: "fs_write", scope: "once_only" });
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true); // spend #1
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true); // spend #2
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(false); // exhausted
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(false);
    });
    test("explicit consume() after a hit cannot remove a grant twice", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "once_only" });
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true); // inline-consumed
        // A redundant manual consume must be a no-op, not corrupt state / throw.
        expect(() => r.consume("p1", { tool: "fs_write" })).not.toThrow();
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(false);
    });
    test("a durable always_allow grant is NOT consumed (re-usable across hits)", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "always_allow" });
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true);
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true);
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true);
    });
});
describe("HELLGATE B6 — space × time isolation matrix (no cross-key leak)", () => {
    // Time axis = scope literal; space axis = projectKey. A grant in one cell
    // must never satisfy a lookup in a different space cell.
    const positiveScopes = [
        "always_allow",
        "project",
        "workspace",
        "session",
        "once_only",
    ];
    for (const scope of positiveScopes) {
        test(`'${scope}' grant for projectKey 'A' does NOT satisfy projectKey 'B'`, () => {
            const r = reg();
            r.grant("project-A", { tool: "bash", scope });
            // Same tool, DIFFERENT project space ⇒ must be isolated.
            expect(r.hasGrant("project-B", { tool: "bash" })).toBe(false);
            // The grant is still intact for its OWN key (proves the false above is
            // isolation, not accidental consumption).
            expect(r.hasGrant("project-A", { tool: "bash" })).toBe(true);
        });
    }
    test("session grant for project A cannot authorize a different project path", () => {
        const r = reg();
        r.grant("/abs/project-A", { tool: "fs_write", scope: "session" });
        expect(r.hasGrant("/abs/project-B", { tool: "fs_write" })).toBe(false);
        expect(r.hasGrant("/abs/project-A/sub", { tool: "fs_write" })).toBe(false);
    });
    test("workspace grant does not leak across workspaces (distinct keys)", () => {
        const r = reg();
        r.grant("ws-1", { tool: "bash", scope: "workspace" });
        expect(r.hasGrant("ws-2", { tool: "bash" })).toBe(false);
        expect(r.hasGrant("ws-1", { tool: "bash" })).toBe(true);
    });
    test("tool-axis isolation: a grant for tool X does not authorize tool Y", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "always_allow" });
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
        expect(r.hasGrant("p1", { tool: "fs_write" })).toBe(true);
    });
    test("actionKey-pinned grant does not authorize a different actionKey", () => {
        const r = reg();
        r.grant("p1", { tool: "fs_write", scope: "always_allow", actionKey: "fs_write:/repo/a.ts" });
        // A different path under the same tool must NOT match the pinned key.
        expect(r.hasGrant("p1", { tool: "fs_write", actionKey: "fs_write:/repo/b.ts" })).toBe(false);
        // Exact key matches.
        expect(r.hasGrant("p1", { tool: "fs_write", actionKey: "fs_write:/repo/a.ts" })).toBe(true);
    });
    test("once_only consumed in project A leaves project B with NO grant (never created)", () => {
        const r = reg();
        r.grant("project-A", { tool: "bash", scope: "once_only" });
        expect(r.hasGrant("project-A", { tool: "bash" })).toBe(true); // consume A
        // B never had a grant; consuming A must not have created one for B.
        expect(r.hasGrant("project-B", { tool: "bash" })).toBe(false);
        expect(r.hasGrant("project-A", { tool: "bash" })).toBe(false); // A exhausted
    });
});
describe("HELLGATE B6 — deny scope is sticky and never reported as a positive grant", () => {
    test("a lone 'deny' grant is NEVER a positive grant (hasGrant=false)", () => {
        const r = reg();
        r.grant("p1", { tool: "bash", scope: "deny" });
        // The wire-up only treats hasGrant=true as ask-skip; deny must read false
        // so it routes to the explicit deny path, never an implicit allow.
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
        // Repeated reads stay false (deny is sticky, not consumed).
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
    });
    test("deny grant remains inert even after a once_only positive grant is spent", () => {
        const r = reg();
        r.grant("p1", { tool: "bash", scope: "deny" });
        r.grant("p1", { tool: "bash", scope: "once_only" });
        // First hit: the once_only positive grant is found + consumed ⇒ true.
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(true);
        // Once the positive grant is spent, only the deny remains ⇒ false.
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
        expect(r.hasGrant("p1", { tool: "bash" })).toBe(false);
    });
});
