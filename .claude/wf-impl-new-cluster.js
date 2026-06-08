export const meta = {
  name: 'impl-new-cluster',
  description: 'Implement NEW cluster tickets 16,17,19,20,21,22,23,24 in 5 collision-safe parallel lanes (TDD red-first, default-OFF, slick UX)',
  phases: [{ title: 'Implement', detail: '5 parallel lanes; MCP lane serial internally' }],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'summary', 'filesChanged', 'testsAdded', 'testResult', 'gate', 'uiuxDelivered', 'deviations', 'followups', 'selfReview'],
  properties: {
    ticket: { type: 'string' },
    summary: { type: 'string', description: 'what was built, 2-3 sentences' },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'isNew', 'what'],
        properties: { path: { type: 'string' }, isNew: { type: 'boolean' }, what: { type: 'string' } },
      },
    },
    testsAdded: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'scenarios'],
        properties: { path: { type: 'string' }, scenarios: { type: 'array', items: { type: 'string' } } },
      },
    },
    testResult: { type: 'string', description: 'exact bun test pass/fail counts for the slice tests you ran, + the command used' },
    gate: { type: 'string' },
    uiuxDelivered: { type: 'array', items: { type: 'string' }, description: 'the slick UX/architecture enhancements actually implemented (not just functional baseline)' },
    deviations: { type: 'string', description: 'anything done differently from the brief + why; "none" if faithful' },
    followups: { type: 'string', description: 'remaining work as (feature)+(why)+(ROI); "none" if complete' },
    selfReview: { type: 'string', description: 'adversarial self-check: default-OFF byte-identity verified? red-on-injection test present? slice-fence clean? no-throw? Be concrete.' },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . Source under src/ . You are implementing on the MAIN working tree, SHARED with sibling agents running concurrently in other lanes.

⛔ FILE OWNERSHIP IS ABSOLUTE: touch ONLY the files in your "FILE OWNERSHIP" list below. Other agents own every other file — editing outside your list will clobber their concurrent work. If you believe you need a file outside your list, do NOT edit it; record it under deviations/followups instead.

DISCIPLINE (hard rules, from CLAUDE.md):
- TDD red-first: write the failing test(s) FIRST, watch them fail for the right reason, then implement to green.
- default-OFF byte-identity: a new gate/slice/field, when its gate is absent/off, must leave existing behavior BYTE-IDENTICAL. Include an explicit byte-identity test.
- red-on-injection: include at least one test that FAILS if the security/correctness invariant is removed (e.g. assert a denied tool is absent, assert no raw breakout, assert the wire field reached the body).
- Gate vocab via @/shared: use gateOn(env,'X') (loose 1/on/true) for normal gates; gateOnStrict(env,'X') (=== '1') for SECURITY-critical gates.
- New slice ⇒ tsconfig.base.json path + slice-fence; but if you stay inside an EXISTING mapped slice (e.g. src/apps/cli, src/mcp, src/llm, src/browser, src/tool) you need NO tsconfig change. Most of these tickets stay in-slice.
- NO-THROW tool/command contract: wrap I/O in try/catch, return a numeric/Result failure, never let a throw escape.
- Honor the DRIFT CORRECTIONS below — the original ticket's line numbers/symbols were verified stale; use the corrected ones.
- Deliver the UX/ARCHITECTURE enhancements, not just the functional baseline. The user explicitly wants slick ("기깔나는") UX + clean architecture.

VERIFY: run ONLY your slice's tests with \`bun test <your test files>\` to confirm red→green. Do NOT run full-repo \`bunx tsc\` — sibling lanes are mid-edit and it will show unrelated transient errors. Self-review type correctness carefully; the orchestrator runs the authoritative full typecheck after all lanes land. If bun test surfaces a type/import error in YOUR files, fix it.

Return the structured report. Be honest in selfReview — list what you did NOT verify.`

phase('Implement')

// ─────────────────────────────────────────────────────────────────────────────
// LANE 1 — SLASH (tickets 16 /init + 17 /agents), one agent owns the slash surface
// ─────────────────────────────────────────────────────────────────────────────
const SLASH_BRIEF = `${COMMON}

=== LANE: SLASH SURFACE — implement BOTH ticket 16 (/init) and ticket 17 (/agents) ===
You own the slash-command surface. Do 17 first (smaller, lower-risk), then 16.

FILE OWNERSHIP (touch ONLY these):
- NEW  src/apps/cli/agents-fleet-panel.ts        (ticket 17 pure renderer)
- NEW  src/apps/cli/init-scaffold.ts             (ticket 16 pure renderer + cmd)
- EDIT src/apps/cli/slash/registry-surface.ts    (add agentsCmd + initCmd to buildSurfaceSlashCommands array ~775-822 AND SURFACE_SLASH_COMMANDS ~830)
- EDIT src/apps/cli/slash-contract.ts            (add SlashContext slots)
- EDIT src/apps/cli/repl/slash-surface.ts        (ReplSlashCtx slot ~55 + BuildReplSlashCtxArgs + buildReplSlashCtx ~376 + projectLegacySlots ~447)
- EDIT src/apps/cli/repl/surface-compose.ts      (pass taskRegistry into buildReplSlashCtx call ~930; instance = setup.lifecycleTaskRegistry already in hand at ~1164)
- NEW  tests/unit/cli/agents-fleet-panel.test.ts
- NEW  tests/unit/apps/cli/agents-slash-wire-hellgate.test.ts
- NEW  tests/unit/cli/init-scaffold.test.ts
- EDIT tests/unit/slash-commands.test.ts         (ONLY if its BUILTINS count/order pins break — update the pins; you are the sole slash-command adder this wave)
- EDIT src/skill/system-skills/init/SKILL.md     (OPTIONAL: one line noting the deterministic /init slash; only if trivial)

