/**
 * A2 Hellgate — artifact PREVIEW CHANNEL plumbing.
 *
 * Covers the four load-bearing bridges (backend/protocol only; no heavy render):
 *  1. drain: a registered artifact → `result.artifacts` ArtifactRef; empty when
 *     the store is off (RED-on-injection if the producer is dropped) + de-dup.
 *  2. mapping: ArtifactKind→kind, previewUrl→locator (NO fs path leak),
 *     mediaType→mimeType, createdAt→ISO.
 *  3. Canvas frame: the `artifact.ready` union member tag-guard + shape-guard
 *     round-trip; a bad shape is rejected.
 *  4. mermaid/katex detection: fenced ```mermaid + $$…$$ marked; lossless;
 *     capability-gated (unset ⇒ plain text byte-identical).
 */

import { describe, expect, test } from "bun:test"
import {
  type Artifact,
  createArtifactRegistry,
  detectRichSegments,
  detectRichSegmentsGated,
  monotonicIdFactory,
  segmentsToText,
} from "@/artifact"
import { drainNewArtifacts, toArtifactRef } from "@/host/runtime/artifact-drain"
import {
  type ArtifactReadyMessage,
  type CanvasMessage,
  decodeCanvasFrame,
  encodeCanvasFrame,
  isCanvasMessage,
  isCanvasMessageKind,
} from "@/protocol/canvas"

const reg = () =>
  createArtifactRegistry({ now: () => 1_700_000_000_000, idFactory: monotonicIdFactory("art") })

