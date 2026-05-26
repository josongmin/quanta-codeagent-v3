# `icons/` — app icon assets

The four icon files referenced from `../tauri.conf.json` `bundle.icon`:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns`

The committed `.png` files are 1×1 transparent placeholders so
`cargo tauri build` does not fail on missing assets. **Replace with real
artwork before shipping.**

`icon.icns` is NOT committed (binary, format-specific). The Tauri CLI can
generate one from a single 1024×1024 source PNG:

```sh
cargo tauri icon path/to/source-1024.png
```

That command writes all four required filenames into this directory.
