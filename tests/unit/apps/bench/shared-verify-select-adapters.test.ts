import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
// The app bench driver was split (refactor/bench-driver-lanes) into
// `src/apps/bench/eval/driver/*.ts` lane modules — pure code motion. The
// shared-adapter routing + evidence-packet import these strings pin now live
// across the barrel + lane modules, so aggregate the barrel + every
// `driver/*.ts` lane source (dir absent pre-split ⇒ just the barrel). The
// `.not.toContain` guards below still hold across the aggregate because the
// lane modules sit one level deeper (`./repair/…`, `../…`), never `./…`.
const APP_DRIVER_DIR = join(REPO_ROOT, "src/apps/bench/eval/driver")
const APP_DRIVER_SRC = [
  readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8"),
  ...(existsSync(APP_DRIVER_DIR)
    ? readdirSync(APP_DRIVER_DIR)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => readFileSync(join(APP_DRIVER_DIR, f), "utf8"))
    : []),
].join("\n")
// The runner core driver was split (jul-02) into `./driver/*` submodules (pure
// code motion). The regression-oracle / repo-regression-discovery adapter wiring
// the runner core OWNS (and the app delegates to) now lives in those submodules,
// which import via `../` since they sit one level deeper. Aggregate the barrel +
// all submodule sources so the SSOT invariant is unchanged by the file split.
const DRIVER_DIR = join(REPO_ROOT, "src/runner/batch/eval/driver")
const SHARED_DRIVER_SRC = [
  readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8"),
  ...readdirSync(DRIVER_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(DRIVER_DIR, f), "utf8")),
].join("\n")

describe("apps bench driver shared verify-select adapters", () => {
  test("ANTI-VACUITY: both driver slices were actually read", () => {
    // `existsSync(APP_DRIVER_DIR) ? … : []` was written for the pre-split tree.
    // The dir exists now, so that fallback no longer means "not yet split" — it
    // means "read nothing", and every `toContain` below would then be asserted
    // against the barrel alone while the wiring it pins sits unread in the lane
    // modules. Same for a `not.toContain`, which an empty read satisfies for free.
    const app = readdirSync(APP_DRIVER_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(APP_DRIVER_DIR, f))
    assertScanPopulation(app, APP_DRIVER_DIR, {
      topLevelOnly: true,
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
    })
    const shared = readdirSync(DRIVER_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(DRIVER_DIR, f))
    assertScanPopulation(shared, DRIVER_DIR, {
      topLevelOnly: true,
      collectable: (n) => n.endsWith(".ts"),
    })
  })

  test("apps driver routes verify-select ownership through the shared runner driver", () => {
    expect(APP_DRIVER_SRC).toContain('from "@/runner/batch/eval/driver"')
    expect(APP_DRIVER_SRC).toContain("computeEffectiveProofRequired")
    expect(APP_DRIVER_SRC).toContain("familyCoverageCoeditEnabled")
    expect(APP_DRIVER_SRC).not.toContain('from "./regression-oracle-adapter"')
    expect(APP_DRIVER_SRC).not.toContain('from "./repo-regression-discovery-adapter"')
    expect(SHARED_DRIVER_SRC).toContain('from "../regression-oracle-adapter"')
    expect(SHARED_DRIVER_SRC).toContain('from "../repo-regression-discovery-adapter"')
  })

  test("apps driver records repair llm evidence via the runner evidence-packet module", () => {
    // 80753c687 rewired the app driver's `recordLlmEvidencePacket` import: it no
    // longer goes through the bench-local `./repair/llm-evidence` re-export shim
    // (which still exists but is now unused by the driver) — it imports the packet
    // recorder DIRECTLY from the runner SSOT `@/runner/batch/eval/llm-evidence-packet`
    // (driver.ts:97-101). The packet IS still recorded (driver.ts:1535, 1675),
    // just via the runner module, so the invariant "app driver records evidence
    // through the shared runner surface" is unchanged by the import move.
    expect(APP_DRIVER_SRC).toContain('from "@/runner/batch/eval/llm-evidence-packet"')
    expect(APP_DRIVER_SRC).toContain("recordLlmEvidencePacket")
    expect(APP_DRIVER_SRC).not.toContain('from "./repair/llm-evidence"')
  })
})
