/**
 * Knob: `test-runner` — expose the structured `test_runner` tool so the agent
 * can run the suite through a typed port instead of raw `bash`.
 *
 * Default-OFF. Like `read-outline`, the actual feature is a runtime-config knob
 * read at wire time (`runtimeConfig()`, envKey `QUANTA_TEST_RUNNER`), so APPLY
 * IS A NOOP — this registry entry exists ONLY so the bench resolver / report /
 * preset layer can SEE it; `buildConfig` bridges an active resolved value to
 * the live-override store via `setKnobOverride`. Strict truthy gate:
 * `"1"` / `"on"` / `"true"` / `"yes"` ⇒ enabled (canonical `isTruthyToken`).
 */

import type { AgentConfig } from "@/agent"
import { isTruthyToken } from "@/shared"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseTestRunner = (raw: string | undefined): true | undefined =>
  isTruthyToken(raw) ? true : undefined

const applyTestRunner = (cfg: AgentConfig): AgentConfig => cfg

export const testRunnerKnob: Knob<true> = {
  id: "test-runner",
  envKey: "QUANTA_TEST_RUNNER",
  category: "verify",
  surfaces: SURFACES,
  parse: parseTestRunner,
  apply: applyTestRunner,
  describe: "Expose the structured test_runner tool (typed suite execution)",
  source: "Agentless absorption",
}

registerKnob(testRunnerKnob)
