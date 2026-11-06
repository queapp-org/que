// The menu-bar icon's pixels: the q, plus a status mark in a slot right of its stem, all one
// width so neighbouring items never shift. Drawn from signed distances and anti-aliased by them,
// as raw BGRA: black ink with alpha as coverage, which is what a template image reads (B, G and R
// stay 0, so premultiplying changes nothing). docs/design.md "Menu bar".

/** The bitmap: 23×18pt at @2x. */
export const ICON_WIDTH = 46
export const ICON_HEIGHT = 36
export const ICON_SCALE = 2

/** One step of the working mark: 12 of them make the sidebar's 1.2s loop. */
export const FRAME_INTERVAL_MS = 100
const FRAME_COUNT = 12

// The q: the proportions of build/icon.png, its stem from the equator down.
const Q = { cx: 12, cy: 13, r: 8.6, w: 3.4 }
const STEM_X = Q.cx + Q.r
const STEM_END_Y = 30

/** The left edge of the status slot; the q draws nothing from here on. */
export const STATUS_SLOT_X = STEM_X + 6

// The working mark's grid, in the corner the logo's dot takes.
const GRID_TOP = 16
const GRID_DOT = 6
const GRID_GAP = 4

// The working-ripple keyframes in styles.css: the loop in seconds and each dot's delay.
const LOOP_S = 1.2
const DELAYS_S = [0, 0.12, 0.12, 0.24]

/** How much of a pixel an edge `d` away covers, from a signed distance. */
const coverage = (d: number): number => Math.min(1, Math.max(0, 0.5 - d))

const dotDistance = (x: number, y: number, cx: number, cy: number, r: number): number =>
  Math.hypot(x - cx, y - cy) - r

function qAlpha(x: number, y: number): number {
  const ring = Math.abs(Math.hypot(x - Q.cx, y - Q.cy) - Q.r) - Q.w / 2
  const stem = Math.hypot(x - STEM_X, y - Math.min(Math.max(y, Q.cy), STEM_END_Y)) - Q.w / 2

  return coverage(Math.min(ring, stem))
}

/** A mark's alpha at a point. */
type Mark = (x: number, y: number) => number

/** The bitmap of the q and a mark: the pixel's centre is what gets sampled. */
function draw(mark: Mark = () => 0): Buffer {
  const bitmap = Buffer.alloc(ICON_WIDTH * ICON_HEIGHT * 4)

  for (let y = 0; y < ICON_HEIGHT; y++) {
    for (let x = 0; x < ICON_WIDTH; x++) {
      const alpha = Math.max(qAlpha(x + 0.5, y + 0.5), mark(x + 0.5, y + 0.5))

      bitmap[(y * ICON_WIDTH + x) * 4 + 3] = Math.round(alpha * 255)
    }
  }

  return bitmap
}

/** A dot's scale `t` seconds into the loop: 0→1 by 30%, hold to 55%, 1→0 by 85%, 0 to 100%. */
function rippleScale(t: number): number {
  const p = (((t % LOOP_S) + LOOP_S) % LOOP_S) / LOOP_S

  if (p < 0.3) return p / 0.3

  if (p < 0.55) return 1

  if (p < 0.85) return 1 - (p - 0.55) / 0.3

  return 0
}

/** The working mark: four dots on a 2×2 grid, each at its scale. */
function workingMark(scales: number[]): Mark {
  return (x, y) => {
    let alpha = 0

    scales.forEach((scale, i) => {
      if (scale <= 0) return
      const cx = STATUS_SLOT_X + (i % 2) * (GRID_DOT + GRID_GAP) + GRID_DOT / 2
      const cy = GRID_TOP + (i >> 1) * (GRID_DOT + GRID_GAP) + GRID_DOT / 2

      alpha = Math.max(alpha, coverage(dotDistance(x, y, cx, cy, (GRID_DOT / 2) * scale)))
    })

    return alpha
  }
}

/** The q alone. */
export function qBitmap(): Buffer {
  return draw()
}

/** The q and one solid dot, echoing the logo's. */
export function qWithDotBitmap(): Buffer {
  return draw((x, y) => coverage(dotDistance(x, y, STATUS_SLOT_X + 5, 25, 4.6)))
}

/** The q and the working mark, one bitmap per step of its loop. */
export function workingBitmaps(): Buffer[] {
  return Array.from({ length: FRAME_COUNT }, (_, i) => {
    const t = (i / FRAME_COUNT) * LOOP_S

    return draw(workingMark(DELAYS_S.map((delay) => rippleScale(t - delay))))
  })
}

/** The q and the working mark standing still, all four dots at full size. */
export function stillWorkingBitmap(): Buffer {
  return draw(workingMark(DELAYS_S.map(() => 1)))
}
