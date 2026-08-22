/**
 * Hellgate — T9-cli surface-dispatch + cli-args audited defects.
 *
 * Three audited, verified defects, each with the adversarial case that
 * would have caught the original bug:
 *
 *  (a) surface-compose `extractPaths` per-tool snapshot extractor
 *    HELL-EXTRACT-01: `read` (read-only) MUST NOT be captured — it never
 *                     mutates, so snapshotting it over-captures with zero
 *                     restore value (the original bug: it WAS captured).
 *    HELL-EXTRACT-02: `apply_patch` input is `{ patch }`, NOT `{ path }`.
 *                     The old `path`-only branch captured NOTHING ⇒ apply_patch
 *                     was silently un-restorable under QUANTA_PER_TOOL_RECORD.
 *                     V4A `*** Add/Update/Delete/Move` headers must be parsed.
 *    HELL-EXTRACT-03: write/edit/scripted_replace still extract `path`.
 *
 *  (b) slash projector SSOT — the dead second dispatcher's projector and the
 *      live REPL projector were two manually byte-synced copies. They are now
 *      ONE exported function (`projectSlashCtx`), so they cannot drift.
 *    HELL-PROJ-01: `projectSlashCtx` is exported (the shared SSOT).
 *    HELL-PROJ-02: presence-gated — an empty ctx projects ZERO slots
 *                  (no `undefined` keys leak into the SlashContext).
 *    HELL-PROJ-03: a wired slot survives the projection.
 *
 *  (c) cli-args required-mode-flag enforcement (one-directional → two-way)
 *    HELL-ARGS-01: `--mode ci-bot` without `--pr` throws (was: silently OK).
 *    HELL-ARGS-02: `--mode batch` without `--corpus` throws.
 *    HELL-ARGS-03: `--mode headless` without `-p/--prompt` throws.
 *    HELL-ARGS-04: each happy path (companion flag present) still parses.
 *    HELL-ARGS-05: `--mode interactive` needs none of them.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { AgentArgsError, parseAgentArgs } from "../../../src/apps/agent/cli-args"
import {
  dispatchReplSlash,
  projectSlashCtx,
  type ReplSlashCtx,
} from "../../../src/apps/cli/repl/slash-surface"
import { extractApplyPatchPaths } from "../../../src/apps/cli/repl/surface-compose"

/* ------------------------------------------------------------------ */
/* (a) extractApplyPatchPaths — V4A header parse                        */
/* ------------------------------------------------------------------ */

