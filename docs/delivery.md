# Private delivery builder

Delivery is an opt-in local service. GitHub Actions uses GitHub-hosted runners only. Machine
names, source paths, service names, SSH destinations and signing credentials belong in an
untracked `~/.config/t3-delivery/config.json`, never in workflow variables or committed config.
Start with `scripts/delivery/config.example.json`; its machines and paths are examples.
Use `~/.local/state/t3-delivery` for `stateDir`. Each delivery writes a private timestamped
journal, command timings, output logs, runtime archive and clean-change brief there.

The builder runs outside the T3 server it updates. Copy and edit
`scripts/delivery/t3-delivery.service.example` to the builder account's systemd user directory,
set its absolute Node 26 executable, source path, private config path and tool PATH, then run
`systemctl --user daemon-reload` and `systemctl --user enable --now t3-delivery.service`.
The socket directory must be private to that account; the socket is mode 0600. On restart the
builder probes an existing socket, refuses an active builder, and removes only a stale socket.
`curl --unix-socket <socket> http://localhost/status` reads its idle/running state and queue size. Never
install this service against a live server without the owner's approval.

## Clean lane

`t3ctl deploy --ref <commit-or-ref> --version <version> [--machines studio,cloudbox]`
queues a build. `--release <existing-tag>` uploads the resulting runtime and changed installers
with `gh release upload`; only the builder needs GitHub credentials. Without that flag it is
an isolated delivery with no GitHub publication. `--now` skips the configurable idle wait.
The local `gate` command must run T1 acceptance; absent or failing gates stop a clean delivery.
Set the command to the T1 entry point supplied by that stage rather than bypassing it.

Before stopping a unit, the default lane obtains the authenticated server delivery drain.
The server closes admission to new turns, waits for active turns and queued starts to finish
up to `maxWaitMs`, and persists the request token across restart. The target verifies the same
drained token immediately before stopping. Healthy activation or restored health releases it.
A deadline failure cancels the drain and leaves the existing runtime running. Older servers
without the drain API fail before stopping; upgrade those through an explicitly authorized
`--now` operation first. `--now` deliberately permits interruption of active work.

Builds run in one persistent, private clone in `buildDir`, preserving pnpm, Vite task, Rust and
Gradle caches across refs. The source checkout stays on its branch. Server/web, the executable
and runtime archive build first. Native desktop changes build Linux installers. Mobile changes
compute Expo's native runtime fingerprint: only a changed fingerprint builds a new APK; a
compatible JS change exports and signs an OTA bundle. First delivery builds both baselines.
The builder uses the tool environment of its service; configure Android SDK, signing and
native build dependencies there (Rust 1.95 or newer; `rustToolchain` selects an installed rustup toolchain). Each target needs Node 26 and the matching t3ctl agent kit;
it does not need `gh` or a build toolchain.

Targets are selected only from the private allowlist. Rollout copies the archive over SSH
when required, and updates one configured
unit at a time. Both systemd user and system units are supported; the account must be allowed
to manage the selected unit. The unit must use an absolute `t3` executable in `ExecStart`.
After obtaining the admission fence, the target stops its unit and backs up `userdata/statev2.sqlite`, retains
the old unit and runtime, starts the new executable and checks B1's `t3_mesh_update_health`:
version, config revision, the captured peer layout watermarks and resumed replica status.
A failed check restores the old unit and database and stops the rollout. The B1 health
contract treats an intentionally paused replica as ready. This delivery path does not change
mesh desired version. Before switching, it refuses a configured `t3.version` that differs
from the delivered version, preventing a competing B1 reconciliation from downgrading it.
An unmanaged desired version (absent `t3.version`) is allowed for isolated hot trials.

`t3ctl deploy rollback [--machines studio]` restores each selected target's journaled previous
unit and database, in reverse target order. Previous runtime trees and backups remain available.
An interrupted target with an unfinished journal refuses another switch until rollback.

## Hot lane

`t3ctl hot [--worktree /absolute/path] [--machines studio,cloudbox] [--now]` or
`t3ctl deploy --hot` snapshots the current working tree, including uncommitted files, with a
temporary Git index and `commit-tree`. It creates `hot/<timestamp>` without changing HEAD,
the user's index or `ws`. Hot deliveries never publish release assets. They use the same
admission drain, backup, health and rollback flow.
Ignored files are not included in the snapshot.

Configure `cleanAgent.project`, and optionally `ctl`, `agent` and `model` (defaults: Codex Sol).
After delivery the builder starts a thread in that project with the source branch, commit and
full diff. Its brief requires proper implementation, tests, T1, merge to `ws` and a clean
release; a wrong change must be rejected and explained in the inbox. The thread runs on the
builder's own t3ctl connection. `cleanAgent.environment` can explicitly select the destination
using `T3CODE_HOME`, `T3CTL_ORIGIN`, `T3CTL_UNIT`, `T3CTL_T3_BIN` and an isolated
`XDG_CONFIG_HOME`. No agent turn is started merely by configuring the builder.

