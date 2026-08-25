// Local Workspace Bridge — lets a remote-only Hermes Desktop expose an
// AUTHORIZED local folder (Windows path, WSL path, or UNC share) to a remote
// Hermes Agent, without installing anything on the user's machine and without
// patching the Hermes server.
//
// Why this exists
// ---------------
// In remote-gateway mode upstream Hermes Desktop routes EVERY filesystem
// operation to the gateway host (see `apps/desktop/src/lib/desktop-fs.ts`:
// `isDesktopFsRemoteMode()` sends readDir / read-text / write-text / git-root /
// default-cwd / the directory picker to `/api/fs/*` and `/api/files*`). The
// agent loop also runs there. So the agent's cwd is the SERVER's home
// (e.g. `/home/username`) and a local `C:\...` or `\\wsl.localhost\...`
// project folder is simply not part of the agent's world. Upstream tracks the
// missing capability as "split runtime" (#18715); `/v1/capabilities` still
// advertises `runtime.split_runtime: false` and no PR implementing it has
// landed.
//
// What this module does instead
// -----------------------------
// It mirrors an authorized local folder to a path on the gateway host and
// keeps the two in sync in both directions, using ONLY endpoints a stock
// Hermes server already serves:
//
//   GET    /api/files?path=      list a remote directory (name/size/mtime)
//   GET    /api/files/read       read a remote file (returns a data: URL)
//   POST   /api/files/upload     write a remote file (accepts a data: URL)
//   POST   /api/files/mkdir      create a remote directory
//   DELETE /api/files            delete a remote file
//
// The agent then works in the mirrored remote path as if it were a normal
// project — which is exactly what a shared cross-agent memory store needs.
//
// This is a MIRROR, not a mount: the agent reads a copy. Latency is one poll
// interval. That trade is deliberate — a true mount needs the server to route
// tool calls back to the client, which is a server-side change this
// desktop-only overlay cannot make.
//
// Kept as a single self-contained file (same rationale as
// `remote-bootstrap-policy.ts`): the only upstream edits are a handful of
// string-anchored lines in `main.ts` and `preload.ts`, so a
// `git rebase upstream/main` has almost no conflict surface.

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One authorized local folder and where it is mirrored on the gateway host. */
export interface BridgeMount {
  /** Stable id; used for the on-disk sync baseline filename. */
  id: string
  /** Local folder. Windows (`C:\src\app`), UNC (`\\wsl.localhost\Ubuntu\home\me\app`), or POSIX (`/home/me/app`, `/mnt/c/src/app`). */
  localPath: string
  /** Absolute POSIX path on the gateway host, e.g. `/home/username/bridge/app`. */
  remotePath: string
  /** `two-way` (default), `push` (local → remote only), or `pull` (remote → local only). */
  mode?: BridgeMode
  /** Extra ignore globs on top of the always-ignored set. */
  ignore?: string[]
  /** Per-file byte cap for this mount; falls back to the top-level cap. */
  maxFileBytes?: number
  /** Desktop connection profile to sync against. Defaults to the active one. */
  profile?: string
}

export type BridgeMode = 'pull' | 'push' | 'two-way'

export interface BridgeConfig {
  /** Master switch. The bridge is inert until this is explicitly true. */
  enabled: boolean
  /** Seconds between sync passes. Clamped to [2, 3600]. */
  intervalSeconds: number
  /** Per-file byte cap. Files above it are skipped and reported. */
  maxFileBytes: number
  /** Safety stop: refuse to sync a mount with more files than this. */
  maxFiles: number
  /** Ignore globs applied to every mount. */
  ignore: string[]
  mounts: BridgeMount[]
}

export interface FileStamp {
  size: number
  mtimeMs: number
}

/** What both sides looked like at the end of the last successful pass. */
export interface BaselineEntry {
  local: FileStamp
  remote: FileStamp
}

export type Baseline = Record<string, BaselineEntry>

export type SyncAction =
  | { rel: string; type: 'deleteLocal' }
  | { rel: string; type: 'deleteRemote' }
  | { rel: string; type: 'mkdirLocal' }
  | { rel: string; type: 'mkdirRemote' }
  | { rel: string; type: 'pull' }
  | { rel: string; type: 'push' }
  | { loser: 'local' | 'remote'; rel: string; type: 'conflict' }

