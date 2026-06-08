export const meta = {
  name: 'longtail-sota',
  description: 'Implement the 25-longtail backlog (PARTIAL+NEW, ~27 items) in collision-safe lanes — SOTA++, default-OFF, e2e hellgates — then adversarial verify',
  phases: [
    { title: 'Implement', detail: '10 collision-safe subsystem lanes' },
    { title: 'Verify', detail: 'independent adversarial skeptics per lane' },
  ],
}

const IMPL = {
  type: 'object',
  additionalProperties: false,
  required: ['lane', 'items', 'shipped', 'filesChanged', 'testsAdded', 'testResult', 'knobsAdded', 'manifestAdded', 'deviations', 'selfReview'],
  properties: {
    lane: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'note'], properties: { id: { type: 'string', description: 'e.g. §8.1' }, status: { type: 'string', enum: ['done', 'v1', 'deferred', 'already-done', 'na'] }, note: { type: 'string' } } } },
    shipped: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'isNew', 'what'], properties: { path: { type: 'string' }, isNew: { type: 'boolean' }, what: { type: 'string' } } } },
    testsAdded: { type: 'array', items: { type: 'string', description: 'test file path + whether it is an e2e hellgate' } },
    testResult: { type: 'string', description: 'exact bun test counts + the command' },
    knobsAdded: { type: 'array', items: { type: 'string', description: 'QUANTA_* knobs you read in src + WHERE you registered them (knob-inventory.ts/cli-knobs.ts) — for the orchestrator to reconcile clobbers' } },
    manifestAdded: { type: 'array', items: { type: 'string', description: 'new tool names you added to manifest.ts (only the NEW-TOOLS lane should have any)' } },
    deviations: { type: 'string' },
    selfReview: { type: 'string', description: 'adversarial self-check + what you did NOT verify; physical evidence over claims' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['lane', 'compiles', 'testsPass', 'e2ePresent', 'defaultOff', 'realBugsFound', 'verdict'],
  properties: {
    lane: { type: 'string' },
    compiles: { type: 'string' },
    testsPass: { type: 'string' },
    e2ePresent: { type: 'string', description: 'is there a real e2e/integration hellgate (not just unit) per the user requirement? cite the file + what it drives' },
    defaultOff: { type: 'string', description: 'default-OFF byte-identity — verified how (actual check, not a comment)' },
    realBugsFound: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'where', 'what', 'evidence'], properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, where: { type: 'string' }, what: { type: 'string' }, evidence: { type: 'string' } } } },
    verdict: { type: 'string', enum: ['closed', 'minor-residual', 'broken'] },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . Source under src/ . You implement on the MAIN tree, SHARED with sibling lanes. Touch ONLY your FILE OWNERSHIP; RE-READ any shared registry file (knob-inventory.ts, cli-knobs.ts, runtime-config.ts) immediately before editing and APPEND (the tree moves). The audit doc paths are jun-08 and the tree has MOVED — RE-VERIFY every seam against the LIVE tree (notably: src/mention-injection and src/git/churn paths drifted; find the real ones).

SOURCE SPEC: docs/tickets/misc-jun-7/25-longtail-audit.md has each item's current-state(file:line), competitor mechanism, and work estimate. READ your items there.

DISCIPLINE (hard): TDD red-first. default-OFF byte-identity (new field/knob/tool, gate absent => behavior BYTE-IDENTICAL — include an explicit byte-identity test). The user REQUIRES an e2e / integration hellgate per feature (drive the real seam end-to-end, not just a unit shape test) — include at least one. red-on-injection where a security/correctness invariant exists. NO-THROW boundaries. New knob => register in src/config/knob-inventory.ts (host-gate) or src/apps/cli/cli-knobs.ts (CLI-read) AND read via @/shared gateOn/gateOnStrict — report it under knobsAdded so the orchestrator reconciles any clobber. New @/ slice => tsconfig.base path + slice-fence. SOTA++: match the competitor mechanism the audit cites (Codex/Cursor/Claude-Code corpus in .extracted_source/), clean architecture (pure cores, injected clocks, structural decoupling), not just the baseline.

MANIFEST: do NOT edit src/tool/surface/manifest.ts unless you are the NEW-TOOLS lane — adding a model-facing tool elsewhere collides. If your item extends an EXISTING tool's schema, that's fine (no new manifest row).

For HIGH/subsystem items (OS-daemon, marketplace, memory-ranking): ship a SOLID, TESTED, default-OFF V1 CORE + explicitly DEFER depth — NEVER leave the build broken. Report status 'v1' + what's deferred.

