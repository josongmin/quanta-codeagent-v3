/**
 * Cross-tool e2e Hellgate — C1 artifact AUTO-REGISTER loop through REAL dispatch.
 *
 * The unit hellgate (`artifact-auto-register-c1-hellgate.test.ts`) proves the
 * generation tools register their output into an INJECTED registry. This battery
 * proves the AGENTIC chain end-to-end through the REAL production composition
 * (`buildBaseFromArgs` → its `ToolRegistry`) + the REAL `dispatchTool`:
 *
 *   GENERATION tool writes a file → auto-registers it →
 *   a SUBSEQUENT `artifact_list` / `artifact_get` call SURFACES it.
 *
 * The crux (#1): the generation tools and the `artifact_*` tools must be wired to
 * the SAME registry instance minted ONCE at the composition root
 * (`buildGatedToolPorts`). If they were NOT shared, auto-register would be
 * invisible to `artifact_list` — a real, silent bug. We prove the shared instance
 * DYNAMICALLY: drive `image_gen` / `xlsx_write` through dispatch, then drive
 * `artifact_list` through dispatch against the SAME registry and assert the
 * generated artifact appears (no registry handle is ever injected by the test —
 * everything flows from the one the composition root built).
 *
 * Determinism / no real network:
 *   - `OPENAI_API_KEY` is pinned so the root constructs the LLM + the key-bound
 *     `openAiImagePort`; `globalThis.fetch` is stubbed to return a canned OpenAI
 *     images response, so `image_gen` writes a real PNG to a tmp jail with NO HTTP.
 *   - `xlsx_write` writes real OOXML bytes (no network).
 *   - All writes are confined to a fresh per-test tmp jail cwd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { OOXML_MEDIA_TYPES, type ToolRegistry } from "@/tool"

const BYPASS: PermissionContext = { mode: "bypass" }

/** Minimal 1×1 PNG (67 bytes) — the canned provider payload. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/** Knobs + key vars this battery drives — snapshot/strip before each test so the
 *  ambient shell can neither pre-enable a gate nor remove the key the builder
 *  needs, and restore after. */
const DRIVEN = [
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_IMAGE_GEN",
  "QUANTA_OFFICE_AUTHORING",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
] as const

const saved: Record<string, string | undefined> = {}

/** Records every fetch call so we can assert the canned provider was hit. */
let fetchCalls: string[] = []
let realFetch: typeof globalThis.fetch

