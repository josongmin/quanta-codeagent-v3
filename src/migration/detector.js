/**
 * External-agent detector (ADR-0038, Cluster D Feature 4).
 *
 * Strict marker-based detection — a provider directory is reported only
 * when ALL of its required marker files exist. No "maybe-claude" heuristics.
 * Unknown directories are NOT reported as `provider: unknown` from the
 * detector; the `unknown` provider in the type exists only so a caller
 * that intentionally probes a hand-supplied path can surface an unknown-
 * provider result. The directory scan reports only confirmed providers.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
/** Provider contracts. Marker lists are the ANDed set of files that MUST
 *  exist for a positive detection. */
const PROVIDER_CONTRACTS = Object.freeze([
    // Claude Code: home dir auth + projects index.
    {
        provider: "claude_code",
        rootSubdir: ".claude",
        markers: [".claude/auth.json", ".claude/projects"],
    },
    // Cursor: per-project but writes a home dir marker for global config.
    {
        provider: "cursor",
        rootSubdir: ".cursor",
        markers: [".cursor/sessions.json"],
    },
    // Aider: writes a per-user history file under `~/.aider/`.
    {
        provider: "aider",
        rootSubdir: ".aider",
        markers: [".aider/history.json"],
    },
]);
/** Check existence of a single path. Returns boolean — does NOT swallow
 *  unexpected errors. */
const exists = async (path) => {
    try {
        await access(path);
        return true;
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return false;
        throw err;
    }
};
/** Scan a home directory for known external-agent installations.
 *  Returns ONLY providers that pass the strict marker check. Unknown
 *  providers (directories that look agent-shaped but lack our markers)
 *  are NOT included — they are caller-driven via the `unknown` enum. */
export const detectExternalAgents = async (homeDir) => {
    const detected = [];
    for (const contract of PROVIDER_CONTRACTS) {
        const root = join(homeDir, contract.rootSubdir);
        if (!(await exists(root)))
            continue;
        let allMarkersPresent = true;
        for (const marker of contract.markers) {
            if (!(await exists(join(homeDir, marker)))) {
                allMarkersPresent = false;
                break;
            }
        }
        if (!allMarkersPresent)
            continue;
        detected.push({
            provider: contract.provider,
            root,
            markers: contract.markers.map((m) => join(homeDir, m)),
        });
    }
    return detected;
};
/** Expose contracts for tests so the suite can assert the marker list
 *  matches the production contract without re-declaring it. */
export const detectorContracts = () => PROVIDER_CONTRACTS;