VERIFY: run ONLY your slice's tests (\`bun test <files>\`). Do NOT run full-repo tsc (siblings mid-edit). Self-review honestly — last session impl agents self-reported "green" while real tsc proved broken; OBSERVE effects, don't claim. Return the structured report.`

phase('Implement')

const LANES = [
  { label: 'L1:session', lane: 'SESSION meta + crash-resume', items: '§8.1 turn_context 6 fields (developer_instructions/dynamic_tools/service_tier/model_provider/approvals_reviewer/base_instructions) · §8.2 session_meta fields (agent_nickname/dynamic_tools/originator/thread_source/model_provider) · §8.3 dynamic_tools session record · §13.1 corrupt-store AGGREGATE detect + operator recovery guidance · §13.2 PERSISTED interrupted-turn marker (crash resume — jun-08 is in-memory ONLY; persist to session store + detect/offer on restart)',
    own: 'src/session/envelope.ts, src/session/types.ts, src/session/store.ts, src/agent/interrupted-turn.ts (+ capture wiring), tests under tests/unit/session/ + tests/integration/. CROWN JEWEL §13.2: a real e2e hellgate simulating crash mid-turn (persist marker) -> restart -> detect + offer resume.' },
  { label: 'L2:llm-obs', lane: 'LLM ratelimit + preset + OTLP', items: '§9.3 account DUAL-WINDOW ratelimit (used_percent/window_minutes per-account accumulation over per-request header parse) · §9.6 opusplan-style sticky preset + Anthropic Message Batches API (V1: preset + batches client core, default-OFF) · §12.7 otelHeadersHelper dynamic OTLP (getHeaders():Promise callback port for OAuth token refresh vs static headers)',
    own: 'src/llm/ratelimit-snapshot/, src/llm/ (preset + batches client), src/observability/otel-exporter.ts, tests under tests/unit/llm/ + tests/unit/observability/. e2e: 2nd request accumulates the dual-window; a dynamic-header refresh.' },
  { label: 'L3:rules-mentions-tree', lane: 'rules argv + mentions folder/git + 3-tree', items: '§10.2 rules ARGV-ARRAY matching (pattern=[...] token-array vs string-prefix) · §10.3 mentions @folder / @git kinds + resolver (find the REAL mention-injection path; ADR-0418 supersede note) · §10.4 file-tree 3-TREE (cwd + gitRoot + userHome parallel scan, each capped — env-context probeRepoMap currently cwd-only)',
    own: 'src/rules/, the real mention-injection slice, src/agent/env-context.ts, tests. e2e: a rule with an argv-array matches; @folder resolves; 3 trees probed with caps.' },
  { label: 'L4:git', lane: 'git 3-way dirty checkout', items: '§7.4 branch-switch 3-WAY dirty action (commit-wip | stash | discard) — currently autoWip OR reject. Add input dirtyAction + stash/discard flows. EXTENDS the existing branch_switch tool (NO new manifest row).',
    own: 'src/tool/git/branch-switch.ts (+ any git stash/discard helper), tests under tests/unit/. e2e: dirty tree -> each of the 3 actions through the real tool.' },
  { label: 'L5:new-tools', lane: 'NEW model-facing tools (SOLE manifest writer)', items: '§5.4 gh PR code-tour (src/tool/gh/ EXISTS — add a PR diff guided-tour tool) · §7.3 CI-investigation FINDING tool (structured CiFinding record vs prose) · §7.2 co-change/related-files tool (co-occurrence matrix from git history; find the real churn path + build the matrix) · §6.5 listVoices (realtime/port.ts has none — add a voices query; tool ONLY if model-facing, else a documented port method). You are the ONLY lane editing src/tool/surface/manifest.ts — add ALL new GATED entries here (each its own QUANTA_* gate, default-OFF). Register knobs in knob-inventory.',
    own: 'src/tool/gh/, NEW tool dir(s), src/realtime/port.ts + impl, src/tool/surface/manifest.ts (ALL new rows), gate wiring (agent/features.ts or tier1 + agent-config-assembler if host-gated), tests. e2e: each new tool dispatched through the real registry; manifest drift guard green.' },
  { label: 'L6:image', lane: 'image_gen plural ref + aspectRatio', items: '§5.2 image_gen — port ImageGenRequest.referenceImages is ALREADY plural; the INPUT SCHEMA is singular referenceImagePath + no aspectRatio. Change input schema to referenceImagePaths:string[] + aspectRatio enum + buildRequest plural handling. EXTENDS the existing image_gen tool (NO new manifest row). Nearly done — verify the port is plural, fix the schema.',
    own: 'src/tool/image-gen/tool.ts + schema, tests. e2e: multi-ref + aspectRatio through the real image_gen tool (mock the gen port).' },
  { label: 'L7:subagent', lane: 'typed agent kind + side-agent daemon V1', items: '§4.4 TYPED agent kind (subagent/types.ts free-string agentType -> SubagentType enum + boundary validation, default-OFF/back-compat: unknown string still accepted via a typed-or-string union) · §4.3 side-agent OS-DAEMON V1 (registry.ts is in-process; audit wants child_process.fork + socket IPC + supervised respawn — HIGH. Ship default-OFF V1: a process-fork port abstraction + basic supervised lifecycle behind a gate, NOT full launchctl/systemd. DEFER OS-daemon-manager depth.)',
    own: 'src/subagent/types.ts (+ consumers), src/side-agent/, tests. e2e: enum validation round-trip; a forked side-agent process spawns + is supervised (V1, mock the OS layer).' },
  { label: 'L8:plugin-skill-connector', lane: 'plugin/skill flags + connector marketplace V1', items: '§2.3 skill allow_implicit_invocation policy flag · §2.4 plugin manifest hooks/apps pointer fields + loader · §2.5 marketplace.json install/auth POLICY gating · §1.6 connector MARKETPLACE V1 (catalog is flat; audit wants DirectoryApp lifecycle/installUrl — ship default-OFF V1: schema + install/lifecycle core, DEFER full marketplace UI/registry).',
    own: 'src/plugin*/ (plugin manifest schema + loader), src/skill/ (implicit flag), src/connectors/, tests. e2e: a plugin manifest with hooks/apps loads; a skill implicit-invocation policy gates; a connector install lifecycle V1.' },
  { label: 'L9:memory', lane: 'memory routing meta + recall weighting V1', items: '§10.6 memory routing meta (memory/types.ts flat -> add taskGroup/appliesTo/reuseRule fields + recall WEIGHTING — HIGH, ranking surgery). Ship default-OFF V1: optional meta fields + a weighting hook in recall that is byte-identical when meta absent. DEFER deep ranking-model changes.',
    own: 'src/memory/, tests. e2e: a memory with routing meta is recall-weighted; absent meta -> byte-identical ranking.' },
  { label: 'L10:config-misc', lane: 'config knobs + compaction salvage + win-shell', items: '§12.6 exclude_tmpdir sandbox toggle (config knob excluding /tmp from sandbox) · §13.3 compaction DROP-OLDEST salvage (fail-fast on overflow -> drop oldest + retry vs abort — find the real compaction path: src/agent/compaction.ts or src/runner/assemble/compaction.ts) · P16 Windows shell guard (runtime/shell.ts hardcodes ["bash","-lc"] with NO win32 branch -> silent fail; add process.platform==="win32" guard + explicit error/cmd fallback — NOT a full Windows port, just stop the silent failure).',
    own: 'src/agent/compaction.ts (or runner/assemble/compaction.ts — whichever has the overflow fail-fast), src/runtime/shell.ts, src/runtime/os-sandbox/ (exclude_tmpdir), knob registration, tests. e2e: overflow -> salvage retry; win32 shell guard returns a typed error not silent fail.' },
]

const impl = await parallel(LANES.map((L) => () => agent(
  `${COMMON}\n\n=== YOUR LANE: ${L.lane} ===\nITEMS: ${L.items}\n\nFILE OWNERSHIP: ${L.own}\n\nImplement every item (or a tested default-OFF V1 for HIGH ones). Each gets an e2e/integration hellgate. Report per-item status.`,
  { label: L.label, phase: 'Implement', schema: IMPL })))

phase('Verify')
const VBRIEF = (L) => `${COMMON}

