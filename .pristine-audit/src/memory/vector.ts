// Pure vector math + (de)serialization for semantic recall. Zero deps: a
// Float32 little-endian buffer is the on-disk form (sqlite BLOB column); the
// in-memory form is a plain number[]. Shared by both adapters and ranking so
// similarity semantics never diverge (RFC: "no logic duplication").

/** Dot product. Returns 0 on length mismatch (treated as "incomparable"). */
export const dot = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/** Euclidean norm. */
export const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a))

/**
 * Cosine similarity in `[-1, 1]`. Returns 0 when either vector is empty, a
 * zero vector, length-mismatched, or contains a non-finite component — i.e.
 * "no semantic signal", never NaN, so ranking stays total and deterministic.
 */
export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 0
  const c = dot(a, b) / (na * nb)
  return Number.isFinite(c) ? c : 0
}

/**
 * L2-normalize (unit length). A zero/empty vector is returned unchanged. Used
 * so stored embeddings can be compared with a plain dot product if desired and
 * so cosine is numerically stable.
 */
export const normalize = (a: readonly number[]): number[] => {
  const n = norm(a)
  if (n === 0) return [...a]
  return a.map((x) => x / n)
}

/** Encode a vector as a Float32 little-endian byte buffer (sqlite BLOB form). */
export const serializeVec = (v: readonly number[]): Uint8Array => {
  const f = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) f[i] = v[i] as number
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

/**
 * Decode a Float32 little-endian buffer back to a number[]. Returns `undefined`
 * for null/empty/odd-length input rather than throwing, so a corrupt or legacy
 * row degrades to "no embedding".
 */
export const deserializeVec = (
  buf: Uint8Array | ArrayBuffer | null | undefined,
): number[] | undefined => {
  if (!buf) return undefined
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf
  if (u8.byteLength === 0 || u8.byteLength % 4 !== 0) return undefined
  // Copy into an aligned buffer (sqlite BLOBs are not guaranteed 4-byte aligned).
  const aligned = u8.byteOffset % 4 === 0 ? u8 : new Uint8Array(u8)
  const f = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
  return Array.from(f)
}
