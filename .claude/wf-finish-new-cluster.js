export const meta = {
  name: 'finish-new-cluster',
  description: 'Finish NEW cluster: 16 /init, 24 browser (bbox/highlight/tabs), 18 Ctrl+B background — collision-safe lanes + adversarial verify',
  phases: [
    { title: 'Implement', detail: 'BROWSER(24A→24B) ∥ SLASH(16→18)' },
    { title: 'Verify', detail: 'independent adversarial skeptics per feature' },
  ],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'shipped', 'summary', 'filesChanged', 'testResult', 'gate', 'uiuxDelivered', 'deviations', 'selfReview'],
  properties: {
    ticket: { type: 'string' },
    shipped: { type: 'string', description: 'what actually landed (e.g. "Wave A only" if Wave B omitted)' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'isNew', 'what'], properties: { path: { type: 'string' }, isNew: { type: 'boolean' }, what: { type: 'string' } } } },
    testResult: { type: 'string', description: 'exact bun test counts + commands run' },
    gate: { type: 'string' },
    uiuxDelivered: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'string' },
    selfReview: { type: 'string', description: 'adversarial self-check; what you did NOT verify' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'compiles', 'testsPass', 'defaultOffByteIdentical', 'riskClaimVerified', 'realBugsFound', 'verdict', 'evidence'],
  properties: {
    ticket: { type: 'string' },
    compiles: { type: 'boolean', description: 'slice typechecks' },
    testsPass: { type: 'boolean' },
    defaultOffByteIdentical: { type: 'string', description: 'is gate-OFF byte-identical? how verified (not self-reported — actually checked)' },
    riskClaimVerified: { type: 'string', description: 'the feature-specific risk claim, INDEPENDENTLY verified by running/inspecting — not trusting the impl agent' },
    realBugsFound: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'where', 'what', 'evidence'], properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, where: { type: 'string' }, what: { type: 'string' }, evidence: { type: 'string' } } } },
    verdict: { type: 'string', enum: ['solid', 'minor-fixes', 'broken'] },
    evidence: { type: 'string', description: 'concrete commands run + outputs observed' },
  },
}

const COMMON = `
Working dir: /Users/songmin/quanta-codeagent-v3 . Source under src/ . You implement on the MAIN working tree, SHARED with (a) a sibling lane in this workflow and (b) the USER's OWN concurrent sprint (capability/bootstrap work right now).

⛔ FILE OWNERSHIP IS ABSOLUTE — touch ONLY your listed files. Before editing any SHARED registration file (registry-surface.ts, slash-contract.ts, surface-compose.ts, manifest.ts) RE-READ it immediately first (the tree moves under you), then APPEND your entry without disturbing existing ones (the user's /model + my /agents are already committed there — append after them).

DISCIPLINE (hard): TDD red-first; default-OFF byte-identity (gate absent ⇒ behavior BYTE-IDENTICAL, include an explicit byte-identity test); red-on-injection test (fails if the invariant is removed); gate via @/shared gateOn (gateOnStrict for security); NO-THROW boundaries; new slice ⇒ tsconfig.base path + slice-fence (but staying in an existing mapped slice needs none). Deliver SOTA++ slick UX + clean architecture (pure render seams, injected clocks, structural decoupling), not just the baseline.

VERIFY your slice with \`bun test <your files>\`. Do NOT run full-repo \`bunx tsc\` (sibling lane + the user's sprint are mid-edit — it shows unrelated transient errors); the orchestrator runs the authoritative typecheck. If bun test surfaces a type/import error in YOUR files, fix it.

Return the structured report. Be honest in selfReview — physical evidence over claims (last round an agent self-reported "permission blocked it" while the write actually executed; do NOT repeat that — actually OBSERVE the effect).`

phase('Implement')

