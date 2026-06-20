/**
 * Reusable EC2 box session for full-remote bench runs (jun-20 box-lifecycle plan,
 * Phase 1). Extracted from {@link createFullRemoteBackend} so the EXPENSIVE
 * bootstrap surface (launch + cloud-init + rsync + bun install + phantom deps +
 * swebench/uvx warm + pyright nav-grounding) is provisioned ONCE and a persistent
 * pool ({@link ../pool}) can run many chunks on the same box — instead of paying
 * the full boot+sync+install tax on every wave (the old per-wave full-remote did).
 *
 * The split:
 *   - {@link provisionBox}    — launch + bootstrap, returns a live {@link BoxSession}.
 *                               On ANY bootstrap failure it terminates the box and
 *                               rethrows (a half-provisioned box must never linger).
 *   - {@link gradeChunkOnBox} — run ONE patch-gen+grading chunk on an already-
 *                               provisioned session. Owns NO lifecycle: the caller
 *                               (single run or pool) decides when to terminate.
 *                               Box paths are parameterised ({@link ChunkPaths}) so
 *                               a pool can isolate each chunk under its own runId
 *                               dir instead of colliding on the fixed `~/report.json`.
 *
 * ⚠️ SECURITY (unchanged from the origin file): full-remote needs an LLM credential
 * ON the box. Only the SHORT-LIVED access_token is shipped ({@link stripToAccessToken}),
 * over ssh STDIN (never an argv / temp file), and the box enforces IMDSv2 hop-1 +
 * a `shutdown -h` TTL backstop and is ALWAYS terminated. Everything routes through
 * the injected {@link SpawnFn} so the whole flow is unit-testable offline.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { mirrorReportToSsot } from "@/runner/batch/report"
import { errMessage } from "@/shared"
import { loadVerdicts } from "../analyze/verdicts"
import { benchHome } from "../corpus"
import { CURRENT_BENCH_BASE_PRESET, presetRequiresLiveLspGrounding } from "../preset"
import { defaultSpawn, type SpawnFn, type SpawnResult } from "./backend"

/** Durable dir for fetched full-remote artifacts (predictions / report / closure
 *  sidecar / trajectory). NEVER /tmp — the OS reaps it on the next session and
 *  silently destroys the only post-mortem signal (2026-06-19: lost the patches
 *  needed to RCA a grading false-negative). Lives under benchHome() like the
 *  rest of bench's persistent output. */
export const fullRemoteArtifactDir = (): string => {
  const dir = join(benchHome(), "full-remote")
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface FullRemoteConfig {
  /** Local quanta repo to rsync to the box (excludes node_modules/.git). */
  readonly repoDir: string
  /** RAW chatgpt.json content (the caller reads it; we strip it here). */
  readonly authJson: string
  /** Local swebench instances.jsonl. */
  readonly datasetPath: string
  /** Subset to run (default: all rows in the dataset). */
  readonly instanceIds?: readonly string[]
  /** Bench preset. Default current base profile. */
  readonly preset?: string
  /** Model id (predictions/report naming). Default `gpt-5.4`. */
  readonly model?: string
  /** Launch-time metadata tag so operators can distinguish pool/full/warm boxes
   *  even before the box-side runtime snapshot exists. */
  readonly launchMode?: "full-remote" | "pool" | "warm-box"
  readonly dryRun?: boolean
  readonly spawn?: SpawnFn
  /** Progress sink — called at each stage so a long run isn't a silent black box. */
  readonly onLog?: (msg: string) => void
  /** Injectable sleep (test seam — default real setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
  /** Max cloud-init readiness polls (test seam — default 30 × 10s ≈ 5min). */
  readonly maxReadyPolls?: number
  readonly region?: string
  readonly ami?: string
  readonly instanceType?: string
  readonly keyName?: string
  readonly keyPath?: string
  readonly subnetId?: string
  readonly vpcId?: string
  readonly sgName?: string
  readonly diskGb?: number
  readonly ttlMinutes?: number
  readonly keep?: boolean
  /** Launch ON-DEMAND instead of spot. Spot is ~3× cheaper but AWS reclaims it
   *  on capacity pressure — observed in ap-northeast-2 reclaiming c7i boxes in
   *  4–17 min, killing runs faster than relaunch can recover. On-demand has no
   *  reclaim. Default false (spot). */
  readonly onDemand?: boolean
  /** Fail-closed single-box guard: if another quanta-bench box is already
   *  running, callers must opt in before launching a fresh one. */
  readonly allowExtraBoxes?: boolean
  /** Override the local single-box owner guard dir (test seam). */
  readonly singleBoxGuardDir?: string
  /** Override the cross-process patch-gen budget lease dir (test seam). */
  readonly tokenBudgetDir?: string
  /** Max wait for the global patch-gen budget lease. */
  readonly tokenBudgetWaitMs?: number
  /** Poll cadence while waiting for the global patch-gen budget lease. */
  readonly tokenBudgetPollMs?: number
}

export const D = {
  region: "ap-northeast-2",
  // PREBAKED AMI (quanta-bench-easydjango, 2026-06-17): docker + uv + the swebench
  // easy-django eval images already pulled. Skips the cold cloud-init image-pull
  // that dominated bootstrap (the stock ubuntu-22.04 ami-0afe1fd15675c3f15 re-pulled
  // GB of swebench images every launch). userData stays idempotent (re-running
  // present installs is fast; bun is still installed there). Override via cfg.ami.
  ami: "ami-04c2cdd2e17b15779",
  instanceType: "c7i.8xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  diskGb: 600,
  ttlMinutes: 180,
  preset: CURRENT_BENCH_BASE_PRESET,
  model: "gpt-5.4",
} as const

/**
 * Reduce a chatgpt.json to the MINIMUM the box needs: the short-lived
 * `access_token` + non-secret account fields. The long-lived `refresh_token`
 * and `id_token` are dropped so a box compromise can't mint fresh credentials.
 */
/** Placeholder for the long-lived secrets we refuse to ship. The token-store
 *  loader only requires `refresh_token`/`id_token` to be NON-EMPTY strings — it
 *  never uses them for a short run (access_token is valid + never refreshed). */
const REDACTED = "REDACTED-not-shipped-to-remote"

export const stripToAccessToken = (authJson: string): string => {
  const parsed = JSON.parse(authJson) as Record<string, unknown>
  // Fail fast: a token file with no usable access_token would still ship (with
  // REDACTED placeholders) and the box would run 0 turns / empty patch after a
  // full provision cycle — an expensive silent waste. Catch it before launch.
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error(
      "[full-remote] auth json has no usable access_token — cannot run patch-gen on the box " +
        "(re-login locally: `quanta /login`).",
    )
  }
  // Same fail-fast for `expires_at`: the box-side token-store loader
  // (parseTokenRecordObject in token-store.ts) HARD-REQUIRES it as a non-empty
  // string — we ship REDACTED placeholders for refresh_token/id_token but there
  // is NO placeholder for expires_at, so a source token missing it would ship,
  // then throw "missing/invalid field: expires_at" on the box AFTER the full
  // provision cycle (the same expensive silent waste the access_token guard
  // above prevents). Catch it locally instead.
  if (typeof parsed.expires_at !== "string" || parsed.expires_at === "") {
    throw new Error(
      "[full-remote] auth json has no usable expires_at — the box token loader requires it " +
        "(re-login locally: `quanta /login`).",
    )
  }
  // Whitelist of the non-secret fields the box ACTUALLY needs (verified jun-20
  // against token-store.ts + the chatgpt-oauth adapter):
  //   - access_token : the bearer the box runs patch-gen with (guarded above);
  //   - account_id   : sent as the `chatgpt-account-id` request header — without
  //                    it the box hits the wrong/default account;
  //   - expires_at   : loader-required (guarded above), drives the pre-refresh
  //                    skip so a short run never tries to refresh;
  //   - last_refresh / plan_type : UX/telemetry only, harmless to keep.
  // refresh_token / id_token are DELIBERATELY excluded (long-lived secrets) and
  // re-added below as REDACTED placeholders only to satisfy the loader's shape.
  const safe: Record<string, unknown> = {}
  for (const k of ["access_token", "account_id", "expires_at", "last_refresh", "plan_type"]) {
    if (parsed[k] !== undefined) safe[k] = parsed[k]
  }
  // The loader hard-requires non-empty refresh_token + id_token fields. Satisfy
  // the shape with REDACTED placeholders so the REAL long-lived secrets stay
  // home — for a short run the access_token never expires, so refresh (which
  // would need the real value) is never invoked.
  safe.refresh_token = REDACTED
  safe.id_token = REDACTED
  return JSON.stringify(safe)
}

/**
 * Packages `src/` imports that are NOT declared in package.json/bun.lock (they
 * survive locally only because they sit in a dev's node_modules). A clean
 * `bun install` on a fresh box misses them, so full-remote `bun add`s them.
 * All pure-JS (no native ABI) so they install cleanly on the linux box.
 * FIXME: these belong in the repo's package.json — a fresh clone breaks without
 * them. (Discovered 2026-06-16 via the full-remote clean-box run.)
 */
export const PHANTOM_DEPS = [
  "turndown",
  "@secretlint/core",
  "@secretlint/secretlint-rule-preset-recommend",
  "@secretlint/types",
  "write-file-atomic",
  "csv-parse",
] as const

const oneLine = (s: string): string => s.trim().split(/\s+/)[0] ?? ""

const RUNNING_BOX_FILTERS = [
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running",
] as const

const LIVE_BOX_FILTERS = [
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running,pending",
] as const

const MAX_LAUNCH_TAG_VALUE = 120

const launchTagValue = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const sanitized = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_LAUNCH_TAG_VALUE)
  return sanitized === "" ? undefined : sanitized
}

const launchSelectionTag = (cfg: FullRemoteConfig): string | undefined => {
  if ((cfg.launchMode ?? "full-remote") === "pool") return undefined
  if (cfg.instanceIds !== undefined && cfg.instanceIds.length === 1) {
    return launchTagValue(cfg.instanceIds[0])
  }
  if (cfg.instanceIds !== undefined && cfg.instanceIds.length > 1) {
    return `count-${cfg.instanceIds.length}`
  }
  if (cfg.datasetPath === "") return undefined
  const ids = readDatasetInstanceIds(cfg.datasetPath)
  if (ids.length === 1) return launchTagValue(ids[0])
  if (ids.length > 1) return `count-${ids.length}`
  return undefined
}

const launchTagSpecifications = (cfg: FullRemoteConfig): string => {
  const tags: Array<{ key: string; value: string }> = [{ key: "Name", value: "quanta-bench-full" }]
  const mode = launchTagValue(cfg.launchMode ?? "full-remote")
  const preset = launchTagValue(cfg.preset)
  const model = launchTagValue(cfg.model)
  const dataset = cfg.datasetPath !== "" ? launchTagValue(basename(cfg.datasetPath)) : undefined
  const selection = launchSelectionTag(cfg)
  if (mode !== undefined) tags.push({ key: "QuantaMode", value: mode })
  if (preset !== undefined) tags.push({ key: "QuantaPreset", value: preset })
  if (model !== undefined) tags.push({ key: "QuantaModel", value: model })
  if (dataset !== undefined) tags.push({ key: "QuantaDataset", value: dataset })
  if (selection !== undefined) tags.push({ key: "QuantaSelection", value: selection })
  return `ResourceType=instance,Tags=[${tags.map((tag) => `{Key=${tag.key},Value=${tag.value}}`).join(",")}]`
}

