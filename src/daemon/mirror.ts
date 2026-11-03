// The @xterm/headless terminal that mirrors everything a terminal has printed, so an
// attach (or a successor daemon) gets the screen and scrollback as they are.
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { TermSnapshotResult } from '../shared/protocol'
import { applyUnicodeWidths } from '../shared/unicode-width'

const SCROLLBACK = 10000

export class TerminalMirror {
  private readonly term: HeadlessTerminal
  private readonly serializer = new SerializeAddon()

  constructor(cols: number, rows: number) {
    this.term = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    // The serialize addon is typed against the browser Terminal; the @xterm/headless
    // terminal implements the same public surface it uses.
    this.term.loadAddon(this.serializer)
    applyUnicodeWidths(this.term)
  }

  write(data: string): void {
    this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  /** Fires when the program sets the title (OSC 0 or 2); an empty title clears it. Ends with the mirror. */
  onTitleChange(cb: (title: string) => void): void {
    this.term.onTitleChange(cb)
  }

  /**
   * Serialized screen + scrollback. The mirror's write queue is drained first
   * so the snapshot reflects every byte received before this call, and no
   * byte received after it (serialization runs inside the write callback,
   * before xterm processes any later chunk).
   */
  snapshot(): Promise<TermSnapshotResult> {
    return this.atBoundary(() => ({ serialized: this.serialize(), text: this.text() }))
  }

  /** Same boundary guarantee as snapshot(), serialized form only. */
  serializeNow(): Promise<string> {
    return this.atBoundary(() => this.serialize())
  }

  dispose(): void {
    this.term.dispose()
  }

  private atBoundary<T>(fn: () => T): Promise<T> {
    return new Promise((resolve) => this.term.write('', () => resolve(fn())))
  }

  private serialize(): string {
    return this.serializer.serialize({ scrollback: SCROLLBACK })
  }

  private text(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []

    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    return lines.join('\n')
  }
}
