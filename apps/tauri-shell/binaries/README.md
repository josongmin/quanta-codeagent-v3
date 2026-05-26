# `binaries/` — sidecar drop-in directory

Tauri's `bundle.externalBin` allowlist (see `../tauri.conf.json`) expects
the two sidecar binaries to live in this directory **before** you run
`cargo tauri build`. They are NOT committed — they're build artifacts of
sibling workers.

| Binary               | Source                          | Build command                                                                                  |
|----------------------|---------------------------------|------------------------------------------------------------------------------------------------|
| `quanta-web-daemon`  | `src/apps/web-daemon/` (worker B) | `bun build --compile --outfile binaries/quanta-web-daemon src/apps/web-daemon/index.ts`         |
| `screen-ocr`         | `native/screen-ocr/` (worker E) | `cd native/screen-ocr && swift build -c release && cp .build/release/screen-ocr ../../apps/tauri-shell/binaries/screen-ocr` |

Build order:

1. Bun web-daemon — independent.
2. Swift screen-ocr — independent.
3. (You can do 1 and 2 in any order or in parallel.)
4. `cargo tauri build` from `apps/tauri-shell/` — Tauri copies both into
   the `.app` bundle's `Contents/MacOS/` directory automatically.

## Tauri 2.x target-triple suffix

Tauri 2.x's sidecar feature looks for `<name>-<target-triple>` when
bundling (e.g. `screen-ocr-aarch64-apple-darwin` on Apple Silicon). If
your `cargo tauri build` errors with "sidecar not found", symlink or
rename:

```sh
ln -s screen-ocr screen-ocr-$(rustc -vV | awk '/host/ {print $2}')
ln -s quanta-web-daemon quanta-web-daemon-$(rustc -vV | awk '/host/ {print $2}')
```

This is documented here (not automated) because the target triple is
toolchain-local and we don't want a build script that mutates worker B/E
outputs.

## Why not commit these?

- Binaries are large (compiled bun is ~80MB; Swift sidecar is ~5MB).
- They depend on workers B/E whose own build steps gate their availability.
- The `.gitkeep` file below keeps the directory present for the ACL path
  resolver.
