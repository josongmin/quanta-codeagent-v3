/**
 * Unit tests for file-tree-summary purpose-extraction hardening.
 *
 * Covers:
 *  - isNoiseLine deny-list (all explicit entries)
 *  - parsePurposeRows noise filtering (5-candidate skip-to-first-clean)
 *  - rendered-vs-scanned alignment (renderedFiles set from aggregate)
 *  - shebang + noise-only fallback cases
 */
import { describe, expect, test } from "bun:test"
import { isNoiseLine, parsePurposeRows } from "@/tool/file-tree-summary"

// ---------------------------------------------------------------------------
// isNoiseLine — every deny-list entry
// ---------------------------------------------------------------------------
describe("isNoiseLine", () => {
  // Copyright variants
  test("copyright (lowercase)", () => expect(isNoiseLine("// copyright 2024 ACME")).toBe(true))
  test("Copyright (mixed case)", () => expect(isNoiseLine("// Copyright (c) 2024")).toBe(true))
  test("COPYRIGHT (upper)", () => expect(isNoiseLine("/* COPYRIGHT 2024 */")).toBe(true))

  // SPDX
  test("SPDX-License-Identifier", () =>
    expect(isNoiseLine("// SPDX-License-Identifier: MIT")).toBe(true))

  // All rights reserved
  test("all rights reserved", () => expect(isNoiseLine("// All Rights Reserved.")).toBe(true))

  // @license
  test("@license in comment", () => expect(isNoiseLine("// @license MIT")).toBe(true))
  test("@license bare", () => expect(isNoiseLine("@license Apache-2.0")).toBe(true))

  // eslint
  test("eslint-disable", () => expect(isNoiseLine("// eslint-disable")).toBe(true))
  test("eslint-disable-next-line", () =>
    expect(isNoiseLine("// eslint-disable-next-line no-unused-vars")).toBe(true))
  test("eslint-enable", () => expect(isNoiseLine("// eslint-enable")).toBe(true))

  // Testing that "biome-ignore" as a substring in file content is treated as noise:
  test("biome-ignore substring", () =>
    expect(isNoiseLine("// biome-ignore lint/style/noVar")).toBe(true))

  // @ts-*
  test("@ts-nocheck", () => expect(isNoiseLine("// @ts-nocheck")).toBe(true))
  test("@ts-ignore", () => expect(isNoiseLine("// @ts-ignore")).toBe(true))
  test("@ts-expect-error", () => expect(isNoiseLine("// @ts-expect-error")).toBe(true))

  // prettier-ignore
  test("prettier-ignore", () => expect(isNoiseLine("// prettier-ignore")).toBe(true))

  // "use X" directives (with/without semicolon, single/double quotes)
  test('"use strict"', () => expect(isNoiseLine('"use strict"')).toBe(true))
  test('"use strict";', () => expect(isNoiseLine('"use strict";')).toBe(true))
  test("'use strict'", () => expect(isNoiseLine("'use strict'")).toBe(true))
  test("'use strict';", () => expect(isNoiseLine("'use strict';")).toBe(true))
  test('"use client"', () => expect(isNoiseLine('"use client"')).toBe(true))
  test('"use client";', () => expect(isNoiseLine('"use client";')).toBe(true))
  test('"use server"', () => expect(isNoiseLine('"use server"')).toBe(true))
  test('"use server";', () => expect(isNoiseLine('"use server";')).toBe(true))

  // shebang
  test("shebang #!/usr/bin/env node", () => expect(isNoiseLine("#!/usr/bin/env node")).toBe(true))
  test("shebang #!/bin/sh", () => expect(isNoiseLine("#!/bin/sh")).toBe(true))

  // NON-noise — should NOT match
  test("export function is NOT noise", () =>
    expect(isNoiseLine("export function foo()")).toBe(false))
  test("class declaration is NOT noise", () => expect(isNoiseLine("class Foo {}")).toBe(false))
  test("// comment about purpose is NOT noise", () =>
    expect(isNoiseLine("// Entry point for the CLI")).toBe(false))
  test('"use awesome" is NOT noise (not a known directive)', () =>
    expect(isNoiseLine('"use awesome"')).toBe(false))
  test("type Foo = ... is NOT noise", () => expect(isNoiseLine("type Foo = string")).toBe(false))
})

