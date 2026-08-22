/**
 * Architecture guard for `@/patch` — config in `_arch/slice-boundary-configs.ts`.
 *
 * `@/patch` is a pure leaf: V4A parser + applier + ports, depending only on
 * `@/shared`. The applier's telemetry is supplied via an injected
 * `PatchTracePort` (closed-port DI), so the slice imports NOTHING from the
 * cross-cutting `@/observability` slice — the OTel binding lives in the
 * `@/observability/patch-trace` adapter, wired at the `apply_patch` tool root.
 *
 * Below the standard suite, a NEGATIVE self-test proves the deny-list rule has
 * teeth: a synthetic `@/patch → @/observability` VALUE import IS flagged, while
 * a type-only import (erased at compile time) is NOT — exactly the inversion
 * this slice config was added to lock out.
 */

import { describe, expect, test } from "bun:test"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { extractImports, registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("patch"))

/** Replicates the scanner's deny-prefix match (exact or `@/slice/...` prefix).
 *  Kept local so the negative test asserts against the SAME semantics the
 *  registered suite uses without depending on a non-exported helper. */
const isDenied = (spec: string, deny: readonly string[]): boolean =>
  deny.some((d) => spec === d || spec.startsWith(`${d}/`))

describe("@/patch deny-list — negative self-test (rule has teeth)", () => {
  const cfg = getSliceBoundaryConfig("patch")

  test("the config denies `@/observability` (the eliminated inversion target)", () => {
    expect(cfg.denyImports).toContain("@/observability")
  })

  test("a synthetic `@/patch → @/observability` VALUE import WOULD be flagged", () => {
    // Mimic the pre-fix `applier.ts` line-1 inversion.
    const synthetic = 'import { recordAttrs, SPAN_NAMES } from "@/observability"\n'
    const imports = extractImports(synthetic)
    // The scanner sees the runtime import...
    expect(imports.map((i) => i.spec)).toContain("@/observability")
    // ...and the deny-list match fires on it ⇒ the suite's
    // "no file imports from the slice deny-list" test would FAIL on this file.
    const flagged = imports.filter((i) => isDenied(i.spec, cfg.denyImports))
    expect(flagged.map((i) => i.spec)).toContain("@/observability")
  })

  test("a type-only `@/observability` import is NOT flagged (erased at compile time)", () => {
    // The current adapter relies on this: `@/observability/patch-trace` may
    // `import type { PatchTracePort } from "@/patch"` without runtime coupling,
    // and `@/patch` may carry a type-only attr-shape import if ever needed.
    const synthetic = 'import type { Attrs } from "@/observability"\n'
    const imports = extractImports(synthetic)
    // `extractImports` skips `import type` entirely — zero runtime specs.
    expect(imports.map((i) => i.spec)).not.toContain("@/observability")
  })
})
