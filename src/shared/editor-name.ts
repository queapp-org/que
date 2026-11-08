// The editor app's name as people read it. No Node imports, so the renderer can use it.

/** An application bundle's file name without `.app`: `/Applications/Editor.app` is `Editor`. */
export function editorName(app: string): string {
  const base = app.replace(/\/+$/, '').split('/').pop() ?? ''

  return base.replace(/\.app$/i, '') || app
}
