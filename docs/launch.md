# Public launch checklist

Three things stand between "works on our PCs" and "anyone can install it":
signed auto-updates, a code-signing certificate, and a published Google sign-in screen.

## 1. Auto-updates (done in the code, one setup step left)

How it works:

- `.github/workflows/release.yml` builds the Windows installer when a `v*` tag is pushed and
  puts it in a **draft** GitHub release, with `latest.json` next to it.
- The installer is signed with the **updater key**. Its public half is in
  `desktop/tauri.conf.json` (`plugins.updater.pubkey`). The app checks the signature and
  refuses any update that the key didn't sign, even one served from the right URL.
- The app reads
  `https://github.com/osmvision/freetime/releases/latest/download/latest.json`
  30 seconds after it starts and then every 12 hours. It does this only when
  "Check for updates automatically" is on in Settings → Updates (on by default).
  The request carries no account and no ID. The installer is downloaded only after the
  user clicks "Install and restart".
- Debug builds (`cargo run`, `tauri dev`) never update themselves.

**One-time setup (the repo owner):**

The private key is in `%USERPROFILE%\.tauri\freetime-updater.key` and its password is in
`freetime-updater.password` next to it. They are **not** in the repo and must never be.

1. **Back both files up somewhere safe**, such as a password manager.
   If they are lost, installed copies can no longer be updated. Every user would have to
   reinstall by hand once.
2. Store them as GitHub Actions secrets from the repo folder:

   ```powershell
   Get-Content -Raw "$env:USERPROFILE\.tauri\freetime-updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY
   Get-Content -Raw "$env:USERPROFILE\.tauri\freetime-updater.password" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```

**To ship a version:**

1. Raise `version` in `desktop/tauri.conf.json` (and `desktop/Cargo.toml`), for example `0.2.0`.
   Merge that to `main`.
2. Tag and push the tag:

   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The workflow refuses a tag that doesn't match the version.
3. When the workflow is green, open the draft release on GitHub, write what changed and press
   **Publish**. Installed apps see the new version within 12 hours, or straight away with
   "Check now".

## 2. Code-signing certificate (costs money or an application)

Without a signature, Windows SmartScreen shows "Windows protected your PC / Unknown publisher"
to the first people who download the installer. Signing gives the installer a publisher name,
and SmartScreen warnings fade as the signed file builds a reputation. Since 2024, even the
expensive EV certificates no longer skip that reputation phase, so an ordinary (OV)
certificate is enough.

Options for a public, MIT-licensed project, cheapest first:

| Option | Cost | Notes |
| --- | --- | --- |
| **SignPath Foundation** (signpath.org) | Free for open source | Apply with the repo. They sign builds coming from our GitHub Actions. The publisher shown is "SignPath Foundation". Best fit if accepted. |
| **Certum Open Source Code Signing** | About €30–70 a year | Issued to an individual. Needs ID checks. The key lives in a smart card or in their SimplySign cloud. Shows your own name as the publisher. |
| **Azure Trusted Signing** | About $10 a month | Signs in the cloud from CI. Check whether individuals in your country are eligible before paying. |
| Commercial OV certificate (Sectigo, DigiCert…) | €200+ a year | Hardware token required. |

Once one is chosen, signing plugs into `bundle.windows.signCommand` in `tauri.conf.json`, or into
the release workflow. That's a small follow-up change.
The **updater key above is separate**: it protects updates and is free. The certificate
only changes what Windows shows the first time someone installs.

## 3. Publishing the Google sign-in screen

While the Google project is in **Testing**, only the test users listed in the console can sign
in (up to 100). Everyone else gets "Access blocked". To open sign-in to everyone:

1. Open Google Cloud console → **Google Auth Platform** for the freetime project.
2. **Branding**:
   - App name: `freetime`
   - User support email: an address you're happy to show publicly
   - Application home page: `https://github.com/osmvision/freetime`
   - Privacy policy link: `https://github.com/osmvision/freetime/blob/main/docs/privacy.md`
   - Authorized domains: `tgvphbmbxfembnsfdxlp.supabase.co` (the sign-in redirect goes there)
   - **Leave the logo empty.** Uploading a logo starts a Google review that takes days or weeks.
3. **Data access**: only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
   These are "non-sensitive" scopes: no security assessment is needed.
4. **Audience** → **Publish app** → confirm. The status becomes "In production". With only
   non-sensitive scopes and no logo, this is immediate.

What users then see: Google's account chooser saying
"to continue to tgvphbmbxfembnsfdxlp.supabase.co". There are two ways to show "freetime"
instead, both optional and both for later:

- **Brand verification**: needs a home page on a domain you own and have verified in
  Google Search Console (a GitHub Pages site on your own domain works). Google then reviews it.
- A **custom domain** for Supabase (a paid Supabase add-on), such as `auth.yourdomain`.

## Before announcing it

- [ ] Updater secrets set, and the key and password backed up.
- [ ] First tagged release published, then installed on a clean PC. The update to a second
      tagged release worked.
- [ ] Google sign-in screen published, and sign-in tested with an account that isn't a test user.
- [ ] Signing certificate chosen (optional for a first small launch).
- [ ] `docs/privacy.md` reviewed: it mentions the update check.
