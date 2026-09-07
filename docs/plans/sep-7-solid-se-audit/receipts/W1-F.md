# W1-F — auth, security, permission, config, capability, migration

```text
AUDIT_ASSIGNMENT|lane=F|scope=auth,security,permission,config,capability,migration|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-F.md
```

Status: **DONE** (scope classified against committed HEAD; not fixed)

## Snapshot

W0 receipt was **absent** at start and still absent at write time. Coordinator
dispatched this lane against a dirty shared checkout. Inspection used the
dispatch-pack HEAD-only rule: committed `HEAD` is the immutable snapshot;
uncommitted overlay is recorded and excluded from findings and completion claims.

| Field | Value |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| merge-base | same |
| branch | `main` |
| ahead/behind | `0 / 0` |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| tracked diff SHA-256 (`git diff HEAD`) | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked manifest SHA-256 | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` |
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md **HEAD** | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| docs/ARCHITECTURE.md working tree | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` (dirty; not used) |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| Pre-inspect vs post-inspect | HEAD / tracked-diff / AGENTS.md / ARCHITECTURE HEAD **unchanged** |
| Untracked after this receipt | `7ea8becb8d817d8bbf9ceb3f98ccc48bd8ceef2dbab3d7d386020a7fcbca7a6b` — delta is campaign receipts (`W1-F.md`, sibling `W1-C.md`). Not source STALE. |

Dirty F production overlay (excluded from truth; hashes differ from HEAD):

- `src/permission/json-state-file/engine.ts`
- `src/permission/json-state-file/locking.ts`
- `src/security/index.ts`
- `src/security/sensitivity-classifier.ts`
- `src/config/knob-inventory/{const-keyed,extra,host}.ts`
- `src/config/knob-schema/schemas/{bench-a,bench-gap-3,bench-loop}.ts`

SEP6 closeout claimed S9 complete at this HEAD, but the S9 bytes live only in
the working-tree overlay. This receipt classifies **committed HEAD**.

## Coverage

| Universe | Count | Rule |
|---|---:|---|
| HEAD `src/{auth,security,permission,config,capability,migration}/**/*.ts` | 168 | git ls-tree |
| Colocated tests (`*.test.ts` / `__tests__`) | 6 | not production |
| `wasm-assets.d.ts` | 1 | type-only; classified |
| Production `.ts` classified | **161 / 161** | exclusive F write scope |
| Production files uninspected | **0** | role+fingerprint assigned; deep PCC on high-risk clusters |

Slice production counts (HEAD, excluding colocated tests and `.d.ts`):
auth 22, security 25, permission 63, config 28, capability 5, migration 18.
Sum 161.

No F god-module `>1000`. Cohort 900–999 members in F: `src/config/knob-inventory/extra.ts` (960), `src/migration/external-config/persist.ts` (914). Crude brace scan found no F function body `>150`.

## Inspected consumers (owner → reachable consumer, not grep-close)

| Cluster | Owner (HEAD) | Consumer inspected |
|---|---|---|
| Permission JSON persist + lock | `json-state-file/engine.ts` `writeToDisk` L106–147; `locking.ts` `acquireLock` L104–130 | `permission-store.ts` L776 `mergeWithDisk`; `trust-scope-store.ts` L538/557 `createJsonStateFile` |
| Inspector vs PEP | `inspector.ts` `explainHost` | tests + barrel; live CLI uses `inspect.ts` instead |
| Sensitivity command class | `sensitivity-classifier.ts` `classifyCommandShapeAt` L387–406 (`MAX_SHELL_UNWRAP_DEPTH = 1`) | `src/tool/bash/index.ts` L701 `classifySource` (lane B; evidence only) |
| Capability probe | `capability/probe-all.ts` `runCapabilityProbe`; `resolve.ts` `resolveExposure` | `src/host/bootstrap/bootstrap-session/capability-probe.ts` L32–73 (lane G; observe-only) |
| ChatGPT refresh | `refresh-transaction.ts` `refreshTokenTransaction`; `refresh.ts` `RefreshCoordinator` | `src/llm/adapters/chatgpt-oauth.ts` L293 (lane E) |
| MCP launch filter | `config/mcp-governance.ts` `filterMcpServersByPolicy` | `src/host/mcp-composition.ts` L394 (lane G) |
| Project trust | `config/trust-store.ts` `TrustStore` | `src/apps/cli/configured-endpoint-wire.ts`; `src/host/mcp-composition.ts` L471 |
| Migration throttle lock | `external-config/ledger.ts` `recordDisposition` L92–131 | `external-config/persist.ts` `persistConvertedItems` L881–914 |
| Migration import-log lock | `persistence.ts` stale reclaim (`DEFAULT_LOCK_STALE_MS`) | colocated `import-log-stale-lock-hellgate.test.ts`; importer path |
| ChatGPT CAS store | `node-lock-file-store.ts` `compareAndSwap` | `refresh-lock.ts` → llm `chatgpt-oauth.ts` `refreshTokenTransaction` |
| Claude settings parse | `loader.ts` `asStringArray` vs `convert.ts` `asStringList` vs `claude-config-decode.ts` `commandsOf` | convert → persist → later `parseSettingsLayer` |
| Knob declaration | `knob-inventory.ts` concatenates EXTRA/HOST/… | inventory is declaration-only; live reads remain at `readSite` / `runtimeConfig()` |
| Headless security stubs | `bridge-attest/headless-stub.ts`; `jwks-identity/headless-stub.ts` | barrels + hellgates; **no live composition consumer found beyond tests** |

## Findings

### F-01 — [P1] Permission merge flush writes without the advisory lock (SEP6 S9 trigger reproduced on HEAD)

- **status:** open
- **attribution:** pre-existing on committed HEAD. SEP6 overlay repairs this in the dirty working tree and must not be treated as snapshot-closed.
- **owner:** `src/permission/json-state-file/engine.ts` HEAD `writeToDisk` ~L112: `if (useLock) locked = await acquireLock(...)` then continues into snapshot / `rereadForMerge` / `writeFile` / `rename` even when `locked === false`. `enqueueWrite` HEAD ~L163–174 clears `dirty` before the write and does not restore it on `{durable:false}`.
- **lock comment:** `locking.ts` HEAD L104–106: “caller then proceeds best-effort”.
- **consumers:** `permission-store.ts` supplies `mergeWithDisk` (lock path is therefore live). `trust-scope-store.ts` same.
- **failure mode:** two OS processes can both time out, both merge from the same on-disk snapshot, and the second `rename` last-write-WINS a security grant/denial. Failed durable writes are not retried (`dirty` stays false).
- **test honesty:** HEAD `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts` pins the fail-open (`flush proceeds lock-free (best-effort)`). The rail would **not** turn RED if the hole remains; it would turn RED if S9 were applied without updating the test. Overlay test bytes (`reason: "cross-process lock unavailable"`) are outside this snapshot.
- **retired-ID policy:** SEP6 S9 reopen is authorized because the documented trigger is reproduced on HEAD.
- **proof_limit:** static owner+consumer+HEAD test text. Multi-process race was not re-executed in this worker.
- **proposed write set (F-owned):**
  - `src/permission/json-state-file/engine.ts`
  - `src/permission/json-state-file/locking.ts` (comments/contract only as needed)
  - `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts`