/** Box-side directory used as an ATOMIC grade lock (`mkdir` is atomic + fails if
 *  it exists). Held for the duration of one chunk's grade so a reused box can
 *  never run two grades at once. */
const GRADE_LOCK_DIR = "~/.pool-grade.lock"
const BOX_STATUS_PATH = "~/.quanta/bench-box-status.json"
const BOX_STATUS_TMP_PATH = "~/.quanta/bench-box-status.json.tmp"

/** Thrown by {@link gradeChunkOnBox} when the box is already grading (lock held).
 *  The pool drops the box WITHOUT terminating it (it belongs to the other run). */
export const POOL_BUSY_ERROR = "POOL_BOX_BUSY"
export const GRADE_LOCK_RELEASE_ERROR = "GRADE_LOCK_RELEASE_FAILED"

/** Single-quote a value for safe interpolation into a remote bash command
 *  string. Without this, a preset/model/instance-id containing a space, `;`,
 *  `$(...)`, backtick, or `|` would break out of the intended command (the
 *  token is piped over STDIN and is safe, but these env/flag values are not). */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Charset a runId / artifact suffix is allowed to contain. The suffix is the
 *  ONLY caller-supplied value that flows UNQUOTED into remote ssh commands —
 *  the pool derives box paths from it ({@link ChunkPaths}: `~/runs/<runId>/…`)
 *  and those paths are interpolated raw into `tail`/`cat`/`setsid bash -c …`. A
 *  suffix with a shell metachar (` `, `;`, `$(…)`, backtick, `|`, `/`, `..`)
 *  would break out of the intended command. The pool already documents the
 *  "filesystem-safe (no spaces / slashes)" contract; this is the boundary that
 *  ENFORCES it (defense-in-depth — a future caller can't smuggle an injection). */
const SAFE_SUFFIX_RE = /^[A-Za-z0-9._-]+$/

/** Assert a caller-supplied runId / artifact suffix cannot break out of the
 *  remote command it is interpolated into. Rejects (never escapes) so a bad
 *  suffix fails LOUDLY at the boundary instead of silently mangling box paths or
 *  smuggling a command. */
export const assertSafeArtifactSuffix = (suffix: string): void => {
  if (!SAFE_SUFFIX_RE.test(suffix)) {
    throw new Error(
      `[full-remote] unsafe artifact suffix / runId ${JSON.stringify(suffix)} — must match ` +
        `${SAFE_SUFFIX_RE} (no spaces, slashes, or shell metacharacters); it is interpolated ` +
        "into remote ssh box paths.",
    )
  }
}

/** Keys set EXPLICITLY in the remote command — excluded from the generic forward
 *  to avoid double-assignment. */
const EXPLICIT_BOX_ENV: ReadonlySet<string> = new Set([
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_CONCURRENCY",
  "QUANTA_BENCH_RECORD_TRAJECTORY",
])

/** Non-`QUANTA_BENCH_`-prefixed env knobs that ALSO must reach the box. These
 *  are runtime-config dials read by the bench runner itself (not preset-bundled,
 *  not BENCH-prefixed) — without forwarding they silently fall back to the box
 *  default. jun-20: `QUANTA_MAX_TURNS` (→ `maxTurnsBatch`) was stuck at the
 *  preset 60 on the box, so complex instances `max_turns_exhausted` even when a
 *  higher local budget was set. Same env-forwarding bug class the BENCH filter
 *  guards against. */
const FORWARD_EXTRA_ENV: ReadonlySet<string> = new Set(["QUANTA_MAX_TURNS"])

/**
 * Build the `KEY=val ` prefix that forwards the operator's local bench knobs
 * (every set, non-empty `QUANTA_BENCH_*` except the explicitly-handled ones) into
 * the remote box command. PURE — deterministic over the given env. Sorted for a
 * stable command string. Each value is shell-quoted.
 *
 * WHY this exists as a tested seam: without forwarding, env-only knobs that are
 * NOT bundled in any preset (QUANTA_BENCH_SPEC_FIDELITY_STEER /
 * QUANTA_BENCH_VERIFICATION_PLAN / …) never reach the box, so a remote experiment
 * arm is SILENTLY INERT and the whole A/B reads as a null effect (jun-16
 * env-forwarding bug class). The test pins that the experiment knobs survive.
 */
export const buildForwardedBenchEnv = (env: NodeJS.ProcessEnv): string =>
  Object.keys(env)
    .filter(
      (k) =>
        (k.startsWith("QUANTA_BENCH_") || FORWARD_EXTRA_ENV.has(k)) &&
        !EXPLICIT_BOX_ENV.has(k) &&
        env[k] !== undefined &&
        env[k] !== "",
    )
    .sort()
    .map((k) => `${k}=${shq(env[k] as string)} `)
    .join("")

const userData = (ttl: number): string =>
  [
    "#!/bin/bash",
    "set -eux",
    `shutdown -h +${ttl}`,
    // ripgrep (jun-19): the `grep` tool AND the new `find_references` tool both
    // shell out to `rg`. It was MISSING from every bench box → both returned
    // "rg: command not found" and the agent silently fell back to bash grep
    // (measured on django-11400: 5/5 grep-tool calls + find_references all failed).
    // Installing it un-breaks the grep tool too, not just find_references.
    "apt-get update -y && apt-get install -y docker.io git curl unzip ripgrep",
    "systemctl enable --now docker",
    "usermod -aG docker ubuntu",
    "su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    "su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'",
    // jun-19: the LSP nav-grounding lever (DEFAULT-ON since jun-17) was 100%
    // INERT on every bench box — `pyright-langserver` is not installed, so the
    // shared nav session failed to ready on every instance ("Executable not
    // found in $PATH"). The box has neither node nor pyright. `uv tool install
    // pyright` lands the PyPI wrapper (which self-manages a pinned node) at
    // ~/.local/bin/pyright-langserver, which remoteRun already puts on PATH.
    // The trailing `pyright --version` warms the one-time node download so the
    // first instance doesn't eat that latency. Fail-OPEN (`|| true`) at
    // cloud-init so the EC2 launch itself stays robust; the post-bootstrap
    // launch-proof below decides whether an inert pyright install is a loud
    // warning or a strict fail-closed stop, depending on the selected preset.
    // jun-19 hardening: the prior line warmed `pyright` (CLI) but the LSP
    // adapter spawns `pyright-langserver`; if uv only linked `pyright` the nav
    // session still failed "not found". Now we (1) install, (2) warm the node
    // download via `pyright --version`, (3) GUARANTEE a `pyright-langserver` on
    // PATH by symlinking it from the uv tool venv when uv didn't expose it, and
    // (4) warm the langserver binary itself. All fail-OPEN (`|| true`).
    "su - ubuntu -c '~/.local/bin/uv tool install pyright >/dev/null 2>&1 || true'",
    "su - ubuntu -c '~/.local/bin/pyright --version >/dev/null 2>&1 || true'",
    "su - ubuntu -c 'test -x ~/.local/bin/pyright-langserver || ln -sf \"$(find ~/.local/share/uv/tools/pyright -name pyright-langserver -type f 2>/dev/null | head -1)\" ~/.local/bin/pyright-langserver 2>/dev/null || true'",
    "su - ubuntu -c '~/.local/bin/pyright-langserver --version >/dev/null 2>&1 || true'",
  ].join("\n")

export interface FullRemoteResult {
  readonly reportPath?: string
  readonly resolved?: readonly string[]
  readonly unresolved?: readonly string[]
  readonly errored?: readonly string[]
  readonly emptyPatch?: readonly string[]
  readonly dryRun?: boolean
  readonly plan?: readonly string[]
  /** The box run hit the shared OAuth rate limit (a `generation_error` / 429 was
   *  observed in the run log). A pool uses this to BACK OFF before the next chunk
   *  instead of hammering the throttled login. Absent ⇒ not detected. */
  readonly rateLimited?: boolean
}

/** Did the box run log show the shared-OAuth rate limit? The CANONICAL marker the
 *  runtime emits for a throttled login is `generation_error` (same class the
 *  sweep's TRANS_RE watches); "rate limit" / "too many requests" cover a raw
 *  provider error. PURE — testable.
 *
 *  NOTE: a BARE `429` is deliberately NOT matched — instance ids and turn counts
 *  routinely contain `429` (`psf__requests-429`, `turns=429`), so it would
 *  false-positive and waste a backoff on a perfectly clean chunk. Only a 429 in an
 *  http/status context counts. */
export const detectRateLimit = (logTail: string): boolean =>
  /generation_error|too many requests|rate[ _-]?limit|(?:http|status)[ /:]*429/i.test(logTail)

/** Every instance that earned ANY verdict in `r` — resolved / unresolved /
 *  errored / emptyPatch. The COMPLEMENT (an expected instance absent from all
 *  four) is a box-loss: spot reclaim or ssh-255 killed the box before that
 *  instance's verdict was written. A grade-concurrency pipeline spreads grading
 *  across the run, so a mid-run death leaves a PARTIAL report — exactly the case
 *  the old all-or-nothing empty-check missed (silent under-count). */
export const coveredInstances = (r: FullRemoteResult): Set<string> =>
  new Set<string>([
    ...(r.resolved ?? []),
    ...(r.unresolved ?? []),
    ...(r.errored ?? []),
    ...(r.emptyPatch ?? []),
  ])

/**
 * Reassemble a byte/chunk stream into COMPLETE lines and `emit` each one (blank
 * lines dropped). A trailing partial line (no newline yet) is held in the buffer
 * until its newline arrives — so a line split across two stdout chunks
 * ("Instances comp" + "leted: 1\n") is emitted ONCE, intact, not as fragments.
 * This is what makes the streamed remote-run feed readable instead of garbled.
 */
export const createLineStreamer = (emit: (line: string) => void): ((chunk: string) => void) => {
  let buf = ""
  return (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() !== "") emit(line)
      nl = buf.indexOf("\n")
    }
  }
}

/**
 * #1-P0 (jun-19 audit) — LSP-grounding launch-proof verdict (PURE, testable).
 *
 * Given the box-side pyright probe result, decide whether LSP grounding is LIVE
 * or INERT for this run. The localize-phase steer (DEFAULT-ON under
 * agentless-v1/v2) tells the model to call lsp_definition/lsp_references, but
 * EVERY nav call silently returns "unavailable" if pyright-langserver is not
 * launchable on the box — grounding becomes THEATER and the report cannot
 * distinguish "model ignored the steer" from "pyright was never there" (the
 * jun-16/19 inert bug class). userData installs pyright fail-open (`|| true`),
 * so this verdict feeds the post-bootstrap posture gate: non-strict presets log
 * a LOUD warning, while the thin-strict family fails closed. INERT ⇒ ready:false.
 */
export const pyrightLaunchProofVerdict = (probe: {
  code: number
  stdout: string
}): { ready: boolean; detail: string } => {
  const out = (typeof probe.stdout === "string" ? probe.stdout : "").trim()
  if (probe.code !== 0 || out === "" || /PYRIGHT_MISSING/.test(out)) {
    return { ready: false, detail: out.slice(-200) }
  }
  return { ready: true, detail: out }
}

const pyrightGroundingProbeCommand =
  'export PATH="$HOME/.local/bin:$PATH"; if command -v pyright-langserver >/dev/null 2>&1; then pyright --version 2>&1 | tail -1; else echo PYRIGHT_MISSING; exit 7; fi'

const probePyrightGrounding = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<{ ready: boolean; detail: string }> =>
  pyrightLaunchProofVerdict(await ssh(pyrightGroundingProbeCommand))

const pyrightProbeDetail = (detail: string): string =>
  detail === "" ? "(no probe output)" : detail

