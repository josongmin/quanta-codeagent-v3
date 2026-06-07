# ADR-0507: `read_image` downsample codec port

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/tool/image/downsample-plan.ts` (`planImageRead`, `scaleToMaxDim` — pure)
  - `src/tool/image/downsample-port.ts` (`ImageDownsamplePort`)
  - `src/tool/image/read.ts` (`makeReadImageTool` factory)
  - `src/tool/index.ts` (`DefaultToolPorts.imageDownsample`)
  - Tests: `tests/unit/image-downsample-plan-hellgate.test.ts`, `tests/unit/image-downsample-wire-hellgate.test.ts`
  - Absorbs: Codex image downsample (gap-other-agent GAP 1)

## Context

quanta hard-rejects images over `MAX_IMAGE_BYTES` (5 MB). Codex downsamples (PIL LANCZOS → a max
longest-edge) so large screenshots are still usable. quanta is pure-TS with no vendored image codec,
so it could not decode/resize in-process.

## Decision

Split decision from execution. The pure `planImageRead(byteLen, cap, canDownsample)` decides
ok/downsample/reject; `scaleToMaxDim(w,h,maxDim)` is the aspect-preserving geometry (no upscale,
≥1px, finite-guarded). The decode→resize→encode rides a host-injected `ImageDownsamplePort` (a
WASM/native codec). `read_image` becomes `makeReadImageTool(port?)`: over-cap + port ⇒ the codec
downsamples (longest edge → `DOWNSAMPLE_MAX_DIM`); over-cap + no port ⇒ reject exactly as before
(byte-identical default-OFF); the over-cap decision moves from stat-time to the actual bytes. A
`port → "unable"` result falls back to the rejection (no throw).

## Consequences

Hosts that wire a codec read oversized images; an unwired host (the default) is byte-identical to the
pre-slice hard reject.
