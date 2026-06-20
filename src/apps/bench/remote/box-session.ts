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
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadVerdicts } from "../analyze/verdicts"
import { benchHome } from "../corpus"
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
  /** Bench preset. Default `agentless-v2-safe`. */
  readonly preset?: string
  /** Model id (predictions/report naming). Default `gpt-5.4`. */
  readonly model?: string
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
  preset: "agentless-v2-safe",
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

/** Box-side directory used as an ATOMIC grade lock (`mkdir` is atomic + fails if
 *  it exists). Held for the duration of one chunk's grade so a reused box can
 *  never run two grades at once. */
const GRADE_LOCK_DIR = "~/.pool-grade.lock"

/** Thrown by {@link gradeChunkOnBox} when the box is already grading (lock held).
 *  The pool drops the box WITHOUT terminating it (it belongs to the other run). */
export const POOL_BUSY_ERROR = "POOL_BOX_BUSY"

/** Single-quote a value for safe interpolation into a remote bash command
 *  string. Without this, a preset/model/instance-id containing a space, `;`,
 *  `$(...)`, backtick, or `|` would break out of the intended command (the
 *  token is piped over STDIN and is safe, but these env/flag values are not). */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

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
    // first instance doesn't eat that latency. Fail-OPEN (`|| true`): grounding
    // is best-effort — a pyright install hiccup must never abort the bootstrap
    // (`set -eux`) and kill the whole bench run. When absent the agent simply
    // degrades to no nav tools (the pre-jun-19 behaviour).
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
 * so this verdict drives a LOUD non-fatal WARNING when it did not land — making
 * an inert-grounding run OBSERVABLE instead of silent. INERT ⇒ ready:false.
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

/**
 * A live, bootstrapped EC2 box. The connection primitives (`ssh`, `aws`, raw
 * `spawn`) are bound to the resolved host/region/key so a caller never re-derives
 * them. `terminate` is idempotent-enough (a double terminate just errors on the
 * second AWS call, swallowed by callers). Created ONLY by {@link provisionBox}.
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
  /** Terminate the box (no-op when `keep`). NEVER throws. */
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
}

