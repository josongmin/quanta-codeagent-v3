# W1-B — Sep-07 SOLID/SE duplicate-development audit

```text
AUDIT_ASSIGNMENT|lane=B|scope=tool,runtime,plugin-isolation,codemode|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-B.md
```

## Snapshot

| Field | Value |
|---|---|
| w0_receipt | **ABSENT** at start. Coordinator dispatched W1-B against a dirty shared checkout. |
| snapshot_policy | Committed `HEAD` only. Uncommitted overlay excluded from classification and completion. |
| inspection_root | `/private/tmp/quanta-sep5-final.xCKd7j/repo` (detached worktree, clean except `?? node_modules`) |
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| ahead/behind | `0 0` |
| staged_diff_sha256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged_diff_sha256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked_manifest_sha256 | `3bc58ab46912cb5a6beb527e8c1a80cd2feef4c3ada9c6c95f4b3b4eb19d5e74` (pre-receipt) |
| post_receipt_note | Writing this file changes the untracked manifest. HEAD / authority / staged / unstaged hashes must stay identical. |

### Authority-document SHA-256 (git show HEAD:path)

| Path | SHA-256 of HEAD blob contents |
|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| package.json | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` |
| biome.json | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` |
| tsconfig.json | `622ad399076687a1e3cdc01ce3b0b46edd344e2bb3da963bf0ea30223a77564b` |
| tsconfig.base.json | `c4ca874cd213452f545c273569a8d220566d763188bb26b64f77433ef51aa22f` |
| tsconfig.typecheck.src.json | `da1da7a381f8ec7b172c78985569df66f1e13e88d7ab0066b1137eaa90eb3320` |
| tsconfig.typecheck.tests.json | `3449f97ec6694b101f4784ab1116c284906d25e10ddc30805de471ee487f0fd0` |
| tests/unit/_arch/slice-boundary-configs.ts | `315560288012f4e6f2cc149f0605a539faac9676149e2e606fb3580a89115697` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.ts | `f665049ffc2afe4eea757ba29997adff569d32bdc0bf0422b1c55ef6ad210271` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

Working-tree `docs/ARCHITECTURE.md` and `tests/unit/_arch/slice-boundary-configs.ts` are dirty versus HEAD. Those working-tree bytes were **not** used.

### Lane-B files dirty in the shared checkout (excluded)

These exist only as uncommitted overlay. They must not be cited as HEAD repairs:

`src/runtime/os-sandbox/llm-error-bridge.ts`, `src/tool/bash/await.ts`, `src/tool/debug/dap-codec.ts`, `src/tool/node-repl/index.ts`, `src/tool/origin.ts`, `src/tool/pty/bun-pty-adapter.ts`, `src/tool/pty/port.ts`, `src/tool/pty/tmux-adapter.ts`, `src/tool/pty/tools.ts`, `src/tool/test-runner/index.ts`, `src/tool/types/tool-result.ts`.

SEP6 closeout prose claims N12 (DAP ceilings) is resolved on this HEAD. The committed `src/tool/debug/dap-codec.ts` on `0b14f5cf` has **no** header/body caps. The unpublished overlay is outside this receipt.

If W0 later freezes a different snapshot, this receipt is **STALE**.

## Coverage counts

| Universe | Count |
|---|---:|
| `src/tool/**/*.ts` | 318 |
| `src/runtime/**/*.ts` | 86 |
| `src/plugin-isolation/**/*.ts` | 7 |
| `src/codemode/**/*.ts` | 5 |
| **Lane B production `.ts` union** | **416** |
| files ≥1000 lines | 0 |
| files in 900–999 cohort | 2 (`src/tool/index.ts` 973, `src/tool/surface/gated-tools.ts` 964) |
| files ≥800 | 6 (plus the two cohort members: loopback-proxy 890, codemode/runtime 852, tool/browser 850, tool/bash/index 847) |
| god-code allowlist modules/functions | empty (`[]`) |
| files classified (path + lines + directory role) | 416 |
| files deep-inspected (owner + ≥1 consumer Read) | 50+ (coordinator + three shard reads; table below is the union) |
| heuristic test-mirror miss | 90 (basename heuristic only; not “untested”) |
| colocated `*.test.ts` inside `src/tool` | counted in the 416 (W0 universe is `src/**/*.ts`) |

### Deep-inspected owner + consumer paths

| Owner (Lane B) | Consumer actually Read |
|---|---|
| `src/tool/origin.ts` `deriveProvenance` | `src/agent/dispatch/execute.ts` `decorateToolOutput`; `src/agent/untrusted-envelope/wrap.ts` `wrapToolResult`; `tests/unit/tool-origin-substrate-hellgate.test.ts` |
| `src/tool/debug/dap-codec.ts` `DapFrameDecoder.push` | `tests/unit/tool/debug/dap-codec.test.ts`; `src/tool/debug/dap-client.ts` (import surface) |
| `src/runtime/run-argv.ts` `assertSandboxEnforced` / `wrapSandboxArgv` | `src/runtime/shell.ts` `resolveShellArgv`; `tests/unit/runtime/explicit-sandbox-fail-closed-hellgate.test.ts` |
| `src/runtime/os-sandbox/wrap-argv.ts` `wrapShellArgv` | `src/apps/cli/sandbox-wire.ts` `buildCliOsSandbox.wrap`; `src/runtime/os-sandbox/per-call.ts` |
| `src/runtime/os-sandbox/default.ts` `spawnImpl` | `src/runtime/os-sandbox/refusal.ts`; `src/runtime/os-sandbox/llm-error-bridge.ts` |
| `src/runtime/bash-bg-registry.ts` `defaultBashProcessHandlePort.spawn` | `createBashBgRegistry` → `register`; contrast `src/tool/bash/index.ts` `adopt` |
| `src/tool/output-spill.ts` `capToolOutput` | `src/tool/registry.ts` run-capping |
| `src/tool/pty/tools.ts` `capOutput` | `src/shared` `sliceWholeChars` (used); contrast spill path |
| `src/tool/pty/bun-pty-adapter.ts` `tailWhole` | `pushChunk` ring bound |
| `src/plugin-isolation/plugin-host.ts` `call`/`notify` | `IsolatedProcess.send` in `src/plugin-isolation/types.ts` |
| `src/plugin-isolation/bun-spawner.ts` | types `MAX_MESSAGE_BYTES` / `PUMP_DEATH_EXIT_GRACE_MS` |
| `src/codemode/runtime.ts` | `src/tool/codemode-tool.ts` (fingerprint only) |
| `src/runtime/node-repl/default-kernel.ts` | `src/tool/node-repl/index.ts` |
| `src/runtime/worktree.ts` / `worktree-inspect.ts` | `defaultGit` literal `"worktree list --porcelain"` |
| `src/tool/surface/gated-tools.ts` | `tests/unit/tool-surface-manifest-hellgate.test.ts` |
| `src/tool/index.ts` `buildDefaultTools` | same hellgate vs `BASE_TOOL_NAMES` |
| `src/host/runtime/objective-verifier-wire.ts` | `defaultPerCallSandbox` + `runArgv` (Lane G consumer; availability checked) |
| `src/tool/write/index.ts` `staleWriteGuard` | `src/tool/stale-read-guard/state.ts` `checkFresh`; contrast `src/tool/edit/index.ts:508` |
| `src/tool/scripted-replace.ts` `staleReplaceGuard` | same `guardWrite` without digest |
| `src/tool/notebook-edit/tool.ts` `staleReadDenial` | same + `catch { return null }` |
| `src/tool/patch-mutation-safety.ts` | digest + fail-closed stat (contrast) |
| `src/tool/test-runner/index.ts` | `src/tool/index.ts:881` always-on; contrast `testrun/tool.ts` gated |
| `src/tool/pty/tmux-adapter.ts` `lastCapture` | `src/host/runtime/pty-backend.ts`; contrast bun ring |
| `src/runtime/os-sandbox/default.ts` `availabilityImpl` | spawn `sandboxUnavailableRefusal` (same file) |
| `src/tool/glob/index.ts` | `runShell` `rg --files` then in-process cap |
| `src/runtime/network-proxy/loopback-proxy.ts` `scanAndPipeHttp` | MITM `bodyOverCap` fail-closed contrast |
| `src/lsp/adapters/jsonrpc.ts` | DAP codec bound contrast (Lane C; fingerprint only) |