──── TICKET 17 /agents (live fleet view) — gate: NONE (presence-gated like /branches,/state) ────
DRIFT (verified): TaskRegistry has NO getById() — use get(id). list():TaskRecord[] at src/subagent/registry.ts:107. TaskRecord{id,description,agentType?,status:'running'|'completed'|'failed'|'stopped',result?,error?,startedAt:number,endedAt?:number}. SubagentResult{ok,finalText,turns,messages?} — NO durationMs; derive age from startedAt/endedAt. The registry instance is ALREADY wired: setup.lifecycleTaskRegistry (surface-compose.ts:1164). @/ui/ui-helpers exports bold/dim/red/green/yellow/magenta/cyan/gray/renderBox (theme-aware, auto-strips). Slot must be added to BOTH ReplSlashCtx (slash-surface.ts:55) AND SlashContext (slash-contract.ts:8) via projectLegacySlots.
SPEC:
1. agents-fleet-panel.ts: define a LOCAL \`export interface AgentFleetRow { id; description; agentType?; status; startedAt:number; endedAt?:number; result?:{ok:boolean;finalText:string;turns:number}; error?:string }\` (structural mirror — do NOT import @/subagent VALUES; the registry-surface fence forbids @/subagent value imports). Export \`renderAgentFleet(rows: readonly AgentFleetRow[], opts:{format:'table'|'json'|'tree'; now:number; all?:boolean}): string\`. PURE — no clock, no I/O. Age via a small formatAge(ms)->'12s'/'3m'/'1h'. table=aligned cols ID/Status/Type/Age/Result(finalText first line, 50-char ellipsis, +turns badge e.g. '(3t)'); json=stable JSON.stringify; tree=group by agentType. Colors via @/ui/ui-helpers: running=cyan, completed=green, failed=red, stopped=dim/yellow.
2. slash-contract.ts: add \`readonly agents?: (() => readonly AgentFleetRow[]) | undefined\` (type-only import of AgentFleetRow).
3. slash-surface.ts: add \`agents\` to ReplSlashCtx; add \`taskRegistry?: import('@/subagent').TaskRegistry\` to BuildReplSlashCtxArgs; in buildReplSlashCtx add \`...(taskRegistry!==undefined ? { agents: () => taskRegistry.list().map(toRow) } : {})\` (toRow maps TaskRecord->AgentFleetRow); add agents to projectLegacySlots.
4. registry-surface.ts: agentsCmd (model on branchesCmd:402/stateCmd:374). Parse --format <t> (default table) + --all; unknown format => err exit 1; ctx.agents undefined => print 'not wired in this surface' exit 0; else ctx.out(renderAgentFleet(ctx.agents(), {format, now: ctx.now?.()??Date.now(), all})).
5. surface-compose.ts: pass \`taskRegistry: setup.lifecycleTaskRegistry\` into the buildReplSlashCtx call ~930.
UIUX TO DELIVER: status glyph+word (● running / ✓ completed / ✗ failed / ⊘ stopped); sort running-first then settled by endedAt desc; humanized right-aligned age computed from injected now (live); footer 'N running · M done · K failed'; HONEST LRU note — --all means 'don't collapse settled', it CANNOT resurrect LRU-evicted records (gone from the Map); renderBox bordered 'Agent fleet' panel matching /state; renderer stays pure (color decided by @/ui layer, never TTY-detect inside).
TDD: tests/unit/cli/agents-fleet-panel.test.ts — 3 formats; injected now => deterministic age (FAILS if renderer reads real clock); 50-char truncation; empty '(no agents)'+hint; color-off strip; status->color map. tests/unit/apps/cli/agents-slash-wire-hellgate.test.ts — BUILTINS contains /agents; DEFAULT-OFF byte-identity (ctx without agents slot => exact 'not wired' line + exit 0); RED-ON-INJECTION (composeSurfaceWires stub with 2 tasks => ctx.agents() returns 2 rows; FAILS if surface-compose wire drops taskRegistry); unknown --format => exit 1.

──── TICKET 16 /init (CLAUDE.md scaffold) — gate: QUANTA_INIT_SLASH (it WRITES to cwd, default-OFF) ────
DRIFT (verified): an /init SKILL already exists (src/skill/system-skills/init/SKILL.md) and a registered /init SLASH will SHADOW it via dispatchReplSlash precedence — keep the skill as the rich/LLM path; have the slash print a pointer. SlashContext has NO interactive confirm/prompt seam — slash cmds are one-shot. So NO Y/N prompt: implement --force-only (exists+no-force => refuse+exit1) PLUS a --dry-run preview (prints scaffold to stdout, writes nothing). makeRepoMapScan(deps:{shell}) at src/runner/assemble/repo-map-scan.ts:73 is NOT cached — /init re-runs its own scan; truncateRepoMap + REPO_MAP_TRUNCATION_MARKER are reusable. loadRepoRules candidates order = ['AGENTS.md','CLAUDE.md',...] — prefer AGENTS.md when neither exists (multi-vendor).
SPEC:
1. init-scaffold.ts: (a) PURE \`scaffoldClaudeMd(cwd, opts?:{repoMap?;buildCmd?;testCmd?;...}): string\` — fixed section order: '# <basename(cwd)>' / '## Quick Start' / '## Directory' (the already-truncated repoMap verbatim) / '## Key Files' / '## Conventions'. NO clock/fs in this fn (deterministic golden). Bracket the auto-generated sections with a sentinel marker (e.g. '<!-- quanta:auto:start -->' / '<!-- quanta:auto:end -->') so a future --force can regenerate ONLY marked blocks and preserve hand-written Conventions (surgical, not destructive). (b) \`detectCommands(cwd)\` — read package.json scripts conservatively (map build/test/typecheck/lint keys to '<pm> run <key>', pm from lockfile bun.lockb/pnpm-lock/package-lock); no package.json => probe Makefile then Justfile; return undefined per-command when unsure (never invent). (c) \`scanRepoMap(cwd, shell)\` via makeRepoMapScan — best-effort, undefined on failure. (d) \`buildInitCmd(deps?):SlashCommand\` name '/init', parse --force/--dry-run; target = AGENTS.md if exists else CLAUDE.md; --dry-run => ctx.out(scaffold) write nothing exit 0; exists && !force => ctx.err('<file> exists (<size>, N sections). Re-run with --force to overwrite — human-edited sections will be lost. Or use --dry-run to preview, or ask "refresh CLAUDE.md" for the richer skill path.') exit 1; else write + ctx.out(green '✓ wrote <path>' + 3-bullet summary: path, commands detected, file count) exit 0. NO-THROW.
2. registry-surface.ts: register \`...(gateOn(process.env,'QUANTA_INIT_SLASH') ? [buildInitCmd({shell:<node child_process-backed>})] : [])\`. The @/runner+@/tool imports live in init-scaffold.ts (apps/cli level — allowed), NOT in registry-surface.ts.
UIUX TO DELIVER: --dry-run preview as the real answer to the missing confirm seam; helpful exists-refusal showing file size+section count+exact re-run cmd+skill pointer; AGENTS.md preference; surgical sentinel markers; green ✓ on write / yellow ⚠ on refuse via @/ui helpers; 3-bullet success summary mirroring the skill.
TDD: tests/unit/cli/init-scaffold.test.ts — scaffoldClaudeMd golden (deterministic, section order, no clock leak); repoMap-with-marker rides through verbatim; detectCommands conservative (test script set / build undefined / Makefile fallback / empty repo all-undefined); exists->refuse exit1 + file bytes UNCHANGED; --force overwrite; --dry-run writes nothing; write-failure NO-THROW; DEFAULT-OFF byte-identity (QUANTA_INIT_SLASH unset => '/init' absent from BUILTINS, skill still owns it). Mock shell as the RepoMapShell duck type with canned \`rg --files\` stdout.

After both: run \`bun test tests/unit/cli/agents-fleet-panel.test.ts tests/unit/cli/init-scaffold.test.ts tests/unit/apps/cli/agents-slash-wire-hellgate.test.ts tests/unit/slash-commands.test.ts\`.`

