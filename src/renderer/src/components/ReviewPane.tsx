import { useEffect, useState } from 'react'
import { prCounts } from '../pr-list'
import { isPreparing, isWorkspace, type ReviewView, useQueSelector, useStore } from '../store'
import ArtifactList from './ArtifactList'
import ChangesList from './ChangesList'
import FilesTree from './FilesTree'
import {
  ArtifactsIcon,
  ChangesIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  EditorIcon,
  FolderIcon,
  PullRequestIcon
} from './icons'
import PullRequestDetail from './PullRequestDetail'
import PullRequestList from './PullRequestList'
import RefreshButton from './RefreshButton'

const VIEWS: ReadonlyArray<{ view: ReviewView; name: string; Icon: () => React.JSX.Element }> = [
  { view: 'prs', name: 'Pull requests', Icon: PullRequestIcon },
  { view: 'changes', name: 'Changes', Icon: ChangesIcon },
  { view: 'files', name: 'Files', Icon: FolderIcon },
  { view: 'artifacts', name: 'Artifacts', Icon: ArtifactsIcon }
]

/**
 * Each view's count beside (or, on the rail, under) its icon: the open pull requests, the changed
 * files, the published pages.
 */
function useViewCounts(termKey: string): Record<ReviewView, number | undefined> {
  const prs = useQueSelector((s) => {
    const ws = s.workspaces[termKey]

    return ws ? prCounts(ws.prs).open : undefined
  })

  const changes = useQueSelector((s) => s.diffs[termKey]?.data?.files.length)

  const artifacts = useQueSelector((s) => s.workspaces[termKey]?.artifacts.length)

  return { prs, changes, files: undefined, artifacts }
}

