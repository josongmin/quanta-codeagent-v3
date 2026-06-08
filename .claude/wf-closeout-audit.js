export const meta = {
  name: 'closeout-audit',
  description: 'Final adversarial structural close-out of NEW cluster 16-24: independent verify (real tsc/test/evidence) incl. my own fix-forward; find any real bug',
  phases: [{ title: 'Audit', detail: '6 independent read-only adversarial auditors' }],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'compiles', 'testsRun', 'testsPass', 'invariantsHeld', 'structuralNotes', 'bugsFound', 'closeoutReady', 'verdict'],
  properties: {
    scope: { type: 'string' },
    compiles: { type: 'string', description: 'ran `bun run typecheck` (or tsc) — result for THESE files; cite the command + any error lines (ignore unrelated user-sprint files: capability/*, bootstrap, model-cmd, header-rules, worktree)' },
    testsRun: { type: 'array', items: { type: 'string' }, description: 'exact bun test commands you ran' },
    testsPass: { type: 'string', description: 'pass/fail counts observed' },
    invariantsHeld: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['invariant', 'held', 'evidence'], properties: { invariant: { type: 'string' }, held: { type: 'boolean' }, evidence: { type: 'string', description: 'the command output / observation that proves it — NOT a comment you read' } } } },
    structuralNotes: { type: 'string', description: 'architecture quality: slice-fence honored? pure render/injected clock? default-OFF discipline? gate registered? no dead code/orphan exports? leaky abstraction? Be specific with file:line.' },
    bugsFound: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'where', 'what', 'evidence'], properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, where: { type: 'string' }, what: { type: 'string' }, evidence: { type: 'string' } } } },
    closeoutReady: { type: 'boolean', description: 'is this scope safe to call DONE/closed?' },
    verdict: { type: 'string', enum: ['closed', 'minor-residual', 'broken'] },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . READ-ONLY audit — do NOT edit anything. This is the FINAL close-out audit of the NEW cluster (tickets 16-24). Two prior impl agents self-reported "wired + green" while real \`tsc\` proved them BROKEN (a live RCE; a non-compiling browser slice). So: TRUST NOTHING SELF-REPORTED. RUN real commands (\`bun run typecheck\`, \`bun test <files>\`, greps, in-repo drivers) and cite the ACTUAL output. An invariant "held" only if you OBSERVED it, not if a comment claims it.

IMPORTANT — the tree is shared with the USER's concurrent sprint (capability/*, host/bootstrap, model-cmd, header-rules, worktree). When you run a broad \`tsc\`/test, IGNORE errors/failures in those user-sprint files; report ONLY issues in YOUR audited scope. Attribute every finding.

The user wants STRUCTURAL close-out: beyond "does it pass", assess architecture quality — slice fences (noRestrictedImports), default-OFF byte-identity, red-on-injection coverage, no-throw boundaries, gate REGISTRATION (knob completeness ratchet), manifest SSOT two-way drift, dead code / orphan exports, injected clocks / pure render seams. Find any REAL defect (not style nits). Return the structured verdict with evidence.`

phase('Audit')

