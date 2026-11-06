---
name: test-planning
description: Identifies what tests to create for a que feature or change, applying the Testing Trophy model to avoid redundant overlap between the E2E, integration (daemon in-process and renderer component), and logic test layers. Use when planning test coverage for new features, daemon methods, CLI commands, renderer components, bug fixes, or refactors.
allowed-tools: Read, Glob, Grep, WebFetch, WebSearch, TodoWrite
---

# Test Planning Skill - que

You are a test planning advisor for que. Your job is to analyze a feature, bug fix, or change and recommend **which tests to write at which layer** while **eliminating redundant overlap** between layers.

**Scope:** This skill covers **what** to test at which layer. For **how** to write Vitest integration, renderer component, and logic tests, use the `vitest-testing` skill. For **how** to write Playwright Electron E2E tests, use the `e2e-testing` skill.

You follow Kent C. Dodds' Testing Trophy model: [**"Write tests. Not too many. Mostly integration."**](https://kentcdodds.com/blog/write-tests)

---

## The Testing Trophy (adapted for this project)

The Testing Trophy inverts the traditional testing pyramid: the **bulk of testing effort goes to integration tests** because they provide the best confidence-to-cost ratio.

que is a macOS Electron app whose real work happens in a long-running daemon (`src/daemon/`): it owns the terminals (node-pty plus an `@xterm/headless` mirror so clients can reattach), projects and workspaces (git worktrees under `~/.que/worktrees/<project>/<name>`), the status engine, Create draft PR, the sessions report, the quiet-hours clock, SQLite (`node:sqlite`), and a unix-socket API. The Electron main process (`src/main/`) and the `que` CLI (`src/cli/`) are both thin clients of that socket through `DaemonClient` (`src/shared/client.ts`); the renderer (`src/renderer/src/`) only ever sees the daemon through the `window.que` bridge that `src/preload/` exposes. That reshapes the trophy: the daemon's in-process integration tests carry most of the confidence, renderer component tests sit beside them in the same layer, "unit" collapses into a **logic layer** for the pure reducers and clock math, and the boundaries are faked where they really are (subprocesses on `PATH`, the `window.que` bridge), never deeper.

```
         _____
        /     \
       /  E2E  \         Few, high-value journeys: built app + real daemon in a temp QUE_HOME
      /---------\
     /           \
    / Integration \      Daemon pieces in-process (real pty, sqlite, git, socket, fake claude)
    \             /      + renderer components against the fake window.que bridge
     \-----------/
     \   Logic   /       Pure reducers, state machines, clock math, framing, parsing
      /---------\
     /  Static   \       TypeScript (strict) (+ a linter later)
    /_____________\
```

### Core Principles

1. **The more your tests resemble how software is used, the more confidence they give you**
2. **Integration tests are the sweet spot** - the real daemon pieces in-process with real node-pty, real `node:sqlite`, real `git`, and the real `DaemonClient` over a temp socket; for UI, real components against the fake `window.que` bridge
3. **Fake at the subprocess and bridge boundaries, not deeper** - que's true boundaries are the `claude`, `git`, `gh`, and `code` subprocesses (fake `claude`/`gh`/`code` binaries on `PATH` from `tests/fakes/bin/`; `git` stays real on temp repos), the filesystem under `QUE_HOME` (a fresh temp dir per test), the clock (injected `now()`), and the Electron bridge (the fake `window.que` in renderer tests). Never mock `protocol.ts`, `client.ts`, the status engine, the store, components, `node:child_process`, or `node:fs`.
4. **Don't test implementation details** - test behavior a user or client can observe (a socket response, an event, a row in the store, a screen line, a rendered badge) or, for the logic layer, the returned value
5. **You should rarely change tests when you refactor code** - if your tests break on refactor, they tested the wrong thing
6. **Code coverage is a tool, not a target** - 100% coverage is counterproductive
7. **The compiler is part of your test suite** - TypeScript strict means the static layer genuinely catches protocol shape mismatches (`Methods`, `Events`, `ParamsOf<M>`), wrong field keys, and bad call signatures across daemon, CLI, main, preload, and renderer. Don't write a runtime test for something the compiler already proves. Behavior — a transition rule, a framing edge case, anything about _what happens_, not just _what shape_ — still needs a real test.

---

## The Three Test Layers in This Project

### Layer 1: E2E Tests (Playwright for Electron) - `tests/e2e/`

