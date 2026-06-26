/**
 * Second half of the `RuntimeConfig` typed surface — launcher/path/bench/cloud
 * fields — split out of `./types` so neither file exceeds the god-module
 * threshold (the interface alone was ~1150 lines). `RuntimeConfig` in `./types`
 * `extends RuntimeConfigPaths`, so the public shape is UNCHANGED (one structural
 * interface). The `#24` doc↔resolver drift hellgate reads BOTH `./types` and
 * this file for the per-field JSDoc corpus.
 */

import type { StatusLineConfig, SwebenchCacheLevel } from "./parsers"

/** Launcher / paths / bench / cloud-credential half of {@link RuntimeConfig}.
 *  Merged into `RuntimeConfig` via `extends` — never consumed standalone. */
export interface RuntimeConfigPaths {
  /** Git SHA stamp for trajectory `producer.gitSha`. Set by the launcher
   *  (CI, dev script). Absent ⇒ field omitted from trajectory events. */
  readonly gitSha: string | undefined
  /** Trajectory pricing version override — pinned by op for reproducibility. */
  readonly pricingVersion: string | undefined
  /** Sessions root override (`QUANTA_SESSIONS_DIR`). Absent ⇒ session/paths
   *  computes `~/.quanta/sessions`. */
  readonly sessionsDir: string | undefined
  /** Per-session transcript retention cap in cumulative utf-8 BYTES
   *  (`QUANTA_SESSION_TRANSCRIPT_MAX_BYTES`). Feeds the host-layer transcript
   *  sweep (`@/apps/cli/session-transcript-retention`) which applies the
   *  `@/stream` `applyRetention` sliding window to each `<id>.jsonl` envelope
   *  under `sessionsRoot()`.
   *
   *  Default ABSENT ⇒ retention is OFF (unbounded — today's behavior). This is
   *  the SAFE default: the sweep is a no-op until an operator opts in, and even
   *  when ON it NEVER deletes a whole session — it only trims the OLDEST rows of
   *  a single transcript once that transcript alone crosses the cap, keeping the
   *  newest events. So recent/active sessions are inherently preserved. */
  readonly sessionTranscriptMaxBytes: number | undefined
  /** HITL overrides JSON path (`QUANTA_HITL_OVERRIDES`). Absent ⇒
   *  `agent/hitl-tier-registry` defaults to `~/.quanta/hitl-overrides.json`. */
  readonly hitlOverridesPath: string | undefined
  /** Tool output cap (`QUANTA_TOOL_OUTPUT_MAX`). Absent ⇒ default in
   *  `tool/output-spill.ts`. */
  readonly toolOutputMaxChars: number | undefined
  /** Tool spill retention (`QUANTA_TOOL_OUTPUT_SPILL_KEEP`). Absent ⇒ default. */
  readonly toolOutputSpillKeep: number | undefined
  /** LLM stream first-chunk timeout in ms (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS`).
   *  Absent ⇒ adapter default (60_000 ms). Read ONCE at adapter construction;
   *  T1 hang-stream guard. Reasoning models (o1/o3/gpt-5) can take 30s+ to
   *  first token, so default is generous. */
  readonly llmStreamFirstChunkMs: number | undefined
  /** LLM stream inter-chunk idle timeout in ms (`QUANTA_LLM_STREAM_IDLE_MS`).
   *  Absent ⇒ adapter default (120_000 ms). Read ONCE at adapter
   *  construction; T1 hang-stream guard. Long completions are OK. */
  readonly llmStreamIdleMs: number | undefined
  /** Consecutive content-less-stream circuit-breaker cap
   *  (`QUANTA_LLM_EMPTY_STREAM_BREAKER_K`). After this many CONSECUTIVE streams
   *  that yield ZERO content events (only telemetry such as `llm_continuation`)
   *  — or that throw the idle-timeout having produced no content — the breaker
   *  throws a TERMINAL non-retryable error instead of letting the transient-
   *  retry path burn the full idle window over and over (jun-26 RCA, cassette
   *  /tmp/g55-traj.jsonl). Absent ⇒ default
   *  (`DEFAULT_EMPTY_STREAM_BREAKER_K` = 2). */
  readonly llmEmptyStreamBreakerK: number | undefined
  /** Per-LLM-stream PROGRESS HEARTBEAT interval in ms
   *  (`QUANTA_LLM_STREAM_TRACE_MS`). The bench `run.log` only gets a line when a
   *  TOOL ACTION completes, so a turn stalled INSIDE the LLM stream is invisible.
   *  The stream-progress trace emits a periodic heartbeat during stream
   *  consumption (idle climbing, content frozen) plus a one-line summary, so a
   *  stall is VISIBLE. Telemetry ONLY — byte-identical event passthrough — so it
   *  is safe DEFAULT-ON. `0` ⇒ DISABLED; absent ⇒ default
   *  (`DEFAULT_STREAM_TRACE_INTERVAL_MS` = 10_000). */
  readonly llmStreamTraceMs: number | undefined
  /** Quanta home dir override (`QUANTA_HOME`). Absent ⇒ feature sites compute
   *  `~/.quanta`. Used by ADR-0046 permission-store path resolution. */
  readonly quantaHome: string | undefined
  /** Bench artifacts root override (`QUANTA_BENCH_HOME`). Absent ⇒ bench
   *  computes a PERSISTENT default (never tmp): `<quantaHome>/bench`, else
   *  macOS `~/Library/quanta-codeagent-v3/bench`, else `~/.quanta/bench`. */
  readonly benchHome: string | undefined
  /** Bench report mirror directory override (`QUANTA_BENCH_RESULTS_DIR`).
   *  Absent ⇒ `quantaHomePath("bench", "results")`; `off`/`0` disables the
   *  canonical mirror. */
  readonly benchResultsDir: string | undefined
  /** Extra cache directory names appended to the audited
   *  `DEFAULT_CACHE_DIR_NAMES` SSOT in `apps/bench/cache-pathspecs.ts`.
   *  `QUANTA_BENCH_CACHE_PATHSPECS_EXTRA` is a `,`/`:`/`;`/newline-separated
   *  list — merge semantics (NOT replace), so adding `target` (Rust) does
   *  not silently drop `__pycache__` (Python). Empty ⇒ defaults only. */
  readonly cachePathspecsExtra: readonly string[]
  /** Extra literal command prefixes appended to the audited env-regime
   *  detection set in `agent/dispatch-dedup.ts#DEFAULT_ENV_PREFIXES`.
   *  `QUANTA_DEDUP_ENV_PREFIXES_EXTRA` is a delimiter-separated list of
   *  LITERAL first-token names (e.g. `uv,poetry,cargo`). Operator merge
   *  semantics — defaults intact. Used to keep the dedup gate's env brake
   *  current with new package managers without code edits. */
  readonly dedupEnvPrefixesExtra: readonly string[]
  /** Permission state-file override (`QUANTA_PERMISSION_STATE`). Absent ⇒
   *  feature site computes `<quantaHome>/permission-state.json`. */
  readonly permissionStateFile: string | undefined
  /** User-defined permission-profile directory (`QUANTA_PROFILES_DIR`,
   *  ADR-0434). Absent ⇒ `listPermissionProfiles`/`selectPermissionProfile`
   *  return only the 3 built-ins (default-OFF, no disk IO). */
  readonly profilesDir: string | undefined
  /** SSH connection marker (`SSH_CONNECTION`). Used by ADR-0046's
   *  `resolveHostId()` to decide between `<user>@<host>` and `localhost`. */
  readonly sshConnection: string | undefined
  /** SWE-bench Docker image cache level (`QUANTA_SWEBENCH_CACHE_LEVEL`).
   *  Default `env` (upstream default) — keeps base+env images warm so a batch
   *  doesn't rebuild the expensive per-repo conda env per instance. */
  readonly swebenchCacheLevel: SwebenchCacheLevel
  /** SWE-bench `--clean` flag (`QUANTA_SWEBENCH_CLEAN`). Default false — keep
   *  images at/under cacheLevel between runs (warm pool). */
  readonly swebenchClean: boolean
  /** SWE-bench grading parallelism (`QUANTA_SWEBENCH_MAX_WORKERS`). Absent ⇒
   *  the harness config computes `min(4, ceil(cpus * 0.75))`. */
  readonly swebenchMaxWorkers: number | undefined
  /** SWE-bench image namespace (`QUANTA_SWEBENCH_NAMESPACE`). Absent ⇒ the
   *  harness config picks by arch ("none" ⇒ build locally; avoids x86 pulls
   *  that would emulate on arm64). */
  readonly swebenchNamespace: string | undefined
  /** SWE-bench source repo bare-mirror cache override
   *  (`QUANTA_SWEBENCH_REPO_CACHE`). Absent ⇒ `<quantaHome>/bench/repo-cache`. */
  readonly swebenchRepoCacheDir: string | undefined
  /** SWE-bench `--force_rebuild` (`QUANTA_SWEBENCH_FORCE_REBUILD`). Default
   *  false — reuse cached images unless explicitly invalidated. */
  readonly swebenchForceRebuild: boolean
  /** Explicit Python interpreter for the SWE-bench harness
   *  (`QUANTA_SWEBENCH_PYTHON_BIN`). Absent ⇒ python-swebench.ts probes
   *  `python` then `python3`. Useful on hosts whose `python3` is too old
   *  for the harness (the package uses PEP 604 `list | None`, needs 3.10+);
   *  set to e.g. `python3.11` or an absolute path to override the probe. */
  readonly swebenchPythonBin: string | undefined
  /** Per-instance wall-clock budget for the bench runner (`QUANTA_BENCH_TIMEOUT_MS`).
   *  Absent ⇒ batch mode default (120_000ms). Surface for `apps/agent/
   *  mode-presets/batch.ts` (RFC may-22 Phase 4). */
  readonly benchTimeoutMs: number | undefined
  /** Max turns per instance for the bench runner (`QUANTA_MAX_TURNS`).
   *  Absent ⇒ batch mode default from BUDGET_PRESETS.batch. */
  readonly maxTurnsBatch: number | undefined
  /** Readiness-probe budget (ms) for the LSP warm/strict-ready proof
   *  (`QUANTA_LSP_READY_TIMEOUT_MS`). The wall-clock cap `ensurePyrightFileReady`
   *  polls `definition` against before declaring `ready_timeout`. Absent ⇒ the
   *  hardcoded default (90_000). ONLY consumed on the LSP grounding/ready path,
   *  so raising it costs nothing when LSP is not used. Raise per-run to test
   *  whether slow-but-resolvable repos (large codebases) are being false-timed-
   *  out — verify with `tools/dev/lsp-grounding-summary.ts` before changing the
   *  default (jun-23 LSP-03: no budget change without receipt evidence). */
  readonly lspReadyTimeoutMs: number | undefined
  /** Extra full-remote box relaunches on an empty result
   *  (`QUANTA_BENCH_FULL_REMOTE_RELAUNCH`). A spot reclaim / ssh-255 drop loses
   *  the whole run; default 1 ⇒ up to 2 attempts. `--keep` forces 0 (a kept box
   *  isn't auto-terminated, so relaunching would orphan it). */
  readonly fullRemoteRelaunch: number
  /** Force `--prepare-images` to attempt the local build even on arm64
   *  (`QUANTA_SWEBENCH_PREPARE_FORCE`). Default false — arm64 skips prepare
   *  (conda crashes under x86 emulation; the eval path pulls prebuilt). */
  readonly swebenchPrepareForce: boolean
  /** Pinned run id (`QUANTA_RUN_ID`). Set ONCE by the bench launcher so
   *  observe + predictions + report all group under the same persistent
   *  `runs/<runId>/` dir (no per-call `Date.now()` drift). Absent ⇒
   *  `apps/bench/paths.ts#benchRunId` mints a `run-<Date.now()>` id. */
  readonly runId: string | undefined
  /** Preferences home override (`QUANTA_PREFS_HOME`). Absent ⇒ slash-command
   *  prefs/usage paths fall back to `os.homedir()`. */
  readonly prefsHome: string | undefined
  /** Last-reported token count (`QUANTA_LAST_TOKENS`). Surfaced by the
   *  `/context` slash command. Absent ⇒ the command omits the line. */
  readonly lastTokens: string | undefined
  /** `quanta session list` default format pin (`QUANTA_SESSION_LIST_FORMAT`).
   *  `plain` keeps the byte-identical legacy table (back-compat + pipelines);
   *  `rich` opts into the Codex-inspired TUI on a real TTY. Absent ⇒ the CLI
   *  surface picks `rich` when `process.stdout.isTTY`, else `plain`. */
  readonly sessionListFormat: "rich" | "plain" | undefined
  /** `quanta session list` default cap (`QUANTA_SESSION_LIST_MAX`). Applies
   *  only to the rich format (plain stays uncapped). Absent ⇒ the dispatcher
   *  defaults to 10. */
  readonly sessionListMax: number | undefined
  /** S5 hook hardening — per-handler timeout in ms (`QUANTA_HOOK_TIMEOUT_MS`).
   *  Absent ⇒ `hooks.ts` `DEFAULT_HOOK_TIMEOUT_MS` (5000). A timed-out handler
   *  logs a warning and the bus continues to the next handler. A
   *  per-registration override (`HookOnOptions.timeoutMs`) WINS over this
   *  default — the env knob is the operator-side floor for hosts that did not
   *  specify a per-hook timeout. */
  readonly hookTimeoutMs: number | undefined
  /** S5 hook hardening — max handlers per event (`QUANTA_HOOK_MAX_HANDLERS`).
   *  Absent ⇒ `hooks.ts` `MAX_HANDLERS_PER_EVENT` (64). Registering above the
   *  cap throws `HookRegistrationError` (load-bearing — surfaces a host
   *  misconfiguration loudly rather than silently dropping handlers). */
  readonly hookMaxHandlers: number | undefined
  /** S5 hook hardening — max emit payload size in BYTES
   *  (`QUANTA_HOOK_MAX_PAYLOAD_BYTES`). Absent ⇒ `hooks.ts`
   *  `MAX_PAYLOAD_BYTES` (1_048_576 = 1MB). Oversize payloads are TRUNCATED
   *  with a stable marker (graceful degradation — the dispatch still fires
   *  so a host that watches a hook never observes a missed event from a
   *  pathological argument). */
  readonly hookMaxPayloadBytes: number | undefined
  /** ADR-0287 async-tool kind activation (`QUANTA_ASYNC_TOOLS=1|on|true`).
   *  Default false — opt-in. When true the composition root constructs the
   *  `DefaultDeferredResultRegistry` and wires `poll_deferred` + every
   *  `defineToolAsync` instance to it; when false those tools degrade to
   *  synchronous execution (byte-identical to the pre-ADR path). */
  readonly asyncTools: boolean
  /** ADR-0286 deferred-result registry max live handles
   *  (`QUANTA_DEFERRED_CAP`). Absent ⇒ `DEFAULT_DEFERRED_CAP` (1000). LRU
   *  eviction; pending/running entries are never evicted (see
   *  `default-registry.ts` invariant #3). */
  readonly deferredCap: number | undefined
  /** H16 cross-session memory consolidation ("auto-dream") gate
   *  (`QUANTA_AUTO_DREAM`). Default false ⇒ the cross-session dream trigger
   *  is NOT constructed: its persisted counter never advances, no state is
   *  read/written, and the consolidate pass never fires from elapsed
   *  sessions/hours (byte-identical to the pre-H16 path). The composition
   *  root builds + wires `CrossSessionDreamTrigger` with a `DreamPolicy` ONLY
   *  when this is on. */
  readonly autoDream: boolean
  /** H16 sessions-since-last-dream threshold (`QUANTA_AUTO_DREAM_SESSIONS`).
   *  Absent ⇒ `DEFAULT_DREAM_POLICY.sessionsThreshold` (5). Drives the OR
   *  semantics — a dream fires after this many session-ends OR after the
   *  hours threshold, whichever crosses first. Positive integer; invalid ⇒
   *  fall back to default. Only consulted when `autoDream` is on. */
  readonly autoDreamSessions: number | undefined
  /** H16 hours-since-last-dream threshold (`QUANTA_AUTO_DREAM_HOURS`).
   *  Absent ⇒ `DEFAULT_DREAM_POLICY.hoursThreshold` (24). Positive number
   *  (fractional allowed, e.g. `0.5` for a 30-minute cadence in tests);
   *  invalid ⇒ fall back to default. Only consulted when `autoDream` is on. */
  readonly autoDreamHours: number | undefined
  /** R4 audit-H — disable the logger label-keyed leaky-bucket rate limiter
   *  (`QUANTA_LOG_RATE_LIMIT=off`). Default false (rate limit ON). Set to
   *  `off` to restore unbounded `logger.{info,warn,error,debug}` semantics —
   *  useful during incident triage where suppressing same-label spam would
   *  hide a forensic signal. The default-ON posture closes the audit-H DoS
   *  surface where a hostile catch in a hot loop could emit millions of
   *  `logger.warn` lines and stall stderr backpressure. */
  readonly logRateLimitDisabled: boolean
  /** H7 rotating cloud credentials — apiKeyHelper shell command
   *  (`QUANTA_API_KEY_HELPER`). Absent ⇒ no helper is wired; the credential
   *  source's `mintApiKey()` is a no-op (byte-identical to BYOK/env-key today).
   *  When set, the composition root builds a trust-gated `CredentialSource` that
   *  runs this command to mint an API key, TTL-cached. Mirrors Claude Code's
   *  `apiKeyHelper`. SENSITIVE — arbitrary command execution; the source gates
   *  it behind the workspace trust check before ever shelling out. */
  readonly apiKeyHelper: string | undefined
  /** H7 — apiKeyHelper / refresh TTL in ms (`QUANTA_API_KEY_HELPER_TTL_MS`).
   *  Absent ⇒ `credential-helper.ts` `DEFAULT_HELPER_TTL_MS` (5 min, mirroring
   *  Claude's `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). Bounds both the minted-key
   *  cache window AND the pre-call cloud-refresh throttle. */
  readonly apiKeyHelperTtlMs: number | undefined
  /** H7 — AWS pre-call refresh command (`QUANTA_AWS_AUTH_REFRESH`). Absent ⇒ the
   *  Bedrock adapter does NOT run a pre-call refresh (byte-identical SDK default
   *  chain). When set, `refreshCloudCreds("aws")` runs this command (e.g.
   *  `aws sso login`) before each Bedrock call, TTL-throttled. SENSITIVE —
   *  trust-gated. */
  readonly awsAuthRefresh: string | undefined
  /** H7 — GCP pre-call refresh command (`QUANTA_GCP_AUTH_REFRESH`). Absent ⇒ the
   *  Vertex adapter does NOT run a pre-call refresh (byte-identical ADC path).
   *  When set, `refreshCloudCreds("gcp")` runs this command (e.g.
   *  `gcloud auth application-default login`) before each Vertex call,
   *  TTL-throttled. SENSITIVE — trust-gated. */
  readonly gcpAuthRefresh: string | undefined
  /** H7 / ADR-0139 — EXPLICIT cloud-transport selection for the MAIN agent LLM
   *  (`QUANTA_LLM_TRANSPORT`). Empty/absent ⇒ the surface falls through to the
   *  registry env precedence ladder (`ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL`
   *  / `ANTHROPIC_FOUNDRY_RESOURCE` / `QUANTA_USE_FOUNDRY`). Set to
   *  `default` | `bedrock` | `vertex` | `foundry` | `mantle` to route the main
   *  agent LLM through `createMulticloudLLM` (the H7 rotating-credential path).
   *  Default-OFF: unset AND no cloud env signal ⇒ the legacy `createLLM` path
   *  builds the four vendor providers BYTE-IDENTICALLY. This is the END-USER
   *  selection knob that was previously missing — it makes the proven multicloud
   *  + rotation seam reachable by config rather than only by an explicit
   *  `buildMulticloudLLMCore` call. */
  readonly llmTransport: string | undefined
  /** H7 — explicit workspace-trust attestation for the credential-helper shell
   *  (`QUANTA_LLM_CREDENTIAL_TRUSTED`). A credential helper / `*AuthRefresh` is
   *  ARBITRARY COMMAND EXECUTION, so the composition root's `isTrusted` predicate
   *  FAILS CLOSED: only the literal `1` here authorizes the shell to run. Unset /
   *  any other value ⇒ the source surfaces a typed `untrusted` decline and NEVER
   *  shells out (mirrors Claude Code's explicit-trust posture for `apiKeyHelper`).
   *  Default-OFF and orthogonal to the four H7 command knobs — setting a refresh
   *  command WITHOUT this attestation is a fail-closed no-run, not a silent run. */
  readonly llmCredentialTrusted: boolean
  /** Prompt-cache TTL selector (`QUANTA_PROMPT_CACHE_TTL`). `"5m"` (default) or
   *  `"1h"`. Only the literal `"1h"` opts into the extended cache-control TTL;
   *  any other value (including absent) ⇒ `"5m"`, byte-identical to the prior
   *  fixed-5m cache_control. The factory further gates `"1h"` behind an
   *  allowlist of models that actually support it (`resolveCacheTtl`), so even
   *  ON it is a no-op for non-allowlisted models. */
  readonly cacheTtl: "5m" | "1h"
  /** OAuth token revoke-on-logout gate (`QUANTA_OAUTH_REVOKE_ON_LOGOUT`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ logout only clears local credential
   *  state (byte-identical). When true, the logout command additionally calls
   *  the provider's RFC 7009 token revocation endpoint before clearing. */
  readonly oauthRevokeOnLogout: boolean
  /** jun-6 (ADR-0481) cell-aware `.ipynb` render — append textual outputs
   *  (`QUANTA_IPYNB_OUTPUTS`). DEFAULT **ON** (the ONLY knob in this codebase
   *  that is default-true, justified: a `.ipynb` read is BROKEN today — it dumps
   *  raw nbformat JSON with base64 image blobs — so the safe default is the
   *  fixed render, not the broken one; matches Claude/Cursor/Codex). This knob
   *  ONLY toggles whether each code cell's TEXTUAL outputs (stream / text-plain /
   *  error traceback) are appended after its source. Set to `off`/`0`/`false`
   *  to render cell SOURCE only. Two things are UNCONDITIONAL (never a knob):
   *  (1) cell-source rendering for any `.ipynb`, and (2) base64 image-blob
   *  stripping (emitting a base64 PNG is never wanted). Has ZERO effect on any
   *  non-`.ipynb` read — the extension gate short-circuits, so every other file
   *  is byte-identical to the pre-ADR raw render. */
  readonly ipynbIncludeOutputs: boolean
  /** jun-6 (RFC jun-6-byok-api-key-helper) — legacy per-vendor apiKeyHelper
   *  resolution gate (`QUANTA_API_KEY_HELPER_LEGACY_VENDOR`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ the legacy LLM-build seam passes
   *  `source: undefined` to `resolveVendorApiKey`, so key resolution is
   *  byte-identical to the pre-slice BYOK/env path. When ON, the composition
   *  root resolves the per-vendor key through the apiKeyHelper credential
   *  source before building the provider. */
  readonly apiKeyHelperLegacyVendor: boolean
  /** jun-6 (RFC jun-6-ai-session-title) — AI session auto-title gate
   *  (`QUANTA_SESSION_AUTO_TITLE`). Standard boolean knob vocabulary
   *  (`1`/`true`/`on`). Default false ⇒ the composition root builds NO
   *  `autoTitlePort` and the loop's first-turn title branch is dead
   *  (byte-identical). When ON *and* `sessionTitleModel` resolves a cheap
   *  `LLMPort`, the loop fire-and-forgets a ≤6-word title for the first user
   *  prompt (never awaited, never clobbers a human rename). */
  readonly sessionAutoTitle: boolean
  /** jun-6 — cheap model id for the auto-title call (`QUANTA_SESSION_TITLE_MODEL`,
   *  mirrors `QUANTA_COMPACT_MODEL`). Absent ⇒ no port is built even when
   *  `sessionAutoTitle` is on (both must be present — advertise-iff-able). */
  readonly sessionTitleModel: string | undefined
  /** jun-6 (RFC jun-6-tool-interrupt-behavior) — `block`-interrupt critical-
   *  section gate (`QUANTA_TOOL_INTERRUPT_BLOCK`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24).
   *  Default false ⇒ the dispatch seam threads the raw `config.signal` and NO
   *  `criticalSection` onto `ToolContext` (byte-identical: a `block` tool
   *  behaves exactly like `cancel`). When ON, a tool whose
   *  `interruptBehavior() === "block"` runs over a derived suppressible signal so
   *  its atomic FS-write window (rename/flush) finishes whole before a withheld
   *  ESC is delivered — bounded by {@link criticalSectionMaxMs}. */
  readonly toolInterruptBlock: boolean
  /** jun-6 — watchdog cap (ms) bounding how long a critical section may withhold
   *  an in-flight abort before it is force-delivered
   *  (`QUANTA_CRITICAL_SECTION_MAX_MS`). Absent ⇒ {@link DEFAULT_CRITICAL_SECTION_MAX_MS}
   *  (5000). The critical-section slice (`@/tool/critical-section`) takes this by
   *  injection; there is NO magic constant inside it, so the default lives here.
   *  5s is generous for a single rename/flush yet guarantees `block` can DEFER a
   *  cancel across one bounded window, never SWALLOW it. */
  readonly criticalSectionMaxMs: number
  /** jun-6 (RFC jun-6-permission-request-hook) — `permission_request` hook
   *  kill-switch (`QUANTA_PERMISSION_HOOK`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default
   *  false ⇒ the admissibility gate does NOT emit the pre-decision
   *  `permission_request` event (byte-identical, the gate falls through to the
   *  policy stack). When ON *and* a `HookBus` is wired, the gate emits the event
   *  before the policy stack and routes the verdict via
   *  `routePermissionHookVerdict` (HARD_DENY floor enforced — a hook `allow`
   *  never overrides the denylist). Extra guard atop hook presence. */
  readonly permissionHook: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (b)) — glob-in-write-path guard gate
   *  (`QUANTA_GLOB_WRITE_GUARD`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  dispatch seam does NOT set `ToolContext.globWriteGuard`, so `write`/`edit`
   *  accept a glob/wildcard `path` as a literal filename exactly as before
   *  (byte-identical). When ON, a `path` that is a glob pattern (`*`/`?`/`{a,b}`)
   *  is rejected with the verbatim cc-cli message BEFORE any fs call. The RFC
   *  argues this is a strong default-ON candidate after a soak; it ships
   *  default-OFF for byte-identity (mirrors `globWriteGuardEnabled`). */
  readonly globWriteGuard: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (a)) — per-turn write/edit budget gate
   *  (`QUANTA_WRITE_BUDGET`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ no
   *  budget port is constructed and `ToolContext.writeBudget` is absent, so
   *  `write`/`edit` proceed byte-identically (no counter). The budget ALSO
   *  requires a configured cap ({@link writeBudgetMax}) — both must be present
   *  for any side effect (advertise-iff-able) — and only fires in an
   *  untrusted-input turn (the §3.5 untrusted-envelope signal). */
  readonly writeBudget: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (a)) — per-turn write/edit cap N
   *  (`QUANTA_WRITE_BUDGET_MAX`, a positive integer). This is the CONFIGURABLE
   *  KNOB value — there is NO hardcoded default (no-heuristics rule: the cap MUST
   *  be calibrated from a real-turn write-count corpus, not guessed). Absent /
   *  invalid ⇒ `undefined` ⇒ the budget stays INERT even when {@link writeBudget}
   *  is on, so the path is byte-identical until an operator sets a cap. */
  readonly writeBudgetMax: number | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (c)) — exfil-scouting gate
   *  (`QUANTA_EXFIL_SCOUTING`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  deterministic `detectScouting` aggregate over the proxy deny-log is never
   *  called and the "Exfil Scouting" taxonomy prose line is OMITTED from the
   *  assembled classifier prompt (byte-identical prompt + behavior). When ON the
   *  detector emits an ADVISORY signal (a classification hint, never a hard
   *  auto-deny — RFC §7 (c)) for ≥ K distinct denied non-allowlisted hosts. */
  readonly exfilScouting: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (c)) — exfil-scouting threshold K
   *  (`QUANTA_EXFIL_SCOUTING_K`, a positive integer). The CONFIGURABLE KNOB —
   *  NO hardcoded default (no-heuristics rule: K must be calibrated from a real
   *  probe-burst corpus, not guessed). Absent / invalid ⇒ `undefined` ⇒ the
   *  detector stays INERT even when {@link exfilScouting} is on, so the path is
   *  byte-identical until an operator sets a threshold. */
  readonly exfilScoutingK: number | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (B)) — secret-aware egress MODE
   *  (`QUANTA_SECRET_EGRESS` = `deny` | `redact`). Any other value (unset, "1",
   *  "true") ⇒ `undefined` (OFF) ⇒ the egress decision is HOST-ONLY (no
   *  body/header scan), byte-identical. When set, the proxy injects the existing
   *  `compositeSecretScanner` into the PLAINTEXT-HTTP request path and
   *  denies/redacts a leaving declared/detected secret. ⚠️ HTTPS CONNECT tunnels
   *  are OPAQUE (raw TLS) and are NEVER content-scanned — they log a visible
   *  `connect-tunnel-unscanned` marker; full coverage needs TLS MITM, a deferred
   *  Phase-2 RFC. `redact` is the recommended mode (RFC §7 (B)). */
  readonly secretEgress: "deny" | "redact" | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (B)) — max buffered-body byte cap for
   *  the secret-egress scan (`QUANTA_SECRET_EGRESS_MAX_BODY`, a positive
   *  integer). DoS guard: a body past the cap is forwarded UNSCANNED with a
   *  visible `body-cap-unscanned` log marker (never blocked-by-truncation). NO
   *  hardcoded default (no-heuristics rule); absent / invalid ⇒ `undefined` ⇒
   *  the wire treats secret-egress as INERT (a scan with no byte budget is not
   *  advertised) until an operator sets the cap. */
  readonly secretEgressMaxBody: number | undefined
  /** jun-7 TLS-MITM (Phase-2 of exfil-rail (B)) — whether the operator has
   *  EXPLICITLY opted into terminating + scanning HTTPS CONNECT traffic. STRONGER
   *  gate than the other knobs (MITM mints a trust anchor the agent's client
   *  accepts): requires BOTH `QUANTA_TLS_MITM=1` AND the verbatim ack phrase in
   *  `QUANTA_TLS_MITM_ACK`. Either missing ⇒ `false` ⇒ the CONNECT path stays a
   *  raw tunnel + `connect-tunnel-unscanned` marker (byte-identical). The
   *  composition root only constructs an ephemeral MITM CA when this is `true`
   *  AND `secretEgress` is set (nothing to scan otherwise). */
  readonly tlsMitm: boolean
  /** jun-7 TLS-MITM — fail-closed policy on a termination/scan error
   *  (`QUANTA_TLS_MITM_ON_FAILURE` = `deny` | `opaque-tunnel`). `deny`
   *  (recommended) hard-blocks an un-scannable host; `opaque-tunnel` falls back
   *  to the raw tunnel + a VISIBLE `connect-tunnel-unscanned` marker. Any other
   *  value ⇒ `deny` (fail closed by default). Inert unless {@link tlsMitm}. */
  readonly tlsMitmOnFailure: "deny" | "opaque-tunnel"
  /** jun-7-misc 02 (manifest codex-compat) — read-only codex-shape manifest
   *  ingest normalizer gate (`QUANTA_MANIFEST_COMPAT`). Strict opt-in
   *  (`=== "1"`). SECURITY-relevant: it LOOSENS manifest validation (accepts a
   *  foreign/codex-shaped manifest by coercing its shape on ingest), so an
   *  accidental loose-truthy enable must NOT arm it — strict `=1` only. Default
   *  false ⇒ the loader rejects non-quanta manifests exactly as today
   *  (byte-identical validation). The normalizer never widens a grant; it only
   *  renames/coerces SHAPE on read. */
  readonly manifestCompat: boolean
  /** jun-7-misc 03 (guardian per-action assessor) — per-action LLM risk
   *  assessor gate (`QUANTA_GUARDIAN_ASSESSOR`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ no guardian assessor is constructed, the admissibility gate
   *  consults no per-action LLM risk pass, and tool dispatch is byte-identical.
   *  When ON *and* a judge LLM + the guardian wiring are assembled at the
   *  composition root, a candidate action may be routed through the assessor for
   *  an advisory risk signal (it NEVER auto-grants — it can only add caution /
   *  route to HITL, never widen a grant). */
  readonly guardianAssessor: boolean
  /** T03 (jun-13 codex-ide, feature 03-guardian) — auto-approval reviewer gate
   *  (`QUANTA_AUTO_REVIEW`). Strict opt-in (`=== "1"`): a feature that lets an
   *  LLM side-agent AUTO-APPROVE tool calls without a human must NEVER be armed by
   *  a stray loose-truthy spelling. Default false ⇒ the reviewer stays `user` (or
   *  the legacy posture-gated selection) and the approval path is byte-identical.
   *  When ON, `selectDefaultReviewer` routes approvals to the side-agent guardian
   *  (the `guardian-approvals` ladder rung) — HARD_DENY still runs BEFORE it.
   *
   *  NOTE — needs an APPROVAL to gate: the guardian only runs when the gate would
   *  otherwise prompt (mode `default`, the interactive default). In `acceptEdits`/
   *  `bypass` the gate auto-allows mutations BEFORE any reviewer, so this knob has
   *  no effect there (no silent escalation — those modes are already a deliberate
   *  "don't review" choice). */
  readonly autoReview: boolean
  /** T03 — named approval-ladder posture (`QUANTA_APPROVAL_LADDER`): one of
   *  `read-only | auto | granular | guardian-approvals | full-access` (the
   *  `@/permission/approval-ladder` SSOT). Unset / unknown / `custom` ⇒ no rung
   *  seeded ⇒ byte-identical. A valid rung seeds the session thread's
   *  `ThreadPermission` (sandbox + approvalPolicy + reviewer). NEVER defaults to a
   *  guardian/full posture — absent the env var, no posture is selected. */
  readonly approvalLadder: string | undefined
  /** jun-7-misc 04 (auto-mode rule overlay) — user-authored rule overlay onto
   *  the auto-mode classifier system prompt (`QUANTA_AUTO_MODE_RULES`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ `evaluateAuto` flows the exact current
   *  `CLASSIFIER_SYSTEM_PROMPT` (or scout-overlaid prompt) unchanged
   *  (byte-identical classification). When ON, `withUserRuleOverlay` splices the
   *  operator's rule text into the classifier prompt. */
  readonly autoModeRules: boolean
  /** jun-7-misc 04 (auto-mode circumvention detect) — denied-effect re-attempt
   *  tracker gate (`QUANTA_CIRCUMVENT_DETECT`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ no `CircumventionTracker` is constructed, zero effect
   *  signatures are recorded, and the auto-mode gate is byte-identical. When ON,
   *  a sibling tracker records a denied action's effect-signature so a
   *  semantically-equivalent retry via a DIFFERENT tool surfaces an advisory
   *  circumvention signal (never an auto-deny — advisory only). */
  readonly circumventDetect: boolean
  /** §20.4 (ticket-12) — HARD-enforce subagent `ownedSurfaces`/`forbiddenSurfaces`
   *  at the dispatch FS-write seam (`QUANTA_FS_OWNERSHIP_ENFORCE`). Strict opt-in
   *  (`=== "1"`). OFF ⇒ those surfaces stay advisory seed-prompt guidance only
   *  (byte-identical legacy). */
  readonly fsOwnershipEnforce: boolean
  /** jun-7-misc 05 (central-config trust) — repo-local central config loader
   *  gate (`QUANTA_CENTRAL_CONFIG`). Strict opt-in (`=== "1"`). SECURITY:
   *  reading a repo-local config file is RCE-adjacent (a hostile repo could plant
   *  config that steers tool behavior), so it must be a deliberate `=1` opt-in.
   *  Default false ⇒ NO repo-local config file is discovered, read, or merged
   *  (byte-identical startup). When ON, the config lane's disk loader (wired
   *  LATER — only the gate field lives here) reads + merges a trust-gated
   *  repo-local central config. */
  readonly centralConfig: boolean
  /** jun-7-misc 06 (model-based fast-apply) — model-apply MERGE rung gate
   *  (`QUANTA_FAST_APPLY_MERGE`). Strict opt-in (`=== "1"`). DISTINCT from the
   *  existing `QUANTA_FAST_APPLY` (the V4A re-emit rung, gated in
   *  `agent/optional-ports.ts`) — this knob adds a NEW optional model-apply rung.
   *  Default false ⇒ no `FastApplyPort` (merge) is constructed, `ctx.fastApplyMerge`
   *  is undefined, and the edit fallback ladder is the byte-identical
   *  `exact → fuzzy → V4A re-emit` with ZERO apply-model dispatches. Requires BOTH
   *  this gate AND a configured {@link fastApplyModel} for any provider call
   *  (advertise-iff-able). */
  readonly fastApplyMerge: boolean
  /** jun-26 edit-escalate (frontier-parity, `QUANTA_EDIT_AUTO_FUZZY`). Strict
   *  opt-in (`=== "1"`). When true the dispatch seam threads
   *  `ToolContext.autoEscalateFuzzy = true`, so the `edit` tool runs the
   *  whitespace-tolerant fuzzy ladder on an exact MISS even without an explicit
   *  `fuzzy:true` (Claude Code / Codex both auto-retry whitespace-tolerant). The
   *  ladder is fail-closed (ambiguous / no-confident ⇒ ok:false, never a wrong
   *  write). Default false ⇒ ctx flag absent ⇒ fuzzy runs ONLY on `input.fuzzy`
   *  ⇒ BYTE-IDENTICAL legacy edit path. Reversible + measurable (A/B). */
  readonly editAutoFuzzy: boolean
  /** jun-7-misc 06 — operator-chosen apply-model id for the fast-apply MERGE rung
   *  (`QUANTA_FAST_APPLY_MODEL`, mirrors `QUANTA_COMPACT_MODEL`). Absent ⇒ no
   *  `FastApplyPort` is built even when {@link fastApplyMerge} is on (both must be
   *  present — advertise-iff-able). NO default model: the apply model is
   *  operator-set (a cheap specialist) and must be measured against the re-emit
   *  baseline, not guessed (`no-heuristics-only-validated`). Never defaults to the
   *  main agent model (that would defeat the cost win). */
  readonly fastApplyModel: string | undefined
  /** jun-7-misc 01 (MCP protocol version) — OPTIONAL max-offered MCP protocol
   *  version override (`QUANTA_MCP_PROTOCOL_MAX`, a protocol-version string).
   *  Absent ⇒ undefined ⇒ negotiation offers the code-side SSOT max version
   *  (the SSOT list lives in `src/mcp`); negotiation is otherwise ALWAYS-ON and
   *  backward-compatible, so there is NO gate. When set, it pins the MAX version
   *  the client/server offers (e.g. to cap at an older spec for a peer that
   *  mis-handles a newer one). An unknown/unsupported value is the mcp lane's
   *  concern to validate against its SSOT; this field only carries the raw
   *  override string. */
  readonly mcpProtocolMax: string | undefined
  /** jun-7-misc 05 (central-config trust) — user-config-dir override for the
   *  `@/config` USER layer (`QUANTA_CONFIG_DIR`, analogous to Claude's
   *  `CLAUDE_CONFIG_DIR`). Absent ⇒ undefined ⇒ the config lane defaults to
   *  `~/.quanta`. PURELY a path string carried for the loader; it has NO effect
   *  unless {@link centralConfig} is on (the loader is never invoked otherwise),
   *  so a set-but-disabled value is byte-identical. */
  readonly centralConfigDir: string | undefined
  /** jun-7-misc 05 (central-config trust) — the `--setting-sources` analogue
   *  (`QUANTA_SETTING_SOURCES`, a comma list subset of
   *  `managed,user,project,local`). Absent ⇒ undefined ⇒ the config lane honors
   *  ALL layers. Carried raw; the `@/config` lane parses + validates it. No
   *  effect unless {@link centralConfig} is on. */
  readonly centralConfigSources: string | undefined
  /** jun-7-misc 05 (central-config trust) — static trusted-path allow-list for
   *  HEADLESS/CI grants (`QUANTA_TRUSTED_PATHS`, a comma/`:`-free path list,
   *  §9 Q3). Absent ⇒ undefined ⇒ NO path is statically trusted (headless ⇒
   *  untrusted, period — the safe default). When set, the config lane
   *  canonicalizes each entry into the trust set. This is the EXPLICIT CI
   *  opt-in; it NEVER auto-trusts cwd. No effect unless {@link centralConfig}
   *  is on. */
  readonly trustedPaths: string | undefined
  /** ticket-15 (§11.7) — scriptable statusLine config (CC `statusLine{}` shape).
   *  DOUBLE-gated default-OFF: `undefined` UNLESS `QUANTA_STATUS_LINE` is on
   *  (gateOn vocab) AND `QUANTA_STATUS_LINE_CONFIG` is a JSON object carrying a
   *  usable `command`. Absent ⇒ the fixed `formatContextUsage` status line is
   *  the only render (byte-identical).
   *  SEAM (validated, not yet composed at the render root): the runner
   *  (`apps/cli/status-command-runner.ts` `runStatusCommand`), the payload
   *  assembler (`buildStatusPayload`), and the palette SSOT (`getColorPalette`)
   *  all exist and are unit-tested (args-based spawn / CC `Status` JSON on stdin /
   *  ANSI-aware first-line truncation), but NO production code reads this field at
   *  the REPL status-render call-site to invoke the command per status tick yet.
   *  Until that auto-render composition lands (a deliberate follow-up), this
   *  field has zero production consumers and statusLineConfig has NO production
   *  render effect — byte-identical even when ON, because the field is unread at
   *  the render root. Intended end state: when ON the CLI REPL runs the
   *  operator-authored command per status tick (args-based spawn, NO shell, CC
   *  `Status` JSON on stdin) and renders its first stdout line in place of the
   *  fixed line. */
  readonly statusLineConfig: StatusLineConfig | undefined
}
