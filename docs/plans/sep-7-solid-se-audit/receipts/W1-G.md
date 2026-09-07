# W1-G receipt — Sep-07 SOLID/SE and duplicate-development audit

```text
AUDIT_ASSIGNMENT|lane=G|scope=apps,host,sdk,ui,workflow,scheduler,reactor,observability,radar|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-G.md
```

## Snapshot

W0 receipt was **absent** at start and still absent at write. Coordinator
assigned lane G against a dirty shared checkout and defined **tracked HEAD-only**
scope: uncommitted production bytes are outside the completion claim.

| Field | Value |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| ahead/behind | `0 0` |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged/tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked manifest SHA-256 (pre) | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` (7 files) |
| untracked manifest SHA-256 (post) | `1e646eb124287a5ab50343ee753bf25ce576b16db137cbac913a0019e062acf9` (8 files) |
| untracked delta during inspection | `+docs/plans/sep-7-solid-se-audit/receipts/W1-C.md` (sibling lane C receipt) |
| G production dirty vs HEAD | 3 files (classified from **HEAD blobs**, not working tree) |

Dirty G production paths (working tree ≠ HEAD; SEP6 overlay, not this claim):

- `src/apps/cli/at-autocomplete/provider.ts`
- `src/apps/cli/session-registry-cmd.ts`
- `src/host/runtime/internal/mention-source-deps.ts`

HEAD/staged/unstaged production hashes are unchanged from the pre-inspection
freeze. The untracked manifest grew by a campaign receipt, not by production
source. If a later W0 names a different HEAD or a different **tracked** diff
hash, this receipt is **STALE**. W2-X must not treat the untracked-hash drift
from sibling receipts as a production-snapshot change.

Authority-document hashes:

| Path | SHA-256 |
|---|---|
| AGENTS.md (HEAD=WT) | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md (WT) | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` |
| docs/ARCHITECTURE.md (HEAD) | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| package.json | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` |
| biome.json | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` |
| tsconfig.json | `622ad399076687a1e3cdc01ce3b0b46edd344e2bb3da963bf0ea30223a77564b` |
| tsconfig.base.json | `c4ca874cd213452f545c273569a8d220566d763188bb26b64f77433ef51aa22f` |
| tsconfig.typecheck.src.json | `da1da7a381f8ec7b172c78985569df66f1e13e88d7ab0066b1137eaa90eb3320` |
| tsconfig.typecheck.tests.json | `3449f97ec6694b101f4784ab1116c284906d25e10ddc30805de471ee487f0fd0` |
| tsconfig.sdk-dts.json | `aea2027ae92f1a2e9d8de93f132b290784ee462e3bf3e4e4741cc1e7f362fa10` |
| tsconfig.sdk-dts-bundle.json | `114ed839a9cb19f221d8e17a8177b40d6277411b6e8e625e6395e6ebb90e50af` |
| tests/unit/_arch/slice-boundary-configs.ts (WT) | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` |
| tests/unit/_arch/slice-boundary-configs.ts (HEAD) | `315560288012f4e6f2cc149f0605a539faac9676149e2e606fb3580a89115697` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

`docs/ARCHITECTURE.md` and `slice-boundary-configs.ts` differ HEAD vs working
tree. Those files are W2/W3 reserved. Lane G did not treat the dirty
ARCHITECTURE text as ownership proof.

God-code detector over the 891 G production files (working-tree bytes; the three
dirty files are larger/smaller only by the SEP6 overlay and stay below 1000):
**0 god-MODULE**, **0 god-FUNCTION**, **9 approaching-cohort (900–999)**.

## Coverage counts

| Universe | Count |
|---|---:|
| Exclusive production `src/{apps,host,sdk,ui,workflow,scheduler,reactor,observability,radar}/**/*.ts` (HEAD-tracked, tests excluded) | 891 |
| Classified | 891 |
| Unclassified | 0 |
| Colocated tests under those trees | 113 |
| Deep-inspected owner+consumer clusters | 28 files listed below |
| Structure-classified remainder | 863 |
| God-MODULE >1000 in G | 0 |
| Cohort 900–999 in G | 9 |
| God-FUNCTION >150 (official detector) | 0 |
| Total production lines | 176973 |

By slice:

| Slice | Files | Lines |
|---|---:|---:|
| apps | 656 | 133855 |
| host | 80 | 17145 |
| observability | 91 | 15706 |
| scheduler | 18 | 4164 |
| sdk | 23 | 2969 |
| reactor | 6 | 1108 |
| workflow | 8 | 999 |
| radar | 7 | 756 |
| ui | 2 | 271 |

Apps subtrees:

| Subtree | Files | Lines |
|---|---:|---:|
| cli | 298 | 58340 |
| bench | 213 | 46999 |
| eval | 63 | 12723 |
| web-daemon | 51 | 10170 |
| agent | 15 | 2529 |
| terminal | 5 | 1250 |
| probe | 5 | 1010 |
| headless | 6 | 834 |

Role-heuristic census (path contract, not basename uniqueness):

| Role | Count |
|---|---:|
| impl | 645 |
| barrel | 53 |
| surface-command | 47 |
| composition-wire | 41 |
| types-or-port | 40 |
| adapter | 24 |
| bootstrap | 13 |
| slash-surface | 12 |
| composition-root | 7 |
| port | 5 |
| parser | 2 |
| schema | 2 |

Cohort 900–999 (inventory for W2-P, not findings by themselves):

1. `src/apps/bench/promax/campaign/gates.ts` 985
2. `src/apps/bench/remote/pool/worker.ts` 962
3. `src/apps/bench/commands/box.ts` 960
4. `src/apps/terminal/brain-mode.ts` 959
5. `src/apps/eval/index.ts` 956
6. `src/apps/cli/rewind-cmd.ts` 938
7. `src/apps/bench/remote/box-session/ec2-lifecycle.ts` 934
8. `src/apps/bench/run-main.ts` 929
9. `src/host/mcp-composition.ts` 923

## Inspected consumer paths

Owner code plus at least one reachable consumer was read for every cluster
below. Foreign slices were not inspected as if owned.

| Owner (G) | Consumer inspected | Lane of consumer |
|---|---|---|
| `host/bootstrap/bootstrap-session.ts` | `apps/cli/repl/session-setup.ts:399`, `apps/headless/session-bridge.ts:111`, `apps/terminal/brain-mode.ts:796` | G |
| `host/bootstrap/bootstrap-session/prepare-runtime.ts:192` | CLI `deps.loadFeatures` → `apps/cli/internal.ts#loadMcpFeatures` | G |
| `host/mcp-composition.ts#loadMcpToolsOrEmpty` | CLI `internal.ts:528` (no catch); web `runtime-factory/daemon-mcp.ts:71` (outer catch) | G |
| `host/mcp-composition.ts:121-135` factory | always `new McpClient`; env `MCP_USE_ISOLATED_SPAWN` unused | C owner, G consumer |
| `host/bootstrap/live-posture-runtime.ts` | CLI `repl.ts:288` fail-soft store load; web `resolveWebLivePosture` | G |
| `host/runtime/usage-accounting-wire.ts` | `host/runtime/agent-config-assembler.ts:121`; CLI mint is **not** this helper | G |
| `host/bootstrap/bootstrap-session/tooling-bundle.ts:186` | `bootstrapSession` result → CLI `session-setup.ts:773` | G |
| `apps/web-daemon/runtime-factory.ts:178` | `createRuntimeFromAgentConfigBase`; `server.ts:453` `prepareHydrate` | G |
| HEAD `host/runtime/internal/mention-source-deps.ts:117` `firstLineOf` | subagent autocomplete descriptions; WT overlay uses `@/shared` | G / A foreign siblings |
| HEAD `apps/cli/at-autocomplete/provider.ts:79` `firstLineOf` | autocomplete `detail` column | G |
| `observability/pricing.ts#costUsd` | unknown model → `null` | G |
| `observability/prompt-cache/default.ts:181` | unknown model → sonnet fallback + warn-once | G |
| `observability/usage-accounting/price.ts` | `pricing.ts` delegates; `pricingKnown` | G |
| `observability/metrics/in-memory-registry.ts` | sink no-throw; series cap `maxSeriesPerName` | G |
| `scheduler/next-fire.ts` | `scheduler/automation-engine` tick | G |
| `scheduler/automation-engine/sqlite.ts#markRun` | 3-table transaction | G |
| `reactor/trigger-source-pr-comment.ts` | `tests/unit/reactor-pr-comment-watermark-hole-hellgate.test.ts` | G / tests |
| `radar/jsonl-file-store.ts` | `apps/cli/repl/surface-compose/wire-builders.ts#buildRadarStore`; `agent/radar-producer-hook.ts` (A) | G / A |
| `sdk/index.ts` | `sdk/runtime` + protocol re-exports; `surfaceIsolationOnly` | G |
| `ui/ui-helpers.ts` | CLI chrome renderers | G |
| `workflow/executor.ts` | CLI/web workflow gate (default-OFF) | G |
| `apps/cli/session-registry-cmd.ts` (HEAD) | `@/agent/session-resource-registry` inspector/GC | A owners, G slash |
| `apps/cli/session-transcript-retention.ts` | `/session-registry cleanup` | G composition over D+stream |
| `apps/agent/mode-presets/interactive.ts` | `assembleAgentConfig` via `apps/agent/assemble.ts` → host assembler | G |
| `apps/agent/mode-presets/stream-json-sink.ts` | silent drop of unmapped `AgentEvent` | G / D26 |
| `apps/web-daemon/runtime-factory.ts` | does **not** call `bootstrapSession` | G (D21 comparison) |
| `host/runtime/agent-config-assembler.ts` | web + mode-presets | G |
| `apps/bench/remote/pool/types.ts#sleepReal` | `pool/worker.ts`, `launch-window.ts` | G |
| `apps/bench/remote/lease-fs.ts#sleepReal` | lease poll | G |

## Findings

Retired SEP5/SEP6 IDs were not reopened unless the documented trigger is
reproduced on this HEAD. D21 (merge CLI/web boot) is **not** reopened: there is
still no written common session-bootstrap I/O contract and no behavioral-parity
RED. D22 is **not** reopened: `sleepReal` copies exist but the owning files are
not in the G dirty set and no sleep-duration drift was measured. D26 is **not**
reopened: `stream-json-sink.ts` documents non-exhaustive mapping; no newly
dropped event was identified.

SEP6 S8 claims `src/shared/mention-text.ts` as owner. That file is **not in
HEAD** (`fatal: exists on disk, but not in HEAD`). The closeout hellgate is
untracked. On this snapshot the local `firstLineOf` owners are live.

### G-F1 [P2] MCP load failure policy: CLI fail-closed vs web fail-open

- **status:** open
- **attribution:** pre-existing
- **invariant:** what happens when MCP config/load throws during interactive boot
- **owner 1:** `src/apps/cli/internal.ts:500-528` `loadMcpFeatures` awaits
  `loadMcpToolsOrEmpty` with **no catch** in that file. Consumer:
  `src/host/bootstrap/bootstrap-session/prepare-runtime.ts:192-198` rethrows
  after closing the session egress proxy → CLI/headless/brain `bootstrapSession`
  fails.
- **owner 2:** `src/apps/web-daemon/runtime-factory/daemon-mcp.ts:53-97` wraps the
  **same** host helpers (`readMcpConfig`, `loadMcpToolsOrEmpty`) in `try/catch`,
  logs `web-daemon: MCP load failed`, returns `{ tools: [], clients: [], mcpAccessor: undefined }`.
- **shared producer:** `src/host/mcp-composition.ts:894-900` `loadMcpToolsOrEmpty`
  (throws through; empty only when `mcpConfigs.length === 0`).
- **measured drift:** broken MCP config / `loadMcpTools` throw → CLI session
  does not start; web daemon boots with no MCP tools and no `/mcp` readout.
  Web comment at `daemon-mcp.ts:8-9` states this is intentional ("NEVER throws").
