/**
 * Hook trust-review store (T04) — the durable record of which review-gated
 * command-hook bindings the user has APPROVED.
 *
 * A binding flagged {@link CommandHookBinding.needsReview} (imported / repo-
 * shipped provenance) must not spawn until the operator explicitly approves it
 * (RCE prevention: an externally-imported `settings.json#hooks` command never
 * executes un-reviewed). This store is the approval ledger:
 *
 *   - the `/hooks` slash (`apps/cli`) WRITES it (`approve`/`revoke`),
 *   - the runner's review port READS it (fail-closed: no record ⇒ not approved).
 *
 * The two sides are decoupled THROUGH THE DISK FILE — there is no in-process
 * handle threaded from the CLI surface to the host runtime. The production
 * review port re-`load`s the (tiny) file per hook fire so a mid-session approve
 * takes effect immediately without any wiring between the surfaces.
 *
 * Identity — a binding is keyed by its NORMALIZED event spelling + matcher +
 * command ({@link hookBindingKey}). Normalizing the event (via
 * {@link mapClaudeEvent}) means `PreToolUse` and `pre_tool_use` collide to the
 * same key, so an approval survives a config rewrite that changes only the
 * spelling. The command string is included verbatim: approving `lint.sh` does
 * NOT approve `rm -rf /` — every distinct command is reviewed on its own.
 *
 * Format (JSON): `{ "version": 1, "approved": { "<key>": {command, event,
 * matcher?} } }`. A missing / malformed file ⇒ an EMPTY store (never throws —
 * an unreadable ledger means "nothing approved", the safe default).
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { mapClaudeEvent } from "./gate"
import type { CommandHookBinding } from "./types"

/** The default on-disk location of the approval ledger, under the user config
 *  dir (the central-config `QUANTA_CONFIG_DIR` or `~/.quanta`). User-scoped so
 *  an approval persists across sessions but is NOT shipped inside a repo (a
 *  repo cannot pre-approve its own hooks). */
export const defaultHookApprovalsPath = (userConfigDir: string): string =>
  join(userConfigDir, "hook-approvals.json")

/** The minimal binding identity the key + record need. */
type BindingIdentity = Pick<CommandHookBinding, "event" | "matcher" | "command">

/** Stable approval key for a binding: a short hex digest of the NORMALIZED
 *  event + matcher + command. Normalizing the event collapses spelling variants
 *  (`PreToolUse` ≡ `pre_tool_use`) so an approval is spelling-stable; the
 *  command is hashed verbatim so each distinct command is its own approval. */
export const hookBindingKey = (binding: BindingIdentity): string => {
  const event = mapClaudeEvent(binding.event) ?? binding.event
  const composite = `${event}\x00${binding.matcher ?? ""}\x00${binding.command}`
  return createHash("sha256").update(composite).digest("hex").slice(0, 16)
}

/** One approved-binding record (kept for human-readable `/hooks` listing). */
export interface HookApprovalRecord {
  readonly key: string
  readonly event: string
  readonly matcher?: string
  readonly command: string
}

interface ApprovalsFile {
  readonly version: 1
  readonly approved: Record<string, HookApprovalRecord>
}

/** Coerce an unknown into a non-null plain object, else undefined. */
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Parse one persisted record defensively (drops anything malformed). */
const parseRecord = (key: string, raw: unknown): HookApprovalRecord | undefined => {
  const o = asObject(raw)
  if (o === undefined) return undefined
  if (typeof o.command !== "string" || typeof o.event !== "string") return undefined
  return {
    key,
    event: o.event,
    command: o.command,
    ...(typeof o.matcher === "string" ? { matcher: o.matcher } : {}),
  }
}

/**
 * The approval ledger. Loaded fail-closed (missing/corrupt ⇒ empty), mutated by
 * {@link approve}/{@link revoke}, and committed atomically by {@link flush}.
 */
export class HookReviewStore {
  private constructor(
    private readonly path: string,
    private readonly approved: Map<string, HookApprovalRecord>,
  ) {}

  /** Load the ledger at `path`. Absent / unreadable / malformed ⇒ an EMPTY
   *  store (never throws — an unreadable ledger means "nothing approved"). */
  static async load(path: string): Promise<HookReviewStore> {
    const approved = new Map<string, HookApprovalRecord>()
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      return new HookReviewStore(path, approved)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return new HookReviewStore(path, approved)
    }
    const file = asObject(parsed)
    const records = asObject(file?.approved)
    if (records !== undefined) {
      for (const [key, raw] of Object.entries(records)) {
        const rec = parseRecord(key, raw)
        // Trust the KEY recomputed from the record, not the stored key, so a
        // tampered key→command mismatch cannot pre-approve a different command.
        if (rec !== undefined) {
          const trueKey = hookBindingKey(rec)
          approved.set(trueKey, { ...rec, key: trueKey })
        }
      }
    }
    return new HookReviewStore(path, approved)
  }

  /** True iff `binding` has been approved (keyed by command identity). */
  isApproved(binding: BindingIdentity): boolean {
    return this.approved.has(hookBindingKey(binding))
  }

  /** True iff `key` (a short digest from {@link hookBindingKey}) is approved. */
  hasKey(key: string): boolean {
    return this.approved.has(key)
  }

  /** Record an approval for `binding`. Idempotent. */
  approve(binding: BindingIdentity): string {
    const key = hookBindingKey(binding)
    this.approved.set(key, {
      key,
      event: binding.event,
      command: binding.command,
      ...(binding.matcher !== undefined ? { matcher: binding.matcher } : {}),
    })
    return key
  }

  /** Drop an approval by key. Returns whether a record was removed. */
  revoke(key: string): boolean {
    return this.approved.delete(key)
  }

  /** All approved records (display order: insertion). */
  list(): readonly HookApprovalRecord[] {
    return [...this.approved.values()]
  }

  /** Atomically persist the ledger (temp + rename in the target dir). Creates
   *  the parent dir if absent. */
  async flush(): Promise<void> {
    const file: ApprovalsFile = {
      version: 1,
      approved: Object.fromEntries(this.approved),
    }
    const content = `${JSON.stringify(file, null, 2)}\n`
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp-${createHash("sha256").update(content).digest("hex").slice(0, 8)}`
    try {
      await writeFile(temp, content, "utf8")
      await rename(temp, this.path)
    } catch (err) {
      await unlink(temp).catch(() => undefined)
      throw err
    }
  }
}
