/**
 * `/snapshot` — shadow-store snapshot UX (ADR-0122, Hermes Agent `/rollback` parity).
 *
 * Surfaces the {@link ShadowOdb} port + the three `shadow_*` tools at the CLI so
 * a user can browse / preview / restore workspace snapshots without round-
 * tripping through the model.
 *
 * Sub-commands:
 *
 *   - `/snapshot`                       → list snapshots (numbered, sha + ISO ts).
 *                                         Newest-first per `listSnapshots`.
 *   - `/snapshot <N>`                   → rewind to snapshot #N (1-based ordinal
 *                                         in the listing) via the ordinal-
 *                                         addressed `ShadowOdb.rewindToRef`
 *                                         (WS-D jul-10). The confirm line pins
 *                                         the sha; the port re-verifies it
 *                                         (`expectSha`) so the success line
 *                                         always describes the snapshot that
 *                                         ACTUALLY landed. Re-run with `--yes`
 *                                         to commit (mirrors `/rewind`).
 *   - `/snapshot <N> <file>`            → restore ONLY <file> from snapshot #N
 *                                         (`restorePartialFromRef`). Same
 *                                         `--yes` confirm gate.
 *   - `/snapshot diff <N>`              → preview: unified diff between the
 *                                         current worktree and snapshot #N
 *                                         (`diffSinceRef`). Read-only.
 *   - `/snapshot --target=verified <N>` → assert #N IS the verified anchor and
 *                                         rewind to it; a mismatch between the
 *                                         ordinal and the verified ref fails
 *                                         closed (exit 1) instead of silently
 *                                         rewinding to a different snapshot
 *                                         than the copy claims.
 *
 * Naming note (subtle decision — see Report):
 *
 *   The task asked for `/rewind`; the registry ALREADY has a `/rewind` that
 *   rewinds the SESSION TRANSCRIPT (Claude Code v1.7196 pattern, `rewind-cmd.ts`).
 *   Registering a second `/rewind` would silently shadow it in
 *   `BUILTINS_BY_NAME` (last-write-wins Map) and break every existing
 *   `tests/unit/cli/rewind-cmd.test.ts` case. The constraint "existing slash
 *   commands unaffected" wins, so the shadow-store UX is registered as
 *   `/snapshot`. The underlying skill (`src/skill/system-skills/rewind/`)
 *   still triggers on the word "rewind" via the LLM activation path — that
 *   surface is unaffected.
 *
 * Default-OFF posture (RFC §1.2):
 *
 *   - `ctx.shadowOdb` absent ⇒ "shadow store not configured" + exit 0.
 *     The surface (REPL / one-shot) is responsible for wiring the port from
 *     `AgentConfig.shadowOdb`. Without the wire, the command is a clean no-op
 *     — byte-identical to NOT registering it.
 *   - Destructive ops (rewind / restore-partial) ALWAYS need `--yes` on the
 *     CLI — the model-facing HITL gate lives at the tool layer; the slash
 *     surface runs OUTSIDE that gate (no agent loop) so the confirmation
 *     prompt lives here. Mirrors the existing `/rewind --yes` posture.
 *
 * Slice contract: lives in `src/apps/cli/**`. Imports `@/storage/shadow-odb`
 * (the port + types) and `@/tool/shadow` is NOT imported — the tool layer
 * speaks the same `ShadowOdb` port, so reaching directly through the port
 * keeps the slash surface decoupled from the tool registry's runtime
 * envelope. Pure functions are exported under `__test` for unit isolation.
 */

import type { ShadowOdb, SnapshotMetadata } from "@/storage/shadow-odb"
import { SHADOW_LAST_VERIFIED_REF, ShadowOdbError } from "@/storage/shadow-odb"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0122 shadow store wire. Absent ⇒ `/snapshot` prints "shadow store
     *  not configured" and exits 0 (default-OFF parity). Injected by the
     *  surface (REPL) from `AgentConfig.shadowOdb`. */
    readonly shadowOdb?: ShadowOdb | undefined
  }
}

