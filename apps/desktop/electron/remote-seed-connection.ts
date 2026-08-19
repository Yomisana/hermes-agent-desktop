// Remote-only build helper — optionally pre-seed a remote connection profile
// into Electron's userData/connection.json BEFORE the app resolves its
// backend, so a freshly-installed Desktop connects to the gateway with zero
// user interaction (no first-run-setup screen, no manual form).
//
// Seed source (checked in this order):
//   1. HERMES_DESKTOP_SEED_CONNECTION  — inline JSON string (set by the
//      installer / CI at package time via an env var or NSIS/pkg postinstall
//      script)
//   2. connection.seed.json            — a JSON file shipped alongside the
//      packaged app (extraResources), read once on first launch
//
// This module NEVER overwrites an existing connection.json — it only seeds
// when the user has no connection configured yet, so it is safe to leave
// enabled permanently (re-running the installer / updating the app will not
// clobber a connection the user has since changed by hand).

import fs from 'node:fs'
import path from 'node:path'

export interface SeedConnectionDeps {
  connectionConfigPath: string
  resourcesPath?: string
  env?: NodeJS.ProcessEnv
  log?: (msg: string) => void
}

interface SeedPayload {
  mode: 'remote'
  baseUrl: string
  token?: string
  headers?: Record<string, string>
}

function readSeedFromEnv(env: NodeJS.ProcessEnv): SeedPayload | null {
  const raw = env.HERMES_DESKTOP_SEED_CONNECTION

  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed.baseUrl === 'string' && parsed.baseUrl) {
      return { mode: 'remote', baseUrl: parsed.baseUrl, token: parsed.token, headers: parsed.headers }
    }
  } catch {
    // malformed env JSON — ignore, fall through to file-based seed
  }

  return null
}

function readSeedFromFile(resourcesPath?: string): SeedPayload | null {
  if (!resourcesPath) return null

  const seedPath = path.join(resourcesPath, 'connection.seed.json')

  try {
    const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))

    if (parsed && typeof parsed.baseUrl === 'string' && parsed.baseUrl) {
      return { mode: 'remote', baseUrl: parsed.baseUrl, token: parsed.token, headers: parsed.headers }
    }
  } catch {
    // not present / unreadable / malformed — no seed shipped with this build
  }

  return null
}

/**
 * Idempotent: writes connection.json only if it does not already exist.
 * Call this once, early in main.ts startup, BEFORE resolveHermesBackend() /
 * runPrimaryBackendStartup() read connection.json.
 */
export function seedRemoteConnectionIfMissing(deps: SeedConnectionDeps): boolean {
  const { connectionConfigPath, resourcesPath, env = process.env, log = () => {} } = deps

  if (fs.existsSync(connectionConfigPath)) {
    return false // user already has a connection config — never touch it
  }

  const seed = readSeedFromEnv(env) || readSeedFromFile(resourcesPath)

  if (!seed) {
    return false // no seed configured for this build — normal behavior
  }

  try {
    fs.mkdirSync(path.dirname(connectionConfigPath), { recursive: true })
    fs.writeFileSync(connectionConfigPath, JSON.stringify(seed, null, 2), { mode: 0o600 })
    log(`[remote] seeded remote connection from ${env.HERMES_DESKTOP_SEED_CONNECTION ? 'env' : 'connection.seed.json'} -> ${seed.baseUrl}`)

    return true
  } catch (error) {
    log(`[remote] failed to seed remote connection: ${(error as Error).message}`)

    return false
  }
}
