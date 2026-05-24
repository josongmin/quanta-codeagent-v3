/**
 * Architecture guard for `@/auth` — config in `_arch/slice-boundary-configs.ts`.
 */

import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("auth"))
