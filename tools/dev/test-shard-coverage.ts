/** Bun exposes native file sharding but no public test-file listing API. */
export interface ShardDiscovery {
  readonly shard: string
  readonly selected: number
  readonly discovered: number
}

const SHARD_LINE = /--shard=(\d+\/\d+):\s+running\s+(\d+)\/(\d+)\s+test files/

export const parseShardDiscovery = (
  text: string,
  expectedShard: string,
): ShardDiscovery | undefined => {
  const match = SHARD_LINE.exec(text)
  if (match?.[1] !== expectedShard || match[2] === undefined || match[3] === undefined)
    return undefined
  return {
    shard: match[1],
    selected: Number.parseInt(match[2], 10),
    discovered: Number.parseInt(match[3], 10),
  }
}

/**
 * Native Bun sharding defines the partition. Its per-worker `n/N` banner is
 * the only public discovery receipt, so require every worker to agree on N
 * and the selected counts to add to N. This catches a changing corpus, a
 * skipped shard, and an empty shard before a green run is accepted.
 */
export const assertShardCoverage = (
  discoveries: readonly ShardDiscovery[],
  shardCount: number,
): void => {
  if (discoveries.length !== shardCount) {
    throw new Error(
      `[test:shards] discovery missing: expected ${shardCount} receipts, got ${discoveries.length}`,
    )
  }
  const expected = new Set(
    Array.from({ length: shardCount }, (_, index) => `${index + 1}/${shardCount}`),
  )
  const actual = new Set(discoveries.map(({ shard }) => shard))
  if (actual.size !== shardCount || [...expected].some((shard) => !actual.has(shard))) {
    throw new Error(`[test:shards] discovery does not cover every shard: ${[...actual].join(", ")}`)
  }
  const totals = new Set(discoveries.map(({ discovered }) => discovered))
  if (totals.size !== 1) {
    throw new Error(
      `[test:shards] discovery changed between shards: ${discoveries.map((d) => `${d.shard}=${d.discovered}`).join(", ")}`,
    )
  }
  const total = discoveries[0]?.discovered
  if (total === undefined || total < shardCount || discoveries.some((d) => d.selected <= 0)) {
    throw new Error(`[test:shards] invalid native shard discovery receipt`)
  }
  const selected = discoveries.reduce((sum, discovery) => sum + discovery.selected, 0)
  if (selected !== total) {
    throw new Error(
      `[test:shards] shard selection is not a full partition: selected=${selected}, discovered=${total}`,
    )
  }
}
