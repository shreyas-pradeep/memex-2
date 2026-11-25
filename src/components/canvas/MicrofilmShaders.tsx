/**
 * Global inline SVG filter defs, rendered once per page.
 *
 * - `#microfilm-duotone`: 1945 archival engraving look for raster images
 *   (luminance, dark-slate to warm-parchment duotone, film grain).
 * - `#amber-glow` / `#violet-glow`: soft halos for human / ghost edges.
 *
 * The glow filters use `userSpaceOnUse` regions so perfectly horizontal or
 * vertical paths (zero-height bounding boxes) are not clipped.
 */
export function MicrofilmShaders() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
    >
      <defs>
        <filter
          id="microfilm-duotone"
          x="0"
          y="0"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          {/* 1. Collapse to luminance. */}
          <feColorMatrix
            type="matrix"
            values="0.33 0.59 0.11 0 0
                    0.33 0.59 0.11 0 0
                    0.33 0.59 0.11 0 0
                    0    0    0    1 0"
            result="luma"
          />
          {/* 2. Map shadows to obsidian slate and highlights to warm parchment. */}
          <feComponentTransfer in="luma" result="duotone">
            <feFuncR type="table" tableValues="0.035 0.96" />
            <feFuncG type="table" tableValues="0.04 0.78" />
            <feFuncB type="table" tableValues="0.06 0.48" />
          </feComponentTransfer>
          {/* 3. Film grain: fractal noise as opaque gray, multiplied in. */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            seed="1945"
            result="noise"
          />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="1 0 0 0 0
                    1 0 0 0 0
                    1 0 0 0 0
                    0 0 0 0 1"
            result="grain"
          />
          <feComposite
            in="duotone"
            in2="grain"
            operator="arithmetic"
            k1="0.5"
            k2="0.78"
            k3="0"
            k4="0"
            result="grained"
          />
          {/* 4. Keep the source image's transparency. */}
          <feComposite in="grained" in2="SourceAlpha" operator="in" />
        </filter>

        <GlowFilter id="amber-glow" color="#FFB236" />
        <GlowFilter id="violet-glow" color="#B388FF" />
      </defs>
    </svg>
  );
}

function GlowFilter({ id, color }: { id: string; color: string }) {
  return (
    <filter
      id={id}
      filterUnits="userSpaceOnUse"
      x="-20000"
      y="-20000"
      width="40000"
      height="40000"
      colorInterpolationFilters="sRGB"
    >
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
      <feFlood floodColor={color} floodOpacity="0.9" result="tint" />
      <feComposite in="tint" in2="blur" operator="in" result="halo" />
      <feMerge>
        <feMergeNode in="halo" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}
