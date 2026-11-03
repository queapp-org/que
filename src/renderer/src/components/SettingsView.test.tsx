import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { hhmm } from '@shared/format'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeQuietState } from '@renderer/testing/fixtures'
import App from '../App'

/** A window an hour either side of now, and the quiet state the daemon reports for it. */
function tonight(): { start: string; end: string; state: ReturnType<typeof makeQuietState> } {
  const start = new Date(Date.now() - 3_600_000)
  const end = new Date(Date.now() + 3_600_000)
  start.setSeconds(0, 0)
  end.setSeconds(0, 0)

  return {
    start: hhmm(start.getTime()),
    end: hhmm(end.getTime()),
    // Unlocked: the main window (and so Settings) only shows during quiet hours then.
    state: makeQuietState({
      inQuietHours: true,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      unlockedUntil: new Date(Date.now() + 600_000).toISOString()
    })
  }
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(<App />)
  await user.click(await screen.findByRole('button', { name: 'Settings' }))

  return screen.findByTestId('settings-view')
}

/** Replaces a field's text by typing, as a person would, without leaving it. */
async function retype(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string
): Promise<void> {
  await user.clear(field)
  await user.type(field, text)
}

describe('SettingsView', () => {
  describe('rendering', () => {
    it('loads the config: quiet hours, per-day overrides, notifications, protected branches and the path', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        protectedBranches: ['main', 'release'],
        quietHours: {
          enabled: true,
          default: { start: '20:30', end: '06:45' },
          days: { friday: { start: '23:00', end: '09:00' }, saturday: 'none' },
          unlockMinutes: 15
        },
        notifications: {
          chimeOnComplete: false,
          chimeOnNeedsInput: true,
          chimeInManualQuiet: false,
          morningSummary: true
        }
      })

      await openSettings(user)

      expect(await screen.findByTestId('settings-quiet-start')).toHaveValue('20:30')
      expect(screen.getByTestId('settings-quiet-end')).toHaveValue('06:45')
      expect(screen.getByTestId('settings-quiet-enabled')).toBeChecked()
      expect(screen.getByTestId('settings-unlock-minutes')).toHaveValue(15)
      expect(screen.getByTestId('settings-day-friday-mode')).toHaveValue('custom')
      expect(screen.getByTestId('settings-day-friday-start')).toHaveValue('23:00')
      expect(screen.getByTestId('settings-day-saturday-mode')).toHaveValue('none')
      expect(screen.getByTestId('settings-day-monday-mode')).toHaveValue('inherit')
      expect(screen.getByTestId('settings-chime-complete')).not.toBeChecked()
      expect(screen.getByTestId('settings-chime-needs-input')).toBeChecked()
      expect(screen.getByTestId('settings-morning-summary')).toBeChecked()
      expect(screen.getByTestId('settings-protected-branches')).toHaveValue('main, release')
      expect(screen.getByTestId('settings-path')).toHaveTextContent(
        '/Users/dev/.config/que/config.toml'
      )
      expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
    })

    it('disables the controls while the daemon is unreachable', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const toggle = await screen.findByTestId('settings-chime-complete')
      expect(toggle).toBeEnabled()

      fakeBridge.disconnect()

      await waitFor(() => expect(toggle).toBeDisabled())
      expect(screen.getByTestId('settings-protected-branches')).toBeDisabled()
    })
  })

  describe('writing on change', () => {
    it('writes a checkbox as soon as it changes, with only its key, then shows Saved briefly', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-chime-complete'))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { notifications: { chimeOnComplete: false } }, applyTonight: false }
        ])
      })
      expect(await screen.findByTestId('settings-chime-complete-saved')).toHaveTextContent('Saved')
      await waitFor(
        () => {
          expect(screen.queryByTestId('settings-chime-complete-saved')).not.toBeInTheDocument()
        },
        { timeout: 4_000 }
      )
    })

    it('writes a typed number on blur, not per keystroke', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await retype(user, await screen.findByTestId('settings-unlock-minutes'), '30')
      expect(fakeBridge.configSetCalls()).toEqual([])
      await user.tab()

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { quietHours: { unlockMinutes: 30 } }, applyTonight: false }
        ])
      })
      expect(await screen.findByTestId('settings-unlock-minutes-saved')).toBeInTheDocument()
    })

    it('writes a typed number on Enter without submitting the form, and only once', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const poll = await screen.findByTestId('settings-tickets-poll')

      await retype(user, poll, '10')
      await user.keyboard('{Enter}')

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { jira: { pollMinutes: 10 } }, applyTonight: false }
        ])
      })
      expect(poll).toHaveFocus()
      expect(await screen.findByTestId('settings-tickets-poll-saved')).toBeInTheDocument()
      await user.tab()
      expect(fakeBridge.configSetCalls()).toHaveLength(1)
    })

    it('writes a textarea on blur, keeping Enter as a new line', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const prompt = await screen.findByTestId('settings-tickets-prompt')

      await retype(user, prompt, 'Plan first.{Enter}Then ask.')
      expect(fakeBridge.configSetCalls()).toEqual([])
      await user.tab()

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { jira: { startPrompt: 'Plan first.\nThen ask.' } }, applyTonight: false }
        ])
      })
    })

    it('writes the protected branches as a list on blur', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await retype(
        user,
        await screen.findByTestId('settings-protected-branches'),
        'main, release, hotfix'
      )
      await user.tab()

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { protectedBranches: ['main', 'release', 'hotfix'] }, applyTonight: false }
        ])
      })
    })

    it('shows Option as Meta from config and writes it on toggle', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({ terminal: { optionAsMeta: true } })
      await openSettings(user)
      const toggle = await screen.findByTestId('settings-option-as-meta')
      expect(toggle).toBeChecked()

      await user.click(toggle)

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { terminal: { optionAsMeta: false } }, applyTonight: false }
        ])
      })
    })

    it('shows the manual-quiet chime from config and writes it on toggle', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        notifications: {
          chimeOnComplete: true,
          chimeOnNeedsInput: false,
          chimeInManualQuiet: true,
          morningSummary: false
        }
      })
      await openSettings(user)

      const toggle = await screen.findByRole('checkbox', {
        name: /Chime when a session finishes during a manual quiet \(quiet hours stay silent\)/
      })

      expect(toggle).toBeChecked()

      await user.click(toggle)

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { notifications: { chimeInManualQuiet: false } }, applyTonight: false }
        ])
      })
      expect(toggle).not.toBeChecked()
    })

    it('writes nothing when a field is left unchanged', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-tickets-jql'))
      await user.tab()
      await user.click(screen.getByTestId('settings-chime-needs-input'))

      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
      expect(fakeBridge.configSetCalls()[0].patch).toEqual({
        notifications: { chimeOnNeedsInput: true }
      })
    })

    it('reverts a field to its saved value on Escape and writes nothing', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const site = await screen.findByTestId('settings-jira-site')

      await retype(user, site, 'team.example.net')
      await user.keyboard('{Escape}')

      expect(site).toHaveValue('')
      await user.tab()
      expect(fakeBridge.configSetCalls()).toEqual([])
    })

    it('writes the quiet window and per-day overrides, removing one set back to the default', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: '19:00', end: '07:00' },
          days: { saturday: 'none' },
          unlockMinutes: 20
        }
      })
      await openSettings(user)

      await retype(user, await screen.findByTestId('settings-quiet-start'), '20:00')
      await user.keyboard('{Enter}')
      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
      await user.selectOptions(screen.getByTestId('settings-day-saturday-mode'), 'inherit')
      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
      await user.selectOptions(screen.getByTestId('settings-day-monday-mode'), 'custom')
      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(3))
      await retype(user, screen.getByTestId('settings-day-monday-end'), '06:30')
      await user.tab()

      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(4))
      expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
        { quietHours: { default: { start: '20:00', end: '07:00' } } },
        { quietHours: { days: { saturday: null } } },
        { quietHours: { days: { monday: { start: '19:00', end: '07:00' } } } },
        { quietHours: { days: { monday: { start: '19:00', end: '06:30' } } } }
      ])
      expect(await screen.findByTestId('settings-day-monday-saved')).toBeInTheDocument()
    })
  })

  describe('refusing a value', () => {
    it('shows a bad number under its field, keeps the text, writes nothing, and other fields still save', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const unlock = await screen.findByTestId('settings-unlock-minutes')

      await retype(user, unlock, '0')
      await user.tab()

      expect(await screen.findByTestId('settings-unlock-minutes-error')).toHaveTextContent(
        'Unlock minutes must be a positive number'
      )
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Unlock minutes must be a positive number'
      )
      expect(unlock).toHaveValue(0)
      expect(fakeBridge.configSetCalls()).toEqual([])

      await user.click(screen.getByTestId('settings-morning-summary'))
      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { notifications: { morningSummary: true } }, applyTonight: false }
        ])
      })

      await retype(user, unlock, '25')
      await user.tab()
      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
      expect(fakeBridge.configSetCalls()[1].patch).toEqual({ quietHours: { unlockMinutes: 25 } })
      expect(screen.queryByTestId('settings-unlock-minutes-error')).not.toBeInTheDocument()
    })

    it('refuses a quiet window whose start and end are the same', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await retype(user, await screen.findByTestId('settings-quiet-end'), '19:00')
      await user.tab()

      expect(await screen.findByTestId('settings-quiet-end-error')).toHaveTextContent(
        'Start and end must differ'
      )
      expect(fakeBridge.configSetCalls()).toEqual([])
    })

    it("shows the daemon's refusal under the field and keeps the typed text", async () => {
      const user = userEvent.setup()
      fakeBridge.refuseConfigSet('jira.site: no site named "team.example.net"')
      await openSettings(user)
      const site = await screen.findByTestId('settings-jira-site')

      await retype(user, site, 'team.example.net')
      await user.tab()

      expect(await screen.findByTestId('settings-jira-site-error')).toHaveTextContent(
        'jira.site: no site named "team.example.net"'
      )
      expect(site).toHaveValue('team.example.net')
      expect(screen.queryByTestId('settings-jira-site-saved')).not.toBeInTheDocument()
      expect(fakeBridge.configSetCalls()).toEqual([])
    })

    it('writes one field in order, so a slow answer never lands after newer input', async () => {
      const user = userEvent.setup()
      await openSettings(user)
      const poll = await screen.findByTestId('settings-tickets-poll')
      fakeBridge.holdConfigSets()

      await retype(user, poll, '10')
      await user.tab()
      await retype(user, poll, '12')
      await user.tab()
      fakeBridge.releaseConfigSets()

      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
      expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
        { jira: { pollMinutes: 10 } },
        { jira: { pollMinutes: 12 } }
      ])
      expect(poll).toHaveValue(12)
    })
  })

  describe('fields sharing a config key', () => {
    it('writes quiet hours Start then End so the daemon ends up with both, even while the first is in flight', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: '22:00', end: '07:00' },
          days: {},
          unlockMinutes: 20
        }
      })
      await openSettings(user)
      fakeBridge.holdConfigSets()

      await retype(user, await screen.findByTestId('settings-quiet-start'), '21:15')
      await user.tab()
      await retype(user, screen.getByTestId('settings-quiet-end'), '06:30')
      await user.tab()
      fakeBridge.releaseConfigSets()

      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
      expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
        { quietHours: { default: { start: '21:15', end: '07:00' } } },
        { quietHours: { default: { start: '21:15', end: '06:30' } } }
      ])
      expect(fakeBridge.configFile()).toEqual({
        quiet_hours: { default: ['21:15', '06:30'] }
      })
      expect(screen.getByTestId('settings-quiet-start')).toHaveValue('21:15')
      expect(screen.getByTestId('settings-quiet-end')).toHaveValue('06:30')
    })
  })

  describe('apply tonight', () => {
    it("asks before a change that ends tonight's quiet hours early, and applies it tonight on Yes", async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-quiet-enabled'))

      const confirm = await screen.findByRole('region', { name: 'Apply tonight?' })
      expect(confirm).toHaveAttribute('data-testid', 'settings-apply-tonight-confirm')
      expect(fakeBridge.configSetCalls()).toEqual([])
      await user.click(within(confirm).getByRole('button', { name: 'Yes, tonight' }))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { quietHours: { enabled: false } }, applyTonight: true }
        ])
      })
      expect(screen.queryByTestId('settings-apply-tonight-confirm')).not.toBeInTheDocument()
      expect(await screen.findByTestId('settings-quiet-enabled-saved')).toBeInTheDocument()
    })

    it('saves for tomorrow on No', async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-quiet-enabled'))
      await user.click(await screen.findByRole('button', { name: 'No, from tomorrow' }))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          { patch: { quietHours: { enabled: false } }, applyTonight: false }
        ])
      })
    })

    it("does not ask for a change outside quiet hours, even during tonight's window", async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-chime-complete'))

      await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
      expect(screen.queryByTestId('settings-apply-tonight-confirm')).not.toBeInTheDocument()
    })
  })
})

