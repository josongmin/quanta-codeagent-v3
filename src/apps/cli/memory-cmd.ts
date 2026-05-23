/**
 * `/memory` slash command — browse / recall / delete the durable memory store.
 *
 * Surface contract (subcommand-style):
 *
 *   - `/memory`                       → recent memories (top 10, by recency)
 *   - `/memory list [--tier=…]`       → list capped at QUANTA_MEMORY_LIST_MAX
 *                                       (default 20). `--tier=episodic|semantic`
 *                                       filters to that tier.
 *   - `/memory search <query>`        → semantic + lexical recall via
 *                                       `PersistentStorePort.recall`. When an
 *                                       `EmbedderPort` is wired the query is
 *                                       embedded and cosine similarity drives
 *                                       the ranking (paraphrase-robust); absent
 *                                       embedder ⇒ lexical/tag/freshness only.
 *   - `/memory show <id>`             → full entry detail (incl. tags, score
 *                                       proxy = importance, size in bytes).
 *   - `/memory delete <id> [--yes]`   → hard-delete. Without `--yes`, prints
 *                                       the confirmation line — a REPL surface
 *                                       can pre-confirm by passing `--yes`.
 *   - `/memory stats`                 → counts per tier + total bytes.
 *
 * Default-OFF posture (RFC §1.2):
 *
 *   - `QUANTA_MEMORY_SLASH` defaults to `"1"` (command registered). Setting
 *     `"0"` removes `/memory` from BUILTINS at load time — same effect as never
 *     registering it; no silent runtime fallthrough.
 *   - `QUANTA_MEMORY_LIST_MAX` caps the `list` page size (default 20). The
 *     cap is honored even when `--tier=…` filters.
 *   - Without an injected {@link MemorySlashState} on
 *     {@link SlashContext.memory}, the command prints "memory store not wired
 *     in this surface" and exits 0 (byte-identical to NOT registering).
 *
 * Slice contract: lives in `src/apps/cli/**` — allowed to import `@/memory`
 * (biome explicitly carves out @/memory for CLI surface commands). The body
 * NEVER imports `@/llm` — embeddings are produced by an injected
 * {@link EmbedderPort} so the slice fence holds.
 *
 * Audit notes (Catalog §raw-similarity hide):
 *   The catalog asks us to HIDE raw similarity scores from PROMPT injection
 *   (model-facing prompt context). They are OK to surface to the USER looking
 *   at their OWN memory store. We render `importance` (the normalized 0..1
 *   weight) as the visible score proxy; the underlying cosine similarity is
 *   never even computed at the slash-command layer.
 */

import {
  type EmbedderPort,
  MEMORY_TIERS,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryTier,
  type PersistentStorePort,
} from "@/memory"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Surface-time state injected by the REPL / session composer so `/memory`
 *  can read the live store. Absent ⇒ command prints "not wired" and exits 0,
 *  symmetric with `/skills` and `/side`. */
