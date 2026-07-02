/**
 * Browser slice — CDP adapter session bring-up (extracted from
 * `../cdp-adapter.ts` to keep that orchestrator under the god-module line cap).
 *
 * Connects the CDP transport, creates + attaches the first page target (flat
 * protocol), enables Page/Runtime/Log, denies downloads, and wires the
 * console/error/log/dialog observers into the ring buffer. Depends only on the
 * injected {@link CdpBrowserDeps} + the cdp/console ports — no adapter-closure
 * state — so a failed bring-up surfaces as a typed `spawn-failed` Err.
 */

import { err, ok, type Result } from "@/shared"
import { type CdpSession, createCdpSession } from "../cdp/cdp-session"
import {
  type ConsoleBuffer,
  consoleArgsToText,
  createConsoleBuffer,
  mapConsoleApiType,
  mapLogEntryLevel,
} from "../cdp/console-buffer"
import { buildNetworkEntry, createNetworkBuffer, type NetworkBuffer } from "../cdp/network-buffer"
import type { BrowserError, ConsoleEntry } from "../types"
import type { CdpBrowserDeps } from "./deps"

/** Connect the transport + enable the Page domain. A failed bring-up (chrome
 *  died right after the ws opened) surfaces as `spawn-failed` now rather than a
 *  confusing closed/timeout on first use (R1 audit [4]). */
export interface BringUp {
  readonly session: CdpSession
  readonly console: ConsoleBuffer
  /** Bounded metadata-only network capture (S1 strengthen). */
  readonly network: NetworkBuffer
  /** The first tab's CDP target + flat-protocol page session (TICKET-24 Wave B). */
  readonly targetId: string
  readonly sessionId: string
}

// Subscribe the persistent console/error/log streams into the ring buffer, plus
// the dialog auto-dismiss. Called once after the page session is attached +
// Page.enable succeeds. Runtime.enable / Log.enable are best-effort: a console
// capture failure must NOT fail the whole bring-up (the page still drives), so
// these errors are swallowed — the buffer simply stays empty.
const installPageObservers = async (
  session: CdpSession,
  buffer: ConsoleBuffer,
  network: NetworkBuffer,
  opts: { signal?: AbortSignal } | undefined,
): Promise<void> => {
  // consoleAPICalled.type → level; args flattened to text.
  session.onEvent("Runtime.consoleAPICalled", (p) => {
    const entry: ConsoleEntry = {
      level: mapConsoleApiType(p.type),
      text: consoleArgsToText(p.args),
      ...(typeof p.timestamp === "number" ? { ts: p.timestamp } : {}),
    }
    buffer.push(entry)
  })
  // exceptionThrown → level "error", text from exceptionDetails.text.
  session.onEvent("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails as
      | { text?: unknown; exception?: { description?: unknown } }
      | undefined
    const text =
      typeof d?.exception?.description === "string"
        ? d.exception.description
        : typeof d?.text === "string"
          ? d.text
          : "uncaught exception"
    buffer.push({
      level: "error",
      text,
      ...(typeof p.timestamp === "number" ? { ts: p.timestamp } : {}),
    })
  })
  // Log.entryAdded → its own level + text.
  session.onEvent("Log.entryAdded", (p) => {
    const e = p.entry as { level?: unknown; text?: unknown; timestamp?: unknown } | undefined
    buffer.push({
      level: mapLogEntryLevel(e?.level),
      text: typeof e?.text === "string" ? e.text : "",
      ...(typeof e?.timestamp === "number" ? { ts: e.timestamp } : {}),
    })
  })
  // SAFETY: a page alert()/confirm()/prompt() fires javascriptDialogOpening and
  // BLOCKS the renderer (and thus every CDP request) until handled. Auto-DISMISS
  // (accept:false) so a page can never wedge the automation. A future
  // accept-policy is out of scope — default-dismiss is the safe posture.
  session.onEvent("Page.javascriptDialogOpening", () => {
    void session.request("Page.handleJavaScriptDialog", { accept: false })
  })
  // ★ Network capture — METADATA ONLY. Each event is projected through
  // buildNetworkEntry (method/url/status/mime/size), which reads NONE of the
  // headers/postData/body the event also carries, so cookies/auth tokens/PII can
  // never enter the buffer (leak guard enforced at the source, not by redaction).
  for (const evt of [
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
  ] as const) {
    session.onEvent(evt, (p) => network.push(buildNetworkEntry(evt, p)))
  }
  await session.request("Runtime.enable", undefined, opts)
  await session.request("Log.enable", undefined, opts)
  // Network.enable is on the CDP allowlist (cdp-allowlist.ts) — best-effort like
  // Runtime/Log: a failure leaves the network buffer empty, page still drives.
  await session.request("Network.enable", undefined, opts)
}

export const connectAndEnable = async (
  deps: CdpBrowserDeps,
  wsUrl: string,
  signal: AbortSignal | undefined,
): Promise<Result<BringUp, BrowserError>> => {
  const conn = await deps.transport.connect(wsUrl, signal)
  if (!conn.ok) return err({ kind: "spawn-failed", detail: conn.error.detail })
  const session = createCdpSession({ conn: conn.value, scheduler: deps.scheduler })
  const opts = signal ? { signal } : undefined
  // DevToolsActivePort gives the BROWSER-level endpoint, where Page.*/Runtime.*
  // do not exist. Create + attach a page target (flat protocol) and route all
  // subsequent page calls through its sessionId (real-chrome e2e bug fix). The
  // Target.* calls below are browser-level — made BEFORE useSessionId.
  const created = await session.request("Target.createTarget", { url: "about:blank" }, opts)
  if (!created.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.createTarget failed during bring-up" })
  }
  const targetId = (created.value as { targetId?: unknown }).targetId
  if (typeof targetId !== "string") {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.createTarget returned no targetId" })
  }
  const attached = await session.request("Target.attachToTarget", { targetId, flatten: true }, opts)
  if (!attached.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.attachToTarget failed during bring-up" })
  }
  const sessionId = (attached.value as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== "string") {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.attachToTarget returned no sessionId" })
  }
  session.useSessionId(sessionId)
  // R2 audit [3]: thread the abort signal into the bring-up request too — a turn
  // aborted during a hung Page.enable must cancel promptly, not wait the timeout.
  const enabled = await session.request("Page.enable", undefined, opts)
  if (!enabled.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Page.enable failed during bring-up" })
  }
  // R2 audit [8]: deny downloads at the source — a page must not be able to write
  // files outside the temp profile (defense-in-depth; download-to-jail is Phase 2).
  // R3 audit [3]: a failed deny would leave downloads ENABLED — fail bring-up
  // rather than silently proceed with an unguarded download surface.
  const dl = await session.request("Page.setDownloadBehavior", { behavior: "deny" }, opts)
  if (!dl.ok) {
    session.dispose()
    return err({
      kind: "spawn-failed",
      detail: "Page.setDownloadBehavior(deny) failed during bring-up",
    })
  }
  // After the page session is live: subscribe console/error/log capture +
  // dialog auto-dismiss, and enable the producing domains. Non-fatal — a console
  // capture failure leaves the buffer empty but the page still drives.
  const consoleBuffer = createConsoleBuffer()
  const networkBuffer = createNetworkBuffer()
  await installPageObservers(session, consoleBuffer, networkBuffer, opts)
  return ok({ session, console: consoleBuffer, network: networkBuffer, targetId, sessionId })
}