describe('SettingsView new workspaces', () => {
  it('starts Claude on the brief by default', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    expect(await screen.findByTestId('settings-start-prompt-enabled')).not.toBeChecked()
    expect(screen.queryByTestId('settings-workspace-prompt')).not.toBeInTheDocument()
    expect(screen.getByText('Claude starts on the brief itself.')).toBeInTheDocument()
  })

  it('writes the suggested prompt when turned on, then an edit to it on blur', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    await user.click(await screen.findByTestId('settings-start-prompt-enabled'))
    const prompt = screen.getByTestId('settings-workspace-prompt')

    const suggestion =
      'Read .que/brief.md. Restate the goal, read the relevant code, and propose a plan before editing anything.'

    expect(prompt).toHaveValue(suggestion)
    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    await retype(user, prompt, 'Read .que/brief.md and ask before editing.')
    await user.tab()

    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
    expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
      { startPrompt: suggestion },
      { startPrompt: 'Read .que/brief.md and ask before editing.' }
    ])
  })

  it('writes the toggle and its prompt in order, so leaving the prompt unchanged mid-write sends nothing', async () => {
    const user = userEvent.setup()
    await openSettings(user)
    fakeBridge.holdConfigSets()

    await user.click(await screen.findByTestId('settings-start-prompt-enabled'))
    const prompt = screen.getByTestId('settings-workspace-prompt')
    await user.click(prompt)
    await user.tab()
    fakeBridge.releaseConfigSets()
    await retype(user, prompt, 'Plan from .que/brief.md first.')
    await user.tab()

    await waitFor(() => {
      expect(fakeBridge.configSetCalls().at(-1)?.patch).toEqual({
        startPrompt: 'Plan from .que/brief.md first.'
      })
    })
    expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
      {
        startPrompt:
          'Read .que/brief.md. Restate the goal, read the relevant code, and propose a plan before editing anything.'
      },
      { startPrompt: 'Plan from .que/brief.md first.' }
    ])
    expect(fakeBridge.configFile()).toEqual({
      start_prompt: 'Plan from .que/brief.md first.'
    })
  })

  it('loads a configured prompt turned on, and turning it off removes start_prompt', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig({ startPrompt: 'Read .que/brief.md, then plan.' })
    await openSettings(user)

    const toggle = await screen.findByTestId('settings-start-prompt-enabled')
    expect(toggle).toBeChecked()
    expect(screen.getByTestId('settings-workspace-prompt')).toHaveValue(
      'Read .que/brief.md, then plan.'
    )
    await user.click(toggle)

    await waitFor(() => {
      expect(fakeBridge.configSetCalls()).toEqual([
        { patch: { startPrompt: null }, applyTonight: false }
      ])
    })
    expect(await screen.findByTestId('settings-start-prompt-enabled-saved')).toBeInTheDocument()
  })

  it('refuses an empty start prompt while it is turned on', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig({ startPrompt: 'Read .que/brief.md, then plan.' })
    await openSettings(user)

    await user.clear(await screen.findByTestId('settings-workspace-prompt'))
    await user.tab()

    expect(await screen.findByTestId('settings-workspace-prompt-error')).toHaveTextContent(
      'The workspace start prompt cannot be empty'
    )
    expect(fakeBridge.configSetCalls()).toEqual([])
  })
})