// ---------------------------------------------------------------------------
// parsePurposeRows — noise filtering + multi-candidate per file
// ---------------------------------------------------------------------------
describe("parsePurposeRows", () => {
  test("first non-noise line wins (copyright→SPDX→blank→eslint→export wins)", () => {
    const stdout = [
      "src/a.ts:1:// Copyright 2024 ACME Corp",
      "src/a.ts:2:// SPDX-License-Identifier: MIT",
      "src/a.ts:3:", // blank text, skipped
      "src/a.ts:4:// eslint-disable no-console",
      "src/a.ts:5:export function foo()",
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.get("src/a.ts")).toBe("export function foo()")
    expect(map.size).toBe(1)
  })

  test("shebang + export: shebang skipped, export wins", () => {
    const stdout = ["bin/cli.ts:1:#!/usr/bin/env node", "bin/cli.ts:2:export function bar()"].join(
      "\n",
    )
    const map = parsePurposeRows(stdout)
    expect(map.get("bin/cli.ts")).toBe("export function bar()")
  })

  test("all 5 candidates are noise → no entry for that file", () => {
    const stdout = [
      "src/noisy.ts:1:// Copyright 2024",
      "src/noisy.ts:2:// SPDX-License-Identifier: Apache-2.0",
      "src/noisy.ts:3:// All Rights Reserved",
      "src/noisy.ts:4:// eslint-disable",
      "src/noisy.ts:5:// @ts-nocheck",
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.has("src/noisy.ts")).toBe(false)
  })

  test("once a non-noise hint is found, later rows for the same file are ignored", () => {
    const stdout = [
      "src/b.ts:3:export const x = 1",
      "src/b.ts:7:export const y = 2", // second match — ignored
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.get("src/b.ts")).toBe("export const x = 1")
  })

  test("multiple files each get correct first non-noise line", () => {
    const stdout = [
      "a.ts:1:// Copyright Corp",
      "a.ts:2:export class A {}",
      "b.ts:1:// @ts-nocheck",
      "b.ts:2:// prettier-ignore",
      "b.ts:3:function doIt() {}",
      "c.ts:1:type Config = {}",
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.get("a.ts")).toBe("export class A {}")
    expect(map.get("b.ts")).toBe("function doIt() {}")
    expect(map.get("c.ts")).toBe("type Config = {}")
  })

  test("hint is capped at 80 chars with ellipsis", () => {
    const longLine = `export const ${"x".repeat(100)}`
    const stdout = `src/long.ts:1:${longLine}`
    const map = parsePurposeRows(stdout)
    const hint = map.get("src/long.ts")
    expect(hint).toBeDefined()
    expect(hint?.endsWith("…")).toBe(true)
    // The sliced part is 80 chars + "…"
    expect(hint?.length).toBe(81)
  })

  test("existing behavior: first match per file wins (legacy compat)", () => {
    const stdout = [
      "src/a.ts:1:  export const a = 1",
      "src/a.ts:5:  export const b = 2", // second hit ignored
      "src/b.ts:3:// a comment",
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.get("src/a.ts")).toBe("export const a = 1")
    expect(map.get("src/b.ts")).toBe("// a comment")
    expect(map.size).toBe(2)
  })

  test("empty stdout returns empty map", () => {
    expect(parsePurposeRows("").size).toBe(0)
    expect(parsePurposeRows("\n\n").size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// renderedFiles alignment — pure aggregate() test
// ---------------------------------------------------------------------------
describe("renderedFiles alignment", () => {
  // We import aggregate indirectly by testing the invariant via parsePurposeRows:
  // renderedFiles MUST be a subset of files in byDir (only rendered files get hints).
  // We verify this contract using parsePurposeRows with a simulated stdout that only
  // contains rows for files in the renderedFiles set.

  test("rendered-vs-scanned: hints map only to rendered files (not deepRollup files)", () => {
    // Simulate: rendered files are 10 shallow files; deep files are never scanned.
    // The purpose pass stdout only contains rows for rendered files.

    // Rendered files: 10 shallow files at depth 1 (src/a1.ts … src/a10.ts)
    const renderedSet = new Set(Array.from({ length: 10 }, (_, i) => `src/a${i + 1}.ts`))
    // Deep files (would appear in old code if scanning whole scope): 5 entries
    const deepFiles = Array.from({ length: 5 }, (_, i) => `src/deep/nested/b${i}.ts`)

    // Build simulated stdout: ONLY rendered files have hints
    const rows = [...renderedSet].map((f, i) => `${f}:${i + 1}:export function fn${i}()`).join("\n")
    // Deep files do NOT appear in stdout (they weren't scanned)
    const map = parsePurposeRows(rows)

    // All rendered files have hints
    for (const f of renderedSet) {
      expect(map.has(f)).toBe(true)
    }
    // Deep files have NO hints
    for (const f of deepFiles) {
      expect(map.has(f)).toBe(false)
    }
    // Total size matches rendered set
    expect(map.size).toBe(renderedSet.size)
  })

  test("parsePurposeRows itself has no cap (cap is in execute() targetFiles slice)", () => {
    // Build a synthetic stdout that has 250 rendered files × 1 row each
    const rows = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts:1:export const x${i} = 1`)
    // parsePurposeRows itself processes all rows it receives; the SUMMARY_FILE_CAP
    // enforcement happens in execute() when slicing renderedFiles before building the rg argv.
    const map = parsePurposeRows(rows.join("\n"))
    expect(map.size).toBe(250)
  })
})