**Purpose:** Validate critical user journeys in the real built app against the real daemon.

E2E launches the built app (`npm run e2e` builds first) with `QUE_HOME` set to a fresh temp dir, `QUE_E2E=1`, and `PATH` prepended with `tests/fakes/bin`, so the real daemon starts in that home, real `git` runs against a temp repo built by `tests/e2e/utils/repo.ts`, and `claude`/`gh`/`code` are the fakes. Its unique value is the **whole system end to end**: Electron main spawning or finding the daemon, the preload bridge, the real renderer with xterm.js, multiple windows, and — the one thing nothing lower can prove — that the daemon and its terminals **outlive the app** and the app reattaches on relaunch.

**Test here:**

- Happy path of critical journeys: add a project → create a workspace → its terminal opens and runs
- Quit and relaunch: the daemon keeps the terminals alive and the relaunched app reattaches and replays the screen
- A session's review journey: a workspace's session runs against the fake `claude`, Create draft PR pushes and opens a draft PR through the fake `gh`, and the morning report shows the workspace
- Quiet mode: the quiet board replaces the terminals during quiet hours, and unlocking brings them back
- Behavior that depends on the real Electron shell (multiple windows, focus, the real xterm rendering)

**Do NOT test here:**

- Every status transition (logic tests)
- Every badge/empty/error rendering variation (renderer component tests)
- Daemon method error shapes, the stall timeout, refusals (integration tests)
- Individual component rendering details

**Cost:** Slow (a build plus a real app launch per test), flaky-prone, expensive to maintain. Every E2E test must earn its place.

### Layer 2: Integration Tests (Vitest) - `tests/integration/**/*.test.ts` and `src/renderer/src/**/*.test.tsx`

**Purpose:** Test real modules working together. This is where the BULK of testing happens. Two flavors share the layer:

**Daemon integration (Vitest `node` project, `tests/integration/`).** The real daemon pieces run in-process: a real `DaemonServer` on a temp socket, the real `DaemonClient` talking to it, real node-pty terminals with their xterm mirror, real `node:sqlite` in a temp `QUE_HOME`, real `git` against temp repos, and the fake `claude` on `PATH`, an interactive session driven by typing into its terminal (a prompt, `/needs-input`, `/background`, `/exit`). Seed through the real API (`client.request(...)`) or by creating real git repos in temp dirs. Real timers + `waitFor`/`expect.poll` for anything touching PTYs, sockets, or subprocesses.

**Renderer component (Vitest `renderer` project, jsdom, colocated `*.test.tsx`).** Real components rendered with React Testing Library against the fake `window.que` bridge (`src/renderer/src/testing/fake-bridge.ts`): an in-memory fixture book, reset after every test, seeded before `render()` with `seedWorkspace`/`setStatus`/`setQuietState`, emitting the same events the real daemon would. Do **not** mock components or any internal module.

**Test here:**

- Daemon methods end to end over the socket: request params, result shapes, structured errors (`not_found`, `unknown_method`), and the events they emit
- PTY lifecycle: create, attach (snapshot replay), write, resize, kill, exit events
- The status engine fed by the real `que hook` path and the fake `claude`'s hook calls
- A fake `claude` session in a workspace terminal: its hooks driving the status, needs input, the stall timeout; Create draft PR calling the fake `gh`
- Workspaces against real temp git repos: worktree creation, branch naming, setup commands from `que.toml`
- CLI commands run against an in-process daemon in a temp `QUE_HOME` (output and exit codes)
- Renderer components with realistic state: the sidebar, terminal tabs, quiet board, morning report, settings
- UI reacting to daemon events from the fake bridge (a status event updating a sidebar badge)
- Empty, error, and disconnected states; accessibility (roles, labels, focus)

**Do NOT test here:**