describe('SettingsView tickets', () => {
  it('loads the filter, interval, prompt and learned projects', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig({
      jira: {
        jql: 'assignee = currentUser()',
        pollMinutes: 7,
        site: null,
        startPrompt: 'Plan first.',
        projects: { APP: 'uploader', WEB: 'site' }
      }
    })
    await openSettings(user)

    expect(await screen.findByTestId('settings-tickets-jql')).toHaveValue(
      'assignee = currentUser()'
    )
    expect(screen.getByTestId('settings-tickets-poll')).toHaveValue(7)
    expect(screen.getByTestId('settings-tickets-prompt')).toHaveValue('Plan first.')
    const learned = screen.getByTestId('settings-tickets-projects')
    expect(learned).toHaveTextContent('APP → uploader')
    expect(learned).toHaveTextContent('WEB → site')
  })

  it('writes the site as the trimmed host, and as null when cleared', async () => {
    const user = userEvent.setup()
    await openSettings(user)
    const site = await screen.findByTestId('settings-jira-site')
    expect(site).toHaveValue('')
    expect(site).toHaveAttribute('placeholder', 'team.example.net')

    await user.type(site, '  team.example.net ')
    await user.tab()
    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    await user.clear(site)
    await user.tab()

    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
    expect(fakeBridge.configSetCalls().map((c) => c.patch)).toEqual([
      { jira: { site: 'team.example.net' } },
      { jira: { site: null } }
    ])
  })

  it('says when no projects are learned, and refuses an empty prompt', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    expect(await screen.findByText('No projects learned yet.')).toBeInTheDocument()
    await user.clear(screen.getByTestId('settings-tickets-prompt'))
    await user.tab()

    expect(await screen.findByTestId('settings-tickets-prompt-error')).toHaveTextContent(
      'The start prompt cannot be empty'
    )
    expect(fakeBridge.configSetCalls()).toEqual([])
  })
})