Shard re-reads (HEAD-confirmed, not dirty overlay): [Audit tool core/pty](3f444923-4a35-4890-8a50-3f93beadb214), [Audit remaining tools](95288ead-ca8c-4fff-946a-5d473e91c01c), [Audit runtime/isolation](e35f4f79-2695-4498-97cf-9b411abb6da2). Coordinator re-Read every new P1/P2 owner before merge.

## Findings

Retired SEP5/SEP6 IDs were not reopened unless the documented trigger is true on this HEAD. N12’s unbounded-decoder trigger **is** true on committed HEAD.

### B-F1 — P1 — builtin subprocess/file/web tools classified `internal`, so untrusted envelope is skipped

- **status:** open
- **attribution:** pre-existing on `0b14f5cf`. Shared dirty `src/tool/origin.ts` already drafts `SHELL_OUTPUT_TOOLS`; that overlay is **not** this snapshot.
- **invariant:** ADR-0471: subprocess / foreign-file / fetched-web tool output is untrusted DATA when `QUANTA_UNTRUSTED_ENVELOPE=1`.
- **owner:** `src/tool/origin.ts` `deriveBuiltinProvenance` (HEAD lines 80–86). Only `web_fetch`/`web_search`, `bash`/`bash_*`, and `FILE_CONTENT_TOOLS` `{read, read_image, csv_read, pdf_read, xlsx_read, yaml_read, ndjson_read}` leave `internal`.
- **producer → contract → consumer:** `ToolRegistry.originOf` (builtin) → `deriveProvenance` → `decorateToolOutput` (`src/agent/dispatch/execute.ts:205-208`) → `wrapToolResult` (`src/agent/untrusted-envelope/wrap.ts:96-102`). `isUntrusted("internal")` is false; wrap is identity.
- **measured drift:** HEAD `deriveProvenance("container_exec","builtin")` / `("pty_read","builtin")` / `("node_repl","builtin")` / `("test_runner","builtin")` / `("docx_read","builtin")` / `("pptx_read","builtin")` / `("read_image_url","builtin")` all fall through to `"internal"`. Live tool names confirmed: `src/tool/container-exec/tool.ts:179`, `src/tool/pty/tools.ts:232`, `src/tool/node-repl/index.ts:207`, `src/tool/test-runner/index.ts:115`, `src/tool/document/docx-read.ts:73`, `src/tool/document/pptx-read.ts:145`, `src/tool/image/from-url.ts:197`.
- **sibling universe (same owner):** every builtin whose model-facing body is subprocess/terminal, foreign file bytes, or fetched URL and is absent from the three sets. Minimum live set above. `grep`/`glob` are explicitly trusted in the owner comment — not claimed here (SEP5 D12).
- **test honesty:** `tests/unit/tool-origin-substrate-hellgate.test.ts` matrix has no `container_exec` / `pty_read` / `node_repl` / `docx_read` rows; removing those names cannot turn RED.
- **gate:** `runtimeConfig().untrustedEnvelope` is default-OFF (`=== "1"`). Failure mode is the supported ON path, not the default.
- **proof_limit:** no runtime wrap executed this session; static owner+consumer path only. Envelope gate OFF ⇒ bytes unchanged even for `bash`.
- **proposed write set (B):** `src/tool/origin.ts`; `tests/unit/tool-origin-substrate-hellgate.test.ts` (add names + red-on-injection that a listed sibling classified `internal` fails).
- **forbidden write set:** do not edit `src/agent/untrusted-envelope/**` unless the `Provenance`/`UntrustedSource` unions must change (they should not if siblings map to existing `bash`/`file`/`web_fetch`). Do not merge tool registries (SEP5 D16).

### B-F2 — P1 — DAP decoder unbounded on committed HEAD (SEP6 N12 trigger reproduced)

- **status:** open (reopen of N12 trigger; not a wording rerun)
- **attribution:** pre-existing on committed HEAD. SEP6 register claims repair on this SHA; repair lives only in the excluded dirty overlay.
- **owner:** `src/tool/debug/dap-codec.ts` `DapFrameDecoder.push` (HEAD, 88 lines). `this.buf = Buffer.concat` with no header/body ceiling. `parseContentLength` accepts any `n >= 0`.
- **consumer:** `src/tool/debug/dap-client.ts` `decoder.push`. HEAD `tests/unit/tool/debug/dap-codec.test.ts` has no 64 KiB / 32 MiB cases.
- **contrast (Lane C, not a B write):** `src/lsp/adapters/jsonrpc.ts` already owns `MAX_HEADER_BYTES=64KiB` / `MAX_FRAME_BYTES=32MiB`.
- **measured failure:** a declared `Content-Length` of 2^31 or a header without `SEP` grows retained `buf` without bound. Same invariant as N12.
- **proof_limit:** no hostile adapter process spawned. Static decoder + HEAD test file + LSP contrast Read.
- **proposed write set (B):** `src/tool/debug/dap-codec.ts`; `tests/unit/tool/debug/dap-codec.test.ts` (header-cap discriminating case from SEP6-P2).
- **forbidden:** do not treat dirty-checkout `dap-codec.ts` as already shipped; do not edit `@/lsp`.

### B-F3 — P2 — background-shell spawn adapter skips `assertSandboxEnforced`

- **status:** open
- **attribution:** pre-existing
- **invariant:** restrictive `QUANTA_SANDBOX` (`read-only` / `workspace-write` / `workspace-write-net`) must not spawn the child when wrap returns `sandboxApplied:false` or a non-tolerated `degradeReason`.
- **owner A (fail-closed):** `src/runtime/run-argv.ts` `assertSandboxEnforced` (L74-87), called from `wrapSandboxArgv` after `slot.wrap` (L121-123). `runShell` uses this (`src/runtime/shell.ts:99`). Proven by `tests/unit/runtime/explicit-sandbox-fail-closed-hellgate.test.ts` (sentinel file not created).
- **owner B (fail-open):** `src/runtime/bash-bg-registry.ts` `defaultBashProcessHandlePort.spawn` L161-164: `(await slot.wrap(baseArgv, cwd)).argv` then `bunScrubbedSpawner` — **no** `assertSandboxEnforced`. Comment claims the same sandbox contract as `runShell`.
- **producer → contract → consumer:** `installCliSandbox` still **installs** a degraded slot and only warns (`src/apps/cli/sandbox-wire.ts:141-148`, Lane G). Foreground `runShell` then throws. `BashBgRegistry.register` uses the default port and would spawn the unwrapped argv. `src/tool/bash/index.ts` production path uses **`adopt`** after `runShell` (L494), not `register`.
- **proof_limit:** no `src/**` production caller of `BashBgRegistry.register` found (rg). `register` remains a public production method; tests call it (`tests/unit/runtime/bash-bg-registry-behavior-hellgate.test.ts`). Not P0: the bash tool’s live detach path is `adopt`.
- **proposed write set (B):** `src/runtime/bash-bg-registry.ts` (`defaultBashProcessHandlePort.spawn` must call `assertSandboxEnforced` before spawn, same as `wrapSandboxArgv`); focused hellgate cloning the sentinel fixture through **`register()` + real default port**.
- **forbidden:** do not “fix” by deleting `register`. Do not move policy into `src/apps/cli/sandbox-wire.ts`. Do not merge wrap-argv into `defaultOsSandbox`.

