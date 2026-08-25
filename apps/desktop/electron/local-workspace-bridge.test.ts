import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import {
  ALWAYS_IGNORED,
  type Baseline,
  baselineFrom,
  createIgnoreMatcher,
  normalizeBridgeConfig,
  reconcile,
  relativeKey,
  remoteJoin,
  scanLocalTree,
  scanRemoteTree,
  syncMount,
  toHostReadablePath,
  type TreeScan
} from './local-workspace-bridge'

// ---------------------------------------------------------------------------
// A fake gateway: an in-memory filesystem behind the five managed-files
// endpoints the bridge uses. Mirrors the real server's shapes — `is_directory`,
// float-seconds `mtime`, data: URLs — so the tests exercise the real wire
// contract rather than a convenient stand-in.
// ---------------------------------------------------------------------------

function fakeGateway(seed: Record<string, string> = {}) {
  const files = new Map<string, { bytes: Buffer; mtime: number }>()
  const dirs = new Set<string>()
  let clock = 1_700_000_000

  function addDirs(filePath: string) {
    let parent = path.posix.dirname(filePath)

    while (parent && parent !== '/' && !dirs.has(parent)) {
      dirs.add(parent)
      parent = path.posix.dirname(parent)
    }
  }

  for (const [key, value] of Object.entries(seed)) {
    files.set(key, { bytes: Buffer.from(value), mtime: clock })
    addDirs(key)
  }

  const api = async (request: any) => {
    const [route, query] = String(request.path).split('?')
    const target = new URLSearchParams(query || '').get('path') || (request.body as any)?.path

    if (route === '/api/files') {
      if (request.method === 'DELETE') {
        files.delete(target)

        return { ok: true }
      }

      if (!dirs.has(target) && ![...files.keys()].some(key => key.startsWith(`${target}/`))) {
        throw new Error(`404: Path not found`)
      }

      const entries: any[] = []
      const prefix = `${target}/`

      for (const child of dirs) {
        if (child.startsWith(prefix) && !child.slice(prefix.length).includes('/')) {
          entries.push({ is_directory: true, mtime: clock, name: path.posix.basename(child), size: null })
        }
      }

      for (const [key, value] of files) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          entries.push({
            is_directory: false,
            mtime: value.mtime,
            name: path.posix.basename(key),
            size: value.bytes.length
          })
        }
      }

      return { entries, path: target }
    }

    if (route === '/api/files/read') {
      const hit = files.get(target)

      if (!hit) {
        throw new Error('404: File not found')
      }

      return { data_url: `data:application/octet-stream;base64,${hit.bytes.toString('base64')}` }
    }

    if (route === '/api/files/mkdir') {
      dirs.add(target)
      addDirs(`${target}/x`)

      return { ok: true }
    }

    if (route === '/api/files/upload') {
      const encoded = String((request.body as any).data_url).split(',')[1]
      files.set(target, { bytes: Buffer.from(encoded, 'base64'), mtime: (clock += 1) })
      addDirs(target)

      return { ok: true }
    }

    throw new Error(`unexpected route ${route}`)
  }

  return {
    api,
    dirs,
    files,
    read: (key: string) => files.get(key)?.bytes.toString('utf8'),
    touch: (key: string, value: string) => files.set(key, { bytes: Buffer.from(value), mtime: (clock += 10) })
  }
}

let workdir = ''

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bridge-'))
})

afterEach(() => {
  fs.rmSync(workdir, { force: true, recursive: true })
})

function localRoot() {
  const root = path.join(workdir, 'project')
  fs.mkdirSync(root, { recursive: true })

  return root
}