const aws =
  (spawn: SpawnFn, region: string) =>
  (args: readonly string[]): Promise<SpawnResult> =>
    spawn("aws", ["--region", region, ...args])

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
    "ResourceType=instance,Tags=[{Key=Name,Value=quanta-bench-full}]",
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
  // #1-P0 (jun-19): LSP-grounding launch-proof. Non-fatal — grounding is an
  // enhancement; emit a LOUD warning if pyright is not launchable so an inert
  // run is observable, never silent theater.
  const pyrightProbe = await ssh(
    'export PATH="$HOME/.local/bin:$PATH"; if command -v pyright-langserver >/dev/null 2>&1; then pyright --version 2>&1 | tail -1; else echo PYRIGHT_MISSING; exit 7; fi',
  )
  const groundingVerdict = pyrightLaunchProofVerdict(pyrightProbe)
  if (!groundingVerdict.ready) {
    log(
      "[full-remote] ⚠️  WARNING: pyright-langserver is NOT launchable on the box — LSP grounding " +
        "(lsp_definition / lsp_references) is INERT this run: the localize steer fires but every nav call " +
        'returns "unavailable" (silent no-nav degrade). The userData pyright install likely failed. ' +
        `probe: ${groundingVerdict.detail}`,
    )
  } else {
    log(`[full-remote] LSP grounding ready — ${groundingVerdict.detail}`)
  }
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
    if (!keep)
      await awsFn(["ec2", "terminate-instances", "--instance-ids", iid]).catch(() => undefined)
  }

  try {
    log(`[full-remote] instance ${iid} — waiting for running…`)
    await awsFn(["ec2", "wait", "instance-running", "--instance-ids", iid])
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
    const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const maxReadyPolls = cfg.maxReadyPolls ?? 30
    let ready = false
    for (let i = 0; i < maxReadyPolls; i++) {
      const probe = await ssh(
        "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY",
      )
      if (probe.code === 0 && probe.stdout.includes("READY")) {
        ready = true
        break
      }
      await sleep(10_000)
    }
    if (!ready) {
      throw new Error(
        "[full-remote] box never became ssh-reachable + bun-ready (check SG :22 / cloud-init)",
      )
    }

    await bootstrapBox(session, cfg)
    return session
  } catch (err) {
    await terminate()
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

/**
 * Find a RUNNING, bootstrapped, IDLE quanta-bench box to REUSE — so a back-to-back
 * run skips the whole bootstrap. "Idle" = no `bench run` (patch-gen) and no
 * `run_evaluation` (docker grade) process is live on the box; attaching to a BUSY
 * box would race its grade and false-negative correct patches (the concurrent-
 * grade hazard). Returns the instance id of the first reusable box, or undefined
 * (⇒ the caller launches a fresh one). Best-effort: any AWS/ssh error ⇒ undefined.
 */
export const findIdleBox = async (cfg: FullRemoteConfig): Promise<string | undefined> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--filters",
    "Name=tag:Name,Values=quanta-bench-full",
    "Name=instance-state-name,Values=running",
    "--query",
    "Reservations[].Instances[].[InstanceId,PublicIpAddress]",
    "--output",
    "text",
  ]).catch(() => undefined)
  if (desc === undefined || desc.code !== 0) return undefined
  const rows = desc.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && (p[0] ?? "").startsWith("i-") && p[1] !== "None" && p[1] !== "")
  for (const [iid, ip] of rows) {
    const ssh = makeSsh(spawn, keyPath, `ubuntu@${ip}`)
    if (!(await isBootstrapped((c) => ssh(c)).catch(() => false))) continue
    const idle = await ssh(
      "if pgrep -f 'cli.ts run' >/dev/null 2>&1 || pgrep -f run_evaluation >/dev/null 2>&1 || test -d ~/.pool-grade.lock; then echo BUSY; else echo IDLE; fi",
    ).catch(() => undefined)
    if (idle !== undefined && idle.code === 0 && idle.stdout.includes("IDLE")) return iid
  }
  return undefined
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
  if (!(await isBootstrapped((c) => ssh(c)))) {
    log(`[pool] box ${iid} missing bootstrap (stale) — re-bootstrapping…`)
    await bootstrapBox(session, cfg)
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
export const gradeChunkOnBox = async (
  session: BoxSession,
  params: GradeChunkParams,
): Promise<FullRemoteResult> => {
  const { host, keyPath, spawn, log } = session
  const ssh = session.ssh.bind(session)
  const paths = params.paths ?? DEFAULT_CHUNK_PATHS
  const { preset, model, concurrency, artifactSuffix } = params
  const makeLineStreamer = (): ((chunk: string) => void) =>
    createLineStreamer((line) => log(`[box] ${line}`))

  // ATOMIC busy-lock: `mkdir` fails non-zero if the dir already exists, so two
  // runs can NEVER grade the SAME reused box concurrently — which would race the
  // shared docker run_id cache and false-negative correct patches (the jun-19
  // concurrent-grade hazard). A freshly-launched box has no lock ⇒ acquires
  // cleanly; a busy box throws POOL_BUSY_ERROR (the pool drops it WITHOUT
  // terminating — it belongs to the other run). Released in the `finally`.
  const lock = await ssh(`mkdir ${GRADE_LOCK_DIR} 2>/dev/null && echo LOCKED || echo BUSY`)
  if (lock.code !== 0) {
    throw new Error(
      `[full-remote] grade lock probe failed (code ${lock.code}): ${lock.stderr || lock.stdout}`,
    )
  }
  if (!lock.stdout.includes("LOCKED")) {
    throw new Error(
      `${POOL_BUSY_ERROR}: box ${session.iid} is grading another run (lock held) — not reusing`,
    )
  }
  try {
    // scp the dataset for THIS chunk.
    const scpDs = await spawn("scp", [
      "-i",
      keyPath,
      "-o",
      "ConnectTimeout=15",
      params.datasetPath,
      `${host}:${paths.dataset}`,
    ])
    if (scpDs.code !== 0) {
      throw new Error(`[full-remote] scp dataset failed (code ${scpDs.code}): ${scpDs.stderr}`)
    }

    // Ship the STRIPPED token over ssh STDIN (never an arg / temp file). chmod 600:
    // quanta's auth loader REFUSES a loose-perm token file.
    log("[full-remote] shipping stripped token (access_token only) over ssh stdin…")
    const shipped = await ssh(
      "mkdir -p ~/.quanta/auth && cat > ~/.quanta/auth/chatgpt.json && chmod 600 ~/.quanta/auth/chatgpt.json",
      stripToAccessToken(params.authJson),
    )
    if (shipped.code !== 0) {
      throw new Error(`[full-remote] token ship failed (code ${shipped.code}): ${shipped.stderr}`)
    }

    const idsFlag =
      params.instanceIds && params.instanceIds.length > 0
        ? ` --instance ${shq(params.instanceIds.join(","))}`
        : ""
    log(
      `[full-remote] running patch-gen + grading on box (minutes). Watch live:\n` +
        `    ssh -i ${keyPath} ${host} 'tail -f ${paths.runLog}'`,
    )
    const trajectoryRecordEnv = params.recordTrajectory
      ? `QUANTA_BENCH_RECORD_TRAJECTORY="${paths.trajectory}" `
      : ""
    // `set -o pipefail` so a failed bench run propagates through the `tee`.
    // GRADING STAYS SERIAL (no QUANTA_SWEBENCH_GRADE_CONCURRENCY) — concurrent
    // on-box grading was MEASURED to false-negative correct patches (2026-06-19:
    // GRADE_CONCURRENCY=6 box scored 0/5; same predictions re-graded serially
    // scored 4/5). patch-gen stays concurrent (QUANTA_BENCH_CONCURRENCY).
    const remoteRun = await ssh(
      // Prepend uv's install dir to PATH so the in-process repro executor can find
      // `uvx`; a non-interactive ssh does NOT source ~/.profile.
      `set -o pipefail; cd ~/quanta && export PATH="$HOME/.local/bin:$PATH"; QUANTA_BENCH_PRESET=${shq(preset)} QUANTA_PROVIDER=chatgpt-oauth QUANTA_SWEBENCH_PYTHON=1 ` +
        `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/swebench-python" ` +
        `QUANTA_SWEBENCH_NAMESPACE=swebench QUANTA_SWEBENCH_MAX_WORKERS=4 QUANTA_BENCH_CONCURRENCY=${concurrency} ` +
        params.forwardedBenchEnv +
        trajectoryRecordEnv +
        `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ${paths.dataset}${idsFlag} ` +
        `--observe-dir ${paths.observeDir} ` +
        `--model ${shq(model)} --predictions ${paths.preds} --report ${paths.report} 2>&1 | tee ${paths.runLog}`,
      undefined,
      makeLineStreamer(),
    )

    log(`[full-remote] run finished (exit ${remoteRun.code}); fetching report…`)
    const fetched = await ssh(`cat ${paths.report} 2>/dev/null`)

    // Fetch the raw predictions BEFORE termination — the report only carries
    // patchBytes (size), so without this the actual patch text is lost once the
    // box dies. Best-effort (never fatal).
    try {
      const preds = await ssh(`cat ${paths.preds} 2>/dev/null`)
      if (preds.code === 0 && preds.stdout.trim() !== "") {
        const localPreds = join(fullRemoteArtifactDir(), `preds-${artifactSuffix}.jsonl`)
        writeFileSync(localPreds, preds.stdout)
        log(`[full-remote] predictions saved: ${localPreds}`)
      }
    } catch (_ignore) {
      /* best-effort — patch text is a diagnostic nicety, not the run result */
    }
    // Closure-diagnostics sidecar (closure measurement metrics). The box writes it
    // next to report.json when QUANTA_BENCH_CLOSURE_DIAG is on.
    try {
      const sidecar = await ssh(
        `cat ${paths.report.replace(/\.json$/, ".closure-diagnostics.json")} 2>/dev/null`,
      )
      if (sidecar.code === 0 && sidecar.stdout.trim() !== "") {
        const localSidecar = join(fullRemoteArtifactDir(), `closure-${artifactSuffix}.json`)
        writeFileSync(localSidecar, sidecar.stdout)
        log(`[full-remote] closure diagnostics saved: ${localSidecar}`)
      }
    } catch (_ignore) {
      /* best-effort — the measurement sidecar is a diagnostic, not the verdict */
    }
    // LLM-trajectory cassette (operator opt-in) — makes a FAILED run replayable.
    if (params.recordTrajectory) {
      try {
        const cassette = await ssh(`cat ${paths.trajectory} 2>/dev/null`)
        if (cassette.code === 0 && cassette.stdout.trim() !== "") {
          const localCassette = join(fullRemoteArtifactDir(), `trajectory-${artifactSuffix}.jsonl`)
          writeFileSync(localCassette, cassette.stdout)
          log(`[full-remote] trajectory cassette saved: ${localCassette}`)
        }
      } catch (_ignore) {
        /* best-effort — replay cassette is a diagnostic, not the run result */
      }
    }
    // The on-box `bench run` writes OUR report shape (perInstance[].passed) —
    // loadVerdicts handles BOTH that and the swebench-harness shape.
    let parsed = {
      resolved: [] as string[],
      unresolved: [] as string[],
      errored: [] as string[],
      emptyPatch: [] as string[],
    }
    try {
      const v = loadVerdicts(JSON.parse(fetched.stdout))
      parsed = {
        resolved: [...v.resolved],
        unresolved: [...v.unresolved],
        errored: [...v.errored],
        emptyPatch: [...v.emptyPatch],
      }
    } catch {
      // unparseable / missing report — diagnose below
    }

    // Save the report locally so it survives box termination. Only set
    // savedReport when a file was actually written.
    let savedReport: string | undefined
    if (fetched.stdout.trim() !== "") {
      const localReport = join(fullRemoteArtifactDir(), `report-${artifactSuffix}.json`)
      try {
        writeFileSync(localReport, fetched.stdout)
        savedReport = localReport
        log(`[full-remote] report saved: ${localReport}`)
      } catch (_ignore) {
        /* best-effort local save */
      }
    }

    const empty =
      parsed.resolved.length +
        parsed.unresolved.length +
        parsed.errored.length +
        parsed.emptyPatch.length ===
      0
    // Always pull the run.log tail: it surfaces a no-verdict failure AND lets us
    // detect a shared-OAuth rate limit (generation_error / 429) so the caller can
    // back off instead of hammering the throttled login.
    const tail = await ssh(`tail -60 ${paths.runLog} 2>/dev/null`)
    const rateLimited = detectRateLimit(tail.stdout)
    if (empty) {
      log(`[full-remote] ⚠️ no verdicts in report (run exit ${remoteRun.code}). Box run.log tail:`)
      log(tail.stdout || "(run.log empty)")
    }
    if (rateLimited) {
      log(
        "[full-remote] ⚠️ rate-limit signal (generation_error / 429) in run log — caller should back off.",
      )
    }

    return {
      ...(savedReport !== undefined ? { reportPath: savedReport } : {}),
      ...parsed,
      ...(rateLimited ? { rateLimited: true } : {}),
    }
  } finally {
    // Release the grade lock so the box can be reused for the next chunk/run.
    await ssh(`rmdir ${GRADE_LOCK_DIR} 2>/dev/null`).catch(() => undefined)
  }
}
