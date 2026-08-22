/**
 * Default `ThreadToolRegistry` impl (ADR-0206).
 *
 * `Map<threadId, Map<toolName, DynamicToolSpec>>` plus a sibling
 * `LazyResolver` cache (kept SEPARATE so the stored spec object is
 * referentially stable and `Object.freeze`-able).
 *
 * Eager (`deferLoading=false`) registration runs `factory()` inside
 * `register` and seeds the resolver cache; a throw is reported as
 * `Err("factory-failed")` and the spec is NOT inserted (the registry
 * stays in its pre-call state — no partial-insert hazard).
 *
 * Deferred (`deferLoading=true`) registration only inserts the spec.
 * The factory runs lazily on first `resolve` (single-flight via the
 * resolver's cache).
 *
 * Plane-clean: imports only `@/shared` + `@/tool` + sibling files. No
 * `@/agent/loop`, no `@/agent/dispatch`.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { Tool } from "@/tool"
import { defaultLazyResolver, type LazyResolver } from "./lazy-resolver"
import type { ListOpts, ThreadToolRegistry } from "./port"
import type { DynamicToolSpec, RegError, ResError } from "./types"

export interface InMemoryThreadToolStoreOpts {
  /** Inject a resolver (default: `defaultLazyResolver()`). Tests use this
   *  to assert single-flight by counting factory invocations. */
  readonly resolver?: LazyResolver
}

export const inMemoryThreadToolStore = (opts?: InMemoryThreadToolStoreOpts): ThreadToolRegistry => {
  const threads = new Map<string, Map<string, DynamicToolSpec>>()
  const resolver = opts?.resolver ?? defaultLazyResolver()

  const threadOf = (tid: string): Map<string, DynamicToolSpec> | undefined => threads.get(tid)

  return {
    register(threadId, spec): Result<void, RegError> {
      let bucket = threads.get(threadId)
      if (bucket === undefined) {
        bucket = new Map()
        threads.set(threadId, bucket)
      }
      const existing = bucket.get(spec.name)
      if (existing !== undefined) {
        return err({
          code: "duplicate-tool",
          existing,
          message: `tool '${spec.name}' already registered on thread '${threadId}'`,
        })
      }
      // Freeze the spec so consumers cannot mutate it post-registration.
      const frozenSpec = Object.freeze({ ...spec })
      if (spec.deferLoading === false) {
        let built: Tool
        try {
          built = spec.factory()
        } catch (cause) {
          const msg = errMessage(cause)
          // Eager-factory failure does NOT insert the spec: the registry
          // stays in its pre-call state. The empty bucket we may have
          // just created is left in place (cheap — Map<string, Spec>()) —
          // never observable from outside since `list` returns []` on it.
          return err({
            code: "factory-failed",
            cause,
            message: `eager factory for '${spec.name}' (thread '${threadId}') threw: ${msg}`,
          })
        }
        resolver.cacheEager(threadId, spec.name, built)
      }
      bucket.set(spec.name, frozenSpec)
      return ok(undefined)
    },

    list(threadId, listOpts?: ListOpts): readonly DynamicToolSpec[] {
      const bucket = threadOf(threadId)
      if (bucket === undefined) return []
      const includeDeferred = listOpts?.includeDeferred === true
      const out: DynamicToolSpec[] = []
      for (const spec of bucket.values()) {
        if (spec.deferLoading === true && includeDeferred === false) {
          // Deferred spec is only listed once its factory has resolved.
          if (resolver.peek(threadId, spec.name) === null) continue
        }
        out.push(spec)
      }
      return out
    },

    resolve(threadId, toolName): Result<Tool, ResError> {
      const bucket = threadOf(threadId)
      const spec = bucket?.get(toolName)
      if (spec === undefined) {
        return err({
          code: "not-found",
          message: `tool '${toolName}' not registered on thread '${threadId}'`,
        })
      }
      if (spec.deferLoading === false) {
        const cached = resolver.peek(threadId, toolName)
        // Eager spec always pre-cached at register time; missing cache
        // would be an internal invariant break, surface it as not-found.
        if (cached === null) {
          return err({
            code: "not-found",
            message: `eager spec '${toolName}' missing resolver entry (invariant break)`,
          })
        }
        return ok(cached)
      }
      return resolver.resolveOnce(threadId, toolName, spec.factory)
    },

    evict(threadId): void {
      threads.delete(threadId)
      resolver.evictThread(threadId)
    },

    evictNamespace(threadId, namespace): void {
      const bucket = threadOf(threadId)
      if (bucket === undefined) return
      for (const [name, spec] of bucket) {
        if (spec.namespace === namespace) {
          bucket.delete(name)
          resolver.evictOne(threadId, name)
        }
      }
    },
  }
}