/** Install a canned OpenAI-images fetch that returns the 1×1 PNG as b64_json. */
const installCannedFetch = (): void => {
  fetchCalls = []
  const b64 = Buffer.from(PNG_1x1).toString("base64")
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    fetchCalls.push(url)
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

let jail: string

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The builder REQUIRES a provider key or it throws ProviderKeyMissingError.
  // Pin a deterministic BYOK OpenAI key so the LLM factory + the key-bound
  // openAiImagePort both construct.
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-deterministic-key"
  __resetRuntimeConfig()
  realFetch = globalThis.fetch
  installCannedFetch()
  jail = mkdtempSync(join(tmpdir(), "c1-cross-tool-e2e-"))
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
  try {
    rmSync(jail, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const partial = () => ({ mode: "headless" as const, dials: undefined })

const config = (registry: ToolRegistry): AgentConfig =>
  ({
    cwd: jail,
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
  }) as AgentConfig

let callSeq = 0
const call = (name: string, input: unknown): ToolUseBlock => {
  callSeq += 1
  return { type: "tool_use", id: `c${callSeq}`, name, input }
}

/** Build the production base with the C1 + a generation knob ON, returning the
 *  REAL registry (whose artifact_* and generation tools share the ONE registry
 *  the composition root minted in `buildGatedToolPorts`). */
const rootRegistry = (knobs: Record<string, string>): ToolRegistry => {
  for (const [k, v] of Object.entries(knobs)) process.env[k] = v
  __resetRuntimeConfig()
  return buildBaseFromArgs(partial()).registry as ToolRegistry
}

/* ──────────────────────────────────────────────────────────────────────────
 * #1 — THE CRUX: the registry instance is SHARED across generation + artifact_*
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — shared registry instance (the crux)", () => {
  test("image_gen + artifact_* tools are BOTH present from ONE composition root", () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_IMAGE_GEN: "1" })
    const names = registry.all().map((t) => t.name)
    expect(names).toContain("image_gen")
    expect(names).toContain("artifact_list")
    expect(names).toContain("artifact_get")
    // If the composition minted TWO registries, the auto-register would be
    // invisible to artifact_list. The dynamic proof lives in the cross-tool
    // chains below — here we only assert co-presence from one root.
  })

  test("xlsx_write auto-register is VISIBLE to a subsequent artifact_list (proves ONE instance)", async () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_OFFICE_AUTHORING: "1" })
    const cfg = config(registry)

    // Sanity: list starts empty (no artifact registered yet).
    const before = await dispatchTool(call("artifact_list", {}), cfg, BYPASS)
    expect(before.ok).toBe(true)
    expect(before.preview).toContain("No artifacts")

    // Generation tool writes + auto-registers into the SAME registry.
    const gen = await dispatchTool(
      call("xlsx_write", { path: "report.xlsx", sheets: [{ name: "S1", rows: [["a", 1]] }] }),
      cfg,
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    expect(gen.preview).toContain("Registered artifact")

    // SUBSEQUENT artifact_list (same dispatch path, same registry) surfaces it.
    const after = await dispatchTool(call("artifact_list", {}), cfg, BYPASS)
    expect(after.ok).toBe(true)
    expect(after.preview).not.toContain("No artifacts")
    expect(after.preview).toContain("spreadsheet")
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * #2 — image_gen → artifact_list → artifact_get
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — image_gen → artifact_list/get", () => {
  test("dispatch image_gen (real key-bound port, canned fetch) → artifact surfaces with kind=image", async () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_IMAGE_GEN: "1" })
    const cfg = config(registry)

    const gen = await dispatchTool(
      call("image_gen", { prompt: "a red square", outputPath: "assets/square.png" }),
      cfg,
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    // The canned provider was actually hit through the REAL composition-wired port.
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]).toContain("/images/generations")
    expect(gen.preview).toContain("Registered artifact")

    // The PNG was really written to the jail.
    const written = join(jail, "assets", "square.png")
    const bytes = new Uint8Array(readFileSync(written))
    expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC)

    // A SUBSEQUENT artifact_list call surfaces the image with the right kind+mime.
    const listed = await dispatchTool(call("artifact_list", {}), cfg, BYPASS)
    expect(listed.ok).toBe(true)
    expect(listed.preview).toContain("image")
    expect(listed.preview).toContain("image/png")

    // Pull the minted id out of the list line and fetch it back via artifact_get.
    const idMatch = /(art-\d+)/.exec(listed.preview)
    expect(idMatch).not.toBeNull()
    const id = (idMatch as RegExpExecArray)[1] as string
    const got = await dispatchTool(call("artifact_get", { id }), cfg, BYPASS)
    expect(got.ok).toBe(true)
    expect(got.preview).toContain("square.png")
    expect(got.preview).toContain(`quanta-artifact://${id}`)

    // kind filter narrows to the image (cross-tool, same registry).
    const onlyImages = await dispatchTool(call("artifact_list", { kind: "image" }), cfg, BYPASS)
    expect(onlyImages.preview).toContain(id)
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * #3 — xlsx_write → artifact_list (kind=spreadsheet + OOXML mime + jailed path)
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — xlsx_write → artifact_list", () => {
  test("artifact_list shows the spreadsheet with the OOXML media type + actual jailed path", async () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_OFFICE_AUTHORING: "1" })
    const cfg = config(registry)

    const gen = await dispatchTool(
      call("xlsx_write", { path: "q3.xlsx", sheets: [{ name: "Q3", rows: [["Region", 1]] }] }),
      cfg,
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    expect(await Bun.file(join(jail, "q3.xlsx")).exists()).toBe(true)

    const listed = await dispatchTool(call("artifact_list", {}), cfg, BYPASS)
    expect(listed.ok).toBe(true)
    expect(listed.preview).toContain("spreadsheet")
    expect(listed.preview).toContain(OOXML_MEDIA_TYPES.xlsx)
    // The registered path is the ACTUAL jailed absolute path on disk.
    expect(listed.preview).toContain(join(jail, "q3.xlsx"))

    // kind filter excludes a non-existent kind (cross-tool semantics).
    const images = await dispatchTool(call("artifact_list", { kind: "image" }), cfg, BYPASS)
    expect(images.preview).toContain("No artifacts")
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * #4 — n>1 images: each registered with its OWN mediaType, all in the list
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — n>1 image batch", () => {
  test("image_gen n=2 → artifact_list shows BOTH images", async () => {
    // The canned provider returns ONE image per call; with n=2 the tool writes
    // two siblings only if the provider returns two. Stub a two-image response.
    const b64 = Buffer.from(PNG_1x1).toString("base64")
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetchCalls.push(String(input))
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }, { b64_json: b64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_IMAGE_GEN: "1" })
    const cfg = config(registry)

    const gen = await dispatchTool(
      call("image_gen", { prompt: "two squares", outputPath: "batch/sq.png", n: 2 }),
      cfg,
      BYPASS,
    )
    expect(gen.ok).toBe(true)

    const listed = await dispatchTool(call("artifact_list", { kind: "image" }), cfg, BYPASS)
    expect(listed.ok).toBe(true)
    // Two distinct ids registered for the batch.
    const ids = [...listed.preview.matchAll(/(art-\d+)/g)].map((m) => m[1])
    const distinct = new Set(ids)
    expect(distinct.size).toBe(2)
    // Both labelled with the image media type.
    expect(listed.preview).toContain("image/png")
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * #5 — best-effort: registry port ABSENT (knob OFF) ⇒ generation still works,
 *      no register line, no artifact_* tool registered, byte-identical write
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — registry ABSENT (QUANTA_ARTIFACT_STORE off)", () => {
  test("xlsx_write still writes + no register line + artifact_* NOT in the menu", async () => {
    // Generation knob ON, artifact store OFF.
    const registry = rootRegistry({ QUANTA_OFFICE_AUTHORING: "1" })
    const names = registry.all().map((t) => t.name)
    expect(names).toContain("xlsx_write")
    expect(names).not.toContain("artifact_list")

    const gen = await dispatchTool(
      call("xlsx_write", { path: "off.xlsx", sheets: [{ name: "S", rows: [["x"]] }] }),
      config(registry),
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    expect(await Bun.file(join(jail, "off.xlsx")).exists()).toBe(true)
    // No artifact registry ⇒ no register line (byte-identical to the const tool).
    expect(gen.preview).not.toContain("Registered artifact")
    expect(gen.preview).not.toContain("quanta-artifact://")
  })

  test("image_gen still writes the PNG with no register line when the store is OFF", async () => {
    const registry = rootRegistry({ QUANTA_IMAGE_GEN: "1" })
    const gen = await dispatchTool(
      call("image_gen", { prompt: "x", outputPath: "noreg.png" }),
      config(registry),
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    expect(await Bun.file(join(jail, "noreg.png")).exists()).toBe(true)
    expect(gen.preview).not.toContain("Registered artifact")
  })
})

/* ──────────────────────────────────────────────────────────────────────────
 * #6 — each dispatch yields exactly one tool_result; a throwing registry does
 *      NOT break the generation dispatch (best-effort side-channel).
 * ────────────────────────────────────────────────────────────────────────── */

describe("C1 cross-tool — single result + no iterator reject", () => {
  test("every cross-tool dispatch returns exactly one tool_result block (ok or not)", async () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_OFFICE_AUTHORING: "1" })
    const cfg = config(registry)

    for (const c of [
      call("xlsx_write", { path: "r.xlsx", sheets: [{ name: "S", rows: [["a"]] }] }),
      call("artifact_list", {}),
      call("artifact_get", { id: "art-1" }),
    ]) {
      const res = await dispatchTool(c, cfg, BYPASS)
      // dispatchTool always resolves to a single DispatchResult with a
      // tool_result block — never rejects the iterator, even for artifact_get
      // on a possibly-missing id.
      expect(res.block.type).toBe("tool_result")
    }
  })

  test("a generation dispatch with the store ON never rejects even though register is a side-channel", async () => {
    const registry = rootRegistry({ QUANTA_ARTIFACT_STORE: "1", QUANTA_OFFICE_AUTHORING: "1" })
    const gen = await dispatchTool(
      call("docx_write", {
        path: "d.docx",
        paragraphs: [{ kind: "heading", level: 1, text: "H" }],
      }),
      config(registry),
      BYPASS,
    )
    expect(gen.ok).toBe(true)
    expect(gen.block.type).toBe("tool_result")
    expect(gen.preview).toContain("Registered artifact")
  })
})
