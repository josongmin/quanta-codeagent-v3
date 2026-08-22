/**
 * Hellgate — dispatch.ts wires for ADR-0121 (checkpoint policy via
 * EffectChannel) and ADR-0126 (image attachments via composeToolResultContent).
 *
 * Six cases sealed:
 *  1. No shadowCheckpoint + no images → byte-identical (wrap is a pass-through:
 *     `registerHead` is NEVER called, and the tool_result block has NO
 *     `contentBlocks` field — only the legacy `content` string).
 *  2. shadowCheckpoint mode="pre-destructive" + destructive call (`isReadOnly()
 *     === false`) → `wireCheckpointedEffectChannel`'s wrap kicks in: the
 *     fake `ShadowOdb.registerHead` is invoked exactly once before the tool
 *     executes.
 *  3. ToolResult with NO `images` field → `tool_result.content` is a string and
 *     `contentBlocks` is OMITTED (byte-identical legacy shape).
 *  4. ToolResult with 1 image → `tool_result.contentBlocks` is the composed
 *     `[{type:"text",text}, ImageBlock]` array; legacy `content` keeps the
 *     text view (so OpenAI/legacy consumers still work).
 *  5. ToolResult with `images: []` → treated as ABSENT → `contentBlocks`
 *     OMITTED (NOT an empty array). Byte-identical.
 *  6. End-to-end: an image-returning fake tool drives dispatch and the final
 *     `DispatchResult.block.contentBlocks` carries the ImageBlock in the
 *     expected shape (`{type:"image", data, mediaType}`), AT INDEX 1, with
 *     `{type:"text",text:output}` at index 0.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ImageBlock, ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { ShadowOdb } from "@/storage"
import type { Tool, ToolEvent, ToolResult } from "@/tool"
import { ToolRegistry } from "@/tool"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const makeTool = (
  name: string,
  readOnly: boolean,
  result: ToolResult,
  schema: z.ZodTypeAny = z.object({}),
): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: schema as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result }
  },
})

const perm: PermissionContext = { mode: "acceptEdits" }

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

/** Build a minimal AgentConfig from a registry + optional overrides. The
 *  shadowOdb / shadowCheckpoint slots are populated ONLY when a test opts in. */
