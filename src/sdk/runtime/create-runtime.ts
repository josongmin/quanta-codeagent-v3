import { createRuntimeFacade } from "./runtime"
import type { CreateRuntimeOptions, RuntimeFacade } from "./types"

export const createRuntime = async (options: CreateRuntimeOptions): Promise<RuntimeFacade> =>
  createRuntimeFacade(options)