### B-F4 — P2 — universal tool-output spill truncates UTF-16 unsafely

- **status:** open
- **attribution:** pre-existing. SEP6 PTY surrogate repair is **not** this surface; PTY `capOutput` on HEAD already uses `sliceWholeChars`.
- **owner:** `src/tool/output-spill.ts` `capToolOutput` L321-324: `output.slice(0, HEAD_CHARS)` / `output.slice(tailStart)`.
- **consumer:** `src/tool/registry.ts` L197-201 — every successful/failed tool result over cap.
- **failure:** a surrogate pair straddling index 8000 becomes a lone UTF-16 unit in the model-facing `<persisted-output>` excerpt (same corruption class as the PTY hellgate).
- **proof_limit:** no fixture with an astral character at offset 8000 executed.
- **proposed write set (B):** `src/tool/output-spill.ts` (reuse `@/shared` `sliceWholeChars` / `sliceTailWholeChars`); owner-local test with a discriminating surrogate at `HEAD_CHARS`.
- **forbidden:** do not reopen PTY tools; do not put truncation policy in `@/shared` beyond the existing helpers.
- **note:** spill **retention** (`DEFAULT_SPILL_KEEP` + prune) is already bounded. B-F4 is only the UTF-16 cut, not unbounded disk.

### B-F5 — P1 — stale-read content authority is mutator-dependent (digest omitted + notebook stat fail-open)

- **status:** open
- **attribution:** pre-existing. ADR-0548 already names the write-class hole; `edit`/`apply_patch` were repaired, write-class was not.
- **invariant:** when a file was read this session, a later mutation must refuse if on-disk **content** changed (`checkFresh` digest-wins). A failed freshness probe must not proceed.
- **owner (fail-open siblings, same `guardWrite` SSOT):**
  - `src/tool/write/index.ts:28` `guardWrite(..., cur.mtimeMs)` — no digest
  - `src/tool/scripted-replace.ts:290` same
  - `src/tool/notebook-edit/tool.ts:142` mtime-only, and `catch { return null }` at L152-154 proceeds on `statFile` fault
- **contrast (fail-closed):** `src/tool/edit/index.ts:508` passes `sha256Hex(currentContent)`; `src/tool/patch-mutation-safety.ts:142-155` fail-closed `staleCheckFailed` on stat fault and supplies digest.
- **producer → contract → consumer:** `ReadFileState.checkFresh` (`state.ts:236-249`) uses digest iff **both** sides have one. Write-class omits `currentDigest` ⇒ same-mtime / `cp -p` content-swap is `fresh`. Notebook cannot-stat is treated as fresh.
- **measured drift:** same `ReadFileState`, tool choice changes deny vs allow. Notebook comment claims “like edit”; edit’s nearby `catch` is the merge-port path (`:290`), not the stale-guard path (`:507` has no swallow).
- **proof_limit:** static owner+SSOT Read. `cp -p` E2E not executed this session.
- **proposed write set (B):** `src/tool/write/index.ts`, `src/tool/scripted-replace.ts`, `src/tool/notebook-edit/tool.ts` (pass digest; notebook stat fault → typed `stale_read` / `staleCheckFailed`). Optional tiny helper next to `fresh-hash.ts`. Tests that inject same-mtime content swap on write/scripted/notebook and expect RED.
- **forbidden:** do not weaken `edit` / `apply_patch`; do not invent a second freshness SSOT.

### B-F6 — P2 — two live “run the suite” tools with HITL drift

- **status:** open
- **attribution:** pre-existing. Not SEP5 D16 (no missing/duplicated registry *name* vs manifest).
- **owner A:** `src/tool/test-runner/index.ts:114-127` `test_runner`, `hitlTier: "pre-approval-ok"`, always registered (`src/tool/index.ts:881`).
- **owner B:** `src/tool/testrun/tool.ts:234-243` `run_tests`, `hitlTier: "always-confirm"`, gated `ports.testRunner === true` (`index.ts:788-789`).
- **measured drift:** overlapping capability (run project tests); HITL and output contracts diverge. When both are in the menu, the model can pick the softer `test_runner`.
- **proof_limit:** assembly graph Read; apps env default for `QUANTA_TEST_RUNNER` not fully traced. Failure requires the gated tool also wired.
- **proposed write set (B):** `src/tool/test-runner/**` and/or `src/tool/testrun/**` + `src/tool/index.ts` / surface row — pick one canonical runner or pin HITL parity. Do not merge unrelated registries (D16).
- **forbidden:** `src/apps/**` as the policy owner.

### B-F7 — P2 — tmux `lastCapture` stores full pane text per handle

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/tool/pty/tmux-adapter.ts:82-86,167-183` stores `r.stdout` wholesale. Handle **count** capped (`PTY_MAX_ATTACHED`); per-snapshot **bytes** not capped.
- **contrast:** bun adapter ring is `PTY_RING_BYTES` + `tailWhole`. Tool-layer `pty_read` caps model output at 32KiB but adapter heap still holds the full capture.
- **consumer:** `src/host/runtime/pty-backend.ts` wires `createTmuxAdapter` → `ptyTools`.
- **failure:** flooding pane × attached handles → unbounded heap (cap is cardinality, not bytes).
- **proof_limit:** static Read; no live tmux flood curve.
- **proposed write set (B):** `src/tool/pty/tmux-adapter.ts` (+ hellgate). Keep host backend as composition only.
- **inventory not finding:** tmux `write` omits `PTY_MAX_WRITE_BYTES` (tools ingress still caps; no non-tool production writer found).

### B-F8 — P2 — `OsSandbox.availability()` still claims passthrough while `spawn` refuses

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/runtime/os-sandbox/default.ts` `availabilityImpl` L244-285 returns `backend: "passthrough"` and warnings `"degraded to passthrough"`. `spawnImpl` L99-163 returns `sandboxUnavailableRefusal` (command not run).
- **LSP:** probe vs spawn disagree. A consumer that trusts availability text will expect unsandboxed run; spawn fail-closes.
- **proof_limit:** no production caller of `defaultOsSandbox().availability()` found besides tests/composition docs; bash uses `PerCallSandboxPort.availability()` (different type). Honesty defect on the OsSandbox port itself.
- **proposed write set (B):** `src/runtime/os-sandbox/default.ts` availability strings + backend discriminant (`unavailable` / `refused`, not `passthrough`); hellgate that spawn-refuse and availability cannot claim passthrough together.