// ─────────────────────────────────────────────────────────────────────────────
// LANE 2 — MCP (19 reverse-MCP, then 20+22), serial within lane (mcp/index.ts barrel)
// ─────────────────────────────────────────────────────────────────────────────
const T19_BRIEF = `${COMMON}

=== LANE: MCP / step 1 — TICKET 19 reverse-MCP (quanta as an MCP server) — gate: QUANTA_MCP_SERVER via gateOnStrict (=== '1', SECURITY/RCE surface) ===
SECURITY-CRITICAL. An external client calling quanta 'bash' = RCE. Default whitelist = READ-ONLY tools only; per-tool explicit opt-in; tools/call NEVER bypasses dispatchTool().

FILE OWNERSHIP (touch ONLY these):
- NEW  src/mcp/server.ts
- NEW  src/mcp/server-builder.ts
- NEW  src/apps/cli/mcp-server-setup.ts
- EDIT src/mcp/index.ts            (add server exports — append; sibling MCP step 2 edits this AFTER you, serially)
- EDIT src/apps/cli/index.ts       (add process.argv[2]==='mcp-server' route, mirror the 'batch' route ~157)
- NEW  src/mcp/__tests__/server.test.ts
- NEW  src/mcp/__tests__/server-builder.test.ts
- NEW  src/apps/cli/__tests__/mcp-server-setup.hellgate.test.ts
⛔ Do NOT touch src/tool/surface/manifest.ts — adding a GATED_TOOLS row for mcp_server would BREAK the drift guard (mcp_server is a CLI subcommand, not an LLM tool). The manifest's role here is read-only: ToolRisk==='read-only' is the whitelist SSOT, consumed via the injected port — you do not edit it.

DRIFT (verified): Transport reuse is ONLY at the codec level — src/mcp/jsonrpc.ts encodeMessage(:34)/LineReader(:71)/isValidEnvelope(:50)/isResponse(:115) are direction-agnostic. StdioMcpTransport/HttpSseMcpTransport are CLIENT-shaped (spawn/connect outward) — NOT reusable as a server listener; the server owns its OWN process.stdin/stdout pump over encodeMessage+LineReader. client.ts:1039 dispatch / :1113 handleInboundRequest / :1136 -32601 is the inverse pattern to mirror. protocol-version.ts resolveOfferedVersion + SUPPORTED_PROTOCOL_VERSIONS = shared negotiation SSOT (reuse, don't duplicate). The @/mcp slice fence FORBIDS @/mcp importing @/agent or @/tool — so McpServer/server-builder take DUCK-TYPED injected ports; the adapter that binds real dispatchTool+registry lives in src/apps/cli/mcp-server-setup.ts (the ONLY place @/agent+@/mcp meet). Reuse targets at the composition root: src/agent/dispatch.ts:532 dispatchTool(call,config,permission) runs the FULL locked pipeline (permission/HARD_DENY/HITL/jail/redactSecrets — :1328) no-throw; src/host/runtime/agent-arg-builder.ts:1338 buildBaseFromArgs assembles config+permission; src/apps/cli/batch-cmd.ts is the composition-root template (no-throw numeric exit, injected IO seam, EXIT_USAGE 64/FAILURE 1/OK 0); src/tool/registry.ts:67 specs()=>{name,description,input_schema} + :39 isReadOnly(name).
SPEC:
1. server.ts McpServer: ctor { toolList:ToolListSource, toolCall:ToolCallPort, write:(line)=>void, readOnlyPolicy } — all injected/duck-typed, NO @/agent import. A LineReader + handle(msg) dispatcher = INVERSE of client.dispatch (only inbound requests+notifications expected). Router: 'initialize' => reply {protocolVersion: resolveOfferedVersion(...), serverInfo:{name:'quanta',version}, capabilities:{tools:{listChanged:false}}}; 'notifications/initialized' => no reply; 'tools/list' => paginate the read-only-whitelisted tools (server-mint cursor, guard against cursor loop like client.listTools), reply {tools,nextCursor?}; 'tools/call' => validate params {name:string, arguments?:object} else -32602; reject name not in whitelist => -32602 'tool not exposed: <name> is <risk>-risk; only read-only tools are exposed by default — opt in per-tool via QUANTA_MCP_SERVER_EXPOSE'; else await toolCall(name,args) => map to {content:[{type:'text',text}], isError} with a LOCAL MAX_RESULT_CHARS cap (keep the cap local — do NOT import @/tool); any throw => -32603. Unknown method => -32601.
2. server-builder.ts buildMcpServer(opts): whitelist = { tools where toolList.readOnly(name)===true } ∪ opts.explicitOptIn (default empty). PURE — this tiny function IS the security boundary; 100% unit-testable. Returns new McpServer.
3. mcp/index.ts: export { McpServer } from './server'; export { buildMcpServer, type ToolListSource, type ToolCallPort, type McpServerOptions } from './server-builder'. APPEND only.
4. mcp-server-setup.ts runMcpServerCmd(argv, io?): if !gateOnStrict(process.env,'QUANTA_MCP_SERVER') => stderr 'reverse MCP server disabled (set QUANTA_MCP_SERVER=1)' exit 64. --help => usage exit 0 (no config assembly). Else dynamic-import @/host/runtime (buildBaseFromArgs/parseAgentArgs/toAssembleRequest) + @/agent (dispatchTool); assemble headless AgentConfig+PermissionContext; ToolListSource over config.registry.specs()+isReadOnly; ToolCallPort=(name,args)=>dispatchTool({name,id:mintId(),input:args},config,permission) folded to text; QUANTA_MCP_SERVER_EXPOSE=comma-list parsed+each VALIDATED against registry (unknown => stderr warn, never silently widen); buildMcpServer({write:(s)=>process.stdout.write(s),...}); pump process.stdin chunks => server.lineReader; resolve on stdin 'end'/SIGINT; exit 0. STDERR banner on start ('quanta MCP server · N read-only tools exposed'); NEVER write non-JSON-RPC to stdout (it's the protocol channel).
5. apps/cli/index.ts: add the mcp-server argv route mirroring batch (dynamic import, AbortController, SIGINT/SIGTERM, --help short-circuit, process.exit(await runMcpServerCmd(...))).
UIUX TO DELIVER: tools/list descriptions prefixed '[quanta · read-only]' + risk class; -32602 errors name WHY + remediation; stderr start banner (stdout stays pure JSON-RPC); QUANTA_MCP_SERVER_EXPOSE per-tool opt-in with registry validation; protocol-version SSOT reuse.
TDD (red-first): server.test.ts (slice-local) — initialize replies SUPPORTED version+serverInfo+capabilities; tools/list returns ONLY read-only (inject fake toolList where 'bash' readOnly:false => ABSENT); pagination cursor round-trips + never loops; empty whitelist => {tools:[]}; tools/call on NON-whitelisted => -32602 AND toolCall spy invoked 0 times (proves no bypass); whitelisted => toolCall once, folded result; malformed params => -32602; toolCall throws => -32603 (pump survives); unknown method => -32601; >MAX_RESULT_CHARS truncated. server-builder.test.ts — whitelist = read-only ∪ explicitOptIn; mutating tool in explicitOptIn appears, default build EXCLUDES it. mcp-server-setup.hellgate.test.ts (CLI-importing => src/apps/cli/__tests__) — DEFAULT-OFF: QUANTA_MCP_SERVER unset => exit 64, nothing assembled, stdout empty; with =1 + injected stdin script (initialize->tools/list->tools/call read tool) => round-trip over in-memory pump, assert 'bash'/'write' ABSENT from tools/list and tools/call 'bash' => -32602 (RCE-deny default); SECURITY red-on-injection: a would-mutate call denied by whitelist AND, if force-opted-in, still hits the permission gate (surfaces as isError, not a raw write).
After: \`bun test src/mcp/__tests__/server.test.ts src/mcp/__tests__/server-builder.test.ts src/apps/cli/__tests__/mcp-server-setup.hellgate.test.ts\`.`