/* ------------------------------------------------------------------ */
/* argv parsing (pure)                                                 */
/* ------------------------------------------------------------------ */

/** Parsed `/snapshot` argv. Closed discriminated union so the dispatch
 *  body is exhaustive at compile time. */
export type SnapshotArgs =
  | { readonly kind: "list" }
  | {
      readonly kind: "rewind"
      readonly ordinal: number
      readonly target: SnapshotTarget
      readonly yes: boolean
    }
  | {
      readonly kind: "restore-partial"
      readonly ordinal: number
      readonly path: string
      readonly target: SnapshotTarget
      readonly yes: boolean
    }
  | { readonly kind: "diff"; readonly ordinal: number }
  | { readonly kind: "err"; readonly message: string }

export type SnapshotTarget = "last" | "verified"

const VALID_TARGETS: ReadonlySet<string> = new Set(["last", "verified"])

interface ParsedFlags {
  yes: boolean
  target: SnapshotTarget
  positional: readonly string[]
  err?: string
}

const parseFlags = (args: readonly string[]): ParsedFlags => {
  let yes = false
  let target: SnapshotTarget = "last"
  const positional: string[] = []
  for (const a of args) {
    if (a === "--yes" || a === "-y") {
      yes = true
      continue
    }
    if (a.startsWith("--target=")) {
      const v = a.slice("--target=".length)
      if (!VALID_TARGETS.has(v)) {
        return {
          yes,
          target,
          positional,
          err: `invalid --target value: ${v} (valid: last | verified)`,
        }
      }
      target = v as SnapshotTarget
      continue
    }
    if (a.startsWith("--")) {
      return { yes, target, positional, err: `unknown flag: ${a}` }
    }
    positional.push(a)
  }
  return { yes, target, positional }
}

/** Parse a 1-based ordinal token. Rejects non-positive, non-integer, NaN. */
const parseOrdinal = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

export const parseSnapshotArgs = (args: readonly string[]): SnapshotArgs => {
  const flags = parseFlags(args)
  if (flags.err !== undefined) return { kind: "err", message: flags.err }
  const tokens = flags.positional
  // Bare `/snapshot` → list.
  if (tokens.length === 0) return { kind: "list" }
  const head = tokens[0] as string
  // `/snapshot diff <N>` — read-only preview, no --yes needed.
  if (head === "diff") {
    if (tokens.length !== 2) {
      return { kind: "err", message: "usage: /snapshot diff <N>" }
    }
    const n = parseOrdinal(tokens[1] as string)
    if (n === null) return { kind: "err", message: `invalid snapshot ordinal: ${tokens[1]}` }
    return { kind: "diff", ordinal: n }
  }
  const n = parseOrdinal(head)
  if (n === null) {
    return { kind: "err", message: `unknown subcommand or invalid ordinal: ${head}` }
  }
  // `/snapshot <N>` → full rewind.
  if (tokens.length === 1) {
    return { kind: "rewind", ordinal: n, target: flags.target, yes: flags.yes }
  }
  // `/snapshot <N> <file>` → partial restore (single path). Multiple paths
  // is intentionally NOT supported on the CLI surface — power-users can
  // call `shadow_restore_partial` through the model for batch restore.
  if (tokens.length === 2) {
    const path = tokens[1] as string
    if (path.length === 0) return { kind: "err", message: "empty path" }
    return { kind: "restore-partial", ordinal: n, path, target: flags.target, yes: flags.yes }
  }
  return {
    kind: "err",
    message:
      "too many arguments (use /snapshot, /snapshot <N>, /snapshot <N> <file>, or /snapshot diff <N>)",
  }
}

/* ------------------------------------------------------------------ */
/* rendering (pure)                                                    */
/* ------------------------------------------------------------------ */

