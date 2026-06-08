export const meta = {
  name: 'audit-new-cluster',
  description: 'Read-only audit of NEW cluster tickets 16-24: verify seams, detect drift, produce impl specs + collision map',
  phases: [{ title: 'Audit', detail: '9 read-only agents, one per ticket' }],
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'title', 'seamsVerified', 'drift', 'filesToTouch', 'sharedFiles', 'complexity', 'gate', 'spec', 'tddPlan', 'uiuxNotes', 'readyToImplement', 'blockers'],
  properties: {
    ticket: { type: 'string', description: 'ticket number e.g. "16"' },
    title: { type: 'string' },
    seamsVerified: {
      type: 'array',
      description: 'Each seam the ticket claims exists, verified against live source',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'exists', 'note'],
        properties: {
          ref: { type: 'string', description: 'e.g. "src/subagent/registry.ts:61 TaskRegistry.list()"' },
          exists: { type: 'boolean' },
          note: { type: 'string', description: 'actual current shape; flag if line numbers/signatures drifted' },
        },
      },
    },
    drift: { type: 'string', description: 'How live source diverges from the ticket\'s claimed current-state. "none" if accurate.' },
    filesToTouch: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'isNew', 'role'],
        properties: {
          path: { type: 'string', description: 'absolute or src-relative path' },
          isNew: { type: 'boolean' },
          role: { type: 'string', description: 'what changes here' },
        },
      },
    },
    sharedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Registration/SSOT files ALSO likely touched by sibling tickets — manifest.ts, mcp/index.ts, slash/registry-surface.ts, tsconfig.base.json, repl/surface-compose, etc. These are collision points.',
    },
    complexity: { type: 'string', enum: ['trivial', 'small', 'moderate', 'hard'] },
    gate: { type: 'string', description: 'env gate name (QUANTA_*) per default-OFF discipline' },
    spec: { type: 'string', description: 'Concrete ordered implementation steps with real symbols/paths, accounting for any drift found' },
    tddPlan: { type: 'string', description: 'Test files + red-first scenarios incl. red-on-injection + default-OFF byte-identity' },
    uiuxNotes: { type: 'string', description: 'UI/UX + architecture enhancements beyond the ticket baseline that make this "기깔나는" (slick): formatting, colors, affordances, error messages, discoverability, seam cleanliness' },
    readyToImplement: { type: 'boolean' },
    blockers: { type: 'string', description: 'anything preventing clean implementation; "none" if clear' },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . Source lives under src/ ; the ticket's bare paths are relative to src/ (e.g. "slash/registry-surface.ts" => "src/apps/cli/slash/registry-surface.ts", "subagent/registry.ts" => "src/subagent/registry.ts"). Resolve the REAL path of every seam.