## Phone OTA

An app built with the OTA certificate is required once. Configure the builder environment with
`APP_VARIANT=sidebar`, `T3_MOBILE_UPDATE_URL` and `T3_MOBILE_UPDATE_CERTIFICATE`; preserve the
same values for fingerprint resolution, APK build and OTA export. Generate keys using
`node scripts/delivery/mobile-ota.mjs keygen --dir /private/keys`. Keep the private key outside
source control. The private `ota` config contains `origin`, `store`, `key`, `certificate`
and `apkUrl`; `store` is a private staging directory. An optional `ota.environment` map
keeps native build inputs such as `T3CODE_MOBILE_VERSION` and `T3_SIDEBAR_VERSION` equal to the
installed APK. The builder supplies the same sidebar variant, update URL and certificate to
fingerprint resolution, APK build, public Expo config and JS export. Signed exports are copied into each
selected server's `<baseDir>/mobile-updates`. Immutable assets arrive before their index.
See the mobile update settings for checking, applying and rolling back compatible bundles.
Native fingerprint changes require the APK; they must not be sent to an incompatible client.
The generated certificate includes Digital Signature and Code Signing usages required by Expo.
The APK also declares the request headers needed for selecting a previous bundle. Changing
either native input needs another APK; an OTA bundle cannot enable it retrospectively.
Set `ota.apkUrl` to a reachable APK download for the native-update notice.

## Verification and limits

The release workflow starts Windows as soon as its Linux WSL runtime archive is ready,
independently of the Linux installer. Runtime publishes before platform assets; skipped
platforms are marked in the release notes with a link to the previous release. Use manual
dispatch with `dry_run=true`, or a `delivery-ci/**` test branch, to build without publishing.
The `delivery-timings` artifact records actual job start/end times. Test-branch pushes still
require authorization when the task prohibits pushing.

Desktop currently bundles its fallback UI. After installing the new shell once, normal
production navigation fetches UI from its local server through the stable `t3code://app/`
origin. Set `T3CODE_DESKTOP_UI_URL` when launching the shell to use a specific remote server.
This setting does not follow the renderer's active environment selection. HTML bypasses the
HTTP cache, Vite resources carry content hashes, and a failed document fetch falls back to
the bundled client. A failed server asset fetch never substitutes a bundled asset.
Run `apps/desktop/node_modules/.bin/electron --no-sandbox --user-data-dir=<isolated-profile>
apps/desktop/scripts/delivery-ui-proof.mjs` to exercise server v1, server v2 and offline fallback;
the command prints the temporary screenshot directory. Linux environments may need Xvfb.

`node --test scripts/delivery/rollout.node-test.mjs` proves bounded idle waiting, health failure
rollback, missing layout watermark refusal and a real Git snapshot preserving the user's index.
The delivery journal records actual build durations rather than predicted estimates.
A real multi-machine rollout, APK installation, desktop visual pass and two OTA transitions
must also be verified on isolated servers and an emulator before first live use. A successful
unit test alone does not establish the five-minute delivery target.

## Isolated delivery acceptance

`scripts/delivery/e2e.mjs --config <private-config> --out <private-evidence> --scenario rollout
--archive <built-runtime> --version <runtime-version> --force-health-failure` drives the real
user and system units in the allowlist, then deliberately requests a version the archive does
not provide. The failed first trial must restore the previous runtime and stop before the next
machine. `sshArgs` and `scpArgs` carry private SSH identity/port options; a privileged private
Node launcher can manage a system unit without giving the builder a GitHub token. No target
needs `gh`. Hold the shared test-bed lock before running against shared infrastructure.

`--scenario lanes --ref <baseline-ref>` makes its own private `D1-delivery-fixture` clone,
changes the mobile About title without committing, and invokes the actual `t3ctl hot` command.
It checks the snapshot branch, preserved dirty index, signed OTA catalog and the clean thread's
first Replay response, commits the fixture change in its own clone, then invokes actual clean
deploy and verifies the configured gate ran. It refuses non-D1 unit names and production clean
agents. Both command timings must be at most five minutes. Emulator verification of the About
marker is a separate device-tool capture; the runner does not claim that a manifest proves UI.

The coordinator-authorized `fixture-gate.mjs` is a transport fixture, not T1 acceptance. It
refuses unless `T3_DELIVERY_FIXTURE_GATE=1` and a private `T3_DELIVERY_FIXTURE_GATE_LOG` are set.
The private gate command can use `env` to pass these only to that fixture. Production clean
releases must configure the actual T1 command. Test evidence must say which gate ran.

Warm-lane measurement may begin from an actually installed baseline runtime and native APK.
Record that baseline ref, artifact and resolved native fingerprint before initializing the
private `last-build.json`; do not modify that history between the timed hot and clean commands.
The first native build, toolchain preparation and cache warming are reported separately.