const T20_22_BRIEF = `${COMMON}

=== LANE: MCP / step 2 — TICKET 20 (resources templates + completion) AND TICKET 22 (elicitation url variant) ===
This runs AFTER step 1 (reverse-MCP) finished editing src/mcp/index.ts — so you append to that barrel without racing. Both tickets are client/protocol slices, both default-OFF.

FILE OWNERSHIP (touch ONLY these):
ticket 20:
- EDIT src/mcp/resources/port.ts
- EDIT src/mcp/resources/codec.ts
- EDIT src/mcp/resources/index.ts
- EDIT src/mcp/client.ts            (add accessors + listResourceTemplates + complete)
- NEW  tests/unit/mcp-templates-completion-hellgate.test.ts
ticket 22:
- EDIT src/mcp/elicitation/schemas.ts
- EDIT src/mcp/elicitation/port.ts
- EDIT src/mcp/elicitation/inbound-router.ts
- EDIT src/mcp/elicitation/default-cli-prompter.ts
- EDIT src/mcp/elicitation/headless-rejecter.ts
- EDIT src/mcp/elicitation/lease.ts
- EDIT src/mcp/elicitation/index.ts
- NEW  tests/unit/mcp/elicitation-url-headless.test.ts
- EDIT tests/unit/mcp/elicitation-hellgate.test.ts
- EDIT tests/unit/mcp-elicitation-inbound-hellgate.test.ts
shared:
- EDIT src/mcp/index.ts             (append ticket-20 template/completion exports AND ticket-22 url exports — you are the sole writer now)

──── TICKET 20 — gate: NONE (client-internal; dead unless a server advertises the capability => byte-identical otherwise) ────
DRIFT (verified, CRITICAL): completion/complete is OUTBOUND (client→server, gated on SERVER 'completions' capability) — NOT inbound. Do NOT touch inbound-router.ts / handleInboundRequest / capabilities/* / full-negotiator for completion. It folds through the existing typedRequest core (client.ts:850). The key template field is uriTemplate (RFC 6570), NOT 'uri'. parseResourceList at codec.ts:46 (cap PARSE_MAX_LIST_ENTRIES=4096, helpers asRecord/str/withOptionalStrings reusable). Keep ticket 20 CLIENT-INTERNAL (no model tool, no supervisor/aggregate mirror — defer that).
SPEC:
1. port.ts: add \`McpResourceTemplate{ readonly uriTemplate:string; name?; description?; mimeType? }\`; \`McpCompletionRef = {type:'ref/prompt';name} | {type:'ref/resource';uri}\`; \`McpCompletionArgument{name;value}\`; \`McpCompletionResult{ readonly values:ReadonlyArray<string>; total?; hasMore? }\`.
2. codec.ts: \`parseResourceTemplateList(result)\` — key 'resourceTemplates', drop entries lacking string uriTemplate, reuse withOptionalStrings, cap at PARSE_MAX_LIST_ENTRIES. \`parseCompletionResult(result)\` — navigate result.completion.{values[]filtered-to-strings(capped, default []), total?, hasMore?}; EMPTY values:[] is VALID (not null); completion-not-object => null.
3. resources/index.ts + mcp/index.ts: export the 4 types + 2 parsers.
4. client.ts: \`serverSupportsCompletions(){ const c=this.serverCapabilities; return c!==null && asRecord(c.completions)!==null }\`; \`async listResourceTemplates(): Promise<McpResult<McpResourceTemplate[]>>{ if(!this.serverSupportsResources()) return unsupported('resources',this.config.name); return this.typedRequest('resources/templates/list',{},parseResourceTemplateList) }\`; \`async complete(ref,argument){ if(!this.serverSupportsCompletions()) return unsupported('completions',this.config.name); return this.typedRequest('completion/complete',{ref,argument},parseCompletionResult) }\`. Add imports from './resources'.
UIUX: discriminated-union ref ({type:'ref/prompt'}|{type:'ref/resource'}) for type-safe branching; refuse LOCALLY with the typed 'unsupported' failure (no -32601 round-trip leaking to model); empty-completion is first-class OK; carry total/hasMore for future 'showing 10 of 240'.
TDD: tests/unit/mcp-templates-completion-hellgate.test.ts — clone FakeTransport from tests/unit/mcp-resources-prompts-roots-hellgate.test.ts. (1) templates round-trip w/ uriTemplate; (2) completion values+total/hasMore; (3) malformed template dropped / all-malformed => ok empty; (4) malformed completion => reason 'malformed' no throw; (5) EMPTY values:[] => ok (NOT malformed); (6) RED-ON-INJECTION: no completions cap => complete()===unsupported AND transport.sent has NO 'completion/complete' frame (refused locally); same for templates w/o resources cap; (7) DEFAULT-OFF byte-identity: neither cap => initialize + listTools outbound bytes IDENTICAL to baseline.

──── TICKET 22 — gate: NONE (TTY-gated via buildCliElicitationPrompterFactory; headless => headlessRejecter). Security: restrict scheme to http/https. ────
DRIFT (verified): schemas.ts has 7 *RequestSchema spanning lines 25-77 (string25/number34/integer42/boolean50/enum56/multiSelect63/singleSelect72) using {prompt:z.string().min(1), title:z.string().min(1).optional(), ...}. inbound-router has TWO switches — the INTERNAL port-method \`switch(sub)\` is at line 178 (add 'case promptUrl' HERE); the SPEC-path \`switch(prop.type)\` at 130 — do NOT wire spec format:'uri'=>promptUrl (no concrete url in an elicitation/create request to confirm; decline/fallback is already correct). MANDATORY files the ticket omitted: lease.ts forContext (~109-126) must add the 8th coalesce arm or the interface is unsatisfied (TS error); elicitation/index.ts + mcp/index.ts barrels must re-export urlRequestSchema+UrlRequest (hellgates import from '@/mcp'). System-open idiom to MIRROR (not import the private fn): src/auth/chatgpt-oauth/browser-flow.ts:46 openBrowserDefault — darwin 'open' / win32 'cmd /c start' / else 'xdg-open', spawn detached+unref+catch-swallow; inject the opener as a seam (mirror runBrowserFlow's opener?:(url)=>void test-seam).
SPEC:
1. schemas.ts: \`urlRequestSchema = z.object({prompt:z.string().min(1), title:z.string().min(1).optional(), url:z.string().refine(v=>{try{const u=new URL(v); return u.protocol==='http:'||u.protocol==='https:'}catch{return false}}, {message:'invalid url (http/https only)'})})\` — SECURITY: reject file:/javascript:/data:. \`type UrlRequest = z.infer<...>\`; \`validateUrl\` mirroring validateString.
2. port.ts: add \`promptUrl(req:UrlRequest, signal?):Promise<ElicitationResult<string>>\` to ElicitationPrompter.
3. headless-rejecter.ts: \`promptUrl: async () => deny<string>()\`.
4. default-cli-prompter.ts: change cliPrompter signature to \`cliPrompter(io, opener:(url:string)=>void = defaultOpener)\` where defaultOpener mirrors browser-flow.ts:46. promptUrl: render the FULL url on its own line then 'Open in browser? (y/n): '; withRetry+validateBoolean; yes => opener(url) (try/catch) then {ok:true,value:url}; no/abort => {ok:false,reason:'cancelled'}.
5. lease.ts: add promptUrl coalesce arm to forContext.
6. inbound-router.ts: \`case 'promptUrl': { const r=urlRequestSchema.safeParse(params); return r.success ? toResponse(await prompter.promptUrl(r.data,signal),null) : DECLINE }\` at switch ~178.
7. elicitation/index.ts + mcp/index.ts: export urlRequestSchema+UrlRequest.
UIUX: result is ElicitationResult<string> value=opened url (keeps {action:'accept',content:{value}} symmetric); full-url-on-its-own-line (phishing safety); http/https-only scheme guard; opener as injected port (surface-model: Tauri/Web own navigation, don't hardcode 'open'); fire-and-forget detached (don't await browser).
TDD: tests/unit/mcp/elicitation-url-headless.test.ts (NEW red-first) — headlessRejecter.promptUrl => {ok:false,reason:'headless-denied'} + spawn-spy proves NO process launched. Extend tests/unit/mcp/elicitation-hellgate.test.ts — 'y'=>opener called once w/ url + {ok:true,value:url}; 'n'=>cancelled, opener NOT called; non-http url => schema rejects; abort => cancelled. Extend tests/unit/mcp-elicitation-inbound-hellgate.test.ts — inbound elicitation/promptUrl valid => accept envelope; cancelled=>cancel; headless=>decline; malformed=>decline (never throw).

After both tickets: \`bun test tests/unit/mcp-templates-completion-hellgate.test.ts tests/unit/mcp/elicitation-url-headless.test.ts tests/unit/mcp/elicitation-hellgate.test.ts tests/unit/mcp-elicitation-inbound-hellgate.test.ts\` plus the existing mcp-resources hellgate to prove no regression.`

