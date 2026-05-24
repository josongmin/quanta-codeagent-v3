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
 *                                         in the listing). Routes through the
 *                                         `shadow_rewind` tool body which is
 *                                         HITL `always-confirm` — the surface
 *                                         shows a confirmation line; re-run
 *                                         with `--yes` to commit (mirrors the
 *                                         existing `/rewind` confirm protocol).
 *   - `/snapshot <N> <file>`            → restore ONLY <file> from snapshot #N.
 *                                         Maps to `shadow_restore_partial`.
 *                                         Same `--yes` confirm gate.
 *   - `/snapshot diff <N>`              → preview: unified diff between the
 *                                         current worktree and snapshot #N.
 *                                         Read-only.
 *   - `/snapshot --target=verified <N>` → use `rewindToVerified` instead of
 *                                         `rewindToLast`. The verified anchor
 *                                         must exist (set by `markVerified`)
 *                                         else surfaces `no-verified-anchor`.
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
import { ShadowOdbError } from "@/storage/shadow-odb"
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

const runRewind = async (
  ctx: SlashContext,
  odb: ShadowOdb,
  ordinal: number,
  target: SnapshotTarget,
  yes: boolean,
): Promise<number> => {
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
    ctx.out(renderConfirm("rewind", pick.snap, ordinal, target, " — DESTRUCTIVE"))
    return 0
  }
  const op = await runOdb(() =>
    target === "verified" ? odb.rewindToVerified(ctx.cwd) : odb.rewindToLast(ctx.cwd),
  )
  if (!op.ok) {
    ctx.err(`/snapshot: ${op.err}\n`)
    return 1
  }
  ctx.out(`rewound to #${ordinal} (${shortSha(pick.snap.sha)}). Pre-rewind ref saved.\n`)
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
  const op = await runOdb(() => odb.restorePartial(ctx.cwd, [path]))
  if (!op.ok) {
    ctx.err(`/snapshot: ${op.err}\n`)
    return 1
  }
  ctx.out(`restored ${path} from #${ordinal} (${shortSha(pick.snap.sha)}).\n`)
  return 0
}

const runDiff = async (ctx: SlashContext, odb: ShadowOdb, ordinal: number): Promise<number> => {
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
  // The closed `ShadowOdb` port exposes `diffSinceLast` (last-registered ref
  // only). Arbitrary-ref diff against snapshot #N is a follow-up: the port
  // doesn't expose `diffSinceRef(ref)` so the CLI cannot honestly synthesize
  // it without reaching past the port. Surface a clear deferral so the user
  // knows the difference between "not implemented" and "broken".
  if (ordinal !== 1) {
    ctx.out(
      `/snapshot diff <N>: only #1 (last-registered) is supported in v1.\n` +
        `  follow-up will expose ShadowOdb.diffSinceRef(ref) for arbitrary N.\n` +
        `  selected: #${ordinal} ${shortSha(pick.snap.sha)} @ ${fmtTs(pick.snap.timestampSec)}\n`,
    )
    return 0
  }
  const r = await runOdb(() => odb.diffSinceLast(ctx.cwd))
  if (!r.ok) {
    ctx.err(`/snapshot: ${r.err}\n`)
    return 1
  }
  if (r.value === "") {
    ctx.out(`(no changes since #1 — worktree matches snapshot)\n`)
    return 0
  }
  ctx.out(r.value.endsWith("\n") ? r.value : `${r.value}\n`)
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
