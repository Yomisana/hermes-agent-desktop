// Update source for packaged overlay builds.
//
// Upstream's desktop self-update is a git flow: `checkUpdates()` resolves the
// backend's hermes root and git-pulls it, so it refuses outright when that
// root has no `.git` ("… isn't a git checkout — desktop self-update only runs
// against a source install"). Our installers are exactly that case — a remote
// -only build talks to a gateway someone else runs, and there is no local
// source tree to pull — so every user of this overlay sees that error where
// the update status should be.
//
// This module answers the same question against the place our installers
// actually come from: the GitHub releases of THIS repo. It only reports; it
// never downloads or swaps anything, so the desktop keeps its "no self-update
// for packaged builds" property and the user gets a link instead of an error.
//
// Kept in one file with no electron imports so it unit-tests as plain Node and
// the patch into upstream's main.ts stays a handful of lines.

/** Overridable so a fork of this fork does not have to re-patch main.ts. */
export const DEFAULT_RELEASE_REPO = 'Yomisana/hermes-agent-desktop'

export interface ReleaseSourceEnv {
  HERMES_DESKTOP_UPDATE_REPO?: string
}

export function releaseRepo(env: ReleaseSourceEnv = process.env as ReleaseSourceEnv): string {
  const configured = env.HERMES_DESKTOP_UPDATE_REPO?.trim()
  return configured || DEFAULT_RELEASE_REPO
}

export function releasesPageUrl(repo: string = releaseRepo()): string {
  return `https://github.com/${repo}/releases`
}

export function releasesApiUrl(repo: string = releaseRepo()): string {
  // The list endpoint, not /releases/latest: every overlay build is published
  // as a pre-release, and /releases/latest skips those — it would answer with
  // a months-old stable release, or 404.
  return `https://api.github.com/repos/${repo}/releases?per_page=20`
}

/**
 * Installer version: `<upstream version>-remote.<overlay>`, e.g. 0.21.0-remote.3.
 * Release TAGS use the upstream git tag instead (v2026.8.31-remote.3), so tags
 * are never compared against versions — only version against version.
 */
export interface DesktopVersion {
  upstream: readonly [number, number, number]
  overlay: number
}

// No leading `v`: that shape is a release TAG (v2026.8.31-remote.3), and
// letting it parse here would compare a calendar tag against a version.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-remote\.(\d+)$/

export function parseDesktopVersion(value: string | null | undefined): DesktopVersion | null {
  const match = VERSION_RE.exec((value ?? '').trim())

  if (!match) {
    return null
  }

  const [major, minor, patch, overlay] = match.slice(1).map(Number)

  return { upstream: [major, minor, patch], overlay }
}

/** Negative when `a` is older, 0 when equal, positive when `a` is newer. */
export function compareDesktopVersions(a: DesktopVersion, b: DesktopVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.upstream[i] !== b.upstream[i]) {
      return a.upstream[i] - b.upstream[i]
    }
  }

  return a.overlay - b.overlay
}

export interface PublishedRelease {
  tag: string
  /** Installer version read off an asset name; null when no asset matched. */
  version: string | null
  url: string
}

// Hermes-0.21.0-remote.3-win-x64.exe → 0.21.0-remote.3
const ASSET_RE = /^Hermes-(\d+\.\d+\.\d+-remote\.\d+)-/

export function assetVersion(names: readonly string[]): string | null {
  for (const name of names) {
    const match = ASSET_RE.exec(name)

    if (match) {
      return match[1]
    }
  }

  return null
}

/**
 * Newest published release, by installer version when the assets carry one and
 * by list order (GitHub returns newest first) otherwise. Drafts are skipped:
 * they are not downloadable by anyone but the repo owner.
 */
export function pickLatestRelease(payload: unknown): PublishedRelease | null {
  if (!Array.isArray(payload)) {
    return null
  }

  let best: PublishedRelease | null = null
  let bestParsed: DesktopVersion | null = null

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object' || (entry as { draft?: boolean }).draft) {
      continue
    }

    const release = entry as { tag_name?: string; html_url?: string; assets?: { name?: string }[] }
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''

    if (!tag) {
      continue
    }

    const names = Array.isArray(release.assets)
      ? release.assets.map(asset => (typeof asset?.name === 'string' ? asset.name : ''))
      : []
    const candidate: PublishedRelease = {
      tag,
      version: assetVersion(names),
      url: typeof release.html_url === 'string' ? release.html_url : releasesPageUrl()
    }
    const parsed = parseDesktopVersion(candidate.version)

    if (!best) {
      best = candidate
      bestParsed = parsed
      continue
    }

    // Only a decisive version comparison may displace the first (newest) entry.
    if (parsed && bestParsed && compareDesktopVersions(parsed, bestParsed) > 0) {
      best = candidate
      bestParsed = parsed
    }
  }

  return best
}

export interface ReleaseUpdateStatus {
  supported: false
  reason: 'packaged-build'
  message: string
  hermesRoot: string
  branch: string
  updateAvailable: boolean
  currentVersion: string
  latestTag: string | null
  latestVersion: string | null
  releaseUrl: string
  fetchedAt: number
}

export interface CheckReleaseUpdateOptions {
  currentVersion: string
  hermesRoot: string
  branch: string
  repo?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Never throws: the update panel is a status line, and a failed probe must read
 * as "could not check", not as a crash or as "you are up to date".
 */
export async function checkReleaseUpdate(
  options: CheckReleaseUpdateOptions
): Promise<ReleaseUpdateStatus> {
  const { currentVersion, hermesRoot, branch } = options
  const repo = options.repo ?? releaseRepo()
  const page = releasesPageUrl(repo)
  const base: ReleaseUpdateStatus = {
    supported: false,
    reason: 'packaged-build',
    message: '',
    hermesRoot,
    branch,
    updateAvailable: false,
    currentVersion,
    latestTag: null,
    latestVersion: null,
    releaseUrl: page,
    fetchedAt: Date.now()
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch

  if (typeof doFetch !== 'function') {
    return { ...base, message: `Installed build ${currentVersion}. Releases: ${page}` }
  }

  let latest: PublishedRelease | null = null

  try {
    const response = await doFetch(releasesApiUrl(repo), {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000)
    })

    if (!response.ok) {
      return {
        ...base,
        message: `Could not check ${repo} for updates (HTTP ${response.status}). Releases: ${page}`
      }
    }

    latest = pickLatestRelease(await response.json())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    return { ...base, message: `Could not check ${repo} for updates (${detail}). Releases: ${page}` }
  }

  if (!latest) {
    return { ...base, message: `No published build found in ${repo}. Releases: ${page}` }
  }

  const current = parseDesktopVersion(currentVersion)
  const published = parseDesktopVersion(latest.version)
  const label = latest.version ? `${latest.version} (${latest.tag})` : latest.tag

  if (!current || !published) {
    // One side is unparseable: say what is out there, claim nothing.
    return {
      ...base,
      latestTag: latest.tag,
      latestVersion: latest.version,
      releaseUrl: latest.url,
      message: `Installed ${currentVersion}; latest published build is ${label}. Releases: ${latest.url}`
    }
  }

  const behind = compareDesktopVersions(published, current) > 0

  return {
    ...base,
    updateAvailable: behind,
    latestTag: latest.tag,
    latestVersion: latest.version,
    releaseUrl: latest.url,
    message: behind
      ? `Update available: ${label}. This build is ${currentVersion}. Download: ${latest.url}`
      : `Up to date — ${currentVersion} is the newest build published in ${repo}.`
  }
}
