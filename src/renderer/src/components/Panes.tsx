import { useEffect, useRef, useState } from 'react'
import { basename } from '../diff'
import { clampRatio } from '../layout'
import {
  diffOf,
  filePathOf,
  prOfDiff,
  RATIO_DEFAULT,
  RATIO_MAX,
  RATIO_MIN,
  usePanes,
  useQueSelector,
  useStore
} from '../store'
import { tabLabel } from '../format'
import { optionAsMeta } from '../terminal-keys'
import { setPaneSource } from '../testHook'
import DiffView from './DiffView'
import FileView from './FileView'
import {
  DiffIcon,
  FileIcon,
  JoinPanesIcon,
  PlusIcon,
  SplitBelowIcon,
  SplitBesideIcon
} from './icons'
import Terminal from './Terminal'

const STEP = 0.05

/** The grid track sizes of a split at this ratio: first pane, divider, second pane. */
function paneTemplate(ratio: number): string {
  return `${ratio}fr 7px ${Math.round((1 - ratio) * 1000) / 1000}fr`
}

/**
 * The divider between two panes. Drag it to resize, double-click it to go back
 * to an even split, or focus it and use the arrow keys. A drag resizes the grid
 * directly and hands the ratio over once, on release.
 */
export function PaneDivider({
  direction,
  ratio,
  onChange
}: {
  direction: 'row' | 'column'
  ratio: number
  onChange: (ratio: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)
  const [live, setLive] = useState<number | null>(null)
  const row = direction === 'row'

  const apply = (e: React.PointerEvent<HTMLHRElement>): number | null => {
    const grid = dragging.current ? e.currentTarget.parentElement : null
    const box = grid?.getBoundingClientRect()
    const size = row ? box?.width : box?.height

    if (!grid || !box || !size) return null
    const next = clampRatio((row ? e.clientX - box.left : e.clientY - box.top) / size)

    grid.style[row ? 'gridTemplateColumns' : 'gridTemplateRows'] = paneTemplate(next)
    setLive(next)

    return next
  }

  const end = (e: React.PointerEvent<HTMLHRElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    setLive(null)

    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    document.body.classList.remove('resizing')
  }

  return (
    <hr
      className={`pane-divider ${direction}`}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuemin={Math.round(RATIO_MIN * 100)}
      aria-valuemax={Math.round(RATIO_MAX * 100)}
      aria-valuenow={Math.round((live ?? ratio) * 100)}
      tabIndex={0}
      data-testid="pane-divider"
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        dragging.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => void apply(e)}
      onPointerUp={(e) => {
        // The last move can be coalesced away under load; the release point is final.
        const next = apply(e) ?? live
        end(e)

        if (next !== null) onChange(next)
      }}
      onPointerCancel={(e) => {
        const next = live
        end(e)

        // A cancelled drag keeps where it got to, as a drag whose every move was applied did.
        if (next !== null) onChange(next)
      }}
      onDoubleClick={() => onChange(RATIO_DEFAULT)}
      onKeyDown={(e) => {
        const back = row ? 'ArrowLeft' : 'ArrowUp'
        const forward = row ? 'ArrowRight' : 'ArrowDown'

        const next =
          e.key === back
            ? ratio - STEP
            : e.key === forward
              ? ratio + STEP
              : e.key === 'Home'
                ? RATIO_MIN
                : e.key === 'End'
                  ? RATIO_MAX
                  : null

        if (next === null) return
        e.preventDefault()
        onChange(next)
      }}
    />
  )
}

/**
 * Split or join: the main column's top-right corner, at the right end of the top-right
 * pane's tab strip.
 */
function PaneControls({ termKey }: { termKey: string }): React.JSX.Element {
  const store = usePanes(termKey)
  const connected = useQueSelector((s) => s.connected)
  const split = Boolean(store.layout(termKey).split)

  return (
    <div className="pane-controls" data-testid="pane-controls">
      {split ? (
        <button
          type="button"
          className="ghost icon"
          aria-label="Join panes"
          title="Join panes: the second pane's tabs move to the first"
          data-testid="topbar-join"
          disabled={!connected}
          onClick={() => store.joinPanes(termKey)}
        >
          <JoinPanesIcon />
        </button>
      ) : (
        <>
          <button
            type="button"
            className="ghost icon"
            aria-label="Split beside"
            title="Split beside (⌘D)"
            data-testid="topbar-split-beside"
            disabled={!connected}
            onClick={() => void store.splitPane(termKey, 'row')}
          >
            <SplitBesideIcon />
          </button>
          <button
            type="button"
            className="ghost icon"
            aria-label="Split below"
            title="Split below (⌘⇧D)"
            data-testid="topbar-split-below"
            disabled={!connected}
            onClick={() => void store.splitPane(termKey, 'column')}
          >
            <SplitBelowIcon />
          </button>
        </>
      )}
    </div>
  )
}