function writeLocal(root: string, rel: string, content: string) {
  const target = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function emptyScan(): TreeScan {
  return { dirs: [], files: {}, skipped: [], truncated: false }
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

test('WSL and drive paths resolve to something the Windows host can open', () => {
  assert.equal(toHostReadablePath('/mnt/c/src/app', 'Ubuntu', 'win32'), 'C:\\src\\app')
  assert.equal(toHostReadablePath('/home/me/app', 'Ubuntu', 'win32'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
  assert.equal(toHostReadablePath('/home/me/app', 'Debian', 'win32'), '\\\\wsl.localhost\\Debian\\home\\me\\app')
  assert.equal(toHostReadablePath('C:\\src\\app', 'Ubuntu', 'win32'), 'C:\\src\\app')
})

test('a UNC path is already Windows-openable and must not be re-prefixed', () => {
  // It normalizes to a leading `/`, so without an explicit guard it would come
  // back as \\\\wsl.localhost\\Ubuntu\\wsl.localhost\\Ubuntu\\...
  const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'

  assert.equal(toHostReadablePath(unc, 'Ubuntu', 'win32'), unc)
  assert.equal(toHostReadablePath('\\\\fileserver\\share\\team', 'Ubuntu', 'win32'), '\\\\fileserver\\share\\team')
})

test('POSIX hosts pass their own paths through untouched', () => {
  assert.equal(toHostReadablePath('/home/me/app', 'Ubuntu', 'linux'), '/home/me/app')
})

test('relativeKey refuses to leave the authorized root', () => {
  assert.equal(relativeKey('/root', '/root/a/b.txt', path.posix), 'a/b.txt')
  assert.equal(relativeKey('/root', '/elsewhere/b.txt', path.posix), null)
  assert.equal(relativeKey('/root', '/root', path.posix), null)
})

test('remoteJoin builds POSIX paths and tolerates a trailing slash', () => {
  assert.equal(remoteJoin('/home/username/bridge/', 'notes/a.md'), '/home/username/bridge/notes/a.md')
  assert.equal(remoteJoin('/home/username/bridge', ''), '/home/username/bridge')
})

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

test('credential files are never syncable', () => {
  const ignore = createIgnoreMatcher()

  // The gateway hides these from list/read, so syncing one would read back as
  // a remote deletion on the next pass and delete the local original.
  for (const rel of ['.env', '.env.local', '.envrc', 'app/.env.production', 'auth.json']) {
    assert.equal(ignore(rel), true, `${rel} must be ignored`)
  }

  assert.ok(ALWAYS_IGNORED.includes('.env'))
})

test('ignore patterns prune whole subtrees and honor globs', () => {
  const ignore = createIgnoreMatcher(['*.log', 'docs/private/*'])

  assert.equal(ignore('node_modules/react/index.js'), true)
  assert.equal(ignore('src/.git/config'), true)
  assert.equal(ignore('run.log'), true)
  assert.equal(ignore('docs/private/secret.md'), true)
  assert.equal(ignore('src/index.ts'), false)
  assert.equal(ignore('docs/public.md'), false)
})

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('a mount is rejected unless it names both sides with an absolute remote path', () => {
  const { config, errors } = normalizeBridgeConfig({
    enabled: true,
    mounts: [
      { id: 'ok', localPath: 'C:\\src', remotePath: '/home/username/src' },
      { id: 'relative', localPath: 'C:\\src', remotePath: 'home/username/src' },
      { id: 'escape', localPath: 'C:\\src', remotePath: '/home/../etc' },
      { id: 'half', localPath: 'C:\\src' }
    ]
  })

  assert.deepEqual(
    config.mounts.map(mount => mount.id),
    ['ok']
  )
  assert.equal(errors.length, 3)
})

test('the bridge stays off unless explicitly enabled with a usable mount', () => {
  assert.equal(normalizeBridgeConfig({}).config.enabled, false)
  assert.equal(normalizeBridgeConfig({ enabled: true, mounts: [] }).config.enabled, false)
  assert.equal(normalizeBridgeConfig('garbage').config.enabled, false)
  assert.equal(normalizeBridgeConfig(null).config.mounts.length, 0)
})

test('interval and size limits are clamped rather than trusted', () => {
  assert.equal(normalizeBridgeConfig({ intervalSeconds: 0 }).config.intervalSeconds, 2)
  assert.equal(normalizeBridgeConfig({ intervalSeconds: 99999 }).config.intervalSeconds, 3600)
  assert.equal(normalizeBridgeConfig({ maxFileBytes: 1e12 }).config.maxFileBytes, 16 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

test('a first pass with no baseline only ever adds, never deletes', () => {
  const local: TreeScan = { ...emptyScan(), files: { 'a.md': { mtimeMs: 1000, size: 1 } } }
  const remote: TreeScan = { ...emptyScan(), files: { 'b.md': { mtimeMs: 1000, size: 1 } } }

  assert.deepEqual(reconcile({ baseline: {}, local, remote }), [
    { rel: 'a.md', type: 'push' },
    { rel: 'b.md', type: 'pull' }
  ])
})

test('the baseline is what distinguishes "deleted here" from "added there"', () => {
  const stamp = { mtimeMs: 1000, size: 1 }
  const baseline: Baseline = { 'gone.md': { local: stamp, remote: stamp } }

  // Present locally, absent remotely, and known to the baseline → the agent
  // deleted it upstream, so it goes here too.
  assert.deepEqual(
    reconcile({ baseline, local: { ...emptyScan(), files: { 'gone.md': stamp } }, remote: emptyScan() }),
    [{ rel: 'gone.md', type: 'deleteLocal' }]
  )

  assert.deepEqual(
    reconcile({ baseline, local: emptyScan(), remote: { ...emptyScan(), files: { 'gone.md': stamp } } }),
    [{ rel: 'gone.md', type: 'deleteRemote' }]
  )
})

test('a reinstall does not turn every already-mirrored file into a conflict', () => {
  // userData (and with it the baseline) is gone, but both sides still hold the
  // same file. Same size => adopt as in-sync rather than raising a conflict.
  const stamp = { mtimeMs: 1000, size: 42 }
  const local = { ...emptyScan(), files: { 'a.md': stamp } }
  const remote = { ...emptyScan(), files: { 'a.md': { mtimeMs: 8000, size: 42 } } }

  assert.deepEqual(reconcile({ baseline: {}, local, remote }), [])
})

test('differing sizes with no baseline still resolve as a conflict', () => {
  const local = { ...emptyScan(), files: { 'a.md': { mtimeMs: 9000, size: 10 } } }
  const remote = { ...emptyScan(), files: { 'a.md': { mtimeMs: 1000, size: 20 } } }

  assert.deepEqual(reconcile({ baseline: {}, local, remote }), [{ loser: 'remote', rel: 'a.md', type: 'conflict' }])
})

test('an unchanged file produces no work', () => {
  const stamp = { mtimeMs: 1000, size: 3 }
  const scan = { ...emptyScan(), files: { 'a.md': stamp } }

  assert.deepEqual(reconcile({ baseline: { 'a.md': { local: stamp, remote: stamp } }, local: scan, remote: scan }), [])
})

test('mtimes within a second are treated as unchanged', () => {
  // The gateway reports float seconds, and drvfs rounds; a sub-second delta
  // must not spin the mirror into a permanent push/pull loop.
  const base = { mtimeMs: 1_000_000, size: 3 }
  const local = { ...emptyScan(), files: { 'a.md': { mtimeMs: 1_000_400, size: 3 } } }
  const remote = { ...emptyScan(), files: { 'a.md': base } }

  assert.deepEqual(reconcile({ baseline: { 'a.md': { local: base, remote: base } }, local, remote }), [])
})

test('a two-sided edit resolves newest-wins and never silently drops the loser', () => {
  const base = { mtimeMs: 1000, size: 1 }
  const baseline: Baseline = { 'a.md': { local: base, remote: base } }
  const newerLocal = { ...emptyScan(), files: { 'a.md': { mtimeMs: 9000, size: 2 } } }
  const olderRemote = { ...emptyScan(), files: { 'a.md': { mtimeMs: 5000, size: 2 } } }

  assert.deepEqual(reconcile({ baseline, local: newerLocal, remote: olderRemote }), [
    { loser: 'remote', rel: 'a.md', type: 'conflict' }
  ])

  assert.deepEqual(reconcile({ baseline, local: olderRemote, remote: newerLocal }), [
    { loser: 'local', rel: 'a.md', type: 'conflict' }
  ])
})

test('push mode never writes locally and pull mode never writes remotely', () => {
  const stamp = { mtimeMs: 1000, size: 1 }
  const local: TreeScan = { ...emptyScan(), dirs: ['src'], files: { 'a.md': stamp } }
  const remote: TreeScan = { ...emptyScan(), dirs: ['docs'], files: { 'b.md': stamp } }

  assert.deepEqual(reconcile({ baseline: {}, local, mode: 'push', remote }), [
    { rel: 'src', type: 'mkdirRemote' },
    { rel: 'a.md', type: 'push' }
  ])

  assert.deepEqual(reconcile({ baseline: {}, local, mode: 'pull', remote }), [
    { rel: 'docs', type: 'mkdirLocal' },
    { rel: 'b.md', type: 'pull' }
  ])
})

test('directories are created but never deleted', () => {
  const baseline: Baseline = {}
  const actions = reconcile({ baseline, local: emptyScan(), remote: { ...emptyScan(), dirs: ['stale'] } })

  assert.deepEqual(actions, [{ rel: 'stale', type: 'mkdirLocal' }])
  assert.ok(!actions.some(action => String(action.type).startsWith('delete')))
})

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

test('the local scan skips symlinks and oversized files', async () => {
  const root = localRoot()
  writeLocal(root, 'small.txt', 'hi')
  writeLocal(root, 'big.txt', 'x'.repeat(5000))
  writeLocal(root, 'nested/deep.txt', 'deep')
  writeLocal(root, 'node_modules/pkg/index.js', 'nope')

  try {
    fs.symlinkSync(path.join(root, 'small.txt'), path.join(root, 'link.txt'))
  } catch {
    // Windows without developer mode can't create symlinks; the rest still holds.
  }

  const scan = await scanLocalTree(root, { ignore: createIgnoreMatcher(), maxFileBytes: 1000 })

  assert.deepEqual(Object.keys(scan.files).sort(), ['nested/deep.txt', 'small.txt'])
  assert.ok(scan.dirs.includes('nested'))
  assert.ok(!scan.dirs.includes('node_modules'))
  assert.ok(scan.skipped.some(entry => entry.rel === 'big.txt' && entry.reason === 'too-large'))
})

test('the local scan stops at maxFiles instead of syncing a runaway tree', async () => {
  const root = localRoot()

  for (let index = 0; index < 20; index += 1) {
    writeLocal(root, `file-${index}.txt`, String(index))
  }

  const scan = await scanLocalTree(root, { maxFiles: 5 })

  assert.equal(scan.truncated, true)
})

test('a remote root that does not exist yet scans as empty', async () => {
  const gateway = fakeGateway()
  const scan = await scanRemoteTree(gateway.api, '/home/username/bridge')

  assert.deepEqual(scan.files, {})
  assert.equal(scan.truncated, false)
})

test('the remote scan converts float-second mtimes into milliseconds', async () => {
  const gateway = fakeGateway({ '/bridge/a.md': 'hello' })
  const scan = await scanRemoteTree(gateway.api, '/bridge')

  assert.equal(scan.files['a.md'].size, 5)
  assert.equal(scan.files['a.md'].mtimeMs, 1_700_000_000_000)
})

// ---------------------------------------------------------------------------
// End-to-end passes against the fake gateway
// ---------------------------------------------------------------------------

const mount = { id: 'test', localPath: '', mode: 'two-way' as const, remotePath: '/bridge' }

function runOptions(gateway: ReturnType<typeof fakeGateway>, root: string) {
  return {
    api: gateway.api,
    config: normalizeBridgeConfig({ enabled: true, mounts: [{ localPath: root, remotePath: '/bridge' }] }).config,
    platform: 'linux',
    stateDir: path.join(workdir, 'state')
  }
}

test('first pass uploads the authorized folder to the gateway', async () => {
  const root = localRoot()
  writeLocal(root, 'notes/memory.md', 'shared memory')
  writeLocal(root, 'README.md', 'hello')

  const gateway = fakeGateway()
  const status = await syncMount({ ...mount, localPath: root }, runOptions(gateway, root))

  assert.equal(status.error, null)
  assert.equal(status.pushed, 2)
  assert.equal(gateway.read('/bridge/notes/memory.md'), 'shared memory')
  assert.equal(gateway.read('/bridge/README.md'), 'hello')
})

test('a file the agent writes on the gateway lands in the local folder', async () => {
  const root = localRoot()
  const gateway = fakeGateway()
  const options = runOptions(gateway, root)

  await syncMount({ ...mount, localPath: root }, options)
  gateway.touch('/bridge/agent-note.md', 'written by the agent')

  const status = await syncMount({ ...mount, localPath: root }, options)

  assert.equal(status.pulled, 1)
  assert.equal(fs.readFileSync(path.join(root, 'agent-note.md'), 'utf8'), 'written by the agent')
})

test('a steady state produces no transfers', async () => {
  const root = localRoot()
  writeLocal(root, 'a.md', 'stable')

  const gateway = fakeGateway()
  const options = runOptions(gateway, root)

  await syncMount({ ...mount, localPath: root }, options)
  const second = await syncMount({ ...mount, localPath: root }, options)

  assert.deepEqual([second.pushed, second.pulled, second.removed], [0, 0, 0])
})

test('a deletion on either side propagates once a baseline exists', async () => {
  const root = localRoot()
  writeLocal(root, 'a.md', 'one')
  writeLocal(root, 'b.md', 'two')

  const gateway = fakeGateway()
  const options = runOptions(gateway, root)

  await syncMount({ ...mount, localPath: root }, options)
  fs.rmSync(path.join(root, 'a.md'))
  gateway.files.delete('/bridge/b.md')

  const status = await syncMount({ ...mount, localPath: root }, options)

  assert.equal(status.removed, 2)
  assert.equal(gateway.read('/bridge/a.md'), undefined)
  assert.equal(fs.existsSync(path.join(root, 'b.md')), false)
})

test('a two-sided edit keeps both copies', async () => {
  const root = localRoot()
  writeLocal(root, 'shared.md', 'original')

  const gateway = fakeGateway()
  const options = runOptions(gateway, root)

  await syncMount({ ...mount, localPath: root }, options)

  // The agent edits it upstream while the user edits it here.
  gateway.touch('/bridge/shared.md', 'agent version')
  fs.writeFileSync(path.join(root, 'shared.md'), 'my version')
  fs.utimesSync(path.join(root, 'shared.md'), new Date(), new Date(Date.now() + 60_000))

  const status = await syncMount({ ...mount, localPath: root }, options)
  const conflicts = fs.readdirSync(root).filter(name => name.includes('.conflict-'))

  assert.equal(status.skipped.some(entry => entry.reason.startsWith('conflict')), true)
  assert.equal(conflicts.length, 1)
  assert.equal(fs.readFileSync(path.join(root, conflicts[0]), 'utf8'), 'agent version')
  assert.equal(fs.readFileSync(path.join(root, 'shared.md'), 'utf8'), 'my version')
})

test('an unreachable local folder reports an error and touches nothing remote', async () => {
  const root = path.join(workdir, 'does-not-exist')
  const gateway = fakeGateway({ '/bridge/keep.md': 'still here' })
  const status = await syncMount({ ...mount, localPath: root }, runOptions(gateway, root))

  assert.ok(status.error)
  assert.match(status.error as string, /local folder unavailable/)
  assert.equal(gateway.read('/bridge/keep.md'), 'still here')
})

test('a credential file is never uploaded', async () => {
  const root = localRoot()
  writeLocal(root, '.env', 'API_KEY=super-secret')
  writeLocal(root, 'app.py', 'print(1)')

  const gateway = fakeGateway()
  const status = await syncMount({ ...mount, localPath: root }, runOptions(gateway, root))

  assert.equal(status.pushed, 1)
  assert.equal(gateway.read('/bridge/.env'), undefined)
})

test('baselineFrom only records paths both sides actually agree on', () => {
  const stamp = { mtimeMs: 1, size: 1 }
  const baseline = baselineFrom(
    { ...emptyScan(), files: { 'both.md': stamp, 'localOnly.md': stamp } },
    { ...emptyScan(), files: { 'both.md': stamp, 'remoteOnly.md': stamp } }
  )

  assert.deepEqual(Object.keys(baseline), ['both.md'])
})