const inertGroundingWarning = (detail: string): string =>
  "[full-remote] ⚠️  WARNING: pyright-langserver is NOT launchable on the box — LSP grounding " +
  "(lsp_definition / lsp_references) is INERT this run: the localize steer fires but every nav call " +
  'returns "unavailable" (silent no-nav degrade). The userData pyright install likely failed. ' +
  `probe: ${pyrightProbeDetail(detail)}`

const strictGroundingFailure = (preset: string, detail: string): Error =>
  new Error(
    `[full-remote] preset ${preset} requires live LSP grounding, but pyright-langserver is not ` +
      `launchable on the box. probe: ${pyrightProbeDetail(detail)}`,
  )

const verifyPyrightGrounding = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  log: (msg: string) => void,
  preset: string,
): Promise<void> => {
  const groundingVerdict = await probePyrightGrounding(ssh)
  if (!groundingVerdict.ready) {
    if (presetRequiresLiveLspGrounding(preset)) {
      throw strictGroundingFailure(preset, groundingVerdict.detail)
    }
    log(inertGroundingWarning(groundingVerdict.detail))
    return
  }
  log(`[full-remote] LSP grounding ready — ${groundingVerdict.detail}`)
}

/**
 * A live, bootstrapped EC2 box. The connection primitives (`ssh`, `aws`, raw
 * `spawn`) are bound to the resolved host/region/key so a caller never re-derives
 * them. `terminate` is a fail-closed cleanup boundary for launched boxes:
 * callers must see a failed AWS terminate instead of silently assuming the box
 * was cleaned up. Created ONLY by {@link provisionBox}.
 */
export interface BoxSession {
  readonly iid: string
  readonly ip: string
  readonly host: string
  readonly keyPath: string
  readonly region: string
  readonly spawn: SpawnFn
  readonly log: (msg: string) => void
  /** ssh to this box. Token/stdin goes over `input` (never an argv). `onData`
   *  streams stdout live. */
  ssh(remoteCmd: string, input?: string, onData?: (chunk: string) => void): Promise<SpawnResult>
  aws(args: readonly string[]): Promise<SpawnResult>
  /** Terminate the box (no-op when `keep` or attach). Throws when launched-box
   *  cleanup fails. */
  terminate(): Promise<void>
}

/** Box-side paths for one grading chunk. Defaults reproduce the historical fixed
 *  paths (so a single full-remote run is byte-identical); a pool overrides them
 *  with runId-scoped paths so concurrent/sequential chunks never collide on the
 *  shared `~/report.json` / `~/instances.jsonl`. */
export interface ChunkPaths {
  readonly dataset: string
  readonly preds: string
  readonly report: string
  readonly runLog: string
  readonly observeDir: string
  readonly trajectory: string
}

// NOTE on `~` vs `$HOME`: every path below is interpolated UNQUOTED into the
// remote command (cat/tee/--flag), where tilde-expansion works — EXCEPT
// `trajectory`, which is also placed inside DOUBLE QUOTES in the record env
// (`QUANTA_BENCH_RECORD_TRAJECTORY="…"`), where bash does NOT expand `~`. So
// trajectory MUST use `$HOME` (which expands in both contexts). A pool building
// runId-scoped overrides must follow the same rule for its trajectory path.
export const DEFAULT_CHUNK_PATHS: ChunkPaths = {
  dataset: "~/instances.jsonl",
  preds: "~/preds.jsonl",
  report: "~/report.json",
  runLog: "~/run.log",
  observeDir: "~/observe",
  trajectory: "$HOME/quanta/bench-trajectory.jsonl",
}

/** Parameters for one patch-gen+grading chunk on an already-provisioned box. */
export interface GradeChunkParams {
  /** Local dataset file to scp up for THIS chunk. */
  readonly datasetPath: string
  /** RAW chatgpt.json — re-stripped + re-shipped per chunk (a pool refreshes the
   *  token between chunks so a long-lived run never runs on a stale access_token). */
  readonly authJson: string
  readonly instanceIds?: readonly string[]
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  /** Box-side paths. Default {@link DEFAULT_CHUNK_PATHS}. */
  readonly paths?: ChunkPaths
  /** Suffix for LOCAL artifact filenames (`report-<suffix>.json`). Single run ⇒
   *  iid; pool ⇒ runId so chunks don't overwrite each other's local artifacts. */
  readonly artifactSuffix: string
  /** Whether to record + fetch the LLM-trajectory cassette (operator opt-in). */
  readonly recordTrajectory: boolean
  /** Forwarded `QUANTA_BENCH_*` env prefix (already built via
   *  {@link buildForwardedBenchEnv}). */
  readonly forwardedBenchEnv: string
  /** jun-20 multi-auth (T-6): auth-pool account that leased this chunk. Surfaced
   *  in the box status snapshot for operator attribution. Omitted in single-auth. */
  readonly accountLabel?: string
}

export interface BoxStatusSnapshot {
  readonly phase: "running" | "fetching" | "idle"
  readonly mode: "pool" | "full-remote"
  readonly runId?: string
  /** jun-20 multi-auth (T-6): which auth-pool account last owned this chunk, so
   *  `box ls` / postmortems can attribute a 429 to a specific account. Absent in
   *  single-auth mode. Never a token — just the operator-facing label. */
  readonly accountLabel?: string
  readonly workload: string
  readonly dataset: string
  readonly instanceCount: number
  readonly instancePreview?: readonly string[]
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  readonly startedAt?: string
  readonly updatedAt: string
  readonly runLogPath?: string
  readonly reportPath?: string
  readonly predictionsPath?: string
  readonly observeDir?: string
  readonly trajectoryPath?: string
  readonly resolvedCount?: number
  readonly unresolvedCount?: number
  readonly erroredCount?: number
  readonly emptyPatchCount?: number
  readonly rateLimited?: boolean
  readonly lastExitCode?: number
  readonly lastLogLine?: string
}

export interface BoxRuntimeProbe {
  readonly activeRunDetected: boolean
  readonly runLogPath?: string
  readonly runLogUpdatedAt?: string
  readonly reportPath?: string
  readonly reportExists?: boolean
  readonly predictionsPath?: string
  readonly predictionsLines?: number
  readonly observeDir?: string
  readonly runExitPath?: string
  readonly runExitExists?: boolean
  readonly lastLogLine?: string
}

export type BoxSnapshotState =
  | "ok"
  | "missing"
  | "write-failed"
  | "invalid"
  | "read-failed"
  | "not-ready"

export interface BoxInspection {
  readonly lifecycle: "bootstrapping" | "idle" | "busy" | "unreachable"
  readonly bootstrapped: boolean
  readonly busy: boolean
  readonly snapshotHealthy: boolean
  readonly snapshotState: BoxSnapshotState
  readonly snapshot?: BoxStatusSnapshot
  readonly probe?: BoxRuntimeProbe
}

interface BoxSnapshotRead {
  readonly snapshotHealthy: boolean
  readonly snapshotState: Exclude<BoxSnapshotState, "not-ready" | "write-failed">
  readonly snapshot?: BoxStatusSnapshot
}

const normalizeStatusText = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .trim()
    .slice(0, 200)

const workloadLabel = (params: GradeChunkParams): string => {
  if (params.instanceIds !== undefined && params.instanceIds.length === 1)
    return params.instanceIds[0] ?? "1 instance"
  if (params.instanceIds !== undefined && params.instanceIds.length > 1)
    return `${params.instanceIds.length} instances`
  return basename(params.datasetPath)
}

const snapshotMode = (params: GradeChunkParams): "pool" | "full-remote" =>
  params.paths === undefined ? "full-remote" : "pool"