### B-F9 — P2 — glob materializes the full `rg --files` list before the 300-hit cap

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/tool/glob/index.ts:109-158` — `runShell("rg --files …")`, `split("\0")` into `allFiles`, then filter/sort, **then** `slice(0, MAX)`.
- **contrast:** model-facing cap is 300; intermediate list is the entire non-ignored tree. `runShell` also buffers that stdout.
- **failure:** large workspace → RAM/latency spike (jail still holds).
- **proof_limit:** static; no huge-repo fixture. W2-P must supply scale + threshold if retained.
- **proposed write set (B):** `src/tool/glob/index.ts` (stream/cap during enumerate, not after).

### B-F10 — P2 — plaintext secret-egress over-cap forwards unscanned

- **status:** open
- **attribution:** pre-existing; comments document the DoS-vs-scan tradeoff.
- **owner:** `src/runtime/network-proxy/loopback-proxy.ts` `scanAndPipeHttp` L347-356: `buffered === null` → `allow` + `body-cap-unscanned` + `pipeHttp`.
- **contrast:** MITM path fail-closes on `bodyOverCap` (same file ~656). Dual failure-policy for the same secret-egress invariant.
- **proof_limit:** e2e asserts log marker / 200; does not prove secret bytes reached origin. `this.log` append is separately unbounded (inventory for W2-P).
- **proposed write set (B):** `loopback-proxy.ts` — align plaintext over-cap with MITM fail-closed **or** make the allow path an explicit typed operator opt-in, with a test that a planted secret in an over-cap body is denied (or proven forwarded only when opted in).

## Inventory (not findings)

- God-module cohort: `src/tool/index.ts` 973, `src/tool/surface/gated-tools.ts` 964, `src/runtime/network-proxy/loopback-proxy.ts` 890, `src/codemode/runtime.ts` 852, `src/tool/browser/index.ts` 850, `src/tool/bash/index.ts` 847. No ≥1000. No ≥150 function allowlist entries. Smell without a new failure mode → W2-P.
- Dual tool-name tables `buildDefaultTools` vs `BASE_TOOL_NAMES`/`GATED_TOOLS`: pinned by `tests/unit/tool-surface-manifest-hellgate.test.ts`. SEP5 D16 stays closed (no missing/duplicated tool vs agreed manifest reproduced).
- `wrapShellArgv` Linux branch always `landlock-not-implemented`; live Linux session path is `sandbox-wire.wrapLinuxShellArgv` / `wrapLinuxPerCall`. Stale branch, no production linux caller of that arm found.
- `defaultOsSandbox` fail-closed refusal vs argv-wrap + `assertSandboxEnforced`: two adapters, one spawn chokepoint for `runShell`. Not merged (different ports).
- `withSandboxLlmErrorEmit`: zero production callers (definition + tests + comments in `@/llm`). Typed `sandbox_error` vs `src/shared/error-classifier.ts` `SANDBOX_MARKERS` including `"sandbox"` → **W2-X** (shared is reserved). Default-OFF is documented.
- `plugin-isolation` `send()` silent drop over `MAX_MESSAGE_BYTES`: documented NO-THROW; `plugin-host.call` waits on timeout. Not a measured hang this session.
- `node_repl` tool vs `runtime/node-repl` kernel: DIP, not dual authority.
- `code_cell` vs `src/codemode`: composition tool vs WASM sandbox — different contracts.
- PTY UTF-16 on HEAD: `capOutput` / `tailWhole` already surrogate-safe. Do not reopen SEP6 PTY.
- `inspectWorktrees` interpolates a **literal** git argv. SEP5 D13 not reproduced.
- Pump-death grace export: SEP5 D25 not reproduced (no same-fixture divergence measured).
- Bash `stripModelControlChars` vs `terminal-sanitize` caret-defang: two sanitizers, bash hellgate locks drop semantics — policy inconsistency without a proven forge overwrite. Not a finding.
- `container-exec` host-kill-only orphan caveat: documented; D13 trigger (orphan reproduction) not run.
- `withSandboxLlmErrorEmit` unwired: composition gap, kept as X-B2 (not a B-only ticket; wiring is Lane G).
- Dual `DETACH_TAIL_BUDGET_BYTES` / `MAX_BG_BUFFER_BYTES` both 200_000: documented fence-local copies; no measured drift.

## Candidate fingerprints for W2-X

Fingerprint shape: `authority/invariant/input/output/state/effect/failure-policy/lifecycle`.

| ID | Fingerprint | Lane-B owner | Foreign owner / consumer | Notes |
|---|---|---|---|---|
| X-B1 | provenance/untrusted-envelope/tool-name+origin/Provenance/none/wrap-or-identity/default-off-gate/per-result | `src/tool/origin.ts` | `src/agent/untrusted-envelope` (A); dispatch `execute.ts` (A) | Dual union is fence-intentional; B-F1 is classification holes, not the dual type. |
| X-B2 | sandbox-error/kind-routing/spawn-result-or-stderr-text/LLMErrorKind/none/retry-route/heuristic-vs-typed/opt-in-bridge | `src/runtime/os-sandbox/llm-error-bridge.ts` | `src/shared/error-classifier.ts` (RESERVED); `src/llm/retry/codex-spec-router.ts` (E); `src/agent/error-routing` (A) | Typed bridge unwired; `"sandbox"` substring is live. |
| X-B3 | os-sandbox-enforcement/restrictive-profile/argv+policy/wrapped-argv+flags/slot/spawn-or-refuse/fail-closed-vs-warn-install/session | `wrap-argv` + `run-argv` + `bash-bg-registry` | `src/apps/cli/sandbox-wire.ts` (G) installs degraded slot | B-F3 is the B-owned spawn sibling. |
| X-B4 | llm-error-bridge/layer-owned-kind/port-result/LLMError/none/throw-or-augment/default-off/decorator | sandbox bridge | `src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts` (A) | Algorithm clone, different kinds. Do not dump into `src/shared`. |
| X-B5 | git-shell/argv-vs-string/`git ${args}`/ShellResult/none/subprocess/module-controlled-args/worktree | `src/runtime/worktree.ts`, `worktree-inspect.ts` | `src/tool/git`, `src/git` (H), `src/tool/gh/runner.ts` | D13 closed unless injection reproduced. |
| X-B6 | rg-exec/search-contracts/pattern+cwd/matches/none/spawn-rg/jail+fallback/per-tool | `src/tool/grep`, `glob`, `search-codebase`, `ast-grep` | — | D12 closed. |
| X-B7 | pump-death/stdout-EOF-vs-exit/child/liveness/none/SIGTERM/grace-50ms/stdio | `src/plugin-isolation/bun-spawner.ts` | `@/mcp` stdio, `@/lsp` (C) | D25 closed. |
| X-B8 | browser-cdp/correlator/session/events/pending-map/reply/lost-waiter | `src/tool/browser`, `src/tool/debug/cdp-client.ts` | `src/browser` (H) | D23 closed. |
| X-B9 | mcp-resource-tools/origin-mcp/uri/resource-bytes/none/RPC+disk-write/untrusted-wrap/session | `src/tool/mcp_resources/**` | `@/mcp` (C) | Origin tagging inspected via comments + hellgates; C owns protocol. |
| X-B10 | subagent-tools/spawn-lifecycle/spec/child-result/registry/dispatch/HITL/tree | `src/tool/subagent-*`, `side-agent` | `src/subagent`, `src/side-agent` (H) | Cross-lane only. |
| X-B11 | dap-vs-lsp-framing/byte-ceilings/Content-Length/decoded-json/buf/concat/unbounded-vs-capped/stream | `src/tool/debug/dap-codec.ts` | `src/lsp/adapters/jsonrpc.ts` (C) | B-F2; share algorithm not policy dump. |
| X-B12 | stale-read/content-digest/path+mtime+digest/Freshness/ReadFileState/mutate-or-deny/fail-closed/per-tool | `stale-read-guard` + mutators | — | B-F5 is in-lane. |
| X-B13 | secret-egress/body-cap/HTTP-body/allow-or-deny/proxy-log/forward/fail-open-plaintext-vs-MITM/request | `loopback-proxy.ts` | — | B-F10. |

## No-finding bounded areas

- `src/runtime/os-sandbox/default.ts` requested-sandbox spawn refusal (DOF-40) on darwin/linux/win32 **when going through `defaultOsSandbox.spawn`**.
- `src/runtime/run-argv.ts` + `runShell` fail-closed for installed restrictive slots (hellgate with real sentinel).
- `src/host/runtime/objective-verifier-wire.ts` checks `availability()` and `onSandboxStatus` before/during `runArgv`.
- PTY read truncation surrogate-safety on HEAD.
- Tool-surface manifest drift guard for base names (SEP5 D16).
- `src/codemode` caps (deadline, memory, tool-call) exist in `runtime.ts` / `limits.ts` — not fully mutation-probed this lane.
- `src/plugin-isolation` line-size cap and pump-death window exist; sibling MCP/LSP not re-audited (Lane C).

## Uninspected conditions

- Per-file largest-function measurement for all 416 files (only ≥800-line modules and finding owners were sized by reading).
- Runtime reproduction of B-F1 with `QUANTA_UNTRUSTED_ENVELOPE=1` and a hostile `container_exec` body.
- Runtime reproduction of B-F2 with an oversized Content-Length stream.
- Runtime reproduction of B-F3 via `registry.register()` under a degraded `QUANTA_SANDBOX` slot.
- Full consumer graph of every tool under `src/tool/{gh,git,web,edit,write,document,lsp_nav,objective,...}` beyond name/role classification.
- Full MITM private methods beyond body-cap / `mitmFailClosed` / `scanAndPipeHttp`.
- Runtime `cp -p` freshness E2E (B-F5), tmux flood curve (B-F7), huge-repo glob (B-F9), planted-secret over-cap (B-F10).
- `src/codemode/runtime.ts` handle-disposal at runtime (hellgate exists; not re-run).
- Dirty-overlay behavioral delta (explicitly out of scope).
- Cognitive-complexity scores per function (lint-debt is repo-wide; W2-P).

## Exact proposed write sets

| Finding | Allowed files | Forbidden |
|---|---|---|
| B-F1 | `src/tool/origin.ts`, `tests/unit/tool-origin-substrate-hellgate.test.ts` | `@/agent` envelope unless union drift; other lanes’ tools |
| B-F2 | `src/tool/debug/dap-codec.ts`, `tests/unit/tool/debug/dap-codec.test.ts` | claiming dirty overlay as HEAD |
| B-F3 | `src/runtime/bash-bg-registry.ts`, new `tests/unit/runtime/bash-bg-register-sandbox-fail-closed-hellgate.test.ts` | `src/apps/cli/sandbox-wire.ts` as the authority; deleting `register` |
| B-F4 | `src/tool/output-spill.ts`, matching unit test | `src/tool/pty/**` |
| B-F5 | `src/tool/write/index.ts`, `src/tool/scripted-replace.ts`, `src/tool/notebook-edit/tool.ts`, owner-local freshness hellgate | do not weaken `edit` / `apply-patch` |
| B-F6 | `src/tool/test-runner/**` and/or `src/tool/testrun/**`, `src/tool/index.ts` / surface row | D16 mega-registry merge; `src/apps/**` as policy owner |
| B-F7 | `src/tool/pty/tmux-adapter.ts`, related hellgate | host `pty-backend.ts` beyond wiring |
| B-F8 | `src/runtime/os-sandbox/default.ts` `availabilityImpl` + honesty hellgate | changing spawn fail-closed back to passthrough |
| B-F9 | `src/tool/glob/index.ts` | changing grep/ast-grep contracts (D12) |
| B-F10 | `src/runtime/network-proxy/loopback-proxy.ts` + discriminating e2e | silent allow without a visible marker |

W1 does not implement these.

## File manifest (complete Lane B `src/**/*.ts`, lines\|path)

Sorted by path. Role is the directory cohort (tool implementation, runtime sandbox, isolation, codemode). Largest-function column omitted except where noted in findings / ≥800 list.

```text
  25|src/codemode/exec-main.ts
  22|src/codemode/index.ts
  60|src/codemode/limits.ts
 852|src/codemode/runtime.ts
 120|src/codemode/types.ts
 613|src/plugin-isolation/bun-spawner.ts
 291|src/plugin-isolation/dxt-loader.ts
 529|src/plugin-isolation/dxt-user-config.ts
  31|src/plugin-isolation/index.ts
 251|src/plugin-isolation/lifecycle.ts
 335|src/plugin-isolation/plugin-host.ts
 125|src/plugin-isolation/types.ts
 762|src/runtime/bash-bg-registry.ts
 149|src/runtime/bounded-buffer.ts
 158|src/runtime/env-probe/checks.ts
  36|src/runtime/env-probe/index.ts
 100|src/runtime/env-probe/probe.ts
 129|src/runtime/env-probe/types.ts
 231|src/runtime/guarded-spawn.ts
  99|src/runtime/index.ts
 102|src/runtime/local-env/apply.ts
  28|src/runtime/local-env/index.ts
  74|src/runtime/local-env/load.ts
 165|src/runtime/local-env/parse.ts
  76|src/runtime/local-env/types.ts
  82|src/runtime/network-allowlist.ts
 104|src/runtime/network-proxy/amendment.ts
 107|src/runtime/network-proxy/decision.ts
  64|src/runtime/network-proxy/env.ts
  29|src/runtime/network-proxy/exfil-scouting-gate.ts
 286|src/runtime/network-proxy/header-rules.ts
 101|src/runtime/network-proxy/index.ts
 150|src/runtime/network-proxy/lifecycle.ts
 890|src/runtime/network-proxy/loopback-proxy.ts
 279|src/runtime/network-proxy/mitm-cert.ts
 277|src/runtime/network-proxy/mitm-channel-bun.ts
 110|src/runtime/network-proxy/mitm-channel-node.ts
 213|src/runtime/network-proxy/mitm-channel.ts
  42|src/runtime/network-proxy/mitm-gate.ts
  80|src/runtime/network-proxy/mitm.ts
  34|src/runtime/network-proxy/port.ts
  51|src/runtime/network-proxy/read-capped-body.ts
  94|src/runtime/network-proxy/scouting.ts
  39|src/runtime/network-proxy/secret-egress-gate.ts
 213|src/runtime/network-proxy/secret-egress.ts
  16|src/runtime/network-proxy/ssrf.ts
 112|src/runtime/network-proxy/types.ts
 614|src/runtime/node-repl/default-kernel.ts
 289|src/runtime/node-repl/headless-stub.ts
  28|src/runtime/node-repl/index.ts
  56|src/runtime/node-repl/port.ts
 125|src/runtime/node-repl/state-store.ts
  55|src/runtime/node-repl/types.ts
 105|src/runtime/os-sandbox/bubblewrap.ts
 373|src/runtime/os-sandbox/default.ts
 181|src/runtime/os-sandbox/denial-classify.ts
  47|src/runtime/os-sandbox/env.ts
  89|src/runtime/os-sandbox/index.ts
 131|src/runtime/os-sandbox/landlock-cli.ts
 373|src/runtime/os-sandbox/landlock-native.ts
 151|src/runtime/os-sandbox/landlock.ts
 208|src/runtime/os-sandbox/linux.ts
 192|src/runtime/os-sandbox/llm-error-bridge.ts
 225|src/runtime/os-sandbox/per-call.ts
  69|src/runtime/os-sandbox/refusal.ts
 171|src/runtime/os-sandbox/seatbelt.ts
  23|src/runtime/os-sandbox/seatbelt/parity-fixtures/read-only.ts
  21|src/runtime/os-sandbox/seatbelt/parity-fixtures/workspace-write-net.ts
  21|src/runtime/os-sandbox/seatbelt/parity-fixtures/workspace-write.ts
  59|src/runtime/os-sandbox/seatbelt/profile-diff.ts
  98|src/runtime/os-sandbox/seatbelt/strict-policy.ts
  32|src/runtime/os-sandbox/seatbelt/verbatim-profile.ts
 211|src/runtime/os-sandbox/types.ts
 328|src/runtime/os-sandbox/windows-native.ts
 168|src/runtime/os-sandbox/windows.ts
 114|src/runtime/os-sandbox/wrap-argv.ts
 249|src/runtime/process-tree.ts
 253|src/runtime/run-argv.ts
 387|src/runtime/sandbox.ts
  86|src/runtime/scrubbed-spawn.ts
 200|src/runtime/shell-argv.ts
  52|src/runtime/shell-disclaim.ts
  62|src/runtime/shell-sandbox-holder.ts
  53|src/runtime/shell-snapshot/bash-capture.ts
 136|src/runtime/shell-snapshot/bun-spawner.ts
 181|src/runtime/shell-snapshot/file-store.ts
  36|src/runtime/shell-snapshot/headless-stub.ts
 148|src/runtime/shell-snapshot/index.ts
  18|src/runtime/shell-snapshot/metric-port.ts
  14|src/runtime/shell-snapshot/no-op-metric.ts
  45|src/runtime/shell-snapshot/port.ts
  46|src/runtime/shell-snapshot/types.ts
  79|src/runtime/shell-snapshot/zsh-capture.ts
 735|src/runtime/shell.ts
 185|src/runtime/types.ts
 365|src/runtime/worktree-fork.ts
 214|src/runtime/worktree-inspect.ts
 229|src/runtime/worktree.ts