export interface MemorySlashState {
  /** The durable {@link PersistentStorePort} (`InMemoryStore` or `SqliteStore`). */
  readonly store: PersistentStorePort
  /** Optional embedder for `search` semantic recall. Absent ⇒ lexical-only
   *  fallback (still works — `recall` degrades gracefully). */
  readonly embedder?: EmbedderPort
  /** Override env access (test seam). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** `/memory` browse + recall + delete state — see `./memory-cmd.ts`. */
    readonly memory?: MemorySlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* env knobs                                                           */
/* ------------------------------------------------------------------ */

const isOn = (v: string | undefined, fallback: string): boolean => {
  const raw = (v ?? fallback).trim().toLowerCase()
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no"
}

/** Whether `/memory` should be registered. Honors an injected env source
 *  (test seam) first, then `process.env`. Default `"1"` (registered). */
export const isMemorySlashEnabled = (
  envSource?: Readonly<Record<string, string | undefined>>,
): boolean => {
  const e = envSource ?? process.env
  return isOn(e.QUANTA_MEMORY_SLASH, "1")
}

const DEFAULT_LIST_MAX = 20
const HARD_LIST_CAP = 200

/** Resolve the `list` page size cap. Bad / negative / overflow values fall
 *  back to {@link DEFAULT_LIST_MAX}; honored cap is also clamped at
 *  {@link HARD_LIST_CAP} so a runaway env can't OOM the REPL. */
const listMax = (envSource?: Readonly<Record<string, string | undefined>>): number => {
  const e = envSource ?? process.env
  const raw = e.QUANTA_MEMORY_LIST_MAX
  if (raw === undefined) return DEFAULT_LIST_MAX
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return DEFAULT_LIST_MAX
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIST_MAX
  return Math.min(n, HARD_LIST_CAP)
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SHORT_ID_LEN = 12
const TIER_PAD = 10
const PREVIEW_MAX = 64

const TIER_SET = new Set<string>(MEMORY_TIERS)

const shortId = (id: string): string => (id.length <= SHORT_ID_LEN ? id : id.slice(0, SHORT_ID_LEN))

/** ISO-minutes for a header line: `2026-05-23T14:23`. Honors a `now` injection
 *  is irrelevant here (createdAt is the source of truth) but tolerates NaN. */
const fmtTime = (epochMs: number | undefined): string => {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return "(unknown)"
  return new Date(epochMs).toISOString().slice(0, 16)
}

/** One-line content preview — collapse whitespace, cap at {@link PREVIEW_MAX}. */
const previewText = (text: string): string => {
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= PREVIEW_MAX) return oneLine
  return `${oneLine.slice(0, PREVIEW_MAX - 3)}...`
}

/** UTF-8 byte size of a text payload (entry size proxy). Embeddings, tags,
 *  and metadata are not included — we report payload bytes only, matching
 *  what `/memory show` prints. */
const textBytes = (text: string): number => Buffer.byteLength(text, "utf8")

/** Find the first entry whose id starts with `prefix`. Returns the entry or
 *  a discriminator ("missing" | "ambiguous"). Prefix lookup is symmetrical
 *  with `/rewind <id-prefix>` so the user never has to type the full id. */
const findByPrefix = async (
  store: PersistentStorePort,
  prefix: string,
): Promise<MemoryEntry | "missing" | "ambiguous"> => {
  const exact = await store.get(prefix)
  if (exact !== undefined) return exact
  const all = await store.all()
  const matches = all.filter((e) => e.id.startsWith(prefix))
  if (matches.length === 0) return "missing"
  if (matches.length > 1) return "ambiguous"
  return matches[0] as MemoryEntry
}

/* ------------------------------------------------------------------ */
/* renderers                                                           */
/* ------------------------------------------------------------------ */

const renderRow = (e: MemoryEntry): string => {
  const id = shortId(e.id).padEnd(SHORT_ID_LEN)
  const tier = ((e.tier ?? "semantic") as string).padEnd(TIER_PAD)
  return `  - ${id}  ${tier}  ${previewText(e.text)}\n`
}

const renderListBlock = (
  ctx: SlashContext,
  shown: readonly MemoryEntry[],
  total: number,
  heading: string,
): void => {
  ctx.out(`/memory:\n`)
  ctx.out(`- ${heading} (${shown.length} of ${total}) -\n`)
  if (shown.length === 0) {
    ctx.out("  (no entries)\n")
  } else {
    for (const e of shown) ctx.out(renderRow(e))
  }
  ctx.out(`  /memory list - /memory search - /memory delete\n`)
}

/* ------------------------------------------------------------------ */
/* subcommand: list / recent                                           */
/* ------------------------------------------------------------------ */

interface ListFlags {
  readonly tier?: MemoryTier
}

const parseListFlags = (args: readonly string[]): ListFlags | string => {
  let tier: MemoryTier | undefined
  for (const a of args) {
    if (a.startsWith("--tier=")) {
      const v = a.slice("--tier=".length)
      if (!TIER_SET.has(v)) {
        return `invalid --tier value: ${v} (valid: ${MEMORY_TIERS.join(" | ")})`
      }
      tier = v as MemoryTier
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    } else {
      return `unexpected argument: ${a}`
    }
  }
  return tier !== undefined ? { tier } : {}
}

/** Sort by createdAt descending — recent first. Stable tiebreak by id so two
 *  entries minted in the same epoch ms render deterministically (tests rely
 *  on this). */
const byRecency = (a: MemoryEntry, b: MemoryEntry): number => {
  const diff = (b.createdAt ?? 0) - (a.createdAt ?? 0)
  if (diff !== 0) return diff
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const RECENT_DEFAULT_COUNT = 10

const runRecent = async (
  ctx: SlashContext,
  store: PersistentStorePort,
  count: number,
): Promise<number> => {
  const all = await store.all()
  const sorted = [...all].sort(byRecency)
  renderListBlock(ctx, sorted.slice(0, count), all.length, "Recent memories")
  return 0
}

const runList = async (
  ctx: SlashContext,
  store: PersistentStorePort,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> => {
  const parsed = parseListFlags(args)
  if (typeof parsed === "string") {
    ctx.err(`/memory list: ${parsed}\n`)
    return 1
  }
  const cap = listMax(env)
  const all = await store.all()
  const filtered =
    parsed.tier !== undefined ? all.filter((e) => (e.tier ?? "semantic") === parsed.tier) : all
  const sorted = [...filtered].sort(byRecency)
  const heading = parsed.tier !== undefined ? `Memories (tier=${parsed.tier})` : "Memories"
  renderListBlock(ctx, sorted.slice(0, cap), filtered.length, heading)
  return 0
}

/* ------------------------------------------------------------------ */
/* subcommand: search                                                  */
/* ------------------------------------------------------------------ */

const SEARCH_LIMIT = 10

const runSearch = async (
  ctx: SlashContext,
  state: MemorySlashState,
  args: readonly string[],
): Promise<number> => {
  const query = args.join(" ").trim()
  if (query === "") {
    ctx.err("/memory search: expected a query string\n")
    return 1
  }
  const q: MemoryQuery = { text: query, limit: SEARCH_LIMIT }
  // Best-effort embed — if the embedder throws (offline, quota), fall through
  // to lexical recall rather than failing the slash command.
  if (state.embedder !== undefined) {
    try {
      const vectors = await state.embedder.embed([query])
      const vec = vectors[0]
      if (vec !== undefined) {
        ;(q as { embedding?: number[] }).embedding = vec
      }
    } catch {
      // lexical fallback — recall() ranks on text/tags/freshness only
    }
  }
  const hits = await state.store.recall(q)
  renderListBlock(ctx, hits, hits.length, `Search "${previewText(query)}"`)
  return 0
}

/* ------------------------------------------------------------------ */
/* subcommand: show                                                    */
/* ------------------------------------------------------------------ */

const runShow = async (
  ctx: SlashContext,
  store: PersistentStorePort,
  args: readonly string[],
): Promise<number> => {
  if (args.length !== 1) {
    ctx.err("/memory show: expected exactly one argument (id or id-prefix)\n")
    return 1
  }
  const prefix = args[0] as string
  const found = await findByPrefix(store, prefix)
  if (found === "missing") {
    ctx.err(`/memory show: no entry matches: ${prefix}\n`)
    return 1
  }
  if (found === "ambiguous") {
    ctx.err(`/memory show: id-prefix '${prefix}' is ambiguous (more than one match)\n`)
    return 1
  }
  const tier = (found.tier ?? "semantic") as string
  const score = (found.importance ?? 0.5).toFixed(2)
  const size = textBytes(found.text)
  ctx.out(`/memory show ${shortId(found.id)}:\n`)
  ctx.out(`- Memory - ${found.id} -\n`)
  ctx.out(`  Tier:     ${tier}\n`)
  ctx.out(`  Kind:     ${found.kind}\n`)
  ctx.out(`  Created:  ${fmtTime(found.createdAt)}\n`)
  ctx.out(`  Updated:  ${fmtTime(found.updatedAt ?? found.createdAt)}\n`)
  ctx.out(`  Score:    ${score}\n`)
  ctx.out(`  Size:     ${size} byte${size === 1 ? "" : "s"}\n`)
  ctx.out(`  - Content -\n`)
  // Indent content so the box-style block stays scannable.
  for (const line of found.text.split("\n")) ctx.out(`    ${line}\n`)
  if (found.tags.length > 0) {
    ctx.out(`  - Tags -\n`)
    ctx.out(`    ${found.tags.join(", ")}\n`)
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* subcommand: delete                                                  */
/* ------------------------------------------------------------------ */

interface DeleteFlags {
  readonly id: string
  readonly yes: boolean
}

const parseDeleteFlags = (args: readonly string[]): DeleteFlags | string => {
  let yes = false
  let id: string | undefined
  for (const a of args) {
    if (a === "--yes" || a === "-y") {
      yes = true
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    } else {
      if (id !== undefined) return `unexpected extra argument: ${a}`
      id = a
    }
  }
  if (id === undefined) return "expected an id (or id-prefix)"
  return { id, yes }
}

const runDelete = async (
  ctx: SlashContext,
  store: PersistentStorePort,
  args: readonly string[],
): Promise<number> => {
  const parsed = parseDeleteFlags(args)
  if (typeof parsed === "string") {
    ctx.err(`/memory delete: ${parsed}\n`)
    return 1
  }
  const found = await findByPrefix(store, parsed.id)
  if (found === "missing") {
    ctx.err(`/memory delete: no entry matches: ${parsed.id}\n`)
    return 1
  }
  if (found === "ambiguous") {
    ctx.err(`/memory delete: id-prefix '${parsed.id}' is ambiguous (more than one match)\n`)
    return 1
  }
  if (!parsed.yes) {
    ctx.out(`/memory delete: would delete ${shortId(found.id)}\n`)
    ctx.out(`  preview: ${previewText(found.text)}\n`)
    ctx.out(`  re-run with --yes to confirm: /memory delete ${shortId(found.id)} --yes\n`)
    return 0
  }
  await store.delete(found.id)
  ctx.out(`/memory delete: removed ${found.id}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* subcommand: stats                                                   */
/* ------------------------------------------------------------------ */

const runStats = async (ctx: SlashContext, store: PersistentStorePort): Promise<number> => {
  const all = await store.all()
  const counts = new Map<string, number>()
  let bytes = 0
  for (const e of all) {
    const tier = (e.tier ?? "semantic") as string
    counts.set(tier, (counts.get(tier) ?? 0) + 1)
    bytes += textBytes(e.text)
  }
  ctx.out(`/memory stats:\n`)
  ctx.out(`- Memory store -\n`)
  ctx.out(`  Total:      ${all.length} entr${all.length === 1 ? "y" : "ies"}\n`)
  ctx.out(`  Total size: ${bytes} byte${bytes === 1 ? "" : "s"} (content only)\n`)
  ctx.out(`  - Per tier -\n`)
  // Render every defined tier (zero-count rows included) so the output is
  // shape-stable for scripts; ad-hoc tiers (none currently, but the union
  // could grow) are appended in insertion order.
  const seen = new Set<string>()
  for (const t of MEMORY_TIERS) {
    seen.add(t)
    ctx.out(`    ${t.padEnd(TIER_PAD)} ${counts.get(t) ?? 0}\n`)
  }
  for (const [tier, n] of counts) {
    if (!seen.has(tier)) ctx.out(`    ${tier.padEnd(TIER_PAD)} ${n}\n`)
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

const HELP_TEXT = `\
/memory                          Recent memories (top 10).
/memory list [--tier=…]          List entries (cap QUANTA_MEMORY_LIST_MAX=20).
/memory search <query>           Semantic recall (lexical fallback if no embedder).
/memory show <id>                Show one entry by id or id-prefix.
/memory delete <id> [--yes]      Delete an entry (confirm with --yes).
/memory stats                    Counts per tier + total bytes.`

export const memoryCmd: SlashCommand = {
  name: "/memory",
  describe: "Browse, search, and delete durable memory entries",
  category: "session",
  async run(args, ctx) {
    if (ctx.memory === undefined) {
      ctx.out("/memory: memory store not wired in this surface\n")
      return 0
    }
    const sub = args[0]
    const rest = args.slice(1)
    const state = ctx.memory
    const env = state.env ?? process.env
    if (sub === undefined) return runRecent(ctx, state.store, RECENT_DEFAULT_COUNT)
    if (sub === "--help" || sub === "-h") {
      ctx.out(`${HELP_TEXT}\n`)
      return 0
    }
    switch (sub) {
      case "list":
        return runList(ctx, state.store, rest, env)
      case "search":
        return runSearch(ctx, state, rest)
      case "show":
        return runShow(ctx, state.store, rest)
      case "delete":
        return runDelete(ctx, state.store, rest)
      case "stats":
        return runStats(ctx, state.store)
      default:
        ctx.err(`/memory: unknown subcommand: ${sub}\n`)
        ctx.out(`${HELP_TEXT}\n`)
        return 1
    }
  },
}
