import type { ComponentPropsWithoutRef } from 'react'

type Props = Omit<ComponentPropsWithoutRef<'span'>, 'className' | 'children'> & {
  /** `accent` (the default) while a session works; `neutral` while a workspace is being prepared or removed. */
  tone?: 'accent' | 'neutral'
}

/**
 * The working mark: four dots on a 2×2 grid with a diagonal ripple, CSS only
 * (`.working-mark` in styles.css). The sidebar and the quiet board draw it in the accent in
 * place of a status dot while something works, and the sidebar, the workspace card and the
 * preparing pane draw it in the neutral tone while a workspace is being prepared or removed.
 * Any other props land on the span.
 */
export default function WorkingMark({ tone = 'accent', ...props }: Props): React.JSX.Element {
  return (
    <span className={tone === 'neutral' ? 'working-mark neutral' : 'working-mark'} {...props}>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
