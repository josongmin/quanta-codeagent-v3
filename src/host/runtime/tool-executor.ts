import type { SessionDeps } from "@/runner/assemble"

export const hasExecutableTools = (deps: SessionDeps): boolean => deps.registry.all().length > 0
