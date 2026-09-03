// Remote-only build policy — controls whether Hermes Desktop is allowed to
// silently bootstrap (install) a local Hermes Agent runtime on this machine.
//
// Rationale: some builds distribute a company-managed remote Hermes backend.
// End users (often non-technical) should never trigger a local Python/Git/uv
// install just because Desktop can't find a local runtime — they should
// configure their remote connection explicitly in Desktop settings.
//
// This file is intentionally the ONLY new file imported by main.ts. Keeping
// the policy here (instead of inlining logic across main.ts) keeps the diff
// against upstream to an absolute minimum, so `git rebase upstream/main`
// conflicts are limited to a couple of lines at the single call site.

export interface BootstrapPolicyEnv {
  HERMES_DESKTOP_SKIP_BOOTSTRAP?: string
  HERMES_DESKTOP_REMOTE_ONLY?: string
  HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP?: string
}

/**
 * Returns true when local-runtime auto-install (install.ps1 / install.sh /
 * uv-managed venv creation) must be skipped entirely.
 *
 * Packaged builds of THIS overlay are remote-only by definition — that is the
 * whole point of the build — so `isPackaged` alone is enough. Relying on
 * HERMES_DESKTOP_REMOTE_ONLY did not work: CI sets it while electron-builder
 * runs, but env vars do not survive into the installed app, so the guard read
 * false on every user's machine and upstream's installer ran anyway.
 *
 * Explicit env still wins in both directions:
 *   HERMES_DESKTOP_SKIP_BOOTSTRAP=true       force skip (e.g. `npm run dev`)
 *   HERMES_DESKTOP_REMOTE_ONLY=true          semantic alias, same effect
 *   HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP=true escape hatch: let a packaged
 *                                            build install a local runtime
 *
 * All must be the exact string 'true'. An unpackaged run with no env set falls
 * through to upstream's normal behavior, so developing against this overlay is
 * unchanged.
 */
export function shouldSkipAutoBootstrap(
  env: BootstrapPolicyEnv = process.env as BootstrapPolicyEnv,
  isPackaged = false
): boolean {
  if (env.HERMES_DESKTOP_SKIP_BOOTSTRAP === 'true' || env.HERMES_DESKTOP_REMOTE_ONLY === 'true') {
    return true
  }

  return isPackaged && env.HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP !== 'true'
}

/**
 * User-facing error shown instead of running the installer, when
 * shouldSkipAutoBootstrap() is true and no local runtime was found.
 */
export function bootstrapSkippedError(activeRoot: string): Error {
  return new Error(
      'This build of Hermes Desktop does not auto-install a local Hermes Agent runtime.\n\n' +
      '請至 Settings → Gateway → Remote gateway 設定遠端連線資訊，\n' +
      '或聯絡 Server 管理者取得連線資訊。\n\n' +
      `(Local runtime would have been installed at: ${activeRoot})`
  )
}
