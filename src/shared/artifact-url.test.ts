import { describe, expect, it } from 'vitest'
import { isArtifactUrl } from './artifact-url'

describe('isArtifactUrl', () => {
  it.each([
    'https://claude.ai/artifact/Bo2pUji8XumREbCYMXcoMe',
    'https://claude.ai/code/artifact/5768b884-1a29-46c3-8310-2ec1eb4d163d',
    'https://claude.ai/artifact/a_b-C9'
  ])('accepts %s', (url) => {
    expect(isArtifactUrl(url)).toBe(true)
  })

  it.each([
    'http://claude.ai/artifact/x',
    'https://claude.ai.evil.example/artifact/x',
    'https://evil.example/https://claude.ai/artifact/x',
    'javascript:alert(1)',
    'https://claude.ai/artifact/',
    'https://claude.ai/artifact/x?y=1',
    'https://claude.ai/artifact/x#y',
    'https://claude.ai/artifact/../../x',
    'https://user@claude.ai/artifact/x',
    'https://claude.ai:8443/artifact/x',
    'https://claude.ai/artifact/x\n',
    ' https://claude.ai/artifact/x',
    'https://claude.ai/code/x',
    ''
  ])('rejects %j', (url) => {
    expect(isArtifactUrl(url)).toBe(false)
  })
})