```

Tool slice (318 files) continues in the generator dump captured during inspection; union count 318+86+7+5=416 was proven by walking `src/{tool,runtime,plugin-isolation,codemode}` on the worktree at HEAD. The remaining tool paths are listed in Appendix A.

### Cohort role map (every production file assigned exactly one primary role)

| Cohort | Primary role | Public ingress | State | Outbound | Dep direction | Test owner (typical) |
|---|---|---|---|---|---|---|
| `src/tool/index.ts` + `surface/*` + `registry.ts` + `factory.ts` + `origin.ts` | assembly / provenance / registry | `buildDefaultTools`, `ToolRegistry.run`, `deriveProvenance` | origin map, tool table | dispatch, envelope | `@/tool` → `@/runtime` `@/storage` `@/shared` | `tool-surface-manifest-hellgate`, `tool-origin-substrate-hellgate` |
| `src/tool/types*` | contracts | types only | none | all tools | leaf types | `tool-no-throw-contract-guard` |
| `src/tool/bash/*` `pty/*` `node-repl` `container-exec` `test-runner` `testrun` | shell/terminal tools | named tools | bg registry via runtime | `runShell` / PTY port / kernel | tool → runtime | `bash-*`, `pty-*`, `node-repl-*` |
| `src/tool/{read,write,edit,glob,grep,web,git,gh,debug,document,...}` | capability tools | named tools | tool-local | FS/shell/network/MCP ports | tool → allowed slices | `tests/unit/tool/**`, root `tests/unit/*tool*` |
| `src/runtime/os-sandbox/*` `shell.ts` `run-argv.ts` | spawn/sandbox policy | `runShell`, `runArgv`, `OsSandbox.spawn` | sandbox slot | OS spawn | runtime → storage/shared | `tests/unit/runtime/**`, `sandbox-*` |
| `src/runtime/bash-bg-registry.ts` | bg shell lifecycle | `register`/`adopt` | handle table | spawn port | runtime | `bash-bg-registry-*` |
| `src/runtime/network-proxy/*` | egress MITM | proxy listen | connections | sockets | runtime | network-proxy tests |
| `src/runtime/node-repl/*` | REPL kernel port | kernel factory | live kernels | `node -i` | runtime | `runtime/node-repl-hellgate` |
| `src/runtime/worktree*` | git worktree runtime | `withWorktree`, `inspectWorktrees` | temp trees | `runShell git …` | runtime | `tool/worktree/*` |
| `src/plugin-isolation/*` | isolated plugin process | `spawn`/`send` | child + pending RPC | `Bun.spawn` | leaf + env carve-out | plugin-isolation hellgates |
| `src/codemode/*` | QuickJS cell sandbox | `runCodeCell` | WASM ctx | injected dispatch port | leaf | codemode hellgates |

Fingerprint for the assembly cohort: `tool-assembly/registry+gate+origin/name+ports/Tool[]/registry-map/register+run/fail-closed-schema/session`.

Fingerprint for sandbox cohort: `os-sandbox/enforcement/argv+profile/WrappedShellArgv\|SandboxedSpawnResult/slot/spawn-or-refuse/fail-closed-restrictive/session`.

## Appendix A — remaining `src/tool/**/*.ts` (lines\|path)

```text
  54|src/tool/_shared/exfil-rail-guards.ts
  98|src/tool/_shared/fresh-hash.ts
  75|src/tool/_shared/glob-in-path.ts
  28|src/tool/_shared/glob-write-gate.ts
  61|src/tool/_shared/resolve-jailed-doc.ts
 117|src/tool/_shared/write-budget.ts
 205|src/tool/advisor/advisor.ts
  32|src/tool/advisor/index.ts
  77|src/tool/advisor/port.ts
  45|src/tool/apply-patch-fallback-wire.ts
 225|src/tool/apply-patch-structured-tool.ts
 650|src/tool/apply-patch.ts
  44|src/tool/appshot/index.ts
 375|src/tool/appshot/loop.ts
 148|src/tool/appshot/port.ts
  96|src/tool/appshot/scaffold.ts
 188|src/tool/appshot/tool.ts
 250|src/tool/artifact/index.ts
 198|src/tool/ask-user/ask-user.ts
  16|src/tool/ask-user/index.ts
  86|src/tool/ask-user/port.ts
 233|src/tool/ast-grep/index.ts
 134|src/tool/async-helper.ts
 223|src/tool/automation_update.ts
 194|src/tool/bash/await.ts
  63|src/tool/bash/heredoc-lowering.test.ts
 166|src/tool/bash/heredoc-lowering.ts
 847|src/tool/bash/index.ts
 120|src/tool/bash/kill.ts
  45|src/tool/bash/per-call-factory.ts
  79|src/tool/bash/sandbox-escalation-wire.ts
 850|src/tool/browser/index.ts
 109|src/tool/browser/net-guard.ts
  98|src/tool/browser/result-map.ts
 128|src/tool/browser/schemas.ts
  86|src/tool/browser/session-holder.ts
 161|src/tool/check_secrets.ts
  13|src/tool/ci-finding/index.ts
 147|src/tool/ci-finding/store.ts
 156|src/tool/ci-finding/tool.ts
 176|src/tool/codemode-tool.ts
 139|src/tool/communicate-update.ts
 324|src/tool/container-exec/container-exec.test.ts
  37|src/tool/container-exec/docker-backend.ts
 174|src/tool/container-exec/docker-run.test.ts
 189|src/tool/container-exec/docker-run.ts
 118|src/tool/container-exec/golden-parity.test.ts
  17|src/tool/container-exec/index.ts
 204|src/tool/container-exec/ipc-backend.test.ts
 163|src/tool/container-exec/ipc-backend.ts
  49|src/tool/container-exec/port.ts
 202|src/tool/container-exec/tool.ts
 138|src/tool/container-exec/write-tool.test.ts
 210|src/tool/container-exec/write-tool.ts
 231|src/tool/coverage_check.ts
 230|src/tool/critical-section.ts
 137|src/tool/debug/cdp-client.ts
 417|src/tool/debug/cdp-inspect.ts
 139|src/tool/debug/dap-client.ts
  88|src/tool/debug/dap-codec.ts
  71|src/tool/debug/event-fanout.ts
  30|src/tool/debug/index.ts
 584|src/tool/debug/inspect-driver.ts
 299|src/tool/debug/port.ts
 307|src/tool/debug/tool.ts
 253|src/tool/default-tool-ports.ts
 256|src/tool/deferred/default-registry.ts
  20|src/tool/deferred/index.ts
  79|src/tool/deferred/legacy.ts
  61|src/tool/deferred/port.ts
  79|src/tool/deferred/types.ts
 167|src/tool/delegate/delegate.ts
  36|src/tool/delegate/index.ts
  81|src/tool/delegate/port.ts
 177|src/tool/diagnostics/index.ts
  48|src/tool/document/authoring/artifact-register.ts
 174|src/tool/document/authoring/docx-write.ts
 112|src/tool/document/authoring/docx.ts
  86|src/tool/document/authoring/index.ts
  95|src/tool/document/authoring/jailed-write.ts
  84|src/tool/document/authoring/ooxml-read.ts
 129|src/tool/document/authoring/ooxml.ts
 160|src/tool/document/authoring/pptx-write.ts
 371|src/tool/document/authoring/pptx.ts
 162|src/tool/document/authoring/xlsx-write.ts
 206|src/tool/document/authoring/xlsx.ts
 558|src/tool/document/authoring/zip-store.ts
 317|src/tool/document/csv-parse.ts
 228|src/tool/document/csv-read.ts
 109|src/tool/document/docx-read.ts
  83|src/tool/document/index.ts
  78|src/tool/document/ndjson-parse.ts
 192|src/tool/document/ndjson-read.ts
 221|src/tool/document/pdf-read.ts
 178|src/tool/document/pptx-read.ts
 352|src/tool/document/xlsx-read.ts
 265|src/tool/document/yaml-read.ts
  38|src/tool/edit/eol.ts
 118|src/tool/edit/exact.ts
 413|src/tool/edit/fuzzy.ts
 649|src/tool/edit/index.ts
  98|src/tool/edit/line-range.ts
 112|src/tool/edit/strategy-hint.ts
  67|src/tool/enter-plan-mode.ts
 164|src/tool/evidence/builder.ts
  17|src/tool/evidence/index.ts
  63|src/tool/evidence/node-runner.ts
 424|src/tool/evidence/runtime.ts
 238|src/tool/evidence/tool.ts
  92|src/tool/evidence/types.ts
 166|src/tool/factory.ts
  81|src/tool/fetch-rules/fetch-rules.ts
   8|src/tool/fetch-rules/index.ts
  20|src/tool/fetch-rules/port.ts
  36|src/tool/file-history/capture.ts
  20|src/tool/file-history/index.ts
  39|src/tool/file-history/sink.ts
 209|src/tool/file-history/store.ts
 209|src/tool/file-history/tool.ts
 587|src/tool/file-tree-summary/index.ts
 181|src/tool/find-refs/find-refs.test.ts
 227|src/tool/find-refs/index.ts
 500|src/tool/gh/index.ts
  59|src/tool/gh/outbound-body-policy.ts
  85|src/tool/gh/pr-blame-parser.ts
  43|src/tool/gh/pr-blame-types.ts
  88|src/tool/gh/pr-blame.ts
 193|src/tool/gh/pr-code-tour.ts
  96|src/tool/gh/pr-edit-labels.ts
 348|src/tool/gh/pr-open.ts
 489|src/tool/gh/pr-resolve-thread.ts
  31|src/tool/gh/ref.ts
 129|src/tool/gh/runner.ts
  32|src/tool/git-write-guard-result.ts
 251|src/tool/git/_budget.ts
  64|src/tool/git/_directive-publish.ts
  66|src/tool/git/_shared.ts
  89|src/tool/git/blame-heatmap.ts
 125|src/tool/git/blame.ts
 326|src/tool/git/branch-switch.ts
  77|src/tool/git/churn.ts
 232|src/tool/git/co-change.ts
 151|src/tool/git/commit.ts
 705|src/tool/git/compose.ts
 300|src/tool/git/conflict-inspect.ts
  16|src/tool/git/conflict-parser/index.ts
  11|src/tool/git/conflict-parser/parse.ts
  16|src/tool/git/conflict-parser/types.ts
  91|src/tool/git/diff.ts
 193|src/tool/git/index.ts
  93|src/tool/git/log.ts
 261|src/tool/git/moved-code-tool.ts
 211|src/tool/git/moved-code/index.ts
  52|src/tool/git/moved-code/normalize.ts
 215|src/tool/git/moved-code/parse-unified-diff.ts
  58|src/tool/git/moved-code/similarity.ts
  74|src/tool/git/moved-code/types.ts
 182|src/tool/git/push.ts
  92|src/tool/git/review-anchor-synth.ts
  73|src/tool/git/review-anchor.ts
 132|src/tool/git/review-diff-canvas.ts
 754|src/tool/git/review-diff.ts
  98|src/tool/git/review-source-adapter.ts
   8|src/tool/git/runner.ts
 143|src/tool/git/stage.ts
 163|src/tool/git/status.ts
 233|src/tool/git/types.ts
 124|src/tool/git/upstream.ts
 166|src/tool/glob/index.ts
 149|src/tool/grep/index.ts
  28|src/tool/image-gen/index.ts
 264|src/tool/image-gen/port.ts
  34|src/tool/image-gen/store.ts
 574|src/tool/image-gen/tool.ts
  54|src/tool/image/compose.ts
  57|src/tool/image/downsample-plan.ts
  30|src/tool/image/downsample-port.ts
 245|src/tool/image/from-url.ts
  22|src/tool/image/index.ts
 333|src/tool/image/read.ts
 973|src/tool/index.ts
 434|src/tool/localize/index.ts
 191|src/tool/lsp_nav/code-action.ts
 147|src/tool/lsp_nav/format.ts
 126|src/tool/lsp_nav/formatters.ts
 564|src/tool/lsp_nav/index.ts
 220|src/tool/lsp_nav/rename-apply.ts
 133|src/tool/lsp_nav/signature-help.ts
 146|src/tool/lsp_nav/types.ts
 123|src/tool/lsp_nav/workspace-edit-jail.ts
 186|src/tool/mcp-connector/index.ts
 507|src/tool/mcp_resources/__tests__/read-resource-dir-blob-to-disk.hellgate.test.ts
  64|src/tool/mcp_resources/capture.ts
  51|src/tool/mcp_resources/get_prompt.ts
 100|src/tool/mcp_resources/index.ts
  43|src/tool/mcp_resources/list_prompts.ts
  51|src/tool/mcp_resources/list_resource_templates.ts
  42|src/tool/mcp_resources/list_resources.ts
  94|src/tool/mcp_resources/port.ts
 127|src/tool/mcp_resources/read_resource.ts
  85|src/tool/mcp_resources/read_resource_dir.ts
 430|src/tool/mcp_resources/render.ts
  60|src/tool/mcp_tasks/cancel_task.ts
 105|src/tool/mcp_tasks/get_task.ts
  41|src/tool/mcp_tasks/index.ts
  84|src/tool/mcp_tasks/list_tasks.ts
  36|src/tool/mcp_tasks/no-throw.ts
  52|src/tool/mcp_tasks/port.ts
 237|src/tool/node-repl/index.ts
 181|src/tool/notebook-edit/index.ts
 248|src/tool/notebook-edit/tool.ts
 632|src/tool/objective/index.ts
 110|src/tool/origin.ts
 341|src/tool/output-spill.ts
 246|src/tool/parse-test-failure/index.ts
 209|src/tool/patch-mutation-safety.ts
 199|src/tool/permission-propose/index.ts
  68|src/tool/plan/create-plan.ts
 106|src/tool/plan/current-plan.ts
  45|src/tool/plan/error-mapping.ts
  42|src/tool/plan/index.ts
  94|src/tool/plan/plan-to-mermaid.ts
  65|src/tool/plan/remove-todos.ts
  82|src/tool/plan/schemas.ts
  68|src/tool/plan/update-plan.ts
  69|src/tool/plan/update-todos.ts
 149|src/tool/poll_deferred.ts
  18|src/tool/projects-kb/index.ts
  39|src/tool/projects-kb/port.ts
 242|src/tool/projects-kb/store.ts
 256|src/tool/projects-kb/tool.ts
 295|src/tool/prompt_cache_status.ts
 352|src/tool/pty/bun-pty-adapter.ts
  37|src/tool/pty/docker-exec-tmux.ts
  41|src/tool/pty/index.ts
 218|src/tool/pty/port.ts
 220|src/tool/pty/tmux-adapter.ts
 287|src/tool/pty/tools.ts
 657|src/tool/read/index.ts
 202|src/tool/read/ipynb.ts
 115|src/tool/read/outline.ts
  29|src/tool/read/parser-port.ts
   9|src/tool/reflect/index.ts
  23|src/tool/reflect/port.ts
 124|src/tool/reflect/reflect.ts
 218|src/tool/registry.ts
  94|src/tool/report-job-result/index.ts
  85|src/tool/request-plan-exit.ts
 184|src/tool/request-user-input.ts
 122|src/tool/schema.ts
 459|src/tool/scripted-replace.ts
 233|src/tool/search-codebase/index.ts
  10|src/tool/search_codebase.ts
 292|src/tool/session_config.ts
 174|src/tool/shadow-verify/index.ts
 105|src/tool/shadow/fork.ts
  48|src/tool/shadow/index.ts
 130|src/tool/shadow/restore-partial.ts
 118|src/tool/shadow/rewind.ts
  90|src/tool/shadow/snapshots.ts
  45|src/tool/shell-exec-observers.ts
  10|src/tool/shell-exec-types.ts
 353|src/tool/side-agent/index.ts
 137|src/tool/spawn-agents-csv/index.ts
  77|src/tool/stale-read-guard/gate-contract.test.ts
  45|src/tool/stale-read-guard/gate.ts
  32|src/tool/stale-read-guard/index.ts
 109|src/tool/stale-read-guard/markers.ts
  36|src/tool/stale-read-guard/reminder.ts
 316|src/tool/stale-read-guard/state.ts
  62|src/tool/stale-read-guard/types.ts
 352|src/tool/subagent-batch/batch.ts
  47|src/tool/subagent-batch/index.ts
 183|src/tool/subagent-batch/load-items.ts
 181|src/tool/subagent-batch/port.ts
 411|src/tool/subagent-batch/run-batch.ts
  85|src/tool/subagent-batch/template.ts
 144|src/tool/subagent-bg/await.ts
  94|src/tool/subagent-bg/force-background.ts
  90|src/tool/subagent-bg/fork.ts
  66|src/tool/subagent-bg/index.ts
  67|src/tool/subagent-bg/poll.ts
  65|src/tool/subagent-bg/port.ts
 396|src/tool/subagent-mailbox/index.ts
 964|src/tool/surface/gated-tools.ts
 164|src/tool/surface/manifest.ts
 138|src/tool/team/index.ts
  40|src/tool/terminal-capability-guide.test.ts
  56|src/tool/terminal-capability-guide.ts
  70|src/tool/terminal-sanitize.ts
 202|src/tool/terminal-surface.test.ts
 201|src/tool/test-runner/index.ts
  85|src/tool/testrun/detect.ts
  21|src/tool/testrun/index.ts
 659|src/tool/testrun/parse.ts
 279|src/tool/testrun/tool.ts
  34|src/tool/testrun/types.ts
  74|src/tool/threads_handoff.ts
  41|src/tool/tool-diff-capture.ts
 201|src/tool/types.ts
 645|src/tool/types/context-seams.ts
 674|src/tool/types/tool-context.ts
 316|src/tool/types/tool-contract.ts
 322|src/tool/types/tool-result.ts
 205|src/tool/update-working-state.ts
 546|src/tool/web/fetch.ts
  65|src/tool/web/html-to-markdown.ts
  43|src/tool/web/index.ts
 238|src/tool/web/providers/brave.ts
 153|src/tool/web/providers/duckduckgo.ts
  58|src/tool/web/providers/from-env.ts
  28|src/tool/web/providers/index.ts
 143|src/tool/web/search.ts
  49|src/tool/web/turndown.d.ts
 124|src/tool/workflow/run-workflow-tool.ts
  83|src/tool/worktree/cwd-override.ts
 481|src/tool/worktree/index.ts
 236|src/tool/write/index.ts
```

Union check: appendix tool entries + runtime/plugin-isolation/codemode lists = 416. Pairwise intersection with other W1 lanes is empty by path prefix. `src/shared/**` not inspected (reserved).

## End state

Scope classified on committed HEAD `0b14f5cf`. Ten retained findings (B-F1..B-F10). No production edits.

DONE