- Pure transitions or clock math with no I/O (logic tests — cheaper and more precise)
- Things already covered by an E2E happy path (don't re-verify the same journey)
- Implementation details (private fields, call counts on internal functions, render counts)

**Cost:** Fast to moderate, reliable when it waits on conditions instead of sleeping, high confidence. Default layer for most testing.

### Layer 3: Logic Tests (Vitest, plain functions) - colocated `src/**/*.test.ts`

**Purpose:** Test que's rules as pure functions. This is the cheapest, most precise layer.

The status-engine reducers, the quiet-hours and unlock clock math, config parsing and defaults, hook and `gh` JSON decoding, worktree naming and slugs, the workspace digest and report formatting, and protocol framing (`LineSplitter`, `MessageDecoder`, `encode`) take inputs and return outputs — no sockets, no processes, no DOM. Anything that depends on time takes an injected `now()` instead of reading the wall clock.

**Test here:**

- Status transitions: `Stop` → idle, `Notification` with `notification_type: 'permission_prompt'` → needs input, `UserPromptSubmit`/`PreToolUse` → working, no event within the stall timeout → stuck, and the cross-check against `claude agents --json`
- The workspace digest: time working, needs-input count and since when, stuck count, from a window of status-log rows
- Quiet-hours math: a window crossing midnight, per-day overrides, DST edges, the "apply tonight" guardrail (an edit made during an active window never shortens it)
- Unlock countdown: remaining time, expiry, an unlock requested outside quiet hours
- Protocol framing with split chunks, byte-at-a-time multi-byte UTF-8, malformed lines
- Decoding hook payloads and `gh` JSON: the fields que reads, missing fields, unknown values
- Worktree naming and slugs, config defaults, report formatting, what the tray shows (`trayView`: its mark, title and counts)
- Immutability: pure reducers never mutate their input

**Do NOT test here:**

- Anything that spawns, listens, or touches disk (integration tests)
- UI rendering or user interactions

**Cost:** Fastest and most stable. Test all branchy rules here, not through the socket or the UI.

---

## The Overlap Elimination Framework

This is the core value of this skill. For any given behavior, **test it at the lowest-cost layer that gives you confidence**, then DON'T re-test it higher up.

### Decision Matrix

| What you're testing                                               | E2E | Integration (daemon / renderer) | Logic |
| ----------------------------------------------------------------- | --- | ------------------------------- | ----- |
| **Status transitions (hook event → status)**                      | -   | -                               | YES   |
| **Workspace digest (status-log rows → what a session did)**       | -   | -                               | YES   |
| **Quiet-hours / unlock clock math**                               | -   | -                               | YES   |
| **Protocol framing, JSON decoding, config defaults, slugs**       | -   | -                               | YES   |
| **Reducer immutability**                                          | -   | -                               | YES   |
| **Daemon method params, results, errors, events over the socket** | -   | YES (daemon)                    | -     |
| **PTY create / attach snapshot / write / kill**                   | -   | YES (daemon)                    | -     |
| **A fake `claude` session: hooks, needs input, stall**            | -   | YES (daemon)                    | -     |
| **Hook delivery: fake `claude` → `que hook` → status engine**     | -   | YES (daemon)                    | -     |
| **Worktree creation on a real temp repo**                         | -   | YES (daemon)                    | -     |
| **Create draft PR pushes and calls the fake `gh`**                | -   | YES (daemon)                    | -     |
| **CLI command output and exit codes**                             | -   | YES (daemon)                    | -     |
| **Component renders correctly for a given fixture book**          | -   | YES (renderer)                  | -     |
| **User interaction triggers the right bridge call**               | -   | YES (renderer)                  | -     |
| **UI reacts to a daemon event (status badge, quiet board)**       | -   | YES (renderer)                  | -     |
| **Empty / error / disconnected states**                           | -   | YES (renderer)                  | -     |
| **Cross-window or cross-process user journey (happy path)**       | YES | -                               | -     |
| **Daemon and terminals survive quit; relaunch reattaches**        | YES | -                               | -     |
| **Session → Create draft PR → morning report**                    | YES | -                               | -     |
| **Real Electron shell behavior (windows, focus)**                 | YES | -                               | -     |

### The "Who Owns This Test?" Rules

1. **Rule ownership** → Logic tests own it. The status engine, the digest, and clock math are pure functions; the daemon and the UI should trust them.
2. **Wiring and boundary ownership** → Daemon integration tests own it. That a method reaches the right module, persists, emits the right event, and drives the right subprocess is proven over the real socket with the fakes on `PATH`.
3. **UI behavior ownership** → Renderer component tests own it. E2E should not re-verify component details.
4. **Whole-system and process-lifetime behavior** → E2E owns it. Only E2E gets the real Electron shell, the real preload bridge, and the app quitting while the daemon lives on.
5. **Status rules**:
   - The rule itself (which event yields which status, when stuck fires) → Logic tests
   - That real hook payloads reach the engine and the event goes out → Daemon integration tests
   - How the status is surfaced (sidebar badge, quiet board row) → Renderer component tests; what the tray shows → a logic test of `trayView`
   - Don't test the same transition in logic, integration, AND E2E

### Overlap Smells (Red Flags)

| Smell                                                                                                   | Problem                                                               | Fix                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| E2E test walks every fake `claude` session path                                                         | Over-testing at the highest-cost layer                                | Move session paths to daemon integration tests, the transitions to logic tests; keep one happy path in E2E |
| Integration test spawns the fake `claude` just to assert a state transition                             | Testing the reducer through a subprocess                              | Call the reducer directly in a logic test                                                                  |
| Logic test AND integration test verify the same transition                                              | Same behavior tested twice                                            | Logic test owns the rule; integration test only that the wiring delivers it                                |
| E2E test for a single component's rendering                                                             | Wrong layer for component testing                                     | Use a renderer component test against the fake bridge instead                                              |
| A test mocks `protocol.ts`, `client.ts`, the status engine, the store, a component, or another internal | Mocking removes confidence; internals are not boundaries              | Run the real module; fake only the subprocess or the bridge                                                |
| A plan proposes `vi.mock('node:child_process')` or `vi.mock('node:fs')`                                 | The subprocess and the disk are the boundary, faked by real stand-ins | Put a fake binary on `PATH`; use a temp `QUE_HOME` and temp repos                                          |
| A test sleeps (`setTimeout`, `waitForTimeout`) to let the daemon catch up                               | Timing-dependent and flaky                                            | Wait on a condition: `waitFor`, `expect.poll`, an event, a CLI query                                       |
| A logic test uses `vi.useFakeTimers()` where the module could take `now()`                              | Time is a boundary to inject, not to monkey-patch                     | Pass an injected clock; fake timers only in pure logic tests with no I/O                                   |

---

## How to Use This Skill

When asked to plan tests for a feature, follow this process:

### Step 1: Understand the Feature

Research the feature by reading:

- `CLAUDE.md` / `AGENTS.md` (architecture, invariants, gotchas) if present and not already loaded
- The protocol (`src/shared/protocol.ts` — `Methods`, `Events`) for any new or changed daemon method
- The relevant daemon modules (`src/daemon/`), CLI commands (`src/cli/`), main/preload wiring (`src/main/`, `src/preload/`), and renderer components (`src/renderer/src/`)
- The test helpers: `src/testing/fixtures.ts`, `src/renderer/src/testing/fixtures.ts`, `src/renderer/src/testing/fake-bridge.ts`, `tests/fakes/bin/`, `tests/e2e/utils/`
- Any existing tests that touch this area

### Step 2: Decompose Into Testable Behaviors

Break the feature into observable behaviors. For each behavior, ask:

- Is this a **pure rule, transition, or calculation**? → Logic test
- Is this **daemon wiring, persistence, a subprocess, or the socket**? → Daemon integration test
- Is this **UI rendering, interaction, or reaction to an event**? → Renderer component test
- Is this a **cross-process journey or real-Electron behavior**? → E2E (only if critical)

### Step 3: Check for Existing Coverage

Before recommending new tests, check what already exists:

- `tests/e2e/` - Existing E2E specs
- `tests/integration/` - Existing daemon integration tests
- `src/**/*.test.ts`, `src/renderer/src/**/*.test.tsx` - Existing logic and renderer component tests
- `scripts/smoke.mjs` - The daemon smoke check

Don't recommend tests that duplicate existing coverage.

### Step 4: Produce a Test Plan

Output a structured test plan using this format:

```
## Test Plan: [Feature Name]

### E2E Tests (Playwright for Electron)
> Only critical user journeys. Each test must justify its cost.

- [ ] **Test name** - What journey this validates and why E2E is necessary
  - Why E2E: [specific reason this can't be tested lower]
  - Setup: [repo.ts fixture, que.ts CLI calls, fake claude commands typed into the terminal]

### Integration Tests (Vitest)
> Bulk of testing. Real daemon pieces in-process; real components against the fake bridge.

Daemon:
- [ ] **Test name** - What behavior this validates
  - Seed: [client.request(...) calls, temp repo, fake claude commands]
  - Act: [method / CLI command / hook delivery]
  - Observe: [result, event, store row, fake gh/code log, screen text]

Renderer:
- [ ] **Test name** - What behavior this validates
  - Seed: [fake bridge fixture book: seedWorkspace / setStatus / setQuietState]
  - Renders: [what should appear]
  - Interactions: [what user actions to test]
  - States: [empty/error/disconnected/success variations]

### Logic Tests (Vitest)
> Pure rules, state machines, clock math, parsing.

- [ ] **Test name** - What rule or transition this validates
  - Given: [input state, injected now()]
  - When: [function call]
  - Then: [expected return value / next state]

### NOT Testing (Intentional Gaps)
> Explicitly call out what you chose NOT to test and why.

- **[Behavior]** - Already covered by [existing test]. Adding another test here would be redundant.
- **[Behavior]** - Low risk, no logic. Not worth a test.
```

### Step 5: Verify No Overlap

Before finalizing, scan the plan for overlap:

- Is any behavior tested at more than one layer? If so, justify it or remove the redundant test.
- Could any E2E test be replaced by a cheaper integration test?
- Could any integration test be replaced by a cheaper logic test?

---

## Common Scenarios

### New Feature

```
Logic:       Tests for any new/changed reducer, state machine, or calculation
Integration: Daemon tests for the new methods/events; renderer tests for the new UI
             (rendering, interactions, states, reaction to events)
E2E:         ONE happy-path test if it's a critical journey, ZERO if it's informational
```

### New Daemon Method

```
Static:      Add it to Methods (and Events if it emits) in protocol.ts — the compiler then
             checks the daemon handler, DaemonClient callers, the CLI, and the preload bridge
Logic:       Any pure rule the handler delegates to (transition, validation, naming)
Integration: Over the real socket with the real DaemonClient: the happy-path result, the
             structured errors (not_found, invalid params), the event(s) it emits, and what it
             persists (re-read through another request, not by peeking at SQLite)
Renderer:    Only if the UI calls it — ONE test that the triggering UI calls the bridge and
             reflects the result (the fake bridge implements the method)
E2E:         NONE unless it creates a genuinely new critical journey
```

### New CLI Command

```
Logic:       Argument parsing/formatting helpers if they branch (e.g. report formatting, duration parsing)
Integration: Run the command against an in-process daemon in a temp QUE_HOME: stdout, exit code,
             --json output shape, the error message when the daemon isn't running.
             `que hook`: real Claude Code hook JSON on stdin reaches the status engine.
E2E:         NONE — unless the command is part of a critical journey (que work + que report), in
             which case the existing journey spec drives it through tests/e2e/utils/que.ts
```

### New Renderer Component

```
Logic:       Any pure formatting/derivation it relies on (badge label, countdown text)
Renderer:    Integration tests against the fake bridge: rendering for seeded fixtures, user
             interactions and the bridge calls they make, reaction to emitted events,
             empty/error/disconnected states, accessibility
E2E:         NONE — existing journeys already render the shell; add data-testids so a future
             journey can reach it
```

### Bug Fix

```
Write ONE test at the layer where the bug lives:
- Wrong transition, wrong math, wrong parse? → Logic test
- Wrong wiring, lost event, subprocess mishandled, bad persistence? → Daemon integration test
- UI shows wrong state? → Renderer component test
- Breaks only across processes or app lifetime (reattach, relaunch)? → E2E

Do NOT add tests at multiple layers for the same bug.
```

### Refactor

```
Existing tests should still pass. If they don't, the tests were testing implementation
details and should be fixed, not the refactor.

Add new tests ONLY if the refactor exposes previously untested behavior.
```

---

## Confidence Calibration

Ask yourself: **"If this test passes, am I confident the feature works?"**

- If you need 5 E2E tests to feel confident → you're testing too much at the E2E layer. Move detail tests down.
- If an integration test exists only to assert what a reducer returns → it's a logic test wearing a costume. Move it down.
- If a daemon integration test spawns the fake `claude` for every branch of a status rule → the branches belong in a logic test; keep one session per real wiring path.
- If you need 20 tests for one component → you're testing implementation details. Write 3-5 integration tests instead.
- If a behavior is a pure function of its inputs and `now()` → the logic layer gives you full confidence for the lowest cost.
- The compiler proves shapes: don't write a runtime test for a wrong field key or a mismatched protocol type — `npm run typecheck` already catches that. But "the types cover it" only covers shape; behavior (transitions, timeouts, reattach) still needs a real test.

The goal is **maximum confidence with minimum tests**. Every test should provide confidence that no other test already provides.