/** Minimal view of the Electron main-process gateway REST bridge. */
export type GatewayApi = (request: {
  body?: unknown
  method?: string
  path: string
  profile?: string
  timeoutMs?: number
}) => Promise<any>

export interface MountStatus {
  error: null | string
  id: string
  lastSyncAt: null | number
  localPath: string
  pulled: number
  pushed: number
  remotePath: string
  removed: number
  skipped: { rel: string; reason: string }[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const BRIDGE_CONFIG_FILENAME = 'local-workspace-bridge.json'

/**
 * Never synced, in either direction.
 *
 * `.env*` and the Hermes credential basenames matter for CORRECTNESS as well
 * as safety: the gateway's managed-files API hides them from list/read
 * (`_is_sensitive_path` in `hermes_cli/web_server.py`), so a pushed `.env`
 * would come back invisible on the next pass and look like a remote deletion —
 * and the bridge would then delete the local original. Keeping them out
 * entirely is the only correct behavior.
 */
export const ALWAYS_IGNORED = [
  '.git',
  '.hg',
  '.svn',
  '.env',
  '.env.*',
  '.envrc',
  'auth.json',
  'credentials.json',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.next',
  '.cache',
  'dist',
  'build',
  'target',
  '*.pyc',
  '*.swp',
  '.DS_Store',
  'Thumbs.db',
  '*.conflict-*'
]

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  enabled: false,
  ignore: [],
  intervalSeconds: 10,
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 5000,
  mounts: []
}

// The gateway caps a managed read at 100 MiB; base64 in a JSON body inflates
// ~33% and buffers in memory on both ends, so hold our own cap well below it.
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024
const MIN_INTERVAL_SECONDS = 2
const MAX_INTERVAL_SECONDS = 3600
// Uploads/downloads are far slower than a status poll; give them their own budget.
const TRANSFER_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// Path helpers
//
// The Electron main process runs on the Windows host, so a WSL project folder
// has to be reached through its UNC form. Upstream already does this for the
// file tree in `wsl-path-bridge.ts`; the conversion is re-implemented here (it
// is ~20 lines) so this overlay stays a single file with no upstream imports.
// ---------------------------------------------------------------------------

const WIN_DRIVE_RE = /^([A-Za-z]):[\\/]/
const WSL_MOUNT_RE = /^\/mnt\/([a-z])(?:\/(.*))?$/i

/**
 * A path as written in config → a path THIS host can actually open.
 *
 * On Windows: `/mnt/c/src/app` → `C:\src\app`, and any other absolute POSIX
 * path → `\\wsl.localhost\<distro>\...`. Everything else passes through.
 */
export function toHostReadablePath(rawPath: string, distro = 'Ubuntu', platform = process.platform): string {
  const value = String(rawPath || '').trim()

  if (platform !== 'win32') {
    return value
  }

  // A UNC path (`\\\\wsl.localhost\\Ubuntu\\...`, `\\\\server\\share`) is ALREADY a
  // Windows-openable path. It also normalizes to a leading `/`, so it has to
  // be caught before the POSIX branch or it gets a second UNC prefix.
  if (/^([\\/]){2}[^\\/]/.test(value)) {
    return value
  }

  const normalized = value.replace(/\\/g, '/')

  if (!normalized.startsWith('/') || WIN_DRIVE_RE.test(value)) {
    return value
  }

  const mount = normalized.match(WSL_MOUNT_RE)

  if (mount) {
    const tail = (mount[2] || '').replace(/\//g, '\\')

    return tail ? `${mount[1].toUpperCase()}:\\${tail}` : `${mount[1].toUpperCase()}:\\`
  }

  return `\\\\wsl.localhost\\${distro}\\${normalized.replace(/^\/+/, '').replace(/\//g, '\\')}`
}

/** Absolute local path → `/`-separated path relative to `root`, or null if outside it. */
export function relativeKey(root: string, absolutePath: string, pathImpl: any = path): null | string {
  const rel = pathImpl.relative(root, absolutePath)

  if (!rel || rel.startsWith('..') || pathImpl.isAbsolute(rel)) {
    return null
  }

  return rel.split(/[\\/]/).join('/')
}

/** Remote root + relative key → absolute POSIX path on the gateway host. */
export function remoteJoin(remoteRoot: string, rel: string): string {
  const root = String(remoteRoot || '').replace(/\/+$/, '')

  return rel ? `${root}/${rel}` : root
}

// ---------------------------------------------------------------------------
// Ignore matching
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')

  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '')
}