const config = (registry: ToolRegistry, over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry,
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig

/** Hand-rolled fake `ShadowOdb`. Only `registerHead` is wired (the only method
 *  the wrap touches on the anchor path). Every other method throws — an
 *  accidental call would surface loudly in the wired tests. */
const makeFakeOdb = (over: { registerHead?: ShadowOdb["registerHead"] } = {}): ShadowOdb => {
  const ni = (name: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${name} not implemented`)
  }
  return {
    init: ni("init") as ShadowOdb["init"],
    registerHead: over.registerHead ?? (ni("registerHead") as ShadowOdb["registerHead"]),
    diffSinceLast: ni("diffSinceLast") as ShadowOdb["diffSinceLast"],
    diffWorkspaceSinceLast: ni("diffWorkspaceSinceLast") as ShadowOdb["diffWorkspaceSinceLast"],
    rewindToLast: ni("rewindToLast") as ShadowOdb["rewindToLast"],
    restorePartial: ni("restorePartial") as ShadowOdb["restorePartial"],
    markVerified: ni("markVerified") as ShadowOdb["markVerified"],
    rewindToVerified: ni("rewindToVerified") as ShadowOdb["rewindToVerified"],
    listSnapshots: ni("listSnapshots") as ShadowOdb["listSnapshots"],
    rewindToRef: ni("rewindToRef") as ShadowOdb["rewindToRef"],
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: ni("diffSinceRef") as ShadowOdb["diffSinceRef"],
    cleanup: ni("cleanup") as ShadowOdb["cleanup"],
  }
}

const PNG_IMAGE: ImageBlock = {
  type: "image",
  data: "iVBORw0KGgo=", // dummy base64
  mediaType: "image/png",
}

/* ------------------------------------------------------------------ */
/* 1. byte-identical default (no checkpoint, no images)               */
/* ------------------------------------------------------------------ */

describe("HELL-1: default → byte-identical", () => {
  test("no shadowCheckpoint + no images ⇒ registerHead never called AND no contentBlocks", async () => {
    let registerHeadCalls = 0
    // Note: even though we BUILD a fake odb, we do NOT wire it into the config.
    // The point is the wire helper must short-circuit when `shadowCheckpoint`
    // is absent — registerHead would never be called regardless. We use the
    // fake to detect any accidental call via a per-test counter.
    const odb = makeFakeOdb({
      registerHead: async () => {
        registerHeadCalls += 1
        return "head-sha-fake"
      },
    })
    void odb // odb intentionally NOT attached to config
    const tool = makeTool("noop", true, { ok: true, output: "ok-out" })
    const res = await dispatchTool(call("noop"), config(new ToolRegistry([tool])), perm)
    expect(res.ok).toBe(true)
    expect(res.block.content).toBe("ok-out")
    expect(res.block.contentBlocks).toBeUndefined()
    expect(registerHeadCalls).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* 2. checkpoint pre-destructive: destructive call ⇒ anchor taken     */
/* ------------------------------------------------------------------ */

describe("HELL-2: shadowCheckpoint + destructive call ⇒ wire kicks in", () => {
  test("mode=pre-destructive + isReadOnly()=false ⇒ registerHead invoked once", async () => {
    let registerHeadCalls = 0
    let lastWorkspace = ""
    const odb = makeFakeOdb({
      registerHead: async (workspace: string) => {
        registerHeadCalls += 1
        lastWorkspace = workspace
        return "head-sha-fake"
      },
    })
    const tool = makeTool("mutate", false, { ok: true, output: "wrote" })
    const cfg = config(new ToolRegistry([tool]), {
      shadowOdb: odb,
      shadowCheckpoint: { mode: "pre-destructive" },
    })
    const res = await dispatchTool(call("mutate"), cfg, perm)
    expect(res.ok).toBe(true)
    // The auto-anchor wrap consulted the policy (destructive call ⇒
    // shouldAnchorBefore=true under default oracle), took the anchor, and
    // then delegated to the underlying executor — so the tool still ran.
    expect(registerHeadCalls).toBe(1)
    expect(lastWorkspace).toBe("/repo")
    expect(res.block.content).toBe("wrote")
  })
})

/* ------------------------------------------------------------------ */
/* 3. no images → content is a string, no contentBlocks               */
/* ------------------------------------------------------------------ */

describe("HELL-3: no images ⇒ string content, no contentBlocks", () => {
  test("ToolResult{ok:true,output} ⇒ tool_result.content string + contentBlocks omitted", async () => {
    const tool = makeTool("plain", true, { ok: true, output: "plain-text" })
    const res = await dispatchTool(call("plain"), config(new ToolRegistry([tool])), perm)
    expect(res.block.content).toBe("plain-text")
    expect(res.block.contentBlocks).toBeUndefined()
    expect("contentBlocks" in res.block).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 4. one image → contentBlocks = [{text}, image]                     */
/* ------------------------------------------------------------------ */

describe("HELL-4: 1 image ⇒ composed contentBlocks", () => {
  test("ToolResult{output,images:[img]} ⇒ contentBlocks = [{type:text,text:output}, image]", async () => {
    const tool = makeTool("with-img", true, {
      ok: true,
      output: "look at this",
      images: [PNG_IMAGE],
    })
    const res = await dispatchTool(call("with-img"), config(new ToolRegistry([tool])), perm)
    // Legacy `content` keeps the text view (so OpenAI / legacy consumers work).
    expect(res.block.content).toBe("look at this")
    // Structured `contentBlocks` carries the array form Anthropic uses on the
    // wire when image attachments are present.
    expect(res.block.contentBlocks).toBeDefined()
    expect(res.block.contentBlocks?.length).toBe(2)
    expect(res.block.contentBlocks?.[0]).toEqual({ type: "text", text: "look at this" })
    expect(res.block.contentBlocks?.[1]).toBe(PNG_IMAGE)
  })
})

/* ------------------------------------------------------------------ */
/* 5. images:[] → treated as absent → no contentBlocks                */
/* ------------------------------------------------------------------ */

describe("HELL-5: images:[] (empty) ⇒ NO contentBlocks", () => {
  test("empty images array is treated as ABSENT (NOT an empty array on the block)", async () => {
    const tool = makeTool("empty-img", true, {
      ok: true,
      output: "no images here",
      images: [],
    })
    const res = await dispatchTool(call("empty-img"), config(new ToolRegistry([tool])), perm)
    expect(res.block.content).toBe("no images here")
    expect(res.block.contentBlocks).toBeUndefined()
    expect("contentBlocks" in res.block).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 6. end-to-end: image-bearing tool ⇒ block.contentBlocks shaped     */
/* ------------------------------------------------------------------ */

describe("HELL-6: end-to-end ⇒ block carries the ImageBlock in correct shape", () => {
  test("full dispatch flow with image-returning tool ⇒ final block.contentBlocks[1] is the image", async () => {
    const img: ImageBlock = {
      type: "image",
      data: "QkFTRTY0", // "BASE64" in base64
      mediaType: "image/jpeg",
    }
    const tool = makeTool("screencap", true, {
      ok: true,
      output: "captured screen",
      images: [img],
    })
    const res = await dispatchTool(
      call("screencap", {}, "c-e2e"),
      config(new ToolRegistry([tool])),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.block.type).toBe("tool_result")
    expect(res.block.tool_use_id).toBe("c-e2e")
    expect(res.block.is_error).toBeUndefined()
    // The blocks contain text-then-image, and the image preserves the
    // tool's exact base64 payload + mediaType (no re-encoding).
    const blocks = res.block.contentBlocks
    expect(blocks).toBeDefined()
    if (!blocks) throw new Error("unreachable: contentBlocks missing")
    expect(blocks.length).toBe(2)
    const text = blocks[0]
    const image = blocks[1]
    expect(text).toEqual({ type: "text", text: "captured screen" })
    if (image?.type !== "image") throw new Error("expected ImageBlock at index 1")
    expect(image.type).toBe("image")
    expect(image.data).toBe("QkFTRTY0")
    expect(image.mediaType).toBe("image/jpeg")
  })
})
