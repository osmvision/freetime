# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

> **Status:** our application to SignPath Foundation is in progress. Until it is approved,
> freetime's Windows installers are not code-signed, and Windows may show a SmartScreen warning.
> This page describes how signing works once it is in place.

## What is signed

- The Windows installer (`freetime_<version>_x64-setup.exe`) and the freetime program inside it.
- Only files built from this repository's source code: <https://github.com/osmvision/freetime>.
  freetime has no closed-source parts. Third-party libraries are included as they are and are
  never signed with our certificate.
- Each signed file has its product name set to `freetime` and its product version set to the
  release version.

## How a release is built and signed

1. A maintainer tags a commit on `main` (for example `v0.2.0`). The tag must match the version
   in `desktop/tauri.conf.json`.
2. GitHub Actions builds the installer from that commit on a GitHub-hosted runner
   ([`.github/workflows/release.yml`](https://github.com/osmvision/freetime/blob/main/.github/workflows/release.yml)).
   Nothing that is signed is built on a personal computer.
3. The build is sent to SignPath. An approver checks that the release is intended and approves
   the signing request by hand. Every release needs this approval.
4. The signed installer is attached to a draft GitHub release, and a maintainer publishes it.

Updates inside the app are also signed with a separate updater key (minisign/ed25519). The app
refuses any update that this key did not sign.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [osmvision](https://github.com/osmvision), [Julien-13](https://github.com/Julien-13) |
| Approvers | [osmvision](https://github.com/osmvision) |

- **Committers** can change the source code in this repository.
- **Reviewers** review every change from anyone else (pull requests) before it is merged.
- **Approvers** decide whether a release may be signed.

All team members use multi-factor authentication on GitHub and on SignPath.

## Privacy policy

freetime's privacy policy: <https://osmvision.github.io/freetime/privacy.html>
(source: [`docs/privacy.md`](https://github.com/osmvision/freetime/blob/main/docs/privacy.md)).

In short, freetime works without an account, and your history and settings stay on your PC.
The app contacts these services only for what you see on screen or turn on yourself:

- Open-Meteo: weather and city search.
- The Steam store and the Epic Games Store: store picks and free games, using your country code.
- YouTube RSS: videos from the channels and topics you choose.
- Open Trivia Database: the bonus quiz, only when you open it.
- GitHub: the update check, which can be turned off in Settings.
- Supabase and Google sign-in: only if you choose to create the optional online profile, which is
  hosted in the EU.

Each of those services has its own privacy policy.

## Uninstalling

freetime installs for the current user only, without administrator rights. It can be removed
from Windows Settings → Apps, or with `uninstall.exe` in its install folder. Your history and
settings in `%APPDATA%\freetime` are kept, and you can delete that folder too.

## Reporting a problem

If you think a file signed for freetime is harmful or wasn't built from this repository, please
[open an issue](https://github.com/osmvision/freetime/issues) or write to
[support@signpath.io](mailto:support@signpath.io).
