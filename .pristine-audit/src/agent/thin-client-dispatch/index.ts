/** Barrel — thin-client dispatch routing (ADR-0493). See `./types` + `@/shared/thin-client-route`. */

export {
  parseThinClientRoute,
  THIN_CLIENT_DISPATCH_FLAG,
  THIN_CLIENT_ROUTES,
  type ThinClientRoute,
} from "@/shared"
export { type DispatchDescriptor, type DispatchSurface, resolveThinClientRoute } from "./types"