// ─────────────────────────────────────────────────────────────────────────────
// LANE 3 — TASKS (ticket 21), isolated
// ─────────────────────────────────────────────────────────────────────────────
const T21_BRIEF = `${COMMON}

=== LANE: TASKS — TICKET 21 MCP Tasks ttl/pollInterval/relatedTaskIds — gate: NONE (capability-negotiation + optional-field omission = byte-identical) ===

FILE OWNERSHIP (touch ONLY these):
- EDIT src/mcp/tasks/types.ts          (add 3 optional fields to McpTaskInfo)
- EDIT src/mcp/tasks/client-port.ts    (extend parseInfo defensively)
- EDIT src/mcp/tasks/poller.ts         (cadence + TTL)
- EDIT src/tool/mcp_tasks/port.ts      (mirror the 3 fields onto TasksTaskInfo — LOCKSTEP)
- EDIT src/tool/mcp_tasks/list_tasks.ts
- EDIT src/tool/mcp_tasks/get_task.ts
- EDIT tests/unit/mcp/tasks-hellgate.test.ts
- EDIT tests/unit/mcp/tasks-live-binding-adversarial.test.ts
⛔ Do NOT edit src/mcp/index.ts (no new export — you only add fields to existing types). Do NOT edit manifest.ts (no new tool).

DRIFT (verified): codec parser is \`parseInfo\` (client-port.ts:56), NOT 'parseTaskInfo'. DEFAULT_INTERVAL_MS=200 is at poller.ts:11 (line 34 = pollTask fn start); pollTask reads opts.intervalMs??DEFAULT_INTERVAL_MS at :39. McpTaskInfo at types.ts:18 = {taskId,state,title?,progress?}. CRITICAL MIRROR the ticket omitted: src/tool/mcp_tasks/port.ts TasksTaskInfo (lines 15-20) is a duck-typed mirror; the mcp-bridge.ts:389 assignment is the compile-time drift guard — add the same optional fields there or they never surface in the tool render. parseInfo already uses conditional-spread (lines 65-70) so absent fields are OMITTED (byte-identity guard) — preserve that. Clock pattern: inject \`now:()=>number\` defaulting Date.now (as supervisor.ts:43 / errors.ts:312) — NO new Clock abstraction, NO heuristic threshold. pollTask has NO production consumer (test-facing seam) — low blast radius.
SPEC:
1. types.ts: add to McpTaskInfo \`readonly ttlMs?:number\`, \`readonly pollIntervalMs?:number\`, \`readonly relatedTaskIds?:ReadonlyArray<string>\` (units in the name to avoid the s-vs-ms bug class).
2. tool/mcp_tasks/port.ts: mirror the same 3 optional fields onto TasksTaskInfo.
3. client-port.ts parseInfo: add \`asFinitePositive(v)=> typeof v==='number'&&Number.isFinite(v)&&v>0 ? v : undefined\` for ttlMs (accept ttl|ttlMs) and pollIntervalMs (accept pollInterval|pollIntervalMs); \`asTaskIdList(v,selfId)\` => filter nonempty strings, drop selfId (circular guard), de-dupe, undefined when empty. Append via conditional-spread (absent stays absent).
4. poller.ts: PollOpts gains \`now?:()=>number\`; \`const now=opts.now??Date.now; const start=now()\`. Each loop after fetching info: if info.ttlMs!==undefined && now()-start>=info.ttlMs => return info (TTL expiry, return LAST observed info, NOT null — distinguishable from abort, lets model see final state+related ids). cadence = Math.max(1, info.pollIntervalMs ?? opts.intervalMs ?? DEFAULT_INTERVAL_MS) with a documented upper ceiling (so a hostile server can't busy-spin at 0 or stall for hours — robustness, commented as such); drive wait(cadence).
5. list_tasks.ts renderInfo: append \`  → rel: id1, id2\` ONLY when relatedTaskIds present (absent => byte-identical line, preserves toEqual list tests).
6. get_task.ts: surface ttl-remaining (human-relative from injected clock e.g. 'ttl: ~480ms left') / pollInterval / related links when present.
UIUX: *Ms unit-suffixed names; human-relative TTL remaining; relatedTaskIds as actionable affordance ('→ related: a, b — poll/cancel together'); terse common path (suffix only when present); cadence floor+ceiling clamp commented as security/robustness (not heuristic); circular-link guard in codec.
TDD (this slice's convention — tests/unit/mcp/, NO CLI import): (a) cadence — pollIntervalMs=50 + injected now/recording wait => sleeps 50 not 200; (b) TTL expiry — ttlMs=500 never-terminal + injected now jumping past 500 => returns last non-terminal info; (c) related carry — relatedTaskIds:['a','b'] => getInfo toEqual includes it + list shows '→ rel: a, b'; EDGE codec never-throw — pollInterval=-5/NaN/0/'50'(string)/ttl negative/NaN => omitted; relatedTaskIds w/ self-id => self dropped, non-strings dropped, []=>omitted; BYTE-IDENTITY — payload with NONE of 3 fields => parseInfo toEqual({taskId,state}) exactly (existing getInfo toEqual ~line 259 stays green); RED-ON-INJECTION — temporarily make parseInfo always set ttlMs:undefined and assert byte-identity test FAILS (confirm the guard bites), then revert.
After: \`bun test tests/unit/mcp/tasks-hellgate.test.ts tests/unit/mcp/tasks-live-binding-adversarial.test.ts\`.`