- **forbidden:** `src/shared/**`; lane B/G stores that only consume the engine.

### F-02 — [P1] Nested shell wrappers classify as `public` (secret command redaction fail-open)

- **status:** open
- **attribution:** pre-existing on HEAD. Dirty overlay raises unwrap depth to 8 and fail-closes overflow; that overlay is not in the snapshot.
- **owner:** `src/security/sensitivity-classifier.ts` HEAD L373–406. `MAX_SHELL_UNWRAP_DEPTH = 1`. Start depth 0 unwraps once; nested `bash -c "bash -c printenv"` returns `"public"`. Overflow does not fail closed.
- **consumer:** `src/tool/bash/index.ts` HEAD L701 `classifySource: (input) => classifyCommandShape(input.command ?? "")`. Same classifier is also imported by container-exec (lane B).
- **failure mode:** Layer-1 source class never marks nested credential printers `secret`, so raw env/token bytes can enter model context / JSONL / distill instead of `[REDACTED:source_class_secret]`.
- **test honesty:** HEAD `tests/unit/security/sensitivity-classifier.test.ts` pins one-level unwrap only (`bash -c 'printenv'` → secret). Nested wrappers are untested on HEAD (negative control missing).
- **proof_limit:** static. Did not execute bash tool redaction E2E on a nested wrapper.
- **proposed write set (F-owned):**
  - `src/security/sensitivity-classifier.ts`
  - `tests/unit/security/sensitivity-classifier.test.ts`
- **forbidden:** do not edit `src/tool/bash/**` (lane B). Consumer evidence only.

### F-03 — [P2] Duplicate wx-lock owners inside `@/migration` with measured stale-lock drift

- **status:** open
- **attribution:** pre-existing
- **owners:**
  1. `src/migration/persistence.ts` — import-log sidecar lock; `DEFAULT_LOCK_STALE_MS`; reclaim when stale **and** owner pid dead; busy throws `ImportLogBusyError`. Hellgate: `src/migration/__tests__/import-log-stale-lock-hellgate.test.ts`.
  2. `src/migration/external-config/ledger.ts` `recordDisposition` L105–109 — `writeFile(..., {flag:"wx"})`; `EEXIST` → `return false`; **no age/pid reclaim**. Crash after create leaves a permanent lock file.
- **producer-contract-consumer:** both serialize JSON under `~/.quanta` with a sibling `.lock` via `wx`. Consumer of (2): `persistConvertedItems` L906–910 swallows ledger failure (`catch (() => false)`).
- **measured drift:** import-log recovers after bounded stale+dead; config throttle lock never recovers. Ledger comments claim worst case is “one extra prompt”; persist comments claim extra persist is “idempotent”. Merge writers refuse corrupt targets, but a skipped `imported` marker allows a later run to merge again into user-edited settings.
- **proof_limit:** static. Did not plant a crashed ledger lock and relaunch persist.
- **proposed write set (F-owned):**
  - `src/migration/external-config/ledger.ts` (canonical: reuse persistence reclaim policy or extract a migration-local lock helper **inside this slice**, do not import `@/permission`)
  - new or extended owner-local hellgate beside the existing import-log stale-lock rail
- **forbidden:** do not move the helper into `@/shared` as a generic lock dump; do not merge with permission `acquireLock` (different fence and durability contract). W2-X compares auth `FileBasedLock` / permission `acquireLock` as **foreign fingerprints**, not F write ownership.

### F-04 — [P2] Orphaned `.cas` claim wedges ChatGPT refresh until manual cleanup

- **status:** open
- **attribution:** pre-existing. Retained after [Audit auth+security](ae085dfa-ce11-4c5b-a2de-0f063b05e4a1); rechecked on HEAD owner+consumer.
- **owner:** `src/auth/node-lock-file-store.ts` `acquireCasClaim` L33–44 (`EEXIST` → `null`); `compareAndSwap` L73–74 maps null to `"changed"`. `.cas` unlink is only in `finally` L82–84. No age/pid reclaim.
- **lock mapping:** `src/auth/lock-file-based.ts` `tryReplaceExisting` L88–89: `"changed"` → `"would-wait"`.
- **consumer:** `src/auth/chatgpt-oauth/refresh-lock.ts` `createChatgptRefreshLock` → `src/llm/adapters/chatgpt-oauth.ts` `refreshTokenTransaction` (8 backoffs then `lock-timeout`).
- **failure mode:** process dies after `wx` create of `{key}.cas` and before unlink. Every later CAS returns `"changed"`. Lock JSON TTL cannot recover because takeover still needs CAS. Live ChatGPT traffic cannot refresh until an operator deletes `~/.quanta/locks/*.cas`.
- **test honesty:** `tests/unit/auth/node-lock-file-store.test.ts` asserts happy-path leaves no `.cas`. No planted-orphan red-on-injection.
- **sibling:** F-03 ledger wx lock is the same class of unreclaimed sidecar; import-log `persistence.ts` already reclaim. Do not merge auth CAS into migration code.
- **proof_limit:** static. Crash-injected leftover `.cas` not executed.
- **proposed write set (F-owned):**
  - `src/auth/node-lock-file-store.ts`
  - `tests/unit/auth/node-lock-file-store.test.ts`
- **forbidden:** do not weaken `writeToken`; persist-swallow after refresh is lane E (`chatgpt-oauth.ts`) — W2-X only.

### F-05 — [P2] Claude permission/hook string parse trim drift (loader vs convert/decode)

