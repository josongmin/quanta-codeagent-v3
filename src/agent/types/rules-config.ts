import type { VendorDetectorPort, VendorId } from "@/rules"

/**
 * ADR-0233 (Wire 2) — Multi-source rules vendor-detector composition slot.
 * Plugs into `AgentConfig.rules?`. All fields optional; default-OFF.
 */
export interface RulesConfigBlock {
  /** OPT-IN master switch. When undefined / false, the host's
   *  `loadGlobRulesWithVendors(cwd, this)` returns byte-identical
   *  `loadGlobRules(cwd)` output. */
  readonly vendorDetectorEnabled?: boolean
  /** Override the default detector factory. Test-injection seam. */
  readonly detector?: VendorDetectorPort
  /** Subset of {@link VendorId} the detector should scan. Default: all 6. */
  readonly vendors?: ReadonlyArray<VendorId>
  /** Explicit precedence override; lower index wins on path collision.
   *  Default: canonical `VENDOR_PRIORITY` from `@/rules`. */
  readonly priority?: ReadonlyArray<VendorId>
}
