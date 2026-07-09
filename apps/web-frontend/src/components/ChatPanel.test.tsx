/**
 * WS-F (UUX-5-24) — the empty-state copy must be honest about connectivity.
 * "Start a conversation" while the daemon is unreachable is a lie; the copy
 * derives from the ConnectionState machine phase.
 */

import { createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { UiConnectionPhase } from "../lib/connection-state"
import { ChatPanel } from "./ChatPanel"

const renderEmpty = (connectionPhase?: UiConnectionPhase, disabled = false): string =>
  renderToStaticMarkup(
    <ChatPanel
      messages={[]}
      draft=""
      disabled={disabled}
      inputRef={createRef<HTMLTextAreaElement>()}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      pendingImages={[]}
      attachmentError={null}
      onAttachImageFile={() => undefined}
      onRemovePendingImage={() => undefined}
      onClearAllPendingImages={() => undefined}
      {...(connectionPhase !== undefined ? { connectionPhase } : {})}
    />,
  )

describe("ChatPanel empty state — connection-aware copy (UUX-5-24)", () => {
  it("connected ⇒ invites a conversation", () => {
    expect(renderEmpty("connected")).toContain("Start a conversation")
  })

  it("degraded ⇒ still invites (live session works; the banner explains the degrade)", () => {
    expect(renderEmpty("degraded")).toContain("Start a conversation")
  })

  it("connecting ⇒ says CONNECTING, not 'Start a conversation'", () => {
    const html = renderEmpty("connecting")
    expect(html).not.toContain("Start a conversation")
    expect(html.toLowerCase()).toContain("connecting")
  })

  it("failed ⇒ says NOT CONNECTED, not 'Start a conversation'", () => {
    const html = renderEmpty("failed", true)
    expect(html).not.toContain("Start a conversation")
    expect(html.toLowerCase()).toContain("not connected")
    // The composer placeholder must not keep lying "Connecting…" either
    // (the composer is disabled in the failed state).
    expect(html).toContain("Not connected — use Retry above")
    expect(html).not.toContain("Connecting…")
  })

  it("omitted phase defaults to the legacy connected copy (back-compat)", () => {
    expect(renderEmpty()).toContain("Start a conversation")
  })
})