- **status:** open
- **attribution:** pre-existing. Retained after [Audit config+migration](6206b79b-4930-420e-b567-b060c90f00b1); rechecked on HEAD. Not a SEP5 D5 reopen (D5 closed the MCP/hooks **decode SSOT**; trim policy still forks).
- **owners:**
  1. `src/config/loader.ts` `asStringArray` L55–67 and `parseCommandHooks` L78–83 — drop whitespace-only tokens (`trim().length > 0`).
  2. `src/migration/external-config/convert.ts` `asStringList` L31–32 — keeps any string, including `"  "`.
  3. `src/migration/claude-config-decode.ts` `commandsOf` L63–71 — accepts any string `command` with no trim.
- **consumer:** `convertSettings`/`convertHooks` → `persistConvertedItems` unions into live `settings.json`. Later `parseSettingsLayer` drops the same tokens. Whitespace hooks can be persisted then vanish on central-config load, or sit as load-bearing if a matcher trims later (loader comment L58–65 names that risk).
- **test honesty:** entrypoint-parity pins valid MCP/hook fields and distinct error policies; it does not pin trim. No whitespace fixture.
- **proof_limit:** static. Did not run a `"  "` allow-rule through convert+persist+loader.
- **proposed write set (F-owned):**
  - `src/migration/claude-config-decode.ts` (canonical trim, then convert uses it)
  - `src/migration/external-config/convert.ts` `asStringList` (delegate or delete)
  - owner-local whitespace fixture on the existing entrypoint-parity rail
- **forbidden:** do not edit loader trim away; loader is the live settings reader. Do not import `@/config` from `@/migration`.

### F-06 — [P2] `explainResolution` lies about `custom` host vs live `evaluateStack`

- **status:** open
- **attribution:** pre-existing. Retained after [Audit permission+capability](93f231ef-0c5d-493b-ab2b-4f7114584647); rechecked on HEAD.
- **owner:** `src/permission/inspector.ts` `explainHost` L126–142 uses `hostAllowsMutation`. That adapter maps `custom` → `undefined` (`per-host-mode.ts` L120–131), so explainHost returns `null` and `explainResolution` falls through to `{outcome:"ask", source:"global-default"}` L184–189.
- **live PEP:** `src/permission/policy.ts` `evaluateStack` L589–618 uses `hostMutationVerdict`. `custom` → `"defer"` → **soft-deny fail-closed**. Comment L589–595 states the boolean adapter must not be used here because it would implicit-allow via global default.
- **contract:** `inspector.ts` L14–16 and L145–147 claim the explanation is observationally identical to `evaluateStack`.
- **consumer:** slice barrel `getPermissionInspector`. Live CLI `/permission explain` uses `inspectPermission` (`inspect.ts`), not this inspector. Tests are the current callers.
- **failure mode:** a UI/API consumer of `explainResolution` reports ask/mode-policy for a host the gate will deny. Operator can grant based on the explanation and still be denied, or the reverse if they treat "ask" as weaker than deny.
- **test honesty:** `tests/unit/permission-inspector.test.ts` "explain.outcome matches evaluateStack.kind for every axis" only pins `read-only` host. Zero `custom` cases. Removing the fail-closed `defer` branch in `evaluateStack` would not turn this test red.
- **proof_limit:** static. No live app caller of `explainResolution` found under `src/apps` / `src/host`.
- **proposed write set (F-owned):**
  - `src/permission/inspector.ts` (`explainHost` must use `hostMutationVerdict`; `defer` ⇒ deny)
  - `tests/unit/permission-inspector.test.ts` (custom host explain.outcome === evaluateStack.kind)
- **forbidden:** do not change `evaluateStack` fail-closed; do not "fix" by making the PEP match the inspector.

## Inventory smells (not findings)

- `extra.ts` 960 and `persist.ts` 914 sit in the 900–999 cohort. Data table / persist module; no function `>150` found. No failure mode from size alone. Split-on-sight if those files are touched.
- Knob-schema comments still say “not wired into the live driver” while `bench.ts` derives from `ALL_BENCH_SCHEMAS`. Comment dual-truth; leaf ratchet (no `@/runner`) still holds. P3 honesty, not a runtime finding.
- ChatGPT persist-fail swallow (`src/llm/adapters/chatgpt-oauth.ts`) is lane E. `writeToken` already throws. W2-X fingerprint only.
- `profile-list-select.ts` 895, `permission-store.ts` 871, `trust-scope-store.ts` 807, `shell/assess.ts` 763, `policy.ts` 707 — SRP pressure, still below god-module.
- `json-state-file.ts` HEAD comment still says a “true lockfile remains the v4 follow-up” while `locking.ts` already exists. Comment drift only.
- `rereadForMerge` maps absent/corrupt/mismatch → `null` then merge writes our state. Intentional peer-crash posture; can clobber a corrupt peer file. Documented.
- Capability layer is observe-only (`probeCapabilityConsistency` warns, never gates). Dual **readers** of env gates, one writable env. Not two writable owners.
- `RedisLockStub` always returns `redis-error`; `FallbackLock` is designed for that LSP weakening. No live ChatGPT path depends on Redis.
- `headlessStubAttestor` deny-all / `headlessJwksClient` `{ok:false, reason:"cache-miss"}` — fail-closed stubs; no production composition consumer found beyond tests.
- Two inspectors: `inspect.ts` (stateless `/permission explain`, live CLI) vs `inspector.ts` (store-backed `explainResolution`, tests + barrel only). Different questions until F-06; do not merge the modules.
- `two-layer-manager` + `canAccess` are tested and built by host `agent-arg-builder`, but `getEffectiveAccess` is not called by the admissibility PEP. `profile-to-context.ts` documents FS pillar as non-dispatch. Stale two-layer-as-evaluateStack-step-4 comment is smell, not a second live PEP.
- `profile-to-context`: `once|session|always` all map to `"default"` — approval-mode distinctions are not representable on live `PermissionContext.mode`.
- `gitWriteProtectReason` is F-owned but applied by dispatch-guard on `path|file_path|target|file` only. Shell `command` writes are a lane A/B consumer gap (X-git-shell), not a second F writer.
- `config/trust-store.ts` (path trust, default UNTRUSTED) vs `permission/trust-scope-store.ts` (tool grants + TTL) — different contracts.
- Knob `home:"runtime-config"` vs typed `runtimeConfig()` remains the SEP5 D27/D28 governed split. `KNOB_INVENTORY` and `RUNTIME_CONFIG_KNOBS` are still two writable **declaration** lists; BENCH inventory is derived (`bench.ts` ← `ALL_BENCH_SCHEMAS`). Disjoint-by-envKey ratchet is live. Not reopened: no same-key runtime double-apply on HEAD. Shard claim that `knob-read-authority-parity` orphan-runtime is vacuous was **not reproduced** — that test only checks authority tags + duplicates on the live inventory.
- SEP5 D1 redaction vs trajectory vs scanner stays fence-split; not reopened (no new HEAD reproduction beyond the historical known-gap note).
- SEP5 D2/D30 ChatGPT live path **does** call `refreshTokenTransaction` + `FileBasedLock` from `chatgpt-oauth.ts`. In-process `RefreshCoordinator` remains the single-flight owner. Closed unless a second live refresh without the transaction is shown.
- SEP5 D5 `claude-config-decode.ts` remains the shared decoder for convert/translators. Closed.
- Circumvention detector is documented advisory FN. Not a finding.

