// The one test of a published page's URL. A URL in a hook payload is untrusted and the app opens
// these outside itself, so the whole string must have this shape: nothing is parsed or normalised.
// No Node imports: the renderer uses it too.

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/

export const isArtifactUrl = (url: string): boolean => ARTIFACT_URL.test(url)
