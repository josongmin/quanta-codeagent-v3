/**
 * ADR-0199 — Live sandbox-exec hellgate (darwin only).
 *
 * STATUS: Phase 1 — DEFERRED to ADR-0199 Phase 2.
 *
 * The unit hellgate (`tests/unit/runtime/seatbelt-verbatim-hellgate.test.ts`)
 * byte-locks the Codex-baseline parity + strict knob behavior over the
 * compiled profile string. A live `sandbox-exec` battery would also
 * exercise the OS enforcement layer end-to-end, but on the current
 * baseline profile `/bin/sh` exits with SIGABRT under the compiled
 * profile (a system-framework subpath gap unrelated to ADR-0199 — see
 * the design note in `src/runtime/os-sandbox/seatbelt.ts` about
 * `process-exec` being denied by design). Closing that gap requires
 * widening the framework subpath allowlist in concert with a real
 * `(allow process-exec)` decision and is a separate slice (Phase 2).
 *
 * On non-darwin platforms the suite politely skips via `describeOnDarwin`.
 * On darwin we register two negative-side cases that the current profile
 * DOES handle (the always-on `null` / passthrough arms) so the file is
 * not entirely dormant.
 */
import { expect, test } from "bun:test"
import { compileSeatbeltProfile } from "@/runtime/os-sandbox"
import { describeOnDarwin } from "../_support/darwin-only"

describeOnDarwin("ADR-0199 — sandbox-exec live integration (Phase 1 negative-side only)", () => {
  test("HELL-SBE-NEG-01: off profile compiles to null (passthrough — sandbox-exec NOT invoked)", () => {
    const p = compileSeatbeltProfile({ profile: "off" }, "/private/tmp/test")
    expect(p).toBeNull()
  })

  test("HELL-SBE-NEG-02: danger-full-access compiles to null even with strict knobs set", () => {
    const p = compileSeatbeltProfile({ profile: "danger-full-access" }, "/private/tmp/test", {
      denyForkAdditional: true,
      denyNetworkAlways: true,
      allowTmpWrite: true,
    })
    expect(p).toBeNull()
  })
})
