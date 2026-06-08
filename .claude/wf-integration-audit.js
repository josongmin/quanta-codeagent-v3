export const meta = {
  name: 'integration-audit-3round',
  description: '3-round parallel adversarial audit of the last 3 days: knob/config/fc/cli/tool-manifest/wiring INTEGRATION completeness (built-but-not-wired hunt)',
  phases: [
    { title: 'Round1', detail: '6 axis auditors — broad sweep + run ratchets' },
    { title: 'Round2', detail: 're-verify R1 + deeper adversarial lens' },
    { title: 'Round3', detail: 'false-positive cull + completeness critic' },
  ],
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['axis', 'round', 'ratchetsRun', 'newGaps', 'priorVerified', 'cleanClaim'],
  properties: {
    axis: { type: 'string' },
    round: { type: 'number' },
    ratchetsRun: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['test', 'result'], properties: { test: { type: 'string' }, result: { type: 'string', description: 'pass/fail + counts, OBSERVED from running it' } } } },
    newGaps: { type: 'array', description: 'REAL integration gaps found THIS round (built-but-not-wired). Empty if none.', items: { type: 'object', additionalProperties: false, required: ['severity', 'artifact', 'gap', 'evidence'], properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, artifact: { type: 'string', description: 'the knob/tool/slice/cmd + file:line' }, gap: { type: 'string', description: 'what integration is missing (declared-not-read / read-not-declared / fc-missing / unregistered / dead-export / gates-nothing / unthreaded)' }, evidence: { type: 'string', description: 'the grep/test/command output proving it — not a guess' } } } },
    priorVerified: { type: 'array', description: 'each prior-round gap you re-checked', items: { type: 'object', additionalProperties: false, required: ['gap', 'verdict', 'evidence'], properties: { gap: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed-real', 'false-positive', 'fixed-since', 'wontfix-intentional'] }, evidence: { type: 'string' } } } },
    cleanClaim: { type: 'string', description: 'what you verified IS fully integrated, with the evidence (ratchet green + end-to-end wiring traced)' },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . READ-ONLY audit. SCOPE = the last 3 DAYS of work (run \`git log --since="3 days ago" --name-only --pretty=format:\` to enumerate touched files). The concern: across heavy parallel sprints (NEW cluster 16-24, IMPROVE 11-15, the 25-longtail ~27 items), did anything land BUILT-BUT-NOT-WIRED — i.e., the slice/knob/tool/cmd exists but is not integrated end-to-end?

INTEGRATION FAILURE MODES to hunt (your axis below narrows this):
- knob: declared in knob-inventory.ts/cli-knobs.ts but NEVER read in src (dead knob); OR read but NOT declared (orphan — the completeness ratchet catches this, RUN it); OR read+declared but the read-site is in a module NOTHING imports (the gate flips nothing — ratchets MISS this, you must trace the importer).
- config: a runtime-config / runtime-config-knobs field added but not threaded to a consumer; web-daemon CONFIG_ALLOWED_KEYS drift; a config option read nowhere or written nowhere.
- fc (feature-catalog at tools/feature-catalog/features/): a NEW feature/tool/slice from the 3-day work MISSING an fc entry; or an fc entry whose reachability/evidence is broken. RUN feature-catalog-audit/reachability/evidence-existence/lint tests.
- cli: a slash command built but NOT registered in BUILTINS / not in help-render; a CLI flag/env capability not surfaced; cli-feature-gates-drift.
- tool/manifest: a new tool in manifest but NOT actually built into the registry (buildDefaultTools/tier1/features.ts) so unreachable; or registry tool missing a manifest row (drift guard). RUN tool-surface-manifest-hellgate.
- wiring/dead-code: a new slice/export with NO live importer; a port method with no caller; a default-OFF V1 core (connector-marketplace, message-batches, side-agent-process, memory-routing, crash-resume, store-health) that is NOT instantiated/reached at any composition root even when its gate is ON.

KEY 3-DAY ARTIFACTS (anchors — verify each is wired, derive the rest from git): tools browser_element_bounds/highlight/browser_tab_*, /agents //init //background slash, mcp-server subcommand, worktree enter/exit/status, header-rules, /model, statusLine+color-palettes, crash-resume, store-health, dual-window ratelimit, OTLP dynamic headers, message-batches, opusplan preset, rules argv-array, @folder/@git mentions, 3-tree, branch_switch dirtyAction, gh_pr_code_tour, git_co_change, ci_finding, listVoices, image aspectRatio, typed agentType, side-agent process daemon, plugin hooks/apps, skill allow_implicit, marketplace-policy, connector-marketplace, memory routing meta, exclude_tmpdir, compaction drop-oldest salvage, win-shell guard. Knobs: QUANTA_CRASH_RESUME/MEMORY_ROUTING/SIDE_AGENT_PROCESS/SUBAGENT_TYPED_KIND/PLUGIN_POINTERS/SKILL_IMPLICIT_POLICY/MARKETPLACE_POLICY/CONNECTOR_MARKETPLACE/MENTION_FOLDER/MENTION_GIT/GH_CODE_TOUR/CI_FINDING/GIT_CO_CHANGE/SANDBOX_EXCLUDE_TMPDIR/WIN_SHELL/BROWSER_TABS/BROWSER_BOUNDS/BROWSER_HIGHLIGHT/INIT_SLASH/BG_TURN/WORKTREE_TOOL/REASONING_SUMMARY/REASONING_VERBOSITY + more.

METHOD: RUN the codified ratchet/guard tests for your axis (cite pass/fail). Then go BEYOND them — trace end-to-end wiring with grep (does the knob's read-site live in a module that the composition root actually imports? is the new tool in buildDefaultTools/tier1? is the fc entry's reachability real?). A finding must have COMMAND-OUTPUT evidence, not a guess. Distinguish a REAL gap from an INTENTIONAL default-OFF/V1-deferred (the latter is wontfix unless the gate-ON path is also broken). Be precise: file:line + the grep/test that proves it.`

let prior = []
const AXES = [
  { id: 'knob', focus: 'KNOB integrity. Run knob-registry-completeness-ratchet + knob-registry-disjoint + bench-knob ratchets. Then for EVERY 3-day knob: confirm declared (knob-inventory.ts OR cli-knobs.ts) AND read in src AND the read-site module is imported by a live composition root (not a dead module). Flag declared-not-read, read-not-declared, and read-in-dead-module.' },
  { id: 'config', focus: 'CONFIG threading. runtime-config.ts / runtime-config-knobs.ts new fields → traced to a consumer? web-daemon CONFIG_ALLOWED_KEYS in sync? Any 3-day config option written-but-never-read or read-but-never-set. Run runtime-config + web-daemon config tests.' },
  { id: 'fc', focus: 'FEATURE-CATALOG completeness. Run feature-catalog-audit + feature-catalog-reachability + feature-catalog-evidence-existence + feature-catalog-lint + feature-catalog-schema. Then: does EVERY 3-day new feature/tool/slice have an fc entry under tools/feature-catalog/features/? Any new capability missing from fc? Any fc entry whose cited evidence/reachability path is stale.' },
  { id: 'cli', focus: 'CLI surfacing. Run slash-commands (BUILTINS) + cli-feature-gates-drift + help-render tests. Then: every 3-day slash command (/agents //init //background //model …) registered in the right registry + in BUILTINS + listed by /help? Every new CLI flag/env reachable? Any built-but-unregistered cmd or help-render drift.' },
  { id: 'tool-manifest', focus: 'TOOL reachability. Run tool-surface-manifest-hellgate (two-way drift). Then for EVERY 3-day new tool (browser_*, worktree_*, gh_pr_code_tour, git_co_change, ci_finding, mcp_server): is it ACTUALLY built into the registry (buildDefaultTools / agent/features.ts / tier1 block / a maybeWireX slot) such that the agent can call it when its gate is ON? A manifest row with no registry build = unreachable. Trace gate → assembler → registry.' },
  { id: 'wiring', focus: 'WIRING / dead-code. For EVERY 3-day NEW slice/module (crash-resume, store-health, dual-window, message-batches, opusplan-preset, connector-marketplace, marketplace-policy, side-agent process daemon, memory-routing, mention @folder/@git resolver, 3-tree probe, ci_finding, co-change, etc.): grep for a LIVE importer/caller at a composition root or feature path. A new export that nothing imports = dead. A V1 core gated default-OFF must STILL be instantiated/reached when its gate is ON (trace the gate-ON path). Distinguish dead-code from intentional-dormant (e.g. §8.1 envelope fields were KNOWINGLY deferred — note as intentional, but confirm it IS the deferred one).' },
]

phase('Round1')
const r1 = await parallel(AXES.map((a) => () => agent(
  `${COMMON}\n\n=== AXIS: ${a.id} (ROUND 1 — broad sweep) ===\n${a.focus}\n\nThis is round 1: enumerate + run ratchets + find gaps. priorVerified will be empty.`,
  { label: `r1:${a.id}`, phase: 'Round1', schema: SCHEMA, agentType: 'Explore' })))
prior = r1.filter(Boolean)

phase('Round2')
const priorJson2 = JSON.stringify(prior.flatMap((p) => (p.newGaps || []).map((g) => ({ axis: p.axis, ...g }))))
const r2 = await parallel(AXES.map((a) => () => agent(
  `${COMMON}\n\n=== AXIS: ${a.id} (ROUND 2 — adversarial re-check + deeper) ===\n${a.focus}\n\nROUND 1 findings (ALL axes) to RE-VERIFY (confirm real / false-positive / intentional) in priorVerified: ${priorJson2}\n\nThen find NEW gaps round 1 MISSED — use a DIFFERENT lens: cross-axis (a knob declared+read but its module is never imported; a tool in manifest+registry but its gate is never set by any assembler; an fc entry pointing at a moved file). Be adversarial about round 1's cleanClaim — try to break it.`,
  { label: `r2:${a.id}`, phase: 'Round2', schema: SCHEMA, agentType: 'Explore' })))
prior = [...prior, ...r2.filter(Boolean)]

phase('Round3')
const priorJson3 = JSON.stringify(prior.flatMap((p) => (p.newGaps || []).map((g) => ({ round: p.round, axis: p.axis, ...g }))))
const r3 = await parallel(AXES.map((a) => () => agent(
  `${COMMON}\n\n=== AXIS: ${a.id} (ROUND 3 — false-positive cull + completeness critic) ===\n${a.focus}\n\nALL gaps from rounds 1-2: ${priorJson3}\n\nROUND 3 job: (1) CULL false positives — re-run/grep each gap in your axis and mark confirmed-real vs false-positive vs intentional-deferred, with command evidence. (2) COMPLETENESS CRITIC — what did rounds 1-2 NOT check in your axis? (a knob/tool/slice not in the anchor list; an integration edge nobody traced). Find any last real gap. Return only DURABLE conclusions.`,
  { label: `r3:${a.id}`, phase: 'Round3', schema: SCHEMA, agentType: 'Explore' })))

return { round1: r1.filter(Boolean), round2: r2.filter(Boolean), round3: r3.filter(Boolean) }
