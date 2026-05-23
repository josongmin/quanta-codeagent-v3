export const SCHEMA_VERSION = 1;
/** Known payload discriminator values — kept in sync with the union below.
 *  `result-store.readAll` validates every line's `payload.kind` against this
 *  set before yielding, so an unknown kind is DROPPED rather than silently
 *  flowing through to `report/coverage-matrix.verdictFromRecord`. */
export const PAYLOAD_KINDS = ["audit", "synthetic", "public", "trajectory", "compare"];
const PAYLOAD_KIND_SET = new Set(PAYLOAD_KINDS);
export const isKnownPayloadKind = (k) => PAYLOAD_KIND_SET.has(k);
