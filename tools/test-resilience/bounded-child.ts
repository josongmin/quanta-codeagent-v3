/**
 * The bounded child lifecycle now lives at `tools/dev/bounded-child.ts` so the
 * gates, the worktree-pollution guard and the unit-speed-budget confirmation
 * can share it (TVH-07 asks for exactly one such primitive). This file stays as
 * the flake-diagnosis lane's import surface: the consumer names it, and the
 * primitive's own docstring carries the measurements that justify it.
 */
export {
  type BoundedChildDeadline,
  type BoundedChildLimits,
  type BoundedChildOutcome,
  type BoundedChildRequest,
  type BoundedChildStatus,
  DEFAULT_CHILD_LIMITS,
  deadlineBudgetMs,
  runBoundedChild,
} from "../dev/bounded-child"
