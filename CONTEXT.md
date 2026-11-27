# Watch Party

The portable Windows package launches the installed Stremio v5 shell with this fork’s interface bundled on the same PC. Its launcher serves assets on loopback for as long as the shell is open and connects the interface to the installed streaming service on the same origin. Party control lives in Stremio’s player, where the same integration can drive mpv on Windows or the HTML video player during browser development.

The host opens a movie or episode, creates a room from the player, and shares the eight-character code. Guests join by code and choose a local stream of the same cut. Firebase carries the title identifiers, playback timeline, membership, and presence. Private source URLs stay in each player.

The host controls play, pause, seek, member removal, and the room’s prebuffer. The host and guests use the same timestamped playback anchors. Party sync leaves playback speed alone and seeks only for larger drift. Guests load normally until the player reports its first frame. A host stall pauses the room until the host has buffered enough. Guest players use their own buffering and catch up once they are ready.

Anonymous Firebase identities enforce membership and host authority. A removed identity cannot rejoin the same room. Host disconnects pause guests once presence is lost. Rooms become inaccessible after 12 hours and the host can end them sooner.