const readDatasetInstanceIds = (path: string): string[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .flatMap((line) => {
        try {
          const id = (JSON.parse(line) as { instance_id?: unknown }).instance_id
          return typeof id === "string" && id !== "" ? [id] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const selectionMeta = (
  params: GradeChunkParams,
): { instanceCount: number; instancePreview?: readonly string[] } => {
  const ids =
    params.instanceIds !== undefined && params.instanceIds.length > 0
      ? [...params.instanceIds]
      : readDatasetInstanceIds(params.datasetPath)
  return {
    instanceCount: ids.length,
    ...(ids.length > 0 ? { instancePreview: ids.slice(0, 3) } : {}),
  }
}

const writeBoxSnapshot = async (
  session: BoxSession,
  snapshot: BoxStatusSnapshot,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    const out = await session.ssh(
      `mkdir -p ~/.quanta && cat > ${BOX_STATUS_TMP_PATH} && mv ${BOX_STATUS_TMP_PATH} ${BOX_STATUS_PATH}`,
      `${JSON.stringify(snapshot)}\n`,
    )
    if (out.code !== 0) {
      return {
        ok: false,
        error: `exit ${out.code}: ${(out.stderr || out.stdout || "no output").trim()}`,
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
}

const asSnapshotPhase = (value: unknown): BoxStatusSnapshot["phase"] | undefined =>
  value === "running" || value === "fetching" || value === "idle" ? value : undefined

const asSnapshotMode = (value: unknown): BoxStatusSnapshot["mode"] | undefined =>
  value === "pool" || value === "full-remote" ? value : undefined

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const asInstancePreview = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "").slice(0, 3)
    : undefined

const optionalSnapshotString = <K extends keyof BoxStatusSnapshot>(
  key: K,
  value: unknown,
): Partial<Pick<BoxStatusSnapshot, K>> => {
  const parsed = asNonEmptyString(value)
  if (parsed === undefined) return {}
  return {
    [key]: key === "lastLogLine" ? normalizeStatusText(parsed) : parsed,
  } as Partial<Pick<BoxStatusSnapshot, K>>
}

const optionalSnapshotNumber = <K extends keyof BoxStatusSnapshot>(
  key: K,
  value: unknown,
): Partial<Pick<BoxStatusSnapshot, K>> => {
  const parsed = asFiniteNumber(value)
  return parsed === undefined ? {} : ({ [key]: parsed } as Partial<Pick<BoxStatusSnapshot, K>>)
}

const snapshotPathMeta = (parsed: Partial<BoxStatusSnapshot>): Partial<BoxStatusSnapshot> => ({
  ...optionalSnapshotString("runLogPath", parsed.runLogPath),
  ...optionalSnapshotString("reportPath", parsed.reportPath),
  ...optionalSnapshotString("predictionsPath", parsed.predictionsPath),
  ...optionalSnapshotString("observeDir", parsed.observeDir),
  ...optionalSnapshotString("trajectoryPath", parsed.trajectoryPath),
})

const snapshotVerdictMeta = (parsed: Partial<BoxStatusSnapshot>): Partial<BoxStatusSnapshot> => ({
  ...optionalSnapshotNumber("resolvedCount", parsed.resolvedCount),
  ...optionalSnapshotNumber("unresolvedCount", parsed.unresolvedCount),
  ...optionalSnapshotNumber("erroredCount", parsed.erroredCount),
  ...optionalSnapshotNumber("emptyPatchCount", parsed.emptyPatchCount),
  ...(parsed.rateLimited === true ? { rateLimited: true } : {}),
  ...optionalSnapshotNumber("lastExitCode", parsed.lastExitCode),
  ...optionalSnapshotString("lastLogLine", parsed.lastLogLine),
})

const normalizeSnapshotPayload = (
  parsed: Partial<BoxStatusSnapshot>,
): BoxStatusSnapshot | undefined => {
  const phase = asSnapshotPhase(parsed.phase)
  const mode = asSnapshotMode(parsed.mode)
  const instancePreview = asInstancePreview(parsed.instancePreview)
  if (phase === undefined || mode === undefined) return undefined
  return {
    phase,
    mode,
    ...optionalSnapshotString("runId", parsed.runId),
    ...optionalSnapshotString("accountLabel", parsed.accountLabel),
    workload: asNonEmptyString(parsed.workload) ?? "unknown",
    dataset: asNonEmptyString(parsed.dataset) ?? "unknown",
    instanceCount: asFiniteNumber(parsed.instanceCount) ?? 0,
    ...(instancePreview !== undefined ? { instancePreview } : {}),
    preset: asNonEmptyString(parsed.preset) ?? "unknown",
    model: asNonEmptyString(parsed.model) ?? "unknown",
    concurrency: asFiniteNumber(parsed.concurrency) ?? 0,
    ...optionalSnapshotString("startedAt", parsed.startedAt),
    updatedAt: asNonEmptyString(parsed.updatedAt) ?? "unknown",
    ...snapshotPathMeta(parsed),
    ...snapshotVerdictMeta(parsed),
  }
}

const BOX_SNAPSHOT_MISSING_MARKER = "__QUANTA_BOX_SNAPSHOT_MISSING__"

const boxSnapshotReadCommand = `if test -f ${BOX_STATUS_PATH}; then cat ${BOX_STATUS_PATH}; else printf '%s\\n' '${BOX_SNAPSHOT_MISSING_MARKER}'; fi`

const readBoxSnapshot = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<BoxSnapshotRead> => {
  const raw = await ssh(boxSnapshotReadCommand).catch(() => undefined)
  if (raw === undefined || raw.code !== 0) {
    return { snapshotHealthy: false, snapshotState: "read-failed" }
  }
  const stdout = raw.stdout.trim()
  if (stdout === BOX_SNAPSHOT_MISSING_MARKER) {
    return { snapshotHealthy: false, snapshotState: "missing" }
  }
  if (stdout === "") {
    return { snapshotHealthy: false, snapshotState: "invalid" }
  }
  try {
    const snapshot = normalizeSnapshotPayload(JSON.parse(raw.stdout) as Partial<BoxStatusSnapshot>)
    if (snapshot === undefined) return { snapshotHealthy: false, snapshotState: "invalid" }
    return { snapshotHealthy: true, snapshotState: "ok", snapshot }
  } catch {
    return { snapshotHealthy: false, snapshotState: "invalid" }
  }
}

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined

const normalizeRuntimeProbePayload = (
  parsed: Partial<BoxRuntimeProbe>,
): BoxRuntimeProbe | undefined => {
  const activeRunDetected = asBoolean(parsed.activeRunDetected) ?? false
  const runLogPath = asNonEmptyString(parsed.runLogPath)
  const runLogUpdatedAt = asNonEmptyString(parsed.runLogUpdatedAt)
  const reportPath = asNonEmptyString(parsed.reportPath)
  const reportExists = asBoolean(parsed.reportExists)
  const predictionsPath = asNonEmptyString(parsed.predictionsPath)
  const predictionsLines = asFiniteNumber(parsed.predictionsLines)
  const observeDir = asNonEmptyString(parsed.observeDir)
  const runExitPath = asNonEmptyString(parsed.runExitPath)
  const runExitExists = asBoolean(parsed.runExitExists)
  const lastLogLine = asNonEmptyString(parsed.lastLogLine)
  if (
    !activeRunDetected &&
    runLogPath === undefined &&
    runLogUpdatedAt === undefined &&
    reportPath === undefined &&
    reportExists === undefined &&
    predictionsPath === undefined &&
    predictionsLines === undefined &&
    observeDir === undefined &&
    runExitPath === undefined &&
    runExitExists === undefined &&
    lastLogLine === undefined
  ) {
    return undefined
  }
  return {
    activeRunDetected,
    ...(runLogPath !== undefined ? { runLogPath } : {}),
    ...(runLogUpdatedAt !== undefined ? { runLogUpdatedAt } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    ...(reportExists !== undefined ? { reportExists } : {}),
    ...(predictionsPath !== undefined ? { predictionsPath } : {}),
    ...(predictionsLines !== undefined ? { predictionsLines } : {}),
    ...(observeDir !== undefined ? { observeDir } : {}),
    ...(runExitPath !== undefined ? { runExitPath } : {}),
    ...(runExitExists !== undefined ? { runExitExists } : {}),
    ...(lastLogLine !== undefined ? { lastLogLine: normalizeStatusText(lastLogLine) } : {}),
  }
}

const BOX_RUNTIME_PROBE_MARKER = "__QUANTA_BOX_RUNTIME_PROBE__"

const boxRuntimeProbeCommand = [
  "python3 - <<'PY'",
  `# ${BOX_RUNTIME_PROBE_MARKER}`,
  "import glob, json, os, re, subprocess",
  "from datetime import datetime, timezone",
  "",
  "HOME = os.path.expanduser('~')",
  "",
  "def ps_lines():",
  "    try:",
  "        out = subprocess.check_output(['ps', '-Ao', 'args='], text=True, stderr=subprocess.DEVNULL)",
  "        return [line.strip() for line in out.splitlines() if line.strip()]",
  "    except Exception:",
  "        return []",
  "",
  "def first_group(pattern, lines):",
  "    regex = re.compile(pattern)",
  "    for line in lines:",
  "        match = regex.search(line)",
  "        if match is None:",
  "            continue",
  "        for group in match.groups():",
  "            if group:",
  "                return group",
  "    return None",
  "",
  "def latest_log():",
  "    candidates = [os.path.join(HOME, 'run.log')] + glob.glob(os.path.join(HOME, 'runs', '*', 'run.log'))",
  "    existing = [path for path in candidates if os.path.exists(path)]",
  "    if not existing:",
  "        return None",
  "    return max(existing, key=os.path.getmtime)",
  "",
  "def iso_mtime(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat().replace('+00:00', 'Z')",
  "    except Exception:",
  "        return None",
  "",
  "def count_lines(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        with open(path, 'r', encoding='utf-8', errors='ignore') as handle:",
  "            return sum(1 for _ in handle)",
  "    except Exception:",
  "        return None",
  "",
  "def last_line(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        with open(path, 'r', encoding='utf-8', errors='ignore') as handle:",
  "            lines = [line.strip() for line in handle.readlines() if line.strip()]",
  "        return lines[-1] if lines else None",
  "    except Exception:",
  "        return None",
  "",
  "def user_path(path):",
  "    if not path:",
  "        return None",
  "    return path.replace(HOME, '~', 1) if path.startswith(HOME) else path",
  "",
  "lines = ps_lines()",
  "driver_lines = [line for line in lines if 'src/apps/bench/cli.ts run' in line]",
  "grade_lines = [line for line in lines if 'swebench.harness.run_evaluation' in line]",
  "",
  "run_log = first_group(r'(?:>\\s*|tee\\s+)(\\S*run\\.log)\\b', driver_lines)",
  "report = first_group(r'--report\\s+(\\S+)', driver_lines)",
  "preds = first_group(r'--predictions\\s+(\\S+)', driver_lines)",
  "observe = first_group(r'--observe-dir\\s+(\\S+)', driver_lines)",
  "if run_log is None:",
  "    run_log = latest_log()",
  "if report is None and run_log:",
  "    report = os.path.join(os.path.dirname(run_log), 'report.json')",
  "if preds is None and run_log:",
  "    preds = os.path.join(os.path.dirname(run_log), 'preds.jsonl')",
  "if observe is None and run_log:",
  "    observe = os.path.join(os.path.dirname(run_log), 'observe')",
  "run_exit = re.sub(r'run\\.log$', 'run.exit', run_log) if run_log else None",
  "",
  "payload = {",
  "    'activeRunDetected': bool(driver_lines or grade_lines),",
  "    'runLogPath': user_path(run_log),",
  "    'runLogUpdatedAt': iso_mtime(run_log),",
  "    'reportPath': user_path(report),",
  "    'reportExists': bool(report and os.path.exists(report)),",
  "    'predictionsPath': user_path(preds),",
  "    'predictionsLines': count_lines(preds),",
  "    'observeDir': user_path(observe),",
  "    'runExitPath': user_path(run_exit),",
  "    'runExitExists': bool(run_exit and os.path.exists(run_exit)),",
  "    'lastLogLine': last_line(run_log),",
  "}",
  "print(json.dumps(payload))",
  "PY",
].join("\n")

const readBoxRuntimeProbe = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<BoxRuntimeProbe | undefined> => {
  const raw = await ssh(boxRuntimeProbeCommand).catch(() => undefined)
  if (raw === undefined || raw.code !== 0 || raw.stdout.trim() === "") return undefined
  try {
    return normalizeRuntimeProbePayload(JSON.parse(raw.stdout) as Partial<BoxRuntimeProbe>)
  } catch {
    return undefined
  }
}

const probeShowsRuntimeEvidence = (probe: BoxRuntimeProbe | undefined): boolean =>
  probe?.activeRunDetected === true ||
  probe?.runLogPath !== undefined ||
  probe?.runLogUpdatedAt !== undefined ||
  probe?.reportPath !== undefined ||
  probe?.reportExists !== undefined ||
  probe?.predictionsPath !== undefined ||
  probe?.predictionsLines !== undefined ||
  probe?.observeDir !== undefined ||
  probe?.runExitPath !== undefined ||
  probe?.runExitExists !== undefined ||
  probe?.lastLogLine !== undefined

/**
 * `gradeChunkOnBox()` publishes the running snapshot BEFORE dataset upload,
 * token ship, and the detached bench run start. Once the runtime probe can see
 * an active run or any run artifacts, the snapshot file should already exist.
 * If it does not, the snapshot publish path regressed and the operator must see
 * that as stronger than a generic "missing file".
 */
const resolveSnapshotInspection = (
  snapshotRead: BoxSnapshotRead,
  probe: BoxRuntimeProbe | undefined,
  busy: boolean,
): Pick<BoxInspection, "snapshotHealthy" | "snapshotState" | "snapshot"> => {
  if (snapshotRead.snapshotState === "missing" && (busy || probeShowsRuntimeEvidence(probe))) {
    return { snapshotHealthy: false, snapshotState: "write-failed" }
  }
  return {
    snapshotHealthy: snapshotRead.snapshotHealthy,
    snapshotState: snapshotRead.snapshotState,
    ...(snapshotRead.snapshot !== undefined ? { snapshot: snapshotRead.snapshot } : {}),
  }
}

export const boxRunLogPath = (
  snapshot?: Pick<BoxStatusSnapshot, "mode" | "runId" | "runLogPath">,
): string | undefined => {
  if (snapshot?.runLogPath !== undefined && snapshot.runLogPath !== "") return snapshot.runLogPath
  if (snapshot?.mode === "pool" && snapshot.runId !== undefined && snapshot.runId !== "") {
    return `~/runs/${snapshot.runId}/run.log`
  }
  if (snapshot?.mode === "full-remote") return DEFAULT_CHUNK_PATHS.runLog
  return undefined
}

const SNAPSHOT_HEARTBEAT_MS = 15_000
const SNAPSHOT_LINE_FLUSH_MS = 2_000
/** Full-remote readiness/retry waits MUST keep the owner process alive.
 *  `unref()` here let the CLI exit cleanly while still awaiting cloud-init,
 *  orphaning fresh EC2 boxes before bootstrap finished. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    setTimeout(r, ms)
  })

const aws =
  (spawn: SpawnFn, region: string) =>
  (args: readonly string[]): Promise<SpawnResult> =>
    spawn("aws", ["--region", region, ...args])

const terminateFailure = (iid: string, result: SpawnResult): Error => {
  const detail =
    result.stderr.trim() || result.stdout.trim() || `aws terminate-instances exited ${result.code}`
  return new Error(`[full-remote] terminate-instances failed for ${iid}: ${detail}`)
}

const cleanupFailure = (phase: string, iid: string, primary: unknown, cleanup: unknown): Error =>
  new Error(
    `[full-remote] ${phase} failed and cleanup failed for ${iid}: primary=${errMessage(primary)}; cleanup=${errMessage(cleanup)}`,
  )

/** ssh helper bound to host+key. Token (when given) goes over STDIN — never an
 *  argv. Short connect-timeout so a closed :22 fails fast.
 *
 *  KEEPALIVE — MIDDLE GROUND (RCA jun-20, two OPPOSITE failure modes):
 *  - ZERO keepalive (the prior over-correction) HANGS: the long run is one
 *    foreground `ssh '… bun run … | tee run.log'`. During patch-gen (8 agents,
 *    minutes of NO stdout) the idle TCP is silently dropped by NAT/firewall;
 *    with no probes ssh never DETECTS the dead socket, so `await ssh` hangs
 *    forever even after the box finishes — the orchestrator is later killed and
 *    the box is ORPHANED (results stranded on it). Observed on 2/2 long runs:
 *    no `run finished (exit …)` line ⇒ the await never returned.
 *  - TIGHT keepalive (`15 / CountMax=4`, 60s grace) TORE DOWN healthy runs: a
 *    CPU-saturated box can't answer probes within 60s → `exit 255`, empty log.
 *  The fix is BOTH at once: probes every 30s keep the idle TCP alive THROUGH the
 *  silence (NAT idle ~300s ≫ 30s), and a 30×20 = 600s grace tolerates a
 *  busy-but-alive box (only 20 consecutive missed probes ⇒ truly dead).
 *  `TCPKeepAlive=yes` is OS-layer belt-and-suspenders. */
const makeSsh =
  (spawn: SpawnFn, keyPath: string, host: string) =>
  (remoteCmd: string, input?: string, onData?: (chunk: string) => void): Promise<SpawnResult> =>
    spawn(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=20",
        "-o",
        "TCPKeepAlive=yes",
        host,
        remoteCmd,
      ],
      ...(input !== undefined || onData !== undefined
        ? [
            {
              ...(input !== undefined ? { input } : {}),
              ...(onData !== undefined ? { onData } : {}),
            },
          ]
        : []),
    )

/** Find-or-create the SG + open :22. Without an attached SG the box lands in the
 *  default SG (no inbound :22) ⇒ ssh times out. Ingress is `0.0.0.0/0` (public,
 *  key-only, throwaway TTL box). Throws on a REAL failure (never masks a
 *  connectivity error by blindly creating). */
const ensureSecurityGroup = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  sgName: string,
  vpcId: string,
  region: string,
): Promise<string> => {
  const found = await awsFn([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=group-name,Values=${sgName}`,
    "--query",
    "SecurityGroups[0].GroupId",
    "--output",
    "text",
  ])
  if (found.code !== 0) {
    throw new Error(
      `[full-remote] could not reach EC2 (${region}) — network/credentials? : ${found.stderr.trim()}`,
    )
  }
  let sgId = oneLine(found.stdout)
  if (sgId === "" || sgId === "None") {
    const created = await awsFn([
      "ec2",
      "create-security-group",
      "--group-name",
      sgName,
      "--description",
      "quanta bench box",
      "--vpc-id",
      vpcId,
      "--query",
      "GroupId",
      "--output",
      "text",
    ])
    if (created.code !== 0) {
      throw new Error(
        `[full-remote] create-security-group failed (code ${created.code}): ${created.stderr}`,
      )
    }
    sgId = oneLine(created.stdout)
  }
  const auth = await awsFn([
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    sgId,
    "--protocol",
    "tcp",
    "--port",
    "22",
    "--cidr",
    "0.0.0.0/0",
  ])
  if (auth.code !== 0 && !/Duplicate/i.test(auth.stderr)) {
    throw new Error(
      `[full-remote] authorize :22 ingress failed (code ${auth.code}): ${auth.stderr}`,
    )
  }
  return sgId
}

/** Launch a hardened box (IMDSv2 hop-1, TTL self-terminate), with instance-type
 *  fallbacks on capacity errors. Returns the instance id. */
const launchInstance = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  cfg: FullRemoteConfig,
  sgId: string,
  ttl: number,
  marketLabel: string,
  log: (m: string) => void,
): Promise<string> => {
  const onDemand = cfg.onDemand ?? false
  // The subnet/AZ is DELIBERATELY NOT pinned unless the caller sets `subnetId` —
  // pinning an AZ is the #1 cause of `InsufficientInstanceCapacity`.
  const typeCandidates = [
    ...new Set([cfg.instanceType ?? D.instanceType, "c7i.4xlarge", "c6i.8xlarge", "m6i.8xlarge"]),
  ]
  const launchArgs = (instanceType: string): string[] => [
    "ec2",
    "run-instances",
    "--image-id",
    cfg.ami ?? D.ami,
    "--instance-type",
    instanceType,
    "--key-name",
    cfg.keyName ?? D.keyName,
    ...(cfg.subnetId !== undefined ? ["--subnet-id", cfg.subnetId] : []),
    "--security-group-ids",
    sgId,
    ...(onDemand ? [] : ["--instance-market-options", '{"MarketType":"spot"}']),
    "--metadata-options",
    "HttpTokens=required,HttpPutResponseHopLimit=1",
    "--instance-initiated-shutdown-behavior",
    "terminate",
    "--block-device-mappings",
    `[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":${cfg.diskGb ?? D.diskGb},"VolumeType":"gp3","DeleteOnTermination":true}}]`,
    "--user-data",
    userData(ttl),
    "--tag-specifications",
    launchTagSpecifications(cfg),
    "--query",
    "Instances[0].InstanceId",
    "--output",
    "text",
  ]

  let iid = ""
  let lastErr = ""
  for (const it of typeCandidates) {
    log(`[full-remote] launching hardened ${marketLabel} box (${it}, IMDSv2 hop-1, TTL)…`)
    const launch = await awsFn(launchArgs(it))
    const got = oneLine(launch.stdout)
    if (launch.code === 0 && got !== "" && got !== "None") {
      iid = got
      break
    }
    lastErr = launch.stderr
    if (/InsufficientInstanceCapacity|capacity/i.test(launch.stderr)) {
      log(`[full-remote] no ${it} capacity — trying next type…`)
      continue
    }
    throw new Error(`[full-remote] run-instances failed (code ${launch.code}): ${launch.stderr}`)
  }
  if (iid === "") {
    throw new Error(
      `[full-remote] no spot capacity across ${typeCandidates.join(", ")}: ${lastErr}`,
    )
  }
  return iid
}

/** The reusable bootstrap surface: rsync src + config, bun install, phantom deps,
 *  swebench shim + warm, pyright nav-grounding probe. Runs on a ready box; throws
 *  on any hard failure (caller terminates). */
const bootstrapBox = async (session: BoxSession, cfg: FullRemoteConfig): Promise<void> => {
  const { host, keyPath, spawn, log } = session
  const ssh = session.ssh.bind(session)
  log(
    "[full-remote] bootstrapped. Syncing src/ + config (SURGICAL — the monorepo's apps/crates/native are GBs and the bench needs only src)…",
  )
  const sshOpts = `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15`
  await ssh("mkdir -p ~/quanta")
  const rsynced = await spawn("rsync", [
    "-az",
    "--partial",
    "--exclude",
    "node_modules",
    "--exclude",
    "*.js", // stale compiled mirrors — bun runs the .ts directly
    "--exclude",
    "*.test.ts", // tests not needed to RUN the agent
    "--exclude",
    ".quanta",
    "-e",
    sshOpts,
    `${cfg.repoDir}/src/`,
    `${host}:~/quanta/src/`,
  ])
  if (rsynced.code !== 0) {
    throw new Error(`[full-remote] rsync src failed (code ${rsynced.code}): ${rsynced.stderr}`)
  }
  const scpCfg = await spawn("scp", [
    "-i",
    keyPath,
    "-o",
    "ConnectTimeout=15",
    `${cfg.repoDir}/package.json`,
    `${cfg.repoDir}/bun.lock`,
    `${cfg.repoDir}/tsconfig.json`,
    `${cfg.repoDir}/tsconfig.base.json`,
    `${cfg.repoDir}/bunfig.toml`,
    `${host}:~/quanta/`,
  ])
  if (scpCfg.code !== 0) {
    throw new Error(`[full-remote] scp config failed (code ${scpCfg.code}): ${scpCfg.stderr}`)
  }
  log("[full-remote] synced src + config; running bun install on box (full deps, ~1-2min)…")
  // `set -o pipefail` so a FAILED install propagates through the `tail`.
  const installed = await ssh(
    "set -o pipefail; cd ~/quanta && ~/.bun/bin/bun install 2>&1 | tail -25",
  )
  if (installed.code !== 0) {
    throw new Error(
      `[full-remote] bun install failed (code ${installed.code}):\n${installed.stdout}${installed.stderr}`,
    )
  }
  // PHANTOM DEPS: packages imported by src/ but undeclared in package.json.
  const phantoms = PHANTOM_DEPS.join(" ")
  log(`[full-remote] installing phantom deps (undeclared in package.json): ${phantoms}…`)
  const added = await ssh(
    `set -o pipefail; cd ~/quanta && ~/.bun/bin/bun add ${phantoms} 2>&1 | tail -15`,
  )
  if (added.code !== 0) {
    throw new Error(
      `[full-remote] bun add (phantom deps) failed (code ${added.code}):\n${added.stdout}${added.stderr}`,
    )
  }
  // Grading toolchain: the swebench-python shim (uvx --from swebench python) +
  // warm the uvx cache so the first import-probe doesn't time out.
  log(
    "[full-remote] creating swebench-python shim + warming uvx swebench cache (first pull ~30-60s)…",
  )
  const shim =
    '#!/usr/bin/env bash\nexec "$HOME/.local/bin/uvx" --from swebench --python 3.11 --quiet python "$@"\n'
  const wrote = await ssh("cat > ~/swebench-python && chmod +x ~/swebench-python", shim)
  if (wrote.code !== 0) {
    throw new Error(
      `[full-remote] writing swebench-python shim failed (code ${wrote.code}): ${wrote.stderr}`,
    )
  }
  const warm = await ssh(
    'set -o pipefail; ~/swebench-python -c "import swebench; print(swebench.__version__)" 2>&1 | tail -3',
  )
  if (warm.code !== 0) {
    throw new Error(
      `[full-remote] swebench toolchain warm failed (code ${warm.code}):\n${warm.stdout}${warm.stderr}`,
    )
  }
  // #1-P0 (jun-19/20): prove LSP grounding is actually LIVE after bootstrap.
  // The thin-strict family is fail-closed: proceeding with silent no-nav
  // degrade would violate the preset's contract.
  await verifyPyrightGrounding(ssh, log, cfg.preset ?? D.preset)
}

/**
 * Launch + bootstrap a box; return a live {@link BoxSession}. On ANY failure
 * after the instance exists, the box is terminated before the error propagates
 * (a half-provisioned box must never linger and burn money / hold a credential).
 */
export const provisionBox = async (cfg: FullRemoteConfig): Promise<BoxSession> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const onDemand = cfg.onDemand ?? false
  const keep = cfg.keep ?? false
  const marketLabel = onDemand ? "on-demand" : "spot"
  const log = cfg.onLog ?? (() => {})
  const awsFn = aws(spawn, region)

  log("[full-remote] ensuring security group (:22 from your IP)…")
  const sgId = await ensureSecurityGroup(
    awsFn,
    cfg.sgName ?? D.sgName,
    cfg.vpcId ?? D.vpcId,
    region,
  )
  const iid = await launchInstance(awsFn, cfg, sgId, ttl, marketLabel, log)

  const terminate = async (): Promise<void> => {
    if (keep) return
    const terminated = await awsFn(["ec2", "terminate-instances", "--instance-ids", iid])
    if (terminated.code !== 0) throw terminateFailure(iid, terminated)
  }

  try {
    log(`[full-remote] instance ${iid} — waiting for running…`)
    await awsFn(["ec2", "wait", "instance-running", "--instance-ids", iid])
    const ip = await describeInstancePublicIp(awsFn, iid)
    const host = `ubuntu@${ip}`
    log(`[full-remote] box up at ${ip}. Waiting for cloud-init (docker+bun+uv ~2-3min)…`)

    const ssh = makeSsh(spawn, keyPath, host)
    const session: BoxSession = {
      iid,
      ip,
      host,
      keyPath,
      region,
      spawn,
      log,
      ssh: (cmd, input, onData) => ssh(cmd, input, onData),
      aws: awsFn,
      terminate,
    }

    // Wait until SSH is reachable AND cloud-init finished installing bun.
    await waitForBoxReady(ssh, cfg)
    await bootstrapBox(session, cfg)
    return session
  } catch (err) {
    try {
      await terminate()
    } catch (cleanupErr) {
      throw cleanupFailure("bootstrap", iid, err, cleanupErr)
    }
    throw err
  }
}

/** Is this box fully bootstrapped (bun + swebench shim + synced src present)? A
 *  warm box from a prior run satisfies this; a half-provisioned one does not. */
const isBootstrapped = async (ssh: (cmd: string) => Promise<SpawnResult>): Promise<boolean> => {
  const probe = await ssh(
    "test -x ~/.bun/bin/bun && test -x ~/swebench-python && test -d ~/quanta/src && echo OK",
  )
  return probe.code === 0 && probe.stdout.includes("OK")
}

const describeInstancePublicIp = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  iid: string,
): Promise<string> => {
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--instance-ids",
    iid,
    "--query",
    "Reservations[0].Instances[0].PublicIpAddress",
    "--output",
    "text",
  ])
  const ip = oneLine(desc.stdout)
  if (ip === "" || ip === "None") {
    throw new Error(`[full-remote] no public IP for ${iid}: ${desc.stdout}`)
  }
  return ip
}

const waitForBoxReady = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  cfg: FullRemoteConfig,
): Promise<void> => {
  const sleep = cfg.sleep ?? defaultSleep
  const maxReadyPolls = cfg.maxReadyPolls ?? 30
  for (let i = 0; i < maxReadyPolls; i++) {
    const probe = await ssh(
      "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY",
    )
    if (probe.code === 0 && probe.stdout.includes("READY")) return
    await sleep(10_000)
  }
  throw new Error(
    "[full-remote] box never became ssh-reachable + bun-ready (check SG :22 / cloud-init)",
  )
}

const listRunningBoxes = async (
  cfg: FullRemoteConfig,
): Promise<Array<{ iid: string; ip: string }>> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--filters",
    ...RUNNING_BOX_FILTERS,
    "--query",
    "Reservations[].Instances[].[InstanceId,PublicIpAddress]",
    "--output",
    "text",
  ])
  if (desc.code !== 0) {
    throw new Error(`[full-remote] describe running boxes failed: ${desc.stderr || desc.stdout}`)
  }
  return desc.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && (p[0] ?? "").startsWith("i-") && p[1] !== "None" && p[1] !== "")
    .map(([iid, ip]) => ({ iid: iid as string, ip: ip as string }))
}

