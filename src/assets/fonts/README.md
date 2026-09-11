# Supplied brand fonts

The WOFF2 assets in this directory were converted from the user-supplied files in `src/app/fonts`. The originals are retained. Conversion preserves the font name, license records, and OS/2 weight metadata; it does not grant or change a font license.

- Neue Machina: regular (400) and ultrabold (800), used for the wordmark and display text.
- General Sans: regular (400), medium (500), and semibold (600), used for body text.
- JetBrains Mono: locally bundled through `@fontsource/jetbrains-mono`, used for UI and metadata.

To regenerate the brand assets, install `fonttools` and `brotli` into the ignored `.font-tools` directory and run `python scripts/convert-fonts.py`. No conversion is necessary to run or build the frontend.
