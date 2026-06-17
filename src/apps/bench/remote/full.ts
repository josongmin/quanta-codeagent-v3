/**
 * Full-remote executor (ADR-0536 §6 / P3) — runs BOTH patch-gen and grading on
 * a fresh EC2 box, for fully-detached long runs.
 *
 * ⚠️ SECURITY: full-remote needs an LLM credential ON the box (it runs the
 * agent, which executes model-generated code). The hardening here is mandatory:
 *   - only the SHORT-LIVED `access_token` is shipped — `refresh_token`/`id_token`
 *     are STRIPPED ({@link stripToAccessToken}); a leaked access_token expires
 *     and cannot mint new ones;
 *   - the token is piped over `ssh` STDIN (never a CLI arg / `ps` / local temp
 *     file / rsync artifact);
 *   - the box enforces IMDSv2 hop-1 (no metadata-credential pivot) + a
 *     `shutdown -h +<ttl>` self-terminate backstop, and is ALWAYS terminated
 *     (even on failure).
 *
 * NOTE: actually invoking `run()` ships a credential across a trust boundary and
 * may be blocked by the harness; that's by design. The executor + its security
 * invariants are fully unit-tested offline via an injected {@link SpawnFn}.
 */
import { writeFileSync } from "node:fs"
import { loadVerdicts } from "../analyze/verdicts"
import { defaultSpawn, type SpawnFn } from "./backend"

export interface FullRemoteConfig {
  /** Local quanta repo to rsync to the box (excludes node_modules/.git). */
  readonly repoDir: string
  /** RAW chatgpt.json content (the caller reads it; we strip it here). */
  readonly authJson: string
  /** Local swebench instances.jsonl. */
  readonly datasetPath: string
  /** Subset to run (default: all rows in the dataset). */
  readonly instanceIds?: readonly string[]
  /** Bench preset. Default `agentless-v1`. */
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
}