- **failure mode:** operator-visible capability set diverges across surfaces
  for the same `.mcp.json` fault. Web warn-only can look like "MCP is off"
  (`mcpAccessor` undefined), not "MCP load failed". Empty tools is fail-closed
  for extra capability, fail-open for boot availability.
- **not D21:** this is not a proposal to merge CLI/web boot. It is one
  failure-policy invariant with two live writers on one host producer.
- **test honesty:** no test asserts web swallow vs CLI throw. Removing the web
  `catch` would not turn an existing rail RED.
- **proposed write set (G):** `src/apps/web-daemon/runtime-factory/daemon-mcp.ts`
  and/or a host-owned load-fault policy consumed by both `loadMcpFeatures` and
  `loadDaemonMcp`. **Forbidden:** merging `session-setup.ts` with
  `runtime-factory.ts` (D21). **Forbidden foreign:** `@/agent` `loadMcpTools`
  body (A) except if W2-X assigns a typed fault.
- **proof limit:** static control-flow. Broken `.mcp.json` / throwing
  `loadMcpTools` was not executed.

### G-F2 [P2] HEAD still has local mention first-line owners; trim drift vs lane A (S8 trigger reproduced)

- **status:** open
- **attribution:** pre-existing (SEP6 S8 overlay is uncommitted)
- **reopens:** S8 / SEP5 D8 **only** because the documented trigger (measured
  trim drift across live first-line owners) is true on HEAD. The shared owner
  `src/shared/mention-text.ts` is untracked and not in this snapshot.
- **G owner 1 (HEAD):** `src/host/runtime/internal/mention-source-deps.ts:117-120`
  `firstLineOf`: empty/non-string → `""`; cut on `/\r?\n/`; **`.trim()`**.
- **G owner 2 (HEAD):** `src/apps/cli/at-autocomplete/provider.ts:79-81`
  `firstLineOf`: cut on `/\r?\n/`; **`.trim()`**. String-only.
- **foreign owners (A, not G write):** HEAD
  `plugin-app-resolver/plugin-resolver.ts` and `skill-resolver.ts` /
  `mention-runner/skill-resolver.ts` cut on `indexOf("\n")` then strip trailing
  CR **without** `.trim()`. `mcp-resolver.ts` and `subagent-resolver.ts` **do**
  trim.
- **measured drift:** input `"  hello  \\nworld"` → G host/CLI `"hello"`;
  A plugin/skill resolvers `"  hello  "`. CRLF handling also differs
  (`search(/\\r?\\n/)` vs `indexOf("\\n")` + optional CR strip) for CR-only
  first lines.
- **producer → consumer:** mention description/system text → autocomplete
  `detail` (G) vs resolve `bodyText` (A). Same user-visible mention kinds.
- **G-internal:** the two G copies match on ordinary strings (confirmed by
  [Host library](fc704a9d-14f0-45c2-af2b-e8d30188c57e)). S8 is not a
  host↔CLI merge finding. It stays open because HEAD still has local owners
  and A-lane trim drift is measured.
- **proposed write set (G):** HEAD
  `src/host/runtime/internal/mention-source-deps.ts`,
  `src/apps/cli/at-autocomplete/provider.ts` (delete locals; call the fence-legal
  shared owner **once it is in the snapshot**). **Forbidden G writes:**
  `src/shared/**` (reserved). **Forbidden:** editing A resolvers as if G owned
  them — send to W2-X.
- **proof limit:** `git show HEAD:` function-body comparison. The untracked
  hellgate `tests/unit/mention-first-line-parity-hellgate.test.ts` was **not**
  treated as HEAD proof.

### G-F3 [P2] Host MCP factory ignores the isolated-spawn enablement gate (G consumer of C-F1)

- **status:** open
- **attribution:** pre-existing
- **cross-receipt:** W1-C C-F1 owns `src/mcp/isolated-client.ts`
  `isolatedMcpEnabledFromEnv`. This row is the **G composition consumer**.
- **owner (G):** `src/host/mcp-composition.ts:121-135` `factory` always
  `return new McpClient(c, clientOpts)`. `rg` of `IsolatedMcpClient` /
  `isolatedMcpEnabledFromEnv` under `src/host` is empty.
- **consumers:** CLI `loadFeatures` and web `loadDaemonMcp` both use this
  factory via `buildMcpLoadOpts` / supervisor deps.
- **failure:** operator sets `MCP_USE_ISOLATED_SPAWN`; host MCP children still
  use in-process `McpClient` + default spawn. Promised isolate timeouts do not
  apply on the interactive/web path.
- **proposed write set (G):** `src/host/mcp-composition.ts` factory to consume
  the C gate **or** stop implying a host swap. **Forbidden:** rewriting
  `isolated-client.ts` (C) or plugin launcher (A) as a substitute for the host
  wire. W2-X assigns wire-vs-delete.
- **proof limit:** static call-site universe in `src/host`. Env was not set in
  a live CLI boot.

### G-F4 [P2] Live `tickScheduler` never reclaims stale `running` claims

- **status:** open
- **attribution:** pre-existing
- **verified after:** [Host library](fc704a9d-14f0-45c2-af2b-e8d30188c57e)
- **invariant:** a `running` row whose worker died is reclaimable after
  `claimedAt <= reclaimBefore`, then can fire again
- **owner (G):** `src/scheduler/automation-engine/ticker.ts:77-91` `TickOpts`
  has no `reclaimBefore`. `:119` always `engine.claim(now)` with no opts.
- **port documents the recovery option:** `src/scheduler/automation-engine/port.ts:215-235`.
  SQLite and in-memory engines implement it (`sqlite/operations.ts:369`,
  `in-memory.ts:129-131`).
- **consumer (A, not G write):** `src/agent/automation-ticker.ts:69-76` calls
  `tickScheduler({ engine, now, handler, eligibility? })`. Even if A wanted
  reclaim, `TickOpts` cannot carry it.
- **measured drift:** hellgates can opt into reclaim on `engine.claim`; the
  production tick path cannot. Crash after claim / before finalize leaves the
  row `running` forever → missed fires for that automation.
- **failure mode:** default-OFF automation engine; when wired, a process kill
  during a tick permanently parks that row until an operator cancels it.
- **test honesty:** reclaim tests prove adapter capability, not that
  `tickScheduler` uses it. Removing the live reclaim call cannot turn RED
  because there is no live call.
- **proposed write set (G):** `src/scheduler/automation-engine/ticker.ts`
  (`TickOpts` + `claim(now, { reclaimBefore })` with a documented stale
  window). **Forbidden:** treating A `automation-ticker.ts` as G-owned; W2-X
  assigns the A wire if the default stays opt-in.
- **proof limit:** static absence of `reclaimBefore` at every `tickScheduler(`
  site in `src/`. Process-kill e2e against an armed sqlite ticker was not run.

### G-F5 [P1] ProMax `boxGrade` early-return skips family setup; `isBootstrapped` still requires the swebench shim

- **status:** open
- **attribution:** pre-existing
- **verified after:** [Bench eval](69728f06-fc85-4aa2-b186-be1372037dcf)
- **invariant:** a family that grades with its own evaluator skips only the
  swebench shim + uvx warm, not on-box family bootstrap / LSP prove
- **owner:** `src/apps/bench/remote/box-session/ec2-lifecycle.ts:483-491`
  `return`s after the skip log, so `:520-530` `setupBoxForFamily` and
  `verifyPyrightGrounding` never run. Comment at `:477-482` claims shim+warm
  skip only.
- **second contract:** `isBootstrapped` at `:711-715` still requires
  `test -x ~/swebench-python`. ProMax never writes that shim (`harnessSpec`
  refuses), so the probe stays false.
- **consumer:** `attachBox` `:890-902` re-calls `bootstrapBox` whenever the
  probe fails → every ProMax warm attach re-runs rsync/`bun install`.
  `findIdleBox` skips non-bootstrapped boxes.
- **failure mode:** ProMax remote boxes never become "bootstrapped"; warm-pool
  reuse pays full bootstrap cost; family `setupBox` / live-LSP prove are
  skipped on the provision path.
- **test honesty:** lifecycle hellgates use verified profile **without**
  `boxGrade`, so they cannot RED this early-return.
- **proposed write set (G):** `src/apps/bench/remote/box-session/ec2-lifecycle.ts`
  (narrow the return to shim/warm; still call family setup + pyright; and/or
  make `isBootstrapped` family-aware). Tests under `tests/unit/apps/bench/promax/`
  with a `boxGrade` fixture. **Forbidden:** changing `@/observability` cost
  tables as a substitute.
- **proof limit:** static control-flow + consumer trace. No live EC2 ProMax
  run. Unverified: AMI images that plant `~/swebench-python` outside this path.

### G-F6 [P2] Eval dotenv file order is reversed vs CLI/bench first-wins SSOT

- **status:** open
- **attribution:** pre-existing
- **verified after:** [Bench eval](69728f06-fc85-4aa2-b186-be1372037dcf)
- **invariant:** first-wins dotenv load order `.env.dev → .env.local → .env`
- **owner 1 (aligned):** `src/apps/cli/index.ts` and `src/apps/agent/index.ts`
  call `loadEnvFiles([".env.dev", ".env.local", ".env"])` from `@/shared/env-files`.
  Bench `src/apps/bench/run-main.ts:833` uses the **same order** via a local copy
  in `run-args.ts`.
- **owner 2 (drift):** `src/apps/eval/index.ts:174`
  `loadEnv([".env", ".env.local", ".env.dev"])` — reversed, no provenance.
- **measured drift:** same cwd, `FOO` in both `.env` and `.env.dev` →
  `bun run bench` / CLI take `.env.dev`; `bun run eval` takes `.env`.
- **failure mode:** provider keys / `QUANTA_*` disagree across bench vs eval
  on the same machine.
- **proposed write set (G):** `src/apps/eval/index.ts` to the shared order
  (prefer `loadEnvFiles` once W2-X allows the reserved shared import, which
  eval as an app slice already may). Optionally delete `run-args.ts` local
  parser and import `@/shared/env-files` (same lane, reduces copy).
  **Forbidden:** changing `src/shared/env-files.ts` policy as G-owned cleanup
  without W2-X (shared is reserved for writes).
- **proof limit:** source-order compare. Dual-process env experiment not run.
  D22 `sleepReal` remains closed (no measured sleep drift).

### G-F7 [P1] HEAD `/session-registry cleanup` mints a second `startAutoSweep`

- **status:** open
- **attribution:** pre-existing (WT overlay already routes through the
  singleton; that overlay is **outside** this HEAD claim)
- **verified after:** [Apps surfaces](83658574-51d7-401d-9de3-f4ce5374c2a5)
- **invariant:** only `global.ts` may call `startAutoSweep`; one timer; one
  `runtimeConfig()` snapshot for backend path + WAL knobs
- **owner (G, HEAD):** `src/apps/cli/session-registry-cmd.ts` `renderCleanup`
  `startAutoSweep(autoSweepConfigFromRuntime(runtimeConfig()))` then
  `handle.sweepNow()`; `finally handle.stop()`. Dry-run uses
  `sessionRegistryCleanupPathsFrom(runtimeConfig())` — a **second** snapshot.
- **second owner (A):** `src/agent/session-resource-registry/global.ts`
  first-get mints `startAutoSweep(sweepConfig)` from the frozen cfg.
  `auto-sweep.ts:445-448` documents two starts without stop ⇒ two timers;
  callers other than `global.ts` are forbidden.
- **producer → consumer:** slash `/session-registry cleanup` after any prior
  `getGlobalSessionResourceRegistry()` (assembler, evict, stats).
- **measured race:** slash starts a second interval + fire-and-forget
  startup sweep overlapping the singleton timer and `await sweepNow()` on the
  same disk/sqlite paths. `stop()` in `finally` kills only the ephemeral
  handle. Dry-run path can count a different dir than the mounted backend
  after `/config set`.
