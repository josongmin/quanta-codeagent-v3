import { errMessage } from "@/shared/errors"
import { runSessionMain } from "./session-main"

runSessionMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${errMessage(error)}\n`)
    process.exit(1)
  })
