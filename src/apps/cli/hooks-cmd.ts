/**
 * `/hooks` — list / review / approve disk-configured command hooks (T04).
 *
 * Command hooks (`settings.json#hooks`) run ARBITRARY shell on tool events. The
 * T04 trust gate (`QUANTA_HOOK_TRUST_GATE`) holds any IMPORTED / repo-shipped
 * hook (`needsReview`) until the operator explicitly approves it — this slash is
 * the approval surface (CC `/hooks` parity, RCE prevention).
 *
 *   /hooks                 — list every configured hook + its review status
 *   /hooks review          — list ONLY the hooks still awaiting review
 *   /hooks approve <key>   — approve a review-gated hook by its short key
 *   /hooks revoke  <key>   — withdraw a previous approval
 *
 * Resolution is the LEGACY (default) path — `settings.json#hooks` under the
 * cwd — which is exactly where the migration importer lands external hooks
 * (each stamped `needsReview`). The approval ledger is the SAME on-disk file the
 * runner's review port reads, so an approve here takes effect on the next hook
 * fire with no in-process wiring.
 */

import { join } from "node:path"
import {
  type CommandHookBinding,
  defaultHookApprovalsPath,
  HookReviewStore,
  hookBindingKey,
  loadCommandHookBindings,
} from "@/agent"
import { quantaHomeDirFrom } from "@/shared"
import type { SlashCommand } from "./slash-contract"

/** Resolve the user-config dir the runner uses for the approval ledger. MUST
 *  match `hookReviewPort` in host/runtime/agent-arg-builder.ts byte-for-byte
 *  (the unified `quantaHomeDirFrom(env)` = `QUANTA_CONFIG_DIR ?? QUANTA_HOME ??
 *  homedir()/.quanta`) — a mismatch would write the approval to a ledger the
 *  runner never reads, so an approve would silently not take effect. */
const userConfigDir = (env: NodeJS.ProcessEnv): string => quantaHomeDirFrom(env)

/** One display row: the binding + its short key + review/approval status. */
const statusOf = (b: CommandHookBinding, approved: boolean): string => {
  if (b.needsReview !== true) return "trusted"
  return approved ? "approved" : "NEEDS REVIEW"
}

const renderBinding = (b: CommandHookBinding, approved: boolean): string => {
  const key = hookBindingKey(b)
  const matcher = b.matcher !== undefined ? ` matcher=${b.matcher}` : ""
  const src = b.source !== undefined ? ` source=${b.source}` : ""
  return `  [${key}] ${b.event}${matcher}${src} — ${statusOf(b, approved)}\n      ${b.command}\n`
}

type HooksCtx = Parameters<NonNullable<SlashCommand["run"]>>[1]
type HookStore = Awaited<ReturnType<typeof HookReviewStore.load>>

const mutateApproval = async (
  subcommand: "approve" | "revoke",
  key: string | undefined,
  bindings: readonly CommandHookBinding[],
  store: HookStore,
  ctx: HooksCtx,
): Promise<number> => {
  if (key === undefined || key === "") {
    ctx.err(`/hooks ${subcommand}: missing <key> (run /hooks to see keys)\n`)
    return 1
  }
  if (subcommand === "revoke") {
    if (!store.revoke(key)) {
      ctx.err(`/hooks revoke: no approval for key ${key}\n`)
      return 1
    }
    await store.flush()
    ctx.out(`/hooks: revoked approval ${key}\n`)
    return 0
  }
  const binding = bindings.find((candidate) => hookBindingKey(candidate) === key)
  if (binding === undefined) {
    ctx.err(`/hooks approve: no configured hook with key ${key}\n`)
    return 1
  }
  if (binding.needsReview !== true) {
    ctx.out(`/hooks: hook ${key} is trusted (no review needed)\n`)
    return 0
  }
  store.approve(binding)
  await store.flush()
  ctx.out(`/hooks: approved ${key} — ${binding.command}\n`)
  return 0
}

const listBindings = (
  reviewOnly: boolean,
  bindings: readonly CommandHookBinding[],
  store: HookStore,
  settingsPath: string,
  ctx: HooksCtx,
): number => {
  const rows = bindings.filter((binding) => !reviewOnly || binding.needsReview === true)
  if (rows.length === 0) {
    ctx.out(
      reviewOnly
        ? "/hooks: no hooks awaiting review\n"
        : `/hooks: no command hooks configured (${settingsPath})\n`,
    )
    return 0
  }
  let pending = 0
  let output = reviewOnly ? "Hooks awaiting review:\n" : "Configured command hooks:\n"
  for (const binding of rows) {
    const approved = store.isApproved(binding)
    if (binding.needsReview === true && !approved) pending += 1
    output += renderBinding(binding, approved)
  }
  if (pending > 0) {
    output += `\n${pending} hook(s) NEED REVIEW — approve with: /hooks approve <key>\n`
  }
  ctx.out(output)
  return 0
}

export const hooksCmd: SlashCommand = {
  name: "/hooks",
  describe: "List / review / approve disk-configured command hooks (T04 trust gate)",
  category: "config",
  async run(args, ctx) {
    const env = process.env
    const settingsPath = join(ctx.cwd, "settings.json")
    const bindings = await loadCommandHookBindings(settingsPath)
    const ledgerPath = defaultHookApprovalsPath(userConfigDir(env))
    const store = await HookReviewStore.load(ledgerPath)

    const sub = (args[0] ?? "").toLowerCase()
    const arg = args[1]

    if (sub === "approve" || sub === "revoke") return mutateApproval(sub, arg, bindings, store, ctx)
    return listBindings(sub === "review", bindings, store, settingsPath, ctx)
  },
}