/** Format a unix-second timestamp deterministically (UTC ISO, ms dropped).
 *  Mirrors `shadow_snapshots` rendering so the two surfaces agree on the
 *  string form. */
const fmtTs = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")

/** Short 12-hex sha for table display — same width `shadow_snapshots` uses. */
const shortSha = (sha: string): string => (sha.length <= 12 ? sha : sha.slice(0, 12))

/** Render the numbered snapshot list. Pure — the caller writes the result. */
export const renderSnapshotList = (snaps: readonly SnapshotMetadata[]): string => {
  if (snaps.length === 0) return "(no snapshots)\n"
  const lines = snaps.map(
    (s, i) =>
      `  ${String(i + 1).padStart(3)}. ${shortSha(s.sha)}  ${fmtTs(s.timestampSec)}  ${s.ref}`,
  )
  const head = `${snaps.length} snapshot${snaps.length === 1 ? "" : "s"}:`
  return `${head}\n${lines.join("\n")}\n`
}

/** Locate snapshot #ordinal in the listing. Returns the metadata or an
 *  error message. Used by every destructive op so the "out of range" path
 *  is identical across rewind / restore-partial / diff. */
export const pickByOrdinal = (
  snaps: readonly SnapshotMetadata[],
  ordinal: number,
):
  | { readonly ok: true; readonly snap: SnapshotMetadata }
  | { readonly ok: false; readonly err: string } => {
  if (ordinal < 1 || ordinal > snaps.length) {
    return {
      ok: false,
      err: `snapshot #${ordinal} out of range (have ${snaps.length} snapshot${snaps.length === 1 ? "" : "s"})`,
    }
  }
  // `pickByOrdinal` is 1-based; the bounds check above guarantees a hit.
  return { ok: true, snap: snaps[ordinal - 1] as SnapshotMetadata }
}

/** Format the destructive-confirm preview line. Includes the resolved
 *  snapshot's sha + timestamp so the user can sanity-check before re-running
 *  with `--yes`. */
const renderConfirm = (
  op: string,
  snap: SnapshotMetadata,
  ordinal: number,
  target: SnapshotTarget,
  extra: string,
): string => {
  const verifiedTag = target === "verified" ? " [target=verified]" : ""
  return `[${op}: #${ordinal} ${shortSha(snap.sha)} @ ${fmtTs(snap.timestampSec)}${verifiedTag}${extra}]\n  re-run with --yes to confirm.\n`
}

/* ------------------------------------------------------------------ */
/* port-call helpers (effectful)                                       */
/* ------------------------------------------------------------------ */

/** Wrap a `ShadowOdb` call so `ShadowOdbError`s collapse to a typed error
 *  output (mirrors the shadow_* tools' contract: `<code>: <message>`).
 *  Non-typed throws bubble (programmer bug). */
const runOdb = async <T>(
  fn: () => Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly err: string }
> => {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (e instanceof ShadowOdbError) return { ok: false, err: `${e.code}: ${e.message}` }
    throw e
  }
}

/* ------------------------------------------------------------------ */
/* dispatch bodies (per sub-command)                                   */
/* ------------------------------------------------------------------ */

const runList = async (ctx: SlashContext, odb: ShadowOdb): Promise<number> => {
  const r = await runOdb(() => odb.listSnapshots(ctx.cwd))
  if (!r.ok) {
    ctx.err(`/snapshot: ${r.err}\n`)
    return 1
  }
  ctx.out(renderSnapshotList(r.value))
  return 0
}

/** WS-D fail-closed capability guard: an injected port object that predates
 *  the ordinal extension must never be silently downgraded to a wrong-target
 *  rewind. Structural (runtime) check — TS enforces this for first-party
 *  wiring, this guard covers duck-typed test/embedder ports. */
