# useOmnis footer design QA

Reference: Image A supplied by the user (`codex-clipboard-bb04428d-a472-4ad4-90c4-31fb5cab4064.png`).
Implementation capture: `output/playwright/footer-desktop.png`, rendered at 1440 × 900 with the browser fixed header visible.

## Comparison

- Full-viewport closing scene: passed. The footer fills the viewport and remains in normal document flow after the final CTA.
- Background treatment: passed. The supplied astronaut artwork is used as a real full-bleed image with preserved aspect ratio, responsive cropping, and a contrast veil.
- Header/brand rhythm: passed. The footer has its own top-left wordmark and top-right locked descriptor, with enough top offset to clear the fixed landing header.
- Link composition: passed. Three ruled columns, real workspace/landing destinations, disabled “coming later” labels, and the primary `start a task` action are present.
- Oversized closing wordmark: passed. The cropped `useOmnis.` treatment anchors the bottom edge without horizontal overflow.
- Responsive continuation: passed in existing 320, 375, 600, 1024, and 1440px reflow coverage; mobile columns collapse and the artwork remains undistorted.

## Intentional deviations

The reference uses landscape photography and social/resource destinations. This implementation uses the authorized portrait astronaut artwork and only real useOmnis routes; unavailable social/resource items are visibly marked “coming later” and are not interactive.

## Result

Passed visual QA for the requested footer direction and accessibility constraints. The footer navigation and fixed-header overlay were also verified from the absolute page bottom.
