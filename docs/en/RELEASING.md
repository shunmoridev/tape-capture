# Releasing TapeCapture

GitHub Actions builds the Windows NSIS and MSI installers and attaches them to
a draft GitHub Release. Release builds are currently unsigned, and FFmpeg is
not bundled.

## Prepare a version

1. Update the same version number in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Run `pnpm install` and `pnpm test:ts`.
3. Run `pnpm test:rust`. This also updates `src-tauri/Cargo.lock` when needed.
4. Commit and push the version change.

## Create the draft release

Push a tag that exactly matches the application version:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow verifies that all three version declarations and the tag
match, runs the test suites, builds the installers, and creates a draft Release.
Review the generated assets and release notes on GitHub, then publish the draft
manually.

The workflow can also be started manually from the Actions tab. In that case it
creates the version tag from `src-tauri/tauri.conf.json`.