const supportsOrdinalOps = (odb: ShadowOdb): boolean =>
  typeof odb.rewindToRef === "function" &&
  typeof odb.restorePartialFromRef === "function" &&
  typeof odb.diffSinceRef === "function"

const ORDINAL_UNSUPPORTED_MSG =
  "/snapshot: this shadow store port does not support ordinal addressing — refusing to guess a target (nothing was changed)\n"

/** `--target=verified` + ordinal must agree: the addressed listing entry has
 *  to BE the verified anchor, otherwise the two designators point at
 *  different snapshots and any success copy would lie about one of them. */
const verifiedMismatch = (
  ctx: SlashContext,
  snaps: readonly SnapshotMetadata[],
  pick: SnapshotMetadata,
  ordinal: number,
): boolean => {
  if (pick.ref === SHADOW_LAST_VERIFIED_REF) return false
  const verIdx = snaps.findIndex((s) => s.ref === SHADOW_LAST_VERIFIED_REF)
  const hint =
    verIdx >= 0
      ? `the verified anchor is #${verIdx + 1} (${shortSha(snaps[verIdx]?.sha ?? "")})`
      : "no verified anchor exists (markVerified never ran)"
  ctx.err(
    `/snapshot: #${ordinal} (${pick.ref}) is not the verified anchor — ${hint}. ` +
      `Re-run with that ordinal, or drop --target=verified.\n`,
  )
  return true
}

const runRewind = async (
  ctx: SlashContext,
  odb: ShadowOdb,
  ordinal: number,
  target: SnapshotTarget,
  yes: boolean,
): Promise<number> => {
  if (!supportsOrdinalOps(odb)) {
    ctx.err(ORDINAL_UNSUPPORTED_MSG)
    return 1
  }
  const listed = await runOdb(() => odb.listSnapshots(ctx.cwd))
  if (!listed.ok) {
    ctx.err(`/snapshot: ${listed.err}\n`)
    return 1
  }
  const pick = pickByOrdinal(listed.value, ordinal)
  if (!pick.ok) {
    ctx.err(`/snapshot: ${pick.err}\n`)
    return 1
  }
  // Verified-target × ordinal coherence (fail-closed on disagreement).
  if (target === "verified" && verifiedMismatch(ctx, listed.value, pick.snap, ordinal)) {
    return 1
  }
  if (!yes) {
    ctx.out(renderConfirm("rewind", pick.snap, ordinal, target, " — DESTRUCTIVE"))
    return 0
  }
  // Ordinal-addressed restore through the port. `expectSha` pins the sha we
  // just showed/validated: if the list shifted since (new snapshot, ref
  // advanced), the port fails closed with `snapshot-moved` — the success
  // line below can only ever describe the snapshot that actually landed.
  const op = await runOdb(() => odb.rewindToRef(ctx.cwd, ordinal, { expectSha: pick.snap.sha }))
  if (!op.ok) {
    ctx.err(`/snapshot: ${op.err}\n`)
    return 1
  }
  const receipt = op.value
  ctx.out(
    `rewound to #${ordinal} (${shortSha(receipt.sha)} ${receipt.ref}). Pre-rewind ref saved.\n`,
  )
  return 0
}

