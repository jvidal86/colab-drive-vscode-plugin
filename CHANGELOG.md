# Changelog

All notable changes to the Colab Drive extension are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-06-20

### Added
- The sidebar now mirrors your Drive **folder hierarchy**: notebooks are grouped
  under expandable folders instead of a single flat list. Only folders that
  contain notebooks (directly or nested) are shown, so empty branches are pruned.

### Changed
- `colabDrive.folderName`, when set, now scopes the view to that folder's whole
  **subtree** (recursive) rather than only its direct children.

## [1.1.3] - 2026-06-20

### Changed
- `colabDrive.folderName` now defaults to **empty**, so the whole Drive is
  searched out of the box. Previously it defaulted to `Colab Notebooks`, which
  silently hid notebooks stored elsewhere (e.g. uploaded `.ipynb` files in My
  Drive root). Folder filtering is now opt-in.

## [1.1.2] - 2026-06-20

### Added
- Extension icon.
- This changelog.

### Changed
- Tightened `.vscodeignore` so the packaged `.vsix` ships only what it needs.

## [1.1.1] - 2026-06-20

### Changed
- Replaced the monolithic `googleapis` dependency with the focused
  `@googleapis/drive` package. No functional change; the packaged `.vsix`
  shrank from ~20 MB to ~2.3 MB.

## [1.1.0] - 2026-06-20

### Added
- **Set up credentials** command storing your Google OAuth `client_secret.json`
  in VS Code's encrypted SecretStorage, so it survives installs and upgrades.
- A dedicated "needs credentials" welcome view that guides first-time setup.

### Changed
- Credentials are no longer required to sit as a plaintext file in the
  extension folder (that path still works as a fallback when running from
  source). README rewritten with the Google Cloud setup guide.

## [1.0.0] - 2026-06-20

### Added
- Initial release: browse Colab and Jupyter notebooks from Google Drive in a
  VS Code sidebar and open them in the editor.
- OAuth2 sign-in via a local loopback flow with CSRF `state` check and a login
  timeout.
- Drive listing with pagination, an optional folder filter
  (`colabDrive.folderName`), and notebooks opened via sanitized temp files.
- State-driven sidebar UX (sign in / no notebooks / sign out) with no flicker.
