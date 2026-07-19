import {
  InMemorySessionEventLog,
  JsonlSessionEventLog,
  type KernelEventLogPort,
} from "@/kernel/session"

export const createInMemorySessionPersistence = (): InMemorySessionEventLog =>
  new InMemorySessionEventLog()

/**
 * W4-b composition seam (ADR-0540 Wave 2 item 0) — selects the kernel session
 * event-log backend.
 *
 * Gate: `QUANTA_SESSION_EVENT_LOG_DIR` — DEFAULT-OFF. Unset / blank ⇒ the
 * historical {@link InMemorySessionEventLog} (byte-identical to the
 * pre-feature runtime, zero disk contact). Set ⇒ the durable append-only JSONL
 * log at `<dir>/<sessionId>.jsonl`, whose `tip()` the SDK runtime consumes to
 * resume seq issuance after a restart (substrate for wire `connect({resume})`,
 * transport-unified-sdk ticket 05).
 *
 * The env VIEW is an injected parameter (default `process.env`, the
 * `mcp-composition.ts` style) — this module never hard-binds a process-global
 * read, so embedders/tests compose with an explicit view.
 */
export const createSessionPersistence = (
  args: { readonly sessionId: string },
  envSource: NodeJS.ProcessEnv = process.env,
): KernelEventLogPort => {
  const dir = envSource.QUANTA_SESSION_EVENT_LOG_DIR?.trim()
  if (dir === undefined || dir === "") return new InMemorySessionEventLog()
  return new JsonlSessionEventLog({ dir, sessionId: args.sessionId })
}
