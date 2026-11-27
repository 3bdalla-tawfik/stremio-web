import { FirebaseError, initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import {
    collection, connectFirestoreEmulator, doc, getDocFromServer, getFirestore, onSnapshot,
    runTransaction, serverTimestamp, updateDoc, type DocumentData, type Timestamp,
} from 'firebase/firestore';
import {
    COMMAND, MEMBER, NO_PERMISSIONS, PARTY, PARTY_CONFIGURATION_REQUIRED, canControl, initialPlayback,
    memberOnline, memberPlaybackIntent, nextPlayback, partyCode, pointAt, positionAt, sameMedia,
    type Media, type Member, type Permission, type PlaybackIntent, type Room,
} from './model';

type StoredRoom = Omit<Room, 'createdAt' | 'endedAt'> & { createdAt: Timestamp; endedAt: Timestamp | null };
type StoredMember = Omit<Member, 'lastSeen'> & { lastSeen: Timestamp | null };
type Start = { media: Media | null; position: number };

export const PARTY_UNAVAILABLE = 'This party is unavailable. It may have ended or expired.';

export function logPartyFailure(operation: string, failure: unknown) {
    const cause = failure instanceof FirebaseError ? failure.code : failure instanceof Error ? failure.name : 'Unknown error';
    console.error(`Watch Party ${operation}:`, cause);
}

function readRoom(data: DocumentData): Room {
    const room = data as StoredRoom;
    return { ...room, createdAt: room.createdAt.toMillis(), endedAt: room.endedAt?.toMillis() ?? null };
}

function readMember(data: DocumentData): Member {
    const member = data as StoredMember;
    return { ...member, lastSeen: member.lastSeen?.toMillis() ?? null };
}

function initializeRoomClient() {
    const config = process.env.PARTY_FIREBASE_CONFIG;
    const useEmulator = process.env.PARTY_FIREBASE_EMULATOR === '1';
    if (!config && !useEmulator) throw new Error(PARTY_CONFIGURATION_REQUIRED);

    const { projectId, host, authPort, firestorePort } = PARTY.emulator;
    const options: FirebaseOptions = useEmulator ? { projectId, apiKey: projectId } : JSON.parse(config!);
    const app = initializeApp(options, PARTY.root);
    const auth = getAuth(app);
    const database = getFirestore(app);
    if (useEmulator) {
        connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
        connectFirestoreEmulator(database, host, firestorePort);
    }

    let offset = 0;
    let signingIn: ReturnType<typeof signInAnonymously> | undefined;
    const now = () => Date.now() + offset;
    const roomRef = (code: string) => doc(database, PARTY.root, code);
    const membersRef = (code: string) => collection(roomRef(code), PARTY.members);
    const memberRef = (code: string, uid: string) => doc(membersRef(code), uid);

    async function identify() {
        await auth.authStateReady();
        if (auth.currentUser) return auth.currentUser.uid;
        signingIn ??= signInAnonymously(auth).finally(() => { signingIn = undefined; });
        return (await signingIn).user.uid;
    }

    async function openRoom(code: string, uid: string) {
        const snapshot = await getDocFromServer(roomRef(code));
        if (!snapshot.exists()) throw new Error(PARTY_UNAVAILABLE);
        const room = readRoom(snapshot.data());
        if (room.endedAt !== null) throw new Error(PARTY_UNAVAILABLE);
        return { code, uid, room, host: room.host === uid };
    }

    return {
        now,
        async create(start: () => Start, name: string) {
            const uid = await identify();
            const { media, position } = start();
            const code = partyCode();
            await runTransaction(database, async (transaction) => {
                transaction.set(roomRef(code), {
                    host: uid,
                    media,
                    mediaRevision: 0,
                    createdAt: serverTimestamp(),
                    endedAt: null,
                    bufferSeconds: PARTY.defaultBufferSeconds,
                    playback: initialPlayback(position, now()),
                });
                transaction.set(memberRef(code, uid), {
                    name, status: MEMBER.active, permissions: NO_PERMISSIONS, lastSeen: null, heartbeatId: null,
                });
            });
            return openRoom(code, uid);
        },
        async join(code: string, name: string) {
            const uid = await identify();
            const membership = memberRef(code, uid);
            try {
                await runTransaction(database, async (transaction) => {
                    const previous = await transaction.get(membership);
                    if (previous.exists()) {
                        if (previous.data().status === MEMBER.kicked) throw new Error(PARTY_UNAVAILABLE);
                        if (previous.data().name !== name) transaction.update(membership, { name });
                    } else {
                        transaction.set(membership, {
                            name, status: MEMBER.active, permissions: NO_PERMISSIONS, lastSeen: null, heartbeatId: null,
                        });
                    }
                });
                return await openRoom(code, uid);
            } catch (error) {
                if (error instanceof FirebaseError && error.code === 'permission-denied') throw new Error(PARTY_UNAVAILABLE);
                throw error;
            }
        },
        watch(
            code: string,
            uid: string,
            isHost: boolean,
            onRoom: (room: Room | null) => void,
            onMembers: (members: Record<string, Member>) => void,
            onConnected: (connected: boolean) => void,
            onError: (error: Error) => void,
        ) {
            const membership = memberRef(code, uid);
            const reference = roomRef(code);
            let watching = true;
            let sending = false;
            let roomFromServer = false;
            let submittedAt = 0;
            let confirmedAt = 0;
            let heartbeatId: string | null = null;
            let acknowledgedId: string | null = null;

            const updateConnection = () => {
                onConnected(roomFromServer && Date.now() - confirmedAt < PARTY.presenceTimeoutMs);
            };
            const heartbeat = async () => {
                updateConnection();
                if (sending) return;
                sending = true;
                submittedAt = Date.now();
                heartbeatId = partyCode();
                try {
                    await runTransaction(database, async (transaction) => {
                        if (!watching) return;
                        if (isHost) {
                            const member = await transaction.get(membership);
                            const seen = member.exists() ? readMember(member.data()).lastSeen : null;
                            if (seen !== null && now() - seen >= PARTY.presenceTimeoutMs) {
                                const snapshot = await transaction.get(reference);
                                if (snapshot.exists()) {
                                    const { playback } = readRoom(snapshot.data());
                                    if (playback.target.playing || playback.autoResume) {
                                        const stoppedAt = Math.floor(seen) + PARTY.presenceTimeoutMs;
                                        const position = positionAt(pointAt(playback, stoppedAt), stoppedAt);
                                        transaction.update(reference, { playback: nextPlayback(playback, { kind: COMMAND.hold, position }, stoppedAt) });
                                    }
                                }
                            }
                        }
                        transaction.update(membership, { lastSeen: serverTimestamp(), heartbeatId });
                    });
                } catch (error) {
                    if (watching) {
                        logPartyFailure('presence heartbeat', error);
                        if (error instanceof FirebaseError && error.code === 'permission-denied') onError(error);
                    }
                } finally {
                    sending = false;
                }
            };

            const stopRoom = onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
                roomFromServer = !snapshot.metadata.fromCache;
                updateConnection();
                if (roomFromServer && !snapshot.metadata.hasPendingWrites) {
                    onRoom(snapshot.exists() ? readRoom(snapshot.data()) : null);
                }
            }, onError);
            const stopMembers = onSnapshot(membersRef(code), { includeMetadataChanges: true }, (snapshot) => {
                if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
                const members = Object.fromEntries(snapshot.docs.map((entry) => [entry.id, readMember(entry.data())]));
                const ownSeen = members[uid]?.lastSeen;
                const ownHeartbeat = snapshot.docs.find((entry) => entry.id === uid)?.data().heartbeatId;
                if (ownSeen !== undefined && ownSeen !== null && ownHeartbeat === heartbeatId && ownHeartbeat !== acknowledgedId) {
                    acknowledgedId = ownHeartbeat;
                    confirmedAt = Date.now();
                    offset = Math.round(ownSeen - (submittedAt + confirmedAt) / 2);
                    updateConnection();
                }
                onMembers(members);
            }, onError);

            void heartbeat();
            const timer = window.setInterval(() => void heartbeat(), PARTY.heartbeatMs);
            return () => {
                watching = false;
                window.clearInterval(timer);
                stopMembers();
                stopRoom();
            };
        },
        async publish(code: string, mediaRevision: number, revision: number, intent: PlaybackIntent) {
            const uid = await identify();
            const reference = roomRef(code);
            return runTransaction(database, async (transaction) => {
                const snapshot = await transaction.get(reference);
                if (!snapshot.exists()) return;
                const room = readRoom(snapshot.data());
                if (room.endedAt !== null || room.media === null || room.mediaRevision !== mediaRevision || room.playback.revision !== revision) return;
                const isHost = uid === room.host;
                if (!isHost) {
                    const author = await transaction.get(memberRef(code, uid));
                    if (!author.exists()) return;
                    const member = readMember(author.data());
                    if (member.status !== MEMBER.active || !canControl(false, member.permissions, intent)) return;
                    const host = await transaction.get(memberRef(code, room.host));
                    if (!host.exists() || !memberOnline(readMember(host.data()), now())) return;
                }
                const at = now();
                const command = isHost ? intent : memberPlaybackIntent(room.playback, intent, at);
                transaction.update(reference, { playback: nextPlayback(room.playback, command, at) });
            });
        },
        async share(code: string, media: Media) {
            const reference = roomRef(code);
            await runTransaction(database, async (transaction) => {
                const snapshot = await transaction.get(reference);
                if (!snapshot.exists()) throw new Error(PARTY_UNAVAILABLE);
                const room = readRoom(snapshot.data());
                if (room.endedAt !== null) throw new Error(PARTY_UNAVAILABLE);
                if (!sameMedia(room.media, media)) {
                    transaction.update(reference, {
                        media,
                        mediaRevision: room.mediaRevision + 1,
                        playback: initialPlayback(0, now()),
                    });
                }
            });
        },
        setBuffer: (code: string, seconds: number) => updateDoc(roomRef(code), { bufferSeconds: seconds }),
        setName: (code: string, uid: string, name: string) => updateDoc(memberRef(code, uid), { name }),
        setPermission: (code: string, uid: string, permission: Permission, enabled: boolean) =>
            updateDoc(memberRef(code, uid), `permissions.${permission}`, enabled),
        kick: (code: string, uid: string) => updateDoc(memberRef(code, uid), { status: MEMBER.kicked }),
        leave: (code: string, uid: string) => runTransaction(database, async (transaction) => {
            transaction.delete(memberRef(code, uid));
        }),
        end: (code: string) => runTransaction(database, async (transaction) => {
            transaction.update(roomRef(code), { endedAt: serverTimestamp() });
        }),
    };
}

let client: ReturnType<typeof initializeRoomClient> | undefined;
export const getRoomClient = () => client ??= initializeRoomClient();
