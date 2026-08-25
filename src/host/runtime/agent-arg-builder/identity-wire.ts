import { identityForToken } from "@/agent/identity"
import { gateOn } from "@/shared"

export const resolveIdentityFromEnv = (env: NodeJS.ProcessEnv): readonly string[] | undefined => {
  if (!gateOn(env, "QUANTA_IDENTITY")) return undefined
  return identityForToken(env.QUANTA_IDENTITY_MODE ?? "default")
}
