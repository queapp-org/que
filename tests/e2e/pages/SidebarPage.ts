// Sessions (loose terminals) above projects → workspaces with their status dots
// (`data-status`, `data-unseen`) and the word under the pointer, the foot (the Quiet row,
// or the unlock row in its place, with Update at its right end, over the icon strip of
// Report, Tickets and Settings, and Claude usage at its right end with the card it opens),
// the project context menu, and the new-workspace and
// remove-project and remove-workspace dialogs, a preparing or removing row's step word, and the card a workspace row opens under a resting pointer.
import { expect, type Locator, type Page } from '@playwright/test'

export class SidebarPage {
  page: Page
  root: Locator
  resizer: Locator
  search: Locator
  searchToggle: Locator
  sortButton: Locator
  sessionsNoMatch: Locator
  projectsNoMatch: Locator
  emptyState: Locator
  addProjectButton: Locator
  sessionsAdd: Locator
  session: (id: string) => Locator
  sessionOpen: (id: string) => Locator
  sessionExited: (id: string) => Locator
  foot: Locator
  footRow: Locator
  quietButton: Locator
  quietLength: (minutes: number) => Locator
  daemonUpdate: Locator
  unlockRow: Locator
  unlockCountdown: Locator
  lockButton: Locator
  strip: Locator
  reportButton: Locator
  ticketsButton: Locator
  settingsButton: Locator
  usageButton: Locator
  usageFiveHour: Locator
  usageWeekly: Locator
  usageCard: Locator
  usageCardFiveHour: Locator
  usageCardWeekly: Locator
  usageCardAsOf: Locator
  newWorkspaceDialog: Locator
  newWorkspaceBrief: Locator
  newWorkspaceStart: Locator
  newWorkspaceName: Locator
  newWorkspaceNewName: Locator
  newWorkspaceSlug: Locator
  newWorkspaceSubmit: Locator
  removeProjectDialog: Locator
  removeProjectSubmit: Locator
  removeWorkspaceDialog: Locator
  removeWorkspaceDeleteBranch: Locator
  removeWorkspaceSubmit: Locator
  project: (id: string) => Locator
  projectToggle: (id: string) => Locator
  projectMenuRemove: (id: string) => Locator
  projectActions: (id: string) => Locator
  projectStart: (id: string) => Locator
  projectMenu: (id: string) => Locator
  projectMenuNewWorkspace: (id: string) => Locator
  projectCount: (id: string) => Locator
  workspace: (id: string) => Locator
  workspaceOpen: (id: string) => Locator
  workspaceName: (id: string) => Locator
  workspaceStatus: (id: string) => Locator
  workspaceReveal: (id: string) => Locator
  workspaceWord: (id: string) => Locator
  workspaceMenu: (id: string) => Locator
  workspaceMenuRemove: (id: string) => Locator
  workspaceStep: (id: string) => Locator
  workspacePopout: (id: string) => Locator
  workspacePopoutPath: (id: string) => Locator
  workspacePopoutBranch: (id: string) => Locator
  workspacePopoutStatus: (id: string) => Locator
  workspacePopoutPr: (id: string, n: number) => Locator
  workspacePopoutPrState: (id: string, n: number) => Locator
  workspacePopoutPrDiff: (id: string, n: number) => Locator
  workspacePopoutPrTitle: (id: string, n: number) => Locator
  workspacePopoutPrLink: (id: string, n: number) => Locator

