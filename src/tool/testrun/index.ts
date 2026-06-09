/** Epic-2 — structured test-runner. Default-OFF (QUANTA_TEST_RUNNER); detects
 *  the project toolchain and runs the suite, returning normalized pass/fail
 *  evidence (the failure half of the Evidence Packet Builder). */
export { detectToolchain, type ExistsPort } from "./detect"
export { parseCargo, parseGoJson, parsePythonUnittest } from "./parse"
export { defaultTestRunPort, makeRunTestsTool, runTestsTool, type TestRunPort } from "./tool"
export type { TestFailure, TestRunResult, Toolchain } from "./types"