function Pane({
  termKey,
  index,
  controls
}: {
  termKey: string
  index: 0 | 1
  /** This pane's strip is the main column's top-right corner, so the split buttons go here. */
  controls: boolean
}): React.JSX.Element {
  const store = usePanes(termKey)
  const connected = useQueSelector((s) => s.connected)
  const connection = useQueSelector((s) => s.connection)
  const error = useQueSelector((s) => s.error)
  const tabs = store.paneTabs(termKey, index)
  const views = store.paneViews(termKey, index)
  const activeId = store.paneActiveId(termKey, index)
  const active = store.paneActive(termKey, index)
  const activeDiff = diffOf(activeId)
  const activeFile = filePathOf(activeId)
  const prs = useQueSelector((s) => s.workspaces[termKey]?.prs)
  const focused = store.focusedPane(termKey) === index
  const optionMeta = useQueSelector((s) => optionAsMeta(s.config?.config))

  return (
    <div
      className="pane"
      data-testid={`pane-${index}`}
      data-focused={focused}
      data-active-term={active?.id ?? ''}
      data-active-tab={activeId ?? ''}
      onPointerDownCapture={() => store.focusPane(termKey, index)}
    >
      <div className="tabbar" data-testid={`pane-${index}-tabbar`}>
        <div className="tabs" role="tablist" aria-label="Tabs">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`tab${t.id === active?.id ? ' active' : ''}${t.alive ? '' : ' exited'}`}
              data-testid={`terminal-tab-${t.id}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.id === active?.id}
                data-term-id={t.id}
                data-testid={`terminal-tab-${t.id}-select`}
                title={[t.cwd, t.title, t.id.slice(0, 4)].filter(Boolean).join('\n')}
                onClick={() => store.selectTerminal(termKey, t.id)}
              >
                {/* An exited terminal's program reads faint; the testid marks it for the specs. */}
                <span
                  className="tab-name"
                  data-testid={t.alive ? undefined : `terminal-tab-${t.id}-exited`}
                >
                  {tabLabel(t)}
                </span>
                {t.reattached && (
                  <span className="badge" data-testid={`terminal-tab-${t.id}-reattached`}>
                    reattached
                  </span>
                )}
              </button>
              <button
                type="button"
                className="close"
                aria-label={`Close ${tabLabel(t)}`}
                data-testid={`terminal-tab-${t.id}-close`}
                onClick={() => void store.closeTerminal(t.id)}
              >
                ×
              </button>
            </span>
          ))}
          {views.map((id) => {
            const filePath = filePathOf(id)
            const diff = diffOf(id)
            // A pull request's diff of the file: the tab says which.
            const inPr = prOfDiff(prs ?? [], diff?.against)
            const kind = filePath === null ? 'diff' : 'file'
            const path = filePath ?? diff?.path ?? id
            const label = basename(path)
            const selected = id === activeId

            return (
              <span
                key={id}
                className={`tab view-tab${selected ? ' active' : ''}`}
                data-testid={`view-tab-${kind}`}
                data-path={path}
                data-pr={inPr?.number}
                data-active={selected}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={inPr ? `#${inPr.number} · ${path}` : path}
                  data-testid={`view-tab-${kind}-select`}
                  data-path={path}
                  data-pr={inPr?.number}
                  onClick={() => store.selectTerminal(termKey, id)}
                >
                  {kind === 'file' ? <FileIcon /> : <DiffIcon />}
                  {label}
                </button>
                <button
                  type="button"
                  className="close"
                  aria-label={`Close ${label}`}
                  data-testid={`view-tab-${kind}-close`}
                  data-path={path}
                  data-pr={inPr?.number}
                  onClick={() => store.closeView(termKey, id)}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
        <button
          type="button"
          className="ghost icon new-tab"
          aria-label="New terminal"
          title="New terminal (⌘T)"
          data-testid={`pane-${index}-new`}
          disabled={!connected}
          onClick={() => {
            store.focusPane(termKey, index)
            void store.newTerminal(termKey)
          }}
        >
          <PlusIcon />
        </button>
        {controls && <PaneControls termKey={termKey} />}
      </div>
      {activeDiff !== null ? (
        <DiffView
          key={activeId}
          termKey={termKey}
          path={activeDiff.path}
          against={activeDiff.against}
        />
      ) : activeFile !== null ? (
        <FileView key={activeFile} termKey={termKey} path={activeFile} />
      ) : active ? (
        // An inactive tab's terminal is detached; it reattaches (and replays) when selected.
        // A reconnect (a new `connection`) attaches it again.
        <Terminal
          key={`${active.id}:${connection}`}
          id={active.id}
          focused={focused}
          optionAsMeta={optionMeta}
        />
      ) : (
        <div className="empty" data-testid="terminal-empty">
          {tabs.length === 0 && !error ? 'No terminals. Press + to open one.' : ''}
        </div>
      )}
    </div>
  )
}

/** One workspace's (or the loose sessions') terminals, in one pane or two. */
export default function Panes({ termKey }: { termKey: string }): React.JSX.Element {
  const store = useStore()
  const layout = useQueSelector((s) => s.layouts[termKey]) ?? store.layout(termKey)
  const split = layout.split

  // Tell the e2e test hook where the panes are.
  useEffect(() => {
    setPaneSource(() => {
      const count = store.layout(termKey).split ? 2 : 1
      const focused = store.focusedPane(termKey)

      return Array.from({ length: count }, (_, index) => ({
        index,
        activeTermId: store.paneActive(termKey, index as 0 | 1)?.id ?? null,
        activeTab: store.paneActiveId(termKey, index as 0 | 1),
        focused: focused === index
      }))
    })

    return () => setPaneSource(null)
  }, [store, termKey])

  const template = split ? paneTemplate(split.ratio) : undefined

  const style = split
    ? split.direction === 'row'
      ? { gridTemplateColumns: template }
      : { gridTemplateRows: template }
    : undefined

  return (
    <div
      className="panes"
      data-testid="panes"
      data-split={split ? split.direction : 'none'}
      data-ratio={split?.ratio}
      style={style}
    >
      {/* Beside, the second pane's strip is the top-right one; below (or alone), the first's. */}
      <Pane termKey={termKey} index={0} controls={split?.direction !== 'row'} />
      {split && (
        <>
          <PaneDivider
            direction={split.direction}
            ratio={split.ratio}
            onChange={(r) => store.setRatio(termKey, r)}
          />
          <Pane termKey={termKey} index={1} controls={split.direction === 'row'} />
        </>
      )}
    </div>
  )
}