/** A view's icon with its count, in the pane's strip or on the rail; each lays it out. */
function ViewButton({
  name,
  Icon,
  count,
  testId,
  className,
  ...button
}: {
  name: string
  Icon: () => React.JSX.Element
  count: number | undefined
  testId: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      className={`ghost icon ${className}`}
      aria-label={name}
      title={name}
      data-testid={testId}
      {...button}
    >
      <Icon />
      {count !== undefined && (
        <span className="review-view-count" data-testid={`${testId}-count`}>
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * The review pane folded: a 40px column in its place with the show chevron in the strip row,
 * then the view icons stacked, each with its count under it. A view icon opens the pane on it.
 */
export function ReviewRail({ termKey }: { termKey: string }): React.JSX.Element {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const counts = useViewCounts(termKey)

  return (
    <aside className="review-rail" data-testid="review-rail" aria-label="Review">
      <div className="review-rail-top">
        <button
          type="button"
          className="ghost icon"
          aria-label="Show review"
          title="Show review (⌘B)"
          data-testid="review-show"
          disabled={!connected}
          onClick={() => store.openReview()}
        >
          <ChevronsLeftIcon />
        </button>
      </div>
      {VIEWS.map(({ view, name, Icon }) => (
        <ViewButton
          key={view}
          name={name}
          Icon={Icon}
          count={counts[view]}
          testId={`review-rail-${view}`}
          className="review-rail-view"
          disabled={!connected}
          onClick={() => store.showReview(termKey, view)}
        />
      ))}
    </aside>
  )
}

/**
 * The review pane at the right of the main area. Four icons in its strip pick the view: the
 * session's pull requests, the worktree's changes, the project's files, or the pages the session
 * published; a pull request opens in place, and the strip's left end becomes its back link. The
 * view's own buttons sit at the strip's right end, then the hide chevron. The pane remembers its
 * view per workspace.
 */
export default function ReviewPane({ termKey }: { termKey: string }): React.JSX.Element {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const ws = useQueSelector((s) => s.workspaces[termKey])
  const counts = useViewCounts(termKey)
  // Read for the re-render; the place itself comes from the store's rule.
  useQueSelector((s) => s.review)
  const place = store.reviewPlace(termKey)
  const [filterFocus, setFilterFocus] = useState(0)
  const workspace = useQueSelector((s) => isWorkspace(s, termKey))
  // Until its preparation has finished there is no worktree to read.
  const preparing = useQueSelector((s) => isPreparing(s, termKey))

  const pr =
    place.view === 'prs' && place.pr !== null
      ? ws?.prs.find((p) => p.number === place.pr)
      : undefined

  const numbers = ws?.prs.map((p) => p.number).join(',')

  // Whatever the view shows, unless it is loaded or on its way.
  useEffect(() => {
    store.ensureReview(termKey)
  }, [store, termKey, place.view, place.pr, numbers])

  const refreshes: Record<ReviewView, (() => Promise<void>) | null> = {
    prs: () => store.refreshPrs(termKey),
    changes: () => store.fetchDiff(termKey),
    files: () => store.refreshFiles(termKey),
    // Hook events keep the list current: nothing polls, so there is nothing to refresh.
    artifacts: null
  }

  const refresh = refreshes[place.view]

  // ⌘F while the pane has focus: the Files view's filter.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!workspace || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return

    if (e.key.toLowerCase() !== 'f') return
    e.preventDefault()

    if (place.view !== 'files') store.setReviewView(termKey, 'files')
    setFilterFocus((n) => n + 1)
  }

  const testId = place.view === 'prs' ? 'pr' : place.view

  return (
    <aside
      className="review"
      data-testid="review-pane"
      data-view={place.view}
      data-pr={pr?.number}
      aria-label="Review"
      onKeyDown={onKeyDown}
    >
      <div className="review-bar" data-testid="review-bar">
        {pr ? (
          <button
            type="button"
            className="ghost review-back"
            aria-label="Back to pull requests"
            title="Back to pull requests"
            data-testid="review-back"
            onClick={() => store.closePullRequest(termKey)}
          >
            ‹ <span className="review-back-number">#{pr.number}</span>
          </button>
        ) : (
          <div className="review-views" role="tablist" aria-label="Review">
            {VIEWS.map(({ view, name, Icon }) => (
              <ViewButton
                key={view}
                name={name}
                Icon={Icon}
                count={workspace ? counts[view] : undefined}
                testId={`review-view-${view}`}
                className="strip-view review-view"
                role="tab"
                aria-selected={place.view === view}
                onClick={() => store.setReviewView(termKey, view)}
              />
            ))}
          </div>
        )}
        <div className="review-actions">
          {ws && (
            <>
              {/* Each view and each pull request turns its own Refresh. */}
              {refresh && (
                <RefreshButton
                  key={`${termKey}:${place.view}:${pr?.number ?? ''}`}
                  testId={`${testId}-refresh`}
                  disabled={!connected || preparing}
                  onRefresh={refresh}
                />
              )}
              <button
                type="button"
                className="ghost icon"
                aria-label="Open in editor"
                title="Open in editor"
                data-testid={`${testId}-open-editor`}
                disabled={!connected || preparing}
                onClick={() => void store.openInEditor(ws.path)}
              >
                <EditorIcon />
              </button>
            </>
          )}
          <button
            type="button"
            className="ghost icon"
            aria-label="Hide review"
            title="Hide review (⌘B)"
            data-testid="review-hide"
            onClick={() => store.closeReview()}
          >
            <ChevronsRightIcon />
          </button>
        </div>
      </div>
      {!workspace ? (
        <p className="changes-note" data-testid="review-empty">
          No workspace
        </p>
      ) : preparing ? (
        <p className="changes-note" data-testid="review-preparing">
          Nothing to review yet.
        </p>
      ) : place.view === 'changes' ? (
        <ChangesList termKey={termKey} />
      ) : place.view === 'files' ? (
        <FilesTree termKey={termKey} focusFilter={filterFocus} />
      ) : place.view === 'artifacts' ? (
        <ArtifactList termKey={termKey} />
      ) : pr ? (
        <PullRequestDetail key={pr.number} termKey={termKey} number={pr.number} />
      ) : (
        <PullRequestList termKey={termKey} />
      )}
    </aside>
  )
}