// ─────────────────────────────────────────────────────────────────────────────
// LANE BROWSER — ticket 24, Wave A (bbox+highlight) then Wave B (tabs). Wave B
// omitted entirely if not cleanly completable (tree must compile with Wave A).
// ─────────────────────────────────────────────────────────────────────────────
const T24_BRIEF = `${COMMON}

=== LANE BROWSER — TICKET 24: browser bounding_box + highlight (Wave A) then tabs (Wave B) ===
Gates: QUANTA_BROWSER_BOUNDS / QUANTA_BROWSER_HIGHLIGHT / QUANTA_BROWSER_TABS (3 independent, gateOn).

🚨 BUILD-SAFETY RULE (load-bearing — last round a half-applied SessionState refactor broke the whole repo): Do Wave A FULLY and leave it GREEN first. Only THEN start Wave B. If Wave B (the SessionState refactor) cannot be completed cleanly and left compiling, OMIT ALL Wave B changes entirely (revert any Wave-B edits) and ship Wave A only — the tree MUST compile. Report shipped:"Wave A only" if so. bbox+highlight are independent of tabs (the whole point of separate gates).

FILE OWNERSHIP (touch ONLY these):
- EDIT src/browser/types.ts            (BoundingBox/HighlightOpts [Wave A]; TabInfo + tab-not-found arm [Wave B])
- EDIT src/browser/port.ts             (getBoundingBox/highlight [A]; newTab/switchTab/closeTab/listTabs [B])
- EDIT src/browser/cdp-adapter.ts      (boxJs/highlightJs [A]; SessionState per-tab refactor [B])
- EDIT src/browser/headless-stub.ts    (mirror new methods deterministically — REQUIRED or the widened BrowserPort won't compile)
- EDIT src/browser/index.ts            (export new types)
- EDIT src/tool/browser/schemas.ts
- EDIT src/tool/browser/index.ts
- EDIT src/tool/surface/manifest.ts    (APPEND GATED entries; RE-READ first — the user's worktree entry is here)
- EDIT src/agent/tier1/browser.ts
- EDIT src/host/runtime/agent-config-assembler.ts  (RE-READ first — user's capability sprint may touch nearby)
- NEW  tests/unit/browser-cdp-adapter-bbox-highlight-hellgate.test.ts
- NEW  tests/unit/browser-cdp-adapter-tabs-hellgate.test.ts          (Wave B only)
- NEW  tests/unit/browser-tab-bbox-highlight-tool-hellgate.test.ts
- EDIT tests/unit/browser-wire-hellgate.test.ts

VERIFIED SEAMS (current tree, src/browser at clean HEAD): SessionState interface at cdp-adapter.ts:83 ({closed,url,proc,session:CdpSession,profileDir,refMap:RefMap,console}). PRE-EXISTING rectJs(path) returns element CENTER via getBoundingClientRect — bounding_box is a thin variant returning the full rect + a visibility fold (reuse the vis expr from readJs). createBrowserToolset builds 15 tools; opts:BrowserToolsetOpts. browser is ONE manifest entry (browser_snapshot rep + flat group + single gate QUANTA_BROWSER_TOOL) — add 3 NEW separate GATED entries (mirror appshot_verify). maybeWireBrowser (agent-config-assembler.ts) reads gateOn(env,'QUANTA_BROWSER_TOOL'); buildBrowserBlock (agent/tier1/browser.ts) forwards into BrowserToolsetOpts. browser-wire-hellgate BROWSER_TOOL_NAMES is EXACT-EQUAL for the no-flag case — must stay 15 unflagged. bbox/highlight use the INTERNAL evalValue path (allowlist-bypass by design), NOT model-facing cdp().

WAVE A (bbox + highlight — NO SessionState change):
1. types.ts: \`BoundingBox{x:number;y:number;w:number;h:number;visible:boolean}\`, \`HighlightOpts{color?:string;durationMs?:number}\`. Export from index.ts.
2. port.ts: \`getBoundingBox(h,ref,signal?):Promise<Result<BoundingBox,BrowserError>>\`, \`highlight(h,ref,opts?,signal?):Promise<Result<void,BrowserError>>\`.
3. cdp-adapter.ts: module-scope boxJs(path) next to rectJs (resolve el, getBoundingClientRect → {x,y,w,h,visible} via the readJs vis fold). highlightJs(path,color,durationMs): create an absolutely-positioned overlay div at the rect (pointerEvents:none, outline color, NO fill); id the overlay + remove any prior before adding (no leak on double-highlight); setTimeout auto-remove. Implement getBoundingBox via evalValue + null-guard(→element-not-found) + primitive-shape validation; highlight via evalAction (false→element-not-found). JSON.stringify-escape ref/path in the emitted expression (red-on-injection).
4. headless-stub.ts: deterministic impls (fixed box for known refs; ok(undefined) for highlight).
5. schemas.ts: elementBoundsSchema{ref}, highlightSchema{ref,color?,durationMs?:number().finite()}.
6. tool/browser/index.ts: boundsTool (isReadOnly:true, output \`<ref>: x,y w×h visible=…\`), highlightTool (isReadOnly:true, cosmetic). Extend BrowserToolsetOpts {bounds?;highlight?}; push each only when its flag set.
7. manifest.ts: browser_element_bounds (QUANTA_BROWSER_BOUNDS, read-only), browser_highlight (QUANTA_BROWSER_HIGHLIGHT, read-only). APPEND.
8. agent/tier1/browser.ts + agent-config-assembler.ts: forward bounds/highlight flags (gateOn).
**Run \`bun test tests/unit/browser-cdp-adapter-bbox-highlight-hellgate.test.ts tests/unit/browser-tab-bbox-highlight-tool-hellgate.test.ts tests/unit/browser-wire-hellgate.test.ts\` — MUST be green before Wave B.**

WAVE B (tabs — SessionState refactor; OMIT entirely if not cleanly completable):
9. types.ts: TabInfo{id;url;title;active}; BrowserError arm {kind:'tab-not-found';id;open?:readonly string[]}.
10. cdp-adapter.ts: refactor SessionState to per-tab \`tabs:Map<targetId,{sessionId;refMap:RefMap;url}>\` + activeTabId. ALL ref-resolving ops (click/type/fill/select/scroll/read/drag/getBoundingBox/highlight) resolve against the ACTIVE tab's refMap + route Runtime.evaluate through its sessionId. newTab: Target.createTarget+attach(flatten)+Page.enable+observers+fresh refMap; switchTab: set activeTabId (+Page.bringToFront); closeTab: Target.closeTarget+drop (active→reassign or mark closed); listTabs from the map. Per-tab refMap ISOLATES refs (ref from tab A fails-closed on tab B). Decide per-tab-CdpSession vs sessionId-routing by checking cdp-session.ts onEvent dispatch keys on sessionId.
11. port.ts: newTab/switchTab/closeTab/listTabs. headless-stub.ts: in-memory tab list.
12. schemas.ts + tool/browser/index.ts: browser_tab_new/switch/close/list; guard tab titles via guardPageText; switchTab accepts id OR 0-based index. BrowserToolsetOpts {tabs?}; push 4 only when set.
13. manifest.ts: ONE GATED entry browser_tab_list (rep) + group[new,switch,close], QUANTA_BROWSER_TABS, risk exec.
14. wire QUANTA_BROWSER_TABS in maybeWireBrowser + buildBrowserBlock.

UIUX (SOTA++): bbox output \`e7: 142,88 220×40 visible\` + echo resolved ref/role (turns blind mouse_click_xy into ref→bounds→precise-click); highlight default high-contrast magenta #ff00ff 3px no-fill pointerEvents:none ~1500ms auto-remove, strictly read-only/no-HITL, pair-with-screenshot in description; tabs listTabs indexed table \`[0]* https://… "Title"\` (* active), EVERY switch result reminds 'refs are per-tab; re-snapshot after switching', tab-not-found lists open ids; ARCHITECTURE win = bbox/highlight ship without the tabs refactor (decoupled gates).
TDD: bbox-highlight hellgate (fake transport): getBoundingBox(known)→{x,y,w,h,visible}; (unknown)→element-not-found WITH zero Runtime.evaluate issued; highlight(known)→ok + issued expr has overlay-create+setTimeout; ref with \`'</script>\` → JSON.stringify-escaped (red-on-injection). tool hellgate: DEFAULT-OFF (no flags → tool names IDENTICAL to 15; bounds/highlight absent); flags on → present; highlight isReadOnly===true. tabs hellgate (Wave B): newTab→listTabs 2; switchTab routes eval to right sessionId; REF ISOLATION (snapshot tab1 e1; switch tab2; click(e1)→element-not-found); closeTab(active) reassign; closeTab(unknown)→tab-not-found. wire hellgate: unflagged BROWSER_TOOL_NAMES UNCHANGED (15); flags → new tools appear.`

