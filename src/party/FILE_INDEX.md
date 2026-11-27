# Watch Party file index

- `model.ts` — `nextPlayback`, `pointAt`, and `positionAt` model shared playback on the Firebase clock. `getPartyMedia` extracts eligible movie and episode identifiers.
- `model.ts` — `playbackReady` and `guestPlaybackAction` keep room controls out of native startup and use seeks for guest catch-up.
- `firebaseRoom.ts` — `getRoomClient` connects to Firebase or local emulators. `watch` tracks room state and per-connection presence.
- `PartyProvider.tsx` — `PartyProvider` provides the room session, command permissions, and create/join dialog across route changes.
- `usePartyPlayback.ts` — `usePartyPlayback` applies scheduled commands, corrects drift, and handles host and guest buffering.
