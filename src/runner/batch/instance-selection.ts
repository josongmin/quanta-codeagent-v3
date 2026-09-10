import { loadCorpus as defaultLoadCorpus } from "./corpus/loader"
import type { Instance } from "./types"

export interface LoadSelectedInstancesOptions {
  corpus: string
  filter?: string
  limit?: number | null
  loadCorpus?: (root: string) => Promise<Instance[]>
}

export interface LoadSelectedInstancesResult {
  all: Instance[]
  instances: Instance[]
}

/** Match an instance id against a comma-separated list of substrings. */
export const matchesInstanceFilter = (id: string, filter: string): boolean => {
  const parts = filter
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (parts.length === 0) return true
  return parts.some((part) => id.includes(part))
}

/** Apply the optional id-substring filter before the optional limit. */
export const selectInstances = (
  all: readonly Instance[],
  filter: string | undefined,
  limit: number | null | undefined,
): Instance[] => {
  const filtered =
    filter !== undefined && filter !== ""
      ? all.filter((instance) => matchesInstanceFilter(instance.id, filter))
      : [...all]
  if (limit === null || limit === undefined) return filtered
  return filtered.slice(0, limit)
}

/** Shared corpus loader + selector for agent batch and bench dry-run paths. */
export const loadSelectedInstances = async (
  opts: LoadSelectedInstancesOptions,
): Promise<LoadSelectedInstancesResult> => {
  const load = opts.loadCorpus ?? defaultLoadCorpus
  const all = await load(opts.corpus)
  return {
    all,
    instances: selectInstances(all, opts.filter, opts.limit),
  }
}
