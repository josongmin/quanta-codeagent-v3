/**
 * Architecture guard for `@/host` — config in `_arch/slice-boundary-configs.ts`.
 *
 * Host is the Layer-2 composition seam (ADR-0299); it is NOT a pure library, so
 * only the surface-isolation invariant binds it: `src/host/**` must not import
 * or type-reference `apps/**`. See the `host` config docblock for the rationale
 * (`surfaceIsolationOnly`). The teeth for this guard — proof it FIRES on a
 * synthetic host→apps reference (value AND type-position) — live in
 * `slice-boundary-up-import-proof.test.ts`.
 */

import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("host"))