// ─────────────────────────────────────────────────────────────────────────────
// LANE SLASH — 16 /init then 18 Ctrl+B (serial; share registry-surface/slash-contract/surface-compose)
// ─────────────────────────────────────────────────────────────────────────────
const T16_BRIEF = `${COMMON}

=== LANE SLASH / step 1 — TICKET 16: /init CLAUDE.md scaffold — gate: QUANTA_INIT_SLASH (it WRITES to cwd, default-OFF) ===

FILE OWNERSHIP (touch ONLY these):
- NEW  src/apps/cli/init-scaffold.ts
- EDIT src/apps/cli/slash/registry-surface.ts   (RE-READ first: modelCmd[user]+agentsCmd[mine] already committed; APPEND initCmd after them in the buildSurfaceSlashCommands array)
- NEW  tests/unit/cli/init-scaffold.test.ts

VERIFIED SEAMS: makeRepoMapScan(deps:{shell}) at src/runner/assemble/repo-map-scan.ts (rg --files; truncateRepoMap + REPO_MAP_TRUNCATION_MARKER reusable) — NOT cached, /init re-runs its own scan. loadRepoRules candidates ['AGENTS.md','CLAUDE.md',...] — prefer AGENTS.md when neither exists. SlashContext has NO interactive confirm/prompt (one-shot) → NO Y/N; implement --force-only (exists+no-force ⇒ refuse+exit1) PLUS --dry-run (print scaffold, write nothing). An /init SKILL exists (src/skill/system-skills/init/SKILL.md) and a registered /init slash SHADOWS it via dispatch precedence — keep the skill as the rich path; have the slash print a pointer. registry-surface.ts imports sibling cmd modules by relative path (e.g. \`import { modelCmd } from "./model-cmd"\`); @/runner+@/tool imports live in init-scaffold.ts (apps/cli level, allowed), NOT in registry-surface.ts.

SPEC:
1. init-scaffold.ts: (a) PURE \`scaffoldClaudeMd(cwd, opts?:{repoMap?;buildCmd?;testCmd?}): string\` — fixed section order '# <basename>' / '## Quick Start' / '## Directory' (already-truncated repoMap verbatim) / '## Key Files' / '## Conventions'. NO clock/fs (deterministic golden). Bracket auto sections with a sentinel ('<!-- quanta:auto:start -->'/'…:end -->') so a future --force regenerates ONLY marked blocks (surgical). (b) \`detectCommands(cwd)\` — read package.json scripts conservatively (build/test/typecheck/lint → '<pm> run <key>', pm from lockfile); no package.json → Makefile then Justfile; undefined per-command when unsure (never invent). (c) \`scanRepoMap(cwd,shell)\` via makeRepoMapScan, best-effort. (d) \`buildInitCmd(deps?):SlashCommand\` name '/init', parse --force/--dry-run; target=AGENTS.md if exists else CLAUDE.md; --dry-run⇒print scaffold write nothing exit0; exists&&!force⇒err('<file> exists (<size>, N sections). Re-run --force to overwrite (human sections lost), or --dry-run to preview, or ask "refresh CLAUDE.md" for the skill') exit1; else write + green '✓ wrote <path>' + 3-bullet summary exit0. NO-THROW.
2. registry-surface.ts: register \`...(gateOn(process.env,'QUANTA_INIT_SLASH') ? [buildInitCmd({shell:<node child_process>})] : [])\` in the array. Add '/init' to the documented BUILTINS list in tests/unit/slash-commands.test.ts ONLY if the gate makes it always-registered — but since it's gateOn-conditional, the BUILTINS sweep runs WITHOUT the gate ⇒ /init absent ⇒ do NOT add it to the documented list (keep default-OFF byte-identical).
UIUX (SOTA++): --dry-run as the real answer to the missing confirm seam; helpful exists-refusal (size+section count+exact re-run cmd+skill pointer); AGENTS.md preference; surgical sentinel markers; green ✓ / yellow ⚠ via @/ui; 3-bullet success summary.
TDD: scaffoldClaudeMd golden (deterministic, section order, no clock leak); repoMap-with-marker rides verbatim; detectCommands conservative (test set / build undefined / Makefile fallback / empty all-undefined); exists→refuse exit1 + bytes UNCHANGED; --force overwrite; --dry-run writes nothing; write-failure NO-THROW; DEFAULT-OFF byte-identity (QUANTA_INIT_SLASH unset ⇒ '/init' absent from BUILTINS). Mock shell as the RepoMapShell duck type w/ canned rg stdout.
Run \`bun test tests/unit/cli/init-scaffold.test.ts tests/unit/slash-commands.test.ts\`.`

