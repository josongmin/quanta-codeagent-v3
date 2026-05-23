/**
 * Tier 3 — trajectory entry. Public surface: classify (label real sessions),
 * replay (re-execute a frozen fixture and diff streams), freeze (promote a
 * real session into the fixtures dir). All three honour the meta-sidecar
 * contract (no heuristic prompt inference).
 */
export { classifyTrajectories, } from "./classifier";
export { diffStreams, projectStream } from "./diff";
export { freezeFixture } from "./freeze";
export { EVAL_META_SCHEMA, metaPathFor, readMeta, writeMeta } from "./meta";
export { replayFixture } from "./replay";
export { listSessions, loadSession, producersOf } from "./source";