/** Running quanta-bench box count, regardless of idle/busy. Used by the single-
 *  box fail-closed guard: if ANY tagged box is already alive OR launching,
 *  callers must opt in before launching another one. */
export const countLiveBoxes = async (cfg: FullRemoteConfig): Promise<number> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--filters",
    ...LIVE_BOX_FILTERS,
    "--query",
    "Reservations[].Instances[].InstanceId",
    "--output",
    "text",
  ])
  if (desc.code !== 0) {
    throw new Error(`[full-remote] describe live boxes failed: ${desc.stderr || desc.stdout}`)
  }
  return desc.stdout
    .trim()
    .split(/\s+/)
    .filter((iid) => iid.startsWith("i-")).length
}

const busyProbeCommand =
  "if pgrep -f 'cli.ts run' >/dev/null 2>&1 || pgrep -f run_evaluation >/dev/null 2>&1; then echo BUSY; " +
  "elif test -d ~/.pool-grade.lock; then " +
  'if find ~/.pool-grade.lock -maxdepth 0 -mmin +10 >/dev/null 2>&1 && [ -n "$(find ~/.pool-grade.lock -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir ~/.pool-grade.lock 2>/dev/null; echo IDLE; else echo BUSY; fi; ' +
  "else echo IDLE; fi"

