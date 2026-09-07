# W1-C receipt — Sep-07 SOLID/SE and duplicate-development audit

```text
AUDIT_ASSIGNMENT|lane=C|scope=mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-C.md
```

## Snapshot

W0 receipt was **absent** at start and still absent at write. Coordinator dispatched
lane C against a dirty shared checkout. Exclusive C production paths are **clean vs
HEAD**; inspection used the working tree, which equals HEAD for those paths.
Uncommitted files are outside this claim.

| Field | Value |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| ahead/behind | `0 0` |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged/tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked manifest SHA-256 | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` |
| C production porcelain | empty (pre and post) |
| post-inspection HEAD / diffs / untracked | identical to pre |

Authority-document hashes (working tree; captured pre and post, unchanged):

| Path | SHA-256 |
|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
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
| tests/unit/_arch/slice-boundary-configs.ts (WT) | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` |
| tests/unit/_arch/slice-boundary-scanner.ts (WT) | `2742c83e4b13c5714f4fae96dcd1f6d3572f982ed17d2cb7066727b4c71aa25c` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

`docs/ARCHITECTURE.md` and `slice-boundary-configs.ts` differ HEAD vs working tree.
Those files are W2/W3 reserved. Lane C did not use the dirty ARCHITECTURE text as
ownership proof; live TypeScript under `src/{mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime}` is the owner.

If a later W0 receipt names a different HEAD or a different tracked/untracked hash,
this receipt is **STALE**.

Overlay: four read-only shard inspectors finished after the first write. New
rows below were re-checked on owner source (not grep-only) before merge. Untracked
hash now includes this receipt file; HEAD and tracked-diff hashes are unchanged.

## Coverage counts

| Universe | Count |
|---|---:|
| Exclusive production `src/**/*.ts` (tests excluded) | 212 |
| Classified | 212 |
| Unclassified | 0 |
| Colocated `src/**/__tests__/**` | 14 |
| Heuristic root/unit tests whose path names a C SUT | 291 (navigation set; not all SUT-owned) |
| God-MODULE >1000 in C | 0 |
| Cohort 900–999 in C | 0 |
| God-FUNCTION >150 (official detector allowlist has **no** C entries; crude span detector over-counted class bodies) | 0 confirmed |

By slice (production files / lines):

| Slice | Files | Lines |
|---|---:|---:|
| mcp | 62 | 8841 |
| lsp | 34 | 3997 |
| protocol | 26 | 3981 |
| ipc | 26 | 5814 |
| connectors | 21 | 2598 |
| integrations | 14 | 3111 |
| remote | 10 | 1403 |
| realtime | 19 | 2193 |

Approaching-cohort inventory (not findings; no failure mode):
`src/mcp/client.ts` 888, `src/ipc/session/handle.ts` 880,
`src/ipc/session/bridge.ts` 879, `src/lsp/adapters/base.ts` 850.

## Inspected consumer paths

Owner code plus at least one reachable consumer was read for every cluster below.

