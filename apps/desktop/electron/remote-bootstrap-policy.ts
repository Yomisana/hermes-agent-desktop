// Remote-only build policy — controls whether Hermes Desktop is allowed to
// silently bootstrap (install) a local Hermes Agent runtime on this machine.
//
// Rationale: some builds distribute a company-managed remote Hermes backend.
// End users (often non-technical) should never trigger a local Python/Git/uv
// install just because Desktop can't find a local runtime — they should
// either already have a pre-seeded remote connection (see
// remote-seed-connection.ts) or be told clearly to configure one.
//
// This file is intentionally the ONLY new file imported by main.ts. Keeping
// the policy here (instead of inlining logic across main.ts) keeps the diff
// against upstream to an absolute minimum, so `git rebase upstream/main`
// conflicts are limited to a couple of lines at the single call site.

export interface BootstrapPolicyEnv {
  HERMES_DESKTOP_SKIP_BOOTSTRAP?: string
  HERMES_DESKTOP_REMOTE_ONLY?: string
}

/**
 * Returns true when local-runtime auto-install (install.ps1 / install.sh /
 * uv-managed venv creation) must be skipped entirely.
 *
 * Enabled by either:
 *   HERMES_DESKTOP_SKIP_BOOTSTRAP=true   (explicit opt-out)
 *   HERMES_DESKTOP_REMOTE_ONLY=true      (semantic alias used by our build)
 *
 * Both must be explicit string 'true' — unset/empty/other values fall through
 * to upstream's normal behavior, so a stock build (no env vars set) behaves
 * identically to the official Hermes Desktop.
 */
export function shouldSkipAutoBootstrap(env: BootstrapPolicyEnv = process.env as BootstrapPolicyEnv): boolean {
  return env.HERMES_DESKTOP_SKIP_BOOTSTRAP === 'true' || env.HERMES_DESKTOP_REMOTE_ONLY === 'true'
}

/**
 * User-facing error shown instead of running the installer, when
 * shouldSkipAutoBootstrap() is true and no local runtime was found.
 */
export function bootstrapSkippedError(activeRoot: string): Error {
  return new Error(
    'This build of Hermes Desktop does not auto-install a local Hermes Agent runtime.\n\n' +
      '請至 Settings → Gateway → Remote gateway 設定遠端連線資訊，\n' +
      '或聯絡資訊人員取得預先設定好的安裝檔。\n\n' +
      `(Local runtime would have been installed at: ${activeRoot})`
  )
}