- **failure mode:** concurrent GC / WAL checkpoint; misleading "Sweep complete";
  dry-run vs live path split.
- **test honesty:** HEAD `tests/unit/session-registry-slash.test.ts` asserts
  the success string; does not RED a second timer.
- **proposed write set (G):** HEAD `src/apps/cli/session-registry-cmd.ts` —
  sweep via singleton handle / `getGlobalSessionResourceRegistryState().sweepConfig`;
  never call `startAutoSweep` from the slash. **Forbidden:** rewriting
  `auto-sweep.ts` / `global.ts` as G work (A). WT already contains this shape;
  do not treat the dirty file as HEAD proof.
- **proof limit:** HEAD call graph + auto-sweep contract. Dual-timer sqlite
  stress was not executed.

### G-F8 [P3] CLI permission-store load is silent fail-soft; web warns

- **status:** open
- **attribution:** pre-existing
- **verified after:** [Apps surfaces](83658574-51d7-401d-9de3-f4ce5374c2a5)
- **invariant:** corrupt durable permission store degrades to in-memory seed
  without crashing boot (shared fail-soft). Observability of that loss.
- **owner 1:** `src/apps/cli/repl.ts:288-295` empty `catch { return undefined }`
- **owner 2:** `src/apps/web-daemon/runtime-factory.ts:272-283` same load,
  `logger.warn` with the error
- **measured drift:** same store API and fail-soft result; CLI emits nothing.
- **failure mode:** CLI operator loses durable posture with no signal; approvals
  silently use the in-memory seed. Not a dual-write of grants.
- **proposed write set (G):** `src/apps/cli/repl.ts` log parity with web.
  **Forbidden:** making CLI fail-closed while web stays fail-soft (would reopen
  boot-policy merge).
- **proof limit:** code-path only; corrupt-store probe not run.

## Candidate fingerprints for W2-X

Format: `authority/invariant/input/output/state/effect/failure-policy/lifecycle`

| ID | Fingerprint | G owner | Foreign owner | Notes |
|---|---|---|---|---|
| X-G1 | mcp-load-fault / boot-capability / mcpConfigs+loadMcpTools / tools+clients / fleet / spawn / throw-vs-empty / session-start | `internal.ts#loadMcpFeatures` vs `daemon-mcp.ts` | `agent` `loadMcpTools` (A) | G-F1; do not merge D21 |
| X-G2 | mention-first-line / trim+CRLF / description / first line / none / lookup+autocomplete / local-vs-shared / call | HEAD `mention-source-deps.ts`, `at-autocomplete/provider.ts` | A resolvers; untracked `shared/mention-text.ts` | G-F2 / S8 trigger |
| X-G3 | mcp-client-select / spawn-isolation-enablement / MCP_USE_ISOLATED_SPAWN / SupervisableMcpClient / process / spawn / env-ignored / start-stop | `mcp-composition.ts:135` | C `isolated-client.ts`; A plugin launcher | G-F3 / C-F1 |
| X-G4 | session-boot / interactive-collaborators / env+deps / AgentConfig / session / mint / surface-local / process | `bootstrapSession` (CLI/headless/brain) vs `runtime-factory` (web) vs `mode-presets/interactive.ts` | D21 conditional | inventory unless parity RED |
| X-G5 | usage-accounting-mint / knob QUANTA_USAGE_ACCOUNTING_V2 / env / UsageAccountingPort / one instance / record / fail-safe-on / session | `tooling-bundle.ts` vs `usage-accounting-wire.ts` vs `runtime-factory.ts` | observability factory | copies; override-safe; CLI hellgate exists |
| X-G6 | unknown-model-price / rate-card miss / model id / usd / none / display / null-vs-sonnet-fallback / record | `pricing.ts#costUsd` vs `prompt-cache/default.ts#resolvePricing` | none | documented split; operator-confusing |
| X-G7 | sleep-real / delay-ms / number / Promise\<void\> / none / timer / n-a / call | `bench/remote/pool/types.ts` vs `lease-fs.ts` | D22 | opportunistic; byte-identical one-liner |
| X-G8 | agent-event-projection / subset-map / AgentEvent / SessionEvent\|undefined / none / stdout-json / silent-drop / turn | `apps/agent/mode-presets/stream-json-sink.ts:218-223` | stream/kernel projectors (D) | D26; no new dropped event named |
| X-G9 | radar-jsonl-durable / append-replay / file / in-memory map / cards / write / skip-corrupt / process | `radar/jsonl-file-store.ts` | A `radar-producer-hook.ts` | gated; no fsync; best-effort |
| X-G10 | named-entry-shape / autocomplete-row / name+description / NamedEntry / none / list / structural-dup / call | host `mention-source-deps.ts` vs CLI `NamedEntry` | fence: host ↛ apps | inventory |
| X-G11 | session.v1-public-verbs / command-union / SessionCommand / CommandReceipt / none / submit / typed-omit / handle | sdk `handle-adapter` pins `SessionVerbSurface` | C-F2 protocol/ipc | G is consumer; do not edit protocol |
| X-G12 | parseEnvFlag / bool-env / raw string / boolean / none / gate / default / call | G files import `@/runner/assemble` re-export | `shared/env-flag.ts` SSOT | not duplicate |
| X-G13 | transcript-retention / max-bytes / jsonl envelopes / trimmed file / none / rewrite / no-throw-continue / sweep | `apps/cli/session-transcript-retention.ts` | stream `applyRetention` + session `sessionsRoot` (D) | legal composition seam |
| X-G14 | scheduler-next-fire / rrule UTC / (rule,from,count) / ms\|never / none / none / never-on-horizon / pure | `scheduler/next-fire.ts` | timezone unused `_clock` | no TZ consumer drift measured |
| X-G15 | automation-claim-reclaim / stale-running / now+reclaimBefore / ClaimedRun / running row / re-claim / opt-in-absent / tick | `ticker.ts` `claim(now)` | A `automation-ticker.ts` | G-F4 |
| X-G16 | box-readiness / bootstrapped⇔shim+family+LSP / ssh probe / bool / box disk / skip-setup / fail-open-reuse / attach | `ec2-lifecycle.ts` `bootstrapBox` vs `isBootstrapped` | profile.`boxGrade` | G-F5 |
| X-G17 | dotenv-first-wins / file-order / KEY=VALUE / process.env / provenance? / set-if-absent / silent-shadow / process-start | `eval/index.ts` vs `bench/run-main.ts` vs `shared/env-files` | CLI/agent `loadEnvFiles` | G-F6; shared reserved |
| X-G18 | session-registry-sweep / single-timer+frozen-cfg / slash cleanup / GC / store / dual-startAutoSweep / process | HEAD `session-registry-cmd.ts` | A `global.ts` + `auto-sweep.ts` | G-F7 |
| X-G19 | permission-store-load / fail-soft / store.load / PermissionStore\|undefined / none / degrade / silent-vs-warn / boot | `repl.ts` vs `runtime-factory.ts` | `@/permission` store (F) | G-F8 |

## Inventory (SOLID smell, no finding)

- SRP/cohort: nine G files sit in 900–999. Official detector reports 0 god-module
  and 0 god-function. Existing ratchet (`approachingModuleCeiling.max = 24`)
  already owns the population. Splitting without a failure mode is W2-P.
- `src/host/mcp-composition.ts` (923) mixes OAuth, launch policy, config layers,
  supervisor factory, and `loadMcpTools` opts. Cohesive composition hub; G-F3 is
  the only failure-mode slice of that file in this receipt.
- `src/apps/cli/internal.ts` / `slash-surface.ts` / `session-setup.ts` /
  `rewind-cmd.ts` / `brain-mode.ts` are large surface modules already split into
  siblings for the god-function cap.
- OCP: slash `registry-surface.ts` and CLI knobs are registration tables;
  extension edits the table. Expected for a composition root.
- ISP: `SessionBootstrapDeps` is a large injected-factory bag; that is the
  fence that keeps host free of `apps/**`. Not a finding.
- DIP: host/sdk are `surfaceIsolationOnly`. No `from "@/apps` value import
  found in `src/host` or `src/sdk`. Apps wrapping host assemblers is the
  intended arrow.
- `parseEnvFlag` from `@/runner/assemble` is a re-export of `@/shared`.
- CLI permission load (`repl.ts:288-295`) and web posture load are both
  fail-soft to `undefined` — aligned, not drifted.
- Usage-accounting mint is copied in three roots but all call
  `resolveUsageAccounting` and `maybeWireUsageAccounting` is override-safe.
  CLI proof: `tests/unit/host/usage-accounting-cli-wire-hellgate.test.ts`.
- Prompt-cache unknown-model sonnet fallback is documented (ADR-0138);
  `costUsd` explicitly refuses fallback. Dual policy is intentional unless a
  UI joins the two dollars as one number (not traced).
- In-memory metrics registry bounds histogram observations and series
  cardinality; sink throws are counted, not crash.
- Scheduler `markRun` is transactional; `computeNextFire` is UTC-pure with a
  10-year scan cap. `_clock` unused — reserved, not a hidden TZ fork. Reclaim
  exists on the engine port but is unused by `tickScheduler` (G-F4), not a
  next-fire defect.
- Reactor PR-comment watermark hole has a live hellgate; production advances
  only to newest emitted stamp before the earliest hole.
- Radar JSONL skip-corrupt + no fsync is documented best-effort and
  default-OFF (`QUANTA_RADAR`). Invalid `QUANTA_RADAR_TASK_MS` defaults to 30s.
