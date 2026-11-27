# Watch Party

The portable Windows package launches the installed Stremio v5 shell with this fork’s interface bundled on the same PC. Its launcher serves assets on loopback for as long as the shell is open and connects the interface to the installed streaming service on the same origin. Party control lives in Stremio’s player, where the same integration can drive mpv on Windows or the HTML video player during browser development.

A host can create a room from Home or the player and share its eight-character code. A room can start before a title is selected. When the host opens a movie or selects an episode, guests are sent to its stream picker automatically. Each participant chooses a local stream for the same cut. Switching titles retains the room code, members, permissions, and prebuffer setting. Each title has a playback revision that prevents an earlier title's commands from changing the new one.

Participants choose their display names. The host can independently grant a guest Play / Pause and Seek, kick guests, and change the room’s prebuffer. Shared playback uses timestamped anchors and seeks for drift correction. Guests load normally until the player reports its first frame. A host stall pauses the room until the host has buffered enough. Guest players use their own buffering and catch up once ready.

Cloud Firestore carries title identifiers, playback, membership, and presence. Source URLs stay in each player. Firestore rules enforce anonymous identity, membership, expiry, and per-member permissions. A kicked identity cannot rejoin. Presence heartbeats let guests pause after a missed host connection. Rooms expire after 12 hours, and hosts can end them sooner. The last five rooms are stored on the device for rejoining.