This is a READ-ONLY audit. Do NOT edit any file. Your job:
1. Open every seam the ticket names. Confirm the symbol/function/line still exists; note the ACTUAL current signature/shape and whether line numbers drifted.
2. Report drift between the ticket's claimed current-state and live source.
3. Identify EVERY file the implementation will touch (new vs modified) and its role.
4. Flag shared/registration files (manifest, index barrels, slash registry, tsconfig.base, surface-compose, codec barrels) that sibling tickets in this same cluster (16-24) will also touch — these are collision points for parallel implementation.
5. Write a concrete, ordered implementation spec using the REAL symbols you found (not the ticket's possibly-stale ones). Honor the project discipline: default-OFF byte-identity, env gate via @/shared gateOn, new LLM tool => manifest GATED entry, new slice => tsconfig.base path + slice-fence, TDD red-first, CLI-importing tests under src/apps/cli/__tests__/.
6. Propose UI/UX + architecture enhancements that make the feature genuinely slick (not just functional) — surface them in uiuxNotes.
7. Verify your claims by actually reading the code. Do not assume. If a seam is missing or different, say so and adapt the spec.

Be precise and terse. Return the structured object.`

phase('Audit')

const TICKETS = [
  {
    n: '16', label: 'init', title: '/init codebase onboarding doc generator',
    body: `Ticket 16 — §11.1 /init codebase onboarding doc generation (ROI 중).
Current claim: runner/assemble/repo-map-scan.ts:73 makeRepoMapScan (rg --files aggregation, injection seam); agent/repo-rules.ts:103 loadRepoRules (AGENTS.md/CLAUDE.md collection); slash/registry-surface.ts:90 cmd pattern.
Design: /init [--force] => repo-map scan + build/test command detection (package.json scripts -> Makefile) => generate CLAUDE.md (sections: Quick Start / Directory / Key Files / Conventions). If exists, confirm (--force skips), preserve user-edited sections. Pure scaffoldClaudeMd(cwd, repoMap?, buildCmd?) renderer.
Files: slash/registry-surface.ts (initCmd) + NEW slash/init-scaffold.ts (pure). TDD: deterministic scaffold output; repo-map mock + truncation; exists -> confirm/--force; unwired degrade.
Risks: build heuristic false positives (conservative default + preserve user edits); large-repo perf (maxChars truncation).
Extra: investigate how existing slash commands are registered and rendered, how confirm/prompt is done in the slash surface, and whether a repo-map scanner result is already cached/available so /init reuses it.`,
  },
  {
    n: '17', label: 'agents', title: '/agents live fleet view',
    body: `Ticket 17 — §11.2 /agents live fleet view (ROI 중-고, observability north-star).
Current claim: subagent/registry.ts:61 TaskRegistry (running/completed/failed/stopped + id/agentType/startedAt/result, list()/getById(), LRU 256). repl/slash-surface.ts:55 ReplSlashCtx (slot to add).
Design: /agents [--format table|json|tree] => taskRegistry.list() -> status table (ID / Status color / Type / Age / Result). Pure renderAgentFleet(tasks, format, now). Future --watch.
Files: slash/registry-surface.ts (agentsCmd) + repl/slash-surface.ts (+taskRegistry?) + repl/surface-compose (wire) + NEW render helper. TDD: render pure (no clock); 3 formats; unwired degrade.
Risks: LRU 256 (doc + --all); TTY ANSI detection; large result (50char truncate).
Extra: read the full TaskRegistry shape and how slash ctx is composed/wired in surface-compose, and how other commands access registries. Confirm what status fields & timestamps are actually available for age/result rendering.`,
  },
  {
    n: '18', label: 'ctrl-b-bg', title: 'Ctrl+B move running turn to background (HARD)',
    body: `Ticket 18 — §11.4 Ctrl+B move running turn to background (ROI 중, HARD/phased).
Current claim: keybindings/types.ts:19 KEY_ACTIONS (closed enum); repl/turn-cancel-install.ts Esc-Esc/Ctrl+C FSM; repl/session-loop.ts while{ runOneTurn() } (turn = monolithic await); tool-layer run_in_background.
Core difficulty: turn is a single await runOneTurn() = transaction. Ctrl+B must detach without waiting + return to prompt + collect result later.
Design: NEW BackgroundTurnPortal (manages detached turns: taskId/state/bufferedOutput ring buffer). keybinding move-to-background + ctrl+b. Mid-turn Ctrl+B -> portal.detach(signal, outcome) -> register + return to prompt. /background list|reattach|cancel.
Files: keybindings/types.ts + defaults.ts; NEW repl/background-turn-portal.ts; turn-runner.ts (onMovedToBackground cb); session-loop.ts; raw-line-reader (action); slash (background cmd).
RECOMMEND phased: V1 (keybinding + portal + read-only reattach) -> V2 (persist) -> V3 (weave). Risks: turn atomicity, output overflow (50MB cap), signal cleanup, weave conflict (detach disabled when weave on), history consistency.
Extra: this is the hardest. Map the EXACT turn lifecycle: where session-loop awaits runOneTurn, how AbortController/signal flows, how turn-cancel FSM intercepts keys, how raw-line-reader dispatches key actions, and where weave-mode is detected. Assess whether V1 is feasible cleanly and what the minimal safe slice is. Be honest about risk.`,
  },
  {
    n: '19', label: 'reverse-mcp', title: 'reverse-MCP — quanta as MCP server',
    body: `Ticket 19 — §22.3 reverse-MCP, quanta as MCP server (ROI 고, ~2-3 days, security-critical).
Current claim: quanta is CLIENT-only (mcp/client.ts connects to external servers + handles inbound sampling/roots/elicitation). tools/list & tools/call SERVER-side = 0. Reuse: mcp/jsonrpc.ts (encode + LineReader + envelope validate, direction-agnostic); transports/ (stdio/http-sse symmetric); tool/surface/manifest.ts (SSOT of exposable tools); permission-store + jail (same gates re-applied).
Design (default-OFF, gated): NEW mcp/server.ts McpServer (mirror of client.dispatch: initialize / tools/list / tools/call). tools/list returns READ-ONLY subset only (default); tools/call passes the SAME permission + jail + redaction gates as the agent. Transport = stdio (embedded). gate QUANTA_MCP_SERVER. SECURITY CORE: an external client calling quanta bash = RCE => default read-only whitelist + per-tool explicit opt-in.
Files: NEW mcp/server.ts + server-builder.ts; mcp/index.ts (export); NEW apps/cli/mcp-server-setup.ts (quanta mcp-server); manifest.ts (mcp_server meta gate). TDD: initialize nego; tools/list (read-only only, pagination); tools/call (permission gate, bash deny by default, redaction, result cap); errors -32601/-32602/-32603; real SDK client integration.
Extra: read mcp/jsonrpc.ts, mcp/client.ts dispatch, the transports, the manifest tool registry shape (how to enumerate tools + their read-only-ness), and how the agent-side tool-call permission/jail/redaction pipeline is invoked so the server reuses it EXACTLY. This is the highest-ROI, highest-risk ticket — map the security boundary precisely.`,
  },
  {
    n: '20', label: 'mcp-res-templates', title: 'MCP resources templates + completion',
    body: `Ticket 20 — §1.3 MCP resources templates/completion (ROI 저-중).
Current claim: mcp/resources/port.ts:27 McpResource (uri/name/mime/desc, no template); codec.ts:46 parseResourceList (flat). completion/complete = 0.
Design: resources/templates/list (parameterized URI file://{folder}/{name}) + completion/complete inbound (prompt/resource argument autocomplete). McpResourceTemplate{uri,name,uriTemplate} + parseResourceTemplateList + client listResourceTemplates() + NEW mcp/completion/ slice. default-OFF (only when server declares capability).
Files: resources/port.ts + codec.ts + inbound-router.ts; client.ts (listResourceTemplates); NEW mcp/completion/. TDD: fake transport returns templates + completion call shape; malformed template; empty completion.
Extra: read the resources port + codec + how client.ts issues requests and how inbound-router dispatches, plus capability negotiation, so completion/templates wire cleanly.`,
  },
  {
    n: '21', label: 'mcp-tasks-ttl', title: 'MCP Tasks ttl/pollInterval/related',
    body: `Ticket 21 — §1.5 MCP Tasks ttl/pollInterval/related-task (ROI 저-중).
Current claim: mcp/tasks/types.ts:18 McpTaskInfo (taskId/state/title/progress only); poller.ts:34 fixed DEFAULT_INTERVAL_MS=200.
Design: add to McpTaskInfo ttl? (expiry -> stop + timeout) / pollInterval? (server cadence hint) / relatedTaskIds? + parseTaskInfo defensive parse + pollTask drives cadence from response pollInterval + TTL expiry check. default-OFF (optional fields).
Files: tasks/types.ts + poller.ts + codec parser; tool/mcp_tasks render. TDD: pollInterval=50 -> 50ms sleep; ttl=500 expiry; related link carry; neg/NaN/circular edge.
Extra: read the tasks types, poller loop, codec parsing of task info, and the mcp_tasks tool render so new fields surface in UX.`,
  },
  {
    n: '22', label: 'mcp-url-elicit', title: 'MCP elicitation url variant',
    body: `Ticket 22 — §1.4 MCP elicitation url variant (ROI 저, niche).
Current claim: elicitation/schemas.ts:25 has 7 variants (string/number/integer/bool/enum/multi/single); inbound-router.ts:130 switch; default-cli-prompter.ts 7 prompts. url = 0.
Design: urlRequestSchema{prompt,title?,url(RFC3986)} 8th variant + router case "url" + promptUrl() (CLI: "confirm open? y/n" -> open/xdg-open, headless -> {ok:false,"headless-denied"}).
Files: schemas.ts + port.ts + inbound-router.ts + default-cli-prompter.ts + headless-rejecter.ts. TDD: spec type:url routing; CLI mock open y/n; headless immediate decline; malformed url/abort.
Extra: read the 7 existing elicitation variants to mirror the exact shape/validation idiom, the router switch, both prompters, and how a system open command is invoked elsewhere in the repo (reuse, don't reinvent).`,
  },
  {
    n: '23', label: 'reasoning-summary', title: 'reasoning summary:auto + verbosity/xhigh',
    body: `Ticket 23 — LLM §9.4 reasoning summary:"auto" + §9.5 verbosity/xhigh (ROI 저, cheap bundle).
Current claim: openai-responses-wire.ts:343 request has reasoning:{effort} only (summary not requested; READ path already preserves summary); :285 effort normalizer = minimal|low|medium|high (no xhigh); verbosity = 0.
Design: (1) request reasoning add summary:"auto" (knob QUANTA_REASONING_SUMMARY); (2) effort enum + xhigh + verbosity:low|medium|high field (knob QUANTA_REASONING_VERBOSITY). factory -> adapter -> stream prepare -> wire 4-seam threading. default-OFF (knob absent => body unchanged).
Files: openai-responses-wire.ts (normalizer + builder); factory.ts (resolve); adapters/openai-responses.ts; responses-stream.ts. TDD: buildResponsesBody emits summary/verbosity; normalizer xhigh accepted / invalid -> undefined; e2e knob on streaming.
Extra: read the exact 4-seam threading path (factory -> adapter -> stream prepare -> wire), the current effort normalizer + body builder, and confirm where these LLM files live under src/llm. Confirm byte-identity when knobs absent.`,
  },
  {
    n: '24', label: 'browser', title: 'browser tabs / bounding_box / highlight',
    body: `Ticket 24 — browser §6.2 tabs / §6.3 bounding_box / §6.4 highlight (ROI 중, bundle).
Current claim: tool/browser/index.ts has 16 tools all on a single BrowserSession (1 page). browser/cdp-adapter.ts:83 SessionState (proc + CDP session + refMap) = driver seam. mouse_click_xy(384) clicks coords but no way to get bounds.
Design (each default-OFF GATED): (1) tabs — BrowserPort newTab/switchTab/closeTab/listTabs (CDP Target.createTarget/closeTarget, SessionState per-tab refMap) + browser_tab_* tools. (2) bounding_box — getBoundingBox(ref) (CDP DOM.getBoxModel or getBoundingClientRect -> {x,y,w,h,visible}) + browser_element_bounds tool. (3) highlight — highlight(ref,{color,duration}) (in-page DOM overlay JS, auto-remove) + browser_highlight tool (read-only, cosmetic).
Files: browser/types.ts (TabInfo/BoundingBox/HighlightOpts); browser/port.ts (methods); browser/cdp-adapter.ts (impl); tool/browser/index.ts + schemas.ts (tools) + manifest GATED. gates QUANTA_BROWSER_TABS/_BOUNDS/_HIGHLIGHT. TDD: cdp-adapter fake transport (tab state/box extract/overlay inject); integration (navigate->tab->switch->click correct tab); multi-tab state machine hellgate.
Risks: tab switch invalidates refs (snapshot notifies changed ref) — tabs is most complex (state refactor).
Extra: read the BrowserPort interface, cdp-adapter SessionState + how refMap/CDP session works, how the 16 existing browser tools are defined + schema'd + manifest-registered, and how mouse_click_xy gets coordinates, so the 3 new capabilities slot in. Assess whether bbox+highlight (thin) can ship independently of tabs (state refactor).`,
  },
]

const audits = await parallel(
  TICKETS.map((t) => () =>
    agent(`${COMMON}\n\n=== YOUR TICKET ===\n${t.body}`, {
      label: `audit:${t.n}-${t.label}`,
      phase: 'Audit',
      schema: AUDIT_SCHEMA,
    })
  )
)

return { audits: audits.filter(Boolean) }
