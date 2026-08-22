/**
 * `/undo` — RFC-def restore surface over the RFC06-4 hunk-mutation journal.
 *
 * Surfaces the EXISTING durable CAS undo journal (`@/runner/hunk-mutation-
 * journal`) over the CLI so an operator can:
 *
 *   - `/undo`                       → list recent per-hunk apply receipts,
 *                                     newest-first (opId / path / applied-hunk
 *                                     count / state).
 *   - `/undo <opId-prefix>`         → preview-only confirm line (DESTRUCTIVE —
 *                                     reverting a mutation rewrites the file).
 *                                     Re-run with `--yes` to commit.
 *   - `/undo <opId-prefix> --yes`   → revert that mutation through the EXISTING
 *                                     `undoHunkMutation` journal revert. The
 *                                     revert is CAS-gated: the file on disk must
 *                                     still hash-equal the receipt's
 *                                     `expectedCurrentHash`. On drift the journal
 *                                     REFUSES (`stale`) and this command surfaces
 *                                     the refusal — it NEVER blind-overwrites and
 *                                     never treats the drifted file as a new
 *                                     baseline.
 *
 * Default-OFF (DESTRUCTIVE gate): the command is registered only when
 * `QUANTA_HUNK_UNDO=1`. Even when registered, `ctx.hunkUndo` is absent unless
 * the composition root wired the durable journal store (which it only does when
 * the same gate is on) — absent ⇒ D-6 not-wired posture, no journal touched.
 *
 * Reuse contract: this command constructs NO revert engine. It resolves an
 * opId against `store.list()` and calls `undoHunkMutation(opId, { store })` —
 * the SAME journal revert unit-tested in
 * `tests/unit/runner/hunk-mutation-journal.test.ts`. The CAS/drift refusal lives
 * in the journal; this surface only lists + confirms + relays the typed result.
 *
 * Slice contract: lives under `src/apps/cli` (slash UX is the top of the slice
 * DAG). Body reads ONLY `@/runner/hunk-mutation-journal` types + the journal
 * revert. The composition root is the ONE place the durable store is built.
 */

import {
  type HunkMutationJournalStore,
  type HunkMutationReceipt,
  undoHunkMutation,
} from "@/runner/hunk-mutation-journal"
import { notWired } from "./not-wired"
import type { SlashCommand } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Wiring slot for `/undo`. Present only when `QUANTA_HUNK_UNDO=1` AND the
 *  composition root built a durable journal store. The command needs the store
 *  to `list()` recent receipts and to `undoHunkMutation(opId, { store })`. */
export interface HunkUndoSlashState {
  readonly store: HunkMutationJournalStore
}

