// What a drop on a terminal means: files become their quoted paths, and anything else is nothing.
import { pasteablePaths } from '../../shared/sh-quote'

/** The drag carries files, as opposed to dragged text or a link. */
export function isFileDrag(data: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(data.types).includes('Files')
}

/** The text a drop pastes: its files' quoted paths, or null when it holds no file on disk. */
export function droppedText(
  data: Pick<DataTransfer, 'files'>,
  pathOf: (file: File) => string
): string | null {
  const paths = Array.from(data.files, pathOf).filter((path) => path !== '')

  return paths.length > 0 ? pasteablePaths(paths) : null
}
