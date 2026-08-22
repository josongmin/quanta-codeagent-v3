export const hasExecutableTools = (registry: { all(): readonly unknown[] }): boolean =>
  registry.all().length > 0