describe('SettingsView instructions', () => {
  it('loads the file the config names into the editor and saves the content on blur', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig(
      { instructionsFile: '/Users/dev/notes/delegation.md' },
      { instructions_file: '/Users/dev/notes/delegation.md' }
    )
    fakeBridge.seedInstructions('Delegate broad searches to a smaller model.\n')
    await openSettings(user)

    expect(await screen.findByTestId('settings-instructions-file')).toHaveValue(
      '/Users/dev/notes/delegation.md'
    )
    const content = screen.getByTestId('settings-instructions-content')
    await waitFor(() => {
      expect(content).toHaveValue('Delegate broad searches to a smaller model.\n')
    })
    expect(content).toBeEnabled()
    expect(screen.queryByTestId('settings-instructions-unset')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save instructions' })).not.toBeInTheDocument()

    await user.type(content, 'Run tests before a commit.')
    expect(fakeBridge.instructionsSetCalls()).toEqual([])
    await user.tab()

    expect(await screen.findByTestId('settings-instructions-content-saved')).toHaveTextContent(
      'Saved'
    )
    expect(fakeBridge.instructionsSetCalls()).toEqual([
      'Delegate broad searches to a smaller model.\nRun tests before a commit.'
    ])
    expect(fakeBridge.configSetCalls()).toEqual([])
  })

  it('reverts the content on Escape', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig({ instructionsFile: '/Users/dev/notes/delegation.md' })
    fakeBridge.seedInstructions('Delegate broad searches.')
    await openSettings(user)
    const content = await screen.findByTestId('settings-instructions-content')
    await waitFor(() => expect(content).toHaveValue('Delegate broad searches.'))

    await user.type(content, ' And more.')
    await user.keyboard('{Escape}')

    expect(content).toHaveValue('Delegate broad searches.')
    await user.tab()
    expect(fakeBridge.instructionsSetCalls()).toEqual([])
  })

  it('disables the editor with a hint until a file is set, then writes the path on blur', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    const content = await screen.findByTestId('settings-instructions-content')
    expect(content).toBeDisabled()
    expect(screen.getByTestId('settings-instructions-unset')).toHaveTextContent(
      'Set a file above to edit the instructions here.'
    )

    await user.type(screen.getByTestId('settings-instructions-file'), '~/notes/delegation.md')
    await user.tab()

    await waitFor(() => {
      expect(fakeBridge.configSetCalls()).toEqual([
        { patch: { instructionsFile: '~/notes/delegation.md' }, applyTonight: false }
      ])
    })
    await waitFor(() => expect(content).toBeEnabled())
    expect(screen.queryByTestId('settings-instructions-unset')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-instructions-file-saved')).toBeInTheDocument()
  })

  it('refuses a relative path, saying why', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    await user.type(await screen.findByTestId('settings-instructions-file'), 'notes/delegation.md')
    await user.keyboard('{Enter}')

    expect(await screen.findByTestId('settings-instructions-file-error')).toHaveTextContent(
      'The instructions file must be an absolute path or start with ~'
    )
    expect(fakeBridge.configSetCalls()).toEqual([])
  })

  it('removes the key when the path is cleared', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig(
      { instructionsFile: '/Users/dev/notes/delegation.md' },
      { instructions_file: '/Users/dev/notes/delegation.md' }
    )
    await openSettings(user)

    await user.clear(await screen.findByTestId('settings-instructions-file'))
    await user.tab()

    await waitFor(() => {
      expect(fakeBridge.configSetCalls()).toEqual([
        { patch: { instructionsFile: null }, applyTonight: false }
      ])
    })
    await waitFor(() => {
      expect(screen.getByTestId('settings-instructions-content')).toBeDisabled()
    })
  })
})

