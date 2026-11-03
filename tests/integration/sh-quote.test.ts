// A real shell reads a quoted path back as the path: the quoting is only right if a shell agrees.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { pasteablePath } from '@shared/sh-quote'

describe('pasteablePath', () => {
  it.each(['/bin/bash', '/bin/zsh'])('reads back as the same path in %s', (shell) => {
    const paths = [
      "/tmp/it's a b.png",
      '/tmp/a\nb.png',
      "/tmp/back\\slash'\x1b.png",
      '/tmp/$(whoami) `date`.png'
    ]

    for (const path of paths) {
      const read = execFileSync(shell, ['-c', `printf %s ${pasteablePath(path)}`], {
        encoding: 'utf8'
      })

      expect(read).toBe(path)
    }
  })
})
