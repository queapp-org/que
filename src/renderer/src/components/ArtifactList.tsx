import { useRef } from 'react'
import type { Artifact } from '../../../preload/index.d'
import { isArtifactUrl } from '../../../shared/artifact-url'
import { formatAge } from '../../../shared/format'
import { useQueSelector, useStore } from '../store'
import { useNow } from '../useNow'
import { CopyIcon, ExternalLinkIcon } from './icons'

function Row({
  wsId,
  artifact,
  now
}: {
  wsId: string
  artifact: Artifact
  now: number
}): React.JSX.Element {
  const store = useStore()
  const link = useRef<HTMLAnchorElement>(null)
  const { url, title, updatedAt, openedAt } = artifact
  const opened = openedAt !== null
  const id = `artifact-${url.slice(url.lastIndexOf('/') + 1)}`

  return (
    <li className={`artifact${opened ? ' opened' : ''}`} data-testid={id} data-opened={opened}>
      <div className="artifact-line">
        <a
          ref={link}
          className="artifact-name"
          href={url}
          target="_blank"
          rel="noreferrer"
          data-testid={`${id}-link`}
          onClick={() => store.artifactOpened(wsId, url)}
        >
          {title}
        </a>
        <button
          type="button"
          className="ghost icon sm artifact-copy"
          aria-label="Copy link"
          title="Copy link"
          data-testid={`${id}-copy`}
          onClick={() => void navigator.clipboard.writeText(url).catch(() => {})}
        >
          <CopyIcon />
        </button>
        <span className="artifact-gap" />
        <span
          className="artifact-age"
          title={`Updated ${new Date(updatedAt).toLocaleString()}`}
          data-testid={`${id}-age`}
          onClick={() => link.current?.click()}
        >
          {formatAge(updatedAt, now)}
        </span>
        <span className="artifact-out">
          <ExternalLinkIcon />
        </span>
      </div>
    </li>
  )
}

/**
 * The pages the session published, in the review pane, newest update first. A row opens its page
 * in the browser, and only a URL of a published page's shape gets a row: a hook payload wrote it.
 */
export default function ArtifactList({ termKey }: { termKey: string }): React.JSX.Element {
  const ws = useQueSelector((s) => s.workspaces[termKey])
  const now = useNow()
  const artifacts = ws?.artifacts.filter((a) => isArtifactUrl(a.url)) ?? []

  if (!ws || artifacts.length === 0) {
    return (
      <section className="artifact-list" data-testid="artifact-list" aria-label="Artifacts">
        <p className="review-empty-note" data-testid="artifact-empty">
          No artifacts from this session yet.
        </p>
      </section>
    )
  }

  return (
    <section className="artifact-list" data-testid="artifact-list" aria-label="Artifacts">
      <header className="review-head">
        <h2 className="label">[ Artifacts ]</h2>
        <span className="review-sum" data-testid="artifact-list-summary">
          {artifacts.length} published
        </span>
      </header>
      <ul className="artifact-rows">
        {artifacts.map((a) => (
          <Row key={a.url} wsId={ws.id} artifact={a} now={now} />
        ))}
      </ul>
    </section>
  )
}