/**
 * Find a RUNNING, bootstrapped, IDLE quanta-bench box to REUSE — so a back-to-back
 * run skips the whole bootstrap. "Idle" = no `bench run` (patch-gen) and no
 * `run_evaluation` (docker grade) process is live on the box; attaching to a BUSY
 * box would race its grade and false-negative correct patches (the concurrent-
 * grade hazard). Returns the instance id of the first reusable box, or undefined
 * (⇒ the caller launches a fresh one). Best-effort: any AWS/ssh error ⇒ undefined.
 */
export const findIdleBox = async (cfg: FullRemoteConfig): Promise<string | undefined> => {
  const keyPath = cfg.keyPath ?? D.keyPath
  const spawn = cfg.spawn ?? defaultSpawn
  const rows = await listRunningBoxes(cfg).catch(() => undefined)
  if (rows === undefined) return undefined
  for (const { iid, ip } of rows) {
    const ssh = makeSsh(spawn, keyPath, `ubuntu@${ip}`)
    if (!(await isBootstrapped((c) => ssh(c)).catch(() => false))) continue
    // BUSY iff a grade process is live OR a FRESH grade lock is held. A lock with
    // NO live grade process AND older than 10min is a STALE leak — the orchestrator
    // was killed mid-grade so the box-side `finally rmdir` never ran (a real grade
    // starts its process within seconds, so a 10min-old lock with no process can
    // only be a crash leak). Reclaim it (rmdir) so the box isn't wasted to its TTL.
    const idle = await ssh(busyProbeCommand).catch(() => undefined)
    if (idle !== undefined && idle.code === 0 && idle.stdout.includes("IDLE")) return iid
  }
  return undefined
}

/** Probe one running box for operator-visible runtime state (bootstrapping vs
 *  idle/busy, plus the current or last workload snapshot when available). */
export const inspectBox = async (
  cfg: FullRemoteConfig,
  box: { iid: string; ip: string },
): Promise<BoxInspection> => {
  const keyPath = cfg.keyPath ?? D.keyPath
  const spawn = cfg.spawn ?? defaultSpawn
  const ssh = makeSsh(spawn, keyPath, `ubuntu@${box.ip}`)
  const bootstrapped = await isBootstrapped((c) => ssh(c)).catch(() => false)
  if (!bootstrapped) {
    return {
      lifecycle: "bootstrapping",
      bootstrapped: false,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "not-ready",
    }
  }
  const busyProbe = await ssh(busyProbeCommand).catch(() => undefined)
  if (busyProbe === undefined || busyProbe.code !== 0) {
    return {
      lifecycle: "unreachable",
      bootstrapped: true,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "read-failed",
    }
  }
  const busy = busyProbe.stdout.includes("BUSY")
  const snapshotRead = await readBoxSnapshot((cmd) => ssh(cmd))
  const probe = await readBoxRuntimeProbe((cmd) => ssh(cmd))
  const snapshotInspection = resolveSnapshotInspection(snapshotRead, probe, busy)
  return {
    lifecycle: busy ? "busy" : "idle",
    bootstrapped: true,
    busy,
    ...snapshotInspection,
    ...(probe !== undefined ? { probe } : {}),
  }
}

/**
 * Attach to an already-running box (REUSE) instead of launching. Resolves the ip,
 * verifies it is bootstrapped (re-bootstraps if a stale box lost its sync), and
 * returns a {@link BoxSession} whose `terminate` is a NO-OP — a reused box is left
 * WARM for the next run (it self-terminates at its EC2 TTL). The caller owns
 * idle-safety (see {@link findIdleBox}).
 */
export const attachBox = async (cfg: FullRemoteConfig, iid: string): Promise<BoxSession> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const log = cfg.onLog ?? (() => {})
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--instance-ids",
    iid,
    "--query",
    "Reservations[0].Instances[0].PublicIpAddress",
    "--output",
    "text",
  ])
  const ip = oneLine(desc.stdout)
  if (ip === "" || ip === "None") {
    throw new Error(`[pool] attach: no public IP for ${iid}: ${desc.stdout}`)
  }
  const host = `ubuntu@${ip}`
  const ssh = makeSsh(spawn, keyPath, host)
  const session: BoxSession = {
    iid,
    ip,
    host,
    keyPath,
    region,
    spawn,
    log,
    ssh: (cmd, input, onData) => ssh(cmd, input, onData),
    aws: awsFn,
    terminate: async () => {}, // reused box stays WARM (TTL reaps it)
  }
  log(`[pool] reusing warm box ${iid} (${ip})`)
  const preset = cfg.preset ?? D.preset
  if (!(await isBootstrapped((c) => ssh(c)))) {
    log(`[pool] box ${iid} missing bootstrap (stale) — re-bootstrapping…`)
    await bootstrapBox(session, cfg)
  } else if (presetRequiresLiveLspGrounding(preset)) {
    const groundingVerdict = await probePyrightGrounding((c) => ssh(c))
    if (!groundingVerdict.ready) {
      log(`[pool] box ${iid} lost live LSP grounding for preset ${preset} — re-bootstrapping…`)
      await bootstrapBox(session, cfg)
    } else {
      log(`[pool] warm box ${iid} LSP grounding ready — ${groundingVerdict.detail}`)
    }
  }
  return session
}

/**
 * Run ONE patch-gen + grading chunk on an already-provisioned box. Ships a fresh
 * stripped token, scps the dataset, runs `bench run` (grading SERIAL — concurrent
 * on-box grading false-negatives correct patches), then fetches report +
 * predictions + closure sidecar + (optional) trajectory back to durable local
 * storage. Owns NO box lifecycle — the caller terminates / reuses the box.
 */
/** Poll cadence for the detached run. The box does the work; we just re-check. */
const RUN_POLL_INTERVAL_MS = 15_000
/** Sentinel splitting the exit-code field from the fresh run.log tail in one poll. */
const RUN_EXIT_MARK = "==XQ-RUN-EXIT-XQ=="
const detachedLaunchCommand = (benchCmd: string, runLog: string, runExit: string): string =>
  `rm -f ${runExit}; setsid bash -c ${shq(`${benchCmd} > ${runLog} 2>&1; echo $? > ${runExit}`)} </dev/null >/dev/null 2>&1 & echo LAUNCHED`

const detachedProbeCommand = (runExit: string, runLog: string, seen: number): string =>
  `cat ${runExit} 2>/dev/null; echo "${RUN_EXIT_MARK}"; tail -n +${seen + 1} ${runLog} 2>/dev/null`