describe('SettingsView updates', () => {
  /** When the last attempt ran, as the check records it. */
  const CHECKED_AT = new Date(2026, 10, 2, 14, 20).getTime()

  const RELEASE = { version: '0.3.1', url: 'https://github.com/queapp-org/que/releases/tag/v0.3.1' }

  it('shows the version and when the check last said up to date', async () => {
    const user = userEvent.setup()
    fakeBridge.setUpdateStatus({ version: '0.3.0', checkedAt: CHECKED_AT })

    await openSettings(user)

    const section = await screen.findByTestId('settings-updates')
    expect(within(section).getByTestId('settings-updates-version')).toHaveTextContent('que 0.3.0')
    expect(within(section).getByTestId('settings-updates-answer')).toHaveTextContent(
      `Up to date. Checked at ${hhmm(CHECKED_AT)}.`
    )
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
  })

  it('reads Checking… and is disabled while the request runs, keeping the last answer', async () => {
    const user = userEvent.setup()
    fakeBridge.setUpdateStatus({ checkedAt: CHECKED_AT })
    fakeBridge.holdUpdateCheck()
    await openSettings(user)

    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(screen.getByTestId('settings-updates-answer')).toHaveTextContent(hhmm(CHECKED_AT))

    fakeBridge.releaseUpdateCheck()

    expect(await screen.findByRole('button', { name: 'Check for updates' })).toBeEnabled()
    expect(fakeBridge.updateCheckCalls()).toBe(1)
  })

  it('finds a newer release: says so, Download opens it, and the Quiet row offers Update', async () => {
    const user = userEvent.setup()
    fakeBridge.answerUpdateCheck({ update: RELEASE, checkedAt: CHECKED_AT, failed: false })
    await openSettings(user)
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))

    await waitFor(() => {
      expect(screen.getByTestId('settings-updates-answer')).toHaveTextContent(
        'que 0.3.1 is available.'
      )
    })
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => {
      expect(fakeBridge.openUpdateCalls()).toBe(1)
    })
  })

  it('says it could not check, and the button can ask again', async () => {
    const user = userEvent.setup()
    fakeBridge.answerUpdateCheck({ checkedAt: CHECKED_AT, failed: true })
    await openSettings(user)

    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Couldn't check: no answer from GitHub. Tried at ${hhmm(CHECKED_AT)}.`
    )
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('shows a known release, not the error, after a failed attempt', async () => {
    const user = userEvent.setup()
    fakeBridge.setUpdateStatus({ update: RELEASE, checkedAt: CHECKED_AT, failed: true })

    await openSettings(user)

    expect(await screen.findByTestId('settings-updates-answer')).toHaveTextContent(
      'que 0.3.1 is available.'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('updates the answer when a background check finishes while Settings is open', async () => {
    const user = userEvent.setup()
    fakeBridge.setUpdateStatus({ checkedAt: CHECKED_AT })
    await openSettings(user)
    await screen.findByTestId('settings-updates-answer')

    fakeBridge.setUpdateStatus({ update: RELEASE, checkedAt: CHECKED_AT + 3_600_000 })

    await waitFor(() => {
      expect(screen.getByTestId('settings-updates-answer')).toHaveTextContent(
        'que 0.3.1 is available.'
      )
    })
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('keeps working while the daemon is unreachable, since the check runs in the app', async () => {
    const user = userEvent.setup()
    await openSettings(user)
    const toggle = await screen.findByTestId('settings-chime-complete')

    fakeBridge.disconnect()

    await waitFor(() => expect(toggle).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('says a local build does not check, and offers no button', async () => {
    const user = userEvent.setup()
    fakeBridge.setUpdateStatus({ releaseBuild: false })

    await openSettings(user)

    expect(await screen.findByTestId('settings-updates-answer')).toHaveTextContent(
      "Local build: que doesn't check for releases."
    )
    expect(screen.getByTestId('settings-updates-version')).toHaveTextContent('que 0.2.0')
    expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument()
  })
})
