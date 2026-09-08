# R14 integration delta — APPLIED (W3-I)

Status: **applied** on integrated source.

`src/apps/cli/index.ts` `routeRemote`:

```ts
import { buildCliRemoteSeams } from "./remote-dependencies/seams"

const resolved = buildCliRemoteSeams(process.env)
const runner = selectRemoteRunner(process.env, resolved.seams)
```

`unconfiguredReason` when `resolved.reason !== "ready"`:

- `missing-binary` / `unknown` passed through
- otherwise `disabled`

G-F9.4: empty `{}` seams are gone from the production CLI path. Live Docker/Lima is `tests/contract/remote-cli-docker.test.ts` (`requireContract` + skipIf; production seams, not fakes).
