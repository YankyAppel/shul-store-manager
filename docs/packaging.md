# Windows packaging

The manager and kiosk are packaged as separate x64 Windows installers using
electron-builder and NSIS:

- `Shul Store Manager` installs the manager application.
- `Shul Store Kiosk` installs the kiosk application.

Both installers use a per-machine install, allow the installer to choose its
directory, and are not one-click installers.

## Build locally

Build the application first, then package either app:

```bash
npm install
npm run build
npm run package -w @shul-store/manager
npm run package -w @shul-store/kiosk
```

The installers are written to `apps/manager/release/` and
`apps/kiosk/release/`. Packaging uses `asar` archives. The manager preload is
compiled to `dist-electron/preload.cjs` and verified before packaging; the
packaged manager resolves that preload from inside its asar archive. Product
images continue to use the `store-image://` protocol and are read from the
per-user data directory, not from the application archive.

No native rebuild step is used. SQLite uses Node's built-in `node:sqlite`
support. If a packaged build cannot open `node:sqlite`, that is a packaging
failure to investigate rather than a reason to replace it with a native
SQLite dependency.

## Store data and upgrades

The manager stores its SQLite database, product images, and local backups in
Electron's OS-specific `userData` directory. On Windows this is normally under
`%APPDATA%\Shul Store Manager\` (the exact path is controlled by Electron).

Installing a newer version does not touch that directory. The NSIS
configuration sets `deleteAppDataOnUninstall: false`, so uninstalling the
application also does not delete the store's books, images, or backups. Keep
local backups before manually deleting the data directory.

The root `package.json` is the single source of the application version.
Both installer configurations import that version, and the manager Settings
screen displays `app.getVersion()`, so the installer and the running app
identify the same build.

## Releases

The release workflow runs on `windows-latest` for a tag matching `v*`, and can
also be started with `workflow_dispatch`. It installs Node 22.14.0, runs the
full quality-gate sequence, builds both installers, and uploads them as
workflow artifacts. For a version tag, the manager package publishes its
installer and `latest.yml` to the public release repository with
electron-builder, and the kiosk installer is uploaded there as a manual
release asset.

Create a release from a clean branch by updating the root `package.json`
version, committing it, and pushing a matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow does not alter the existing pull-request CI workflow.

## Signing and SmartScreen

Installers are unsigned unless the release job has both
`CSC_LINK` and `CSC_KEY_PASSWORD` configured as protected environment or
repository secrets. No certificate or placeholder certificate path is stored
in this repository. An unsigned install normally causes Windows SmartScreen to
show an **unknown publisher** warning; the shames can choose the Windows
option to continue only after verifying the installer source.

When a code-signing certificate is supplied through those environment
variables, electron-builder signs the installer and Windows can show the
certificate publisher instead of “unknown publisher” (subject to certificate
trust and reputation).

## Manager automatic updates

The manager's default update feed is the public GitHub Releases feed for
`YankyAppel/shul-store-manager-releases`. The release repository must be public
so an installed manager can read its metadata without credentials. That target
lives in `apps/manager/update-config.cjs`, and the release workflow's
`RELEASE_REPOSITORY` value must match it. The manager checks about 30 seconds
after its window is ready and
then every six hours. When an update is found, it downloads in the background
and installs only when the manager is closed; it never restarts during a sale
or other open session.

Automatic updates are enabled by default. Turn them off with the
**Download updates automatically and install when the app closes** checkbox in
Settings. The **Check for updates** button remains available as a manual
fallback, and Settings shows the last check result and timestamp. When an
update is downloaded, the Settings notice says which version is ready and
that it will install on close.

The optional **Update feed URL** setting overrides GitHub Releases with a
self-hosted generic electron-updater feed. It is device-local and must be an
HTTPS URL; HTTP, `file:`, malformed, and other schemes are rejected. Leave it
blank to use the public release repository. A persisted non-HTTPS value is
refused by the updater rather than used as a fallback. A tagged release must include the manager installer and
its `latest.yml` metadata; the Windows release workflow publishes both with
electron-builder using the `GH_RELEASE_TOKEN` secret, a PAT with write access
to the public release repository. The kiosk installer is uploaded separately
to that same release repository and has no updater because a kiosk must never
restart itself mid-sale. Kiosk upgrades are manual.