// ─────────────────────────────────────────────────────────────────────────────
// LANE 4 — LLM (ticket 23), isolated
// ─────────────────────────────────────────────────────────────────────────────
const T23_BRIEF = `${COMMON}

=== LANE: LLM — TICKET 23 reasoning summary:"auto" + verbosity + effort xhigh — gates: QUANTA_REASONING_SUMMARY (bool) + QUANTA_REASONING_VERBOSITY (enum); xhigh is a value of existing QUANTA_REASONING_EFFORT ===

FILE OWNERSHIP (touch ONLY these):
- EDIT src/llm/openai-responses-wire.ts
- EDIT src/llm/factory.ts
- EDIT src/llm/adapters/openai-responses.ts
- EDIT src/llm/adapters/chatgpt-oauth.ts
- EDIT src/llm/responses-stream.ts
- EDIT src/config/knob-inventory.ts
- EDIT src/apps/web-daemon/server.ts        (add 2 keys to CONFIG_ALLOWED_KEYS — UX hot-tuning)
- EDIT tests/unit/llm/openai-responses-wire.test.ts
- NEW  tests/unit/llm/reasoning-summary-verbosity-e2e-hellgate.test.ts

DRIFT (verified, CRITICAL): the OpenAI Responses wire shape is \`text:{verbosity}\` (TOP-LEVEL sibling of reasoning/input) — a FLAT \`verbosity\` key is silently ignored by the API. \`summary:"auto"\` co-locates INSIDE reasoning (\`reasoning:{effort, summary}\`). There are FIVE responses-surface threading points, not 4 — chatgpt-oauth.ts is a co-equal 2nd adapter that ALSO calls prepareResponsesContinuationRequest (:333) and MUST be threaded or the OAuth subscription path silently drops the knobs. Effort/verbosity/summary are read via ENV in factory.ts (NOT runtime-config.ts — only carryover lives there); mirror resolveReasoningEffort (factory.ts:226), do NOT add a runtime-config field. Verified seams: normalizeResponsesReasoningEffort (wire:285) returns effort when minimal|low|medium|high else undefined; the reasoning emission spread is at wire:343 (effort-gated); BuildResponsesBodyOptions:113; buildResponsesBody:292; fingerprintResponsesBody:354 strips only input/previous_response_id (new fields correctly bust resume fingerprint — good); CreateLLMOptions:56 (reasoningEffort:83); OpenAIResponsesConfig:16; responses-stream PrepareResponsesContinuationRequestArgs:78 (buildResponsesBody called TWICE — full :237 + resume-tail :344); knob-inventory.ts:752 QUANTA_REASONING_EFFORT entry = template.
SPEC (TDD red-first):
1. openai-responses-wire.ts: add 'xhigh' to the normalizeResponsesReasoningEffort OR-chain (:287) + update JSDoc :281-284. Add \`normalizeResponsesReasoningVerbosity(v?)=> low|medium|high lowercased else undefined\`. Add \`reasoningSummary?:boolean\` + \`reasoningVerbosity?:string\` to BuildResponsesBodyOptions. In buildResponsesBody: build \`reasoning\` iff (reasoningEffort!==undefined || reasoningSummary) => \`{ ...(effort?{effort}:{}), ...(summary?{summary:'auto'}:{}) }\` spread only when non-empty; SEPARATELY \`...(verbosity!==undefined ? { text:{verbosity} } : {})\`. CRITICAL: when both knobs absent, body is BYTE-IDENTICAL to today (effort-only spread shape unchanged). Do NOT inject a default verbosity:'medium' (leave absent => API default).
2. responses-stream.ts: add the 2 fields to PrepareResponsesContinuationRequestArgs; spread into BOTH buildResponsesBody calls (full + resume-tail) so resume fingerprint stays consistent.
3. adapters/openai-responses.ts + adapters/chatgpt-oauth.ts: add config fields + private members + ctor assignment; spread both into the prepareResponsesContinuationRequest call ONLY (body-only knobs, NOT streamResponsesSurface).
4. factory.ts: add CreateLLMOptions fields; \`resolveReasoningSummary(env)=gateOn(env,'QUANTA_REASONING_SUMMARY')\`, \`resolveReasoningVerbosity(opts,env)=opts.reasoningVerbosity ?? env.QUANTA_REASONING_VERBOSITY\`; compute+spread into BOTH the openai-responses arm (:135) AND chatgpt-oauth arm (:184).
5. knob-inventory.ts: append QUANTA_REASONING_SUMMARY (kind bool, default false) + QUANTA_REASONING_VERBOSITY (kind enum, default undefined) mirroring the EFFORT entry (group 'llm', home 'runtime-config', readSite 'llm/factory.ts') — REQUIRED by the completeness ratchet or tests go red.
6. web-daemon/server.ts: add the 2 keys to CONFIG_ALLOWED_KEYS (:308).
UIUX: wire-faithful shape (text:{verbosity} + reasoning.summary) so fields actually take effect — the highest-ROI correctness call; summary STANDALONE (gate reasoning on effort OR summary) — real observability payoff (user SEES the reasoning summary stream, wire already maps reasoning_summary_text.delta); verbosity-default honesty (emit only when opted-in); crisp knob describe strings for --help; xhigh forward-compat one-line JSDoc (opaque pass-through, normalizer stays the closed-set SSOT); body-only seam cleanliness (never pollute streamResponsesSurface).
TDD: extend tests/unit/llm/openai-responses-wire.test.ts — normalizer xhigh accepted/'XHIGH'/'ultra'->undefined; verbosity normalizer low/MEDIUM/high pass, 'verbose'->undefined; buildResponsesBody summary:true => reasoning.summary==='auto'; effort+summary => both; verbosity:'low' => text==={verbosity:'low'} AND NO flat verbosity key; DEFAULT-OFF byte-identity hellgate (buildResponsesBody(input,model,{}) deep-equals summary:false+verbosity:undefined; no text key, no reasoning key when effort also absent; snapshot legacy body JSON unchanged). NEW tests/unit/llm/reasoning-summary-verbosity-e2e-hellgate.test.ts (mirror reasoning-carryover-e2e harness) — RED-ON-INJECTION: drive prepareResponsesContinuationRequest with summary:true+verbosity:'high', capture posted body via fetch spy in streamResponsesSurface, assert reasoning.summary==='auto' + text.verbosity==='high' reached the wire on FULL + resume-tail paths; OFF case omit both => byte-identical JSON.
After: \`bun test tests/unit/llm/ tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts tests/unit/cli/knob-registry-disjoint-hellgate.test.ts\`.`

