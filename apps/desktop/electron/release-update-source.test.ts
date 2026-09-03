import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  assetVersion,
  checkReleaseUpdate,
  compareDesktopVersions,
  DEFAULT_RELEASE_REPO,
  parseDesktopVersion,
  pickLatestRelease,
  releaseRepo,
  releasesApiUrl
} from './release-update-source'

const release = (tag: string, version: string | null, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/${DEFAULT_RELEASE_REPO}/releases/tag/${tag}`,
  assets: version ? [{ name: `Hermes-${version}-win-x64.exe` }] : [],
  ...extra
})

test('the update target is this repo unless the env overrides it', () => {
  assert.equal(releaseRepo({}), DEFAULT_RELEASE_REPO)
  assert.equal(releaseRepo({ HERMES_DESKTOP_UPDATE_REPO: '  Someone/fork ' }), 'Someone/fork')
  // Every overlay build is a pre-release, so /releases/latest is never used.
  assert.ok(releasesApiUrl(DEFAULT_RELEASE_REPO).endsWith('/releases?per_page=20'))
})

test('installer versions compare on upstream version then overlay', () => {
  const older = parseDesktopVersion('0.21.0-remote.3')!
  const newer = parseDesktopVersion('0.21.0-remote.10')!

  assert.ok(compareDesktopVersions(newer, older) > 0)
  assert.ok(compareDesktopVersions(parseDesktopVersion('0.22.0-remote.0')!, newer) > 0)
  assert.equal(compareDesktopVersions(older, parseDesktopVersion('0.21.0-remote.3')!), 0)
  // Release tags are a different scheme and must never parse as a version.
  assert.equal(parseDesktopVersion('v2026.8.31-remote.3'), null)
  assert.equal(parseDesktopVersion('0.21.0'), null)
})

test('the newest published release wins; drafts are skipped', () => {
  const picked = pickLatestRelease([
    release('v2026.8.31-remote.9', '0.21.0-remote.9', { draft: true }),
    release('v2026.8.31-remote.2', '0.21.0-remote.2'),
    release('v2026.8.31-remote.4', '0.21.0-remote.4'),
    release('v2026.8.18-remote.3', '0.20.4-remote.3')
  ])

  assert.equal(picked?.tag, 'v2026.8.31-remote.4')
  assert.equal(picked?.version, '0.21.0-remote.4')
  assert.equal(assetVersion(['SHA256SUMS', 'Hermes-0.21.0-remote.4-linux-x86_64.AppImage']), '0.21.0-remote.4')
  assert.equal(assetVersion(['SHA256SUMS']), null)
  assert.equal(pickLatestRelease({ message: 'Not Found' }), null)
})

const check = (payload: unknown, currentVersion: string, ok = true) =>
  checkReleaseUpdate({
    currentVersion,
    hermesRoot: '/opt/hermes',
    branch: 'main',
    fetchImpl: async () =>
      ({ ok, status: ok ? 200 : 403, json: async () => payload }) as unknown as Response
  })

test('a newer published build is reported with its download link', async () => {
  const status = await check([release('v2026.8.31-remote.4', '0.21.0-remote.4')], '0.21.0-remote.3')

  assert.equal(status.updateAvailable, true)
  assert.equal(status.latestVersion, '0.21.0-remote.4')
  // supported:false keeps the renderer from offering upstream's git-pull flow,
  // which cannot work against a packaged install.
  assert.equal(status.supported, false)
  assert.match(status.message, /Update available: 0\.21\.0-remote\.4/)
  assert.match(status.message, /releases\/tag\/v2026\.8\.31-remote\.4/)
})

test('the newest build reads as up to date, not as an error', async () => {
  const status = await check([release('v2026.8.31-remote.4', '0.21.0-remote.4')], '0.21.0-remote.4')

  assert.equal(status.updateAvailable, false)
  assert.match(status.message, /Up to date/)
  assert.doesNotMatch(status.message, /git checkout/)
})

test('a failed probe says so and still points at the releases page', async () => {
  const http = await check([], '0.21.0-remote.3', false)

  assert.equal(http.updateAvailable, false)
  assert.match(http.message, /HTTP 403/)
  assert.match(http.message, new RegExp(DEFAULT_RELEASE_REPO.replace('/', '\\/')))

  const offline = await checkReleaseUpdate({
    currentVersion: '0.21.0-remote.3',
    hermesRoot: '/opt/hermes',
    branch: 'main',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }
  })

  assert.equal(offline.updateAvailable, false)
  assert.match(offline.message, /ENOTFOUND/)
})

test('an unparseable version claims nothing either way', async () => {
  const status = await check([release('nightly', null)], '0.21.0-remote.3')

  assert.equal(status.updateAvailable, false)
  assert.equal(status.latestTag, 'nightly')
  assert.match(status.message, /latest published build is nightly/)
})
