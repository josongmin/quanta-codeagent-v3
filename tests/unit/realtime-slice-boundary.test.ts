/**
 * Architecture guard for `@/realtime` — config in `_arch/slice-boundary-configs.ts`.
 * Entrypoint that runs the per-slice boundary suite (paired 1:1 with the config;
 * enforced by tests/unit/slice-boundary-config-parity.test.ts).
 */

import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("realtime"))
