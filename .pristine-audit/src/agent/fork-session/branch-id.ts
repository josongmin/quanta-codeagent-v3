/**
 * Branch ID minter (ADR-0226).
 *
 * URL-safe, collision-resistant short IDs for fork branches. The user spec
 * suggested `nanoid`, but installs are blocked in this repo (per the
 * verify-workflow memory), so we ship a tiny in-house equivalent built on
 * `node:crypto.randomBytes` — entropy-equivalent to the standard nanoid
 * default at length 21 (~126 bits) and ZERO external dependencies.
 *
 * Public surface:
 *
 *   - `defaultBranchIdMinter(opts?) → () => string` — factory; pin the
 *     entropy source for tests by passing an injected `randomBytes`
 *     callback.
 *   - `BRANCH_ID_ALPHABET` — exported as a literal tuple so tests +
 *     audits can prove no `=`/`+`/`/` (URL-unsafe) leak in.
 *   - `isWellFormedBranchId(s)` — pure validator; lets the CLI / port
 *     reject malformed caller input WITHOUT pulling in a regex DSL.
 *
 * Why a brand-new file: the existing `default-forker.ts` (ADR-0201) mints
 * UUID-v4 SESSION ids via `crypto.randomUUID()`. BRANCH ids are a separate
 * axis — they are human-grep'able labels under a sessionId (a sessionId
 * may host many fork branches), so they live in their own file with their
 * own alphabet + length. UUID-v4 is overkill (36 chars, dashes, hex-only)
 * for the human-facing branch surface.
 *
 * Plane-clean: imports `node:crypto` only.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto"

/** URL-safe alphabet — A-Z + a-z + 0-9 + `-` + `_`. Exactly 64 chars so the
 *  modulo-bias-free read of one random byte (modulo `alphabet.length`) is
 *  ZERO-bias when the alphabet length divides 256 evenly — and 64 | 256.
 *  Pinned as a literal tuple so a `replaceAll` or accidental edit cannot
 *  silently change the surface without flipping the type. */
export const BRANCH_ID_ALPHABET = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "-",
  "_",
] as const

/** Default branch-id length. 21 chars = ~126 bits of entropy (URL-safe
 *  alphabet), matching the well-studied collision rate of nanoid default.
 *  Equivalent collision-likelihood to UUID v4 (~122 bits) at a smaller
 *  on-screen footprint. */
export const DEFAULT_BRANCH_ID_LENGTH = 21

/** Validator: branch id is non-empty, length <= 64, every char in the
 *  URL-safe alphabet. Rejects whitespace, slashes, NUL, query-string
 *  separators, ref-name traversal patterns, AND raw `..` segments.
 *  Pure — used by the CLI to validate `--name=` AND by the port to
 *  reject malformed caller input before any state mutates. */
export const isWellFormedBranchId = (s: string): boolean => {
  if (typeof s !== "string") return false
  if (s.length === 0) return false
  if (s.length > 64) return false
  if (s.includes("..")) return false
  const allowed: ReadonlySet<string> = new Set<string>(BRANCH_ID_ALPHABET)
  for (const ch of s) {
    if (!allowed.has(ch)) return false
  }
  return true
}

/** Options for `defaultBranchIdMinter`. All fields optional — production
 *  callers wire nothing, tests inject deterministic bytes. */
export interface BranchIdMinterOpts {
  /** Override the entropy source. Default: `node:crypto.randomBytes`.
   *  Tests pass a counter-based fake so the minted ids are
   *  reproducible. The callback receives the byte-count requested and
   *  must return EXACTLY that many bytes (no short read). */
  readonly randomBytes?: (size: number) => Uint8Array
  /** Override the output length (chars). Default
   *  `DEFAULT_BRANCH_ID_LENGTH = 21`. Clamped to `[1, 64]`. */
  readonly length?: number
}

/** Factory. Returns a zero-arg minter so the caller's call-site reads
 *  `mint()` rather than `mint(opts)` — consistency with `crypto.randomUUID`. */
export const defaultBranchIdMinter = (opts?: BranchIdMinterOpts): (() => string) => {
  const length = Math.max(1, Math.min(64, opts?.length ?? DEFAULT_BRANCH_ID_LENGTH))
  const rb = opts?.randomBytes ?? ((n: number): Uint8Array => Uint8Array.from(nodeRandomBytes(n)))
  return (): string => {
    const buf = rb(length)
    if (!(buf instanceof Uint8Array) || buf.length < length) {
      // Programmer-bug — the injected callback returned the wrong shape.
      // Throw (not Result) because there is no recovery — every caller is
      // a session-level mutator.
      throw new Error(
        `branch-id: randomBytes returned ${buf instanceof Uint8Array ? buf.length : typeof buf} bytes, expected ${length}`,
      )
    }
    let out = ""
    for (let i = 0; i < length; i += 1) {
      // Modulo-bias-free because 256 % 64 === 0 (alphabet length is 64).
      const byte = buf[i] as number
      out += BRANCH_ID_ALPHABET[byte & 0x3f]
    }
    return out
  }
}
