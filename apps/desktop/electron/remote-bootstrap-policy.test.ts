import assert from 'node:assert/strict'

import { test } from 'vitest'

import { bootstrapSkippedError, shouldSkipAutoBootstrap } from './remote-bootstrap-policy'

const PACKAGED = true
const DEV = false

test('a packaged overlay build never auto-installs a local runtime', () => {
  // The regression this guards: the policy used to depend on
  // HERMES_DESKTOP_REMOTE_ONLY, which CI sets at BUILD time only — the
  // installed app has no such env, so it read false and upstream's installer
  // ran on the user's machine anyway.
  assert.equal(shouldSkipAutoBootstrap({}, PACKAGED), true)
})

test('an unpackaged run keeps upstream behavior unless asked otherwise', () => {
  assert.equal(shouldSkipAutoBootstrap({}, DEV), false)
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_SKIP_BOOTSTRAP: 'true' }, DEV), true)
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_REMOTE_ONLY: 'true' }, DEV), true)
})

test('only the exact string true counts', () => {
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_REMOTE_ONLY: '1' }, DEV), false)
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_REMOTE_ONLY: 'TRUE' }, DEV), false)
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP: 'yes' }, PACKAGED), true)
})

test('the escape hatch re-enables bootstrap for a packaged build', () => {
  assert.equal(shouldSkipAutoBootstrap({ HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP: 'true' }, PACKAGED), false)
  // ...but an explicit skip still wins over it.
  assert.equal(
    shouldSkipAutoBootstrap(
      { HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP: 'true', HERMES_DESKTOP_SKIP_BOOTSTRAP: 'true' },
      PACKAGED
    ),
    true
  )
})

test('the refusal names the gateway settings and the path it did not touch', () => {
  const error = bootstrapSkippedError('C:\\Users\\me\\.hermes\\hermes-agent')

  assert.match(error.message, /Settings/)
  assert.match(error.message, /C:\\Users\\me\\.hermes\\hermes-agent/)
})
