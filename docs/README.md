# docs

`preview.png` is the gallery image referenced by `pi.image` in `package.json`
and shown on https://pi.dev/packages.

Requirements (per pi package docs):
- Format: PNG, JPEG, GIF, or WebP.
- Recommended: a wide screenshot of the usage bar in pi's footer,
  e.g. `cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h │ oai ▓░░░░ 12% · 3h 4m`.

To capture: run `pi -e ./extensions/usage-bar.ts`, screenshot the footer,
save it here as `preview.png`, then commit and publish.