const parseDetachedProbe = (stdout: string): { exitCode?: number; freshLines: string[] } => {
  const mark = stdout.indexOf(RUN_EXIT_MARK)
  const exitField = (mark >= 0 ? stdout.slice(0, mark) : "").trim()
  const fresh = mark >= 0 ? stdout.slice(mark + RUN_EXIT_MARK.length) : ""
  return {
    ...(/^\d+$/.test(exitField) ? { exitCode: Number(exitField) } : {}),
    freshLines: fresh.split("\n").slice(0, -1),
  }
}

/**
 * Detached run + poll — ssh-resilience (RCA jun-20). Launches `benchCmd` under
 * `setsid` so it is its OWN session leader: an ssh teardown's SIGHUP never
 * reaches it, and the bench runs to completion regardless of any local-side
 * disconnect. Output goes to `runLog`, the exit code to a `runExit` sentinel.
 * Then we POLL with SHORT reconnecting ssh calls — a dropped/255 poll is
 * NON-FATAL (the next tick reconnects); no single long-lived ssh is ever held,
 * which is what was orphaning boxes (a 60-90min foreground stream dies on any
 * idle NAT-drop or active reset). Returns the bench's real exit code.
 */
const runBenchDetachedPoll = async (args: {
  ssh: (cmd: string, input?: string, onData?: (chunk: string) => void) => Promise<SpawnResult>
  benchCmd: string
  runLog: string
  runExit: string
  onLine: (chunk: string) => void
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
}): Promise<{ code: number }> => {
  const sleep = args.sleep ?? defaultSleep
  const launch = await args.ssh(detachedLaunchCommand(args.benchCmd, args.runLog, args.runExit))
  if (launch.code !== 0) {
    throw new Error(
      `[full-remote] detached bench launch failed (code ${launch.code}): ${launch.stderr}`,
    )
  }
  let seen = 0
  for (;;) {
    // ONE short ssh per tick: exit sentinel (empty until done) + NEW run.log lines.
    const probe = await args.ssh(detachedProbeCommand(args.runExit, args.runLog, seen))
    // A failed/dropped poll (ssh non-zero) is NON-FATAL — just retry next tick.
    if (probe.code === 0) {
      const parsed = parseDetachedProbe(probe.stdout)
      for (const line of parsed.freshLines) {
        args.onLine(`${line}\n`)
        seen += 1
      }
      if (parsed.exitCode !== undefined) return { code: parsed.exitCode }
    }
    await sleep(args.pollIntervalMs ?? RUN_POLL_INTERVAL_MS)
  }
}

/* ── REMOTE VERDICT PARSING (cohesive, PURE seam) ───────────────────────────
 * The one concern in this otherwise god-shaped file that is fully pure and
 * self-contained: turn a fetched remote report.json STRING into the four
 * disjoint verdict id-sets the chunk result + box snapshot are built from. It
 * touches no ssh / no lifecycle / no IO, so it is exported and unit-tested
 * directly ({@link ../../../../tests/unit/bugbash-fix-box-session.test.ts})
 * instead of only through a full provision+grade round-trip.
 *
 * SEAM NOTE (jun-20 #26): these four symbols + their callers (assignVerdictCounts,
 * the verdict-count branch in gradeChunkOnBox) are the natural cut line for a
 * future `./verdict-parse.ts` sibling module — kept in-file here to stay within
 * the behavior-preserving boundary (no import churn / no caller rewiring), but
 * the export-seam already isolates the concern for independent testing. */
export interface GradeChunkVerdicts {
  readonly resolved: string[]
  readonly unresolved: string[]
  readonly errored: string[]
  readonly emptyPatch: string[]
}

interface GradeChunkState {
  wroteRunningSnapshot: boolean
  finalExitCode?: number
  finalLastLogLine?: string
  finalResolvedCount?: number
  finalUnresolvedCount?: number
  finalErroredCount?: number
  finalEmptyPatchCount?: number
  finalRateLimited: boolean
  latestLogLine?: string
  sawLiveLogLine: boolean
  lastSnapshotFlushAt: number
  snapshotWrites: Promise<void>
  heartbeat?: ReturnType<typeof setInterval>
}

const createGradeChunkState = (): GradeChunkState => ({
  wroteRunningSnapshot: false,
  finalRateLimited: false,
  sawLiveLogLine: false,
  lastSnapshotFlushAt: 0,
  snapshotWrites: Promise.resolve(),
})

const createSnapshotBase = (
  params: GradeChunkParams,
  paths: ChunkPaths,
  artifactSuffix: string,
): Omit<BoxStatusSnapshot, "phase" | "updatedAt"> => {
  const selection = selectionMeta(params)
  return {
    mode: snapshotMode(params),
    ...(snapshotMode(params) === "pool" ? { runId: artifactSuffix } : {}),
    ...(params.accountLabel !== undefined && params.accountLabel !== ""
      ? { accountLabel: params.accountLabel }
      : {}),
    workload: workloadLabel(params),
    dataset: basename(params.datasetPath),
    instanceCount: selection.instanceCount,
    ...(selection.instancePreview !== undefined
      ? { instancePreview: selection.instancePreview }
      : {}),
    preset: params.preset,
    model: params.model,
    concurrency: params.concurrency,
    startedAt: new Date().toISOString(),
    runLogPath: paths.runLog,
    reportPath: paths.report,
    predictionsPath: paths.preds,
    observeDir: paths.observeDir,
    ...(params.recordTrajectory ? { trajectoryPath: paths.trajectory } : {}),
  }
}

const idleSnapshotExtras = (state: GradeChunkState): Partial<BoxStatusSnapshot> => ({
  ...(state.finalExitCode !== undefined ? { lastExitCode: state.finalExitCode } : {}),
  ...(state.finalResolvedCount !== undefined ? { resolvedCount: state.finalResolvedCount } : {}),
  ...(state.finalUnresolvedCount !== undefined
    ? { unresolvedCount: state.finalUnresolvedCount }
    : {}),
  ...(state.finalErroredCount !== undefined ? { erroredCount: state.finalErroredCount } : {}),
  ...(state.finalEmptyPatchCount !== undefined
    ? { emptyPatchCount: state.finalEmptyPatchCount }
    : {}),
  ...(state.finalRateLimited ? { rateLimited: true } : {}),
  ...(state.finalLastLogLine !== undefined && state.finalLastLogLine !== ""
    ? { lastLogLine: state.finalLastLogLine }
    : {}),
})

const createSnapshotController = (
  session: BoxSession,
  snapshotBase: Omit<BoxStatusSnapshot, "phase" | "updatedAt">,
  state: GradeChunkState,
): {
  publish: (phase: BoxStatusSnapshot["phase"], extras?: Partial<BoxStatusSnapshot>) => Promise<void>
  flush: (force?: boolean) => void
  makeLineStreamer: () => (chunk: string) => void
  start: () => Promise<void>
  stop: () => void
  finish: () => Promise<void>
} => {
  const { log } = session
  let snapshotWriteFailures = 0
  let snapshotWriteWarned = false
  const publish = async (
    phase: BoxStatusSnapshot["phase"],
    extras: Partial<BoxStatusSnapshot> = {},
  ): Promise<void> => {
    state.snapshotWrites = state.snapshotWrites.then(async () => {
      const write = await writeBoxSnapshot(session, {
        ...snapshotBase,
        phase,
        updatedAt: new Date().toISOString(),
        ...extras,
      })
      if (!write.ok) {
        snapshotWriteFailures += 1
        if (!snapshotWriteWarned) {
          snapshotWriteWarned = true
          log(`[box] snapshot publish failed (${phase}): ${write.error}`)
        }
      }
    })
    await state.snapshotWrites
  }

  const flush = (force = false): void => {
    if (!state.wroteRunningSnapshot) return
    const now = Date.now()
    if (!force && now - state.lastSnapshotFlushAt < SNAPSHOT_LINE_FLUSH_MS) return
    state.lastSnapshotFlushAt = now
    void publish("running", {
      ...(state.latestLogLine !== undefined && state.latestLogLine !== ""
        ? { lastLogLine: state.latestLogLine }
        : {}),
    })
  }

  const makeLineStreamer = (): ((chunk: string) => void) =>
    createLineStreamer((line) => {
      log(`[box] ${line}`)
      const normalized = normalizeStatusText(line)
      if (normalized !== "") {
        state.latestLogLine = normalized
        if (!state.sawLiveLogLine) {
          state.sawLiveLogLine = true
          flush(true)
          return
        }
      }
      flush()
    })

  const start = async (): Promise<void> => {
    await publish("running")
    state.wroteRunningSnapshot = true
    state.lastSnapshotFlushAt = Date.now()
    state.heartbeat = setInterval(() => flush(true), SNAPSHOT_HEARTBEAT_MS)
    state.heartbeat.unref?.()
  }

  const stop = (): void => {
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat)
  }

  const finish = async (): Promise<void> => {
    if (!state.wroteRunningSnapshot) return
    await publish("idle", idleSnapshotExtras(state))
    if (snapshotWriteFailures > 0) {
      log(
        `[box] snapshot publish degraded: ${snapshotWriteFailures} failure(s) total; ` +
          "later `box status` may report snapshot=write-failed.",
      )
    }
  }

  return { publish, flush, makeLineStreamer, start, stop, finish }
}

const acquireGradeLock = async (ssh: BoxSession["ssh"], iid: string): Promise<void> => {
  const lock = await ssh(`mkdir ${GRADE_LOCK_DIR} 2>/dev/null && echo LOCKED || echo BUSY`)
  if (lock.code !== 0) {
    throw new Error(
      `[full-remote] grade lock probe failed (code ${lock.code}): ${lock.stderr || lock.stdout}`,
    )
  }
  if (!lock.stdout.includes("LOCKED")) {
    throw new Error(
      `${POOL_BUSY_ERROR}: box ${iid} is grading another run (lock held) — not reusing`,
    )
  }
}

const releaseGradeLock = async (ssh: BoxSession["ssh"]): Promise<void> => {
  const released = await ssh(`rmdir ${GRADE_LOCK_DIR} 2>/dev/null`)
  if (released.code !== 0) {
    throw new Error(
      `${GRADE_LOCK_RELEASE_ERROR}: ${released.stderr.trim() || released.stdout.trim() || `rmdir exited ${released.code}`}`,
    )
  }
}

const uploadChunkDataset = async (args: {
  spawn: SpawnFn
  keyPath: string
  datasetPath: string
  host: string
  targetPath: string
}): Promise<void> => {
  const scpDs = await args.spawn("scp", [
    "-i",
    args.keyPath,
    "-o",
    "ConnectTimeout=15",
    args.datasetPath,
    `${args.host}:${args.targetPath}`,
  ])
  if (scpDs.code !== 0) {
    throw new Error(`[full-remote] scp dataset failed (code ${scpDs.code}): ${scpDs.stderr}`)
  }
}

const shipAccessToken = async (
  ssh: BoxSession["ssh"],
  log: (msg: string) => void,
  authJson: string,
): Promise<void> => {
  log("[full-remote] shipping stripped token (access_token only) over ssh stdin…")
  const shipped = await ssh(
    "mkdir -p ~/.quanta/auth && cat > ~/.quanta/auth/chatgpt.json && chmod 600 ~/.quanta/auth/chatgpt.json",
    stripToAccessToken(authJson),
  )
  if (shipped.code !== 0) {
    throw new Error(`[full-remote] token ship failed (code ${shipped.code}): ${shipped.stderr}`)
  }
}