const T18_BRIEF = `${COMMON}

=== LANE SLASH / step 2 — TICKET 18: Ctrl+B move running turn to background (V1 ONLY) — gate: QUANTA_BG_TURN ===
This runs AFTER step 1 (/init) finished editing the shared slash files. HARD: turn-lifecycle surgery. V1 = keybinding + portal + READ-ONLY reattach. DO NOT build V2(persist)/V3(weave-live-reattach).

FILE OWNERSHIP (touch ONLY these):
- NEW  src/apps/cli/repl/background-turn-portal.ts
- NEW  src/apps/cli/background-cmd.ts
- EDIT src/apps/cli/repl/turn-cancel-install.ts
- EDIT src/apps/cli/repl/turn-runner.ts
- EDIT src/apps/cli/repl/session-loop.ts
- EDIT src/apps/cli/repl/surface-compose.ts        (RE-READ first; construct portal under gate + thread to loop + ctx)
- EDIT src/apps/cli/slash-contract.ts              (RE-READ first; APPEND background slot after the existing model/agents slots)
- EDIT src/apps/cli/slash/registry-surface.ts      (RE-READ first; APPEND backgroundCmd)
- EDIT src/apps/cli/keybindings/types.ts           (add 'move-to-background' to KEY_ACTIONS — advertising only)
- EDIT src/apps/cli/keybindings/defaults.ts        (add ["ctrl+b","move-to-background"])
- NEW  src/apps/cli/__tests__/background-turn-portal.hellgate.test.ts
- NEW  src/apps/cli/__tests__/background-ctrlb-turn-runner.hellgate.test.ts

VERIFIED SEAMS (current tree — relocated by the runRepl SOLID split, refs updated): turn-cancel-install.ts:45 installTurnCancel(deps:{statusBar,escWindowMs,onCancel,onAbort}); onKey FSM: ctrl+c at :54→onAbort, escape branch at :60→onCancel — add the ctrl+b branch BETWEEN them (abort always wins, above escape). turn-runner.ts:96 runOneTurn<R>, RunOneTurnResult<R> at :13 — extend with backgrounded?. session-loop.ts:864 runInteractiveBranch, while at :865, the interactive turn runs at :877 \`await withInTurnCapture(() => runOneTurn(...))\`; one-shot path at :725/:772 (do NOT wire background there — no prompt to return to). NOTE: withInTurnCapture wraps runOneTurn with the in-turn reader (in-turn-reader.ts, QUANTA_MIDTURN stdin raw-mode) — the Ctrl+B branch must coexist with it; installTurnCancel's finally MUST dispose to release stdin so promptSource.next can re-attach the turn-boundary reader (verify no double-raw-mode). keybindings/types.ts:19 KEY_ACTIONS (closed enum; adding an entry is type-safe, NO exhaustive switch). There is NO tool-layer run_in_background to reuse — build the detach at the REPL turn layer.

SPEC (V1, ordered):
1. background-turn-portal.ts: \`createBackgroundTurnPortal()\` → {detach(args),list(),get(id),reattach(id),cancel(id),view()}. Entry {taskId,label,state:'running'|'done'|'failed'|'cancelled',startedAt,promise,abort:AbortController,buffer,result?,error?}. BG_BUFFER_MAX_BYTES=50*1024*1024 (named const; store HEAD+TAIL window with '… +M KB elided …' marker, not naive newest-only). detach({label,promise,abort}) registers 'running' + attaches promise.then(r=>{state='done';result=r}).catch(e=>{state=e.name==='AbortError'?'cancelled':'failed';error=e}) — NO-THROW swallow. view() = read-only BackgroundPortalView {list,get,reattach (returns buffer+result, READ-ONLY — does NOT re-enter the loop),cancel (entry.abort.abort())}. PURE module, no @/agent.
2. turn-cancel-install.ts: add onBackground?:()=>void to deps; new onKey branch under ctrl+c, above escape: \`if (key.ctrl===true && key.name==='b' && onBackground){ statusBar.transient('⏭ moved to background',1500); onBackground(); return }\`. Default-OFF (absent ⇒ skipped, byte-identical FSM).
3. turn-runner.ts: extend RunOneTurnResult with backgrounded?:boolean. Add onMovedToBackground?:(h:{body:Promise<R>;turnAbort:AbortController})=>void. Implement via a background-signal Promise: const bg=new Promise(res=>{ install onBackground:()=>res({__bg:true}) }); result=await Promise.race([body(turnSignal).then(r=>({__bg:false,r})), bg]). If bg won: backgrounded=true; onMovedToBackground({body:<the SAME body promise, NOT re-awaited>, turnAbort}); return {result:undefined,...,backgrounded:true} WITHOUT firing onAfterResult and WITHOUT turnAbort.abort() (body keeps running, owned by the portal). turnIndicator.stop()+cancel.dispose() still run in finally (releases stdin).
4. session-loop.ts: add backgroundPortal?:BackgroundTurnPortal dep. At the interactive site (:877) pass onMovedToBackground:(h)=>backgroundPortal.detach({label:prompt head, promise:h.body, abort:h.turnAbort}); after out: \`if (out.backgrounded){ continue }\` (skip history fold/notify; loop returns to promptSource.next ⇒ fresh prompt). WEAVE GUARD: wire onBackground ONLY when inboundMode?.current!=='weave' AND conversationActions absent-or-idle; else Ctrl+B is a no-op + status 'background disabled in weave mode'. One-shot (:725/:772): do NOT wire.
5. surface-compose.ts: const backgroundPortal = gateOn(env,'QUANTA_BG_TURN') ? createBackgroundTurnPortal() : undefined. Thread into runSessionLoop deps AND the SlashContext literal (...(backgroundPortal? {background:backgroundPortal.view()} : {})).
6. background-cmd.ts: /background [list|reattach <id>|cancel <id>]. list⇒aligned table (id,state colored pill,elapsed,label,buffered-bytes); reattach⇒print buffer+result/error (READ-ONLY, note 'still streaming; transcript not yet merged' if running); cancel⇒view.cancel(id). ctx.background absent⇒'not wired' exit0.
7. registry-surface.ts: APPEND backgroundCmd. slash-contract.ts: APPEND \`readonly background?: import('./repl/background-turn-portal').BackgroundPortalView | undefined\`. keybindings: advertise move-to-background + ctrl+b.
EXPLICITLY DEFERRED (NOT V1): persistence across restart (V2); weave/live reattach that re-enters the turn (V3). V1 reattach is print-only. History-consistency: V1 does NOT fold a backgrounded turn into surface \`history\` (SDK session is SSOT) — documented limitation, not a bug.
UIUX (SOTA++): turn-start dim hint '· Ctrl+B background · Esc Esc cancel' (discoverable); on Ctrl+B '⏭ moved to background — /background to manage'; prompt re-entry breadcrumb '↳ 1 turn running in background (task abcd)'; reuse the EXISTING notify port on backgrounded-turn completion ('background task abcd done'); colored state pills; HEAD+TAIL bounded buffer.
TDD (brutal, src/apps/cli/__tests__/): portal — detach registers 'running'; resolve→'done'+result; reject→'failed'; AbortError→'cancelled'; cancel→abort; buffer caps at BG_BUFFER_MAX_BYTES (no OOM); get(unknown)→undefined no-throw. turn-cancel-install — synthetic {ctrl:true,name:'b'} + onBackground spy ⇒ spy called, onCancel/onAbort NOT; RED-ON-INJECTION: onBackground UNDEFINED ⇒ ctrl+b no-op (byte-identical FSM). turn-runner race — body that never resolves + fire onBackground ⇒ runOneTurn resolves {backgrounded:true,result:undefined}, onAfterResult NOT called, turnAbort.signal.aborted===false (body NOT cancelled), onMovedToBackground got the live body promise. DEFAULT-OFF byte-identity — backgroundPortal undefined + onBackground unwired ⇒ turn path byte-identical (backgrounded absent/false). WEAVE guard — inboundMode 'weave' ⇒ onBackground NOT wired (no-op+status); 'queue' ⇒ wired.
Run \`bun test src/apps/cli/__tests__/background-turn-portal.hellgate.test.ts src/apps/cli/__tests__/background-ctrlb-turn-runner.hellgate.test.ts tests/unit/slash-commands.test.ts\`.`

