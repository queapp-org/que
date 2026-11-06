import { describe, expect, it } from 'vitest'
import {
  FRAME_INTERVAL_MS,
  ICON_HEIGHT,
  ICON_SCALE,
  ICON_WIDTH,
  qBitmap,
  qWithDotBitmap,
  STATUS_SLOT_X,
  stillWorkingBitmap,
  workingBitmaps
} from './tray-icon'

const SLOT = Math.floor(STATUS_SLOT_X)

const alphaAt = (bitmap: Buffer, x: number, y: number): number =>
  bitmap[(y * ICON_WIDTH + x) * 4 + 3]

/** The alpha of every pixel left of the status slot, row by row. */
function qPixels(bitmap: Buffer): number[] {
  const pixels: number[] = []

  for (let y = 0; y < ICON_HEIGHT; y++) {
    for (let x = 0; x < SLOT; x++) pixels.push(alphaAt(bitmap, x, y))
  }

  return pixels
}

/** The size in pixels of each separate blob of ink in the status slot. */
function slotBlobs(bitmap: Buffer): number[] {
  const seen = new Set<string>()
  const sizes: number[] = []

  const inked = (x: number, y: number): boolean =>
    x >= SLOT && x < ICON_WIDTH && y >= 0 && y < ICON_HEIGHT && alphaAt(bitmap, x, y) > 0

  for (let y = 0; y < ICON_HEIGHT; y++) {
    for (let x = SLOT; x < ICON_WIDTH; x++) {
      if (!inked(x, y) || seen.has(`${x},${y}`)) continue
      const stack = [[x, y]]
      let size = 0

      while (stack.length > 0) {
        const [px, py] = stack.pop() as number[]

        if (!inked(px, py) || seen.has(`${px},${py}`)) continue
        seen.add(`${px},${py}`)
        size += 1
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1])
      }

      sizes.push(size)
    }
  }

  return sizes
}

const everyImage = [qBitmap(), qWithDotBitmap(), stillWorkingBitmap(), ...workingBitmaps()]

describe('the tray icon', () => {
  it('is 23×18pt at @2x in every state, so neighbours never shift', () => {
    expect([ICON_WIDTH / ICON_SCALE, ICON_HEIGHT / ICON_SCALE]).toEqual([23, 18])

    for (const bitmap of everyImage) expect(bitmap).toHaveLength(46 * 36 * 4)
  })

  it('draws black ink only, the alpha carrying the shape, as a template image needs', () => {
    for (const bitmap of everyImage) {
      const colour = bitmap.filter((_value, i) => i % 4 !== 3)

      expect(colour.every((value) => value === 0)).toBe(true)
      expect(bitmap.some((value) => value > 0)).toBe(true)
    }
  })

  it('draws the same q in every state', () => {
    const q = qPixels(qBitmap())

    expect(q.some((alpha) => alpha === 255)).toBe(true)

    for (const bitmap of everyImage) expect(qPixels(bitmap)).toEqual(q)
  })

  describe('the status slot', () => {
    it('is empty on the bare q', () => {
      expect(slotBlobs(qBitmap())).toEqual([])
    })

    it('holds one dot on the q with the dot', () => {
      expect(slotBlobs(qWithDotBitmap())).toHaveLength(1)
    })
  })

  describe('the working mark', () => {
    it('runs 12 frames, 100ms each: the sidebar’s 1.2s loop', () => {
      expect(workingBitmaps()).toHaveLength(12)
      expect(FRAME_INTERVAL_MS).toBe(100)
    })

    it('changes on every step of the loop, and from the last frame to the first', () => {
      const frames = workingBitmaps()

      frames.forEach((frame, i) => {
        expect(frame.equals(frames[(i + 1) % frames.length]), `frame ${i}`).toBe(false)
      })
    })

    it('stands still with all four dots, the same size', () => {
      const dots = slotBlobs(stillWorkingBitmap())

      expect(dots).toHaveLength(4)
      expect(new Set(dots).size).toBe(1)
    })

    it('stands still at full size: the loop’s fullest frame is the still one', () => {
      const still = stillWorkingBitmap()

      expect(workingBitmaps().some((frame) => frame.equals(still))).toBe(true)
    })
  })
})
