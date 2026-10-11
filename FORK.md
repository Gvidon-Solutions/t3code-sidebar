# T3 Code Sidebar — fork notes and feature log

This repository is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
maintained alongside upstream. It adds a workspace sidebar and ships its own desktop builds
("T3 Code Sidebar") that install next to upstream T3 Code. Everything else is upstream.

## How the fork is kept

- **Remotes.** `origin` is `Gvidon-Solutions/t3code-sidebar`, `upstream` is `pingdotgg/t3code`.
- **Branches.** Fork work lives on `ws`. `main` mirrors upstream and is not used for fork work.
- **Syncing.** Merge `upstream/main` into `ws` (no rebases of published history). Fork code is
  kept in its own files so merges stay small; the seams into upstream files are listed per
  feature below. Re-check those seams after every upstream merge.
- **No upstream PRs** from this fork unless the owner asks for one.
- **Tests.** Some desktop tests still assert upstream's app name and paths and fail on `ws`;
  upstream CI does not run here (it triggers on `main`).

## Relation to upstream

- **Base.** Last synced with upstream `main` at `18656a3402` on 2026-10-11 (merge into `ws`;
  the previous base, `6c8fed35dd` from 2026-10-02, was 748 commits behind). Fork builds report
  upstream's version plus `-sidebar.<run>`.
- **Footprint in upstream files.** Small, about 16 files and 70 lines: the settings schema
  key, the shared-settings list, the sidebar switch in `AppSidebarLayout.tsx`, one Settings
  row, desktop identity and WSL paths, and the artifact build script. Everything else is in
  fork-only files. Run `git diff $(git merge-base ws upstream/main) ws --stat` to see it.
- **What is replaced, what is reused.** The workspace sidebar is a third sidebar next to
  upstream's two: upstream `Sidebar` and `LegacySidebar` are untouched, and the setting
  picks which one shows. The fork reuses upstream's thread data, statuses, actions, menus,
  keybindings and project icons, and adds no server logic beyond one settings key. Projects,
  threads, providers and the server run upstream code unchanged.
- **Not covered yet.** The mobile app (`apps/mobile`) shows upstream's UI and ignores
  workspaces.

## Identity (desktop)

|                          | Upstream             | Fork                              |
| ------------------------ | -------------------- | --------------------------------- |
| Product name             | T3 Code (Alpha)      | T3 Code Sidebar                   |
| App id                   | `com.t3tools.t3code` | `com.gvidon.t3code-sidebar`       |
| Data dir (`T3CODE_HOME`) | `~/.t3`              | `~/.t3-sidebar` (also inside WSL) |
| Electron profile         | `t3code`             | `t3code-sidebar`                  |
| `t3code://` handler      | registered           | not registered (left to upstream) |
| Updates                  | upstream releases    | this fork's GitHub releases       |

Changed in `apps/desktop/src/app/{DesktopEnvironment,DesktopStatePaths,DesktopEarlyElectronStartup,DesktopApp,DesktopUserData,DesktopLegacyLocalStorage}.ts`,
`apps/desktop/src/backend/DesktopBackendConfiguration.ts` (WSL `t3Home`),
`apps/desktop/src/wsl/DesktopWslEnvironment.ts` (WSL runtime dir), `apps/desktop/package.json`
and `scripts/build-desktop-artifact.ts` (app id, artifact and `.deb` package names, no URL
schemes, no AppStream metainfo). Windows also gets its own AppUserModelID.

## Releases and deployment

- **Desktop.** `.github/workflows/sidebar-desktop.yml` runs on every push to `ws` (docs and
  `deploy/` excluded): JS bundle → Linux AppImage/deb + Linux CLI archive → Windows NSIS with
  the CLI archive embedded as the WSL runtime → GitHub release `sidebar-v<version>` marked
  latest, with `latest.yml` / `latest-linux.yml`. Version is `<upstream version>-sidebar.<run>`;
  the core stays upstream's so version-skew checks against servers hold. Builds are unsigned.
- **Self-hosted web.** `deploy/t3-ws/` builds a Docker image of `t3 serve` and runs it on the
  owner's VPS behind an SSH tunnel (`deploy.sh`, `open.sh` → `t3-ws` command). Codex only.

## Feature log

Newest first. Each entry: what it does for the user, how it works, where it lives.

### 2026-10-11 — Done badge for threads never opened on this device

- **What.** A thread whose latest turn finished after you started using the workspace sidebar
  on this device shows a green check until you open it, even if this device never opened it.
- **How.** Upstream counts a completion as unseen only when the device has a visit timestamp.
  The workspace view store records `seenBaselineAt` once per device; `isThreadUnread` falls
  back to it. Opening a thread stamps the visit (upstream `ChatView`).
- **Where.** `workspaces.logic.ts` (`isThreadUnread`), `workspaceViewStore.ts`,
  `WorkspaceThreadRow.tsx`.

### 2026-10-11 — Self-updating desktop releases

- **What.** Installed T3 Code Sidebar offers new fork builds through the normal update button.
- **How.** Builds keep `GITHUB_REPOSITORY`, so electron-builder writes a GitHub publish config
  pointing at this fork; the release carries the updater manifests. Channel `latest`.
- **Where.** `.github/workflows/sidebar-desktop.yml`.

### 2026-10-11 — Project icons from the folder menu

- **What.** Right-click a project folder → Icon… / Reset icon.
- **How.** Reuses upstream's `ProjectIconPickerDialog` and project `projectIcon` override,
  written to every checkout of the folder (same as Project settings › Icon).
- **Where.** `WorkspaceSidebar.tsx` (`setFolderIcon`).

### 2026-10-11 — Tile order, tile icons, undeletable default

- **What.** Drag tiles (or Move left/right) to reorder; Alt+1…9 follow the order. Tile face:
  up to two letters, an emoji, or a built-in glyph. The default workspace can't be deleted and
  carries a small mark.
- **How.** Order is the order of `sidebarWorkspaces.workspaces`; `icon` holds the label or
  `glyph:<key>`. `effectiveDefaultWorkspaceId` is the one workspace delete refuses.
- **Where.** `workspaces.logic.ts`, `WorkspaceChrome.tsx`, `WorkspaceSidebar.tsx`.

### 2026-10-11 — Desktop app that installs next to upstream (incl. WSL)

- **What.** Windows/Linux installers named T3 Code Sidebar with their own data and profile;
  the WSL backend works and keeps its data in `~/.t3-sidebar` inside the distro.
- **Where.** See _Identity_ above.

### 2026-10-10 — Workspace sidebar

- **What.** Workspaces (e.g. personal / vtbfamily / potentialplus / eduplatform) as square
  tiles at the bottom, current workspace name at the top, one toggle (Alt+0) to see every
  workspace in one list. Projects are folders with one-line threads in a stable order, a
  Quiet projects group, pinned and snoozed sections, search, context menus, Alt+1…9 to switch
  workspaces, thread jump keys. Turn it off in Settings › General › Workspace sidebar.
- **How.** The config is a shared server setting (`sidebarWorkspaces`, in
  `SHARED_SERVER_SETTING_KEYS`), so every client of a server sees the same workspaces.
  Projects resolve to a workspace by explicit assignment, then path glob rules, then the
  default. Per-device view state (open workspace, collapsed folders) is local.
- **Where.** `packages/contracts/src/sidebarWorkspaces.ts`; seams in
  `packages/contracts/src/settings.ts`, `packages/client-runtime/src/state/sharedSettings.ts`,
  `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`
  and `settingsSearch.ts`; UI in `apps/web/src/components/workspaces/`.
