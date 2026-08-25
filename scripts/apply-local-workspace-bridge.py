#!/usr/bin/env python3
"""Wire the Local Workspace Bridge into a pinned upstream Desktop checkout.

Same contract as ``apply-patch.py``: string-anchored (not line-numbered) so it
survives upstream drift, and it fails loudly if an anchor is missing or
ambiguous instead of silently half-applying.

All the behavior lives in ``apps/desktop/electron/local-workspace-bridge.ts``,
which is copied in as a new file. This script only adds the import, the IPC
registrations, and the start/stop hooks — about 25 lines across two upstream
files, so ``git rebase upstream/main`` has almost nothing to conflict with.
"""
import sys

# Insert point chosen so the new import stays alphabetically ordered:
# perfectionist/sort-imports is an *error* rule in eslint.config.shared.mjs,
# and './local-workspace-bridge' sorts between link-title-window and
# main-window-lifecycle.
MAIN_IMPORT_ANCHOR = "import { ensureMainWindow } from './main-window-lifecycle'\n"

MAIN_IPC_ANCHOR = (
    "ipcMain.handle('hermes:workspace:sanitize', async (_event, cwd) => sanitizeWorkspaceCwd(cwd))\n"
)

MAIN_IPC_BLOCK = """
// --- Local Workspace Bridge (remote-only overlay) ---------------------------
// In remote-gateway mode every file tool runs on the gateway host, so a local
// project folder is invisible to the agent. This mirrors an AUTHORIZED local
// folder to a path on that host over the stock managed-files API, so the agent
// can work on it. Inert unless `local-workspace-bridge.json` in userData sets
// `enabled: true` — with no config file the build behaves exactly like
// upstream.
const localWorkspaceBridgeConfigPath = () => path.join(app.getPath('userData'), BRIDGE_CONFIG_FILENAME)

const localWorkspaceBridge = createLocalWorkspaceBridge({
  api: request => handleHermesApiRequest(request),
  configPath: localWorkspaceBridgeConfigPath(),
  log: message => rememberLog(message),
  stateDir: app.getPath('userData')
})

ipcMain.handle('hermes:local-bridge:status', () => localWorkspaceBridge.getStatus())
ipcMain.handle('hermes:local-bridge:sync-now', () => localWorkspaceBridge.syncNow())
ipcMain.handle('hermes:local-bridge:config-path', () => localWorkspaceBridgeConfigPath())
ipcMain.handle('hermes:local-bridge:reload', () => {
  localWorkspaceBridge.reload()

  return localWorkspaceBridge.getStatus()
})

app.whenReady().then(() => localWorkspaceBridge.start())
app.on('will-quit', () => localWorkspaceBridge.stop())
"""

PRELOAD_ANCHOR = "  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),\n"

PRELOAD_BLOCK = """  localWorkspaceBridge: {
    configPath: () => ipcRenderer.invoke('hermes:local-bridge:config-path'),
    reload: () => ipcRenderer.invoke('hermes:local-bridge:reload'),
    status: () => ipcRenderer.invoke('hermes:local-bridge:status'),
    syncNow: () => ipcRenderer.invoke('hermes:local-bridge:sync-now')
  },
"""

EDITS = {
    "main.ts": [
        (
            MAIN_IMPORT_ANCHOR,
            "import { BRIDGE_CONFIG_FILENAME, createBridgeRunner as createLocalWorkspaceBridge } from './local-workspace-bridge'\n"
            + MAIN_IMPORT_ANCHOR,
        ),
        (MAIN_IPC_ANCHOR, MAIN_IPC_ANCHOR + MAIN_IPC_BLOCK),
    ],
    "preload.ts": [
        (PRELOAD_ANCHOR, PRELOAD_ANCHOR + PRELOAD_BLOCK),
    ],
}


# Applying twice would duplicate the block (the anchors stay unique after an
# insert), so refuse a second pass instead of emitting broken TypeScript.
ALREADY_APPLIED = "local-workspace-bridge"


def apply(path: str, kind: str) -> None:
    with open(path, encoding="utf-8") as f:
        src = f.read()

    if ALREADY_APPLIED in src:
        sys.exit(f"{path} already carries the local-workspace-bridge patch; refusing to apply twice")

    for anchor, replacement in EDITS[kind]:
        n = src.count(anchor)
        if n != 1:
            sys.exit(f"anchor not found or ambiguous ({n}x) in {path}: {anchor[:70]!r}")
        src = src.replace(anchor, replacement)

    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print(f"local-workspace-bridge: patched {kind}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: apply-local-workspace-bridge.py <main.ts> <preload.ts>")
    apply(sys.argv[1], "main.ts")
    apply(sys.argv[2], "preload.ts")
