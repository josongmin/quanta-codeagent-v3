/**
 * Thin-client dispatch routing — the gate-aware resolver (ADR-0493).
 *
 * The route vocabulary + NO-THROW parser live in `@/shared/thin-client-route`
 * (a leaf, shared by @/skill and @/apps/cli). This file adds the SURFACE model
 * and the gate-aware resolver:
 *
 *   - "local"           → the host runs the command locally (the safe default).
 *   - "post-text"       → the host posts the command's text into the stream.
 *   - "control-request" → the host issues a structured control request.
 *
 * THICK surfaces (cli / headless / bench) own a real process/TTY and ALWAYS run
 * locally — a tag must never break a real terminal. THIN surfaces (web / ide)
 * are host-driven UIs that route per tag, but ONLY when `QUANTA_THIN_CLIENT_DISPATCH`
 * is opted in. Default-OFF ⇒ every descriptor resolves "local", byte-identical.
 *
 * Pure leaf: the resolver takes the raw env in (NEVER reads `process.env`).
 */
import {
  gateOn,
  parseThinClientRoute,
  THIN_CLIENT_DISPATCH_FLAG,
  type ThinClientRoute,
} from "@/shared"

/** The minimal shape the resolver needs from a command/skill descriptor. */
export interface DispatchDescriptor {
  readonly name: string
  /** Optional route tag. Absent / invalid ⇒ treated as "local". */
  readonly thinClientDispatch?: ThinClientRoute
}

/**
 * Surfaces the resolver distinguishes. THICK surfaces own a real process/TTY and
 * ALWAYS run locally. THIN surfaces (web/ide) are host-driven UIs that can route.
 */
export type DispatchSurface = "cli" | "headless" | "bench" | "web" | "ide"

const THIN_SURFACES: ReadonlySet<DispatchSurface> = new Set<DispatchSurface>(["web", "ide"])

/**
 * Resolve the effective route for a descriptor on a surface.
 *
 *   gate OFF                            → "local" (byte-identical default)
 *   THICK surface (cli/headless/bench)  → "local" (full process runs locally)
 *   THIN surface (web/ide), gate ON     → the descriptor's valid tag, else "local"
 *
 * Pure: depends only on (descriptor, surface, env). A garbage/unknown tag
 * degrades to "local" — never throws.
 */
export const resolveThinClientRoute = (
  descriptor: DispatchDescriptor,
  surface: DispatchSurface,
  env: Record<string, string | undefined>,
): ThinClientRoute => {
  if (!gateOn(env, THIN_CLIENT_DISPATCH_FLAG)) return "local"
  if (!THIN_SURFACES.has(surface)) return "local"
  return parseThinClientRoute(descriptor.thinClientDispatch) ?? "local"
}
