---
inclusion: fileMatch
fileMatchPattern: "src/components/**/*"
---
# UI Aesthetics: "1945 Amber & Phantom Violet" (Zero-AI-Slop Standard)

## Visual Identity & Atmosphere
- **Theme:** 1945 tactile microfilm archive meets a supernatural autonomous AI ghost engine. High contrast, dark mode only.
- **Color Tokens:**
  - `canvas-bg`: `#090A0F` (Deep obsidian slate with dynamic subtle dot grid)
  - `card-surface`: `#141721` (Matte dark archival microfiche)
  - `card-border`: `rgba(255, 178, 54, 0.18)` (Default warm archival border)
  - `accent-human`: `#FFB236` (Warm tungsten vacuum-tube amber for user notes and manual trails)
  - `accent-ghost`: `#B388FF` (Supernatural phantom violet for autonomous AI connections and ghost trails)
  - `text-primary`: `#F4F1EA` (High-contrast parchment white)
  - `text-muted`: `#8E94A5` (Film grain slate for metadata, timestamps, and coordinates)
- **Typography:**
  - Headings: Editorial high-contrast serif (`font-serif`) for card titles
  - Metadata / IDs: Crisp technical monospace (`font-mono`) for node IDs, timestamps, and similarity scores

## Anti-AI-Slop Graphics Rules
1. **Unified Microfilm Filter:** All raster images dropped on the canvas MUST pass through an inline SVG `<filter id="microfilm-duotone">` (`feColorMatrix` + grain) so every image looks like an authentic 1945 archival engraving.
2. **Procedural SVGs Only:** Use mathematical inline SVGs with `1px` crisp strokes, crosshair registration marks (`+`), and glowing bezier curves (`#FFB236` for human, `#B388FF` for Ghost AI) with animated `stroke-dasharray` pulses.
3. **60fps Motion:** Use `framer-motion` spring physics (`stiffness: 300, damping: 28`) for cards. Never animate `top`/`left`/`width`/`height`—only `transform` and `opacity`. Camera transitions (`setCenter` / `fitView`) must glide smoothly (`duration: 800ms`).