/**
 * Build a matcher over `/`-relative keys.
 *
 * A pattern matches a path segment, so `node_modules` prunes the whole tree
 * beneath it. A pattern containing `/` is matched against the full key.
 */
export function createIgnoreMatcher(patterns: string[] = []): (rel: string) => boolean {
  const all = [...ALWAYS_IGNORED, ...patterns].map(entry => String(entry || '').trim()).filter(Boolean)
  const segmentRules = all.filter(entry => !entry.includes('/')).map(globToRegExp)
  const pathRules = all.filter(entry => entry.includes('/')).map(globToRegExp)

  return (rel: string) => {
    const key = String(rel || '')

    if (!key) {
      return false
    }

    if (pathRules.some(rule => rule.test(key))) {
      return true
    }

    return key.split('/').some(segment => segmentRules.some(rule => rule.test(segment)))
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number, fallback: number): number {
  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function normalizeMode(raw: unknown): BridgeMode {
  return raw === 'push' || raw === 'pull' ? raw : 'two-way'
}

/**
 * Validate + normalize a hand-edited config file.
 *
 * Never throws: a malformed file must not brick the app, so bad mounts are
 * dropped and reported. An empty/disabled result means "do nothing", which is
 * byte-for-byte upstream behavior.
 */
export function normalizeBridgeConfig(raw: unknown): { config: BridgeConfig; errors: string[] } {
  const errors: string[] = []
  const source: any = raw && typeof raw === 'object' ? raw : {}

  const maxFileBytes = clamp(
    source.maxFileBytes ?? DEFAULT_BRIDGE_CONFIG.maxFileBytes,
    1024,
    HARD_MAX_FILE_BYTES,
    DEFAULT_BRIDGE_CONFIG.maxFileBytes
  )

  const seenIds = new Set<string>()
  const mounts: BridgeMount[] = []

  for (const [index, entry] of (Array.isArray(source.mounts) ? source.mounts : []).entries()) {
    const item: any = entry && typeof entry === 'object' ? entry : {}
    const localPath = String(item.localPath || '').trim()
    const remotePath = String(item.remotePath || '').trim()
    const label = `mounts[${index}]`

    if (!localPath || !remotePath) {
      errors.push(`${label}: both localPath and remotePath are required`)
      continue
    }

    if (!remotePath.startsWith('/')) {
      errors.push(`${label}: remotePath must be an absolute POSIX path on the gateway host`)
      continue
    }

    // `..` would let a mirrored name escape the mount root on either side.
    if (remotePath.split('/').includes('..')) {
      errors.push(`${label}: remotePath must not contain '..'`)
      continue
    }

    const id = String(item.id || '').trim() || `mount-${index + 1}`

    if (seenIds.has(id)) {
      errors.push(`${label}: duplicate id '${id}'`)
      continue
    }

    seenIds.add(id)
    mounts.push({
      id,
      ignore: Array.isArray(item.ignore) ? item.ignore.map(String) : [],
      localPath,
      maxFileBytes: item.maxFileBytes ? clamp(item.maxFileBytes, 1024, HARD_MAX_FILE_BYTES, maxFileBytes) : maxFileBytes,
      mode: normalizeMode(item.mode),
      profile: String(item.profile || '').trim() || undefined,
      remotePath: remotePath.replace(/\/+$/, '') || '/'
    })
  }

  return {
    config: {
      enabled: source.enabled === true && mounts.length > 0,
      ignore: Array.isArray(source.ignore) ? source.ignore.map(String) : [],
      intervalSeconds: clamp(
        source.intervalSeconds ?? DEFAULT_BRIDGE_CONFIG.intervalSeconds,
        MIN_INTERVAL_SECONDS,
        MAX_INTERVAL_SECONDS,
        DEFAULT_BRIDGE_CONFIG.intervalSeconds
      ),
      maxFileBytes,
      maxFiles: clamp(source.maxFiles ?? DEFAULT_BRIDGE_CONFIG.maxFiles, 1, 200_000, DEFAULT_BRIDGE_CONFIG.maxFiles),
      mounts
    },
    errors
  }
}

/** The commented template written on first run so the file is self-documenting. */
export function bridgeConfigTemplate(): string {
  return JSON.stringify(
    {
      $schema: 'https://github.com/Yomisana/hermes-agent-desktop#local-workspace-bridge',
      $doc: [
        'Authorize local folders for the remote Hermes Agent.',
        'Set enabled=true and restart Hermes Desktop.',
        'localPath: Windows, UNC, or WSL path on THIS machine.',
        'remotePath: absolute path on the Hermes gateway host (point the agent cwd here).',
        'mode: two-way | push | pull',
        '.env / credential files are never synced.'
      ],
      enabled: false,
      intervalSeconds: 10,
      maxFileBytes: 2097152,
      maxFiles: 5000,
      ignore: [],
      mounts: [
        {
          id: 'shared-memory',
          localPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\code-project\\shared-memory',
          remotePath: '/home/username/bridge/shared-memory',
          mode: 'two-way'
        }
      ]
    },
    null,
    2
  )
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export interface TreeScan {
  dirs: string[]
  files: Record<string, FileStamp>
  skipped: { reason: string; rel: string }[]
  truncated: boolean
}

/** Walk the authorized local folder. Symlinks are never followed. */
export async function scanLocalTree(
  root: string,
  options: { fs?: any; ignore?: (rel: string) => boolean; maxFileBytes?: number; maxFiles?: number } = {}
): Promise<TreeScan> {
  const fsImpl = options.fs || fs
  const ignore = options.ignore || (() => false)
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_BRIDGE_CONFIG.maxFileBytes
  const maxFiles = options.maxFiles ?? DEFAULT_BRIDGE_CONFIG.maxFiles
  const scan: TreeScan = { dirs: [], files: {}, skipped: [], truncated: false }
  const queue: string[] = ['']

  while (queue.length) {
    const relDir = queue.shift() as string
    const absDir = relDir ? path.join(root, ...relDir.split('/')) : root
    let dirents

    try {
      dirents = await fsImpl.promises.readdir(absDir, { withFileTypes: true })
    } catch (error: any) {
      scan.skipped.push({ reason: error?.code || 'read-error', rel: relDir })
      continue
    }

    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name

      if (ignore(rel)) {
        continue
      }

      // A symlink could point anywhere, including outside the authorized root.
      if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) {
        scan.skipped.push({ reason: 'symlink', rel })
        continue
      }

      if (dirent.isDirectory()) {
        scan.dirs.push(rel)
        queue.push(rel)
        continue
      }

      if (!dirent.isFile()) {
        continue
      }

      if (Object.keys(scan.files).length >= maxFiles) {
        scan.truncated = true

        return scan
      }

      try {
        const stat = await fsImpl.promises.stat(path.join(absDir, dirent.name))

        if (stat.size > maxFileBytes) {
          scan.skipped.push({ reason: 'too-large', rel })
          continue
        }

        scan.files[rel] = { mtimeMs: Math.round(stat.mtimeMs), size: stat.size }
      } catch (error: any) {
        scan.skipped.push({ reason: error?.code || 'stat-error', rel })
      }
    }
  }

  return scan
}

/**
 * Walk the mirrored folder on the gateway host via `GET /api/files`.
 *
 * A 404 on the root means "not created yet" and scans as empty, so the first
 * pass simply pushes everything up.
 */
export async function scanRemoteTree(
  api: GatewayApi,
  root: string,
  options: { ignore?: (rel: string) => boolean; maxFiles?: number; profile?: string } = {}
): Promise<TreeScan> {
  const ignore = options.ignore || (() => false)
  const maxFiles = options.maxFiles ?? DEFAULT_BRIDGE_CONFIG.maxFiles
  const scan: TreeScan = { dirs: [], files: {}, skipped: [], truncated: false }
  const queue: string[] = ['']

  while (queue.length) {
    const relDir = queue.shift() as string
    let listing

    try {
      listing = await api({
        path: `/api/files?path=${encodeURIComponent(remoteJoin(root, relDir))}`,
        profile: options.profile
      })
    } catch (error: any) {
      // A missing directory is expected on a first run; anything else is real.
      if (/\b404\b/.test(String(error?.message || ''))) {
        continue
      }

      throw error
    }

    for (const entry of listing?.entries || []) {
      const name = String(entry?.name || '')
      const rel = relDir ? `${relDir}/${name}` : name

      if (!name || ignore(rel)) {
        continue
      }

      if (entry.is_directory) {
        scan.dirs.push(rel)
        queue.push(rel)
        continue
      }

      if (Object.keys(scan.files).length >= maxFiles) {
        scan.truncated = true

        return scan
      }

      scan.files[rel] = {
        // The gateway reports mtime in float seconds; keep every stamp in ms.
        mtimeMs: Math.round(Number(entry.mtime || 0) * 1000),
        size: Number(entry.size || 0)
      }
    }
  }

  return scan
}

// ---------------------------------------------------------------------------
// Reconciliation — pure, so the interesting half is unit-testable with no IO
// ---------------------------------------------------------------------------

function stampChanged(current: FileStamp | undefined, baseline: FileStamp | undefined): boolean {
  if (!current || !baseline) {
    return true
  }

  // Whole-second tolerance: the gateway reports float seconds and some
  // filesystems (FAT/exFAT, and drvfs under WSL) round mtimes.
  return current.size !== baseline.size || Math.abs(current.mtimeMs - baseline.mtimeMs) >= 1000
}

/**
 * Decide what to do for every path known to either side.
 *
 * The baseline records what BOTH sides looked like after the last successful
 * pass, which is what makes "deleted here" distinguishable from "added there"
 * — a two-sided mirror cannot tell them apart from the live state alone.
 *
 * Directories are created but never deleted: an empty leftover directory is
 * harmless, whereas a wrongly-inferred recursive delete is not.
 */
export function reconcile(input: {
  baseline: Baseline
  local: TreeScan
  mode?: BridgeMode
  remote: TreeScan
}): SyncAction[] {
  const { baseline, local, remote } = input
  const mode = input.mode || 'two-way'
  const actions: SyncAction[] = []

  const allowPush = mode !== 'pull'
  const allowPull = mode !== 'push'

  for (const rel of remote.dirs) {
    if (allowPull && !local.dirs.includes(rel)) {
      actions.push({ rel, type: 'mkdirLocal' })
    }
  }

  for (const rel of local.dirs) {
    if (allowPush && !remote.dirs.includes(rel)) {
      actions.push({ rel, type: 'mkdirRemote' })
    }
  }

  for (const rel of new Set([...Object.keys(local.files), ...Object.keys(remote.files)])) {
    const localStamp = local.files[rel]
    const remoteStamp = remote.files[rel]
    const base = baseline[rel]

    if (localStamp && !remoteStamp) {
      if (base) {
        // Known to the baseline and now gone upstream → the agent deleted it.
        if (allowPull) {
          actions.push({ rel, type: 'deleteLocal' })
        }
      } else if (allowPush) {
        actions.push({ rel, type: 'push' })
      }

      continue
    }

    if (!localStamp && remoteStamp) {
      if (base) {
        if (allowPush) {
          actions.push({ rel, type: 'deleteRemote' })
        }
      } else if (allowPull) {
        actions.push({ rel, type: 'pull' })
      }

      continue
    }

    if (!localStamp || !remoteStamp) {
      continue
    }

    // No baseline (first run, or userData was reset) but the file exists on
    // both sides. Without this, every already-mirrored file would be reported
    // as a two-sided edit and get a `.conflict-` sidecar. Equal size is the
    // usual rsync-style quick check: adopt it as in-sync and let the next real
    // edit on either side resolve any residual difference.
    if (!base && localStamp.size === remoteStamp.size) {
      continue
    }

    const localChanged = stampChanged(localStamp, base?.local)
    const remoteChanged = stampChanged(remoteStamp, base?.remote)

    if (localChanged && remoteChanged) {
      // Both sides moved. Newest wins; the loser is preserved as a sibling
      // `.conflict-<stamp>` file so a two-way mirror can never lose an edit.
      const loser = localStamp.mtimeMs >= remoteStamp.mtimeMs ? 'remote' : 'local'

      if ((loser === 'remote' && allowPush) || (loser === 'local' && allowPull)) {
        actions.push({ loser, rel, type: 'conflict' })
      }

      continue
    }

    if (localChanged && allowPush) {
      actions.push({ rel, type: 'push' })
      continue
    }

    if (remoteChanged && allowPull) {
      actions.push({ rel, type: 'pull' })
    }
  }

  return actions
}

// ---------------------------------------------------------------------------
// Transport — thin wrappers over the stock managed-files API
// ---------------------------------------------------------------------------

function dataUrlToBuffer(dataUrl: string): Buffer {
  const text = String(dataUrl || '')
  const comma = text.indexOf(',')

  if (!text.startsWith('data:') || comma < 0) {
    throw new Error('Gateway returned a malformed data URL')
  }

  return Buffer.from(text.slice(comma + 1), 'base64')
}

export async function remoteMkdir(api: GatewayApi, remotePath: string, profile?: string): Promise<void> {
  await api({ body: { path: remotePath }, method: 'POST', path: '/api/files/mkdir', profile })
}

export async function remoteReadFile(api: GatewayApi, remotePath: string, profile?: string): Promise<Buffer> {
  const result = await api({
    path: `/api/files/read?path=${encodeURIComponent(remotePath)}`,
    profile,
    timeoutMs: TRANSFER_TIMEOUT_MS
  })

  return dataUrlToBuffer(result?.data_url)
}

export async function remoteWriteFile(
  api: GatewayApi,
  remotePath: string,
  bytes: Buffer,
  profile?: string
): Promise<void> {
  await api({
    body: {
      data_url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
      overwrite: true,
      path: remotePath
    },
    method: 'POST',
    path: '/api/files/upload',
    profile,
    timeoutMs: TRANSFER_TIMEOUT_MS
  })
}

export async function remoteDeleteFile(api: GatewayApi, remotePath: string, profile?: string): Promise<void> {
  await api({ body: { path: remotePath, recursive: false }, method: 'DELETE', path: '/api/files', profile })
}

// ---------------------------------------------------------------------------
// Config + baseline persistence
// ---------------------------------------------------------------------------

/**
 * Read the config, writing a commented template on first run.
 *
 * Any failure degrades to "disabled" rather than throwing: this runs during
 * main-process startup and must never be able to prevent the app from opening.
 */
export function readBridgeConfig(
  configPath: string,
  fsImpl: any = fs
): { config: BridgeConfig; errors: string[] } {
  try {
    return normalizeBridgeConfig(JSON.parse(fsImpl.readFileSync(configPath, 'utf8')))
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      try {
        fsImpl.mkdirSync(path.dirname(configPath), { recursive: true })
        fsImpl.writeFileSync(configPath, `${bridgeConfigTemplate()}\n`, 'utf8')
      } catch {
        // Read-only userData — the bridge simply stays off.
      }

      return { config: { ...DEFAULT_BRIDGE_CONFIG }, errors: [] }
    }

    return {
      config: { ...DEFAULT_BRIDGE_CONFIG },
      errors: [`${BRIDGE_CONFIG_FILENAME}: ${error?.message || 'unreadable'}`]
    }
  }
}