## Candidate fingerprints for W2-X

Fingerprint shape: `authority/invariant/input/output/state/effect/failure-policy/lifecycle`.

| ID | Fingerprint | F owner | Foreign peer (do not edit) |
|---|---|---|---|
| X-lock-wx | advisory-lock / mutual-exclusion / path+ttl / acquired\|busy / lockfile / write-or-skip / fail-open-or-busy / stale-reclaim | F-03 ledger vs persistence; F-04 `.cas`; permission `acquireLock`; auth `FileBasedLock` | storage atomic-write (lane D) |
| X-claude-trim | settings-decode / whitespace-token / json-array / string[] / none / persist-then-reload / drop-vs-keep / none | F-05 loader vs convert vs decode | agent command-hooks settings-loader (lane A) |
| X-atomic-bytes | durable-rename / crash-safe-bytes / path+payload / void\|error / tmp file / fsync+rename / fail-closed-before-rename / tmp-cleanup | `private-file-atomic.ts`; `persist.writeJsonAtomic`; permission engine | `@/storage` writeFileAtomic |
| X-secret-regex | secret-pattern / known-format-mask / string / redacted+hits / none / replace-spans / closed-union / none | `security/redaction.ts` vs `secret-detection/pattern-scanner.ts` vs `pii-redaction/pattern-scanner.ts` | `shared/trajectory.ts` `redactValue` (D1 closed; parity hellgate) |
| X-path-canon | path-identity / alias-collapse / path+cwd / canonical string / none / compare / reject-relative / no-symlink | `config/trust-store.canonicalizeProjectPath`; `permission/circumvention` segments; `special-path-resolver` | git/path helpers (lane H) |
| X-trust | trust-grant / default-untrusted-vs-ttl-allow / path-or-tool / boolean / file / persist / fail-closed-absent / flush | `TrustStore` vs `TrustScopeStore` | host/cli wire (lane G) |
| X-knob-read | env-knob / declared-vs-typed-read / envKey / value / none / process.env or runtimeConfig / ratchet-43-raw / startup-seed | `knob-inventory/**` + `derive-inventory.ts` | `shared/runtime-config` (RESERVED) |
| X-mcp-policy | mcp-launch-allowdeny / name-filter / server[]+policy / kept+dropped / none / drop / deny-wins / empty-allowlist-noop | `mcp-governance.ts` | host mcp-composition; permission MCP rules if any |
| X-token-persist | token-durability / refresh-then-disk / TokenRecord / void\|mem-fallback / mem vs file / http+write / swallow-persist / lock-released | F writeToken throws | llm `chatgpt-oauth.ts` persist catch (lane E) |
| X-pep | live-PEP vs unused two-layer / inspector-explain / named-profile FS | evaluateStack+decideFloor vs canAccess unused | agent admissibility-gate (lane A); host builder |
| X-git-shell | git-write-protect / path-fields-only / action / reason\|null / none / deny-or-proceed / default-OFF-helper / none | git-write-guard.ts | dispatch-guard + bash (lanes A/B) |

## No-finding bounded areas

- Auth PKCE, JWT decode, revoke, callback-port, paths, browser-flow-error: classified; no second owner for those contracts.
- Permission fail-closed base hellgate (branch-only, `..` jail, empty writableRoots, custom host defer) still matches production helpers inspected in `fail-closed-base.hellgate.test.ts`.
- Permission `thread-permission-decode.ts` remains the D10 decode SSOT used by store/posture.
- Config `managed-path.ts` is pure OS path enumeration; absent file fail-safe in loader.
- Config `derive-inventory.ts` is a pure schema→inventory projection for bench knobs, not a second runtime reader.
- Security luhn-validator, entropy-scanner, secretlint adapter: scanner ports with distinct outputs (findings vs redaction spans).
- Capability seed registry (4 caps) is data; enforcement stays at surface gates while master gate is default-OFF.

## Uninspected conditions

- Runtime two-process permission lock race (HEAD fail-open) not re-run; SEP6 overlay tests exist but are dirty.
- Nested `bash -c` redaction through the live bash tool + model envelope not executed.
- Ledger stale-lock crash fixture not planted.
- Full `shell/assess.ts` vs `@/tool/bash` permission vehicle (foreign SUT; fingerprint only).
- Every bench knob schema semantic vs runner derive (`@/runner/batch/eval/kernel/derive` is lane E).
- JWKS/attestor production composition outside tests (bounded absence in `src/` grep).
- Cognitive-complexity scores / lint-debt per-function (lint-debt file is W0/W2-P authority; not re-measured here).
- Working-tree overlay behavior (explicitly out of scope).

## Exact proposed write sets

| Finding | Files | Notes |
|---|---|---|
| F-01 | `src/permission/json-state-file/engine.ts`, `src/permission/json-state-file/locking.ts`, `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts` | Align HEAD with SEP6 S9 contract: no write outside lock; restore `dirty` on non-durable newest generation |
| F-02 | `src/security/sensitivity-classifier.ts`, `tests/unit/security/sensitivity-classifier.test.ts` | Nested unwrap + overflow fail-closed; RED on `bash -c "bash -c printenv"` → secret |
| F-03 | `src/migration/external-config/ledger.ts`, owner-local hellgate under `src/migration/__tests__/` or `tests/unit/migration/` | Reclaim policy parity with `persistence.ts`; do not share permission/auth lock types |
| F-04 | `src/auth/node-lock-file-store.ts`, `tests/unit/auth/node-lock-file-store.test.ts` | Stale `.cas` reclaim or TTL steal without claim; planted-orphan RED |
| F-06 | `src/permission/inspector.ts`, `tests/unit/permission-inspector.test.ts` | `hostMutationVerdict`; custom host RED vs `evaluateStack` |

W1 must not edit `src/shared/**`, feature catalog, architecture configs, or foreign slices.

## File manifest (production)

Legend: role = port / adapter / policy / persist / decode / registry / barrel / stub / types. Fingerprint abbreviated as `auth|inv|in|out|state|effect|fail|life`.

