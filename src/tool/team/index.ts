/**
 * Peer teammate messaging — team lifecycle tools (RFC jun-6, DELTA #2).
 *
 * `team_create` mints a team (a membership SCOPE over the shared per-session
 * mailbox — NOT a new store) and seeds members; `team_delete` reaps it and
 * returns the reaped member ids (the host disposes their runners via the
 * existing subagent disposer — these tools touch ONLY the registry). The
 * cross-team deny is enforced at `send` by the `TeamScopedMailbox` decorator,
 * not here — these tools only manage membership.
 *
 * GATED + mutating: registered only when `QUANTA_TEAM_PEER_MSG` is on (the host
 * injects the `TeamRegistryPort`). `risk:"mutating"` — they spawn/reap the team
 * boundary. The peer bus is a COMMS channel, never a grant channel — these tools
 * never touch the permission decider.
 *
 * SLICE FENCE: imports the DUCK-TYPED `TeamRegistryWriter` port (so the tool
 * slice never imports `@/subagent`), `../types` (Tool / ToolContext / ToolEvent
 * / ToolResult), `@/shared` (errMessage), and `zod`. NO-THROW: zod `safeParse`
 * at the boundary; the registry call is wrapped so a throwing port surfaces as
 * `{ ok:false, output:"..." }`.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

/** The slice of `TeamRegistryPort` these tools need (duck-typed). */
export interface TeamRegistryWriter {
  create(teamId: string, members: readonly string[], caller?: string): void
  delete(teamId: string, caller?: string): readonly string[]
  members(teamId: string): readonly string[]
}

const TEAM_ID_MAX = 128
const MEMBER_MAX = 128
const MEMBERS_MAX = 256

export const teamCreateSchema = z.object({
  team_id: z.string().min(1).max(TEAM_ID_MAX).describe("The team id to mint."),
  members: z
    .array(z.string().min(1).max(MEMBER_MAX))
    .max(MEMBERS_MAX)
    .optional()
    .describe("Agent ids to seed into the team (the caller is auto-added)."),
})
export type TeamCreateInput = z.infer<typeof teamCreateSchema>

export const teamDeleteSchema = z.object({
  team_id: z.string().min(1).max(TEAM_ID_MAX).describe("The team id to reap."),
})
export type TeamDeleteInput = z.infer<typeof teamDeleteSchema>

const errResult = (msg: string): ToolResult => ({ ok: false, output: msg })

/** The caller's stable mailbox identity (so `team_create` auto-adds the caller
 *  to its own team). Mirrors the subagent-mailbox tool's id derivation. */
const callerId = (ctx: ToolContext): string =>
  typeof ctx.agentLabel === "string" && ctx.agentLabel.length > 0 ? ctx.agentLabel : "root"

const buildTeamCreate = (registry: TeamRegistryWriter): Tool<TeamCreateInput> => ({
  name: "team_create",
  description:
    "Mint a team — a set of peer teammates that share a message bus. Members " +
    "can message each other (and broadcast within the team); cross-team " +
    "messages are denied. You are automatically added. Returns the team roster.",
  inputSchema: teamCreateSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = teamCreateSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const me = callerId(ctx)
      const seeded = parsed.data.members ?? []
      const members = seeded.includes(me) ? seeded : [me, ...seeded]
      // jul-7 audit (F2): pass the caller so the registry refuses a re-home hijack —
      // the caller cannot join a foreign team or drag a teamed victim into its team.
      registry.create(parsed.data.team_id, members, me)
      const roster = registry.members(parsed.data.team_id)
      yield {
        type: "result",
        result: {
          ok: true,
          output: `team ${parsed.data.team_id} created\nmembers: ${roster.join(", ")}`,
        },
      }
    } catch (e) {
      yield { type: "result", result: errResult(`team_create failed: ${errMessage(e)}`) }
    }
  },
})

const buildTeamDelete = (registry: TeamRegistryWriter): Tool<TeamDeleteInput> => ({
  name: "team_delete",
  description:
    "Reap a team: drop its membership scope and return the member ids that " +
    "were removed (the host disposes their runners). After deletion, mail to a " +
    "reaped member sits unread and is reclaimed by the mailbox retention window.",
  inputSchema: teamDeleteSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = teamDeleteSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      // jul-7 audit (F3): pass the caller so the registry reaps ONLY a team the caller
      // belongs to — no cross-team DoS on a disjoint team's runners.
      const reaped = registry.delete(parsed.data.team_id, callerId(ctx))
      yield {
        type: "result",
        result: {
          ok: true,
          output:
            reaped.length === 0
              ? `team ${parsed.data.team_id} deleted (no members)`
              : `team ${parsed.data.team_id} deleted\nreaped: ${reaped.join(", ")}`,
        },
      }
    } catch (e) {
      yield { type: "result", result: errResult(`team_delete failed: ${errMessage(e)}`) }
    }
  },
})

/** Build the team-lifecycle tools wired to a single `TeamRegistryWriter`.
 *  Returned as a stable array so the tier-1 composer can spread it uniformly. */
export const teamTools = (registry: TeamRegistryWriter): Tool[] => [
  buildTeamCreate(registry) as Tool,
  buildTeamDelete(registry) as Tool,
]
