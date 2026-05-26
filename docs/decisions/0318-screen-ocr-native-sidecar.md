# ADR-0318 — Screen OCR native sidecar (Swift + ScreenCaptureKit + Vision)

- **Status**: accepted (2026-05-26)
- **Related**: ADR-0309 surface wire R2 (Tauri shell host), [[implementation-baseline-from-competitors]], [[no-heuristics-only-validated]]
- **References**:
  - Apple Vision `VNRecognizeTextRequest` (revision 3, `ko-KR` + `en-US`)
  - Apple `ScreenCaptureKit` (`SCShareableContent`, `SCStream`, `SCContentFilter`)
  - TCC Screen Recording permission (`CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`)

## Context

The Tauri shell (Worker D) needs to feed quanta two things from the host desktop:

1. The list of on-screen application windows the user can target.
2. A single captured frame of a chosen window, plus its OCR text.

The quanta core is TS/Bun. The Tauri shell binds the host (Rust) to the renderer
(web), but it does NOT itself want to depend on Apple frameworks — that would
drag ScreenCaptureKit + Vision into every host of every surface, including ones
that have nothing to do with screen capture (e.g. the CLI surface).

We need a small, replaceable native binary that:

- Speaks JSON on stdout (so the shell can spawn it as a sidecar and `JSON.parse`
  one line per invocation).
- Has zero shared state across invocations (one-shot stateless tool).
- Exits cleanly with a typed code on every failure path.
- Runs on Apple Silicon AND Intel macOS.

## Decision

Ship `native/screen-ocr/` — a Swift Package Manager executable named
`screen-ocr` with three subcommands:

| Subcommand          | Purpose                                                            |
|---------------------|--------------------------------------------------------------------|
| `list-windows`      | Enumerate on-screen layer-0 windows with `CGWindowListCopyWindowInfo`. |
| `capture --window-id N [--include-image]` | Single-frame grab via SCStream + Vision OCR. |
| `check-permission`  | Probe (NOT prompt) Screen Recording TCC state.                     |

### Stack pin

- Swift 5.9, SPM, `swift-argument-parser` 1.3.0+ for subcommand routing.
- `Package.swift` platform pin: `.macOS(.v13)`. ScreenCaptureKit shipped in
  12.3 but the OCR revision 3 + several SC stability fixes land in 13.0.
- Frameworks: `ScreenCaptureKit`, `Vision`, `Foundation`, `AppKit`,
  `CoreGraphics`, `CoreMedia`, `CoreVideo`, `ImageIO`, `UniformTypeIdentifiers`.
- NO `UIKit` (mac-only by construction).

### Wire format (stdout JSON, snake_case)

Every subcommand emits exactly one single-line JSON document followed by `\n`.
Errors emit `{"error":{"code":"…","message":"…"}}` PLUS a non-zero exit code.

```
list-windows  → { "windows": [ { "id", "app", "title", "bounds": {x,y,w,h}, "layer" } ] }
capture       → { "window_id", "captured_at_ms", "image_size": {w,h},
                  "text", "lines": [{ "text", "bbox": {x,y,w,h}, "confidence" }],
                  "image_png_b64": null | "<base64>" }
check-perm    → { "granted": bool, "needs_prompt": bool }
```

`image_png_b64` is ALWAYS present — `null` when `--include-image` is not passed.
That distinguishes "missing field" (host parser error) from "no image embedded
this call" (normal).

### Error envelope + exit codes

| code                | exit |
|---------------------|------|
| `INVALID_ARGS`      | 2    |
| `PERMISSION_DENIED` | 3    |
| `WINDOW_NOT_FOUND`  | 4    |
| `CAPTURE_FAILED`    | 5    |
| `OCR_FAILED`        | 5    |
| `UNKNOWN`           | 1    |

### Permission model (TCC Screen Recording)

- `check-permission` calls `CGPreflightScreenCaptureAccess()` ONLY. It returns
  state and never triggers the system prompt.
- The prompt fires automatically the first time the **host** process reads
  `SCShareableContent.current` (i.e. when the Tauri shell first invokes
  `capture`). The shell is responsible for deciding when to provoke that
  prompt — the sidecar reports state, never commits the host to a UX flow.
- Once granted, the entitlement is per-binary in the TCC database; rebuilding
  the sidecar with a different code signature requires re-granting.

