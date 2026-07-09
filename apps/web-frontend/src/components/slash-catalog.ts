/**
 * WS-F move 1 — the production slash-command catalogue assembly, extracted
 * from App.tsx so the palette invariant test exercises EXACTLY what ships.
 *
 * Assembly rules:
 *   1. Offline (`endpoint === null`): the base catalogue only — live-data
 *      commands appear as honest `unwired` stubs.
 *   2. Connected: the HTTP-backed builders (llm-config / auth / readouts)
 *      are spliced in, and any base entry whose slug a live builder OWNS is
 *      dropped. Resolution is first-match, so leaving the stub in would
 *      SHADOW the live command (the pre-fix `/effort` bug: the base prefill
 *      stub shadowed the live llm-config `/effort`, making it dead).
 */

import {
  buildDefaultSlashCommands,
  isSlashMode,
  type SlashCommand,
  type SlashCommandContext,
  splitDraft,
} from "./SlashPalette"
import { buildAuthSlashCommands } from "./slash-auth"
import { buildLlmConfigSlashCommands } from "./slash-llm-config"
import { buildReadoutSlashCommands } from "./slash-readout"

export interface SlashCatalogDeps {
  readonly clearTranscript: () => void
  readonly focusImageAttachment: () => void
  readonly appendClientMessage: (role: "system" | "error", text: string) => void
  readonly getContext: () => SlashCommandContext
  readonly openKnobsPanel: () => void
  /** Resolved daemon HTTP endpoint, or `null` before the first daemon-info
   *  round-trip (offline catalogue). */
  readonly endpoint: { readonly httpUrl: string; readonly token?: string } | null
}

export const assembleSlashCommands = (deps: SlashCatalogDeps): readonly SlashCommand[] => {
  const base = buildDefaultSlashCommands({
    clearTranscript: deps.clearTranscript,
    focusImageAttachment: deps.focusImageAttachment,
    appendClientMessage: deps.appendClientMessage,
    getContext: deps.getContext,
    openKnobsPanel: deps.openKnobsPanel,
  })
  if (deps.endpoint === null) return base

  const { httpUrl, token } = deps.endpoint
  const sharedEndpoint = {
    httpUrl,
    ...(token !== undefined ? { token } : {}),
    onResult: (msg: string, kind: "ok" | "err"): void => {
      deps.appendClientMessage(kind === "err" ? "error" : "system", msg)
    },
  }
  const llmCommands = buildLlmConfigSlashCommands(sharedEndpoint)
  const authCommands = buildAuthSlashCommands(sharedEndpoint)
  const readoutCommands = buildReadoutSlashCommands({
    httpUrl,
    ...(token !== undefined ? { token } : {}),
    appendSystem: (text: string): void => {
      deps.appendClientMessage("system", text)
    },
    onError: (msg: string): void => {
      deps.appendClientMessage("error", msg)
    },
  })

  // Live builders own their slugs: drop the base stubs they replace so
  // first-match resolution can never hit a dead stub in front of a live
  // command. (Guarded by the invariant test's duplicate-slug check.)
  const connected = [...llmCommands, ...authCommands, ...readoutCommands]
  const ownedSlugs = new Set(connected.map((c) => c.slug))
  const baseMinusOwned = base.filter((c) => !ownedSlugs.has(c.slug))
  return [...baseMinusOwned, ...connected]
}

/**
 * First-match command resolution for a leading-`/` draft: exact slug match
 * wins over alias match, earlier entries win ties. Shared by the composer's
 * submit path (App) and any test that needs production resolution semantics.
 */
export const resolveSlashCommandFrom = (
  commands: readonly SlashCommand[],
  text: string,
): { cmd: SlashCommand; rest: string } | null => {
  if (!isSlashMode(text)) return null
  const { slug, rest } = splitDraft(text)
  const cmd =
    commands.find((c) => c.slug.toLowerCase() === slug) ??
    commands.find((c) => c.aliases?.some((a) => a.toLowerCase() === slug))
  return cmd === undefined ? null : { cmd, rest }
}
