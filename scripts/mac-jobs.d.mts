export interface MacJobsFacts {
  event: string | undefined
  headRef?: string
  tree?: string
  secondParentTree?: string
  changedFiles?: string[]
  versionChanged?: boolean
}

export interface MacJobsDecision {
  run: boolean
  reason: string
}

export function decide(facts: MacJobsFacts): MacJobsDecision
export function decideFromGit(where: {
  event: string | undefined
  headRef?: string
  cwd: string
}): MacJobsDecision
