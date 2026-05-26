# screen-ocr

Tiny Swift CLI sidecar for the quanta Tauri shell.

- Lists on-screen macOS windows (`list-windows`).
- Grabs ONE frame from a given window via ScreenCaptureKit (`capture --window-id N`).
- Runs Apple Vision OCR (`VNRecognizeTextRequest`, revision 3, `ko-KR + en-US`,
  `accurate` level, `usesLanguageCorrection = true`).
- Checks TCC Screen Recording permission state (`check-permission`).

All output is single-line JSON on stdout with snake_case keys. Errors are JSON too
plus a non-zero exit code (see `Sources/ScreenOcr/JSON/Models.swift` for the
shapes and `Sources/ScreenOcr/main.swift` for the exit code table).

## Build

```sh
cd native/screen-ocr
swift build -c release
# binary at: .build/release/screen-ocr
```

Apple Silicon and Intel are both supported (Swift Package Manager produces a
native binary per host arch; lipo afterwards if a universal binary is needed).

## Use from the host

```sh
./screen-ocr list-windows
./screen-ocr capture --window-id 1234
./screen-ocr capture --window-id 1234 --include-image   # PNG base64 inline
./screen-ocr check-permission
./screen-ocr --version
```

## Permissions

ScreenCaptureKit needs the **Screen Recording** TCC entitlement. The system
prompt is auto-triggered the first time `SCShareableContent.current` is read by
the host process (the Tauri shell, when it spawns this sidecar). The
`check-permission` subcommand only inspects state — it deliberately does NOT
trigger the prompt itself.

## Why a separate Swift binary, not Rust?

See [`docs/decisions/0318-screen-ocr-native-sidecar.md`](../../docs/decisions/0318-screen-ocr-native-sidecar.md).
Short version: ScreenCaptureKit + Vision are first-party Swift APIs with the
shortest path to correctness, and the alternative (Tesseract via Rust) loses on
Korean accuracy.

## Negative invariants

- macOS-only. No iOS / UIKit imports.
- Single-frame capture only. No streaming subprocess in v1.
- Stateless one-shot — every invocation re-resolves `SCShareableContent`.
- stdout is JSON-only. Debug logs go to stderr behind `SCREEN_OCR_DEBUG=1`.