- Workflow / ui / sdk barrels are thin. Radar barrel comment ("no other slice
  imports") is stale: CLI `buildRadarStore` and A `radar-producer-hook` import
  it — comment rot, not a second owner.
- `NamedEntry` redeclared in host because host cannot import apps — fence, not
  dual write.
- Param-count heuristic (≥8) fired on color helpers and destructuring; false
  positives, not explosion findings.

## No-finding bounded areas

Bounded by inspected owner + consumer on this HEAD:

- `bootstrapSession` is the shared boot for CLI, headless, and brain-mode.
  Web does not call it (D21 remains conditional).
- `assembleAgentConfig` lives in host; `apps/agent/assemble.ts` is an env-binding
  shim. Web `buildAgentConfigBase` projects onto that assembler.
- `loadMcpToolsOrEmpty` empty-on-zero-configs is not a catch-all.
- Reactor watermark: hellgate encodes the hole-cap contract; residual skip-past-hole
  not reproduced in source.
- Scheduler sqlite unique index `idx_automations_live_heartbeat_thread` owns
  one-live-heartbeat-per-thread across processes.
- SDK public surface does not re-export 133-field `AgentConfig` (comment +
  `tests/unit/sdk/public-surface.test.ts` exists; not re-run).
- UI slice is pure string helpers; `envAllowFiles: ui-helpers.ts` is the
  documented display-posture read.
- Transcript sweep is a legal apps composition seam over session+stream
  (fence: those library slices cannot import each other).

## Uninspected conditions

- Per-file consumer trace for all 891 files. Remainder classified by path role;
  consumers were not opened one-by-one.
- Runtime: broken MCP config on CLI vs web; `MCP_USE_ISOLATED_SPAWN=1` live boot;
  `QUANTA_RADAR` + `QUANTA_RADAR_FILE` crash mid-append; scheduler DST/TZ;
  bench remote pool under load; eval live LLM.
- Official god-function AST over **HEAD blobs** of the three dirty files
  (detector ran on working-tree bytes). Overlay is SEP6 mention-text, not size.
- Biome cognitive-complexity scores per G function (lint-debt ceiling is
  repo-wide; not re-attributed here).
- Full AgentEvent exhaustiveness vs every G projector (D26 reopen needs a named
  dropped event).
- Parallel sub-workers: [Host library](fc704a9d-14f0-45c2-af2b-e8d30188c57e),
  [Bench eval](69728f06-fc85-4aa2-b186-be1372037dcf), and
  [Apps surfaces](83658574-51d7-401d-9de3-f4ce5374c2a5) completed. Coordinator
  re-read owners and kept G-F4–F8. Sibling untracked receipts are not production STALE.
- Root tests whose SUT is G were mapped by directory heuristic
  (`tests/unit/apps/*`, `tests/unit/cli/`, `tests/unit/host/`,
  `tests/unit/observability-*`, slice-boundary entrypoints). Not every one of
  the ~750 rg hits was opened.

## Exact proposed write sets

Implementation is **not** authorized by this receipt. W3-I tickets only.

| Finding | Allowed G writes | Forbidden |
|---|---|---|
| G-F1 | `src/apps/web-daemon/runtime-factory/daemon-mcp.ts`; optional host helper under `src/host/mcp-composition.ts` if W2-X names host as policy owner | D21 merge of CLI/web boot; `@/agent` loadMcpTools rewrite as G work |
| G-F2 | HEAD `src/host/runtime/internal/mention-source-deps.ts`; `src/apps/cli/at-autocomplete/provider.ts` | `src/shared/**`; A resolvers; committing the dirty overlay without W3-I |
| G-F3 | `src/host/mcp-composition.ts` factory | `src/mcp/isolated-client.ts` (C); plugin launcher (A) |
| G-F4 | `src/scheduler/automation-engine/ticker.ts` | A `automation-ticker.ts` except W2-X assigns the wire |
| G-F5 | `src/apps/bench/remote/box-session/ec2-lifecycle.ts` + ProMax boxGrade tests | observability price tables; live AMI guess |
| G-F6 | `src/apps/eval/index.ts`; optional `apps/bench/run-args.ts` to import shared | rewriting `src/shared/env-files.ts` as G cleanup |
| G-F7 | HEAD `src/apps/cli/session-registry-cmd.ts` | A `global.ts` / `auto-sweep.ts`; treating WT overlay as HEAD |
| G-F8 | `src/apps/cli/repl.ts` warn on store-load fault | flipping CLI to fail-closed while web stays fail-soft |

## Test-owner map (coarse)

- `src/apps/cli/**` → `src/apps/cli/__tests__/**`, `tests/unit/apps/cli/**`, `tests/unit/cli/**`
- `src/apps/web-daemon/**` → `tests/unit/apps/web-daemon/**`, integration `*-web-daemon-e2e*`
- `src/apps/bench/**` → `tests/unit/apps/bench/**`, `tests/unit/bench*`
- `src/apps/eval/**` → `tests/unit/eval-*`
- `src/apps/agent/**` → `tests/unit/apps/agent/**`
- `src/apps/headless/**` → `tests/unit/apps/headless/**`
- `src/host/**` → `tests/unit/host/**`, `tests/unit/host-slice-boundary.test.ts`
- `src/sdk/**` → `tests/unit/sdk/**`, `tests/unit/sdk-slice-boundary.test.ts`
- `src/observability/**` → `tests/unit/observability*.test.ts`, `tests/unit/observability-slice-boundary.test.ts`
- `src/scheduler/**` → `tests/unit/scheduler-*.test.ts`
- `src/reactor/**` → `tests/unit/reactor-*.test.ts`
- `src/radar/**` → `tests/unit/radar-slice-boundary.test.ts` (thin)
- `src/workflow/**` → `tests/unit/workflow-*.test.ts`
- `src/ui/**` → `tests/unit/ui-slice-boundary.test.ts`

Complete path×role×line census is the appendix (891 rows). Fingerprints in the
appendix are role-heuristic seeds for W2-X, not per-file deep contracts.

## Appendix — complete production file manifest

Columns: `lines`, `role`, `path`. Sorted by path. HEAD-tracked, tests excluded.

```text
40	impl	src/apps/agent/assemble.ts
21	impl	src/apps/agent/cli-args.ts
606	barrel	src/apps/agent/index.ts
22	impl	src/apps/agent/interactive-turn-assembler.ts
175	impl	src/apps/agent/mode-presets/batch.ts
491	impl	src/apps/agent/mode-presets/ci-bot.ts
133	impl	src/apps/agent/mode-presets/daemon.ts
189	impl	src/apps/agent/mode-presets/headless.ts
143	impl	src/apps/agent/mode-presets/ide.ts
240	impl	src/apps/agent/mode-presets/interactive.ts
226	impl	src/apps/agent/mode-presets/stream-json-sink.ts
74	impl	src/apps/agent/mode-presets/system.ts
5	composition-wire	src/apps/agent/pipeline-wire.ts
159	impl	src/apps/agent/run.ts
5	composition-wire	src/apps/agent/search-pipeline-wire.ts
285	impl	src/apps/bench/analyze/bestk-passk-grade.ts
304	impl	src/apps/bench/analyze/cost.ts
185	impl	src/apps/bench/analyze/diff.ts
186	impl	src/apps/bench/analyze/explain.ts
194	impl	src/apps/bench/analyze/leaderboard.ts
471	impl	src/apps/bench/analyze/verdicts.ts
438	impl	src/apps/bench/analyze/wave2-analysis.ts
189	impl	src/apps/bench/analyze/wave2-guards.ts
35	barrel	src/apps/bench/auth-pool/index.ts
197	impl	src/apps/bench/auth-pool/lease-manager.ts
221	impl	src/apps/bench/auth-pool/load.ts
189	impl	src/apps/bench/auth-pool/login.ts
37	types-or-port	src/apps/bench/auth-pool/types.ts
203	impl	src/apps/bench/benchmark-suite.ts
134	composition-wire	src/apps/bench/boot-llm-wire.ts
247	impl	src/apps/bench/cli.ts
261	impl	src/apps/bench/commands/analyze.ts
100	impl	src/apps/bench/commands/auth.ts
960	impl	src/apps/bench/commands/box.ts
85	impl	src/apps/bench/commands/grade-expected.ts
433	impl	src/apps/bench/commands/grade.ts
422	impl	src/apps/bench/commands/pool.ts
173	impl	src/apps/bench/commands/shared.ts
459	impl	src/apps/bench/commands/terminal.ts
100	impl	src/apps/bench/commands/trace.ts
7	impl	src/apps/bench/corpus/cache-pathspecs.ts
13	impl	src/apps/bench/corpus/dataset.ts
11	impl	src/apps/bench/corpus/failure-classifier.ts
1	barrel	src/apps/bench/corpus/index.ts
5	impl	src/apps/bench/corpus/loader.ts
8	impl	src/apps/bench/corpus/paths.ts
94	impl	src/apps/bench/dataset-family-token.ts
71	impl	src/apps/bench/dataset-family.ts
92	impl	src/apps/bench/default-trace-sink.ts
131	impl	src/apps/bench/dry-run.ts
39	impl	src/apps/bench/entry-bootstrap.ts
558	impl	src/apps/bench/eval/driver.ts
637	impl	src/apps/bench/eval/driver/agent-phase.ts
119	impl	src/apps/bench/eval/driver/app-main.ts
6	impl	src/apps/bench/eval/driver/deps.ts
200	impl	src/apps/bench/eval/driver/repair.ts
866	impl	src/apps/bench/eval/driver/selection.ts
1	impl	src/apps/bench/eval/env-prep.ts
1	impl	src/apps/bench/eval/exec.ts
87	impl	src/apps/bench/eval/fork-branch-report.ts
182	impl	src/apps/bench/eval/fork-experiments.ts
9	barrel	src/apps/bench/eval/index.ts
1	adapter	src/apps/bench/eval/regression-oracle-adapter.ts
1	impl	src/apps/bench/eval/repair/context.ts
1	barrel	src/apps/bench/eval/repair/index.ts
1	impl	src/apps/bench/eval/repair/llm-evidence.ts
1	types-or-port	src/apps/bench/eval/repair/types.ts
1	impl	src/apps/bench/eval/repair/validator.ts
1	adapter	src/apps/bench/eval/repo-regression-discovery-adapter.ts
1	impl	src/apps/bench/eval/report.ts
1	impl	src/apps/bench/eval/sandbox.ts
5	impl	src/apps/bench/eval/snapshot.ts
1	impl	src/apps/bench/eval/verdict.ts
86	impl	src/apps/bench/family-mode-honor.ts
42	impl	src/apps/bench/harness/arch.ts
64	impl	src/apps/bench/harness/config.ts
179	impl	src/apps/bench/harness/images.ts
51	barrel	src/apps/bench/harness/index.ts
196	impl	src/apps/bench/harness/prepare.ts
228	impl	src/apps/bench/harness/promax/adapter.ts
147	impl	src/apps/bench/harness/promax/box-grade.ts
506	impl	src/apps/bench/harness/promax/campaign-freeze.ts
76	impl	src/apps/bench/harness/promax/chunk-verdicts.ts
156	impl	src/apps/bench/harness/promax/classify.ts
768	impl	src/apps/bench/harness/promax/evaluator-bootstrap.ts
71	impl	src/apps/bench/harness/promax/evaluator-python.ts
636	impl	src/apps/bench/harness/promax/gate-run.ts
119	impl	src/apps/bench/harness/promax/gold-sentinel.ts
550	impl	src/apps/bench/harness/promax/golden-derive.ts
478	impl	src/apps/bench/harness/promax/image-freeze.ts
490	impl	src/apps/bench/harness/promax/image-preflight.ts
224	impl	src/apps/bench/harness/promax/image-provenance.ts
192	barrel	src/apps/bench/harness/promax/index.ts
196	impl	src/apps/bench/harness/promax/invocation.ts
212	impl	src/apps/bench/harness/promax/official-result.ts
201	impl	src/apps/bench/harness/promax/submission.ts
167	impl	src/apps/bench/host-resource-sampler.ts
137	barrel	src/apps/bench/index.ts
140	impl	src/apps/bench/lane-progress-renderer.ts
94	impl	src/apps/bench/model-lanes.ts
17	impl	src/apps/bench/observe.ts
68	impl	src/apps/bench/official-grade-ingest-source.ts
495	impl	src/apps/bench/otel-trace-sink.ts
219	impl	src/apps/bench/otel.ts
118	impl	src/apps/bench/preset.ts
108	impl	src/apps/bench/pro-measure.ts
315	impl	src/apps/bench/pro-swebench.ts
240	bootstrap	src/apps/bench/profiles/bootstrap-phase-wiring.ts
22	bootstrap	src/apps/bench/profiles/bootstrap.ts
83	impl	src/apps/bench/profiles/corpus-read.ts
83	impl	src/apps/bench/profiles/corpus-row.ts
61	impl	src/apps/bench/profiles/harness-spec.ts
86	impl	src/apps/bench/profiles/jsonl-corpus.ts
28	impl	src/apps/bench/profiles/plan.ts
48	impl	src/apps/bench/profiles/pro-box-setup.ts
69	impl	src/apps/bench/profiles/pro-dataset-shape.ts
39	impl	src/apps/bench/profiles/pro-env-prefix.ts
113	impl	src/apps/bench/profiles/promax-bootstrap.ts
92	impl	src/apps/bench/profiles/promax-corpus.ts
107	impl	src/apps/bench/profiles/promax-dataset-shape.ts
256	impl	src/apps/bench/profiles/promax-field-class.ts
64	impl	src/apps/bench/profiles/promax-projection.ts
393	impl	src/apps/bench/profiles/promax.ts
131	impl	src/apps/bench/profiles/python-version.ts
244	impl	src/apps/bench/profiles/registry.ts
89	impl	src/apps/bench/profiles/selection.ts
500	types-or-port	src/apps/bench/profiles/types.ts
497	impl	src/apps/bench/promax/campaign/cli.ts
363	impl	src/apps/bench/promax/campaign/evidence-decode.ts
205	impl	src/apps/bench/promax/campaign/exceptions.ts
346	impl	src/apps/bench/promax/campaign/gate-clauses.ts
985	impl	src/apps/bench/promax/campaign/gates.ts
112	barrel	src/apps/bench/promax/campaign/index.ts
621	impl	src/apps/bench/promax/campaign/owner-audit.ts
258	impl	src/apps/bench/promax/campaign/rails.ts
876	impl	src/apps/bench/promax/campaign/record.ts
143	impl	src/apps/bench/promax/corpus/artifacts.ts
217	impl	src/apps/bench/promax/corpus/decode.ts
51	impl	src/apps/bench/promax/corpus/grader-bundle.ts
74	barrel	src/apps/bench/promax/corpus/index.ts
122	impl	src/apps/bench/promax/corpus/layout.ts
170	impl	src/apps/bench/promax/corpus/public-reader.ts
251	impl	src/apps/bench/promax/corpus/sample-select.ts
283	impl	src/apps/bench/promax/corpus/samples.ts
89	types-or-port	src/apps/bench/promax/corpus/types.ts
279	impl	src/apps/bench/promax/provenance/assemble.ts
29	impl	src/apps/bench/promax/provenance/bundle-layout.ts
246	impl	src/apps/bench/promax/provenance/corpus-identity.ts
36	impl	src/apps/bench/promax/provenance/digest.ts
76	impl	src/apps/bench/promax/provenance/frozen-snapshot.ts
69	barrel	src/apps/bench/promax/provenance/index.ts
57	impl	src/apps/bench/promax/provenance/json.ts
107	impl	src/apps/bench/promax/provenance/manifest.ts
72	impl	src/apps/bench/promax/provenance/selector.ts
169	types-or-port	src/apps/bench/promax/provenance/types.ts
302	impl	src/apps/bench/promax/provenance/verify.ts
131	impl	src/apps/bench/promax/settings.ts
693	impl	src/apps/bench/python-swebench.ts
145	impl	src/apps/bench/python-verifier-wiring.ts
50	impl	src/apps/bench/reasoning-summary.ts
202	impl	src/apps/bench/remote/backend.ts
127	bootstrap	src/apps/bench/remote/bootstrap-tracer.ts
846	impl	src/apps/bench/remote/box-session.ts
97	impl	src/apps/bench/remote/box-session/auth.ts
117	impl	src/apps/bench/remote/box-session/box-readiness.ts
295	impl	src/apps/bench/remote/box-session/chunk-artifacts.ts
137	impl	src/apps/bench/remote/box-session/chunk-scrub.ts
332	impl	src/apps/bench/remote/box-session/dataset-preflight.ts
27	impl	src/apps/bench/remote/box-session/dataset-rows.ts
551	impl	src/apps/bench/remote/box-session/detached-poll.ts
934	impl	src/apps/bench/remote/box-session/ec2-lifecycle.ts
417	impl	src/apps/bench/remote/box-session/family-bootstrap-exec.ts
811	impl	src/apps/bench/remote/box-session/family-box-grade.ts
153	impl	src/apps/bench/remote/box-session/family-box-setup.ts
66	impl	src/apps/bench/remote/box-session/image-receipt-transport.ts
110	impl	src/apps/bench/remote/box-session/official-grade-transport.ts
91	impl	src/apps/bench/remote/box-session/pyright-grounding.ts
180	impl	src/apps/bench/remote/box-session/shell.ts
602	impl	src/apps/bench/remote/box-session/snapshot.ts
209	impl	src/apps/bench/remote/box-session/src-sync-guard.ts
411	types-or-port	src/apps/bench/remote/box-session/types.ts
79	impl	src/apps/bench/remote/box-session/verdict-parse.ts
459	impl	src/apps/bench/remote/ec2.ts
149	impl	src/apps/bench/remote/fanout.ts
118	impl	src/apps/bench/remote/fresh-auth.ts
740	impl	src/apps/bench/remote/full.ts
89	impl	src/apps/bench/remote/lease-fs.ts
60	impl	src/apps/bench/remote/pool-auth.ts
213	impl	src/apps/bench/remote/pool.ts
201	impl	src/apps/bench/remote/pool/coverage.ts
153	impl	src/apps/bench/remote/pool/launch-window.ts
119	types-or-port	src/apps/bench/remote/pool/types.ts
962	impl	src/apps/bench/remote/pool/worker.ts
89	impl	src/apps/bench/remote/relaunch-coverage.ts
340	impl	src/apps/bench/remote/single-box-guard.ts
348	impl	src/apps/bench/remote/ssh.ts
618	impl	src/apps/bench/remote/token-budget.ts
121	impl	src/apps/bench/remote/verdict-buckets.ts
14	impl	src/apps/bench/report.ts
161	impl	src/apps/bench/resume/canonicalize.ts
60	impl	src/apps/bench/resume/config.ts
23	impl	src/apps/bench/resume/identity.ts
14	barrel	src/apps/bench/resume/index.ts
293	impl	src/apps/bench/resume/recorder.ts
249	impl	src/apps/bench/resume/resume-launch.ts
298	impl	src/apps/bench/resume/security.ts
118	impl	src/apps/bench/resume/store.ts
89	impl	src/apps/bench/run-args.ts
267	impl	src/apps/bench/run-config.ts
307	impl	src/apps/bench/run-main-helpers.ts
929	impl	src/apps/bench/run-main.ts
97	impl	src/apps/bench/run-report.ts
163	impl	src/apps/bench/sampler.ts
123	impl	src/apps/bench/slicing/microchunk.ts
183	impl	src/apps/bench/span-sink.ts
156	impl	src/apps/bench/terminal/canary.ts
529	impl	src/apps/bench/terminal/config.ts
67	impl	src/apps/bench/terminal/dataset.ts
407	impl	src/apps/bench/terminal/doctor.ts
229	impl	src/apps/bench/terminal/harbor-command.ts
118	impl	src/apps/bench/terminal/harbor-results.ts
463	impl	src/apps/bench/terminal/manifest.ts
714	impl	src/apps/bench/terminal/report.ts
72	impl	src/apps/bench/terminal/retired-tb-2-0-smoke.ts
394	impl	src/apps/bench/terminal/scoring.ts
168	impl	src/apps/bench/trajectory-debug-sink.ts
432	impl	src/apps/bench/trajectory.ts
10	types-or-port	src/apps/bench/types.ts
360	impl	src/apps/cli/agents-fleet-panel.ts
179	impl	src/apps/cli/agents-fleet-tree.ts
117	composition-wire	src/apps/cli/ask-user-wire.ts
13	impl	src/apps/cli/at-autocomplete/env.ts
51	impl	src/apps/cli/at-autocomplete/fuzzy.ts
42	barrel	src/apps/cli/at-autocomplete/index.ts
49	types-or-port	src/apps/cli/at-autocomplete/port.ts
212	impl	src/apps/cli/at-autocomplete/provider.ts
440	impl	src/apps/cli/at-autocomplete/recursive-file-list.ts
177	impl	src/apps/cli/at-autocomplete/state-machine.ts
85	impl	src/apps/cli/at-autocomplete/symbol-list.ts
316	surface-command	src/apps/cli/attach-cmd.ts
421	impl	src/apps/cli/attach/attach-client.ts
70	impl	src/apps/cli/attach/commands.ts
12	impl	src/apps/cli/attach/handshake.ts
22	barrel	src/apps/cli/attach/index.ts
109	impl	src/apps/cli/attach/render.ts
9	impl	src/apps/cli/auth-ui.ts
75	composition-wire	src/apps/cli/auto-title-wire.ts
172	surface-command	src/apps/cli/background-cmd.ts
544	surface-command	src/apps/cli/batch-cmd.ts
407	impl	src/apps/cli/branch-search-progress.ts
54	surface-command	src/apps/cli/bug-cmd.ts
230	impl	src/apps/cli/cli-feature-gates.ts
107	impl	src/apps/cli/cli-knobs-accessor.ts
839	impl	src/apps/cli/cli-knobs.ts
46	impl	src/apps/cli/cli-seeded-gates.ts
236	impl	src/apps/cli/color-palettes.ts
235	impl	src/apps/cli/config-migration-notice.ts
303	impl	src/apps/cli/config-migration-skill-stage.ts
148	composition-wire	src/apps/cli/configured-endpoint-wire.ts
91	impl	src/apps/cli/context-warning.ts
435	impl	src/apps/cli/cost-panel.ts
140	surface-command	src/apps/cli/debug-cmd.ts
326	impl	src/apps/cli/debug-tracer.ts
508	impl	src/apps/cli/diff-preview.ts
36	impl	src/apps/cli/doctor/cmd.ts
122	impl	src/apps/cli/doctor/default-probes.ts
34	barrel	src/apps/cli/doctor/index.ts
216	impl	src/apps/cli/doctor/registry.ts
82	impl	src/apps/cli/doctor/render.ts
109	types-or-port	src/apps/cli/doctor/types.ts
1	impl	src/apps/cli/dotenv.ts
162	surface-command	src/apps/cli/dream-cmd.ts
96	surface-command	src/apps/cli/edit-message-cmd.ts
276	surface-command	src/apps/cli/edit-plan-cmd.ts
100	impl	src/apps/cli/effort-cycle.ts
56	composition-wire	src/apps/cli/fetch-rules-wire.ts
209	surface-command	src/apps/cli/fork-checkpoint-cmd.ts
72	impl	src/apps/cli/from-pr-cmd-adapters.ts
224	impl	src/apps/cli/from-pr-cmd-runner.ts
392	surface-command	src/apps/cli/from-pr-cmd.ts
497	impl	src/apps/cli/help-render.ts
394	surface-command	src/apps/cli/history-cmd.ts
137	surface-command	src/apps/cli/hooks-cmd.ts
209	impl	src/apps/cli/idle-monitor.ts
123	surface-command	src/apps/cli/image-cmd.ts
87	impl	src/apps/cli/image-loader.ts
90	impl	src/apps/cli/image-queue.ts
345	barrel	src/apps/cli/index.ts
495	impl	src/apps/cli/init-scaffold.ts
409	surface-command	src/apps/cli/inspect-cmd.ts
898	impl	src/apps/cli/internal.ts
223	impl	src/apps/cli/internal/argv.ts
10	impl	src/apps/cli/internal/mcp.ts
98	impl	src/apps/cli/internal/shell-snapshot.ts
134	impl	src/apps/cli/keybind-truth.ts
73	impl	src/apps/cli/keybindings/defaults.ts
134	impl	src/apps/cli/keybindings/load.ts
125	impl	src/apps/cli/keybindings/normalize.ts
74	types-or-port	src/apps/cli/keybindings/types.ts
80	composition-wire	src/apps/cli/knob-catalog-wire.ts
122	impl	src/apps/cli/knobs-bootstrap.ts
267	impl	src/apps/cli/lifecycle-pills.ts
62	impl	src/apps/cli/line-edit-ops.ts
75	impl	src/apps/cli/live-history-swap.ts
305	surface-command	src/apps/cli/login-cmd.ts
210	surface-command	src/apps/cli/logout-cmd.ts
266	impl	src/apps/cli/markdown-painter.ts
566	surface-command	src/apps/cli/mcp-cmd.ts
153	impl	src/apps/cli/mcp-config-rmw.ts
210	impl	src/apps/cli/mcp-elicitation-prompter.ts
33	impl	src/apps/cli/mcp-health.ts
388	impl	src/apps/cli/mcp-server-setup.ts
516	surface-command	src/apps/cli/memory-cmd.ts
99	impl	src/apps/cli/memory-compose.ts
176	impl	src/apps/cli/mode-cycle.ts
52	impl	src/apps/cli/not-wired.ts
18	barrel	src/apps/cli/notify/index.ts
42	impl	src/apps/cli/notify/notify-enabled.ts
182	adapter	src/apps/cli/notify/osc-adapter.ts
69	types-or-port	src/apps/cli/notify/port.ts
66	impl	src/apps/cli/notify/presence-decision.ts
60	impl	src/apps/cli/notify/push-decision.ts
58	impl	src/apps/cli/operator-notice.ts
591	surface-command	src/apps/cli/paste-cmd.ts
429	impl	src/apps/cli/permission-explain.ts
311	impl	src/apps/cli/plan-panel.ts
328	impl	src/apps/cli/preflight.ts
76	impl	src/apps/cli/proc-panel.ts
195	impl	src/apps/cli/prompt-history.ts
350	surface-command	src/apps/cli/queue-cmd.ts
148	impl	src/apps/cli/ratelimit-notice.ts
63	impl	src/apps/cli/raw-line-reader-editor.ts
157	impl	src/apps/cli/raw-line-reader.ts
64	impl	src/apps/cli/raw-line-reader/ansi.ts
84	impl	src/apps/cli/raw-line-reader/history-search.ts
174	impl	src/apps/cli/raw-line-reader/interactions.ts
33	impl	src/apps/cli/raw-line-reader/key-event.ts
725	impl	src/apps/cli/raw-line-reader/keymap.ts
190	impl	src/apps/cli/raw-line-reader/machine.ts
146	impl	src/apps/cli/raw-line-reader/options.ts
87	impl	src/apps/cli/raw-line-reader/paste-accum.ts
46	impl	src/apps/cli/raw-line-reader/paste-display.ts
87	impl	src/apps/cli/raw-line-reader/render-rows.ts
162	impl	src/apps/cli/raw-line-reader/render.ts
123	types-or-port	src/apps/cli/raw-line-reader/types.ts
222	impl	src/apps/cli/reactor-watch-bridge.ts
74	impl	src/apps/cli/reject-counter.ts
322	surface-command	src/apps/cli/remote-cmd.ts
44	impl	src/apps/cli/repl-banners.ts
23	impl	src/apps/cli/repl-paint.ts
55	impl	src/apps/cli/repl-silent-catch.ts
477	impl	src/apps/cli/repl.ts
153	impl	src/apps/cli/repl/automation-banner.ts
93	impl	src/apps/cli/repl/background-capture-tee.ts
312	impl	src/apps/cli/repl/background-turn-portal.ts
84	impl	src/apps/cli/repl/cli-admissibility-compose.ts
289	impl	src/apps/cli/repl/cli-approval-prompt.ts
216	impl	src/apps/cli/repl/cli-feature-config.ts
101	impl	src/apps/cli/repl/cli-hunk-select-flow.ts
92	impl	src/apps/cli/repl/context-usage-snapshot.ts
128	composition-wire	src/apps/cli/repl/conv-checkpoint-wire.ts
17	impl	src/apps/cli/repl/conversation-action-surface.ts
42	adapter	src/apps/cli/repl/ctx-adapters/composer-edit-adapter.ts
45	adapter	src/apps/cli/repl/ctx-adapters/focus-chain-adapter.ts
33	adapter	src/apps/cli/repl/ctx-adapters/fork-session-adapter.ts
105	adapter	src/apps/cli/repl/ctx-adapters/identity-mode-adapter.ts
223	adapter	src/apps/cli/repl/ctx-adapters/model-adapter.ts
47	adapter	src/apps/cli/repl/ctx-adapters/per-tool-checkpoint-adapter.ts
68	adapter	src/apps/cli/repl/ctx-adapters/plan-edit-adapter.ts
70	adapter	src/apps/cli/repl/ctx-adapters/preset-role-resolver-adapter.ts
143	adapter	src/apps/cli/repl/ctx-adapters/sticky-model-adapter.ts
20	impl	src/apps/cli/repl/ctx-adapters/text-inbox-singleton.ts
44	adapter	src/apps/cli/repl/ctx-adapters/tool-profile-adapter.ts
247	composition-wire	src/apps/cli/repl/env-probe-wire.ts
39	impl	src/apps/cli/repl/external-prompt-queue.ts
17	impl	src/apps/cli/repl/factories/branch-progress.ts
24	impl	src/apps/cli/repl/factories/cost-panel.ts
67	impl	src/apps/cli/repl/factories/debug-tracer.ts
23	barrel	src/apps/cli/repl/factories/index.ts
114	port	src/apps/cli/repl/factories/indicator-stream-port.ts
111	impl	src/apps/cli/repl/factories/lifecycle.ts
17	impl	src/apps/cli/repl/factories/metrics-sink.ts
101	impl	src/apps/cli/repl/factories/notify-and-warning.ts
14	impl	src/apps/cli/repl/factories/plan-store.ts
35	impl	src/apps/cli/repl/factories/timeline-panel.ts
71	impl	src/apps/cli/repl/factories/turn-indicator.ts
95	impl	src/apps/cli/repl/factories/turn-summary.ts
40	impl	src/apps/cli/repl/goal-checkpoint-line.ts
22	impl	src/apps/cli/repl/goal-quiescence.ts
46	impl	src/apps/cli/repl/goal-wake-signal.ts
225	impl	src/apps/cli/repl/heartbeat-binder.ts
176	impl	src/apps/cli/repl/hunk-select.ts
385	impl	src/apps/cli/repl/in-turn-reader.ts
133	impl	src/apps/cli/repl/inbound-dispatch.ts
94	impl	src/apps/cli/repl/input-lane.ts
120	impl	src/apps/cli/repl/item-store.ts
123	composition-wire	src/apps/cli/repl/mcp-surface-wire.ts
213	impl	src/apps/cli/repl/mid-turn-approval-channel.ts
111	composition-wire	src/apps/cli/repl/mid-turn-capture-wire.ts
267	composition-wire	src/apps/cli/repl/ndjson-wire.ts
121	composition-wire	src/apps/cli/repl/per-tool-checkpoint-wire.ts
62	impl	src/apps/cli/repl/playbook-trigger-surface-seam.ts
167	composition-wire	src/apps/cli/repl/playbook-trigger-wire.ts
451	impl	src/apps/cli/repl/prompt-pipeline.ts
296	composition-wire	src/apps/cli/repl/prompt-suggestion-wire.ts
43	impl	src/apps/cli/repl/prompt-types.ts
30	impl	src/apps/cli/repl/reviewer-policy.ts
184	composition-wire	src/apps/cli/repl/rewind-restore-coordinator-wire.ts
570	impl	src/apps/cli/repl/runtime-context-compose.ts
5	impl	src/apps/cli/repl/session-deps-compose.ts
290	impl	src/apps/cli/repl/session-host-ports.ts
266	impl	src/apps/cli/repl/session-loop-options.ts
120	impl	src/apps/cli/repl/session-loop.ts
14	impl	src/apps/cli/repl/session-loop/automation.ts
370	bootstrap	src/apps/cli/repl/session-loop/bootstrap.ts
80	impl	src/apps/cli/repl/session-loop/branch-context.ts
67	impl	src/apps/cli/repl/session-loop/close-stack.ts
175	impl	src/apps/cli/repl/session-loop/deps.ts
87	impl	src/apps/cli/repl/session-loop/interactive-branch.ts
299	impl	src/apps/cli/repl/session-loop/interactive-loop.ts
447	impl	src/apps/cli/repl/session-loop/interactive-setup.ts
82	impl	src/apps/cli/repl/session-loop/one-shot-branch.ts
177	impl	src/apps/cli/repl/session-loop/session-switch.ts
89	impl	src/apps/cli/repl/session-loop/turn-driver.ts
470	impl	src/apps/cli/repl/session-loop/turn-helpers.ts
9	types-or-port	src/apps/cli/repl/session-loop/types.ts
131	impl	src/apps/cli/repl/session-loop/wiring-installs.ts
70	impl	src/apps/cli/repl/session-picker.ts
105	impl	src/apps/cli/repl/session-runtime-config.ts
845	impl	src/apps/cli/repl/session-setup.ts
32	impl	src/apps/cli/repl/session-startup-error.ts
33	impl	src/apps/cli/repl/session-state.ts
74	composition-wire	src/apps/cli/repl/session-switch-wire.ts
174	impl	src/apps/cli/repl/skills-surface.ts
898	impl	src/apps/cli/repl/slash-surface.ts
171	composition-wire	src/apps/cli/repl/spinner-stall-live-wire.ts
246	impl	src/apps/cli/repl/sticky-model-boot.ts
12	impl	src/apps/cli/repl/surface-compose.ts
83	impl	src/apps/cli/repl/surface-compose/composer.ts
375	impl	src/apps/cli/repl/surface-compose/core-state.ts
246	impl	src/apps/cli/repl/surface-compose/dispatch-compose.ts
260	impl	src/apps/cli/repl/surface-compose/dispatch.ts
13	impl	src/apps/cli/repl/surface-compose/kb-slot.ts
155	impl	src/apps/cli/repl/surface-compose/mutable-wires.ts
266	impl	src/apps/cli/repl/surface-compose/prompt-ux.ts
112	impl	src/apps/cli/repl/surface-compose/runtime-compose.ts
202	impl	src/apps/cli/repl/surface-compose/slash-context-compose.ts
98	impl	src/apps/cli/repl/surface-compose/turn-sinks.ts
70	types-or-port	src/apps/cli/repl/surface-compose/types.ts
311	impl	src/apps/cli/repl/surface-compose/wire-builders.ts
120	impl	src/apps/cli/repl/turn-cancel-install.ts
193	impl	src/apps/cli/repl/turn-runner.ts
343	composition-wire	src/apps/cli/repl/voice-live-wire.ts
57	impl	src/apps/cli/repl/voice-overlay.ts
585	surface-command	src/apps/cli/replay-cmd.ts
99	impl	src/apps/cli/repo-info.ts
19	impl	src/apps/cli/resume.ts
239	impl	src/apps/cli/retry-with.ts
938	surface-command	src/apps/cli/rewind-cmd.ts
229	surface-command	src/apps/cli/rewind-conv-cmd.ts
239	impl	src/apps/cli/rewind-git.ts
329	surface-command	src/apps/cli/rewind-tool-cmd.ts
393	impl	src/apps/cli/rule-indicator.ts
136	surface-command	src/apps/cli/rules-cmd.ts
26	impl	src/apps/cli/sandbox-mode-parse.ts
199	composition-wire	src/apps/cli/sandbox-wire.ts
547	surface-command	src/apps/cli/serve-stdio-cmd.ts
366	surface-command	src/apps/cli/session-cmd.ts
292	impl	src/apps/cli/session-import-handler.ts
42	impl	src/apps/cli/session-io.ts
41	impl	src/apps/cli/session-list-env.ts
541	surface-command	src/apps/cli/session-registry-cmd.ts
157	impl	src/apps/cli/session-transcript-retention.ts
160	impl	src/apps/cli/shell-stream-painter.ts
301	surface-command	src/apps/cli/side-cmd.ts
179	impl	src/apps/cli/slash-commands-capabilities.ts
623	impl	src/apps/cli/slash-commands-knobs.ts
57	impl	src/apps/cli/slash-commands.ts
469	impl	src/apps/cli/slash-contract.ts
66	impl	src/apps/cli/slash-engine.ts
33	impl	src/apps/cli/slash-ref.ts
303	surface-command	src/apps/cli/slash/attention-cmd.ts
114	surface-command	src/apps/cli/slash/browser-net-cmd.ts
189	surface-command	src/apps/cli/slash/cron-cmd.ts
255	surface-command	src/apps/cli/slash/goal-cmd.ts
155	slash-surface	src/apps/cli/slash/goal-render.ts
85	surface-command	src/apps/cli/slash/kb-cmd.ts
119	surface-command	src/apps/cli/slash/mcp-resources-cmd.ts
185	surface-command	src/apps/cli/slash/model-cmd.ts
191	slash-surface	src/apps/cli/slash/model-picker.ts
248	slash-surface	src/apps/cli/slash/objective.ts
48	surface-command	src/apps/cli/slash/onboard-cmd.ts
279	slash-surface	src/apps/cli/slash/posture.ts
134	surface-command	src/apps/cli/slash/presets-cmd.ts
85	slash-surface	src/apps/cli/slash/registry-app.ts
243	slash-surface	src/apps/cli/slash/registry-session.ts
813	slash-surface	src/apps/cli/slash/registry-surface.ts
238	slash-surface	src/apps/cli/slash/registry-surface/config-posture-cmds.ts
184	slash-surface	src/apps/cli/slash/registry-surface/focus-effort-brief.ts
222	slash-surface	src/apps/cli/slash/registry-surface/preferences-cmds.ts
221	slash-surface	src/apps/cli/slash/render-helpers.ts
205	slash-surface	src/apps/cli/slash/skill.ts
482	surface-command	src/apps/cli/snapshot-cmd.ts
251	impl	src/apps/cli/status-bar.ts
197	surface-command	src/apps/cli/status-cmd.ts
660	impl	src/apps/cli/status-command-runner.ts
69	impl	src/apps/cli/status-flash-config.ts
134	impl	src/apps/cli/status-line-driver.ts
163	impl	src/apps/cli/status-line.ts
330	impl	src/apps/cli/status-pills.ts
296	impl	src/apps/cli/terminal-chrome.ts
93	impl	src/apps/cli/text-inbox.ts
462	impl	src/apps/cli/timeline-panel.ts
340	impl	src/apps/cli/turn-indicator.ts
399	impl	src/apps/cli/turn-summary.ts
234	surface-command	src/apps/cli/undo-cmd.ts
52	impl	src/apps/cli/unhandled-rejection-defense.ts
64	surface-command	src/apps/cli/version-cmd.ts
358	surface-command	src/apps/cli/voice-cmd.ts
222	surface-command	src/apps/cli/voice-live-cmd.ts
60	impl	src/apps/cli/voice-queue.ts
237	surface-command	src/apps/cli/web-cmd.ts
405	impl	src/apps/cli/webhook-server-setup.ts
194	impl	src/apps/cli/welcome-banner.ts
472	surface-command	src/apps/cli/why-cmd.ts
241	impl	src/apps/cli/working-state-panel.ts
228	impl	src/apps/eval/audit/grep-mapper.ts
88	barrel	src/apps/eval/audit/index.ts
44	impl	src/apps/eval/audit/matrix.ts
97	impl	src/apps/eval/audit/rules.ts
41	impl	src/apps/eval/compare/adapter.ts
50	adapter	src/apps/eval/compare/adapters/aider.ts
24	adapter	src/apps/eval/compare/adapters/claude-code.ts
248	adapter	src/apps/eval/compare/adapters/cli-base.ts
39	adapter	src/apps/eval/compare/adapters/cursor.ts
63	adapter	src/apps/eval/compare/adapters/quanta.ts
232	barrel	src/apps/eval/compare/index.ts
205	impl	src/apps/eval/compare/pairwise-judge.ts
129	impl	src/apps/eval/grounding/baseline.ts
618	impl	src/apps/eval/grounding/compare.ts
68	impl	src/apps/eval/grounding/config.ts
61	impl	src/apps/eval/grounding/diagnostics.ts
40	impl	src/apps/eval/grounding/execution-contract.ts
163	impl	src/apps/eval/grounding/file-context.ts
517	impl	src/apps/eval/grounding/gate.ts
42	impl	src/apps/eval/grounding/harness.ts
487	barrel	src/apps/eval/grounding/index.ts
401	impl	src/apps/eval/grounding/loader.ts
498	impl	src/apps/eval/grounding/normalization/heuristic.ts
389	impl	src/apps/eval/grounding/normalization/structural.ts
51	impl	src/apps/eval/grounding/normalizer.ts
122	parser	src/apps/eval/grounding/parser.ts
352	impl	src/apps/eval/grounding/probe.ts
156	impl	src/apps/eval/grounding/referent-context.ts
453	impl	src/apps/eval/grounding/regression.ts
395	impl	src/apps/eval/grounding/replay-scaffold.ts
611	impl	src/apps/eval/grounding/report.ts
58	impl	src/apps/eval/grounding/route-matrix.ts
694	schema	src/apps/eval/grounding/schema.ts
66	impl	src/apps/eval/grounding/scorer.ts
12	impl	src/apps/eval/grounding/stable-json.ts
956	barrel	src/apps/eval/index.ts
130	adapter	src/apps/eval/public/adapters/swebench.ts
4	barrel	src/apps/eval/public/index.ts
53	impl	src/apps/eval/public/mapping.ts
213	impl	src/apps/eval/report/coverage-matrix.ts
32	barrel	src/apps/eval/report/index.ts
76	impl	src/apps/eval/report/markdown.ts
12	barrel	src/apps/eval/storage/index.ts
326	impl	src/apps/eval/storage/result-store.ts
255	schema	src/apps/eval/storage/schema.ts
218	impl	src/apps/eval/synthetic/generator.ts
250	barrel	src/apps/eval/synthetic/index.ts
181	impl	src/apps/eval/synthetic/judge.ts
315	impl	src/apps/eval/synthetic/runner.ts
176	impl	src/apps/eval/synthetic/scenario.ts
161	impl	src/apps/eval/taxonomy/classifier.ts
45	impl	src/apps/eval/taxonomy/doc-sync.ts
57	barrel	src/apps/eval/taxonomy/index.ts
405	impl	src/apps/eval/taxonomy/usecases.ts
154	impl	src/apps/eval/trajectory/classifier.ts
152	impl	src/apps/eval/trajectory/diff.ts
59	impl	src/apps/eval/trajectory/freeze.ts
21	barrel	src/apps/eval/trajectory/index.ts
119	impl	src/apps/eval/trajectory/meta.ts
135	impl	src/apps/eval/trajectory/redacted-export.ts
328	impl	src/apps/eval/trajectory/replay.ts
122	impl	src/apps/eval/trajectory/source.ts
26	types-or-port	src/apps/eval/types.ts
98	impl	src/apps/headless/approval-wiring.ts
149	impl	src/apps/headless/fake-deps.ts
58	impl	src/apps/headless/fake-llm.ts
230	barrel	src/apps/headless/index.ts
142	impl	src/apps/headless/session-bridge.ts
157	types-or-port	src/apps/headless/types.ts
113	impl	src/apps/probe/funnel.ts
274	barrel	src/apps/probe/index.ts
195	impl	src/apps/probe/parse.ts
228	impl	src/apps/probe/render.ts
200	impl	src/apps/probe/triage.ts
44	impl	src/apps/terminal/brain-approval-posture.ts
153	impl	src/apps/terminal/brain-mode-session-scaffold.ts
959	impl	src/apps/terminal/brain-mode.ts
79	barrel	src/apps/terminal/index.ts
15	impl	src/apps/terminal/verify-gate.ts
60	impl	src/apps/web-daemon/agent-state-source.ts
286	impl	src/apps/web-daemon/auth-routes.ts
120	impl	src/apps/web-daemon/authority-readouts.ts
69	impl	src/apps/web-daemon/canvas-artifact-source.ts
280	impl	src/apps/web-daemon/canvas-emitter.ts
93	impl	src/apps/web-daemon/canvas-fanout.ts
177	impl	src/apps/web-daemon/canvas-tool-diff-source.ts
69	impl	src/apps/web-daemon/canvas-usage-source.ts
60	impl	src/apps/web-daemon/control-request-frame.ts
52	impl	src/apps/web-daemon/follower-verb-frame.ts
106	impl	src/apps/web-daemon/goal-state-source.ts
82	impl	src/apps/web-daemon/goal-verify-compose.ts
39	impl	src/apps/web-daemon/goal-verify-frame.ts
210	impl	src/apps/web-daemon/goal-wake-compose.ts
172	impl	src/apps/web-daemon/goal-work-compose.ts
71	impl	src/apps/web-daemon/goal-work-frame.ts
493	barrel	src/apps/web-daemon/index.ts
70	composition-wire	src/apps/web-daemon/knob-catalog-wire.ts
313	impl	src/apps/web-daemon/observability-emitter.ts
168	impl	src/apps/web-daemon/persistence-sqlite.ts
82	impl	src/apps/web-daemon/readout-compose.ts
739	impl	src/apps/web-daemon/readout.ts
527	composition-root	src/apps/web-daemon/runtime-factory.ts
352	composition-root	src/apps/web-daemon/runtime-factory/agent-config-base.ts
98	composition-root	src/apps/web-daemon/runtime-factory/daemon-mcp.ts
203	composition-root	src/apps/web-daemon/runtime-factory/observable-facade.ts
128	composition-root	src/apps/web-daemon/runtime-factory/readout-sources.ts
445	composition-root	src/apps/web-daemon/runtime-factory/session-collaborators.ts
106	composition-root	src/apps/web-daemon/runtime-factory/session-observability.ts
693	impl	src/apps/web-daemon/server.ts
114	impl	src/apps/web-daemon/server/approval-continuation.ts
37	impl	src/apps/web-daemon/server/auth.ts
52	impl	src/apps/web-daemon/server/canvas-artifact-bridge.ts
545	impl	src/apps/web-daemon/server/fetch-handler.ts
93	impl	src/apps/web-daemon/server/follower-approval.ts
394	impl	src/apps/web-daemon/server/http.ts
99	impl	src/apps/web-daemon/server/net.ts
38	impl	src/apps/web-daemon/server/persistence.ts
348	impl	src/apps/web-daemon/server/sinks.ts
120	impl	src/apps/web-daemon/server/thread-hydrate.ts
148	impl	src/apps/web-daemon/server/transcript-persist.ts
56	impl	src/apps/web-daemon/server/ws-data.ts
517	impl	src/apps/web-daemon/server/ws-handlers.ts
76	impl	src/apps/web-daemon/session-registry.ts
153	impl	src/apps/web-daemon/subagent-source.ts
72	types-or-port	src/apps/web-daemon/types.ts
195	port	src/apps/web-daemon/web-ask-user-port.ts
259	port	src/apps/web-daemon/web-control-request-port.ts
171	impl	src/apps/web-daemon/web-model-switch.ts
167	port	src/apps/web-daemon/web-user-input-port.ts
153	adapter	src/apps/web-daemon/ws-adapter.ts
366	bootstrap	src/host/bootstrap/bootstrap-session.ts
34	bootstrap	src/host/bootstrap/bootstrap-session/bootstrap-fault.ts
74	bootstrap	src/host/bootstrap/bootstrap-session/capability-probe.ts
216	bootstrap	src/host/bootstrap/bootstrap-session/prepare-runtime.ts
260	bootstrap	src/host/bootstrap/bootstrap-session/session-state-ports.ts
144	bootstrap	src/host/bootstrap/bootstrap-session/startup-announcement.ts
238	bootstrap	src/host/bootstrap/bootstrap-session/tooling-bundle.ts
48	barrel	src/host/bootstrap/index.ts
97	bootstrap	src/host/bootstrap/live-posture-runtime.ts
55	bootstrap	src/host/bootstrap/route-event-forwarder.ts
680	types-or-port	src/host/bootstrap/types.ts
923	impl	src/host/mcp-composition.ts
36	impl	src/host/mcp-health.ts
77	impl	src/host/runtime/agent-arg-builder-config-slots.ts
886	impl	src/host/runtime/agent-arg-builder.ts
90	composition-wire	src/host/runtime/agent-arg-builder/boot-port-wire.ts
90	composition-wire	src/host/runtime/agent-arg-builder/command-hooks-wire.ts
540	impl	src/host/runtime/agent-arg-builder/gated-tool-ports.ts
7	composition-wire	src/host/runtime/agent-arg-builder/identity-wire.ts
274	composition-wire	src/host/runtime/agent-arg-builder/model-switch-wire.ts
112	composition-wire	src/host/runtime/agent-arg-builder/observability-wire.ts
289	impl	src/host/runtime/agent-arg-builder/permission-profile.ts
881	impl	src/host/runtime/agent-args.ts
130	impl	src/host/runtime/agent-config-assemble-types.ts
895	impl	src/host/runtime/agent-config-assembler.ts
179	composition-wire	src/host/runtime/appshot-port-wire.ts
73	impl	src/host/runtime/artifact-drain.ts
109	impl	src/host/runtime/artifact-preview-resolver.ts
167	impl	src/host/runtime/base-slot-registry.ts
318	impl	src/host/runtime/batch-jobs-sqlite-store.ts
86	impl	src/host/runtime/budget-ledger-persist.ts
8	impl	src/host/runtime/builder.ts
59	impl	src/host/runtime/capabilities.ts
259	impl	src/host/runtime/capability-wire-registry.ts
108	barrel	src/host/runtime/index.ts
660	impl	src/host/runtime/internal/context-binding.ts
479	impl	src/host/runtime/internal/context-binding/approval-protocol.ts
180	impl	src/host/runtime/internal/context-binding/approval-support.ts
592	impl	src/host/runtime/internal/context-binding/base.ts
286	impl	src/host/runtime/internal/context-binding/objective-settlement.ts
58	composition-wire	src/host/runtime/internal/context-binding/rewind-capture-wire.ts
185	impl	src/host/runtime/internal/context-binding/side-conversation.ts
356	impl	src/host/runtime/internal/context-binding/turn-runner.ts
418	types-or-port	src/host/runtime/internal/context-binding/types.ts
65	impl	src/host/runtime/internal/mention-app-plugin-deps.ts
376	impl	src/host/runtime/internal/mention-source-deps.ts
210	impl	src/host/runtime/internal/mention-symbol-deps.ts
90	composition-wire	src/host/runtime/internal/mention-wire.ts
206	impl	src/host/runtime/internal/session-host-turn-event-bridge.ts
99	impl	src/host/runtime/keyring/compose.ts
18	barrel	src/host/runtime/keyring/index.ts
71	impl	src/host/runtime/keyring/libsecret.ts
72	impl	src/host/runtime/keyring/macos.ts
24	impl	src/host/runtime/keyring/null.ts
72	types-or-port	src/host/runtime/keyring/port.ts
40	impl	src/host/runtime/keyring/select.ts
34	impl	src/host/runtime/keyring/serialize.ts
241	composition-wire	src/host/runtime/mcp-connector-wire.ts
470	impl	src/host/runtime/mcp-oauth-provider.ts
94	impl	src/host/runtime/mcp-roots-provider.ts
243	impl	src/host/runtime/mcp-sampling-handler.ts
147	impl	src/host/runtime/mcp-tool-reload.ts
262	composition-wire	src/host/runtime/objective-store-wire.ts
752	composition-wire	src/host/runtime/objective-verifier-wire.ts
5	impl	src/host/runtime/operator-review.ts
94	composition-wire	src/host/runtime/peer-message-sink-wire.ts
92	composition-wire	src/host/runtime/peer-team-wire.ts
32	impl	src/host/runtime/persistence.ts
99	composition-wire	src/host/runtime/pii-redaction-wire.ts
90	composition-wire	src/host/runtime/progress-sink-wire.ts
317	impl	src/host/runtime/pty-backend.ts
226	composition-wire	src/host/runtime/sandbox-escalation-wire.ts
165	composition-wire	src/host/runtime/security-rails-wire.ts
4	impl	src/host/runtime/session-host.ts
238	port	src/host/runtime/side-agent-fork-port.ts
19	impl	src/host/runtime/side-agent-worker-asset.d.ts
92	impl	src/host/runtime/sips-image-downsample.ts
2	impl	src/host/runtime/tool-executor.ts
22	types-or-port	src/host/runtime/types.ts
40	composition-wire	src/host/runtime/usage-accounting-wire.ts
315	impl	src/observability/attrs.ts
79	impl	src/observability/codex-r2-metrics/cache-metrics-decorator.ts
20	barrel	src/observability/codex-r2-metrics/index.ts
141	adapter	src/observability/codex-r2-metrics/metrics-adapter.ts
83	impl	src/observability/codex-r2-metrics/registry-metrics-decorator.ts
55	types-or-port	src/observability/codex-r2-metrics/types.ts
70	impl	src/observability/context-only-sink.ts
165	impl	src/observability/cost-dashboard.ts
481	impl	src/observability/coverage/ast-source.ts
354	impl	src/observability/coverage/c8-source.ts
44	barrel	src/observability/coverage/index.ts
328	impl	src/observability/coverage/istanbul-shape-emitter.ts
630	impl	src/observability/coverage/istanbul-source.ts
156	impl	src/observability/coverage/merge.ts
140	types-or-port	src/observability/coverage/port.ts
122	impl	src/observability/coverage/reporter.ts
397	impl	src/observability/coverage/v8-source.ts
55	impl	src/observability/delta-stream.ts
153	impl	src/observability/failure-taxonomy/classify.ts
35	barrel	src/observability/failure-taxonomy/index.ts
105	types-or-port	src/observability/failure-taxonomy/types.ts
76	barrel	src/observability/index.ts
78	impl	src/observability/logger.ts
126	impl	src/observability/memory-telemetry.ts
139	impl	src/observability/metrics.ts
35	impl	src/observability/metrics/console-sink.ts
142	impl	src/observability/metrics/decision-counter-sink.ts
239	impl	src/observability/metrics/health-snapshot-watcher.ts
225	impl	src/observability/metrics/health-snapshot.ts
736	impl	src/observability/metrics/in-memory-registry.ts
40	barrel	src/observability/metrics/index.ts
63	impl	src/observability/metrics/instrument-budget.ts
157	impl	src/observability/metrics/instrument-genai.ts
95	impl	src/observability/metrics/instrument-lsp.ts
125	impl	src/observability/metrics/instrument-plan-queue.ts
159	impl	src/observability/metrics/instrument-shadow.ts
491	impl	src/observability/metrics/instrument-tool-dedup.ts
97	impl	src/observability/metrics/instrument-tool.ts
262	impl	src/observability/metrics/instrument.ts
44	impl	src/observability/metrics/jsonl-sink.ts
79	impl	src/observability/metrics/new-slice-instruments.ts
28	impl	src/observability/metrics/objective-lifecycle.ts
232	impl	src/observability/metrics/observability-helper.ts
164	impl	src/observability/metrics/otel-resource.ts
302	impl	src/observability/metrics/otel-sink.ts
317	impl	src/observability/metrics/otlp-helper.ts
155	types-or-port	src/observability/metrics/port.ts
85	impl	src/observability/metrics/wire-new-slices.ts
154	impl	src/observability/ndjson/encoder.ts
45	barrel	src/observability/ndjson/index.ts
110	impl	src/observability/ndjson/ring-buffer.ts
182	impl	src/observability/ndjson/sinks.ts
120	types-or-port	src/observability/ndjson/types.ts
648	impl	src/observability/otel-exporter.ts
322	impl	src/observability/otel-exporter/otlp-encode.ts
82	impl	src/observability/otel-exporter/retry-policy.ts
304	impl	src/observability/otel-exporter/transport.ts
258	impl	src/observability/otel-span-export.ts
71	impl	src/observability/otlp-attr-value.ts
14	barrel	src/observability/patch-trace/index.ts
66	impl	src/observability/patch-trace/otel-patch-trace.ts
42	impl	src/observability/payload-preview.ts
145	impl	src/observability/pricing.ts
88	impl	src/observability/prompt-cache/budget-bridge.ts
64	impl	src/observability/prompt-cache/default-pricing.ts
435	impl	src/observability/prompt-cache/default.ts
28	barrel	src/observability/prompt-cache/index.ts
197	types-or-port	src/observability/prompt-cache/types.ts
47	impl	src/observability/semconv-pin.ts
62	impl	src/observability/shell-exec-otel.ts
323	impl	src/observability/spans.ts
56	impl	src/observability/tracing/active-context.ts
23	impl	src/observability/tracing/hex-id.ts
31	barrel	src/observability/tracing/index.ts
178	impl	src/observability/tracing/noop-tracer.ts
389	impl	src/observability/tracing/otel-tracer.ts
133	types-or-port	src/observability/tracing/port.ts
116	impl	src/observability/tracing/w3c-propagator.ts
162	impl	src/observability/turn-timing.ts
69	types-or-port	src/observability/types.ts
52	impl	src/observability/usage-accounting/activation.ts
290	impl	src/observability/usage-accounting/authority.ts
449	impl	src/observability/usage-accounting/durable-codec.ts
39	barrel	src/observability/usage-accounting/index.ts
83	impl	src/observability/usage-accounting/normalize.ts
136	types-or-port	src/observability/usage-accounting/port.ts
74	impl	src/observability/usage-accounting/price.ts
149	impl	src/observability/usage-accounting/projection.ts
128	types-or-port	src/observability/usage-accounting/types.ts
538	impl	src/observability/vocabulary.ts
185	impl	src/observability/work-metrics.ts
57	impl	src/radar/headless-stub.ts
56	impl	src/radar/heuristics/idle-long-task.ts
137	impl	src/radar/in-memory-store.ts
27	barrel	src/radar/index.ts
292	impl	src/radar/jsonl-file-store.ts
66	types-or-port	src/radar/port.ts
121	types-or-port	src/radar/types.ts
38	adapter	src/reactor/agent-outcome-adapter.ts
45	barrel	src/reactor/index.ts
193	impl	src/reactor/self-wake.ts
284	impl	src/reactor/trigger-source-ci.ts
351	impl	src/reactor/trigger-source-pr-comment.ts
197	types-or-port	src/reactor/types.ts
509	impl	src/scheduler/automation-engine/in-memory.ts
45	barrel	src/scheduler/automation-engine/index.ts
289	types-or-port	src/scheduler/automation-engine/port.ts
70	impl	src/scheduler/automation-engine/run-model.ts
172	impl	src/scheduler/automation-engine/sqlite.ts
522	impl	src/scheduler/automation-engine/sqlite/operations.ts
123	impl	src/scheduler/automation-engine/sqlite/statements.ts
182	impl	src/scheduler/automation-engine/ticker.ts
260	adapter	src/scheduler/cron-slash-adapter.ts
113	impl	src/scheduler/deeplink-route.ts
51	impl	src/scheduler/deeplink.ts
106	barrel	src/scheduler/index.ts
137	impl	src/scheduler/model-reroute.ts
329	impl	src/scheduler/next-fire.ts
311	parser	src/scheduler/rrule-parser.ts
387	composition-wire	src/scheduler/runtime-wire.ts
388	types-or-port	src/scheduler/types.ts
170	impl	src/scheduler/weekday.ts
356	impl	src/sdk/connect.ts
189	impl	src/sdk/embed.ts
32	impl	src/sdk/errors.ts
24	impl	src/sdk/events.ts
104	barrel	src/sdk/index.ts
50	impl	src/sdk/profiles.ts
170	impl	src/sdk/run.ts
120	impl	src/sdk/runtime/base.ts
432	impl	src/sdk/runtime/context.ts
5	impl	src/sdk/runtime/create-runtime.ts
333	adapter	src/sdk/runtime/handle-adapter.ts
31	barrel	src/sdk/runtime/index.ts
58	impl	src/sdk/runtime/runtime.ts
229	impl	src/sdk/runtime/session.ts
319	impl	src/sdk/runtime/session/engine.ts
136	impl	src/sdk/runtime/session/rehydrate.ts
67	impl	src/sdk/runtime/session/turn-submit-authority.ts
16	impl	src/sdk/runtime/subscription.ts
26	impl	src/sdk/runtime/transport.ts
181	types-or-port	src/sdk/runtime/types.ts
72	impl	src/sdk/testing.ts
13	types-or-port	src/sdk/types.ts
6	impl	src/sdk/version.ts
8	barrel	src/ui/index.ts
263	impl	src/ui/ui-helpers.ts
86	impl	src/workflow/builders.ts
88	impl	src/workflow/compile.ts
345	impl	src/workflow/executor.ts
44	barrel	src/workflow/index.ts
43	impl	src/workflow/semaphore.ts
93	impl	src/workflow/spec.ts
64	impl	src/workflow/structured.ts
236	types-or-port	src/workflow/types.ts
```

DONE