| Owner (C) | Consumer inspected | Lane of consumer |
|---|---|---|
| `mcp/isolated-client.ts` `isolatedMcpEnabledFromEnv` | **no production caller**; tests only; host factory always `new McpClient` | G (`src/host/mcp-composition.ts:135`) |
| `mcp/isolated-client.ts` class | `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:93` | A |
| `mcp/client.ts` + `client/negotiate.ts` | `src/host/mcp-composition.ts` factory; `src/agent/mcp-bridge.ts:409` | G / A |
| `mcp/capabilities/{default,full}-negotiator.ts` | `src/host/runtime/agent-arg-builder.ts` `pickMcpNegotiator` | G |
| `mcp/transports/http-sse.ts` `classifyStandaloneGetResponse` | in-process `McpClient.start` via default HTTP factory | C / A |
| `mcp/transports/stdio.ts` `buildEnv` | `McpClient` default stdio carrier | C |
| `mcp/reconnect/supervisor.ts` | `mcpSupervisorDepsFor` always wraps `McpClient` | G |
| `mcp/jsonrpc.ts` | stdio transport `LineReader` | C |
| `lsp/adapters/base/atomic-edit.ts` | `LspClient.applyWorkspaceEdit` (`base.ts:503`); `tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` | C / tests |
| `lsp/adapters/file-write-atomic.ts` | **no `src/` production caller**; tests only (`lsp-atomic-write-hellgate`) | C / tests |
| `mcp/client.ts` `doReauthorize` | HTTP 401 path; `tests/unit/mcp-cluster-hardening-r2-hellgate.test.ts` (synthetic transport) | C / tests |
| `mcp/client/inbound-router.ts` + `sampling/inbound-router.ts` | `McpClient.dispatch` | C |
| `remote/runner/registry.ts` | `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})` | G |
| `integrations/github/idempotency.ts` | `webhook-server.ts` `createDurableDeliveryStore` | C |
| `protocol/session/codec.ts` `decodeSessionEvent` | `ipc/session/codec.ts` + `bridge.ts` fan-out | C |
| `lsp/adapters/base/diagnostics-hub.ts` | `LspClient.diagnostics()` | C |
| `lsp/adapters/base/transport.ts` spawn env | `resolveLspMemBudgetMb(process.env)` at spawn | C |
| `protocol/session/{commands,builders,codec,verb-surface}.ts` | `src/ipc/session/handle.ts` `buildWireVerbSurface`; `src/kernel/session/scheduler.ts` cases | C / D |
| `protocol/session/codec.ts` | `src/ipc/session/codec.ts` re-exports `decodeSessionCommand` | C |
| `ipc/session/handle.ts` | `src/sdk/runtime/handle-adapter.ts` compile pins | G |
| `ipc/session/transports/stdio.ts` | `createSessionStdioServer`; `tests/unit/ipc/session-transport-liveness.test.ts` | C / tests |
| `ipc/transports/stdio.ts` | event-bridge CLI↔daemon framing | C |
| `ipc/session-export.ts` / `session-import.ts` | `tests/unit/ipc/session-export-import.test.ts`; CLI `/session import` uses **session** envelope not portable | C / G |
| `connectors/token-rotation.ts` | `token-refresh-scheduler.ts` calls `TokenRotator.rotate` (no second mutex) | C |
| `connectors/custom-3p/{in-memory-registry,jsonl-store}.ts` | jsonl wraps in-memory; duplicated `validateEndpoint` | C |
| `integrations/github/{signature-verify,webhook-server,webhook-secret-resolver}.ts` | webhook POST pipeline HMAC → 401 | C |
| `integrations/github/outbound-body-policy.ts` | `pr-output-sink.ts`; twin `src/tool/gh/outbound-body-policy.ts` | C / B |
| `remote/runner/{lima,docker,apple-vz}-adapter.ts` | `selectRemoteRunner` in `src/apps/cli/index.ts` | G |
| `mcp/skybridge/lima-microvm.ts` | `detectLima` uses binary name `lima` vs remote `limactl` | C |
| `realtime/default-adapter.ts` | `src/realtime/index.ts` barrel; web-daemon `@/realtime` import count not re-run (catalog #74 retired unless new consumer) | C |
| `protocol/subagent/projection.ts` | `redactSecrets` from `@/security` (allowed); daemon sink type | F type/value |

## Findings

Retired SEP5/SEP6 IDs were not reopened: D9, D19, D24, D25, D29, D30, D6, D11, D20.
Aug-25 items are not those IDs; live reproduction on this HEAD is reported as **new**
campaign findings.

### C-F1 [P1] `MCP_USE_ISOLATED_SPAWN` gate has no production ingress

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/mcp/isolated-client.ts:56-64` (`isolatedMcpEnabledFromEnv`)
- **second owner / claimed swap:** `src/host/mcp-composition.ts:121-135` always `return new McpClient(c, clientOpts)`
- **invariant:** documented default-OFF swap of spawn implementation when env is `1`/`true`/`yes`
- **failure:** operator sets the env; host MCP still uses `McpClient` + `Bun.spawn`. Promised 5s spawn timeout and SIGTERM→SIGKILL grace do not apply. Feature catalog `162-mcp-isolated-spawn.yaml` and the module docstring still describe the swap.
- **producer → contract → consumer:** env parser (C) produces a boolean; no composition root consumes it. `rg` of `isolatedMcpEnabledFromEnv` / `IsolatedMcpClient` in `src/apps`, `src/host`, `src/agent/mcp-bridge.ts` is empty. Sole live constructor is `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:93`, which **always** uses isolated and ignores the env.
- **test honesty:** `tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts` asserts the parser only. Removing a non-existent factory branch cannot turn RED. Anti-vacuum on the env helper is not a composition rail.
- **not D24 / not SEP5 closed twins:** this is a dead enablement gate, not lima-vs-lima lifecycle comparison.
- **proposed write set (C):** `src/mcp/isolated-client.ts` (stop advertising a swap the slice cannot perform, or export a factory the composition root must call). **Forbidden C writes:** catalog YAML, host composition (lane G), agent launcher (lane A). W2-X must assign the wire vs delete-docs split.
- **proof limit:** static owner+consumer universe (`src/**` call sites of `isolatedMcpEnabledFromEnv`). Runtime with the env set was not executed.

### C-F2 [P2] `SessionVerbSurface` is a second, narrower owner of public session.v1 verbs

- **status:** open
- **attribution:** pre-existing (Aug-25 #73 shape; **not** SEP5 D9, which closed factory-merge of existing verbs)
- **owners:** `src/protocol/session/verb-surface.ts:55-101` vs `SESSION_COMMAND_TYPES` in `src/protocol/session/commands.ts:221-234` plus builders in `builders.ts` (`buildPostureSet`, `buildSkillSetEnabled`, `buildObjectiveMutate`) and kernel cases in `src/kernel/session/scheduler.ts`
- **measured drift:** three commands have fail-closed codec arms (`codec.ts:193-227`) and kernel dispatch, but `buildWireVerbSurface` (`src/ipc/session/handle.ts:675-728`) has no `posture` / `skill` / `objective` methods. `SessionHandle` therefore cannot mint them. `SessionTransportClient.sendCommand` remains a raw escape hatch.
- **consumer:** `src/sdk/runtime/handle-adapter.ts` compile-pins `RuntimeSession` to `SessionVerbSurface` — in-process SDK inherits the same hole. CLI `/posture` and host projections bypass the wire surface.
- **failure:** a wire `SessionHandle` peer cannot issue RFC-03/05/06 commands the server already accepts. Surfaces invent local slash/OOB paths instead of one verb table.
- **proposed write set (C):** `src/protocol/session/verb-surface.ts`, `src/ipc/session/handle.ts` `buildWireVerbSurface`. **Forbidden:** kernel scheduler (D), sdk adapter (G) except type pins after protocol adds methods.
- **proof limit:** static API/codec/kernel comparison. No live SDK client was driven to prove a user-visible hang; the typed surface simply cannot express the commands.

### C-F3 [P2] LSP workspace-edit commit has no EXDEV fallback; file-write-atomic does

- **status:** open
- **attribution:** pre-existing
- **owners:** `src/lsp/adapters/base/atomic-edit.ts:113-131` (any rename failure throws; partial commit of files `1..K-1`) vs `src/lsp/adapters/file-write-atomic.ts:190-198` (`isExdev` → `commitViaCopyFallback`)
- **not D29:** D29 is storage vs lsp atomic-write ports. This is **intra-`@/lsp`** two commit strategies for the same POSIX rename.
- **measured drift:** hellgate `tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` **requires** EXDEV to throw (`rename EXDEV`, tmp files remain). Hellgate `tests/unit/lsp-atomic-write-hellgate.test.ts` ATOMW-C11 **requires** EXDEV to copy+warn.
- **consumer:** `LspClient.applyWorkspaceEdit` (`base.ts:512`) is the live production path. `atomicFileWriteStrategy` has **zero** `src/` callers outside its defining files — ADR-0155 port is test-only. Hellgate headers that claim “strategy DI” do not reach `LspClient`.
- **failure:** cross-filesystem workspace apply aborts with partial files on disk. The EXDEV copy fallback exists only on the unwired sibling, so production cannot take it.
- **proposed write set (C):** wire `LspClient` to `FileWriteStrategy` **or** lift EXDEV into `atomic-edit.ts` and retire the dead sibling. Update the applyWorkspaceEdit hellgate so the live ingress has RED. **Forbidden:** `src/storage/atomic-write.ts` (D29).
- **proof limit:** tests encode both behaviors; live EXDEV on a two-mount fixture was not reproduced in this audit.

### C-F4 [P2] Isolated initialize is a weaker copy of `McpClient` initialize

- **status:** open
- **attribution:** pre-existing (Aug-25 #67/#84 live on this HEAD)
- **owners:** `src/mcp/client.ts` `initializeWithDowngrade` + injected `CapabilityNegotiator` vs `src/mcp/isolated-client.ts:219-223` (`capabilities: {}`, single `host.call("initialize")`) and private `pinNegotiatedVersion` at `:361-376` (copy of `client/negotiate.ts:76-95` without header pin / without downgrade)
- **consumer:** `createIsolatedMcpLauncherPort` always constructs isolated; host `QUANTA_MCP_CAPS=full` never reaches this path.
- **failure:** plugin-isolated MCP cannot advertise elicitation/tasks/sampling/roots even when the host knob is full. A strict server that JSON-RPC-rejects the newest protocol version fails permanently on isolated; in-process retries `PROTOCOL_DOWNGRADE_FLOOR`.
- **proposed write set (C):** `src/mcp/isolated-client.ts` initialize to call `initializeWithDowngrade` / `pinNegotiatedVersion` / optional negotiator. **Forbidden:** rewriting plugin-isolation JSON-RPC (lane B) as a substitute for offering the same initialize contract.
- **proof limit:** static initialize payloads. Dual-flag runtime (`QUANTA_MCP_CAPS=full` + plugin launcher) not executed. Default-OFF plugin launcher means the failure is latent until that composition root is wired.

### C-F5 [P2] Session stdio transport does not observe reader EOF; event-bridge stdio does

- **status:** open
- **attribution:** pre-existing (comment names deferred ticket 02)
- **owners:** `src/ipc/session/transports/stdio.ts:20-27,107-124` (data-only; teardown on owner close, writer throw, frame cap) vs `src/ipc/transports/stdio.ts:35-40` (subscribes `end`/`close`/`error`)
- **consumer:** `createSessionStdioServer` → `serve --stdio` (lane G). Spawned children have a separate exit path in `stdio-spawn.ts`. Direct stdin/stdout does not.
- **failure:** a peer that exits cleanly (EOF, no EPIPE on next write) leaves session waiters and `onClose` unset. Correlator hang-guard in `handle.ts` depends on `onConnectionState closed`.
- **proposed write set (C):** `src/ipc/session/transports/stdio.ts` feature-detect lifecycle like the sibling, fail closed to `teardown("reader_eof")`. **Forbidden:** changing event-bridge drop-invalid-line policy as if it were this bug.
- **proof limit:** static sibling comparison + comments. EOF hang was not executed against `quanta serve --stdio`.

### C-F6 [P1] `selectRemoteRunner` docker/lima seams are never injected at the only consumer

- **status:** open
- **attribution:** pre-existing (Aug-25 #90 CLI-only; this is the missing composition, not a second reader)
- **owner:** `src/remote/runner/registry.ts:62-76` — docker/lima return `null` when `dockerProcess` / (`limaProcess`+`limaVm`) absent
- **consumer:** `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})`
- **failure:** `QUANTA_REMOTE_RUNNER=docker|lima` cannot select a live adapter. Registry is honest (`null` = missing seam); the only production caller never supplies seams, so adapters are dead. apple-vz still constructs and then `daemon-unavailable` (fail-closed-ish).
- **proposed write set (C):** `src/remote/runner/registry.ts` only if the contract should refuse names whose seams the composition root cannot supply. **Forbidden C writes:** `src/apps/cli/index.ts` (lane G) — W2-X assigns the seam factory.
- **proof limit:** static registry+CLI. `quanta remote` was not executed.

### C-F7 [P1] `QUANTA_REMOTE_RUNNER=headless` is a production synthetic-success runner

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/remote/runner/registry.ts:69-70` (headless needs no seam) + `src/remote/runner/headless-stub.ts:93-103` (`timeoutMs !== 0` → `succeeded` / exit 0 without exec)
- **consumer:** same CLI `routeRemote`
- **failure:** unlike docker/lima, headless is selectable with `{}` and reports remote success. LSP-weaker than `RemoteRunner` (no job, no VM). Operator can believe a remote run happened.
- **proposed write set (C):** `headless-stub.ts` / registry — refuse headless unless an explicit test seam, or mark status `headless` so CLI cannot print success as remote. **Forbidden:** treating skybridge lima as this runner (D24).
- **proof limit:** static spawn record. CLI binary not run.

### C-F8 [P2] Two inbound sampling in-flight caps

- **status:** open
- **attribution:** pre-existing
- **owners:** `src/mcp/client/inbound-router.ts:30,199-210` `MAX_INBOUND_SAMPLING_IN_FLIGHT` vs `src/mcp/sampling/inbound-router.ts:37,169-183` `SAMPLING_MAX_IN_FLIGHT` (both 8 today; separate counters; outer `-32000` vs inner decline message)
- **consumer:** `McpClient.dispatch` → `handleInboundSampling` then `routeSampling`
- **failure:** two writable constants for one DoS bound. Changing one leaves a silent inner/outer mismatch. No test pins single authority.
- **proposed write set (C):** one exported constant; one counter. Prefer keeping the client-router DoS gate **or** delegating entirely to `routeSampling`.
- **proof limit:** static dual increment. Concurrent sampling storm not executed.

### C-F9 [P2] HTTP OAuth reauthorize rebuilds the carrier without MCP `initialize`

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/mcp/client.ts:822-845` `doReauthorize` — `next.start()` only
- **second owner:** `src/mcp/transports/http-sse.ts` session id assigned on initialize POST
- **failure:** mid-session 401 on Streamable-HTTP: new transport has `sessionId=null`; subsequent POSTs can be rejected or attach to a different session while pending RPC ids are reused on the rebuilt carrier.
- **proposed write set (C):** `client.ts` re-run initialize (or a transport session-rebind) after rebuild. Stdio OAuth path unchanged.
- **proof limit:** static control flow. Existing oauth hellgates use synthetic transports that do not model session headers.

### C-F10 [P2] Webhook delivery dedup is a 1024-FIFO, not a durable forever-set

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/integrations/github/idempotency.ts:46-54,190-192` — `makeBoundedSet` evicts oldest; durable `add` persists the **post-eviction** snapshot on new insert
- **consumer:** `webhook-server.ts` durable store
- **failure:** after 1024 distinct `X-GitHub-Delivery` ids, an evicted id `has()` false. GitHub redelivery re-enqueues the trigger. Module comments claim redelivery is recognised after reboot without stating the cap window. Persist-on-new-add **does** run on eviction inserts; the defect is bounded forgetfulness, not a skipped save.
- **proposed write set (C):** `idempotency.ts` — persist+document the cap as the replay window, or fail-closed/503 when cap would evict still-retryable ids.
- **proof limit:** `idempotency-cap-hellgate` already shows `has("d-0")` false after overflow. Live GitHub retry after 1024 others not reproduced.

### C-F11 [P2] `decodeSessionEvent` is a shallow cast; command decode is fail-closed

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/protocol/session/codec.ts:238-244` vs `:160-228`
- **consumer:** session bridge event fan-out / web attach
- **failure:** unknown event `type` throws; a known type with mistyped payload fields is accepted and downcast. Command path asserts posture/objective/skill/`turn.submit` shapes. Mistyped `prompt` etc. can poison correlator maps (the command codec comments name this class of bug).
- **proposed write set (C):** `codec.ts` event payload guards for high-fan-out types used by `createTurnEndCorrelator`.
- **proof limit:** `session-codec.test.ts` covers envelope metadata, not mistyped event fields. Runtime poison not reproduced.

### C-F12 [P3] Diagnostics waiter entries leak after timeout

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/lsp/adapters/base/diagnostics-hub.ts:31-38` — timeout `settle` does not `delete(uri)` from `diagnosticsWaiters`
- **consumer:** `LspClient.diagnostics()`
- **failure:** hang is prevented (`settled` guard). Late `publishDiagnostics` still walks leftover callbacks. Long sessions accumulate waiter arrays per URI that timed out.
- **proposed write set (C):** `diagnostics-hub.ts` prune on timeout (same as publish path).
- **proof limit:** static; leak volume not measured.

## Candidate fingerprints for W2-X

Format: `authority/invariant/input/output/state/effect/failure-policy/lifecycle`

| ID | Fingerprint | C owner | Foreign owner | Notes |
|---|---|---|---|---|
| X-C1 | mcp-client-select / spawn-isolation-enablement / env MCP_USE_ISOLATED_SPAWN / SupervisableMcpClient / process / spawn+kill / fail-open (env ignored) / start-stop | `isolated-client.ts` | `host/mcp-composition.ts` (G), catalog YAML (reserved) | C-F1 |
| X-C2 | session.v1-public-verbs / command-union completeness / SessionCommand / CommandReceipt / none / submit / typed-omit vs kernel-accept / handle-lifetime | `verb-surface.ts`, `handle.ts` | `kernel/session/scheduler.ts` (D), `sdk/runtime/handle-adapter.ts` (G) | C-F2; do not reopen D9 factory merge |
| X-C3 | posix-rename-commit / EXDEV / temp path / original path / tmp leftovers / copy-or-throw / partial-commit / apply-batch | `atomic-edit.ts` vs `file-write-atomic.ts` | `storage/atomic-write.ts` (D) is D29 — keep separate | C-F3 |
| X-C4 | mcp-initialize / protocolVersion+capabilities / initialize params / pinned version / negotiatedVersion / JSON-RPC / fail-closed unsupported / session-start | `client/negotiate.ts` vs `isolated-client.ts` | plugin launcher (A) | C-F4 |
| X-C5 | stdio-framing-liveness / peer-death / byte stream / onClose / buffer / teardown / fail-open EOF / transport-lifetime | session stdio vs ipc event-bridge stdio | `serve --stdio` (G) | C-F5 |
| X-C6 | jsonrpc-framing / max-bytes / newline vs Content-Length / decoded msg / reader buffer / drop-or-kill / pump | `mcp/jsonrpc.ts` vs `lsp/adapters/jsonrpc.ts` | D19 closed unless new drift | inventory |
| X-C7 | sandbox-cli / lima-or-docker-or-vz / spec / handle / vm process / exec / injection / spawn-cancel | `mcp/skybridge/*` vs `remote/runner/*` | D24 closed; binaries `lima` vs `limactl` | inventory |
| X-C8 | pump-death / stdout-end-while-alive / grace ms / fireExit / pumps / kill / fail-closed / child-lifetime | mcp stdio, lsp transport | `plugin-isolation` (B) D25 | inventory unless new fixture divergence |
| X-C9 | session-export-format / portable-v1 vs envelope-v1v2 / SavedSession / wire JSON / none / persist / validation / round-trip | `ipc/session-export.ts` | `session/import-export.ts` (D) | different schemas; not a duplicate unless a consumer mixes them |
| X-C10 | pr-comment-body / utf8-cap-65000+redact / body string / prepared body / none / gh post / fail-closed prepare / one-shot | `integrations/github/outbound-body-policy.ts` | `tool/gh/outbound-body-policy.ts` (B) | SEP5 twin; reopen only with measured truncate/redact drift |
| X-C11 | token-coalesce / in-flight-refresh / connectorId / TokenRecord / inFlight map / store.write / mutex / rotate | `connectors/token-rotation.ts` | chatgpt refresh + mcp oauth (F) D30 | scheduler is caller, not second mutex |
| X-C12 | endpoint-scheme / mcp-vs-llm URL / spec / throw Custom3pError / none / reject-register / fail-closed / seed-vs-live | jsonl-store `validateEndpoint` copy vs in-memory | none | copy risk; kinds currently only mcp\|llm |
| X-C13 | protocol-barrel / slice-public-API / @/protocol / exports / none / import / missing index / load | no `src/protocol/index.ts`, no `src/integrations/index.ts` | arch SSOT `requireSliceBarrel` omitted | inventory |
| X-C14 | mention-first-line / trim / text / first line / none / lookup / S8 shared | none in C | `src/shared/mention-text.ts` SEP6 S8 | do not reopen |
| X-C15 | webhook-hmac / sha256= / raw body / bool / none / 401 / fail-closed empty secret / request | `signature-verify.ts` + `webhook-server.ts` | none second writer | no-finding bounded |
| X-C16 | remote-runner-select / env+seams / QUANTA_REMOTE_RUNNER / RemoteRunner\|null / none / spawn / missing-seam-null vs headless-success / cmd-lifetime | `remote/runner/registry.ts` | `apps/cli/index.ts` (G) | C-F6, C-F7 |
| X-C17 | inbound-sampling-cap / in-flight count / sampling/createMessage / busy\|decline / two counters / send error / fail-closed / request | inbound-router vs sampling/inbound-router | none | C-F8 |
| X-C18 | mcp-http-session / oauth-reauth / 401 / new bearer+carrier / sessionId / POST / fail-open stale session / mid-session | `client.ts` `doReauthorize` | http-sse session header | C-F9 |
| X-C19 | webhook-delivery-dedup / X-GitHub-Delivery / id / bool has / FIFO Map 1024 / enqueue / bounded-forget / process+disk | `idempotency.ts` | none | C-F10 |
| X-C20 | session-event-decode / typed payload / wire JSON / SessionEvent / none / fan-out / shallow-cast / attach | `protocol/session/codec.ts` | `ipc/session/bridge.ts` | C-F11 |
| X-C21 | repo-slug-gate / owner/repo / string / bool / none / gh api path / fail-closed / request | `pr-output-sink.ts` `REPO_SLUG_RE` | `reactor/trigger-source-pr-comment.ts` (G) | **byte-identical today** — inventory, not a finding |
| X-C22 | web-daemon-oob-ws / control frames / text frame / handler / none / mutate / unversioned / socket | none in protocol | `apps/web-daemon/server/ws-handlers.ts` (G) Aug-25 #87 | foreign; do not write from C |

## Inventory (SOLID smell, no finding)

- SRP: `McpClient`, `LspClient`, `HttpSseMcpTransport`, `createSessionHandle`/`bridge`/`attach-flow` are large but split into methods/helpers under the 150-line function gate.
- OCP: skybridge `registry.ts` and remote `registry.ts` are closed env-name switches; adding a backend edits the table — expected adapter registries.
- ISP: `SupervisableMcpClient` optional methods (`requestRaw`, resources, tasks) are honest Isolated omissions, documented, default-OFF tools.
- DIP: protocol `subagent/projection.ts` value-imports `@/security` `redactSecrets` (fence-allowed). `ipc/session-import.ts` persists via `@/session#saveSessionById` — composition-legal for LAYER2 ipc; portable v1 vs session envelope v1/v2 are **different schemas** (Aug-25 #104 stays inventory unless a consumer mixes them).
- Default MCP negotiator emits `{}` unless `QUANTA_MCP_CAPS=full` — explicit opt-in, not hidden fallback on the in-process client.
- Webhook secret resolver: empty secret / unknown map key fail closed; empty map does not silently fall back to the single secret.
- Token refresh scheduler delegates to one rotator mutex. `createTokenRefreshScheduler` / `enforceMarketplacePolicy` / `createJsonlCustom3pRegistry` have no host caller — documented default-OFF, not dual-write.
- Realtime adapter outbound queue is documented NOOP (WS buffer). Speculative slowness → W2-P only with a fixture.
- `QUANTA_LSP_MEM_BUDGET_MB` is spawn-time `process.env` (`server-mem-budget.ts` + `transport.ts`); not in knob inventory. Dual-read vs `runtimeConfig()` is a lane F question; lsp `envAllowFiles` already lists these files.
- `REPO_SLUG_RE` in integrations vs reactor is currently the same regex; fence-local copies without measured drift.
- Isolated HTTP-empty-command throw is documented stdio-only; plugin `url` configs fail `ready: false` (adjacent to C-F4, not a second initialize invariant).

## No-finding bounded areas

Bounded by inspected owner + consumer on this snapshot:

- MCP HTTP-SSE standalone GET non-2xx: `classifyStandaloneGetResponse` calls `reportStandaloneGetFailure` → `fireExit` except 405 POST-only (Aug-25 #69 **not** reproduced).
- MCP JSON-RPC line cap 10MB; LSP frame cap 32MiB — different carriers, D19.
- GitHub `verifyHubSignature256`: empty secret returns false; server refuses boot on empty secret.
- Protocol `decodeSessionCommand`: unknown type throws `bad_command_type`.
- Connectors `ProviderKind` is only `"mcp" | "llm"`; jsonl/in-memory endpoint rules currently match.
- Realtime `createHeadlessStub` is a test/swap adapter; no extra production STT consumer found in C (D7 not triggered). `QUANTA_REMOTE_RUNNER=headless` is a **different** stub (`remote/runner/headless-stub.ts`) — see C-F7.
- `mcp/naming.ts` `sanitizeMcpNameSegment` remains the C-side SSOT (D6).

## Uninspected conditions

- Runtime with `MCP_USE_ISOLATED_SPAWN=1` against a live MCP server (static call-site universe was used instead).
- Live EXDEV across two mounts for workspace edit vs file write.
- Live `serve --stdio` peer EOF hang.
- Plugin-mcp-launcher composition actually mounted in CLI/web (ADR-0338 default-OFF).
- Cognitive-complexity scores per C function (`lint:debt` not run; read-only).
- Official god-function AST pass (allowlist has zero C entries; assumed green on HEAD).
- Full execution of the 291 heuristic C tests (not required for classification).
- Web-daemon OOB WS frames vs session.v1 (Aug-25 #87) — consumer is lane G; fingerprint X-C2 only.
- Whether `QUANTA_REMOTE_RUNNER` is read outside CLI (lane G) besides `selectRemoteRunner`.
- HTTP OAuth 401 against a real Streamable-HTTP session header.
- Sampling storm hitting both in-flight counters.
- Durable webhook store after 1024 GitHub deliveries.

## Exact proposed write sets

| Finding | C files | Forbidden |
|---|---|---|
| C-F1 | `src/mcp/isolated-client.ts` (gate honesty or factory) | `src/host/**`, catalog YAML, `src/agent/plugin-mcp-launcher/**` unless W2-X assigns them |
| C-F2 | `src/protocol/session/verb-surface.ts`, `src/ipc/session/handle.ts` | `src/kernel/**`, `src/sdk/**` except type pins |
| C-F3 | `src/lsp/adapters/base/atomic-edit.ts`, optional `file-write-*.ts` wire-or-delete, owner-local hellgate | `src/storage/atomic-write.ts` |
| C-F4 | `src/mcp/isolated-client.ts` initialize/negotiator | `src/plugin-isolation/**` as a fake initialize owner |
| C-F5 | `src/ipc/session/transports/stdio.ts` | `src/ipc/transports/stdio.ts` policy rewrite |
| C-F6 | `src/remote/runner/registry.ts` (contract only) | `src/apps/cli/index.ts` unless W2-X assigns G |
| C-F7 | `src/remote/runner/headless-stub.ts`, `registry.ts` | mcp skybridge lima (D24) |
| C-F8 | `src/mcp/client/inbound-router.ts`, `src/mcp/sampling/inbound-router.ts` | host sampling handler (G) |
| C-F9 | `src/mcp/client.ts` `doReauthorize` | oauth provider impl (G) |
| C-F10 | `src/integrations/github/idempotency.ts` | none |
| C-F11 | `src/protocol/session/codec.ts` `decodeSessionEvent` | kernel event producers (D) |
| C-F12 | `src/lsp/adapters/base/diagnostics-hub.ts` | none |

Lane C will not implement these in this campaign.

## Complete file manifest

212 exclusive production files. Role is a classification tag, not a second authority.

```text
slice	lines	role	path
mcp	13	capability-policy	src/mcp/capabilities/default-negotiator.ts
mcp	62	capability-policy	src/mcp/capabilities/full-negotiator.ts
mcp	5	barrel	src/mcp/capabilities/index.ts
mcp	40	port	src/mcp/capabilities/port.ts
mcp	59	capability-policy	src/mcp/client/capabilities-gate.ts
mcp	96	client	src/mcp/client/errors.ts
mcp	235	client	src/mcp/client/inbound-router.ts
mcp	95	capability-policy	src/mcp/client/negotiate.ts
mcp	165	client	src/mcp/client/result-folding.ts
mcp	40	transport	src/mcp/client/transport-factory.ts
mcp	888	client	src/mcp/client.ts
mcp	249	impl	src/mcp/elicitation/default-cli-prompter.ts
mcp	24	impl	src/mcp/elicitation/headless-rejecter.ts
mcp	241	impl	src/mcp/elicitation/inbound-router.ts
mcp	31	barrel	src/mcp/elicitation/index.ts
mcp	130	impl	src/mcp/elicitation/lease.ts
mcp	51	port	src/mcp/elicitation/port.ts
mcp	192	impl	src/mcp/elicitation/schemas.ts
mcp	164	barrel	src/mcp/index.ts
mcp	382	client	src/mcp/isolated-client.ts
mcp	153	codec	src/mcp/jsonrpc.ts
mcp	20	impl	src/mcp/naming.ts
mcp	14	impl	src/mcp/oauth/headless-rejecter.ts
mcp	7	barrel	src/mcp/oauth/index.ts
mcp	37	port	src/mcp/oauth/port.ts
mcp	67	impl	src/mcp/progress.ts
mcp	70	impl	src/mcp/protocol-version.ts
mcp	18	barrel	src/mcp/reconnect/index.ts
mcp	75	lifecycle	src/mcp/reconnect/policy.ts
mcp	74	port	src/mcp/reconnect/port.ts
mcp	491	lifecycle	src/mcp/reconnect/supervisor.ts
mcp	262	codec	src/mcp/resources/codec.ts
mcp	60	impl	src/mcp/resources/inbound-router.ts
mcp	47	barrel	src/mcp/resources/index.ts
mcp	97	impl	src/mcp/resources/notifications.ts
mcp	157	port	src/mcp/resources/port.ts
mcp	18	impl	src/mcp/sampling/headless-rejecter.ts
mcp	186	impl	src/mcp/sampling/inbound-router.ts
mcp	21	barrel	src/mcp/sampling/index.ts
mcp	80	port	src/mcp/sampling/port.ts
mcp	110	server	src/mcp/server-builder.ts
mcp	311	server	src/mcp/server.ts
mcp	159	impl	src/mcp/skybridge/applevz-microvm.ts
mcp	355	impl	src/mcp/skybridge/applevz-native.ts
mcp	39	impl	src/mcp/skybridge/container.ts
mcp	49	barrel	src/mcp/skybridge/index.ts
mcp	340	impl	src/mcp/skybridge/lima-microvm.ts
mcp	39	impl	src/mcp/skybridge/microvm.ts
mcp	185	impl	src/mcp/skybridge/passthrough.ts
mcp	124	registry	src/mcp/skybridge/registry.ts
mcp	206	types	src/mcp/skybridge/types.ts
mcp	181	impl	src/mcp/tasks/client-port.ts
mcp	102	impl	src/mcp/tasks/default-store.ts
mcp	17	barrel	src/mcp/tasks/index.ts
mcp	79	impl	src/mcp/tasks/poller.ts
mcp	29	port	src/mcp/tasks/port.ts
mcp	15	impl	src/mcp/tasks/rpc.ts
mcp	70	types	src/mcp/tasks/types.ts
mcp	789	transport	src/mcp/transports/http-sse.ts
mcp	74	port	src/mcp/transports/port.ts
mcp	333	transport	src/mcp/transports/stdio.ts
mcp	119	types	src/mcp/types.ts
lsp	133	adapter	src/lsp/adapters/base/atomic-edit.ts
lsp	52	adapter	src/lsp/adapters/base/config.ts
lsp	68	adapter	src/lsp/adapters/base/diagnostics-hub.ts
lsp	80	adapter	src/lsp/adapters/base/document-tracker.ts
lsp	24	adapter	src/lsp/adapters/base/errors.ts
lsp	413	adapter	src/lsp/adapters/base/mappers.ts
lsp	169	types	src/lsp/adapters/base/raw-types.ts
lsp	113	adapter	src/lsp/adapters/base/request-correlator.ts
lsp	283	transport	src/lsp/adapters/base/transport.ts
lsp	27	adapter	src/lsp/adapters/base/workspace.ts
lsp	850	adapter	src/lsp/adapters/base.ts
lsp	28	adapter	src/lsp/adapters/clangd.ts
lsp	79	adapter	src/lsp/adapters/default-code-action.ts
lsp	34	adapter	src/lsp/adapters/default-format.ts
lsp	54	adapter	src/lsp/adapters/default-rename-apply.ts
lsp	30	adapter	src/lsp/adapters/default-signature-help.ts
lsp	266	adapter	src/lsp/adapters/file-write-atomic.ts
lsp	89	adapter	src/lsp/adapters/file-write-sequential.ts
lsp	85	adapter	src/lsp/adapters/file-write-strategy.ts
lsp	17	adapter	src/lsp/adapters/gopls.ts
lsp	158	codec	src/lsp/adapters/jsonrpc.ts
lsp	87	adapter	src/lsp/adapters/pyright.ts
lsp	16	adapter	src/lsp/adapters/rust-analyzer.ts
lsp	32	adapter	src/lsp/adapters/typescript.ts
lsp	77	barrel	src/lsp/index.ts
lsp	98	port	src/lsp/ports/code-action-port.ts
lsp	39	port	src/lsp/ports/format-port.ts
lsp	59	port	src/lsp/ports/rename-apply-port.ts
lsp	33	port	src/lsp/ports/signature-help-port.ts
lsp	64	port	src/lsp/ports.ts
lsp	76	server	src/lsp/server-mem-budget.ts
lsp	54	registry	src/lsp/server-registry.ts
lsp	176	server	src/lsp/server-rss-watchdog.ts
lsp	134	types	src/lsp/types.ts
protocol	58	barrel	src/protocol/agent-state/index.ts
protocol	249	impl	src/protocol/agent-state/messages.ts
protocol	415	projection	src/protocol/agent-state/projection.ts
protocol	27	barrel	src/protocol/canvas/index.ts
protocol	249	impl	src/protocol/canvas/messages.ts
protocol	26	barrel	src/protocol/observability/index.ts
protocol	173	impl	src/protocol/observability/messages.ts
protocol	436	projection	src/protocol/readout/goal.ts
protocol	23	barrel	src/protocol/readout/index.ts
protocol	266	protocol-contract	src/protocol/session/builders.ts
protocol	36	capability-policy	src/protocol/session/capabilities.ts
protocol	272	codec	src/protocol/session/codec.ts
protocol	239	protocol-contract	src/protocol/session/commands.ts
protocol	205	impl	src/protocol/session/errors.ts
protocol	379	impl	src/protocol/session/events.ts
protocol	149	barrel	src/protocol/session/index.ts
protocol	26	projection	src/protocol/session/objective-projection.ts
protocol	71	projection	src/protocol/session/posture-projection.ts
protocol	185	projection	src/protocol/session/read-models.ts
protocol	30	projection	src/protocol/session/skill-projection.ts
protocol	122	impl	src/protocol/session/snapshot.ts
protocol	101	protocol-contract	src/protocol/session/verb-surface.ts
protocol	6	impl	src/protocol/session/version.ts
protocol	23	barrel	src/protocol/subagent/index.ts
protocol	121	projection	src/protocol/subagent/projection.ts
protocol	94	barrel	src/protocol/subagent-frame/index.ts
ipc	351	impl	src/ipc/event-bridge.ts
ipc	76	barrel	src/ipc/index.ts
ipc	622	impl	src/ipc/session/attach-flow.ts
ipc	879	impl	src/ipc/session/bridge.ts
ipc	399	client	src/ipc/session/client.ts
ipc	452	codec	src/ipc/session/codec.ts
ipc	86	impl	src/ipc/session/errors.ts
ipc	880	impl	src/ipc/session/handle.ts
ipc	94	impl	src/ipc/session/heartbeat.ts
ipc	110	barrel	src/ipc/session/index.ts
ipc	28	server	src/ipc/session/server.ts
ipc	36	client	src/ipc/session/stdio-client.ts
ipc	25	server	src/ipc/session/stdio-server.ts
ipc	61	transport	src/ipc/session/transports/close-signal.ts
ipc	270	transport	src/ipc/session/transports/stdio-spawn.ts
ipc	153	transport	src/ipc/session/transports/stdio.ts
ipc	169	transport	src/ipc/session/transports/websocket.ts
ipc	199	types	src/ipc/session/types.ts
ipc	32	client	src/ipc/session/websocket-client.ts
ipc	21	server	src/ipc/session/websocket-server.ts
ipc	91	impl	src/ipc/session-export.ts
ipc	275	impl	src/ipc/session-import.ts
ipc	124	transport	src/ipc/transports/in-memory.ts
ipc	214	transport	src/ipc/transports/stdio.ts
ipc	59	transport	src/ipc/transports/uds.ts
ipc	108	transport	src/ipc/transports/websocket.ts
connectors	129	impl	src/connectors/availability-prober.ts
connectors	12	impl	src/connectors/availability.ts
connectors	211	impl	src/connectors/connector-marketplace.ts
connectors	32	headless-stub	src/connectors/custom-3p/headless-stub.ts
connectors	121	impl	src/connectors/custom-3p/health-probe.ts
connectors	213	registry	src/connectors/custom-3p/in-memory-registry.ts
connectors	31	barrel	src/connectors/custom-3p/index.ts
connectors	214	impl	src/connectors/custom-3p/jsonl-store.ts
connectors	48	port	src/connectors/custom-3p/port.ts
connectors	122	types	src/connectors/custom-3p/types.ts
connectors	26	registry	src/connectors/in-memory-registry.ts
connectors	92	barrel	src/connectors/index.ts
connectors	84	impl	src/connectors/marketplace-policy.ts
connectors	164	impl	src/connectors/mcp-connector-catalog.ts
connectors	114	impl	src/connectors/oauth-discovery.ts
connectors	107	impl	src/connectors/oauth-registration.ts
connectors	119	adapter	src/connectors/rest-catalog-adapter.ts
connectors	212	registry	src/connectors/rest-registry.ts
connectors	262	impl	src/connectors/token-refresh-scheduler.ts
connectors	85	impl	src/connectors/token-rotation.ts
connectors	200	types	src/connectors/types.ts
integrations	37	adapter	src/integrations/github/adapters/delivery-persist-fs.ts
integrations	241	impl	src/integrations/github/event-payload.ts
integrations	225	impl	src/integrations/github/event-source-actions.ts
integrations	217	impl	src/integrations/github/idempotency.ts
integrations	100	barrel	src/integrations/github/index.ts
integrations	188	impl	src/integrations/github/mention-filter.ts
integrations	105	impl	src/integrations/github/outbound-body-policy.ts
integrations	198	impl	src/integrations/github/pr-context-loader.ts
integrations	661	impl	src/integrations/github/pr-output-sink.ts
integrations	59	authn-boundary	src/integrations/github/signature-verify.ts
integrations	165	types	src/integrations/github/types.ts
integrations	253	authn-boundary	src/integrations/github/webhook-secret-resolver.ts
integrations	376	authn-boundary	src/integrations/github/webhook-server.ts
integrations	286	transport	src/integrations/github/webhook-transports.ts
remote	9	barrel	src/remote/index.ts
remote	126	adapter	src/remote/runner/apple-vz-adapter.ts
remote	390	adapter	src/remote/runner/docker-adapter.ts
remote	143	headless-stub	src/remote/runner/headless-stub.ts
remote	57	barrel	src/remote/runner/index.ts
remote	237	adapter	src/remote/runner/lima-adapter.ts
remote	46	port	src/remote/runner/port.ts
remote	85	registry	src/remote/runner/registry.ts
remote	210	types	src/remote/runner/types.ts
remote	100	impl	src/remote/runner/validate.ts
realtime	51	codec	src/realtime/audio-codec.ts
realtime	404	adapter	src/realtime/default-adapter.ts
realtime	212	headless-stub	src/realtime/headless-stub.ts
realtime	51	barrel	src/realtime/index.ts
realtime	102	port	src/realtime/port.ts
realtime	96	capability-policy	src/realtime/sdp-negotiator.ts
realtime	85	types	src/realtime/types.ts
realtime	147	impl	src/realtime/voice-session/default-playback.ts
realtime	68	impl	src/realtime/voice-session/default-session/context.ts
realtime	103	impl	src/realtime/voice-session/default-session/inbound.ts
realtime	98	impl	src/realtime/voice-session/default-session/lifecycle.ts
realtime	205	impl	src/realtime/voice-session/default-session.ts
realtime	71	barrel	src/realtime/voice-session/index.ts
realtime	77	adapter	src/realtime/voice-session/openai-realtime-adapter.ts
realtime	88	impl	src/realtime/voice-session/pcm-bridge.ts
realtime	37	impl	src/realtime/voice-session/playback-port.ts
realtime	134	port	src/realtime/voice-session/port.ts
realtime	86	impl	src/realtime/voice-session/session-config.ts
realtime	78	impl	src/realtime/voice-session/state-machine.ts
```

Union of the 212 paths is the exclusive C production universe. Intersection with A/B/D/E/F/G/H production scopes is empty by path prefix. `src/shared/**` was not written.

DONE
