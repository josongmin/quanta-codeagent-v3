# `binaries/` — sidecar staging directory

Tauri's `bundle.externalBin` allowlist (see `../tauri.conf.json`) expects
the two sidecar binaries to live in this directory when the shell build
runs. `../scripts/prepare-build.sh` now compiles and stages them
automatically from `beforeBuildCommand`.

| Binary               | Source                          | Build command                                                                                  |
|----------------------|---------------------------------|------------------------------------------------------------------------------------------------|
| `quanta-web-daemon`  | `src/apps/web-daemon/` (worker B) | `bun build --compile --outfile binaries/quanta-web-daemon src/apps/web-daemon/index.ts`         |
| `screen-ocr`         | `native/screen-ocr/` (worker E) | `cd native/screen-ocr && swift build -c release && cp .build/release/screen-ocr ../../apps/tauri-shell/binaries/screen-ocr` |

The build script also mirrors each sidecar into:

- `<name>-<target-triple>` in this directory, for Tauri's sidecar resolver
- `target/release/{<name>,<name>-<target-triple>}`, so
  `cargo tauri build --no-bundle` produces a directly runnable release tree

## Tauri 2.x target-triple suffix

Tauri 2.x's sidecar feature looks for `<name>-<target-triple>` when
bundling (e.g. `screen-ocr-aarch64-apple-darwin` on Apple Silicon). If
your `cargo tauri build` errors with "sidecar not found", symlink or
rename:

```sh
ln -s screen-ocr screen-ocr-$(rustc -vV | awk '/host/ {print $2}')
ln -s quanta-web-daemon quanta-web-daemon-$(rustc -vV | awk '/host/ {print $2}')
```

This is automated now because stale sidecar copies in `target/release/`
were a real failure mode during shell smoke.

## Why not commit these?

- Binaries are large (compiled bun is ~80MB; Swift sidecar is ~5MB).
- They depend on workers B/E whose own build steps gate their availability.
- The `.gitkeep` file below keeps the directory present for the ACL path
  resolver.