=== ADVERSARIAL VERIFY — lane "${L.lane}" ===
You are the INDEPENDENT skeptic — TRUST NOTHING the implementer reported. RE-READ the diff, RUN real commands (\`bun run typecheck\` filtered to these files ignoring unrelated user-sprint files; \`bun test <lane test files>\`), and try to BREAK it.
Owned files: ${L.own}
Check + cite evidence: (1) compiles (no error in THESE files). (2) tests pass — exact counts. (3) e2ePresent — is there a REAL e2e/integration hellgate driving the seam end-to-end (the user required it), not just a unit shape test? Name it. (4) defaultOff — with the new knob/field/tool absent, is behavior byte-identical? Verify by ACTUALLY checking, not reading a comment. (5) realBugsFound — any genuine defect (no-throw violation, default-OFF break, missing knob registration -> run the knob-completeness ratchet, fabricated/empty test, unhandled edge). Severity + file:line + the command output proving it. Only REAL defects. Return the verdict.`

const verdicts = await parallel(LANES.map((L) => () => agent(VBRIEF(L), { label: `verify:${L.label.split(':')[0]}`, phase: 'Verify', schema: VERDICT, agentType: 'Explore' })))

return { implemented: impl.filter(Boolean), verdicts: verdicts.filter(Boolean) }
