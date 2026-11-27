# Watch Party file index

- `model.ts` — `nextPlayback`, `pointAt`, and `positionAt` model shared playback on the Firebase clock. `getPartyMedia` extracts eligible movie and episode identifiers.
- `model.ts` — `playbackReady` and `guestPlaybackAction` keep room controls out of native startup and use seeks for guest catch-up.
- `firebaseRoom.ts` — `getRoomClient` connects to Firestore or local emulators. `watch` observes room and member snapshots and renews presence. `share` and `publish` guard title and playback revisions in transactions.
- `PartyProvider.tsx` — `PartyProvider` shares the host’s active title and routes guests to its local stream picker. The dialog handles room creation, member names, grants, and rejoining.
- `localPartySettings.ts` — `rememberParty` retains the five most recent distinct codes and `markPartyUnavailable` records closed or inaccessible rooms on this device.
- `usePartyPlayback.ts` — `usePartyPlayback` applies scheduled commands, corrects drift, and handles host and guest buffering.
