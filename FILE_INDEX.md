# File index

- `src/App/App.js` — `App` provides one party session across routes.
- `src/components/NavBar/HorizontalNavBar/HorizontalNavBar.js` — `HorizontalNavBar` opens the Watch Party dialog from navigation or the player.
- `src/routes/Details/Details.tsx` — `Details` resolves movie stream identifiers and shows when a title is shared with the party.
- `src/routes/Details/useDirectEpisode.ts` — `useDirectEpisode` builds episode back navigation for direct links. Party-driven links use their existing navigation history.
- `src/routes/Player/Player.js` — `Player` routes play, pause, and seek through the active party and retains local playback controls outside it.
- `src/routes/Player/useVideo.js` — `useVideo` observes position, buffering, and cache state and dispatches controls to the active video backend.
- `src/party/FILE_INDEX.md` — room state, shared playback, and player integration.
- `firestore.rules` — Firestore membership, room changes, playback grants, and expiry.
- `desktop/PartyDesktop.cs` — `PartyDesktop.Run` finds Stremio 5, starts the bundled UI, and keeps the desktop process connected to it.
- `desktop/StaticAppServer.cs` — `StaticAppServer` serves the packaged UI and limits requests to the local PC and the app directory.
- `desktop/StreamingEngineProxy.cs` — `StreamingEngineProxy` gives the bundled interface same-origin access to the installed local streaming service.
- `desktop/PlaybackLog.cs` — writes bounded local streaming diagnostics without URLs, invite codes, or credentials.
- `desktop/package.ps1` — validates the cloud configuration, compiles the launcher, and creates the Windows ZIP.
- `tests/party-sync.test.mjs` — timeline and Firebase rules regression checks.
