# Fork server releases (atlitech/skald-code)

Fork-only runbook. `atli` is upstream `main` plus our commits.
[`fork-server-release.yml`](../../.github/workflows/fork-server-release.yml)
publishes the same self-contained Linux x64 server archive an official release
ships, so a VM that already runs the official background service can switch to
our build and keep its T3 Connect link. Each release also carries the signed
and notarized Mac arm64 desktop app. Mobile delivery uses EAS local builds on CI runners: native Android
releases attach an APK from the same commit; compatible OTA releases link the
original APK. iOS delivery follows GitHub publication.

## Versions

Fork versions are `<next upstream patch>-atli.<n>`, for example `0.0.46-atli.1`
while `apps/server/package.json` says `0.0.45`. That is the same core upstream
nightlies use (`0.0.46-nightly.<date>.<run>`).

- It sorts above the official stable the VM came from. Switching needs no
  `--allow-downgrade`, and clients never offer the older stable as an update.
- It sorts below the next official stable (`0.0.46`), but fork update checks stay
  on atli releases; see [Updates offered by clients](#updates-offered-by-clients).
- `atli.<n>` compares numerically, so `atli.10` is newer than `atli.9`.
- It sorts below `0.0.46-nightly.*`. A VM on a nightly needs
  `--allow-downgrade` to switch.

Increase `<n>` for every release and never reuse a version. Each installed
runtime is keyed by its version and is never downloaded again. After an
upstream update moves `package.json` to a new version, use the new next patch
and restart `<n>` at 1.

## One-time repository setup

- **Settings → Secrets and variables → Actions → Variables**: add these
  public values from `.env.example`. The workflow stops if one is missing.

  | Variable                           | Value                          |
  | ---------------------------------- | ------------------------------ |
  | `T3CODE_CLERK_PUBLISHABLE_KEY`     | `pk_live_Y2xlcmsudDMuY29kZXMk` |
  | `T3CODE_CLERK_JWT_TEMPLATE`        | `t3-relay`                     |
  | `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | `hzxSgY2cH10sDU2r`             |
  | `T3CODE_RELAY_URL`                 | `https://relay.t3.codes`       |

- **Settings → Environments**: retain `personal-android-signing` and
  `personal-ios-signing`, restricted to the `atli` branch with the existing owner
  approval controls. EAS credentials can sign production apps, so place
  `EXPO_OTA_TOKEN` in **both protected environments**, then remove the repository
  copy before making managed signing available. Ordinary PR checks must not receive
  it. The existing `atlitech` robot token must have access to builds, updates, and
  submission credentials; confirm any Expo protected-resource restrictions too.

- In `personal-ios-signing`, configure:

  | Kind     | Name                                      | Value                                         |
  | -------- | ----------------------------------------- | --------------------------------------------- |
  | Variable | `SKALD_ASC_APP_ID`                        | Skald Code's numeric App Store Connect app ID |
  | Variable | `T3CODE_IOS_APP_STORE_CONNECT_KEY_ID`     | App Store Connect team API key ID             |
  | Variable | `T3CODE_IOS_APP_STORE_CONNECT_ISSUER_ID`  | That key's issuer ID                          |
  | Secret   | `T3CODE_IOS_APP_STORE_CONNECT_KEY_BASE64` | Base64-encoded API private key                |

  The controller verifies that the ASC app belongs to `tech.atli.skaldcode` and
  rejects upstream's app ID `6787819824`. Use an API key with the App Manager role.
  CI uploads the verified IPA directly with Apple's `altool` and that API key.
  EAS supplies the managed distribution certificate and profiles to its local
  worker, which manages the temporary signing keychain. No EAS cloud submission
  record is required; Apple's app/version/build lookup is authoritative.

- **Settings → Environments**: create `personal-macos-signing`, allowed only on
  `atli`. Only the Mac build job uses it, and a release does not publish
  without it:

  | Kind     | Name                                                 | Value                                                        |
  | -------- | ---------------------------------------------------- | ------------------------------------------------------------ |
  | Secret   | `T3CODE_PERSONAL_MACOS_CERTIFICATE_BASE64`           | the Developer ID Application certificate, `base64 -i id.p12` |
  | Secret   | `T3CODE_PERSONAL_MACOS_CERTIFICATE_PASSWORD`         | the password the `.p12` was exported with                    |
  | Secret   | `T3CODE_PERSONAL_MACOS_PROFILE_BASE64`               | Developer ID profile for `tech.atli.skaldcode`, base64       |
  | Secret   | `T3CODE_PERSONAL_MACOS_APP_STORE_CONNECT_KEY_BASE64` | the same App Store Connect API key, base64                   |
  | Variable | `T3CODE_PERSONAL_MACOS_APP_STORE_CONNECT_KEY_ID`     | that key's ID                                                |
  | Variable | `T3CODE_PERSONAL_MACOS_APP_STORE_CONNECT_ISSUER_ID`  | the issuer ID                                                |

  Only the Account Holder can create the certificate, in Xcode under **Manage
  Certificates → + → Developer ID Application**. Make the profile under
  **Profiles → + → Developer ID** for that certificate. The build signs
  associated-domain entitlements for upstream's Clerk passkey domain, and
  macOS refuses them unless the App ID has Associated Domains. Passkeys
  themselves do not work there, since that domain trusts only T3 Tools' apps.

- Enable the [Blacksmith GitHub integration](https://docs.blacksmith.sh/introduction/quickstart)
  for `atlitech/skald-code` before dispatching a release. The full test suite
  uses Blacksmith, as upstream's tests do; upstream's browser tests time out on a
  standard GitHub runner. Without repository access, those jobs stay queued.
  Mobile compilation runs on `blacksmith-8vcpu-ubuntu-2404` for Android and
  `blacksmith-12vcpu-macos-26` for iOS. Confirm the Mac image has Xcode 27.1,
  CocoaPods and Fastlane; setup selects and verifies that Xcode version. Planning, native compilation, and OTA use the same
  per-platform toolchain. EAS image settings do not install local tools; CI
  installs Java 17, Android SDK/build tools 36 and NDK 27.1, plus the repository's
  Node/pnpm pins. Confirm runner access and billing before pilots.

- Disable every upstream workflow; the fork runs only its own `fork-*.yml`
  (see [Continuous integration](#continuous-integration)). This lists the
  active ones to disable:

  ```sh
  gh api repos/atlitech/skald-code/actions/workflows \
    --jq '.workflows[] | select(.state == "active") | select(.path | test("/fork-") | not) | .path'
  gh workflow disable <path> -R atlitech/skald-code
  ```

  A workflow stays disabled when an update changes its file, but a workflow
  upstream adds arrives active, so run this after every update.

## EAS migration readiness

The migration code is not evidence of a successful rollout. Leave the repository
variable `SKALD_EAS_READY` unset until all of these prerequisites have been verified:

1. Use [@atlitech/skald-code](https://expo.dev/accounts/atlitech/projects/skald-code),
   project `4dfd2e15-bc73-461a-a26f-ba1c7d559172`. Import the installed Android app's
   existing keystore into EAS managed credentials; its SHA-256 certificate is
   `8be8ce453295854ea7d25ace67081dd59a924ec1ae8ae111721e8c2446b37e8e`.
   Import valid Apple Distribution credentials for team `H6L3F33KRM` and App Store
   profiles for `tech.atli.skaldcode`, `tech.atli.skaldcode.widgets`, and
   `tech.atli.skaldcode.sharing`, preserving `group.tech.atli.skaldcode` and the
   existing entitlements. Check certificate/profile expiry. Never generate
   replacement identities during migration; retain secure backups. Use owner-held
   signing files or an explicitly protected one-time import job: GitHub's API
   cannot return stored secret values.
2. Confirm the actual Android installation/distribution maximum versionCode and
   the applicable iOS App Store Connect build-number maximum. Initialize the
   remote EAS counters at least at those maxima, so `autoIncrement` reserves a
   strictly later number. From `apps/mobile`, the interactive
   `APP_VARIANT=personal pnpm dlx eas-cli@27.5.0 build:version:set --platform android
   --profile personal` command sets the Android counter; repeat with `ios` for
   the confirmed iOS counter. Do not seed from app config's default or derive
   native numbers from the fork release version. Pilot and local-worker builds
   consume the same remote counters.
3. Configure EAS's `production` environment with the public Clerk publishable key,
   JWT template, relay URL, and any Google OAuth identifiers required by the app.
   Use readable plain-text or sensitive visibility so fingerprint and update jobs
   see the same values as local native workers. GitHub job variables and local `.env`
   files are not forwarded to EAS. If push requires a Google services file, make
   the identical `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` available to fingerprinting,
   builds, and updates. Mirror public configuration into `preview` for pilots.
4. Create the `personal-production` EAS channel and branch before delivery. The
   channel must be unpaused and point 100% to the branch of the same name; split
   rollouts or another branch mapping fail the publication check. Set up the
   separate `personal-pilot` channel/branch for pilot builds.
5. Confirm CI runner availability, billing, artifact retention, EAS service limits,
   and the approved pilot budget (currently up to $25). Local builds do not use
   paid EAS cloud workers; CI compute and EAS services still have their own limits.
   Inspect the EAS source archive from a clean full checkout:
   workspace packages, patches, dependency tarballs, native headers, and the
   terminal XCFramework must be present; secrets, `.env`, local state, `.repos`,
   and generated native projects must be absent. The root `.easignore` owns these
   exclusions. Do not use sparse checkout for EAS uploads.
6. Build an Android APK and iOS IPA with `eas build --local --freeze-credentials`
   using `personal-pilot` on the same toolchains as CI. Verify their native
   identity/signature/entitlements, native numbers, embedded update URL/channel,
   and runtime against EAS metadata and the calculated fingerprint. Install over
   the existing Android app and through TestFlight for iOS; verify retained
   settings/pairings, standalone launch, remote connections, terminal, widgets,
   and sharing using `test-t3-mobile`. Test a compatible OTA, rollback, and rejection
   of an incompatible native runtime. Record the evidence and measured build cost.

After these checks and the protected-token move, set `SKALD_EAS_READY=true`.
The first manual production release establishes production-channel baselines;
pilot builds do not establish production distribution. Verify both production
installs, a later OTA-only release linking the original APK, and a deliberate
native refresh before declaring cutover complete. No native or device pilot is
implied by merging this migration.

## Cutting a release

Dispatch the workflow from `atli`; nothing else starts a release:

```sh
gh workflow run fork-server-release.yml -R atlitech/skald-code --ref atli -f version=0.0.46-atli.1
```

A guard job runs before any build. It refuses a dispatch from any other ref, a
version whose tag or release already exists, and an `atli` tip without a
passing `Check` run. Every build checks out the exact commit the guard approved.
Linux admission, the signed/notarized Mac build, and the full test suite remain
required release gates.

Mobile planning compares each platform's fingerprint and app version with its
last **distributed** baseline. A compatible baseline receives OTA; a native
change, app-version change, absent baseline, or explicit refresh needs a native
build. iOS also refreshes when the actual Apple expiration is within 14 days.
A new fork release number alone does not require a native build. Select
`force-native` as `none` (default), `android`, `ios`, or `all`; for example:

```sh
gh workflow run fork-server-release.yml -R atlitech/skald-code --ref atli \
  -f version=0.0.46-atli.2 -f force-native=android
```

A required native APK must pass identity, certificate, ABI, embedded runtime,
channel, and exact EAS native-number checks before GitHub publication. For OTA,
the original published APK's checksum is checked instead. The publish job uploads
the complete assets and immutable mobile delivery intent to a draft, then publishes
it. Only afterward may OTA delivery or iOS verification/submission run.

The prerelease contains the Linux archive, Mac desktop assets, `SHA256SUMS`,
`ADMISSION.json`, and `manifest.json`. A native Android release also attaches its
new APK. An OTA-only release's manifest and release notes point to the original
APK's release, filename, URL, digest, source SHA, native build reference, and runtime.
Referenced bytes are never renamed or attached as a new build. The manifest records
[verification scope](#verification-scope) for artifacts actually checked in this
release, and intended mobile delivery rather than speculative success.

Linux/Mac artifacts retain their build provenance attestations:

```sh
gh attestation verify t3-0.0.46-atli.1-linux-x64.tar.gz -R atlitech/skald-code
```

CI runs the pinned EAS CLI/local-worker plugin with managed credentials and
remote native counters. Each verified binary and its baseline metadata are saved
in one immutable Actions artifact for 90 days. The native identity is
`github:<runId>:<runAttempt>:<platform>`; deployments record the exact artifact ID,
workflow SHA, checked-out release SHA, digest, runtime, and allocated native
number. The controller captures that number from the worker's allowlisted job
metadata, never from a later read of the shared remote counter. Android's original
release APK remains the permanent download. EAS history owns OTA update IDs;
GitHub deployments `skald-mobile-android` and `skald-mobile-ios` record actual
delivery outcomes. Existing manifests with EAS build IDs remain readable.

A published release never changes. Before publication, resolve a failure and
start a fresh dispatch; once a tag/release exists, use a new version for another
release. For mobile failures **after publication**, retry the named published
release as described below; do not publish another server release merely to retry
delivery. Release and retry entrypoints share one production concurrency group
with cancellation disabled, so they cannot overtake one another.

Owner action, once: enable immutable releases on atlitech/skald-code
(**Settings → General → Releases**), so GitHub also refuses to change a
published release's assets or move its tag.

### Measuring Android build time

Use `android-build-benchmark.yml` to test Android build changes without signing
credentials or publication. Push a branch named `ci/android/<name>`, or dispatch
the workflow on that branch. Re-run the same commit after its caches have saved
to measure a warm build. Dispatch with `optimized=false` to compare against
Gradle caching alone. The artifacts include an unsigned APK, Gradle profiles,
build logs, and compiler-cache statistics; the APK is not an installable release.

This unsigned diagnostic workflow retains the GitHub compiler-cache setup;
production compilation uses EAS local workers on CI. Only compiler objects and Metro
transforms are persisted in the benchmark; generated `app/build` outputs are not
safe to restore because some tasks omit inputs. Keep the release's artifact
identity checks enabled when changing EAS build settings.

## Verification scope

Not every package in a release is checked the same way. By the owner decision
of 2026-10-06:

- **Linux x64 server**: runtime-verified. The admission job installs the
  archive over data the prior release wrote, upgrades and runs it, and reads
  that data back; the release's `ADMISSION.json` names the version and the
  archive's sha256 it admitted.
- **Mac arm64 desktop app** and **Android arm64-v8a APK**: build-checked but
  runtime-unverified. Their jobs check the built package's identity (the Mac
  app's bundle identifier, version, and signature; the APK's public config,
  package, certificate, native number, and embedded update metadata) and never run it.
  An OTA-only Android release references a previously verified APK; it adds no new
  APK verification-scope entry and makes no claim to have rebuilt or run that APK.

`manifest.json` records this as `verificationScope`: the decision, and one
entry per asset with its status, `runtimeVerified`, and the job and step of
each check. The publish job writes it only when `ADMISSION.json` admits the
release's own Linux archive, refuses a scope that marks the Mac or Android
package runtime-verified, and writes the release notes from it.

To read a release's scope, download its `manifest.json` and `ADMISSION.json`
and run the checker from an `atli` checkout:

```sh
gh release download v0.0.46-atli.4 --repo atlitech/skald-code -p manifest.json -p ADMISSION.json
node scripts/fork-release-scope.ts --manifest manifest.json --admission ADMISSION.json
```

It prints one line per platform, or fails when the two files disagree on the
version, the Linux archive, or its sha256, when `verificationScope` is
missing, or when the manifest marks the Mac or Android package
runtime-verified. The publish job runs it only as a refusal guard; the
evidence verdict is an independent reader's run on the published release,
never the publishing run's own.

## Switching the VM to a fork build

A fork version installs only once it is admitted: its release carries the
`ADMISSION.json` the release workflow's admission job publishes, naming that
version and the sha256 of its Linux x64 archive. `install.sh`, `t3 update`, and
the in-app update all check it, and refuse a version without a record or whose
record does not match the archive, before anything changes. Official versions
need no record. Below, `<version>` is an admitted fork version, such as the
newest fork release.

These steps assume the official service runs as your user with the default
home, `~/.t3`. The service keeps the same home, database, and secrets, so the
T3 Connect link carries over. If the service's unit sets a different
`T3CODE_HOME`, export that value first.

1. Point the service's own downloads at the fork. `t3 service install` writes
   the systemd **user** unit `~/.config/systemd/user/t3code.service` and
   rewrites only that file, so a drop-in survives updates and reinstalls:

   ```sh
   mkdir -p ~/.config/systemd/user/t3code.service.d
   printf '[Service]\nEnvironment=T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/skald-code/releases/download\n' \
     > ~/.config/systemd/user/t3code.service.d/fork.conf
   systemctl --user daemon-reload
   ```

2. Install the archive. This unpacks it into
   `~/.t3/runtime/versions/<version>` and repoints `~/.local/bin/t3`. It does
   not touch the running service.

   ```sh
   export T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/skald-code/releases/download
   curl -fsSL https://raw.githubusercontent.com/atlitech/skald-code/atli/scripts/install.sh \
     | T3CODE_VERSION=<version> sh
   ```

3. Switch the service. This uses the runtime unpacked in step 2, rewrites the
   unit, and restarts the service:

   ```sh
   t3 service install
   ```

4. Check the result:

   ```sh
   t3 --version
   t3 service status
   t3 connect status
   systemctl --user show t3code.service -p Environment
   ```

To move to a newer fork build later, run one command. It downloads, verifies,
checks the admission record, migrates a scratch copy of the database with the
new version, repoints `t3`, and restarts the service. If that migration fails,
it refuses and the service keeps the current version; the in-app update does
the same. Run it with the base URL exported in your shell, because `t3 update`
reads the shell's environment, not the unit's.

```sh
T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/skald-code/releases/download t3 update <version> --yes
```

`0.0.46-atli.1`, `0.0.46-atli.2`, and `0.0.46-atli.3` were released before
admission existed and have no record. Use them only for an owner rollback,
with `t3 update <version> --allow-unadmitted`, which accepts only those three
versions and logs the override. Any other unadmitted version is refused even
with the flag. The in-app update (a client's Update button) and `install.sh`
have no override.

## Installing the macOS desktop app

Every release carries the Mac arm64 desktop app, Skald Code
(`tech.atli.skaldcode`), as a DMG with the same version as the server. It is
signed with the Atli LLC Developer ID and notarized, so it opens without a
Gatekeeper warning. Download it and check it before installing:

```sh
gh release download v0.0.46-atli.2 -R atlitech/skald-code -p 'T3-Code-*-arm64.dmg' -p SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify T3-Code-0.0.46-atli.2-arm64.dmg -R atlitech/skald-code
```

Quit the app, then drag Skald Code from the DMG into `/Applications`. Projects
and threads live in `~/.t3/userdata` and the desktop's own data in
`~/Library/Application Support/t3code-v2`, so both carry over. An agent running
inside the app ends when it quits, so an agent doing the swap must hand it to a
detached process. Install the first OTA-enabled release this way once: older
builds have no update feed and cannot discover it. Later releases use the
existing in-app download and restart flow. Keep **Settings → About → Update
track** on Stable; it follows atli prereleases in this fork. Nightly is not
published for the fork.

Each release includes the signed, notarized ZIP used by the Mac updater,
`atli-mac.yml`, and blockmaps. CI checks the identity and signature of both the
DMG app and the ZIP app, their embedded fork feed, and the payload sizes and
SHA-512 hashes before publication. `manifest.json` lists these extra files in
`updaterAssets`; `SHA256SUMS` includes them. They are build-checked, not
runtime-verified; the Linux admission remains the only runtime verification.

Earlier releases shipped an ad hoc signed `T3 Code (Beta).app` (or
`T3 Code (Alpha).app`) with upstream's bundle ID. Delete it after installing
Skald Code, or both claim `t3code://` links. macOS asks once for Keychain access to "T3 Code Safe Storage" and again
for camera, microphone, and screen capture, because the signature and bundle ID
are new; allow them and they stay allowed across updates.

### Building it locally

When a release cannot be used, build the same DMG from `atli`. Use the same
version as the server release. Builds read T3 Connect's public identifiers from
the repository `.env`; without it the app builds with T3 Connect left out:

```sh
cp -n .env.example .env
T3CODE_DESKTOP_VERSION=0.0.46-atli.2 vp run dist:desktop:dmg:arm64
```

The DMG lands in `release/`. The build compiles the bundled resource monitor,
which needs Rust (`rustup target add aarch64-apple-darwin`). Without Rust, and
only while `native/resource-monitor` is unchanged since the installed app was
built, reuse the installed binary:

```sh
mkdir -p native/resource-monitor/target/aarch64-apple-darwin/release
cp "/Applications/Skald Code.app/Contents/Resources/resource-monitor/t3-resource-monitor" \
  native/resource-monitor/target/aarch64-apple-darwin/release/
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1 T3CODE_DESKTOP_VERSION=0.0.46-atli.2 vp run dist:desktop:dmg:arm64
```

A local build is not signed with the Developer ID. Copy the app out of the
DMG, sign it ad hoc, and install it as above; macOS asks for Keychain access
after every ad hoc build:

```sh
hdiutil attach release/T3-Code-0.0.46-atli.2-arm64.dmg -nobrowse -readonly -mountpoint /tmp/t3-dmg
ditto "/tmp/t3-dmg/Skald Code.app" "Skald Code.app"
hdiutil detach /tmp/t3-dmg
codesign --force --deep --sign - "Skald Code.app"
```

## Installing the personal Android app

Use the Android link in the release notes. For native delivery it points to the
new `tech.atli.skaldcode` ARM64 APK; for OTA-only delivery it points to the
original compatible APK in its original release. The manifest's
`mobile.android.baseline` gives its release tag, filename, SHA-256, and native
build number. Download that original asset and its original `SHA256SUMS`, then:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
adb devices -l
adb -s <device-serial> install -r <original-apk-filename>
```

EAS allocates a higher versionCode for every native build. OTA does not change
that number. Reusing the original APK installs its older embedded JavaScript;
network access and applying the OTA are required to reach the new release.
Force a native Android release when an up-to-date offline installer is required.
Never uninstall to work around a signing mismatch or downgrade: that destroys
settings and pairings.

Earlier releases used `com.elvis.t3code`. Android treats `tech.atli.skaldcode` as
a separate app even with the same key; data cannot transfer through `install -r`.

### Building it locally

Use the `develop-t3-personal-android` skill and its EAS local-worker helper:

```sh
.agents/skills/develop-t3-personal-android/scripts/build-personal-apk.sh
```

Install the APK path returned by EAS with `adb install -r` after the same identity
checks. The helper uses the `personal` profile, managed credentials, and remote
counters, using the same local-worker mechanism as CI. It requires Expo
connectivity and is not offline disaster recovery. The old `--release-version` and direct production
Gradle path are retired. During a complete Expo outage, pause publication until
an explicit recovery procedure reestablishes a single numbering authority.

## Installing the personal iOS app

Native iOS delivery compiles the exact published release SHA on the Mac runner, verifies the
IPA's app/widget/share identities, entitlements, signature, native build number,
and embedded update settings, retains the IPA, then uploads those exact bytes to
TestFlight. Compatible releases use OTA instead. Neither a successful local build
nor an accepted upload proves tester availability: Apple must process the build and make it
available to a testing group with testers before the deployment is marked
`distributed`.

Install Skald Code (`tech.atli.skaldcode`) through TestFlight. Internal testers
must be users of the Atli LLC App Store Connect team assigned to an internal
app testing group. OTA does not extend a build's TestFlight expiration. The next
manual release requests a native refresh within 14 days of the expiration Apple
reports; if no release is triggered, the installed build can still expire.

The app signs in to T3 Connect through the maintainers' deployment, which trusts
only their own apps for native Google sign-in, Sign in with Apple, passkeys, and
push. Use the email-code flow and keep distribution internal while relying on it.
Free Personal Team installations use a separate identity and remain available
through `vp run ios:personal --bundle-id <your-identifier>`; they have no OTA.

## Personal mobile OTA updates

Production updates use [@atlitech/skald-code](https://expo.dev/accounts/atlitech/projects/skald-code)
and `personal-production`. Mobile publication starts only with a manual fork
release, never with an `atli` merge. Old personal binaries with updates disabled
need the first OTA-enabled native production baseline. Native fingerprints route
updates to compatible installations; they do not guarantee client/server protocol
compatibility with older or remotely connected servers.

`manifest.json` is immutable delivery intent. Inspect EAS history and the GitHub
`skald-mobile-android` / `skald-mobile-ios` deployment payloads and statuses for
actual native references, artifact IDs, update group IDs, Apple build IDs, checksums, and delivery
outcomes. A failed mobile delivery does not mutate or invalidate the server
release. Pending Apple processing or tester-group assignment is still pending
mobile delivery.

Retry mobile delivery with the already published tag:

```sh
gh workflow run fork-mobile-update.yml -R atlitech/skald-code --ref atli \
  -f tag=v0.0.46-atli.2
```

The retry resolves and checks the published manifest/tag SHA, checks out that
exact commit, and resumes its recorded native artifact and Apple build. It cannot publish
arbitrary current `atli` code. Older releases cannot overtake newer delivery.
An unavailable/expired intended TestFlight baseline requires a new manual release
with native refresh; a retry cannot rewrite the old release's intent.

Retries recover the original binary by run, artifact ID/name, source SHA, runtime,
and checksum; they do not allocate another number while retained bytes exist.
If a build died before saving its artifact, or the 90-day retention expired,
`-f rebuild-native=true` explicitly permits a new iOS build with a higher remote
number. It does not replace an already published Android APK. Before publication,
use a fresh release version if an Android attempt has no recoverable artifact.

An upload is checkpointed before contacting Apple. If its response is lost, retry
only reconciles the exact app/version/build in App Store Connect and never uploads
it twice. Missing visibility after an ambiguous upload requires operator
investigation; `rebuild-native` does not bypass that guard. Failed Apple processing
requires a new native refresh release. Pending processing or tester assignment
can be retried once Apple has made the existing build available.

For emergency JavaScript rollback, suspend manual release/retry dispatches and
wait for the current production publication to finish. Select the known-good
update group for the same platform/runtime in EAS Update and use its explicit
rollback/republish operation. Record the resulting update ID and source in the
deployment history before normal releases resume. The retry
workflow intentionally does not treat an old release as a rollback request.
A native recovery needs the original signing identity and a later EAS-allocated
number; never uninstall or downgrade to recover.

Local production workers use the same channel, but differing public config or
native inputs can produce a different runtime. Prefer release artifacts for daily
use. `personal-pilot` isolates migration testing on its own update channel; it does
not replace the required production baseline or prove production delivery.

## Pull request watcher

Fork builds ship with the pull request watcher off (`enablePullRequestWatch`
defaults to `false`). To turn it on for a server, set the top-level key in
`~/.t3/userdata/settings.json`, or use **Settings → Source control** from any
client. The server watches the file and applies edits without a restart. Write
to a temporary file, then rename it, so the server never reads a half-written
file:

```sh
f=~/.t3/userdata/settings.json
[ -f "$f" ] || echo '{}' > "$f"
tmp="$(mktemp "$f.XXXXXX")" && jq '.enablePullRequestWatch = true' "$f" > "$tmp" && mv "$tmp" "$f"
```

Only fork builds have this setting. Official builds do not read it and always
watch.

## Updates offered by clients

OTA-enabled Mac builds check `atlitech/skald-code`'s `atli` channel. The update
button downloads the signed ZIP and restarts the app when requested. **Update
everything** can bring the connected Linux server to the same release first.

On an updated fork server, plain `t3 update` discovers the newest published
`-atli.N` release and downloads it from the fork. Existing servers need one
explicit version update to get this discovery behavior. Checks from the
updated mobile app also follow the server's fork version. Upstream releases
are not offered for fork hosts. Explicit mirror/base-URL overrides still win.

Linux updates continue to require `ADMISSION.json` and verify the archive's
checksum. Client-triggered server updates use upstream's temporary
service-update rollback backup; `t3 update` does not create a rollback backup.
Discovery does not bypass admission. No Linux desktop package is shipped by this workflow.

Older clients can still offer upstream versions. Update those clients, or use
`t3 update` on the server. To return to upstream intentionally, follow
[Rolling back](#rolling-back-to-an-official-version).

## Rolling back to an official version

Remove the drop-in, then update without the fork base URL. The official
version is lower than the fork version, so the update needs `--allow-downgrade`.
If that runtime is still in `~/.t3/runtime/versions`, `t3 update` reuses it.

```sh
rm ~/.config/systemd/user/t3code.service.d/fork.conf
systemctl --user daemon-reload
unset T3CODE_RELEASE_BASE_URL
t3 update 0.0.45 --allow-downgrade --yes
```

A fork build may already have run database migrations from upstream `main`
against `~/.t3/userdata`, and an older official build may not run on that
database. Neither current fork nor official CLI updates keep a recovery point,
so back up `~/.t3/userdata` before switching between them.

### Recovering a failed update

Client-triggered server updates use upstream's temporary rollback backup while
the background service tries the new runtime. The service launcher removes it
after a successful update or rollback. As in upstream, `t3 update` installs the
target directly, without a launcher trial or database rollback backup. Back up
`~/.t3/userdata` before using the CLI if you need to restore the previous database.

Neither path creates or prunes retained recovery points, so updates do not
accumulate three additional database copies. Preflight still uses a temporary
database copy to check migrations; that copy is discarded, not kept for recovery.

Older fork builds may have kept a recovery point under
`~/.t3/recovery/points/`. Existing points and displaced databases are left
untouched; this change does not reclaim their disk space. `t3 recover` remains
available for restoring those legacy points. To go back to one:

1. List the points and pick the one kept before the failed update:

   ```sh
   t3 recover --list
   ```

2. Restore it by its id:

   ```sh
   t3 recover <id>
   ```

3. Check the result. `t3 --version` names the prior version. When this home's
   background service serves it, `t3 service status` shows it running again;
   otherwise start the server as you did before.

`t3 recover <id>` puts back that point's database and the prior runtime it
records. When this home's background service serves it, recover stops the
service first, then points it at the prior runtime and restarts it; otherwise
it changes only the database and the `t3` launcher. The database it replaces
is kept under `~/.t3/recovery/displaced/` and never pruned, so later work is
not lost. The [recovery drill](#recovery-drill) rehearses these steps on a
scratch home. Recover refuses before changing anything when the backup or the
prior runtime does not match the point's record, while a server started by
hand runs on this home, when `server-runtime.json` cannot be read to tell
whether one does, or while another `t3 recover` holds this home's
`~/.t3/recovery/recover.lock`. A lock left by a recover that is no longer
running is taken over; if a recover dies during that takeover, the next one
names the `recover.lock.takeover` file to remove. A prior runtime installed
without a recorded archive sha256 is restored only with
`--allow-unverified-runtime`, which the point's `recovery.json` records.

Revocations made after the point was kept are carried over into the restored
database: before anything moves, recover copies the point's backup beside the
database and applies to that copy every session and pairing-link revocation,
and every pairing-link use, the current database records. A session or
pairing link the current database no longer has, for example because a
migration recreated the auth tables, is revoked in the restored database. A
session created after the point is not in the restored database at all. When those
revocations cannot be read, recover refuses with the current database in
place.

## Recovery drill

[`fork-recovery-drill.yml`](../../.github/workflows/fork-recovery-drill.yml)
proves on Linux that [recovering a failed update](#recovering-a-failed-update)
works between two admitted fork releases. On a scratch T3 home, it installs the
prior release, writes data, upgrades to the target release, writes new work
with it, declares the upgrade failed, and runs `t3 recover <id>`. The server
runs in the foreground on the runner, not as a service.

This is a legacy recovery drill: explicitly select an admitted release whose
prior version still created recovery points. New updates do not create them.
The prior is the `priorVersion` in the target's `ADMISSION.json`, and it must already
carry `t3 recover`. Dispatch the workflow from `atli`; nothing else starts it:

```sh
gh workflow run fork-recovery-drill.yml --repo atlitech/skald-code --ref atli -f target-version=0.0.46-atli.5
```

The drill job uploads `RECOVERY.json` with the drilled home. A separate verify
job, on a fresh runner, unpacks that home, re-observes its runtime and
database, and uploads `VERIFICATION.json`. Download both records:

```sh
gh run download <run-id> --repo atlitech/skald-code -n recovery-drill -n recovery-verification
```

`RECOVERY.json` names the drill's commit and host, the prior and target
versions with each archive's sha256, the recovery point it restored, the
database's sha256 at that point and after recover, the environment id from
before the upgrade, where the displaced database went, and every command the
drill ran with its UTC start and end and exit code.
`VERIFICATION.json` says whether it `passed` and lists each check with its
result. The verdict is `VERIFICATION.json` from the verify job, never the
drill job's own grading: the drill passes only when the prior binary and data
in the drilled home match the recorded recovery point.

## Updating `atli` from upstream

`atli` takes upstream changes only through a merge, so it keeps upstream's
history as an ancestor. The ruleset on `atli` refuses force pushes, so never
rewrite it. `origin` is `atlitech/skald-code` and `upstream` is `pingdotgg/t3code`.

Freeze the newest upstream commit whose CI passed, so the update does not move
while you work on it, then build a candidate branch from `atli` plus a merge of
that commit. Fork CI refuses a branch built on an upstream commit without a
passing upstream `Check`:

```sh
git fetch origin atli
git fetch upstream main
upstream_sha="$(gh api 'repos/pingdotgg/t3code/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1' --jq '.workflow_runs[0].head_sha')"
branch="update/upstream-${upstream_sha:0:12}"
git switch -c "$branch" origin/atli
git merge --no-ff "$upstream_sha" -m "Merge upstream ${upstream_sha:0:12} into atli"
git push origin "$branch"
gh pr create --repo atlitech/skald-code --base atli --head "$branch" \
  --title "Merge upstream ${upstream_sha:0:12} into atli" \
  --body "Merges upstream commit $upstream_sha. Merge with a merge commit."
```

When the fork's CI passes, merge the pull request with a merge commit, never
squash or rebase. Either loses upstream's commits as ancestors of `atli`, and
the next update conflicts again on everything this one resolved:

```sh
gh pr merge <pr> --repo atlitech/skald-code --merge
```

### Conflicts

Two files are known to conflict. Resolve them in the candidate branch, then
`git add` them and `git commit` to finish the merge:

- `pnpm-workspace.yaml`: both sides add entries to `patchedDependencies`.
  Keep both sides' entries.
- `pnpm-lock.yaml`: never hand-merge it. Take either side, then regenerate it
  with `pnpm install` once `pnpm-workspace.yaml` is resolved.

Any other conflict stops the update. Run `git merge --abort`, delete the
candidate branch, and leave the update for the owner.

After the merge, disable any workflow the update added (see
[One-time repository setup](#one-time-repository-setup)). Then cut a release. If
`apps/server/package.json` moved, use its new next patch with `-atli.1`.

## Continuous integration

The fork does not run upstream's CI. Upstream runs it on every upstream commit,
and running it again on every fork push and pull request got the fork's
Actions paused by GitHub for usage volume on 2026-10-14 ("Workflows are not
currently being run on this fork"). Only a repository admin can lift that, from
the banner on the Actions tab.

- `fork-ci.yml`'s `Check` runs on pull requests into `atli` and pushes to it.
  The test lanes confirm the upstream commit passed upstream's own `Check`
  and select every test file the fork added or changed since that commit
  (`scripts/fork-check.ts`). Server shards, other tests, and repository-wide
  lint and typechecks run in parallel. The final `Check` requires every lane
  to succeed; a failed, cancelled, or skipped lane cannot satisfy the `atli`
  ruleset or the release guard on the released commit.
  For a runner comparison, dispatch the same ref with `runner-profile` set
  to `github` or `blacksmith`; use `use-cache: false` to bypass task-result
  reuse. Compare complete runs on the same ref, including setup and cache
  transfers, then repeat with caching enabled to measure warm behavior.
- `fork-full-suite.yml` runs every package's tests. A release runs it on the
  commit it publishes, which catches an upstream test that breaks against fork
  code. Dispatch it by hand after a large update:
  `gh workflow run fork-full-suite.yml -R atlitech/skald-code --ref atli`.
