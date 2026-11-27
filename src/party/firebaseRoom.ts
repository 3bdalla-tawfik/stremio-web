import { FirebaseError, initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectDatabaseEmulator, get, getDatabase, onDisconnect, onValue, push, ref, remove, serverTimestamp, set } from 'firebase/database';
import { initialPlayback, MEMBER, PARTY, PARTY_CONFIGURATION_REQUIRED, partyCode, type Media, type Playback, type Room } from './model';

export function logPartyFailure(operation: string, failure: unknown) {
    const cause = failure instanceof FirebaseError ? failure.code : failure instanceof Error ? failure.name : 'Unknown error';
    console.error(`Watch Party ${operation}:`, cause);
}

function initializeRoomClient() {
    const config = process.env.PARTY_FIREBASE_CONFIG;
    const useEmulator = process.env.PARTY_FIREBASE_EMULATOR === '1';
    if (!config && !useEmulator) {
        throw new Error(PARTY_CONFIGURATION_REQUIRED);
    }

    const { projectId, host, authPort, databasePort } = PARTY.emulator;
    const options: FirebaseOptions = useEmulator ? {
        projectId,
        apiKey: projectId,
        databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
    } : JSON.parse(config!);
    const app = initializeApp(options, PARTY.root);
    const auth = getAuth(app);
    const database = getDatabase(app);
    if (useEmulator) {
        connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
        connectDatabaseEmulator(database, host, databasePort);
    }

    let offset = 0;
    onValue(ref(database, PARTY.clockOffset), (snapshot) => { offset = snapshot.val() ?? 0; });
    const now = () => Date.now() + offset;
    const connectionState = ref(database, PARTY.connected);
    const roomRef = (code: string) => ref(database, `${PARTY.root}/${code}`);

    async function identify() {
        await auth.authStateReady();
        return (auth.currentUser ?? (await signInAnonymously(auth)).user).uid;
    }

    function waitForConnection() {
        return new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                unsubscribe();
                reject(new Error('Could not connect to the party server. Try again.'));
            }, PARTY.connectionTimeoutMs);
            const unsubscribe = onValue(connectionState, (snapshot) => {
                if (snapshot.val() === true) {
                    window.clearTimeout(timeout);
                    // The first callback can run before onValue returns its unsubscribe function.
                    queueMicrotask(() => unsubscribe());
                    resolve();
                }
            });
        });
    }

    return {
        now,
        async create(start: () => { media: Media; position: number }) {
            const uid = await identify();
            await waitForConnection();
            const { media, position } = start();
            const code = partyCode();
            await set(roomRef(code), {
                host: uid,
                media,
                createdAt: serverTimestamp(),
                bufferSeconds: PARTY.defaultBufferSeconds,
                playback: initialPlayback(position, now()),
                members: { [uid]: MEMBER.active },
            });
            return { code, uid };
        },
        async join(code: string) {
            const uid = await identify();
            await waitForConnection();
            await set(ref(database, `${PARTY.root}/${code}/members/${uid}`), MEMBER.active);
            const snapshot = await get(roomRef(code));
            if (!snapshot.exists()) throw new Error('The party ended while joining.');
            return { code, uid, room: snapshot.val() as Room };
        },
        watch(code: string, uid: string, onRoom: (room: Room | null) => void, onConnected: (connected: boolean) => void, onError: (error: Error) => void) {
            const presence = push(ref(database, `${PARTY.root}/${code}/presence/${uid}`));
            const disconnect = onDisconnect(presence);
            let watching = true;
            const unsubscribeRoom = onValue(roomRef(code), (snapshot) => onRoom(snapshot.val()), onError);
            const unsubscribeConnection = onValue(connectionState, (snapshot) => {
                const connected = snapshot.val() === true;
                onConnected(connected);
                if (connected) {
                    disconnect.remove().then(() => {
                        if (watching) return set(presence, true);
                    }).catch((error) => {
                        if (watching) onError(error);
                    });
                }
            });
            return () => {
                watching = false;
                unsubscribeConnection();
                unsubscribeRoom();
                // Remove first so a lost connection can still run the server-side cleanup.
                remove(presence).then(() => disconnect.cancel()).catch((error) => logPartyFailure('presence cleanup', error));
            };
        },
        publish: (code: string, playback: Playback) => set(ref(database, `${PARTY.root}/${code}/playback`), playback),
        setBuffer: (code: string, seconds: number) => set(ref(database, `${PARTY.root}/${code}/bufferSeconds`), seconds),
        kick: (code: string, uid: string) => set(ref(database, `${PARTY.root}/${code}/members/${uid}`), MEMBER.kicked),
        leave: (code: string, uid: string) => remove(ref(database, `${PARTY.root}/${code}/members/${uid}`)),
        end: (code: string) => remove(roomRef(code)),
    };
}

let client: ReturnType<typeof initializeRoomClient> | undefined;
export const getRoomClient = () => client ??= initializeRoomClient();
