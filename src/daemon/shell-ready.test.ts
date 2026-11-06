import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { echoIsOff, type ShellWait, waitForShell } from './shell-ready'

type Probe = () => Promise<boolean>

describe('waitForShell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers ready at the first poll for a shell already at its prompt', async () => {
    const probe = vi.fn<Probe>(() => Promise.resolve(true))

    await expect(waitForShell({ probe, stopped: () => false })).resolves.toBe('ready')

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('polls until the probe reports the line editor has taken over', async () => {
    const answers = [false, false, true]
    const probe = vi.fn<Probe>(() => Promise.resolve(answers.shift() === true))

    const wait = waitForShell({ probe, stopped: () => false, intervalMs: 50 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(wait).resolves.toBe('ready')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('gives up at the timeout, ten seconds by default', async () => {
    const settled = vi.fn<(outcome: ShellWait) => void>()
    const wait = waitForShell({ probe: () => Promise.resolve(false), stopped: () => false })
    void wait.then(settled)

    await vi.advanceTimersByTimeAsync(9_950)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    await expect(wait).resolves.toBe('timeout')
  })

  it('gives up at a shorter timeout when given one', async () => {
    const wait = waitForShell({
      probe: () => Promise.resolve(false),
      stopped: () => false,
      intervalMs: 10,
      timeoutMs: 30
    })

    await vi.advanceTimersByTimeAsync(30)

    await expect(wait).resolves.toBe('timeout')
  })

  it('stops polling once it is stopped', async () => {
    let stopped = false
    const probe = vi.fn<Probe>(() => Promise.resolve(false))

    const wait = waitForShell({ probe, stopped: () => stopped, intervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    stopped = true
    await vi.advanceTimersByTimeAsync(50)

    await expect(wait).resolves.toBe('stopped')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never probes when already stopped', async () => {
    const probe = vi.fn<Probe>(() => Promise.resolve(true))

    await expect(waitForShell({ probe, stopped: () => true })).resolves.toBe('stopped')

    expect(probe).not.toHaveBeenCalled()
  })

  it('never starts a poll while the last one is still running', async () => {
    let answer: (ready: boolean) => void = () => {}

    const probe = vi.fn<Probe>(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )

    const wait = waitForShell({ probe, stopped: () => false, intervalMs: 50 })
    await vi.advanceTimersByTimeAsync(500)
    expect(probe).toHaveBeenCalledTimes(1)

    answer(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(probe).toHaveBeenCalledTimes(2)

    answer(true)
    await expect(wait).resolves.toBe('ready')
  })
})

describe('echoIsOff', () => {
  it.each([
    [
      'a line editor',
      'lflags: -icanon isig iexten -echo echoe echok echoke -echonl echoctl\n\t-echoprt'
    ],
    ['the flag ending the output', 'lflags: -icanon -echo'],
    ['the flag at the start', '-echo icanon'],
    ['the semicolons of another stty', 'isig; -echo; -echonl;']
  ])('is true for %s', (_case, output) => {
    expect(echoIsOff(output)).toBe(true)
  })

  it.each([
    [
      'a shell still reading its profile',
      'lflags: icanon isig iexten echo echoe echok echoke -echonl echoctl\n\t-echoprt'
    ],
    ['flags that only start with echo', 'lflags: echo -echoe -echok -echoke -echonl -echoctl'],
    ['no output', '']
  ])('is false for %s', (_case, output) => {
    expect(echoIsOff(output)).toBe(false)
  })
})