const buildBenchCommand = (params: GradeChunkParams, paths: ChunkPaths): string => {
  const idsFlag =
    params.instanceIds && params.instanceIds.length > 0
      ? ` --instance ${shq(params.instanceIds.join(","))}`
      : ""
  const trajectoryRecordEnv = params.recordTrajectory
    ? `QUANTA_BENCH_RECORD_TRAJECTORY="${paths.trajectory}" `
    : ""
  return (
    `set -o pipefail; cd ~/quanta && export PATH="$HOME/.local/bin:$PATH"; QUANTA_BENCH_PRESET=${shq(params.preset)} QUANTA_PROVIDER=chatgpt-oauth QUANTA_SWEBENCH_PYTHON=1 ` +
    `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/swebench-python" ` +
    `QUANTA_SWEBENCH_NAMESPACE=swebench QUANTA_SWEBENCH_MAX_WORKERS=4 QUANTA_BENCH_CONCURRENCY=${params.concurrency} ` +
    params.forwardedBenchEnv +
    trajectoryRecordEnv +
    `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ${paths.dataset}${idsFlag} ` +
    `--observe-dir ${paths.observeDir} ` +
    `--model ${shq(params.model)} --predictions ${paths.preds} --report ${paths.report}`
  )
}

const runChunkBench = async (args: {
  ssh: BoxSession["ssh"]
  log: (msg: string) => void
  keyPath: string
  host: string
  paths: ChunkPaths
  params: GradeChunkParams
  onLine: (chunk: string) => void
}): Promise<number> => {
  args.log(
    `[full-remote] running patch-gen + grading on box (minutes). Watch live:\n` +
      `    ssh -i ${args.keyPath} ${args.host} 'tail -f ${args.paths.runLog}'`,
  )
  const remoteRun = await runBenchDetachedPoll({
    ssh: args.ssh,
    benchCmd: buildBenchCommand(args.params, args.paths),
    runLog: args.paths.runLog,
    runExit: args.paths.runLog.replace(/run\.log$/, "run.exit"),
    onLine: args.onLine,
  })
  return remoteRun.code
}

const fetchRemoteFile = async (ssh: BoxSession["ssh"], remotePath: string): Promise<SpawnResult> =>
  await ssh(`cat ${remotePath} 2>/dev/null`)

const saveLocalArtifact = (
  localPath: string,
  content: string,
  log: (msg: string) => void,
  label: string,
): string | undefined => {
  if (content.trim() === "") return undefined
  try {
    writeFileSync(localPath, content)
    log(`${label}: ${localPath}`)
    return localPath
  } catch {
    return undefined
  }
}

const fetchOptionalArtifact = async (args: {
  ssh: BoxSession["ssh"]
  remotePath: string
  localPath: string
  log: (msg: string) => void
  label: string
}): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteFile(args.ssh, args.remotePath)
    if (fetched.code !== 0) return undefined
    return saveLocalArtifact(args.localPath, fetched.stdout, args.log, args.label)
  } catch {
    return undefined
  }
}

const fetchChunkArtifacts = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  artifactSuffix: string
  recordTrajectory: boolean
  log: (msg: string) => void
}): Promise<{ reportText: string; reportPath?: string }> => {
  const fetchedReport = await fetchRemoteFile(args.ssh, args.paths.report)
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.preds,
    localPath: join(fullRemoteArtifactDir(), `preds-${args.artifactSuffix}.jsonl`),
    log: args.log,
    label: "[full-remote] predictions saved",
  })
  // ALWAYS pull the operational run.log back before the box is terminated. It
  // holds the only on-box diagnostics — LSP server-exit WARNs (crash/OOM),
  // throttle/429 markers, warm-up exhaustion — and the box is destroyed at
  // end-of-run, so a death NOT fetched here is a death investigated by live
  // ssh-babysitting (or lost entirely). Not gated on `recordTrajectory`: this is
  // the cheap, always-useful failure-forensics artifact, not the heavy cassette.
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.runLog,
    localPath: join(fullRemoteArtifactDir(), `runlog-${args.artifactSuffix}.log`),
    log: args.log,
    label: "[full-remote] run.log saved",
  })
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.report.replace(/\.json$/, ".closure-diagnostics.json"),
    localPath: join(fullRemoteArtifactDir(), `closure-${args.artifactSuffix}.json`),
    log: args.log,
    label: "[full-remote] closure diagnostics saved",
  })
  if (args.recordTrajectory) {
    await fetchOptionalArtifact({
      ssh: args.ssh,
      remotePath: args.paths.trajectory,
      localPath: join(fullRemoteArtifactDir(), `trajectory-${args.artifactSuffix}.jsonl`),
      log: args.log,
      label: "[full-remote] trajectory cassette saved",
    })
  }
  const reportPath = saveLocalArtifact(
    join(fullRemoteArtifactDir(), `report-${args.artifactSuffix}.json`),
    fetchedReport.stdout,
    args.log,
    "[full-remote] report saved",
  )
  if (reportPath !== undefined) {
    // Canonical SSOT mirror — same sink as the local batch's writeReport, so
    // full-remote per-box reports also collect in one fixed place.
    await mirrorReportToSsot(reportPath, fetchedReport.stdout)
    return {
      reportText: fetchedReport.stdout,
      reportPath,
    }
  }
  return {
    reportText: fetchedReport.stdout,
  }
}

export const emptyVerdicts = (): GradeChunkVerdicts => ({
  resolved: [],
  unresolved: [],
  errored: [],
  emptyPatch: [],
})

/** Parse a fetched remote report.json STRING into the four verdict id-sets.
 *  Tolerant: a missing/empty/invalid-JSON report yields {@link emptyVerdicts}
 *  (the run is then surfaced as a box-loss / no-verdict, never a crash). */
export const parseVerdicts = (reportText: string): GradeChunkVerdicts => {
  try {
    const v = loadVerdicts(JSON.parse(reportText))
    return {
      resolved: [...v.resolved],
      unresolved: [...v.unresolved],
      errored: [...v.errored],
      emptyPatch: [...v.emptyPatch],
    }
  } catch {
    return emptyVerdicts()
  }
}

/** Total instances that earned ANY verdict — 0 ⇒ the chunk produced nothing
 *  gradeable (drives the "no verdicts in report" diagnostics + box-loss path). */
export const verdictCount = (verdicts: GradeChunkVerdicts): number =>
  verdicts.resolved.length +
  verdicts.unresolved.length +
  verdicts.errored.length +
  verdicts.emptyPatch.length

const assignVerdictCounts = (state: GradeChunkState, verdicts: GradeChunkVerdicts): void => {
  state.finalResolvedCount = verdicts.resolved.length
  state.finalUnresolvedCount = verdicts.unresolved.length
  state.finalErroredCount = verdicts.errored.length
  state.finalEmptyPatchCount = verdicts.emptyPatch.length
}

const collectRunDiagnostics = async (args: {
  ssh: BoxSession["ssh"]
  runLogPath: string
  latestLogLine: string | undefined
  remoteRunCode: number
  emptyVerdicts: boolean
  log: (msg: string) => void
}): Promise<{ lastLogLine?: string; rateLimited: boolean }> => {
  const tail = await args.ssh(`tail -60 ${args.runLogPath} 2>/dev/null`)
  const lastLogLine = normalizeStatusText(
    tail.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ??
      args.latestLogLine ??
      "",
  )
  const rateLimited = detectRateLimit(tail.stdout)
  if (args.emptyVerdicts) {
    args.log(
      `[full-remote] ⚠️ no verdicts in report (run exit ${args.remoteRunCode}). Box run.log tail:`,
    )
    args.log(tail.stdout || "(run.log empty)")
  }
  if (rateLimited) {
    args.log(
      "[full-remote] ⚠️ rate-limit signal (generation_error / 429) in run log — caller should back off.",
    )
  }
  return {
    ...(lastLogLine !== "" ? { lastLogLine } : {}),
    rateLimited,
  }
}

export const gradeChunkOnBox = async (
  session: BoxSession,
  params: GradeChunkParams,
): Promise<FullRemoteResult> => {
  const { host, keyPath, spawn, log } = session
  const ssh = session.ssh.bind(session)
  const paths = params.paths ?? DEFAULT_CHUNK_PATHS
  const { artifactSuffix } = params
  // Boundary guard: artifactSuffix is the pool runId — the one caller value that
  // reaches the box paths UNQUOTED. Reject a shell-metachar suffix before any
  // remote command is built/run (shell-injection defense-in-depth).
  assertSafeArtifactSuffix(artifactSuffix)
  const state = createGradeChunkState()
  const snapshots = createSnapshotController(
    session,
    createSnapshotBase(params, paths, artifactSuffix),
    state,
  )
  let result: FullRemoteResult | undefined
  let primaryErr: unknown

  // ATOMIC busy-lock: `mkdir` fails non-zero if the dir already exists, so two
  // runs can NEVER grade the SAME reused box concurrently — which would race the
  // shared docker run_id cache and false-negative correct patches (the jun-19
  // concurrent-grade hazard). A freshly-launched box has no lock ⇒ acquires
  // cleanly; a busy box throws POOL_BUSY_ERROR (the pool drops it WITHOUT
  // terminating — it belongs to the other run). Released in the `finally`.
  await acquireGradeLock(ssh, session.iid)
  try {
    await snapshots.start()
    await uploadChunkDataset({
      spawn,
      keyPath,
      datasetPath: params.datasetPath,
      host,
      targetPath: paths.dataset,
    })
    await shipAccessToken(ssh, log, params.authJson)
    state.finalExitCode = await runChunkBench({
      ssh,
      log,
      keyPath,
      host,
      paths,
      params,
      onLine: snapshots.makeLineStreamer(),
    })
    await snapshots.publish("fetching", {
      ...(state.finalExitCode !== undefined ? { lastExitCode: state.finalExitCode } : {}),
    })
    log(`[full-remote] run finished (exit ${state.finalExitCode}); fetching report…`)
    const fetched = await fetchChunkArtifacts({
      ssh,
      paths,
      artifactSuffix,
      recordTrajectory: params.recordTrajectory,
      log,
    })
    const parsed = parseVerdicts(fetched.reportText)
    assignVerdictCounts(state, parsed)
    const diagnostics = await collectRunDiagnostics({
      ssh,
      runLogPath: paths.runLog,
      latestLogLine: state.latestLogLine,
      remoteRunCode: state.finalExitCode ?? -1,
      emptyVerdicts: verdictCount(parsed) === 0,
      log,
    })
    if (diagnostics.lastLogLine !== undefined) {
      state.finalLastLogLine = diagnostics.lastLogLine
    }
    state.finalRateLimited = diagnostics.rateLimited
    result = {
      ...(fetched.reportPath !== undefined ? { reportPath: fetched.reportPath } : {}),
      ...parsed,
      ...(diagnostics.rateLimited ? { rateLimited: true } : {}),
    }
  } catch (err) {
    primaryErr = err
  } finally {
    snapshots.stop()
  }
  let cleanupErr: unknown
  try {
    // Release the grade lock so the box can be reused for the next chunk/run.
    await releaseGradeLock(ssh)
  } catch (err) {
    cleanupErr = err
  }
  await snapshots.finish()
  if (cleanupErr !== undefined) {
    if (primaryErr !== undefined) {
      throw new Error(
        `[full-remote] grade lock cleanup failed for ${session.iid}: primary=${errMessage(primaryErr)}; cleanup=${errMessage(cleanupErr)}`,
      )
    }
    throw cleanupErr
  }
  if (primaryErr !== undefined) {
    throw primaryErr
  }
  return result ?? {}
}
