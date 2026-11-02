# Contributing to que

Thanks for helping. que is small on purpose; a good change keeps it that way.

## Setup

You need macOS on Apple Silicon, Node 24, and git. Then:

```sh
git clone https://github.com/queapp-org/que.git
cd que
npm ci          # also rebuilds node-pty for Electron (postinstall)
npm run dev     # the app with hot reload, using ~/.que
```

To try things without touching your real state, set `QUE_HOME` (and
`QUE_CONFIG`) to a scratch directory first; every test and script does.

## Before you open a pull request

```sh
npm run verify
```

runs typecheck, lint, build, the Vitest suites, the smoke check, and the
Playwright specs in that order and stops at the first failure. CI runs the
same steps split into five checks, one workflow each: Typecheck, Lint, Unit
tests, E2E tests, and Packaged app (`npm run smoke:packaged`). Lint also fails
if the generated docs are stale. If you changed a CLI command or a
config default, run `npm run docs` and commit the regenerated `docs/` files.

A Semgrep check also runs on every pull request (registry rules plus `.semgrep/que.yml`). To run the
custom rules locally, install `semgrep` and run `semgrep scan --config .semgrep/que.yml --error .`.

## Lint and format

`npm run lint` runs oxlint (with the vendored rules in `tools/oxlint/`, see its README) and an oxfmt format check; `npm run format` writes the formatting. `npm ci` installs a pre-commit hook (husky and lint-staged) that lints and formats the staged files.

## Tests

The repository carries three testing guides in `.claude/skills/` that apply to
everyone, human or not:

- `test-planning`: which behavior to test at which layer (logic, daemon or
  renderer integration, end to end), without testing the same thing twice;
- `vitest-testing`: how to write logic, daemon integration, and renderer tests;
- `e2e-testing`: how to write the Playwright specs.

The short version: fake the subprocesses (`tests/fakes/bin` first on `PATH`),
never internal modules; a fresh temp `QUE_HOME` for every test; no sleeps, wait
on a condition; inject the clock into anything time-dependent.
`npm run test:flaky -- 10` runs the Vitest suites ten times when you suspect a
flaky test.

When the website's home-page animation changes, re-record the README's GIF with `npm run day:gif`: it records one loop of the animation from queapp.org (`-- --url http://localhost:4321/` for a local build of the website) and writes `docs/images/day.gif`. It needs Playwright's browser (`npx playwright install chromium`).

`npm run test:coverage` runs the Vitest suites with coverage and writes the
report to `coverage/index.html`. Every pull request's "Unit tests" step summary
shows the same four percentages (lines, statements, branches, functions) and
links the full report. The floor is 75% of lines, statements and functions and
70% of branches (#107): a run below it fails, locally and in the Unit tests
check. The CLI integration tests run the built CLI as a subprocess, so
`src/cli` shows as uncovered, and the Playwright specs are not measured.

Two mechanical commits (the oxfmt reformat and the blank-line autofix) are
listed in `.git-blame-ignore-revs`; run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
skips them.

## Pull requests

- One change per pull request, with tests at the layer the change lives in.
- Explain the why in the description; the diff shows the what.
- Keep `npm run verify` green, and update `CHANGELOG.md` under `Unreleased`.
- Code, comments, and docs describe que on its own terms.

By contributing you agree that your contribution is licensed under the
Apache License 2.0 (see `LICENSE`), and to follow the
[code of conduct](CODE_OF_CONDUCT.md).

## Releasing

A release happens when `[Unreleased]` in `CHANGELOG.md` has earned one.

```sh
git switch main && git pull
git switch -c release/0.2.0
npm run release
```

`npm run release` (release-it, configured in `.release-it.json`) refuses any
branch but `release/*` and a dirty tree, runs `npm run verify`, asks patch,
minor or major, moves the `[Unreleased]` notes under `## [<version>] - <today>`
with the compare links updated, bumps `package.json` and `package-lock.json`,
commits `Release v<version>`, pushes the branch and opens the release pull
request. `npm run release -- --dry-run` prints every step and writes nothing;
`npm run release -- minor --ci` skips the questions. Nothing is tagged
locally.

A beta for testers goes the same way from `release/0.2.0-beta.1`:
`npm run release -- minor --preRelease=beta` makes `0.2.0-beta.1` (run again,
`--preRelease` alone makes `beta.2`), and the release is drafted as a GitHub
prerelease, which the app's update check never offers.

Review the pull request (the changelog section is the release notes) and merge
it. The release workflow then builds que.app and drafts the GitHub release;
check the notes and the DMG on the release page and publish the draft, which
creates the tag.

`npm run package` and `npm run dist` build unsigned. With a Developer ID
Application certificate in your login keychain,
`CSC_IDENTITY_AUTO_DISCOVERY=true npm run dist` builds a signed one.
