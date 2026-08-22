import type { RunInstanceDeps as SharedRunInstanceDeps } from "@/runner/batch/eval/driver"
import type { createRuntime } from "@/sdk/runtime"

export interface RunInstanceDeps extends SharedRunInstanceDeps {
  readonly runtimeFactory?: typeof createRuntime
}