  constructor(page: Page) {
    this.page = page
    this.root = page.getByTestId('sidebar')
    this.resizer = page.getByTestId('sidebar-resizer')
    this.search = page.getByTestId('sidebar-search')
    this.searchToggle = page.getByTestId('sidebar-search-toggle')
    this.sortButton = page.getByTestId('sidebar-sort')
    this.sessionsNoMatch = page.getByTestId('sidebar-sessions-nomatch')
    this.projectsNoMatch = page.getByTestId('sidebar-projects-nomatch')
    this.emptyState = page.getByTestId('sidebar-empty')
    this.addProjectButton = page.getByTestId('sidebar-add-project')
    this.sessionsAdd = page.getByTestId('sidebar-sessions-add')
    this.session = (id: string) => page.getByTestId(`sidebar-session-${id}`)
    this.sessionOpen = (id: string) => page.getByTestId(`sidebar-session-${id}-open`)
    this.sessionExited = (id: string) => page.getByTestId(`sidebar-session-${id}-exited`)
    this.foot = page.getByTestId('sidebar-bottom')
    this.footRow = page.getByTestId('sidebar-foot-row')
    this.quietButton = page.getByTestId('sidebar-quiet')
    this.quietLength = (minutes: number) => page.getByTestId(`sidebar-quiet-${minutes}`)
    this.daemonUpdate = page.getByTestId('sidebar-daemon-update')
    this.unlockRow = page.getByTestId('sidebar-unlock')
    this.unlockCountdown = page.getByTestId('sidebar-unlock-countdown')
    this.lockButton = page.getByTestId('sidebar-lock')
    // The icon strip: each view's icon, `aria-current="page"` while its view is open.
    this.strip = page.getByTestId('sidebar-strip')
    this.reportButton = page.getByTestId('sidebar-report')
    this.ticketsButton = page.getByTestId('sidebar-tickets')
    this.settingsButton = page.getByTestId('sidebar-settings')
    // The strip's right end: Claude usage (`5h 42%  wk 18%`) and the card a click opens.
    this.usageButton = page.getByTestId('sidebar-usage')
    this.usageFiveHour = page.getByTestId('sidebar-usage-five-hour')
    this.usageWeekly = page.getByTestId('sidebar-usage-weekly')
    this.usageCard = page.getByTestId('sidebar-usage-card')
    this.usageCardFiveHour = page.getByTestId('sidebar-usage-card-five-hour')
    this.usageCardWeekly = page.getByTestId('sidebar-usage-card-weekly')
    this.usageCardAsOf = page.getByTestId('sidebar-usage-card-as-of')
    this.newWorkspaceDialog = page.getByTestId('dialog-new-workspace')
    this.newWorkspaceBrief = page.getByTestId('dialog-new-workspace-brief')
    this.newWorkspaceStart = page.getByTestId('dialog-new-workspace-start')
    this.newWorkspaceName = page.getByTestId('dialog-new-workspace-name')
    this.newWorkspaceNewName = page.getByTestId('dialog-new-workspace-new-name')
    this.newWorkspaceSlug = page.getByTestId('dialog-new-workspace-slug')
    this.newWorkspaceSubmit = page.getByTestId('dialog-new-workspace-submit')
    this.removeProjectDialog = page.getByTestId('dialog-remove-project')
    this.removeProjectSubmit = page.getByTestId('dialog-remove-project-submit')
    this.removeWorkspaceDialog = page.getByTestId('dialog-remove-workspace')
    this.removeWorkspaceDeleteBranch = page.getByTestId('dialog-remove-workspace-delete-branch')
    this.removeWorkspaceSubmit = page.getByTestId('dialog-remove-workspace-submit')
    this.project = (id: string) => page.getByTestId(`sidebar-project-${id}`)
    this.projectToggle = (id: string) => page.getByTestId(`sidebar-project-${id}-toggle`)
    this.projectMenuRemove = (id: string) => page.getByTestId(`sidebar-project-${id}-menu-remove`)
    // The head's buttons, under the pointer: the character (one click to a Claude session) and ⋯.
    this.projectActions = (id: string) => page.getByTestId(`sidebar-project-${id}-actions`)
    this.projectStart = (id: string) => page.getByTestId(`sidebar-project-${id}-start`)
    this.projectMenu = (id: string) => page.getByTestId(`sidebar-project-${id}-menu`)
    this.projectMenuNewWorkspace = (id: string) =>
      page.getByTestId(`sidebar-project-${id}-menu-new-workspace`)
    this.projectCount = (id: string) => page.getByTestId(`sidebar-project-${id}-count`)
    this.workspace = (id: string) => page.getByTestId(`sidebar-workspace-${id}`)
    this.workspaceOpen = (id: string) => page.getByTestId(`sidebar-workspace-${id}-open`)
    this.workspaceName = (id: string) => page.getByTestId(`sidebar-workspace-${id}-name`)
    this.workspaceStatus = (id: string) => page.getByTestId(`sidebar-workspace-${id}-status`)
    // The row's overlay (the status word, then ⋯): opacity 1 only under the pointer or focus.
    this.workspaceReveal = (id: string) => page.getByTestId(`sidebar-workspace-${id}-reveal`)
    this.workspaceWord = (id: string) => page.getByTestId(`sidebar-workspace-${id}-word`)
    this.workspaceMenu = (id: string) => page.getByTestId(`sidebar-workspace-${id}-menu`)
    this.workspaceMenuRemove = (id: string) =>
      page.getByTestId(`sidebar-workspace-${id}-menu-remove`)
    // While the workspace is prepared or removed: its step and the clock since it started, always shown.
    this.workspaceStep = (id: string) => page.getByTestId(`sidebar-workspace-${id}-step`)
    // The card beside a row: opens once the pointer rests on the row.
    this.workspacePopout = (id: string) => page.getByTestId(`sidebar-workspace-${id}-popout`)
    this.workspacePopoutPath = (id: string) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-path`)
    this.workspacePopoutBranch = (id: string) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-branch`)
    this.workspacePopoutStatus = (id: string) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-status`)
    this.workspacePopoutPr = (id: string, n: number) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-pr-${n}`)
    this.workspacePopoutPrState = (id: string, n: number) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-pr-${n}-state`)
    this.workspacePopoutPrDiff = (id: string, n: number) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-pr-${n}-diff`)
    this.workspacePopoutPrTitle = (id: string, n: number) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-pr-${n}-title`)
    this.workspacePopoutPrLink = (id: string, n: number) =>
      page.getByTestId(`sidebar-workspace-${id}-popout-pr-${n}-link`)
  }

  async waitForLoad() {
    await this.root.waitFor({ state: 'visible' })
    await Promise.race([
      this.page
        .getByTestId(/^sidebar-project-/)
        .first()
        .waitFor({ state: 'visible' })
        .catch(() => {}),
      this.emptyState.waitFor({ state: 'visible' }).catch(() => {})
    ])
  }

  // Waits for a row's dot (or working mark), naming the workspace and the last status seen on failure.
  async waitForWorkspaceStatus(id: string, status: string, timeout = 30_000) {
    const badge = this.workspaceStatus(id)
    await badge.waitFor({ state: 'visible', timeout })
    await expect(badge, `workspace ${id} never reached ${status}`).toHaveAttribute(
      'data-status',
      status,
      { timeout }
    )
  }
}