Colocated tests (not production): `src/config/knob-schema/schemas/bench-repro-acceptance-doc.test.ts`; `src/migration/__tests__/import-log-fsync-hellgate.test.ts`; `src/migration/__tests__/import-log-stale-lock-hellgate.test.ts`; `src/permission/__tests__/fail-closed-base.hellgate.test.ts`; `src/permission/__tests__/profile-list-select.hellgate.test.ts`; `src/permission/__tests__/profile-list-select-harder.hellgate.test.ts`. Type-only: `src/permission/shell/wasm-assets.d.ts`.

### auth (22)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/auth/index.ts | 5 | barrel | re-export | tests/unit/auth-slice-boundary.test.ts | n/a |
| src/auth/oauth-refresh-lock.ts | 55 | port | tryAcquire/release | tests/unit/oauth-refresh-lock-hellgate.test.ts | lock/mutex/key+ttl/LockResult/map-or-file/acquire/redis-error-fallback/ttl-reap |
| src/auth/lock-in-memory.ts | 82 | adapter | OAuthRefreshLockPort | same | lock/in-proc/key/LockResult/Map/none/holder-check/ttl |
| src/auth/lock-file-based.ts | 133 | adapter | OAuthRefreshLockPort | same | lock/cross-proc/key/LockResult/lockfile/fs/mtime-reap/ttl |
| src/auth/lock-redis-stub.ts | 92 | stub+chain | RedisLockStub/FallbackLock | same | lock/redis-absent/key/redis-error/none/none/always-error/phase1 |
| src/auth/node-lock-file-store.ts | 87 | adapter | file store IO | same | persist/lock-dir/path/bytes/dir/fs/wx/none |
| src/auth/private-file-atomic.ts | 130 | persist | writePrivateFileAtomic | tests around token-store | durable-bytes/crash-safe/path+payload/void/tmp/fsync-rename/fail-before-rename/tmp-clean |
| src/auth/github-token-rotation.ts | 225 | policy | rotate with lockPort | tests/unit/github-token-rotation-hellgate.test.ts | oauth-refresh/single-flight+lock/token/new-token/none/http+lock/throw/lock-lifetime |
| src/auth/chatgpt-oauth/index.ts | 13 | barrel | re-export | tests/unit/auth/* | n/a |
| src/auth/chatgpt-oauth/config.ts | 75 | types | resolveOAuthConfig | chatgpt oauth tests | oauth-config/issuer+client/env/cfg/none/none/throw-missing/none |
| src/auth/chatgpt-oauth/paths.ts | 31 | policy | home/auth paths | same | path/auth-root/env/path/none/none/default-home/none |
| src/auth/chatgpt-oauth/pkce.ts | 17 | decode | pkce pair | same | pkce/s256/none/verifier+challenge/none/hash/throw/ephemeral |
| src/auth/chatgpt-oauth/jwt.ts | 89 | decode | decodeJwtClaims | same | jwt-claims/decode/string/claims/none/none/shape-throw/none |
| src/auth/chatgpt-oauth/callback-port.ts | 62 | port | loopback callback | cli-callback tests | oauth-callback/redirect/url/code/none/http/timeout/bind |
| src/auth/chatgpt-oauth/cli-callback.ts | 319 | adapter | createCliOAuthCallback | same | oauth-callback/cli/url/tokens/none/http+browser/error-typed/port-lifetime |
| src/auth/chatgpt-oauth/browser-flow.ts | 179 | adapter | interactive login | same | oauth-browser/auth-code/cfg/tokens/none/browser+http/error/flow |
| src/auth/chatgpt-oauth/browser-flow-error.ts | 24 | types | errors | same | oauth-error/class/none/Error/none/none/typed/none |
| src/auth/chatgpt-oauth/refresh.ts | 284 | policy | refreshToken / RefreshCoordinator | tests/unit/auth/t07-refresh-hellgate | oauth-refresh/in-proc-coalesce/RefreshInput/TokenRecord/inflight Map/http/throw-shape/clear-on-settle |
| src/auth/chatgpt-oauth/refresh-lock.ts | 24 | adapter | createChatgptRefreshLock | chatgpt-refresh-transaction tests | lock/chatgpt-home/env/port/none/file-lock/none/shared-dir |
| src/auth/chatgpt-oauth/refresh-transaction.ts | 122 | policy | refreshTokenTransaction | tests/unit/auth/chatgpt-refresh-transaction.test.ts | oauth-refresh/cross-proc-tx/key+deps/TokenRecord/lock held/http+persist/lock-timeout/release-finally |
| src/auth/chatgpt-oauth/token-store.ts | 269 | persist | read/write token | token-store tests | token-record/0600-file/path/TokenRecord/file/atomic-write/shape-throw/expire |
| src/auth/chatgpt-oauth/revoke.ts | 93 | adapter | revoke | revoke tests | oauth-revoke/token/cfg/void/none/http/ignore-missing/none |

### security (25)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/security/index.ts | 24 | barrel | redact/classify exports | tests/unit/security-slice-boundary.test.ts | n/a |
| src/security/sensitivity-classifier.ts | 413 | policy | classifyPath/classifyCommandShape | tests/unit/security/sensitivity-classifier.test.ts | source-class/secret-path-or-cmd/path\|cmd/enum/none/none/fail-open-nested/none **F-02** |
| src/security/redaction.ts | 359 | policy | redactSecrets | tests/unit/redaction-parity-hellgate.test.ts; security/redaction-*.test.ts | redact/known-format/string/text+hits/none/replace/closed-union/none |
| src/security/redaction-config.ts | 117 | types | config | tests/unit/security/redaction-config.test.ts | redact-cfg/toggles/opts/cfg/none/none/default/none |
| src/security/pii-redaction/index.ts | 16 | barrel | PII scanner | pii tests | n/a |
| src/security/pii-redaction/port.ts | 121 | port | PiiScanner | same | pii-scan/findings/text/findings/none/none/max-findings/none |
| src/security/pii-redaction/pattern-scanner.ts | 192 | adapter | patterns | same | pii-regex/kind/text/findings/none/match/high-conf/none |
| src/security/pii-redaction/luhn-validator.ts | 46 | decode | luhn | same | luhn/checksum/digits/bool/none/none/reject/none |
| src/security/pii-redaction/composite-scanner.ts | 136 | adapter | compose | same | pii-compose/union/text/findings/none/fan-in/cap/none |
| src/security/secret-detection/index.ts | 33 | barrel | SecretScanner | secret-detection tests | n/a |
| src/security/secret-detection/port.ts | 142 | port | scan | same | secret-scan/findings/path\|text/findings/none/io/read-error/none |
| src/security/secret-detection/pattern-scanner.ts | 235 | adapter | SECRET_PATTERN_CATALOG | same | secret-regex/kind/text/findings/none/match/high/none |
| src/security/secret-detection/entropy-scanner.ts | 235 | adapter | entropy | same | secret-entropy/generic/text/findings/none/score/threshold/none |
| src/security/secret-detection/secretlint-scanner.ts | 256 | adapter | secretlint | same | secretlint/rules/text/findings/none/lib/fail-soft/none |
| src/security/secret-detection/composite-scanner.ts | 90 | adapter | compose | same | secret-compose/union/text/findings/none/fan-in/cap/none |
| src/security/bridge-attest/index.ts | 28 | barrel | attestor | tests/unit/security/bridge-attest-hellgate.test.ts | n/a |
| src/security/bridge-attest/port.ts | 43 | port | BridgeAttestor | same | attest/preflight-verify-revoke/req/result/none/none/deny-default/none |
| src/security/bridge-attest/types.ts | 170 | types | Attest* | same | n/a |
| src/security/bridge-attest/default-attestor.ts | 301 | adapter | defaultAttestor | same | attest/remote/req/result/cache?/http/deny-on-fail/token-ttl |
| src/security/bridge-attest/headless-stub.ts | 34 | stub | headlessStubAttestor | same | attest/headless/req/deny/none/none/always-deny/none |
| src/security/jwks-identity/index.ts | 19 | barrel | JwksClient | tests/unit/security/jwks-identity-hellgate.test.ts | n/a |
| src/security/jwks-identity/port.ts | 39 | port | JwksClient | same | jwks/verify/jwt/VerifyResult/cache/http/cache-miss/refresh |
| src/security/jwks-identity/types.ts | 103 | types | | same | n/a |
| src/security/jwks-identity/default-client.ts | 319 | adapter | defaultJwksClient | same | jwks/fetch-verify/url+jwt/result/cache/http/fetch-error/ttl |
| src/security/jwks-identity/headless-stub.ts | 33 | stub | headlessJwksClient | same | jwks/headless/jwt/{ok:false}/none/throw-fetch/cache-miss/none |

### capability (5)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/capability/index.ts | 25 | barrel | | tests/unit/capability/* | n/a |
| src/capability/descriptor.ts | 74 | types | CapabilityDescriptor | same | n/a |
| src/capability/registry.ts | 70 | registry | CAPABILITIES | capability-exposure hellgate | cap-data/id+gate+surfaces/none/list/frozen/none/dangling-gate-ratchet/none |
| src/capability/resolve.ts | 86 | policy | resolveExposure | same | cap-exposure/gate AND requires/env/bool/none/none/master-off-unwired/none |
| src/capability/probe-all.ts | 87 | policy | runCapabilityProbe | host capability-probe (G) | cap-probe/consistency/env/probes/none/log-only/gate-off-empty/none |

### config (28)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/config/index.ts | 155 | barrel | | tests/unit/config-slice-boundary.test.ts; knob-* hellgates | n/a |
| src/config/types.ts | 211 | types | ResolvedSettings | loader tests | n/a |
| src/config/loader.ts | 379 | adapter | load settings layers | tests/unit around loader/merge | config-load/layers/paths/ResolvedSettings/files/read/absent-empty/layer-order |
| src/config/merge.ts | 318 | policy | merge layers | merge tests | config-merge/precedence/layers/ResolvedSettings/none/none/deny-wins/none |
| src/config/mcp-governance.ts | 58 | policy | filterMcpServersByPolicy | host mcp-composition | mcp-filter/allowdeny/name/kept+dropped/none/filter/empty-allowlist-noop/none |
| src/config/managed-path.ts | 38 | policy | osManagedSettingsPath | managed-path tests | managed-path/os-convention/platform/path/none/none/override-wins/none |
| src/config/trust-store.ts | 167 | persist | TrustStore | trust-store tests | project-trust/default-untrusted/path/bool/map+file/flush/relative-throw/canonical-key |
| src/config/knob-catalog.ts | 259 | registry | mergeKnobCatalog | knob catalog tests | knob-catalog/help-projection/decls/catalog/none/none/none/none |
| src/config/knob-inventory.ts | 72 | registry | KNOB_INVENTORY concat | tests/unit/knob-read-authority-parity.test.ts | knob-decl/declaration-only/envKey/entry/none/none/home-is-target/none |
| src/config/knob-inventory/types.ts | 47 | types | | same | n/a |
| src/config/knob-inventory/bench.ts | 20 | registry | BENCH derived | derive-inventory tests | knob-decl/bench-schema-derived/schema/entry/none/none/none/none |
| src/config/knob-inventory/const-keyed.ts | 339 | registry | CONST_KEYED | knob inventory hellgates | knob-decl/table/envKey/entry/none/none/none/none |
| src/config/knob-inventory/daemon.ts | 277 | registry | DAEMON | same | knob-decl/table/envKey/entry/none/none/none/none |
| src/config/knob-inventory/extra.ts | 960 | registry | EXTRA | same | knob-decl/table/envKey/entry/none/none/none/none **cohort 960** |
| src/config/knob-inventory/host.ts | 640 | registry | HOST | same | knob-decl/table/envKey/entry/none/none/none/none |
| src/config/knob-inventory/mention.ts | 134 | registry | MENTION | same | knob-decl/table/envKey/entry/none/none/none/none |
| src/config/knob-inventory/runner.ts | 314 | registry | RUNNER | same | knob-decl/table/envKey/entry/none/none/none/none |
| src/config/knob-schema/contracts.ts | 146 | types | KnobSchema | schema tests | n/a |
| src/config/knob-schema/derive-inventory.ts | 101 | decode | deriveInventoryEntry | same | knob-derive/schema→inventory/schema/entry/none/none/escape-hatches/none |
| src/config/knob-schema/schemas/index.ts | 222 | registry | ALL_BENCH_SCHEMAS | same | knob-schema/bench/none/list/none/none/none/none |
| src/config/knob-schema/schemas/bench-a.ts | 317 | registry | schemas | same | knob-schema/bench-a/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-b.ts | 542 | registry | schemas | same | knob-schema/bench-b/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-c.ts | 252 | registry | schemas | same | knob-schema/bench-c/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-gap-1.ts | 278 | registry | schemas | same | knob-schema/gap1/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-gap-2.ts | 261 | registry | schemas | same | knob-schema/gap2/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-gap-3.ts | 403 | registry | schemas | same | knob-schema/gap3/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-loop.ts | 126 | registry | schemas | same | knob-schema/loop/none/schema/none/none/none/none |
| src/config/knob-schema/schemas/bench-repro.ts | 179 | registry | schemas | same | knob-schema/repro/none/schema/none/none/none/none |

### permission (63 production)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/permission/index.ts | 397 | barrel | | tests/unit/permission-slice-boundary.test.ts | n/a |
| src/permission/types.ts | 367 | types | | | n/a |
| src/permission/pdp.ts | 53 | port | decide | pdp/access tests | pdp/allow-ask-deny/action/verdict/none/none/fail-closed-missing/none |
| src/permission/access-check.ts | 152 | policy | canAccess | fail-closed-base hellgate | fs-access/jail/path+policy/bool/none/none/empty-roots-deny/none |
| src/permission/outcome.ts | 190 | types | verdicts | | n/a |
| src/permission/deny-reason.ts | 189 | types | reasons | | n/a |
| src/permission/json-state-file.ts | 176 | persist | createJsonStateFile | json-state-file-lock-clock hellgate | persist/json-state/opts/handle/file/debounce-rename/load-empty-corrupt/lock-if-merge **F-01** |
| src/permission/json-state-file/engine.ts | 314 | persist | writeToDisk/enqueueWrite | same | persist/flush/EngineState/PersistOutcome/dirty+baseline/fs/lock-timeout-write-anyway/queue **F-01** |
| src/permission/json-state-file/locking.ts | 152 | persist | acquireLock | same | lock/wx-stale-steal/lockPath/bool/lockfile/fs/timeout-false/stale-ms **F-01** |
| src/permission/permission-store.ts | 871 | persist | createPermissionStore | permission-store concurrent e2e | perm-state/grants-denials/file/state/live+disk/mergeWithDisk/in-memory-authoritative/debounce |
| src/permission/trust-scope.ts | 131 | policy | TrustScopeRegistry | trust-scope tests | trust-scope/cascade/tool+key/bool/memory/none/deny-short-circuit/ttl-read |
| src/permission/trust-scope-store.ts | 807 | persist | file-backed registry | trust-scope concurrent e2e | trust-scope/persist/file/grants/json-state/merge/ttl-filter/debounce |
| src/permission/posture-persistence.ts | 275 | persist | posture file | D10 decode tests | posture/persist/file/posture/json/none/decode-ssot/none |
| src/permission/per-thread-store.ts | 77 | persist | thread domain | store tests | thread-perm/mutate/state/void/memory/flush/none/none |
| src/permission/per-host-mode.ts | 132 | policy | hostAllowsMutation | fail-closed-base | host-mode/custom-defer/mode/verdict/none/none/custom-not-allow/none |
| src/permission/thread-permission-decode.ts | 121 | decode | decodeThreadPermission | D10 | decode/thread-json/unknown/ThreadPermission/none/none/shape-invalid/none |
| src/permission/classifier.ts | 584 | policy | ClassifierPort + taxonomy prompt | auto-mode tests | auto-class/llm-threat/action/allow-block/denial-counts/llm/absent→ask/circuit-break |
| src/permission/circumvention.ts | 581 | policy | denied-effect tracker | circumvention tests | circumvention/same-path-diff-tool/path/advisory/memory/none/fn-obfuscated/turn-clock |
| src/permission/git-write-guard.ts | 198 | policy | gitWriteProtectReason | git-write tests | git-protect/destructive/cmd/reason/none/none/fail-closed-protected/none |
| src/permission/branch-only.ts | 225 | policy | decideBranchOnly | fail-closed-base | branch-protect/reset-on-protected/cmd+branch/verdict/none/none/deny-hard/none |
| src/permission/approval-ladder.ts | 91 | policy | ladder | approval tests | approval/ladder/state/next/none/none/none/none |
| src/permission/assessment-collapse.ts | 208 | policy | collapse | same | assessment/collapse/layers/verdict/none/none/deny-wins/none |
| src/permission/named-profiles.ts | 139 | registry | profiles | profile tests | profile/named/id/profile/none/none/unknown/none |
| src/permission/permission-profile.ts | 219 | types | PermissionProfile | same | n/a |
| src/permission/profile-inheritance.ts | 626 | policy | inherit | profile-inheritance tests | profile-inherit/layer-merge/profiles/profile/none/none/none/none |
| src/permission/profile-layer-merge.ts | 383 | policy | merge layers | same | profile-merge/layers/in/out/none/none/none/none |
| src/permission/profile-list-select.ts | 895 | policy | select | colocated profile-list-select hellgates | profile-select/list-ui/items/choice/none/none/none/none |
| src/permission/profile-to-context.ts | 66 | decode | to context | same | profile→ctx/project/profile/ctx/none/none/none/none |
| src/permission/policy.ts | 707 | policy | evaluate | policy tests | perm-policy/rules/action/verdict/none/none/fail-closed/none |
| src/permission/policy-rules.ts | 370 | registry | rules | same | perm-rules/table/action/match/none/none/none/none |
| src/permission/policy-layers/index.ts | 438 | policy | layer stack | provenance tests | perm-layers/stack/action/verdict/none/none/none/none |
| src/permission/policy-layers/provenance-guard.ts | 682 | policy | provenance | same | provenance/tool-origin/action/verdict/none/none/fail-closed/none |
| src/permission/special-path-resolver.ts | 220 | adapter | createCachedResolver | fail-closed-base | special-path/kind→abs/ports/path/cache/none/missing-port/cache-lifetime |
| src/permission/inspector.ts | 198 | inspect | inspect | inspect tests | inspect/explain/action/report/none/none/none/none |
| src/permission/inspect.ts | 433 | inspect | inspect API | same | inspect/explain/action/report/none/none/none/none |
| src/permission/recorder.ts | 214 | persist | record decisions | recorder tests | record/audit/decision/void/ledger/flush/none/none |
| src/permission/remember-patterns.ts | 296 | policy | remember | remember tests | remember/pattern-grant/pattern/void/state/flush/none/none |
| src/permission/review-kind.ts | 270 | types | review kinds | reviewer tests | n/a |
| src/permission/reviewer.ts | 348 | policy | reviewer | same | review/hitl/action/decision/none/none/ask/none |
| src/permission/reviewer-default-policy.ts | 109 | policy | defaults | same | review-default/policy/none/policy/none/none/none/none |
| src/permission/auto-approval-review.ts | 141 | policy | createApprovalReviewer | auto-approval tests | auto-approve/review/action/decision/none/none/none/none |
| src/permission/auto-approval-review-observer.ts | 81 | adapter | observer | same | observe/review/event/void/none/log/none/none |
| src/permission/autorun-eligibility.ts | 156 | policy | eligible? | autorun tests | autorun/eligibility/ctx/bool/none/none/fail-closed/none |
| src/permission/autorun-eligibility-wire.ts | 49 | adapter | wire | same | autorun-wire/compose/ctx/bool/none/none/none/none |
| src/permission/gate-pattern-wire.ts | 224 | adapter | gate patterns | gate tests | gate-pattern/wire/pattern/bool/none/none/none/none |
| src/permission/session-grant-prefix.ts | 195 | policy | [P] prefix | session-grant tests | session-grant/prefix/text/grant/none/none/invalid-reject/none |
| src/permission/two-layer-manager.ts | 190 | policy | two-layer | two-layer tests | two-layer/user+project/rules/verdict/none/none/none/none |
| src/permission/post-denial.ts | 171 | policy | post-denial | post-denial tests | post-denial/follow-up/denial/action/none/none/none/none |
| src/permission/posture/types.ts | 168 | types | | posture tests | n/a |
| src/permission/posture/ports.ts | 50 | port | | same | n/a |
| src/permission/posture/authority.ts | 300 | policy | createPostureAuthority | same | posture-auth/control/state/verdict/none/none/none/none |
| src/permission/posture/availability.ts | 225 | policy | availability | same | posture-avail/flags/state/bool/none/none/none/none |
| src/permission/posture/control.ts | 169 | policy | buildPostureControl | same | posture-ctrl/build/opts/control/none/none/none/none |
| src/permission/posture/presets.ts | 212 | registry | presets | same | posture-preset/table/id/preset/none/none/unknown/none |
| src/permission/posture/question-policy.ts | 97 | policy | questions | same | posture-q/policy/state/question/none/none/none/none |
| src/permission/shell/index.ts | 22 | barrel | | shell assess tests | n/a |
| src/permission/shell/ir.ts | 324 | decode | shell IR | same | shell-ir/ast/cmd/IR/none/none/parse-fail/none |
| src/permission/shell/parser.ts | 124 | decode | parse | same | shell-parse/text/cmd/IR/none/none/fail/none |
| src/permission/shell/assess.ts | 763 | policy | assess | same | shell-assess/effect/IR/assessment/none/none/fail-closed/none |
| src/permission/shell/rules.ts | 639 | registry | rules | same | shell-rules/table/IR/match/none/none/none/none |
| src/permission/shell/path-effect.ts | 116 | policy | path effect | same | shell-path/write-set/IR/paths/none/none/fn-vars/none |
| src/permission/shell/vehicle.ts | 71 | types | vehicle | same | n/a |
| src/permission/shell/write-targets.ts | 189 | policy | write targets | circumvention uses this | shell-write/targets/cmd/paths/none/none/fn-obfuscated/none |

### migration (18)

| path | loc | role | ingress | test owner | fingerprint |
|---|---:|---|---|---|---|
| src/migration/index.ts | 52 | barrel | | tests/unit/skill-migration.test.ts; migration hellgates | n/a |
| src/migration/types.ts | 181 | types | | | n/a |
| src/migration/detector.ts | 88 | policy | detect | detector tests | detect/external-config/fs/items/none/stat/absent-empty/none |
| src/migration/dedup.ts | 107 | decode | dedup | dedup tests | dedup/identity/items/items/none/none/none/none |
| src/migration/importer.ts | 303 | adapter | import sessions | importer tests | import/session-log/home/result/log/fs/busy-throw/lock-reclaim |
| src/migration/persistence.ts | 241 | persist | appendImportLog | import-log-fsync + stale-lock hellgates | import-log/append/home+entry/void/jsonl/fsync-rename/busy-error/stale-reclaim **F-03 peer** |
| src/migration/claude-config-decode.ts | 95 | decode | decode claude MCP/hooks | D5; convert+translators | claude-decode/mcp-hooks/unknown/typed/none/none/invalid/none |
| src/migration/translators/index.ts | 36 | barrel | | translator tests | n/a |
| src/migration/translators/types.ts | 25 | types | | | n/a |
| src/migration/translators/claude-code.ts | 207 | decode | translate session | same | translate/session/claude/quanta/none/none/none/none |
| src/migration/translators/claude-code-config.ts | 91 | decode | translate config via decode SSOT | same | translate/config/claude/quanta/none/none/none/none |
| src/migration/external-config/index.ts | 68 | barrel | | external-config-migration hellgate | n/a |
| src/migration/external-config/types.ts | 232 | types | | | n/a |
| src/migration/external-config/detect.ts | 255 | policy | detect configs | same | detect/settings-mcp/fs/items/none/stat/none/none |
| src/migration/external-config/convert.ts | 446 | decode | convert via claude-config-decode | same | convert/mcp-hooks/items/converted/none/none/skip-bad/none |
| src/migration/external-config/run.ts | 319 | adapter | run migration | same | run/offer-import/ctx/result/ledger/persist/throttle/none |
| src/migration/external-config/persist.ts | 914 | persist | persistConvertedItems | persist/symlink/fsync tests | persist/merge-json/items/result/settings.json/atomic+fsync/corrupt-refuse/tmp-clean **cohort 914** |
| src/migration/external-config/ledger.ts | 133 | persist | recordDisposition | **gap vs import-log hellgate** | throttle-ledger/disposition/home+key/bool/json/wx-lock/EEXIST-skip/no-stale-reclaim **F-03** |

## Mirrored tests (F SUT)

Primary trees: `tests/unit/auth*`, `tests/unit/security/**`, `tests/unit/permission/**`, `tests/unit/capability/**`, `tests/unit/*knob*`, `tests/unit/*config*`, `tests/unit/*migration*`, colocated `__tests__` above, plus root hellgates whose SUT is F (`json-state-file-lock-clock`, `sensitivity-classifier`, `knob-read-authority-parity`, `redaction-parity`, `fail-closed-base`, import-log fsync/stale-lock).

Root tests whose SUT is **not** F (bash/pty/node-repl redaction consumers, host mcp-composition, llm chatgpt adapter) are evidence only.

## Union proof (lane-local)

F exclusive production paths are exactly the 161 files tabulated. They do not include `src/shared/**`. Intersection with other W1 lanes is empty by path prefix. W0 must still prove global union; this receipt only owns prefixes `src/auth|security|permission|config|capability|migration`.

DONE
