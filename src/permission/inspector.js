/**
 * Permission inspector (ADR-0046 follow-up).
 *
 * Read-only programmatic surface for visualizing the permission stack. The
 * eventual `quanta permission inspect <action>` CLI / Tauri dashboard wraps
 * this seam — but the inspector itself is IO-free beyond the store reads it
 * delegates and has no side effects. Safe to call from any thread / from
 * tests / from a UI render loop.
 *
 * Why a dedicated inspector instead of exposing the store API directly:
 *   1. Stable contract: the store's internal map shape (`Record<key, value>`)
 *      can evolve (e.g. switch to a typed branded key) without breaking
 *      downstream UIs.
 *   2. Decision-explanation: `explainResolution` returns the SAME precedence
 *      verdict as `evaluateStack` plus a structured `source` label so a UI
 *      can highlight which axis fired. Keeps a single SSOT for "why".
 *   3. Map (not Record) at the boundary: a `ReadonlyMap` carries iteration
 *      order + a stable `.size`, both useful for dashboards.
 *
 * Cross-refs:
 *   - ADR-0026 — admissibility-gate SSOT (the stack is consulted there)
 *   - ADR-0029 — reviewer 3-tier (post-denial sits AFTER reviewer denies)
 *   - ADR-0030 — mid-turn steering (UI surface this inspector feeds)
 *   - ADR-0047 — HITL 4-tier gate (orthogonal but composes via `runAdmissibilityGate`)
 */
import { hostAllowsMutation } from "./per-host-mode";
import { threadAllowsMutation } from "./per-thread-store";
import { computeActionSignature, } from "./permission-store";
/**
 * Build an inspector bound to a store. The composition root (apps/*) must
 * pass an explicit store; tests pass an isolated store.
 *
 * The returned inspector is stateless — every method reads the store at
 * call time, so a UI poll loop sees fresh data without rebuilding the
 * inspector.
 */
export const getPermissionInspector = (opts) => {
    const store = opts.store;
    const listThreadPermissions = () => store.listThreads();
    const listHostModes = () => store.listHosts();
    const listPostDenialOverrides = (threadId) => store.listThreadDenials(threadId);
    /** Per-thread axis. Returns null when no per-thread record exists for the
     *  given threadId — the caller falls through to the next axis. */
    const explainThread = (action, actionSignature) => {
        if (action.threadId === undefined)
            return null;
        const tp = store.getThread(action.threadId);
        if (tp === undefined)
            return null;
        const verb = threadAllowsMutation(tp, action.workdir) ? "permits" : "refuses";
        return {
            outcome: verb === "permits" ? "allow" : "deny",
            source: "per-thread",
            reason: `Per-thread policy (${tp.sandboxPolicy.type}) ${verb} ${action.tool} on ${action.workdir}`,
            actionSignature,
        };
    };
    /** Per-host axis. Returns null when no host record exists OR the host
     *  signals `custom` (defer to next axis). */
    const explainHost = (action, actionSignature) => {
        if (action.hostId === undefined)
            return null;
        const hm = store.getHost(action.hostId);
        const verdict = hostAllowsMutation(hm);
        if (verdict === undefined)
            return null;
        const verb = verdict ? "permits" : "refuses";
        return {
            outcome: verdict ? "allow" : "deny",
            source: "per-host",
            reason: `Per-host mode (${hm}) ${verb} ${action.tool} on host ${action.hostId}`,
            actionSignature,
        };
    };
    /** Mirror of `evaluateStack`'s precedence but surface the WHY, not just the
     *  WHAT. Order MUST match `policy.ts::evaluateStack` so the explanation is
     *  observationally identical to what the gate will decide.
     *
     *  HARD_DENY is intentionally NOT modeled here — the inspector is purely
     *  about the stack axes. A caller needing the HARD_DENY verdict composes
     *  `hardDenyReason` separately. */
    const explainResolution = (action) => {
        const actionSignature = computeActionSignature({
            tool: action.tool,
            workdir: action.workdir,
            args: action.args,
        });
        if (action.isReadOnly === true) {
            return {
                outcome: "allow",
                source: "read-only-bypass",
                reason: "Read-only action bypasses the permission stack",
                actionSignature,
            };
        }
        if (action.threadId !== undefined &&
            store.hasPostDenialOverride(action.threadId, actionSignature)) {
            return {
                outcome: "allow",
                source: "post-denial-override",
                reason: `Post-denial override active for thread ${action.threadId}`,
                actionSignature,
            };
        }
        const fromThread = explainThread(action, actionSignature);
        if (fromThread !== null)
            return fromThread;
        const fromHost = explainHost(action, actionSignature);
        if (fromHost !== null)
            return fromHost;
        // Fall-through ⇒ defer to global default. We can't replay it without a
        // `PermissionContext` here, so we surface "ask" with a descriptive
        // source — UI uses that to render "fallback to mode policy".
        return {
            outcome: "ask",
            source: "global-default",
            reason: "No stack axis decided; defer to mode-policy",
            actionSignature,
        };
    };
    return {
        listThreadPermissions,
        listHostModes,
        listPostDenialOverrides,
        explainResolution,
    };
};
