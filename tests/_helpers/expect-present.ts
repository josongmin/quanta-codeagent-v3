/**
 * Total reads for test bodies — the failure MESSAGE is the reason these exist.
 *
 * Production code in this repo carries zero non-null assertions; the remaining
 * ones are all in tests, where the dominant shape is `arr[i]!` on an array the
 * test just built or received. That assertion is not merely a type escape: when
 * it is wrong, `chunks[3]!.text` throws `Cannot read property 'text' of
 * undefined`, which names neither the index nor the actual length — inside a
 * test whose entire job is to tell you what broke.
 *
 * These read the same values and fail with what a reader needs instead. They
 * deliberately do NOT use `expect()`, so they work in fixtures, helpers and
 * `beforeEach` bodies where no assertion context exists.
 */

/** Index an array, failing with the index AND the real length when it is short. */
export const nth = <T>(xs: ArrayLike<T> | readonly T[], i: number, what = "item"): T => {
  const v = (xs as ArrayLike<T>)[i]
  if (v === undefined) {
    throw new Error(`${what}[${i}] is missing — the collection has length ${xs.length}`)
  }
  return v
}

/** Read a value the test knows is set, failing with a name when it is not. */
export const present = <T>(v: T | null | undefined, what: string): T => {
  if (v === undefined || v === null) {
    throw new Error(`${what} is ${v === null ? "null" : "undefined"} — expected it to be present`)
  }
  return v
}