// ─────────────────────────────────────────────────────────────────────────────
// LANE 5 — BROWSER (ticket 24), isolated; internally Wave A then Wave B
// ─────────────────────────────────────────────────────────────────────────────
const T24_BRIEF = `${COMMON}

=== LANE: BROWSER — TICKET 24 tabs / bounding_box / highlight — 3 independent gates: QUANTA_BROWSER_BOUNDS, QUANTA_BROWSER_HIGHLIGHT, QUANTA_BROWSER_TABS ===
SHIP IN TWO INDEPENDENT WAVES. Wave A (bounding_box + highlight) is THIN (per-element, no state refactor) — do it first and fully. Wave B (tabs) needs a SessionState refactor — do it second. They do not depend on each other; if Wave B runs long, Wave A must still be complete+green.

FILE OWNERSHIP (touch ONLY these):
- EDIT src/browser/types.ts
- EDIT src/browser/port.ts
- EDIT src/browser/cdp-adapter.ts
- EDIT src/browser/headless-stub.ts        (mirror new methods deterministically or TS won't compile the widened interface — REQUIRED)
- EDIT src/browser/index.ts                (export new types)
- EDIT src/tool/browser/schemas.ts
- EDIT src/tool/browser/index.ts
- EDIT src/tool/surface/manifest.ts        (3 new GATED entries — you are the SOLE manifest writer this wave)
- EDIT src/agent/tier1/browser.ts
- EDIT src/host/runtime/agent-config-assembler.ts
- NEW  tests/unit/browser-cdp-adapter-bbox-highlight-hellgate.test.ts
- NEW  tests/unit/browser-cdp-adapter-tabs-hellgate.test.ts
- NEW  tests/unit/browser-tab-bbox-highlight-tool-hellgate.test.ts
- EDIT tests/unit/browser-wire-hellgate.test.ts
- NEW  tests/integration/browser-tab-e2e.test.ts

DRIFT (verified): line numbers are stale across the ticket. SessionState at cdp-adapter.ts:83 {closed,url,proc,session:CdpSession,profileDir,refMap:RefMap,console} — ONE per session; sessions Map keyed by handle.id at :545. mouseClickXY is at :814 (not 384). PRE-EXISTING rectJs(path) at :160 returns element CENTER via getBoundingClientRect — bounding_box is a thin variant returning the FULL rect + visibility fold (reuse the \`vis\` expr from readJs:179). Tool count is 15 (not 16); createBrowserToolset at tool/browser/index.ts:510, opts:BrowserToolsetOpts. browser is ONE manifest entry (browser_snapshot:262 + flat group, single gate QUANTA_BROWSER_TOOL) — the 3 new sub-gates are net-new; RECOMMEND 3 SEPARATE GATED entries (mirror appshot_verify:734). maybeWireBrowser at agent-config-assembler.ts:292 reads gateOn(env,'QUANTA_BROWSER_TOOL'); buildBrowserBlock at agent/tier1/browser.ts:29 forwards into BrowserToolsetOpts. browser-wire-hellgate.test.ts:39 BROWSER_TOOL_NAMES is EXACT-EQUAL (:79) for the no-flag case — must stay 15 unflagged. bbox/highlight use the INTERNAL evalValue path (allowlist-bypass BY DESIGN like click/type/read), NOT the model-facing cdp() allowlist.

WAVE A — bounding_box + highlight (NO SessionState change):
1. types.ts: \`BoundingBox{x:number;y:number;w:number;h:number;visible:boolean}\`, \`HighlightOpts{color?:string;durationMs?:number}\`. Export from index.ts.
2. port.ts: \`getBoundingBox(h,ref,signal?):Promise<Result<BoundingBox,BrowserError>>\`, \`highlight(h,ref,opts?,signal?):Promise<Result<void,BrowserError>>\`.
3. cdp-adapter.ts: module-scope \`boxJs(path)\` next to rectJs — resolve el, \`const r=el.getBoundingClientRect()\`, visibility via the readJs:179 vis fold, return {x:r.x,y:r.y,w:r.width,h:r.height,visible}. \`highlightJs(path,color,durationMs)\` — resolve el, create an absolutely-positioned overlay div at the rect (pointerEvents:none, outline color, NO fill), id the overlay + remove any prior before adding (no leak on double-highlight), setTimeout auto-remove. Implement getBoundingBox via evalValue + null-guard(=>element-not-found) + primitive-shape validation (mirror read:863); highlight via evalAction (:263) false=>element-not-found. JSON.stringify-escape the ref/path in the emitted expression (red-on-injection).
4. headless-stub.ts: deterministic impls (fixed box for known refs; ok(undefined) for highlight).
5. schemas.ts: \`elementBoundsSchema=z.object({ref:z.string()})\`, \`highlightSchema=z.object({ref:z.string(),color:z.string().optional(),durationMs:z.number().finite().optional()})\` + Input types.
6. tool/browser/index.ts: boundsTool (isReadOnly:true, hitlTier 'pre-approval-ok', output \`<ref>: x,y w×h visible=…\`), highlightTool (isReadOnly:true, cosmetic). Extend BrowserToolsetOpts with bounds?:boolean; highlight?:boolean; push each tool only when its flag set.
7. manifest.ts: browser_element_bounds (gate env-flag QUANTA_BROWSER_BOUNDS, risk read-only), browser_highlight (QUANTA_BROWSER_HIGHLIGHT, risk read-only).
8. agent/tier1/browser.ts: extend slot + forward bounds/highlight. agent-config-assembler.ts maybeWireBrowser: read gateOn(env,'QUANTA_BROWSER_BOUNDS'/'_HIGHLIGHT') onto the slot.

WAVE B — tabs (SessionState refactor):
9. types.ts: \`TabInfo{id:string;url:string;title:string;active:boolean}\`; BrowserError arm \`{kind:'tab-not-found';id:string}\`.
10. cdp-adapter.ts: refactor SessionState to per-tab \`tabs: Map<targetId,{sessionId:string;refMap:RefMap;url:string}>\` + \`activeTabId\`. Bring-up's first Target.createTarget/attach => tab #1. ALL ref-resolving ops (click/type/fill/select/scroll/read/drag/getBoundingBox/highlight) resolve against the ACTIVE tab's refMap and route Runtime.evaluate through the active tab's sessionId. newTab: Target.createTarget(url)+attachToTarget(flatten)+Page.enable+observers+fresh refMap; switchTab: set activeTabId (+Page.bringToFront/Target.activateTarget); closeTab: Target.closeTarget+drop (if active, reassign or mark closed); listTabs from the map. Per-tab refMap ISOLATES refs (ref from tab A fails-closed on tab B — same invariant as navigation). Decide per-tab CdpSession vs sessionId-routing by checking cdp-session.ts onEvent dispatch keys on sessionId; prefer sessionId-routing within one CdpSession if multiplexed.
11. port.ts: newTab/switchTab/closeTab/listTabs.
12. headless-stub.ts: in-memory tab list.
13. schemas.ts + tool/browser/index.ts: browser_tab_new/switch/close/list; guard tab titles via guardPageText; switchTab accepts tab id OR 0-based index. Extend BrowserToolsetOpts tabs?:boolean; push the 4 only when set.
14. manifest.ts: ONE GATED entry browser_tab_list (rep) + group[browser_tab_new,switch,close], env-flag QUANTA_BROWSER_TABS, risk exec.
15. maybeWireBrowser + buildBrowserBlock: wire QUANTA_BROWSER_TABS.

UIUX: bbox output \`e7: 142,88  220×40  visible\` + echo resolved ref/role (turns blind mouse_click_xy into ref→bounds→precise-click) + description nudge ('use before browser_mouse_click_xy for canvas/drag offsets'); highlight default high-contrast magenta #ff00ff 3px no-fill pointerEvents:none, ~1500ms auto-remove, pair-with-screenshot description, strictly read-only/no-HITL; tabs listTabs indexed table \`[0]* https://… "Title"\` (* = active), EVERY switch result reminds 'refs are per-tab; re-snapshot after switching' (mirror navigate ref-invalidation prose at cdp-adapter:694), switchTab accepts id-or-index, tab-not-found lists open tab ids for one-turn self-correct; ARCHITECTURE: bbox+highlight in their OWN gates so they ship without the tabs refactor (the biggest slickness win = decoupling).
TDD: browser-cdp-adapter-bbox-highlight-hellgate.test.ts (fake transport, copy harness from browser-cdp-adapter-hellgate.test.ts) — getBoundingBox(known)=>{x,y,w,h,visible}; getBoundingBox(unknown)=>element-not-found WITH zero Runtime.evaluate issued; highlight(known)=>ok + issued expr contains overlay-create+setTimeout; ref with \`'</script>\` chars => JSON.stringify-escaped (red-on-injection). browser-tab-bbox-highlight-tool-hellgate.test.ts — DEFAULT-OFF byte-identity (no flags => tool names IDENTICAL to today's 15; bounds/highlight absent); {bounds:true,highlight:true} => 2 present; highlight isReadOnly===true. browser-cdp-adapter-tabs-hellgate.test.ts — newTab=>listTabs 2; switchTab routes eval to right sessionId; REF ISOLATION (snapshot tab1 e1; switchTab tab2; click(e1)=>element-not-found); closeTab(active) reassign; closeTab(unknown)=>tab-not-found. browser-wire-hellgate.test.ts — unflagged BROWSER_TOOL_NAMES UNCHANGED (15); tabs flag => 4 browser_tab_* appear. tests/integration/browser-tab-e2e.test.ts — navigate→newTab→switch→click-correct-tab on headless stub. The existing tool-surface-manifest-hellgate.test.ts auto-greps new name:"x" — run it after adding manifest rows to confirm green.
After Wave A: \`bun test tests/unit/browser-cdp-adapter-bbox-highlight-hellgate.test.ts tests/unit/browser-tab-bbox-highlight-tool-hellgate.test.ts tests/unit/browser-wire-hellgate.test.ts\`. After Wave B: add the tabs hellgate + integration + tool-surface-manifest-hellgate.`

// dispatch
const slashLane = async () => agent(SLASH_BRIEF, { label: 'impl:16+17-slash', phase: 'Implement', schema: IMPL_SCHEMA })

const mcpLane = async () => {
  const r19 = await agent(T19_BRIEF, { label: 'impl:19-reverse-mcp', phase: 'Implement', schema: IMPL_SCHEMA })
  const r2022 = await agent(T20_22_BRIEF, { label: 'impl:20+22-mcp-proto', phase: 'Implement', schema: IMPL_SCHEMA })
  return [r19, r2022]
}

const results = await parallel([
  () => slashLane(),
  () => mcpLane(),
  () => agent(T21_BRIEF, { label: 'impl:21-mcp-tasks', phase: 'Implement', schema: IMPL_SCHEMA }),
  () => agent(T23_BRIEF, { label: 'impl:23-llm-reasoning', phase: 'Implement', schema: IMPL_SCHEMA }),
  () => agent(T24_BRIEF, { label: 'impl:24-browser', phase: 'Implement', schema: IMPL_SCHEMA }),
])

const flat = results.flat().filter(Boolean)
return { implemented: flat }
