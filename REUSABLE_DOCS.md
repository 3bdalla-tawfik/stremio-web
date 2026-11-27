# Reusable code

## Utilities

`useLiveRef` — `src/common/useLiveRef.js` — read fresh React state from long-lived callbacks — `useLiveRef(value)`

`pointAt`, `positionAt`, `nextPlayback` — `src/party/model.ts` — schedule a playback transition and compute the shared media position at a server time — `nextPlayback(playback, intent, now)`

`playbackReady`, `guestPlaybackAction` — `src/party/model.ts` — gate guest sync until the player is loaded and decide when to pause, play, or seek — `guestPlaybackAction(state, point, now, canSeek)`

`logPartyFailure` — `src/party/firebaseRoom.ts` — log Firebase error codes without invite codes or database paths — `logPartyFailure(operation, failure)`

## Services

`getRoomClient` — `src/party/firebaseRoom.ts` — initialize the party Firebase client and manage rooms, presence, and host commands — `getRoomClient()`

`StaticAppServer` — `desktop/StaticAppServer.cs` — serve the bundled interface on loopback while the Windows shell runs — `StaticAppServer(appDirectory, address).Start()`

## Components and hooks

`PartyProvider`, `useParty` — `src/party/PartyProvider.tsx` — frame-wide room session and Watch Party dialog — `useParty().open()`

`usePartyPlayback` — `src/party/usePartyPlayback.ts` — bind the shared room to an active Stremio player — `usePartyPlayback(video, media, focused)`