declare module "./slash-commands" {
  interface SlashContext {
    /** RFC-def `/undo` hunk-revert wiring slot. */
    readonly hunkUndo?: HunkUndoSlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The env gate whose absence produces the not-wired hint. */
const HUNK_UNDO_GATE = "QUANTA_HUNK_UNDO"

/** Whether `/undo` should be REGISTERED at all. DESTRUCTIVE ⇒ default OFF:
 *  absent / falsy `QUANTA_HUNK_UNDO` ⇒ the command is not added to the registry
 *  (byte-identical — no undo surface exists). Same `gateOn` truthy vocab as the
 *  runtime-config read so the register decision and the store-wire decision
 *  agree. Honors an injected env source (test seam) then `process.env`. */
export const isHunkUndoEnabled = (
  envSource?: Readonly<Record<string, string | undefined>>,
): boolean => {
  const raw = (envSource ?? process.env)[HUNK_UNDO_GATE]
  const v = (raw ?? "").trim().toLowerCase()
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no"
}

const SHORT_ID_LEN = 8

const shortId = (id: string): string => (id.length <= SHORT_ID_LEN ? id : id.slice(0, SHORT_ID_LEN))

interface UndoFlags {
  readonly opIdPrefix?: string
  readonly yes: boolean
}

const parseUndoArgs = (args: readonly string[]): UndoFlags | string => {
  let yes = false
  let opIdPrefix: string | undefined
  for (const a of args) {
    if (a === "--yes" || a === "-y") {
      yes = true
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    } else if (opIdPrefix !== undefined) {
      return `unexpected extra argument: ${a}`
    } else {
      opIdPrefix = a
    }
  }
  return { ...(opIdPrefix !== undefined ? { opIdPrefix } : {}), yes }
}

/** Resolve an operationId prefix against the store listing. Only `applied`
 *  receipts are revertible targets — an already-`reverted` receipt is NOT
 *  offered (reverting it again is a fail-closed no-op in the journal). Returns
 *  the matched receipt on a unique hit, or an error message on miss / ambiguity.
 *  Pure over the supplied listing. */
const resolveOpId = (
  receipts: readonly HunkMutationReceipt[],
  prefix: string,
): HunkMutationReceipt | string => {
  const revertible = receipts.filter((r) => r.state === "applied")
  let hit: HunkMutationReceipt | undefined
  for (const r of revertible) {
    if (r.operationId === prefix) return r // exact match always wins
    if (r.operationId.startsWith(prefix)) {
      if (hit !== undefined) {
        return `ambiguous operationId prefix: ${prefix} (matches ${hit.operationId} and ${r.operationId})`
      }
      hit = r
    }
  }
  return hit ?? `no revertible mutation for operationId prefix: ${prefix}`
}

/** Render the recent-receipt table `/undo` (no args) prints. Pure. */
const renderReceipts = (receipts: readonly HunkMutationReceipt[]): string => {
  if (receipts.length === 0) {
    return "(no hunk-mutation receipts recorded yet)"
  }
  const lines: string[] = []
  lines.push(`recent hunk mutations (${receipts.length}):`)
  for (const r of receipts) {
    const state = r.state.padEnd(8)
    const hunks = `${r.appliedHunks.length}h`.padEnd(4)
    lines.push(`  ${shortId(r.operationId)}  ${state}  ${hunks}  ${r.path}`)
  }
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/** List the store's receipts (empty when the store cannot enumerate — none of
 *  our stores omit `list`, but the surface stays fail-closed). */
const listReceipts = async (
  store: HunkMutationJournalStore,
): Promise<readonly HunkMutationReceipt[]> => (store.list !== undefined ? await store.list() : [])

export const undoCmd: SlashCommand = {
  name: "/undo",
  describe: "Revert a recent per-hunk apply from the durable CAS undo journal",
  category: "session",
  async run(args, ctx) {
    const state = ctx.hunkUndo
    if (state === undefined) {
      // D-6: the durable journal store is not wired in this surface. Name the
      // gate so the operator knows what to set (destructive ⇒ default OFF).
      return notWired(ctx.out, { feature: "/undo", gate: HUNK_UNDO_GATE })
    }
    const parsed = parseUndoArgs(args)
    if (typeof parsed === "string") {
      ctx.err(`/undo: ${parsed}\n`)
      return 1
    }

    const receipts = await listReceipts(state.store)

    // List mode: no opId prefix.
    if (parsed.opIdPrefix === undefined) {
      ctx.out(`${renderReceipts(receipts)}\n`)
      ctx.out("usage: /undo <operationId-prefix> [--yes]  (DESTRUCTIVE — reverts the file)\n")
      return 0
    }

    const resolved = resolveOpId(receipts, parsed.opIdPrefix)
    if (typeof resolved === "string") {
      ctx.err(`/undo: ${resolved}\n`)
      return 1
    }

    // Confirmation gate (destructive — the revert rewrites the file on disk).
    if (!parsed.yes) {
      ctx.out(
        `[/undo] would revert ${shortId(resolved.operationId)} (${resolved.appliedHunks.length} hunk(s)) in ${resolved.path}. Re-run with --yes to commit.\n`,
      )
      return 0
    }

    // Route through the EXISTING journal revert. It CAS-verifies the file still
    // hash-equals `expectedCurrentHash` and REFUSES (`stale`) on drift — no
    // blind overwrite, no naive-baseline revert.
    const result = await undoHunkMutation(resolved.operationId, { store: state.store })
    if (result.status === "reverted") {
      ctx.out(`/undo: reverted ${shortId(resolved.operationId)} in ${resolved.path}\n`)
      return 0
    }
    if (result.status === "stale") {
      // Fail-closed: the file changed since the apply (CAS drift) or was already
      // reverted. The file on disk is UNCHANGED by this refusal.
      ctx.err(
        `/undo: refused — ${result.reason} (${resolved.path} left unchanged; nothing was overwritten)\n`,
      )
      return 1
    }
    if (result.status === "not-found") {
      ctx.err(`/undo: ${result.reason}\n`)
      return 1
    }
    ctx.err(`/undo: revert failed — ${result.reason}\n`)
    return 1
  },
  complete(_args, _partial, _ctx) {
    return [{ value: "--yes", kind: "argument", description: "commit the revert (DESTRUCTIVE)" }]
  },
}

/** Test-only re-exports. */
export const __test = {
  parseUndoArgs,
  resolveOpId,
  renderReceipts,
  shortId,
  HUNK_UNDO_GATE,
}