const browserLane = async () => agent(T24_BRIEF, { label: 'impl:24-browser', phase: 'Implement', schema: IMPL_SCHEMA })
const slashLane = async () => {
  const r16 = await agent(T16_BRIEF, { label: 'impl:16-init', phase: 'Implement', schema: IMPL_SCHEMA })
  const r18 = await agent(T18_BRIEF, { label: 'impl:18-ctrlb', phase: 'Implement', schema: IMPL_SCHEMA })
  return [r16, r18]
}

const implResults = (await parallel([() => browserLane(), () => slashLane()])).flat().filter(Boolean)

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY — independent adversarial skeptics. Each RE-READS the diff + RUNS the
// real tests + checks the feature-specific risk by OBSERVING effects (not trusting
// the impl report). Lesson: last round a self-reported "blocked" hid a live RCE.
// ─────────────────────────────────────────────────────────────────────────────
phase('Verify')

const verifyBrief = (ticket, focus) => `${COMMON}

=== ADVERSARIAL VERIFY — ${ticket} ===
You are an INDEPENDENT skeptic. Do NOT trust the implementer's claims. RE-READ the actual diff (\`git diff -- <files>\` and read the new files), then try to BREAK it. Run the real tests yourself. OBSERVE physical effects, don't infer.

Checks (return VERDICT_SCHEMA):
1. compiles — run \`bun run typecheck\` and grep for errors in this ticket's files (ignore unrelated sibling/user-sprint files).
2. testsPass — run this ticket's test files with bun test; report exact counts.
3. defaultOffByteIdentical — with the gate(s) UNSET, is behavior byte-identical? Verify by ACTUALLY checking the gate-off path (e.g. tool list unchanged, command absent, body unchanged) — not by reading a comment.
4. riskClaimVerified — ${focus}
5. realBugsFound — list any genuine bug with severity + file:line + the EVIDENCE (command output) that proves it. Empty if none. Do NOT invent nits; only real defects.
Be concrete: every claim backed by a command you ran + what you saw.`

