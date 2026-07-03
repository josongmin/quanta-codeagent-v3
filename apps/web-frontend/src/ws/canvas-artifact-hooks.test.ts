/**
 * A2 — frontend canvas artifact hook + guard + preview-URL helper.
 *
 * The `artifact.ready` Canvas frame is the marker-level channel a surface CAN
 * render: the reducer collects refs (latest-wins per id), the guard routes the
 * frame, and `artifactPreviewUrl` turns the OPAQUE `quanta-artifact://<id>`
 * locator into the daemon's `GET /artifact/<id>` preview URL (never an fs path).
 */

import { describe, expect, it } from "vitest"
import type { ArtifactReadyMessage, CanvasMessage } from "../types/protocol"
import {
  artifactPreviewUrl,
  artifactsReducer,
  isArtifactReadyMessage,
  isContextUsageMessage,
  isToolDiffMessage,
} from "./canvas-hooks"

const ready = (id: string, name?: string): ArtifactReadyMessage => ({
  kind: "artifact.ready",
  artifactId: id,
  artifactKind: "image",
  mimeType: "image/png",
  locator: `quanta-artifact://${id}`,
  ...(name !== undefined ? { name } : {}),
  emittedAt: 0,
})

describe("A2 canvas artifact kind filter", () => {
  it("isArtifactReadyMessage narrows artifact.ready only", () => {
    const a: CanvasMessage = ready("art-1")
    expect(isArtifactReadyMessage(a)).toBe(true)
    // The sibling guards must NOT match an artifact frame (routing exclusivity).
    expect(isToolDiffMessage(a)).toBe(false)
    expect(isContextUsageMessage(a)).toBe(false)
  })
})

describe("A2 artifactsReducer", () => {
  it("collects refs latest-wins per id", () => {
    let state = artifactsReducer(new Map(), { type: "message", msg: ready("art-1", "v1") })
    state = artifactsReducer(state, { type: "message", msg: ready("art-2") })
    state = artifactsReducer(state, { type: "message", msg: ready("art-1", "v2") })
    expect(state.size).toBe(2)
    expect(state.get("art-1")?.name).toBe("v2") // latest wins
    expect(state.get("art-2")).toBeDefined()
  })

  it("reset clears the map", () => {
    const state = artifactsReducer(new Map([["art-1", ready("art-1")]]), { type: "reset" })
    expect(state.size).toBe(0)
  })
})

describe("A2 artifactPreviewUrl", () => {
  it("maps a valid locator to the daemon /artifact/<id> route", () => {
    expect(artifactPreviewUrl("quanta-artifact://art-7")).toBe("/artifact/art-7")
    expect(artifactPreviewUrl("quanta-artifact://art-7", "http://host:4096")).toBe(
      "http://host:4096/artifact/art-7",
    )
  })

  it("returns null for a non-scheme / traversal locator (no broken fetch, no fs path)", () => {
    expect(artifactPreviewUrl("file:///etc/passwd")).toBeNull()
    expect(artifactPreviewUrl("/etc/passwd")).toBeNull()
    expect(artifactPreviewUrl("quanta-artifact://")).toBeNull()
    expect(artifactPreviewUrl("quanta-artifact://../secret")).toBeNull()
  })
})