const AUDITS = [
  {
    label: 'A:24-browser', scope: '24 browser bbox+highlight (Wave A, LIVE) + confirm Wave B tabs cleanly omitted',
    body: `Scope: TICKET-24 Wave A — browser_element_bounds + browser_highlight. This was FIX-FORWARDED by the orchestrator after the impl agent fabricated it, so audit it with FRESH skeptic eyes (the orchestrator's own verification has the same self-report bias the lesson warns about).
Files: src/browser/cdp-adapter.ts (getBoundingBox/highlight in the RETURNED object + boxJs/highlightJs helpers), src/browser/headless-stub.ts, src/browser/port.ts, src/browser/types.ts, src/browser/index.ts, src/tool/browser/index.ts (boundsTool/highlightTool + BrowserToolsetOpts), src/tool/browser/schemas.ts, src/tool/surface/manifest.ts (2 GATED entries — RE-READ, it just changed), src/agent/tier1/browser.ts, src/host/runtime/agent-config-assembler.ts.
Adversarially verify (RUN it): (1) browser slice typechecks (no TS2739 — the bug that was committed). (2) tests/unit/browser-cdp-adapter-bbox-highlight-hellgate.test.ts + browser-tab-bbox-highlight-tool-hellgate.test.ts + browser-wire-hellgate.test.ts + tool-surface-manifest-hellgate.test.ts all green — run them. (3) INJECTION: read highlightJs — is \`color\` JSON.stringify-escaped so a \`"\`-breakout can't inject? (the HELL-HL-03 test). (4) ZERO-EVAL fail-closed: getBoundingBox(unknown ref) must issue NO Runtime.evaluate (resolve via refMap first). (5) malformed page value → cdp-error (not a NaN box). (6) DEFAULT-OFF byte-identity: no flags ⇒ exactly the 15 base tools (browser_element_bounds/browser_highlight ABSENT). (7) gate FLIP: are QUANTA_BROWSER_BOUNDS/_HIGHLIGHT registered in the knob inventory (run the knob ratchet)? (8) manifest two-way drift: the 2 new entries map to real tools + risk read-only (run the manifest hellgate). (9) Wave B tabs: confirm ZERO tab code leaked (grep TabInfo/newTab/switchTab/activeTabId) and the omission left the tree compiling. STRUCTURAL: are bbox/highlight truly decoupled (independent gates, no tabs dependency)? Is highlight isReadOnly+pre-approval-ok? dead code (boxJs/highlightJs actually referenced now)?`,
  },
  {
    label: 'B:16-17-slash', scope: '16 /init + 17 /agents (slash surface)',
    body: `Scope: TICKET-16 /init (gated) + TICKET-17 /agents (presence-gated).
Files: src/apps/cli/init-scaffold.ts (+ the default node rg shell the orchestrator added), src/apps/cli/agents-fleet-panel.ts, src/apps/cli/slash/registry-surface.ts (initCmd gated spread + agentsCmd), src/apps/cli/repl/slash-surface.ts (taskRegistry→agents wire + toAgentFleetRow), src/apps/cli/repl/surface-compose.ts (taskRegistry pass), src/apps/cli/slash-contract.ts.
Adversarially verify (RUN it): (1) typecheck these files (no errors). (2) tests/unit/cli/init-scaffold.test.ts + agents-fleet-panel.test.ts + slash-commands.test.ts + repl-slash-ctx-mega-wire-hellgate + repl-surface-wire-hellgate green. (3) /init GATE FLIP via an in-repo driver: with QUANTA_INIT_SLASH=1 a fresh process has /init in SURFACE_SLASH_COMMANDS; unset ⇒ ABSENT (prove it flips, not vacuously dead). (4) /init default-OFF byte-identity: gate unset ⇒ /init absent from BUILTINS ⇒ the documented BUILTINS list is unchanged. (5) /init --force REALLY refuses without the flag (existing file bytes unchanged) and --dry-run writes NOTHING — verify against a real temp dir. (6) the default node rg shell (init-scaffold.ts) is NO-THROW (a failed exec resolves to a typed non-zero exitCode, never an exception) and tests still inject their own shell (default doesn't break them). (7) /agents: ctx.agents absent ⇒ "not wired" exit 0 (byte-identical); with a stub registry ⇒ renders; toAgentFleetRow maps TaskRecord→AgentFleetRow without leaking @/subagent into the fenced render. STRUCTURAL: renderAgentFleet pure (injected now, no clock leak)? slice-fence: registry-surface imports buildInitCmd as an opaque object (the @/runner import lives in init-scaffold, apps/cli level)? Is QUANTA_INIT_SLASH registered (knob ratchet)?`,
  },
  {
    label: 'C:18-ctrlb', scope: '18 Ctrl+B background (V1)',
    body: `Scope: TICKET-18 Ctrl+B move-turn-to-background, V1.
Files: src/apps/cli/repl/background-turn-portal.ts, src/apps/cli/background-cmd.ts, src/apps/cli/repl/turn-cancel-install.ts, src/apps/cli/repl/turn-runner.ts, src/apps/cli/repl/session-loop.ts, src/apps/cli/repl/surface-compose.ts, src/apps/cli/slash-contract.ts, src/apps/cli/keybindings/{types,defaults}.ts.
Adversarially verify (RUN the tests + read the code): (1) typecheck. (2) src/apps/cli/__tests__/background-turn-portal.hellgate.test.ts + background-ctrlb-turn-runner.hellgate.test.ts green. (3) TURN ATOMICITY: on Ctrl+B, the turn body promise is NOT aborted (turnAbort.signal.aborted===false) and is handed to the portal alive; runOneTurn resolves {backgrounded:true,result:undefined} WITHOUT firing onAfterResult. Verify by reading turn-runner + the test assertions. (4) STDIN: installTurnCancel's finally disposes (releases raw-mode) so promptSource.next re-attaches — no double-raw-mode hang. (5) DEFAULT-OFF: QUANTA_BG_TURN unset ⇒ no portal ⇒ onBackground unwired ⇒ ctrl+b a silent no-op ⇒ turn path byte-identical. (6) WEAVE guard: shouldWireBackground returns false when inboundMode==='weave' or conversationActions active (read it + any test). (7) portal NO-THROW: detach/cancel/get(unknown) never throw; ring buffer caps at BG_BUFFER_MAX_BYTES. (8) the orchestrator just fixed a stale comment in session-loop.ts ~393 — confirm no code emits a phantom "background disabled in weave mode" string (grep). STRUCTURAL: is BackgroundTurnPortal a pure per-session value object (one owner, handed to loop-writer + slash-reader), no module singleton? Is QUANTA_BG_TURN registered (knob ratchet)? V1 scope respected (no V2 persist / V3 weave-live-reattach leaked in)?`,
  },
  {
    label: 'D:19-rce', scope: '19 reverse-MCP RCE boundary (re-verify the fix holds)',
    body: `Scope: TICKET-19 reverse-MCP. A live RCE was found+fixed (headless acceptEdits auto-allowed a force-opted-in write; fixed to dispatch under {mode:"default"} + server.drain()). RE-VERIFY the fix HOLDS — this is the security crux.
Files: src/apps/cli/mcp-server-setup.ts (serverPermission {mode:"default"} + drain), src/mcp/server.ts (inflight + drain), src/mcp/server-builder.ts, src/mcp/index.ts.
Adversarially verify (RUN it with OPENAI_API_KEY=sk-dummy-test-000): (1) src/apps/cli/__tests__/mcp-server-setup.hellgate.test.ts + src/mcp/__tests__/server.test.ts + server-builder.test.ts green. (2) RCE MUTATION (the decisive check): run the force-opt-in write hellgate and confirm NO .tmp-mcp-rce-probe-*.txt file is created in cwd (ls before+after) — the write must be DENIED. (3) confirm the denial surfaces as isError (not -32602; the tool IS whitelisted via opt-in but the permission gate blocks it). (4) DRAIN: read server.ts — does the pump await in-flight tools/call before exit (so an async write can't outlive the command and race a post-run check)? (5) DEFAULT-OFF: QUANTA_MCP_SERVER unset ⇒ exit 64, stdout EMPTY, nothing assembled; loose 'on' refused (strict ===1). (6) tools/list read-only whitelist: bash/write ABSENT by default. STRUCTURAL: does @/mcp server.ts/server-builder.ts import NEITHER @/agent NOR @/tool (slice fence — run the slice-graph hellgate if present, or grep imports)? Is the security boundary (buildMcpServer whitelist) a small pure function? Are QUANTA_MCP_SERVER/_EXPOSE registered (knob ratchet)?`,
  },
  {
    label: 'E:20-23-mcp-llm', scope: '20/21/22 MCP + 23 LLM (earlier-landed; confirm still solid)',
    body: `Scope: TICKET-20 (resources templates/completion), 21 (tasks ttl/poll/related), 22 (url elicitation), 23 (reasoning summary/verbosity/xhigh). Landed earlier — confirm they still hold + are structurally sound (the tree has moved since).
Files: src/mcp/resources/{port,codec,index}.ts, src/mcp/client.ts, src/mcp/tasks/{types,client-port,poller}.ts, src/tool/mcp_tasks/*, src/mcp/elicitation/{schemas,port,inbound-router,default-cli-prompter,headless-rejecter,lease,index}.ts, src/mcp/index.ts, src/llm/{openai-responses-wire,factory,responses-stream}.ts, src/llm/adapters/{openai-responses,chatgpt-oauth}.ts, src/config/knob-inventory.ts.
Adversarially verify (RUN it): (1) typecheck these. (2) bun test tests/unit/mcp-templates-completion-hellgate.test.ts tests/unit/mcp/elicitation-url-headless.test.ts tests/unit/mcp/elicitation-hellgate.test.ts tests/unit/mcp-elicitation-inbound-hellgate.test.ts tests/unit/mcp/tasks-hellgate.test.ts tests/unit/mcp/tasks-live-binding-adversarial.test.ts tests/unit/llm/openai-responses-wire.test.ts tests/unit/llm/reasoning-summary-verbosity-e2e-hellgate.test.ts — all green. (3) 23 WIRE-FAITHFUL: buildResponsesBody emits text:{verbosity} (NOT a flat verbosity key the API ignores) and reasoning.summary co-located with effort; default-OFF body byte-identical when knobs absent (run the byte-identity test). (4) 22 SECURITY: urlRequestSchema rejects non-http/https (file:/javascript:/data:) — read the refine + any test. (5) 20 completion is OUTBOUND (no inbound-router/negotiator wiring); empty completion is OK not malformed. (6) 21 codec defensiveness: neg/NaN/circular relatedTaskIds dropped; byte-identity when fields absent. STRUCTURAL: are the 23 knobs (QUANTA_REASONING_SUMMARY/VERBOSITY) registered? any @/tool↔@/mcp slice-fence breach? all 5 reasoning threading seams consistent (incl. chatgpt-oauth adapter)?`,
  },
  {
    label: 'F:structural-xcut', scope: 'cross-cutting STRUCTURAL integrity of the whole NEW cluster',
    body: `Scope: the cross-cutting structural health the user emphasized ("구조적으로"). Audit the SHARED registration files + repo-wide ratchets, independent of any single ticket.
Adversarially verify (RUN it): (1) FULL src typecheck: \`bun run typecheck\` — report the TOTAL error count and whether ANY error is in NEW-cluster files (vs user-sprint capability/bootstrap/model/worktree/header noise). (2) KNOB COMPLETENESS: run tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts + knob-registry-disjoint-hellgate.test.ts — orphans must be 0; if any orphan, name it + whose it is (NEW-cluster QUANTA_BROWSER_BOUNDS/_HIGHLIGHT/_INIT_SLASH/_BG_TURN/_MCP_SERVER must be registered). (3) MANIFEST SSOT: run tool-surface-manifest-hellgate.test.ts (two-way drift: every tool has a row, every row a real tool) — the 2 browser entries + mcp_server (NOT a GATED row — it's a CLI subcommand) must be consistent. (4) SLICE FENCES: run any slice-graph / noRestrictedImports hellgate (e.g. tests for biome restricted imports, slice-boundary). Confirm: registry-surface.ts imports no @/agent/@/llm/@/runner/@/host directly; @/mcp imports no @/agent/@/tool; @/tool/browser render imports no @/subagent. (5) SHARED-FILE INTEGRITY: registry-surface.ts + slash-contract.ts + surface-compose.ts each cleanly hold BOTH my NEW-cluster additions (/agents /background /init, agents/background slots, taskRegistry) AND the user's (/model, model/stickyModel slots) with no duplicate/clobbered entries — read them. (6) DEAD CODE: any new exported symbol (renderAgentFleet, buildInitCmd, McpServer, boxJs/highlightJs, BackgroundTurnPortal) actually reachable from a wired call site? (7) BUILTINS sweep: tests/unit/slash-commands.test.ts green (documented builtins == registered). Report a definitive cross-cutting PASS/FAIL with the command outputs.`,
  },
]

const verdicts = await parallel(
  AUDITS.map((a) => () => agent(`${COMMON}\n\n=== YOUR SCOPE ===\n${a.body}`, { label: a.label, phase: 'Audit', schema: VERDICT, agentType: 'Explore' }))
)

return { verdicts: verdicts.filter(Boolean) }