describe("A2 — Artifact→ArtifactRef mapping", () => {
  test("maps kind/mediaType/previewUrl and NEVER leaks the fs path", () => {
    const artifact: Artifact = {
      id: "art-7",
      kind: "spreadsheet",
      path: "/jail/secret/abs/path/q3.xlsx",
      mediaType: "application/vnd.ms-excel",
      label: "Q3",
      createdAt: 1_700_000_000_000,
    }
    const ref = toArtifactRef(artifact)
    expect(ref.artifactId).toBe("art-7")
    expect(ref.kind).toBe("spreadsheet")
    expect(ref.mimeType).toBe("application/vnd.ms-excel")
    expect(ref.name).toBe("Q3")
    expect(ref.locator).toBe("quanta-artifact://art-7")
    // JAIL: the absolute on-disk path must never appear on the wire ref.
    expect(JSON.stringify(ref)).not.toContain("/jail/secret/abs/path")
    // createdAt is an ISO string, not the raw epoch number.
    expect(ref.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  test("omits name when the artifact has no label", () => {
    const ref = toArtifactRef({
      id: "art-1",
      kind: "image",
      path: "/j/a.png",
      mediaType: "image/png",
      createdAt: 0,
    })
    expect("name" in ref).toBe(false)
  })
})

describe("A2 — drain producer (the MISSING producer for artifact.ready)", () => {
  test("registered artifacts drain into refs; store-off ⇒ empty (default-OFF)", () => {
    // Store OFF: undefined registry ⇒ no producer ⇒ empty (byte-identical).
    expect(drainNewArtifacts(undefined, new Set())).toEqual([])

    const r = reg()
    r.register({ kind: "image", path: "/j/a.png", mediaType: "image/png", label: "A" })
    r.register({ kind: "document", path: "/j/b.docx", mediaType: "application/msword" })
    const seen = new Set<string>()
    const refs = drainNewArtifacts(r, seen)
    // RED-on-injection: if the producer is dropped this is [] and the assert fails.
    expect(refs.map((x) => x.artifactId)).toEqual(["art-1", "art-2"])
    expect(refs.map((x) => x.locator)).toEqual([
      "quanta-artifact://art-1",
      "quanta-artifact://art-2",
    ])
  })

  test("de-dup: a second drain does NOT re-emit already-seen artifacts", () => {
    const r = reg()
    r.register({ kind: "image", path: "/j/a.png", mediaType: "image/png" })
    const seen = new Set<string>()
    expect(drainNewArtifacts(r, seen).map((x) => x.artifactId)).toEqual(["art-1"])
    // No new registration ⇒ second drain is empty (each artifact ready ONCE).
    expect(drainNewArtifacts(r, seen)).toEqual([])
    // A newly-registered artifact IS emitted on the next drain.
    r.register({ kind: "image", path: "/j/c.png", mediaType: "image/png" })
    expect(drainNewArtifacts(r, seen).map((x) => x.artifactId)).toEqual(["art-2"])
  })
})

describe("A2 — Canvas artifact.ready frame", () => {
  const frame = (): ArtifactReadyMessage => ({
    kind: "artifact.ready",
    artifactId: "art-3",
    artifactKind: "image",
    mimeType: "image/png",
    locator: "quanta-artifact://art-3",
    name: "diagram",
    emittedAt: 42,
  })

  test("kind tag is registered in the closed enum", () => {
    expect(isCanvasMessageKind("artifact.ready")).toBe(true)
  })

  test("shape-guard accepts a well-formed frame and it round-trips the codec", () => {
    const msg: CanvasMessage = frame()
    expect(isCanvasMessage(msg)).toBe(true)
    const decoded = decodeCanvasFrame(encodeCanvasFrame(msg))
    expect(decoded).toEqual(msg)
  })

  test("shape-guard REJECTS an artifact.ready frame missing a load-bearing field", () => {
    const bad = { ...frame(), locator: undefined } as unknown
    expect(isCanvasMessage(bad)).toBe(false)
    // And a non-string kind for the wrong-shape branch.
    const bad2 = { ...frame(), mimeType: 5 } as unknown
    expect(isCanvasMessage(bad2)).toBe(false)
  })

  test("the pre-existing tool.diff / context.usage guards are untouched (no regression)", () => {
    expect(
      isCanvasMessage({
        kind: "tool.diff",
        toolCallId: "t1",
        lines: [],
        additions: 0,
        deletions: 0,
        emittedAt: 1,
      }),
    ).toBe(true)
    expect(
      isCanvasMessage({ kind: "context.usage", segments: [], total: 0, max: 1, emittedAt: 1 }),
    ).toBe(true)
  })
})

describe("A2 — mermaid + katex detection", () => {
  test("detects a fenced mermaid block + display katex; lossless re-join", () => {
    const text = "Intro\n```mermaid\ngraph TD; A-->B\n```\nMiddle $$E=mc^2$$ end"
    const segs = detectRichSegments(text)
    const kinds = segs.map((s) => s.kind)
    expect(kinds).toContain("mermaid")
    expect(kinds).toContain("katex")
    const mermaid = segs.find((s) => s.kind === "mermaid")
    expect(mermaid?.body).toBe("graph TD; A-->B")
    const katex = segs.find((s) => s.kind === "katex")
    expect(katex?.body).toBe("E=mc^2")
    // LOSSLESS: concatenating every segment's source reproduces the input.
    expect(segmentsToText(segs)).toBe(text)
  })

  test("plain prose with a lone $ is a single text segment (no false katex)", () => {
    const text = "It costs $5 and $10, no math here."
    const segs = detectRichSegments(text)
    expect(segs).toEqual([{ kind: "text", source: text }])
  })

  test("capability gate OFF ⇒ single verbatim text segment (byte-identical)", () => {
    const text = "```mermaid\ngraph TD; A-->B\n```"
    // Gated OFF: no scan, one text segment carrying the source verbatim.
    expect(detectRichSegmentsGated(text, false)).toEqual([{ kind: "text", source: text }])
    // Gated ON: delegates to the detector (a mermaid segment appears).
    expect(detectRichSegmentsGated(text, true).some((s) => s.kind === "mermaid")).toBe(true)
  })
})