export function baselinePath(stateDir: string, mountId: string): string {
  return path.join(stateDir, `local-workspace-bridge-${mountId.replace(/[^\w.-]/g, '_')}.baseline.json`)
}

function readBaseline(file: string, fsImpl: any): Baseline {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // No baseline yet (or a corrupt one): treat both sides as new. That
    // resolves to pushes/pulls, never deletions, which is the safe direction.
    return {}
  }
}

function writeBaseline(file: string, baseline: Baseline, fsImpl: any): void {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true })
    fsImpl.writeFileSync(file, JSON.stringify(baseline), 'utf8')
  } catch {
    // Losing the baseline costs a redundant pass, not correctness.
  }
}

export function baselineFrom(local: TreeScan, remote: TreeScan): Baseline {
  const baseline: Baseline = {}

  for (const rel of Object.keys(local.files)) {
    if (remote.files[rel]) {
      baseline[rel] = { local: local.files[rel], remote: remote.files[rel] }
    }
  }

  return baseline
}

// ---------------------------------------------------------------------------
// One sync pass
// ---------------------------------------------------------------------------

function conflictName(rel: string, now: number): string {
  return `${rel}.conflict-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
}

/** mkdirs first, then transfers, then deletes — so a rename can't lose data. */
const ACTION_ORDER: Record<SyncAction['type'], number> = {
  conflict: 1,
  deleteLocal: 2,
  deleteRemote: 2,
  mkdirLocal: 0,
  mkdirRemote: 0,
  pull: 1,
  push: 1
}

export async function syncMount(
  mount: BridgeMount,
  options: {
    api: GatewayApi
    config: BridgeConfig
    fs?: any
    now?: () => number
    platform?: string
    profile?: string
    stateDir: string
    wslDistro?: string
  }
): Promise<MountStatus> {
  const fsImpl = options.fs || fs
  const now = options.now || Date.now
  const api = options.api
  const localRoot = toHostReadablePath(mount.localPath, options.wslDistro || 'Ubuntu', options.platform)
  const status: MountStatus = {
    error: null,
    id: mount.id,
    lastSyncAt: null,
    localPath: localRoot,
    pulled: 0,
    pushed: 0,
    remotePath: mount.remotePath,
    removed: 0,
    skipped: []
  }

  const ignore = createIgnoreMatcher([...(options.config.ignore || []), ...(mount.ignore || [])])
  const scanOptions = {
    fs: fsImpl,
    ignore,
    maxFileBytes: mount.maxFileBytes ?? options.config.maxFileBytes,
    maxFiles: options.config.maxFiles
  }

  try {
    // An unreadable local root is the common misconfiguration (wrong WSL
    // distro, drive not mounted). Fail this mount loudly and leave the remote
    // side untouched — an empty scan would otherwise read as "delete it all".
    const rootStat = await fsImpl.promises.stat(localRoot)

    if (!rootStat.isDirectory()) {
      throw new Error('localPath is not a directory')
    }
  } catch (error: any) {
    status.error = `local folder unavailable (${localRoot}): ${error?.code || error?.message}`

    return status
  }

  const file = baselinePath(options.stateDir, mount.id)

  try {
    await remoteMkdir(api, mount.remotePath, options.profile)

    let local = await scanLocalTree(localRoot, scanOptions)
    let remote = await scanRemoteTree(api, mount.remotePath, {
      ignore,
      maxFiles: options.config.maxFiles,
      profile: options.profile
    })

    status.skipped = local.skipped

    if (local.truncated || remote.truncated) {
      status.error = `more than ${options.config.maxFiles} files; raise maxFiles or narrow the mount`

      return status
    }

    const baseline = readBaseline(file, fsImpl)
    const actions = reconcile({ baseline, local, mode: mount.mode, remote }).sort(
      (a, b) => ACTION_ORDER[a.type] - ACTION_ORDER[b.type]
    )

    for (const action of actions) {
      const absLocal = path.join(localRoot, ...action.rel.split('/'))
      const absRemote = remoteJoin(mount.remotePath, action.rel)

      switch (action.type) {
        case 'mkdirLocal':
          await fsImpl.promises.mkdir(absLocal, { recursive: true })
          break

        case 'mkdirRemote':
          await remoteMkdir(api, absRemote, options.profile)
          break

        case 'push':
          await remoteWriteFile(api, absRemote, await fsImpl.promises.readFile(absLocal), options.profile)
          status.pushed += 1
          break

        case 'pull':
          await fsImpl.promises.mkdir(path.dirname(absLocal), { recursive: true })
          await fsImpl.promises.writeFile(absLocal, await remoteReadFile(api, absRemote, options.profile))
          status.pulled += 1
          break

        case 'deleteLocal':
          await fsImpl.promises.rm(absLocal, { force: true })
          status.removed += 1
          break

        case 'deleteRemote':
          await remoteDeleteFile(api, absRemote, options.profile)
          status.removed += 1
          break

        case 'conflict': {
          // Both sides changed since the last pass. Keep the newer edit live
          // and park the older one beside it locally; `.conflict-*` is in
          // ALWAYS_IGNORED, so the sidecar never syncs anywhere.
          const sidecar = path.join(localRoot, ...conflictName(action.rel, now()).split('/'))

          await fsImpl.promises.mkdir(path.dirname(sidecar), { recursive: true })

          if (action.loser === 'remote') {
            await fsImpl.promises.writeFile(sidecar, await remoteReadFile(api, absRemote, options.profile))
            await remoteWriteFile(api, absRemote, await fsImpl.promises.readFile(absLocal), options.profile)
            status.pushed += 1
          } else {
            await fsImpl.promises.copyFile(absLocal, sidecar)
            await fsImpl.promises.writeFile(absLocal, await remoteReadFile(api, absRemote, options.profile))
            status.pulled += 1
          }

          status.skipped.push({ reason: `conflict — older ${action.loser} copy kept beside it`, rel: action.rel })
          break
        }
      }
    }

    // Re-stamp both sides after mutating them, so the next pass compares
    // against what is actually on disk rather than against pre-transfer stats.
    if (actions.length) {
      local = await scanLocalTree(localRoot, scanOptions)
      remote = await scanRemoteTree(api, mount.remotePath, {
        ignore,
        maxFiles: options.config.maxFiles,
        profile: options.profile
      })
    }

    writeBaseline(file, baselineFrom(local, remote), fsImpl)
    status.lastSyncAt = now()
  } catch (error: any) {
    status.error = String(error?.message || error)
  }

  return status
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface BridgeRunner {
  getStatus: () => { config: BridgeConfig; errors: string[]; mounts: MountStatus[]; running: boolean }
  reload: () => void
  start: () => void
  stop: () => void
  syncNow: () => Promise<MountStatus[]>
}

/**
 * Drive `syncMount` on a timer.
 *
 * Passes never overlap (a slow pass just delays the next one) and a failing
 * mount never blocks its peers, so one unplugged drive can't stall the rest.
 */
export function createBridgeRunner(deps: {
  api: GatewayApi
  configPath: string
  fs?: any
  log?: (message: string) => void
  now?: () => number
  platform?: string
  profile?: () => string | undefined
  stateDir: string
  wslDistro?: string
}): BridgeRunner {
  const fsImpl = deps.fs || fs
  const log = deps.log || (() => {})
  let { config, errors } = readBridgeConfig(deps.configPath, fsImpl)
  let statuses: MountStatus[] = []
  let timer: any = null
  let inFlight = false

  async function pass(): Promise<MountStatus[]> {
    if (inFlight) {
      return statuses
    }

    inFlight = true

    try {
      const results: MountStatus[] = []

      for (const mount of config.mounts) {
        results.push(
          await syncMount(mount, {
            api: deps.api,
            config,
            fs: fsImpl,
            now: deps.now,
            platform: deps.platform,
            profile: mount.profile ?? deps.profile?.(),
            stateDir: deps.stateDir,
            wslDistro: deps.wslDistro
          })
        )
      }

      statuses = results

      for (const result of results) {
        if (result.error) {
          log(`[local-bridge] ${result.id}: ${result.error}`)
        } else if (result.pushed || result.pulled || result.removed) {
          log(`[local-bridge] ${result.id}: +${result.pushed} ↑ / +${result.pulled} ↓ / ${result.removed} removed`)
        }
      }

      return results
    } finally {
      inFlight = false
    }
  }

  function start() {
    if (timer || !config.enabled) {
      return
    }

    log(`[local-bridge] enabled for ${config.mounts.length} mount(s), every ${config.intervalSeconds}s`)
    timer = setInterval(() => {
      pass().catch(error => log(`[local-bridge] pass failed: ${error?.message || error}`))
    }, config.intervalSeconds * 1000)

    // Node keeps the event loop alive for pending timers; this one must not
    // hold up quit.
    timer.unref?.()
    pass().catch(error => log(`[local-bridge] first pass failed: ${error?.message || error}`))
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    getStatus: () => ({ config, errors, mounts: statuses, running: Boolean(timer) }),
    reload: () => {
      stop()
      ;({ config, errors } = readBridgeConfig(deps.configPath, fsImpl))
      statuses = []
      start()
    },
    start,
    stop,
    syncNow: pass
  }
}