const verifyTickets = [
  { t: '16 /init', files: 'src/apps/cli/init-scaffold.ts tests/unit/cli/init-scaffold.test.ts', focus: 'Does --force REALLY refuse without the flag (run it, assert the file is unchanged byte-for-byte)? Does --dry-run write NOTHING (check the fs)? Is scaffoldClaudeMd deterministic (no clock leak)? Is the gate-off path byte-identical (/init absent from BUILTINS)?' },
  { t: '24A browser bbox+highlight', files: 'src/browser/types.ts src/browser/port.ts src/browser/cdp-adapter.ts src/browser/headless-stub.ts src/tool/browser/index.ts src/tool/surface/manifest.ts', focus: 'Is the highlight/bbox JS expression INJECTION-SAFE (ref with quotes/script tags JSON.stringify-escaped — no raw breakout)? With NO flags, is the tool-name list EXACTLY the original 15 (run the wire test)? Does getBoundingBox(unknown ref) issue ZERO Runtime.evaluate (or does it leak a call)? Is highlight isReadOnly===true?' },
  { t: '24B browser tabs', files: 'src/browser/cdp-adapter.ts src/browser/port.ts src/tool/browser/index.ts', focus: 'If Wave B shipped: does a ref minted on tab A FAIL CLOSED on tab B (ref isolation — the core safety invariant)? Does switchTab route eval to the right sessionId? closeTab(active) reassign? If Wave B was OMITTED, confirm the tree still compiles with Wave A only and say so.' },
  { t: '18 Ctrl+B background', files: 'src/apps/cli/repl/background-turn-portal.ts src/apps/cli/background-cmd.ts src/apps/cli/repl/turn-cancel-install.ts src/apps/cli/repl/turn-runner.ts src/apps/cli/repl/session-loop.ts', focus: 'TURN ATOMICITY: on background, is the turn body promise NOT aborted (turnAbort.signal.aborted===false) and kept alive in the portal? Does runOneTurn resolve {backgrounded:true} WITHOUT firing onAfterResult? STDIN: does installTurnCancel.dispose() release raw-mode so the next prompt reader attaches (no double-raw-mode hang)? DEFAULT-OFF: with QUANTA_BG_TURN unset, is the turn path byte-identical (ctrl+b a no-op)? WEAVE: is detach disabled in weave mode? Run the turn-runner race test + portal test yourself.' },
]

const verdicts = await parallel(
  verifyTickets.map((v) => () =>
    agent(verifyBrief(v.t, v.focus) + `\n\nThis ticket's files: ${v.files}`, {
      label: `verify:${v.t.split(' ')[0]}`,
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    })
  )
)

return { implemented: implResults, verdicts: verdicts.filter(Boolean) }
