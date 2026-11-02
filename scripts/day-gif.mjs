// Records the website home page's "a day with que" animation into docs/images/day.gif, the
// README's GIF: one whole loop, in real time, so the walks, fades and blinks between the clock's
// ticks are in it too.
//
//   npm run day:gif                                    from https://queapp.org/
//   npm run day:gif -- --url http://localhost:4321/    from a local build of the website
//   npm run day:gif -- --executable <path>             a browser build other than Playwright's own
//
// The page's clock (src/lib/day.ts in the website) ticks every 300 ms and comes back to tick 0
// after 120 ticks. The page is loaded fresh, at full motion, in the site's default dark theme;
// the stage (the scene and the app window, without the buttons under them) is scrolled into view
// during the first loop, and one whole loop of the second is recorded, from START_TICK round to
// START_TICK, so the GIF loops without a seam. The screen is captured as PNG frames with their
// own timestamps, and each tick becomes TICK_MS / FRAME_MS frames of FRAME_MS each, taken at
// fixed offsets from that tick's own start, so the GIF keeps the page's timing even when a tick
// fires a little late.
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'images', 'day.gif')

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://queapp.org/' },
    executable: { type: 'string' }
  }
})

/** The page's clock: a tick every TICK_MS, and tick 0 again after LOOP_TICKS. */
const TICK_MS = 300
const LOOP_TICKS = 120

/** Each tick becomes TICK_MS / FRAME_MS frames: 20 a second. */
const FRAME_MS = 50

/**
 * The GIF opens on the morning report once it has faded in, so its first frame reads on its own
 * where motion is reduced; the fade-in plays at the end, on the way round.
 */
const START_TICK = 4

/**
 * The stage at its natural size, in CSS px. The window is wide enough for it, and tall enough
 * for it under the site's fixed header.
 */
const STAGE = { width: 1110, height: 460 }
const VIEWPORT = { width: 1200, height: 560 }

/**
 * The capture delivers one pixel per CSS px whatever the device scale, so the page is drawn at
 * 1x, where the site lays its blocks edge to edge, and the GIF is 0.8 of the natural size: the
 * scene's 5 px blocks land on whole 4 px blocks, and the window's text stays legible.
 */
const SCALE = 0.8
const WIDTH = Math.round(STAGE.width * SCALE)
const HEIGHT = Math.round(STAGE.height * SCALE)

const browser = await chromium.launch({ executablePath: args.executable })

const page = await browser.newPage({
  viewport: VIEWPORT,
  // The site's theme for a first visit: dark unless the system asks for light.
  colorScheme: 'dark',
  reducedMotion: 'no-preference'
})

// Every tick of the page's clock, as the time it fired.
const ticks = []
let onTick = () => {}

await page.exposeFunction('queDayTick', (at) => {
  ticks.push(at)
  onTick()
})

await page.addInitScript((tickMs) => {
  const setInterval = window.setInterval

  window.setInterval = function (handler, ms, ...rest) {
    if (ms !== tickMs || typeof handler !== 'function') {
      return setInterval.call(window, handler, ms, ...rest)
    }

    const tick = (...a) => {
      handler(...a)
      window.queDayTick(performance.timeOrigin + performance.now())
    }

    return setInterval.call(window, tick, ms, ...rest)
  }
}, TICK_MS)

await page.goto(args.url, { waitUntil: 'load' })

await page.evaluate(() => document.fonts.ready)

const stage = page.locator('[data-day] .stage')

await stage.waitFor()

// The stage just under the header, with a few pixels of page between them.
const header = await stage.evaluate((el) => {
  const below = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
  window.scrollBy(0, Math.floor(el.getBoundingClientRect().top - below) - 8)

  return below
})

const box = await stage.boundingBox()

if (
  Math.round(box.width) !== STAGE.width ||
  box.y < header ||
  box.y + box.height > VIEWPORT.height
) {
  throw new Error(`the stage is not whole at its natural size: ${JSON.stringify(box)}`)
}

const crop = { left: Math.round(box.x), top: Math.round(box.y), ...STAGE }

/** Resolves once the clock has fired n ticks since the page loaded. */
function untilTick(n) {
  return new Promise((resolve) => {
    onTick = () => ticks.length >= n && resolve()
    onTick()
  })
}

// Tick START_TICK of the second loop, as an index into ticks: the nth tick after the page
// loaded shows tick n % LOOP_TICKS. Capturing starts a few ticks before it.
const first = LOOP_TICKS + START_TICK - 1

await untilTick(first - 5)

const cdp = await page.context().newCDPSession(page)
const frames = []

cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  frames.push({ at: metadata.timestamp * 1000, png: Buffer.from(data, 'base64') })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})

await cdp.send('Page.startScreencast', { format: 'png' })

await untilTick(first + LOOP_TICKS + 2)

await cdp.send('Page.stopScreencast')

await browser.close()

const shots = []

for (let k = 0; k < LOOP_TICKS; k++) {
  const start = ticks[first + k]

  // Just before the end of each FRAME_MS: what the page shows by then, painted.
  for (let at = start + FRAME_MS - 5; at < start + TICK_MS; at += FRAME_MS) {
    const frame = frames.findLast((f) => f.at <= at)

    if (!frame) throw new Error(`no frame for tick ${(START_TICK + k) % LOOP_TICKS}`)
    shots.push(frame.png)
  }
}

// Each distinct picture once, held for as long as it stays the same.
const scaled = []
const delays = []

for (const png of shots) {
  const out = await sharp(png)
    .extract(crop)
    .resize(WIDTH, HEIGHT, { kernel: 'lanczos3' })
    .png()
    .toBuffer()

  if (scaled.length > 0 && out.equals(scaled[scaled.length - 1])) {
    delays[delays.length - 1] += FRAME_MS
  } else {
    scaled.push(out)
    delays.push(FRAME_MS)
  }
}

mkdirSync(dirname(OUT), { recursive: true })

await sharp(scaled, { join: { animated: true } })
  .gif({
    delay: delays,
    loop: 0,
    effort: 10,
    // No dithering: the scene's flat blocks and the window's text stay crisp, and frames
    // compress better.
    dither: 0,
    interFrameMaxError: 4,
    keepDuplicateFrames: true
  })
  .toFile(OUT)

const total = delays.reduce((sum, d) => sum + d, 0)
const mb = (statSync(OUT).size / 1024 / 1024).toFixed(2)

console.log(
  `${OUT}: ${WIDTH}x${HEIGHT}, ${scaled.length} frames, ${(total / 1000).toFixed(1)} s, ${mb} MB` +
    ` (from ${frames.length} captured)`
)
