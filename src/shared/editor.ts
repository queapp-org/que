// Opening a workspace's folder in the editor app (editor_app) for the app and
// the CLI. `open -a` takes the app by its path, so nothing is looked up on PATH
// but `open` itself, and it returns once the app has the folder. Node-only: the
// renderer never imports this.
import fs from 'node:fs'
import { editorName } from './editor-name'
import { firstLine, run } from './exec'

/** Opens `path` in the application bundle `app`; rejects with a sentence that says what went wrong. */
export async function openWithEditor(app: string, path: string): Promise<void> {
  const name = editorName(app)

  const there = await fs.promises.stat(app).then(
    (s) => s.isDirectory(),
    () => false
  )

  if (!there) {
    throw new Error(`${name} is no longer at ${app}. Choose another editor in que's Settings.`)
  }

  const r = await run('open', ['-a', app, path], { timeoutMs: 30_000 })

  if (!r.ok) throw new Error(`Could not open ${path} in ${name}: ${firstLine(r.stderr, r.error)}`)
}
