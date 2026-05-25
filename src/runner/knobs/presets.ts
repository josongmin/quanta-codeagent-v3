/**
 * Named presets — convenience bundles of knob values, applied as the
 * LOWEST-priority overlay above defaults.
 *
 * The contents are intentionally simple (string -> string) so the resolver
 * can treat them identically to env vars / config-file entries.
 */

export const KNOB_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  baseline: {},
  "agentless-full": {
    "issue-hint": "agentless",
    "branch-search": "3",
    "repro-test": "5",
  },
  "hint-only": { "issue-hint": "1" },
  everything: {
    lsp: "1",
    subagent: "1",
    skills: "1",
    "localize-phase": "3",
    "branch-search": "3",
    "issue-hint": "agentless",
    "repro-test": "5",
  },
}