const runRestorePartial = async (
  ctx: SlashContext,
  odb: ShadowOdb,
  ordinal: number,
  path: string,
  target: SnapshotTarget,
  yes: boolean,
): Promise<number> => {
  if (target === "verified") {
    // Mirrors the tool layer's v1 restriction so the CLI surface and the
    // model-facing tool give the same error code/text.
    ctx.err(
      "/snapshot: no-verified-anchor: partial restore from 'verified' is not supported in v1 — use /snapshot <N> with --target=verified for full-tree, or omit --target for path-scoped from last.\n",
    )
    return 1
  }
  if (!supportsOrdinalOps(odb)) {
    ctx.err(ORDINAL_UNSUPPORTED_MSG)
    return 1
  }
  const listed = await runOdb(() => odb.listSnapshots(ctx.cwd))
  if (!listed.ok) {
    ctx.err(`/snapshot: ${listed.err}\n`)
    return 1
  }
  const pick = pickByOrdinal(listed.value, ordinal)
  if (!pick.ok) {
    ctx.err(`/snapshot: ${pick.err}\n`)
    return 1
  }
  if (!yes) {
    ctx.out(renderConfirm("restore-partial", pick.snap, ordinal, target, ` — file: ${path}`))
    return 0
  }
  // Ordinal-addressed path restore (expectSha pins the confirmed sha — see
  // runRewind). The returned receipt is what the success line describes.
  const op = await runOdb(() =>
    odb.restorePartialFromRef(ctx.cwd, ordinal, [path], { expectSha: pick.snap.sha }),
  )
  if (!op.ok) {
    ctx.err(`/snapshot: ${op.err}\n`)
    return 1
  }
  ctx.out(`restored ${path} from #${ordinal} (${shortSha(op.value.sha)} ${op.value.ref}).\n`)
  return 0
}

const runDiff = async (ctx: SlashContext, odb: ShadowOdb, ordinal: number): Promise<number> => {
  if (!supportsOrdinalOps(odb)) {
    ctx.err(ORDINAL_UNSUPPORTED_MSG)
    return 1
  }
  // Ordinal-addressed preview through the port (WS-D UUX-6-18 — the v1
  // "only #1" shrug exited 0 without any effect; arbitrary N is real now).
  // The port resolves the ordinal inside its lock and returns the snapshot it
  // ACTUALLY diffed against — the header derives from that receipt.
  const r = await runOdb(() => odb.diffSinceRef(ctx.cwd, ordinal))
  if (!r.ok) {
    ctx.err(`/snapshot: ${r.err}\n`)
    return 1
  }
  const { snap, diff } = r.value
  ctx.out(`diff vs #${ordinal} (${shortSha(snap.sha)} ${snap.ref} @ ${fmtTs(snap.timestampSec)})\n`)
  if (diff === "") {
    ctx.out(`(no changes — worktree matches snapshot #${ordinal})\n`)
    return 0
  }
  ctx.out(diff.endsWith("\n") ? diff : `${diff}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* registered SlashCommand                                             */
/* ------------------------------------------------------------------ */

export const snapshotCmd: SlashCommand = {
  name: "/snapshot",
  describe:
    "Browse/restore shadow snapshots (ADR-0122). /snapshot [<N> [<file>] | diff <N>] [--yes] [--target=verified]",
  category: "session",
  async run(args, ctx) {
    const odb = ctx.shadowOdb
    if (odb === undefined) {
      ctx.out("/snapshot: shadow store not configured\n")
      return 0
    }
    const parsed = parseSnapshotArgs(args)
    if (parsed.kind === "err") {
      ctx.err(`/snapshot: ${parsed.message}\n`)
      return 1
    }
    switch (parsed.kind) {
      case "list":
        return runList(ctx, odb)
      case "rewind":
        return runRewind(ctx, odb, parsed.ordinal, parsed.target, parsed.yes)
      case "restore-partial":
        return runRestorePartial(ctx, odb, parsed.ordinal, parsed.path, parsed.target, parsed.yes)
      case "diff":
        return runDiff(ctx, odb, parsed.ordinal)
    }
  },
  complete(_args, _partial, _ctx) {
    return [
      { value: "diff", kind: "argument", description: "preview diff vs snapshot" },
      { value: "--yes", kind: "argument", description: "skip confirm prompt" },
      { value: "--target=verified", kind: "argument", description: "use last verified anchor" },
    ]
  },
}

/* ------------------------------------------------------------------ */
/* test seam                                                           */
/* ------------------------------------------------------------------ */

export const __test = {
  parseFlags,
  parseOrdinal,
  fmtTs,
  shortSha,
}
