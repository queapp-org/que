import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { openTerminalLink } from '../terminal-links'
import { clearActiveTerminal, setActiveTerminal } from '../testHook'

interface Props {
  /** Daemon terminal id to attach to. */
  id: string
  /** Keyboard focus belongs here (the focused pane's terminal). Default true. */
  focused?: boolean
}

const isMac = navigator.userAgent.includes('Mac')

export default function Terminal({ id, focused = true }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const focusedRef = useRef(focused)

  useEffect(() => {
    focusedRef.current = focused
  })

  // Moving focus between panes with the keyboard has to move the cursor too.
  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  useEffect(() => {
    const host = hostRef.current

    if (!host) return

    const term = new XTerm({
      fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      macOptionIsMeta: false,
      // OSC 8 hyperlinks. xterm itself drops those that are not http or https.
      linkHandler: { activate: openTerminalLink },
      // The app's surface colours (styles.css); the cursor takes the accent.
      theme: {
        background: '#181818',
        foreground: '#eeeeee',
        cursor: '#3fcdb4',
        cursorAccent: '#181818',
        selectionBackground: '#363636'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    // Plain URLs in the output.
    term.loadAddon(new WebLinksAddon(openTerminalLink))
    term.open(host)

    // Prefer the GPU renderer; fall back to xterm's default DOM renderer if
    // WebGL is unavailable or the context is lost later.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('WebGL renderer unavailable, using default renderer', err)
    }

    // Shift+Enter inserts a newline in Claude Code. xterm sends the same bare
    // carriage return for it as for Enter, so send a line feed instead: the
    // Ctrl+J newline Claude Code accepts in any terminal, and plain Enter to a
    // shell or anything else that reads lines.
    //
    // Cmd+C copies when there is a selection. Cmd+V goes through the default
    // Edit menu's paste role into xterm's textarea, which applies bracketed
    // paste when the running program has enabled it.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true

      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        term.input('\n')
        ev.preventDefault()

        return false
      }

      if (!isMac || !ev.metaKey) return true

      if (ev.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        ev.preventDefault()

        return false
      }

      return true
    })

    fit.fit()
    termRef.current = term

    if (focusedRef.current) term.focus()

    let disposed = false
    let attached = false
    // Live output that arrives before the snapshot has been written.
    let queued: string[] = []
    const cleanups: Array<() => void> = []

    cleanups.push(
      window.que.term.on('term.data', (e) => {
        if (e.id !== id) return

        if (attached) term.write(e.data)
        else queued.push(e.data)
      }),
      window.que.term.on('term.exit', (e) => {
        if (e.id === id) term.write(`\r\n[process exited with code ${e.exitCode}]\r\n`)
      })
    )
    const input = term.onData((data) => window.que.term.write({ id, data }))
    cleanups.push(() => input.dispose())

    void window.que.term.attach({ id, cols: term.cols, rows: term.rows }).then(
      (res) => {
        if (disposed) return
        // Replay the daemon's mirror before streaming live data.
        term.write(res.snapshot)

        for (const d of queued) term.write(d)
        queued = []
        attached = true
        setActiveTerminal(id, term)

        // Sync in case the window resized while the attach was in flight.
        if (term.cols !== res.cols || term.rows !== res.rows) {
          void window.que.term.resize({ id, cols: term.cols, rows: term.rows })
        }
      },
      (err: Error) => {
        if (!disposed) term.write(`\r\n[could not attach: ${err.message}]\r\n`)
      }
    )

    let frame = 0

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        fit.fit()

        if (attached)
          void window.que.term.resize({ id, cols: term.cols, rows: term.rows }).catch(() => {})
      })
    })

    observer.observe(host)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()

      for (const c of cleanups) c()
      // Detach only; the terminal keeps running in the daemon.
      void window.que.term.detach({ id }).catch(() => {})
      clearActiveTerminal(term)
      termRef.current = null
      term.dispose()
    }
  }, [id])

  return <div className="terminal" ref={hostRef} data-testid="terminal-viewport" />
}
