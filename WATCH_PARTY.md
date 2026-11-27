# Watch Party on Windows

## Share the Windows app

Send `dist/Stremio-Party-Windows.zip` to your friends. Everyone installs Stremio 5 for Windows, extracts the full ZIP, and opens **Stremio Party.exe**. Exit any existing Stremio window from the system tray first. The app serves its bundled interface from each PC and connects to the shared Firebase project for party sync.

To regenerate the ZIP after changing the app, build with the project's public Firebase configuration and run the Windows packaging script from the checkout.

```powershell
Remove-Item Env:PARTY_FIREBASE_EMULATOR -ErrorAction SilentlyContinue
$env:PARTY_FIREBASE_CONFIG = Get-Content -Raw '.\.stremio-party.firebase.local.json'
$env:PARTY_DESKTOP_BUILD = '1'
pnpm build
.\desktop\package.ps1
```

## Run locally for development

Install Node.js 22 or later, pnpm 11, the Firebase CLI and Java for the emulators, and Stremio v5 for Windows. Run these commands from the checkout.

```powershell
pnpm install --frozen-lockfile
firebase emulators:start --only auth,firestore --project demo-stremio-party
```

Start the fork in another PowerShell window.

```powershell
$env:PARTY_FIREBASE_EMULATOR = '1'
pnpm start
```

Exit the existing Stremio app from the system tray before launching the same Windows shell against the party build. This command uses the default installation path.

```powershell
& "$env:LOCALAPPDATA\Programs\Stremio\stremio-shell-ng.exe" --webui-url=http://127.0.0.1:8080/
```

You can also open `http://127.0.0.1:8080/` in two separate browser profiles for a local smoke test. Use the same movie or episode, with a stream each profile can play.

## Watch together

1. On Home or the player, open **Watch Party**, enter a display name, and select **Create party** and **Copy code**.
2. Guests open **Watch Party**, enter a display name and the code, then select **Join**. Guests can join before a title is picked.
3. The host opens a movie or selects an episode. Guests are sent to its stream picker automatically each time the title changes. Everyone picks a stream for the same cut in the built-in player.
4. The host can reopen **Watch Party** to grant **Play / Pause** or **Seek** to each guest, change the prebuffer, kick guests, or end the party. Each guest can edit their display name.
5. To return to an active room, select **Rejoin** under **Recent parties**. The five most recent parties are saved on the current device.

## Use a different Firebase project

Enable Anonymous Authentication and create the default Cloud Firestore database in your Firebase project. Save the Web app’s public Firebase configuration as `.stremio-party.firebase.local.json` in the checkout. Deploy the included rules to that project, then build and package the Windows app again. Everyone in the party uses the Firestore build configured for the same project. Schedule the switch once existing Realtime Database rooms have finished.

```powershell
firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
```

The Firebase configuration is built into the client. Use public Web configuration only. The app and rules enforce the 12-hour room lifetime. For a public deployment, use a trusted administrative job to recursively delete expired room documents and their member subcollections.

## Validate the party

Run the tests with the emulators running.

```powershell
$env:PARTY_FIREBASE_EMULATOR = '1'
node --test tests/party-sync.test.mjs
```
