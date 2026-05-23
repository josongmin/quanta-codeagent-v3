/**
 * DAG validation for plan dependencies (ADR-0095 draft).
 *
 * Three pure exports operating on a `Readonly<Record<string, TodoItem>>` graph:
 *
 *   - {@link validateDag} — full-plan validation. Returns the first failure in
 *     the priority order `self_dependency` → `dependency_unknown` →
 *     `dependency_cycle`. Reports as a typed {@link PlanMutationError} via
 *     {@link PlanResult}.
 *   - {@link findCycle} — DFS w/ tri-state colour. Returns the cycle path
 *     (traversal order, NOT necessarily canonical) or `null`. Optional
 *     `startId` narrows the search to nodes reachable from that root.
 *   - {@link topologicalSort} — Kahn-style ordering with deterministic tie-
 *     break by id (lexicographic). Returns the ordered ids or, if the graph
 *     has a cycle, `{ cycle: [...] }` mirroring {@link findCycle}'s shape.
 *
 * Complexity is O(V+E) for all three. The 100-node perf hellgate pins this
 * (`tests/unit/agent/plan/dag-hell.test.ts` — "perf: 100-node DAG validation
 * under 50ms").
 *
 * Slice rule: pure module. No clock, no I/O, no logger, no allocation beyond
 * the result. Safe for hot-path mutation pre-flight.
 */
/** Build adjacency from todos. Self-deps are emitted intact so the caller
 *  can detect them BEFORE any cycle walk (priority order matters). */
const buildAdjacency = (todos) => {
    const adj = {};
    for (const id of Object.keys(todos)) {
        const t = todos[id];
        adj[id] = t === undefined ? [] : t.dependencies;
    }
    return adj;
};
/**
 * Full DAG validation in three priority phases. Returns the FIRST failure
 * (no batching) so the caller learns one fixable problem at a time and the
 * test surface stays deterministic.
 *
 * Priority is fixed:
 *   1. `self_dependency` — a todo lists its own id in `dependencies`.
 *   2. `dependency_unknown` — a `dep` id does not exist in `todos`. The first
 *      encountered (by todo-key iteration order, which is insertion order in
 *      modern JS) is reported.
 *   3. `dependency_cycle` — full DFS over the remaining well-formed graph.
 */
export const validateDag = (todos) => {
    // Phase 1: self-deps. O(V+E).
    for (const id of Object.keys(todos)) {
        const t = todos[id];
        if (t === undefined)
            continue;
        if (t.dependencies.includes(id)) {
            return { ok: false, error: { kind: "self_dependency", id } };
        }
    }
    // Phase 2: dangling refs. O(V+E).
    for (const id of Object.keys(todos)) {
        const t = todos[id];
        if (t === undefined)
            continue;
        for (const dep of t.dependencies) {
            if (!(dep in todos)) {
                return { ok: false, error: { kind: "dependency_unknown", from: id, to: dep } };
            }
        }
    }
    // Phase 3: cycle detection. O(V+E).
    const cycle = findCycleInternal(buildAdjacency(todos), undefined);
    if (cycle !== null) {
        return { ok: false, error: { kind: "dependency_cycle", path: cycle } };
    }
    return { ok: true, value: true };
};
/**
 * DFS w/ tri-state colour. White = unvisited, Gray = on the current DFS path
 * (back-edge to a gray ⇒ cycle), Black = fully explored. Returns the cycle
 * path (from the back-edge target forward through the gray prefix back to
 * the back-edge source) or `null`.
 *
 * If `startId` is supplied, the search starts from that node and only walks
 * its reachable subgraph. Otherwise, every unvisited node is iterated in id
 * lexicographic order so the result is deterministic regardless of input
 * iteration order.
 */