describe("HELL-EXTRACT — per-tool snapshot path extractor", () => {
  test("HELL-EXTRACT-02: Add/Update/Delete headers all extracted", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const x = 1",
      "*** Update File: src/old.ts",
      "@@",
      "-const a = 1",
      "+const a = 2",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n")
    expect(extractApplyPatchPaths(patch)).toEqual(["src/new.ts", "src/old.ts", "src/gone.ts"])
  })

  test("HELL-EXTRACT-02b: Move to: captures BOTH source and destination", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/from.ts",
      "*** Move to: src/to.ts",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n")
    // Source must be snapshotted (prior contents); destination created (so a
    // restore can delete it). Both, deduped, order-preserving.
    expect(extractApplyPatchPaths(patch)).toEqual(["src/from.ts", "src/to.ts"])
  })

  test("HELL-EXTRACT-02c: deduped + order-preserving across repeated targets", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " ctx",
      "*** Update File: a.ts",
      "@@",
      " ctx2",
      "*** Add File: b.ts",
      "+z",
      "*** End Patch",
    ].join("\n")
    expect(extractApplyPatchPaths(patch)).toEqual(["a.ts", "b.ts"])
  })

  test("HELL-EXTRACT-02d: body lines that merely contain a header word are ignored", () => {
    // A `+`-prefixed body line containing the words "Add File" is NOT a
    // directive header (no `*** ` prefix) ⇒ must not be mistaken for a path.
    const patch = [
      "*** Begin Patch",
      "*** Add File: real.ts",
      "+// *** Add File: not-a-path.ts",
      "*** End Patch",
    ].join("\n")
    expect(extractApplyPatchPaths(patch)).toEqual(["real.ts"])
  })

  test("HELL-EXTRACT-02e: no directive headers ⇒ empty", () => {
    expect(extractApplyPatchPaths("garbage with no sentinels")).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* (b) projectSlashCtx — single shared projector (no byte-sync drift)   */
/* ------------------------------------------------------------------ */

describe("HELL-PROJ — slash projector SSOT", () => {
  test("HELL-PROJ-01: projectSlashCtx is the exported shared projector", () => {
    expect(typeof projectSlashCtx).toBe("function")
  })

  test("HELL-PROJ-02: undefined / empty ctx ⇒ ZERO leaked slots", () => {
    expect(projectSlashCtx(undefined)).toEqual({})
    // An object whose optional slots are all absent must project no keys —
    // not `{ skills: undefined, ... }` (which would poison exactOptional sites).
    const projected = projectSlashCtx({} as ReplSlashCtx)
    expect(Object.keys(projected)).toEqual([])
  })

  test("HELL-PROJ-03: a wired slot survives projection (skills + textInbox)", () => {
    const skills = async () => []
    const textInbox = { add: () => {}, size: () => 0 } as unknown as ReplSlashCtx["textInbox"]
    const projected = projectSlashCtx({ skills, textInbox } as ReplSlashCtx)
    expect(projected.skills).toBe(skills)
    expect(projected.textInbox).toBe(textInbox)
    // No spurious extra keys leaked.
    expect(Object.keys(projected).sort()).toEqual(["skills", "textInbox"])
  })

  test("HELL-PROJ-04: legacy dispatch honors slashCtx.cwd, not ambient process.cwd()", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "quanta-repl-slash-cwd-"))
    const origOut = process.stdout.write.bind(process.stdout)
    let out = ""
    process.stdout.write = ((chunk: unknown): boolean => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const handled = await dispatchReplSlash("/hooks", { cwd } as ReplSlashCtx)
      expect(handled).toBe(true)
    } finally {
      process.stdout.write = origOut
    }
    expect(out).toContain(`${cwd}/settings.json`)
    expect(out).not.toContain(`${process.cwd()}/settings.json`)
  })
})

/* ------------------------------------------------------------------ */
/* (c) cli-args — required mode-flag enforcement (two-directional)      */
/* ------------------------------------------------------------------ */

describe("HELL-ARGS — required mode-flag enforcement", () => {
  test("HELL-ARGS-01: --mode ci-bot without --pr throws (was silently OK)", () => {
    expect(() => parseAgentArgs(["--mode", "ci-bot"])).toThrow(AgentArgsError)
    expect(() => parseAgentArgs(["--mode", "ci-bot"])).toThrow(
      /--pr is required with --mode ci-bot/,
    )
  })

  test("HELL-ARGS-02: --mode batch without --corpus throws", () => {
    expect(() => parseAgentArgs(["--mode", "batch"])).toThrow(
      /--corpus is required with --mode batch/,
    )
  })

  test("HELL-ARGS-03: --mode headless without -p/--prompt throws", () => {
    expect(() => parseAgentArgs(["--mode", "headless"])).toThrow(
      /-p\/--prompt is required with --mode headless/,
    )
  })

  test("HELL-ARGS-04: happy paths with companion flag still parse", () => {
    expect(parseAgentArgs(["--mode", "ci-bot", "--pr", "42"]).pr).toBe("42")
    expect(parseAgentArgs(["--mode", "batch", "--corpus", "/x"]).corpus).toBe("/x")
    expect(parseAgentArgs(["--mode", "headless", "-p", "do it"]).prompt).toBe("do it")
  })

  test("HELL-ARGS-05: --mode interactive requires none of the companion flags", () => {
    const a = parseAgentArgs(["--mode", "interactive"])
    expect(a.mode).toBe("interactive")
  })
})
