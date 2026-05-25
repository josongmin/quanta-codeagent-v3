import { InMemorySessionEventLog } from "@/kernel/session"

export const createInMemorySessionPersistence = (): InMemorySessionEventLog =>
  new InMemorySessionEventLog()