### OCR config (locked verbatim)

```swift
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ko-KR", "en-US"]
request.revision = VNRecognizeTextRequestRevision3
```

- bboxes are normalized (0..1) and **y-flipped** at the boundary from Vision's
  bottom-left-origin convention to the top-left-origin convention every other
  quanta surface uses.
- Lines sorted top-to-bottom, left-to-right with a 0.01 y-tolerance band
  (otherwise same-line glyphs with different ascender heights fragment).

### Capture config (SCStream single-frame)

- `SCContentFilter(desktopIndependentWindow: targetWindow)` — single window.
- `SCStreamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA`.
- `width/height` matched to the window's frame.
- `captureResolution = .best` when on macOS 14+.
- One `SCStreamOutput` handler that resolves the first valid frame's
  CMSampleBuffer → CGImage and immediately calls `stopCapture`.
- Hard wall-clock timeout (default 5s) — never hang the sidecar.

## Alternatives considered

### A. Pure-Rust via `objc2-screen-capture-kit` + `objc2-vision`

- ~5× more code (manual ObjC selector binding for every SCStream method).
- Lags Apple framework additions by months — every minor SCK release is a port.
- We'd still need a Vision binding crate, also lagging.
- **Rejected**: maintenance cost > the integration win.

### B. Tesseract (via `leptonica` + `tesseract-rs` or shell-out)

- Worse Korean accuracy (Vision's `ko-KR` model is materially better in 13+).
- Extra runtime dep (`brew install tesseract` / bundled `.traineddata`).
- Still need a Rust path to ScreenCaptureKit for the capture half.
- **Rejected**: worse output and not actually simpler.

### C. Existing CLIs (e.g. `screencapture(1)` + an OCR shell-out)

- `screencapture` cannot target a specific `CGWindowID` cleanly; it captures
  by interactive selection or full-screen / display-region only.
- **Rejected**: doesn't satisfy the per-window requirement.

## Wire to the rest of quanta

- Worker D's Tauri shell spawns this binary as a sidecar from
  `apps/tauri-shell/binaries/screen-ocr`.
- The shell forwards one window-list request and one capture request per
  user-initiated action. No long-running channel.
- TS-side consumes JSON; types are mirrored in the host adapter (Worker D).
- ADR is read-only here — no quanta TS module mutated by this slice.

## Test plan

- `Tests/ScreenOcrTests/ModelsTests.swift` — pure Codable round-trip:
  - `ListWindowsResponse` round-trip + snake_case key assertions.
  - `CaptureResponse` snake_case keys (`window_id`, `captured_at_ms`,
    `image_size`, `image_png_b64`) AND camelCase-MUST-NOT-appear.
  - `CaptureResponse` with `imagePngB64 = nil` emits JSON `null` (key present).
  - `CaptureResponse` with base64 PNG round-trips byte-for-byte.
  - `PermissionResponse` snake_case (`needs_prompt`, NOT `needsPrompt`).
  - `ErrorCode` rawValue contract — all 6 cases.
  - `OcrLine` normalized bbox round-trip.
  - `VisionOCR.sortReadingOrder` top-to-bottom-left-to-right behaviour
    (including the 0.01 y-tolerance band).
- ScreenCaptureKit + Vision live integration is out of scope for unit tests
  (they need the TCC grant and a real display). Worker D runs the end-to-end
  smoke from the Tauri shell.

## Negative invariants

- macOS-only. No `import UIKit`. No iOS / iPadOS targets in `Package.swift`.
- Single-frame capture only. NO streaming subprocess in v1 — the sidecar
  starts → captures one frame → stops → exits. A future streaming variant
  is a separate decision.
- Stateless one-shot. Every invocation re-resolves `SCShareableContent`. No
  caching of windows, contents, OCR results, or stream handles across calls.
- stdout is JSON-only. No log lines, no banner, no progress text on stdout.
  Debug logs go to stderr ONLY when `SCREEN_OCR_DEBUG=1` is set.
- `check-permission` MUST NOT trigger the system prompt. That's the host's
  decision, not the sidecar's.
- No environment-derived behaviour besides `SCREEN_OCR_DEBUG`. The host
  controls everything else via argv.
- Do NOT bundle Tesseract or any non-Apple OCR engine — the entire point of
  the Swift choice is to ride Apple's first-party models.