const D = {
  region: "ap-northeast-2",
  ami: "ami-0afe1fd15675c3f15",
  instanceType: "c7i.8xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  diskGb: 600,
  ttlMinutes: 180,
  preset: "agentless-v1",
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

/** Single-quote a value for safe interpolation into a remote bash command
 *  string. Without this, a preset/model/instance-id containing a space, `;`,
 *  `$(...)`, backtick, or `|` would break out of the intended command (the
 *  token is piped over STDIN and is safe, but these env/flag values are not). */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const userData = (ttl: number): string =>
  [
    "#!/bin/bash",
    "set -eux",
    `shutdown -h +${ttl}`,
    "apt-get update -y && apt-get install -y docker.io git curl unzip",
    "systemctl enable --now docker",
    "usermod -aG docker ubuntu",
    "su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    "su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'",
  ].join("\n")

export interface FullRemoteResult {
  readonly reportPath?: string
  readonly resolved?: readonly string[]
  readonly unresolved?: readonly string[]
  readonly errored?: readonly string[]
  readonly emptyPatch?: readonly string[]
  readonly dryRun?: boolean
  readonly plan?: readonly string[]
}

export const createFullRemoteBackend = (
  cfg: FullRemoteConfig,
): { run: () => Promise<FullRemoteResult> } => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const preset = cfg.preset ?? D.preset
  const model = cfg.model ?? D.model
  // Patch-gen concurrency on the remote box (c7i.8xlarge = 32 vCPU). Default 6 —
  // the binding limit is the shared gpt-5.4 login rate, not box CPU. Serial
  // (the prior implicit default) ran ~10 min/instance and risked the TTL on a
  // 12+ instance run. Overridable via QUANTA_FULL_REMOTE_CONCURRENCY; clamped to
  // [1, 16]. Forwarded to the remote `bench run` via QUANTA_BENCH_CONCURRENCY.
  const concurrency = Math.max(
    1,
    Math.min(16, Math.trunc(Number(process.env.QUANTA_FULL_REMOTE_CONCURRENCY)) || 6),
  )
  const keep = cfg.keep ?? false
  const log = cfg.onLog ?? (() => {})

  const sgName = cfg.sgName ?? D.sgName
  const vpcId = cfg.vpcId ?? D.vpcId
  const aws = (args: readonly string[]) => spawn("aws", ["--region", region, ...args])
  /** ssh helper bound to the resolved host (`ubuntu@<ip>`). Token, when given,
   *  goes over STDIN — never an argv. Short connect-timeout so a closed :22
   *  fails fast instead of the default ~2min hang.
   *
   *  NOTE on keepalive: a tight `ServerAliveInterval=15 / CountMax=4` (60s grace)
   *  was tried to reap a one-off 65-min dead-box hang, but it KILLED healthy long
   *  runs — during docker grading the box is CPU-saturated and sshd cannot answer
   *  keepalive probes within 60s, so ssh tore down healthy sessions (`exit 255`,
   *  empty run.log) on 2/2 grading calls. The long grading session must tolerate
   *  a busy-but-alive box, so we do NOT set an aggressive keepalive here; the rare
   *  truly-dead-box hang is bounded by the OUTER `timeout` the caller wraps. */
  const sshTo = (host: string, remoteCmd: string, input?: string) =>
    spawn(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        host,
        remoteCmd,
      ],
      ...(input !== undefined ? [{ input }] : []),
    )

  /** Find-or-create the SG + open :22. Without an attached SG the box lands in
   *  the default SG (no inbound :22) ⇒ ssh times out.
   *
   *  Ingress is `0.0.0.0/0` (public) — the operator opted into it; SSH is
   *  key-only (no password auth on the Ubuntu AMI) and the box is throwaway +
   *  TTL-terminated, so public :22 is acceptable and avoids a brittle public-IP
   *  lookup. Tighten via a tagged SG if you need IP-restricted. */
  const ensureSecurityGroup = async (): Promise<string> => {
    const found = await aws([
      "ec2",
      "describe-security-groups",
      "--filters",
      `Name=group-name,Values=${sgName}`,
      "--query",
      "SecurityGroups[0].GroupId",
      "--output",
      "text",
    ])
    // A FAILED describe is a connectivity/credentials problem — do NOT mask it by
    // blindly creating (the SG likely already exists). Surface it; a re-run when
    // the network recovers will find the existing SG.
    if (found.code !== 0) {
      throw new Error(
        `[full-remote] could not reach EC2 (${region}) — network/credentials? : ${found.stderr.trim()}`,
      )
    }
    let sgId = oneLine(found.stdout)
    if (sgId === "" || sgId === "None") {
      const created = await aws([
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
    // Open :22 publicly. A DUPLICATE rule returns non-zero (tolerated — already
    // open). A REAL failure (wrong VPC / perms) fails fast: otherwise the box
    // launches into an SG with no :22 and the only symptom is a misleading
    // ssh/cloud-init timeout minutes later.
    const auth = await aws([
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

  const plan = (): readonly string[] => [
    `[dry-run] would launch ${cfg.instanceType ?? D.instanceType} spot (IMDSv2 hop-1, shutdown -h +${ttl})`,
    `[dry-run] would rsync ${cfg.repoDir} (excl node_modules/.git) + bun install`,
    "[dry-run] would ship STRIPPED token over ssh stdin (access_token only; refresh/id dropped)",
    `[dry-run] would run: bun run bench run --swebench <dataset> --grade-backend local (preset=${preset}, concurrency=${concurrency})`,
    "[dry-run] would scp report+observe back, then terminate the box",
  ]

  const run = async (): Promise<FullRemoteResult> => {
    if (cfg.dryRun) return { dryRun: true, plan: plan() }

    log("[full-remote] ensuring security group (:22 from your IP)…")
    const sgId = await ensureSecurityGroup()

    // Instance-type fallbacks on capacity errors. The subnet/AZ is DELIBERATELY
    // NOT pinned unless the caller sets `subnetId` — pinning an AZ is the #1
    // cause of `InsufficientInstanceCapacity`; letting AWS choose the AZ + a few
    // type fallbacks makes the launch resilient.
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
      "--instance-market-options",
      '{"MarketType":"spot"}',
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
      log(`[full-remote] launching hardened spot box (${it}, IMDSv2 hop-1, TTL)…`)
      const launch = await aws(launchArgs(it))
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
      // A non-capacity error won't be fixed by a different type ⇒ fail fast.
      throw new Error(`[full-remote] run-instances failed (code ${launch.code}): ${launch.stderr}`)
    }
    if (iid === "") {
      throw new Error(
        `[full-remote] no spot capacity across ${typeCandidates.join(", ")}: ${lastErr}`,
      )
    }

    const terminate = async (): Promise<void> => {
      if (!keep) await aws(["ec2", "terminate-instances", "--instance-ids", iid])
    }

    log(`[full-remote] instance ${iid} — waiting for running…`)
    try {
      await aws(["ec2", "wait", "instance-running", "--instance-ids", iid])
      const desc = await aws([
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

      // Wait until SSH is reachable AND cloud-init finished installing bun —
      // instance-running ≠ bootstrap-done. Poll up to ~5min.
      const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
      const maxReadyPolls = cfg.maxReadyPolls ?? 30
      let ready = false
      for (let i = 0; i < maxReadyPolls; i++) {
        const probe = await sshTo(
          host,
          "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY",
        )
        if (probe.code === 0 && probe.stdout.includes("READY")) {
          ready = true
          break
        }
        await sleep(10_000)
      }
      if (!ready)
        throw new Error(
          "[full-remote] box never became ssh-reachable + bun-ready (check SG :22 / cloud-init)",
        )

      log(
        "[full-remote] bootstrapped. Syncing src/ + config (SURGICAL — the monorepo's apps/crates/native are GBs and the bench needs only src)…",
      )
      // The repo is a monorepo (top-level apps/ alone is ~4GB). The bench agent
      // imports ONLY `src/` (via `@/*` aliases). Ship src/ minus stale `*.js`
      // build artifacts, plus the root config files, then `bun install`. Whole-
      // repo rsync overran the ssh connection ("Connection reset by peer").
      const sshOpts = `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15`
      await sshTo(host, "mkdir -p ~/quanta")
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
      // Root config files needed for `bun install` + `@/*` path aliases.
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
      // `set -o pipefail` so a FAILED install propagates through the `tail`
      // (without it the pipeline exit is tail's 0 — masking a partial install).
      const installed = await sshTo(
        host,
        "set -o pipefail; cd ~/quanta && ~/.bun/bin/bun install 2>&1 | tail -25",
      )
      if (installed.code !== 0) {
        throw new Error(
          `[full-remote] bun install failed (code ${installed.code}):\n${installed.stdout}${installed.stderr}`,
        )
      }
      // PHANTOM DEPS: the repo imports several packages that are NOT declared in
      // package.json/bun.lock (they only exist in a dev's local node_modules), so
      // a clean install misses them and the bench dies with "Cannot find package".
      // We can't ship the macOS node_modules (native ABI ≠ linux), so install the
      // known phantoms on the box (all pure-JS). FIXME: declare these in the repo's
      // package.json — a fresh `bun install` breaks without them.
      const phantoms = PHANTOM_DEPS.join(" ")
      log(`[full-remote] installing phantom deps (undeclared in package.json): ${phantoms}…`)
      const added = await sshTo(
        host,
        `set -o pipefail; cd ~/quanta && ~/.bun/bin/bun add ${phantoms} 2>&1 | tail -15`,
      )
      if (added.code !== 0) {
        throw new Error(
          `[full-remote] bun add (phantom deps) failed (code ${added.code}):\n${added.stdout}${added.stderr}`,
        )
      }

      // Grading toolchain: the bench grades via QUANTA_SWEBENCH_PYTHON_BIN, which
      // must be the `swebench-python` SHIM (uvx --from swebench python "$@"), NOT
      // raw uvx (uvx can't take `-c "import swebench"`). The shim lives in tools/
      // locally (not shipped), so create it on the box + WARM the uvx cache so the
      // 60s import-probe doesn't time out on swebench's first (multi-second) pull.
      log(
        "[full-remote] creating swebench-python shim + warming uvx swebench cache (first pull ~30-60s)…",
      )
      // Write the shim via ssh STDIN (verbatim — no printf/escaping hell). `$HOME`
      // and `$@` stay literal in the file; bash expands them at shim RUN time.
      const shim =
        '#!/usr/bin/env bash\nexec "$HOME/.local/bin/uvx" --from swebench --python 3.11 --quiet python "$@"\n'
      const wrote = await sshTo(host, "cat > ~/swebench-python && chmod +x ~/swebench-python", shim)
      if (wrote.code !== 0) {
        throw new Error(
          `[full-remote] writing swebench-python shim failed (code ${wrote.code}): ${wrote.stderr}`,
        )
      }
      const warm = await sshTo(
        host,
        'set -o pipefail; ~/swebench-python -c "import swebench; print(swebench.__version__)" 2>&1 | tail -3',
      )
      if (warm.code !== 0) {
        throw new Error(
          `[full-remote] swebench toolchain warm failed (code ${warm.code}):\n${warm.stdout}${warm.stderr}`,
        )
      }

      const scpDs = await spawn("scp", [
        "-i",
        keyPath,
        "-o",
        "ConnectTimeout=15",
        cfg.datasetPath,
        `${host}:~/instances.jsonl`,
      ])
      if (scpDs.code !== 0) {
        throw new Error(`[full-remote] scp dataset failed (code ${scpDs.code}): ${scpDs.stderr}`)
      }

      // Ship the STRIPPED token over ssh STDIN (never an arg / temp file).
      log("[full-remote] shipping stripped token (access_token only) over ssh stdin…")
      const shipped = await sshTo(
        host,
        // chmod 600: quanta's auth loader REFUSES a token file with loose perms
        // (umask makes `cat >` create it 0664) — without this the agent aborts
        // with 0 turns / empty patch ("token file has loose permissions").
        "mkdir -p ~/.quanta/auth && cat > ~/.quanta/auth/chatgpt.json && chmod 600 ~/.quanta/auth/chatgpt.json",
        stripToAccessToken(cfg.authJson),
      )
      if (shipped.code !== 0) {
        throw new Error(`[full-remote] token ship failed (code ${shipped.code}): ${shipped.stderr}`)
      }

      // Run patch-gen + grading ON the box (full remote). Tee to ~/run.log so the
      // operator can watch live from another terminal.
      // `--instance` is a comma-OR filter on the box (see matchesInstanceFilter):
      // ALL ids go through, shell-quoted as one arg.
      const idsFlag =
        cfg.instanceIds && cfg.instanceIds.length > 0
          ? ` --instance ${shq(cfg.instanceIds.join(","))}`
          : ""
      log(
        `[full-remote] running patch-gen + grading on box (minutes). Watch live:\n` +
          `    ssh -i ${keyPath} ${host} 'tail -f ~/run.log'`,
      )
      // Propagate trajectory recording to the box when the operator opted in
      // locally. Force a FIXED box-side path so the cassette can be fetched back
      // deterministically (see below). Absent ⇒ empty ⇒ box run unchanged.
      const recordTrajectory =
        process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== undefined &&
        process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "" &&
        process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "0"
      const trajectoryRecordEnv = recordTrajectory
        ? `QUANTA_BENCH_RECORD_TRAJECTORY="$HOME/quanta/bench-trajectory.jsonl" `
        : ""
      // `set -o pipefail` so a failed bench run propagates through the `tee`
      // (otherwise the pipeline's exit code is tee's, always 0 — masking failures).
      //
      // NOTE (2026-06-17): a detached `setsid`+sentinel-poll variant was tried to
      // survive local network blips during the multi-minute run, but it REGRESSED
      // (the poll repeatedly saw the box unreachable and gave up with an empty
      // run.log on 2/2 boxes, while the proven blocking form succeeded on ~6 prior
      // waves the same day). Reverted to the single blocking ssh. Flaky/blip box
      // loss is handled by CALLER-LEVEL retry (relaunch a fresh box), not by
      // holding/ polling one box. A correct detached variant needs offline testing,
      // not live trial-and-error.
      const remoteRun = await sshTo(
        host,
        `set -o pipefail; cd ~/quanta && QUANTA_BENCH_PRESET=${shq(preset)} QUANTA_PROVIDER=chatgpt-oauth QUANTA_SWEBENCH_PYTHON=1 ` +
          `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/swebench-python" ` +
          // Force prebuilt-image pull (the proven fast path) — on x64 the bench's
          // arch-aware default is "none" (slow local conda build).
          `QUANTA_SWEBENCH_NAMESPACE=swebench QUANTA_SWEBENCH_MAX_WORKERS=4 QUANTA_BENCH_CONCURRENCY=${concurrency} ` +
          // Optional LLM-trajectory recording (default-OFF). When the operator
          // sets QUANTA_BENCH_RECORD_TRAJECTORY locally, propagate it to the box
          // so the run records a replayable cassette (fetched back below) — makes
          // a FAILED remote run replayable/forkable from any turn after the fact.
          trajectoryRecordEnv +
          `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ~/instances.jsonl${idsFlag} ` +
          `--model ${shq(model)} --predictions ~/preds.jsonl --report ~/report.json 2>&1 | tee ~/run.log`,
      )

      log(`[full-remote] run finished (exit ${remoteRun.code}); fetching report…`)
      const fetched = await sshTo(host, "cat ~/report.json 2>/dev/null")

      // Also fetch the raw predictions (our generated patches) BEFORE the box is
      // terminated — the report only carries `patchBytes` (size), so without this
      // the actual patch text is lost forever once the box dies, making any later
      // oracle (gold-patch) diff / failure-mode classification impossible. Saved
      // to a local sidecar; best-effort (never fatal to the run result).
      try {
        const preds = await sshTo(host, "cat ~/preds.jsonl 2>/dev/null")
        if (preds.code === 0 && preds.stdout.trim() !== "") {
          const localPreds = `/tmp/full-remote-preds-${iid}.jsonl`
          writeFileSync(localPreds, preds.stdout)
          log(`[full-remote] predictions saved: ${localPreds}`)
        }
      } catch (_ignore) {
        /* best-effort — patch text is a diagnostic nicety, not the run result */
      }
      // Fetch the LLM-trajectory cassette when recording was requested — makes a
      // FAILED remote run replayable/forkable from any turn after the box dies.
      if (recordTrajectory) {
        try {
          const cassette = await sshTo(host, "cat ~/quanta/bench-trajectory.jsonl 2>/dev/null")
          if (cassette.code === 0 && cassette.stdout.trim() !== "") {
            const localCassette = `/tmp/full-remote-trajectory-${iid}.jsonl`
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
      let reportJson: unknown
      try {
        reportJson = JSON.parse(fetched.stdout)
        const v = loadVerdicts(reportJson)
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
      // `savedReport` when a file was actually written — otherwise the result's
      // reportPath would be a dangling ENOENT for the caller.
      let savedReport: string | undefined
      if (fetched.stdout.trim() !== "") {
        const localReport = `/tmp/full-remote-report-${iid}.json`
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
      if (empty) {
        // No verdicts — pull the tail of the on-box run log so the failure is
        // visible BEFORE we terminate the box.
        const tail = await sshTo(host, "tail -40 ~/run.log 2>/dev/null")
        log(`[full-remote] ⚠️ no verdicts in report (run exit ${remoteRun.code}). Box run.log tail:`)
        log(tail.stdout || "(run.log empty)")
      }

      log("[full-remote] terminating box…")
      await terminate()
      return { ...(savedReport !== undefined ? { reportPath: savedReport } : {}), ...parsed }
    } catch (err) {
      await terminate().catch(() => undefined)
      throw err
    }
  }

  return { run }
}