export const findCycle = (todos, startId) => findCycleInternal(buildAdjacency(todos), startId);
const findCycleInternal = (adj, startId) => {
    const colour = {}; // 0=white, 1=gray, 2=black
    const parent = {};
    let cycleResult = null;
    // Deterministic iteration: sort ids lexicographically when we visit roots.
    const roots = startId !== undefined ? [startId] : Object.keys(adj).slice().sort();
    const dfs = (root) => {
        if (!(root in adj))
            return null; // startId unknown ⇒ empty subgraph
        if (colour[root] !== undefined && colour[root] !== 0)
            return null;
        const stack = [{ id: root, nextIdx: 0 }];
        colour[root] = 1;
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame === undefined)
                break;
            const edges = adj[frame.id] ?? [];
            if (frame.nextIdx >= edges.length) {
                // No more out-edges from this node — pop, paint black.
                colour[frame.id] = 2;
                stack.pop();
                continue;
            }
            const next = edges[frame.nextIdx];
            frame.nextIdx += 1;
            if (next === undefined || !(next in adj))
                continue; // dangling skipped here (validateDag catches earlier)
            const c = colour[next] ?? 0;
            if (c === 1) {
                // Back-edge ⇒ cycle. Reconstruct path: gray nodes on stack from `next` onward + `next` again.
                const path = [];
                let started = false;
                for (const f of stack) {
                    if (!started && f.id === next)
                        started = true;
                    if (started)
                        path.push(f.id);
                }
                path.push(next); // close the cycle
                return path;
            }
            if (c === 0) {
                colour[next] = 1;
                parent[next] = frame.id;
                stack.push({ id: next, nextIdx: 0 });
            }
            // c === 2 (black): already fully explored, skip.
        }
        return null;
    };
    for (const root of roots) {
        if ((colour[root] ?? 0) !== 0)
            continue;
        const found = dfs(root);
        if (found !== null) {
            cycleResult = found;
            break;
        }
    }
    return cycleResult;
};
/**
 * Topological sort. Returns the id order on success, or `{ cycle }` on
 * failure (same path shape as {@link findCycle}). Tie-break: lexicographic
 * by id (deterministic regardless of input iteration).
 *
 * Algorithm: Kahn (BFS over in-degree=0 frontier). Stable tie-break by
 * sorting the frontier each pop — O((V+E) log V). Acceptable at our scale
 * (`PLAN_LIMITS.MAX_TODOS = 200`).
 */
export const topologicalSort = (todos) => {
    const ids = Object.keys(todos);
    if (ids.length === 0)
        return [];
    const inDeg = {};
    const out = {};
    for (const id of ids) {
        inDeg[id] = 0;
        out[id] = [];
    }
    for (const id of ids) {
        const t = todos[id];
        if (t === undefined)
            continue;
        for (const dep of t.dependencies) {
            if (!(dep in inDeg))
                continue; // dangling — validateDag's job; sort skips
            // Edge: id depends on dep, so dep MUST come first ⇒ edge dep → id.
            inDeg[id] = (inDeg[id] ?? 0) + 1;
            const o = out[dep] ?? [];
            out[dep] = [...o, id];
        }
    }
    // Frontier: in-degree 0, sorted lex.
    const frontier = ids.filter((id) => (inDeg[id] ?? 0) === 0).sort();
    const result = [];
    while (frontier.length > 0) {
        const next = frontier.shift();
        if (next === undefined)
            break;
        result.push(next);
        for (const child of out[next] ?? []) {
            const d = (inDeg[child] ?? 1) - 1;
            inDeg[child] = d;
            if (d === 0) {
                // Insert into frontier maintaining sort.
                let i = 0;
                while (i < frontier.length && (frontier[i] ?? "") < child)
                    i += 1;
                frontier.splice(i, 0, child);
            }
        }
    }
    if (result.length !== ids.length) {
        // Remaining nodes form one or more cycles. Return the first one.
        const cycle = findCycleInternal(buildAdjacency(todos), undefined);
        return { cycle: cycle ?? [] };
    }
    return result;
};
