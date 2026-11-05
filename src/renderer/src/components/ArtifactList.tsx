import type { Artifact } from '../../../preload/index.d'
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
  const { url, title, updatedAt, openedAt } = artifact
  const opened = openedAt !== null
  const id = `artifact-${url.slice(url.lastIndexOf('/') + 1)}`

  return (
    <li className={`artifact${opened ? ' opened' : ''}`} data-testid={id} data-opened={opened}>
      <a
        className="artifact-name"
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${title}\nUpdated ${new Date(updatedAt).toLocaleString()}`}
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
      <span className="artifact-age" data-testid={`${id}-age`}>
        {formatAge(updatedAt, now)}
      </span>
      <span className="artifact-out">
        <ExternalLinkIcon />
      </span>
    </li>
  )
}

/** The pages the session published, in the review pane, newest update first. A row opens its page in the browser. */
export default function ArtifactList({ termKey }: { termKey: string }): React.JSX.Element {
  const artifacts = useQueSelector((s) => s.workspaces[termKey]?.artifacts) ?? []
  const now = useNow()

  return (
    <section className="artifact-list" data-testid="artifact-list" aria-label="Artifacts">
      {artifacts.length === 0 ? (
        <p className="review-empty-note" data-testid="artifact-empty">
          No artifacts from this session yet.
        </p>
      ) : (
        <>
          <header className="review-head">
            <h2 className="label">[ Artifacts ]</h2>
            <span className="review-sum" data-testid="artifact-list-summary">
              {artifacts.length} published
            </span>
          </header>
          <ul className="artifact-rows">
            {artifacts.map((a) => (
              <Row key={a.url} wsId={termKey} artifact={a} now={now} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
