import assert from 'node:assert/strict';
import test from 'node:test';
import { guestPlaybackAction, initialPlayback, nextPlayback, PARTY, STATUS, pointAt, positionAt, validCode, partyCode, COMMAND, MEMBER, NO_PERMISSIONS } from '../src/party/model.ts';

test('scheduled play and pause retain the same media position across delayed deliveries', () => {
    const initial = initialPlayback(10000, 1000);
    const playing = nextPlayback(initial, { kind: 'play', position: 10000 }, 2000);
    const start = 2000 + PARTY.commandLeadMs;
    assert.equal(pointAt(playing, start - 1).playing, false);
    assert.equal(positionAt(pointAt(playing, start + 300), start + 300), 10300);
    const paused = nextPlayback(playing, { kind: 'pause', position: 0 }, start + 5000);
    const pause = start + 5000 + PARTY.commandLeadMs;
    assert.equal(pointAt(paused, pause - 1).playing, true);
    assert.equal(pointAt(paused, pause).playing, false);
    assert.equal(positionAt(pointAt(paused, pause + 800), pause + 800), 10000 + 5000 + PARTY.commandLeadMs);
});

test('host buffering holds the room and a seek while playing prepares a shared restart', () => {
    const playing = nextPlayback(initialPlayback(2000, 1000), { kind: 'play', position: 2000 }, 1000);
    const buffering = nextPlayback(playing, { kind: 'buffer', position: 4000 }, 4000);
    assert.equal(positionAt(pointAt(buffering, 9000), 9000), 4000);
    assert.equal(buffering.autoResume, true);
    const seeking = nextPlayback(playing, { kind: 'seek', position: 12000 }, 4000);
    assert.equal(pointAt(seeking, seeking.target.at - 1).playing, true);
    assert.equal(pointAt(seeking, seeking.target.at).position, 12000);
    assert.equal(seeking.autoResume, true);
    assert.equal(nextPlayback(buffering, { kind: 'pause', position: 4000 }, 4000).autoResume, false);
});

test('a guest loads normally before the first frame and keeps playback requested while buffering', () => {
    const point = { position: 30000, playing: true, at: 1000 };
    const state = { loaded: false, time: 0, duration: 90000, paused: false, buffering: true };
    assert.deepEqual(guestPlaybackAction(state, point, 1000, true), { status: STATUS.loading });
    assert.deepEqual(guestPlaybackAction(state, { ...point, playing: false }, 1000, true), { status: STATUS.loading });

    const buffering = guestPlaybackAction({ ...state, loaded: true, paused: true }, point, 1000, true);
    assert.deepEqual(buffering, { status: STATUS.buffering, paused: false });
    const ready = { ...state, loaded: true, buffering: false };
    assert.deepEqual(guestPlaybackAction(ready, point, 1000, true), { status: STATUS.syncing, paused: undefined, seekTo: 30000 });
    assert.equal(guestPlaybackAction(ready, point, 1000, false).seekTo, undefined);
    assert.equal(guestPlaybackAction({ ...ready, time: 29600 }, point, 1000, true).seekTo, undefined);
    assert.equal(guestPlaybackAction({ ...ready, time: 30000 }, { ...point, playing: false }, 1000, true).paused, true);
});

test('Firestore enforces invite membership, independent playback grants and room transitions', {
    skip: process.env.PARTY_FIREBASE_EMULATOR !== '1',
}, async () => {
    const { initializeApp, deleteApp } = await import('firebase/app');
    const { getAuth, connectAuthEmulator, signInAnonymously } = await import('firebase/auth');
    const {
        getFirestore, connectFirestoreEmulator, doc, getDocFromServer, onSnapshot, serverTimestamp,
        setDoc, updateDoc, deleteDoc, writeBatch,
    } = await import('firebase/firestore');
    const { host, authPort, firestorePort, projectId } = PARTY.emulator;
    const apps = [];
    const connect = async (name, signedIn = true) => {
        const app = initializeApp({ projectId, apiKey: projectId }, name);
        apps.push(app);
        const db = getFirestore(app);
        connectFirestoreEmulator(db, host, firestorePort);
        if (!signedIn) return { db };
        const auth = getAuth(app);
        connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
        const { user } = await signInAnonymously(auth);
        return { db, uid: user.uid };
    };
    const code = partyCode();
    assert.ok(validCode(code));
    const room = ({ db }) => doc(db, PARTY.root, code);
    const membership = (client, uid = client.uid) => doc(room(client), PARTY.members, uid);
    const denied = (operation) => assert.rejects(operation, { code: 'permission-denied' });
    const newMember = (name) => ({ name, status: MEMBER.active, permissions: NO_PERMISSIONS, lastSeen: null, heartbeatId: null });
    const playback = initialPlayback(0, Date.now());
    const episode = { type: 'series', id: 'tt0000001', videoId: 'tt0000001:1:2' };
    let unsubscribe;

    try {
        const [owner, guest, visitor] = await Promise.all([connect('host'), connect('guest'), connect('visitor', false)]);
        const batch = writeBatch(owner.db);
        batch.set(room(owner), {
            host: owner.uid, media: null, mediaRevision: 0, bufferSeconds: PARTY.defaultBufferSeconds,
            createdAt: serverTimestamp(), endedAt: null, playback,
        });
        batch.set(membership(owner), newMember('Host'));
        await batch.commit();

        await denied(getDocFromServer(room(visitor)));
        await denied(getDocFromServer(room(guest)));
        await denied(setDoc(membership(guest), { ...newMember('Guest'), permissions: { ...NO_PERMISSIONS, seek: true } }));
        await setDoc(membership(guest), newMember('Guest'));
        assert.equal((await getDocFromServer(room(guest))).data().media, null);
        await updateDoc(membership(guest), { name: 'Sam' });
        assert.equal((await getDocFromServer(membership(owner, guest.uid))).data().name, 'Sam');

        const titleChange = new Promise((resolve, reject) => {
            unsubscribe = onSnapshot(room(guest), (snapshot) => {
                if (!snapshot.metadata.fromCache && snapshot.data()?.mediaRevision === 1) resolve(snapshot.data());
            }, reject);
        });
        const change = { media: episode, mediaRevision: 1, playback };
        await denied(updateDoc(room(guest), change));
        await updateDoc(room(owner), change);
        assert.deepEqual((await titleChange).media, episode);
        unsubscribe();
        unsubscribe = undefined;
        await denied(updateDoc(room(owner), { ...change, media: { ...episode, videoId: 'tt0000001:1:3' } }));
        await updateDoc(membership(owner), { lastSeen: serverTimestamp(), heartbeatId: partyCode() });

        const play = () => nextPlayback(playback, { kind: COMMAND.play, position: 0 }, Date.now());
        const seek = (from) => nextPlayback(from, { kind: COMMAND.seek, position: 24000 }, Date.now());
        await denied(updateDoc(room(guest), { playback: play() }));
        await denied(updateDoc(room(guest), { playback: seek(playback) }));
        await denied(updateDoc(room(guest), { bufferSeconds: 5 }));
        await denied(updateDoc(membership(guest), 'permissions.playPause', true));

        await updateDoc(membership(owner, guest.uid), 'permissions.playPause', true);
        await denied(updateDoc(room(guest), { playback: seek(playback) }));
        const forgedPlay = play();
        forgedPlay.target.position = 24000;
        await denied(updateDoc(room(guest), { playback: forgedPlay }));
        const playing = play();
        await updateDoc(room(guest), { playback: playing });
        await denied(updateDoc(room(guest), { playback: playing }));
        const pause = () => nextPlayback(playing, { kind: COMMAND.pause, position: 0 }, Date.now());
        await updateDoc(membership(owner, guest.uid), { permissions: { playPause: false, seek: true } });
        await denied(updateDoc(room(guest), { playback: pause() }));
        const forgedSeek = seek(playing);
        forgedSeek.autoResume = false;
        await denied(updateDoc(room(guest), { playback: forgedSeek }));
        await updateDoc(room(guest), { playback: seek(playing) });

        await deleteDoc(membership(guest));
        await denied(getDocFromServer(room(guest)));
        await setDoc(membership(guest), newMember('Sam'));
        assert.equal((await getDocFromServer(room(guest))).data().mediaRevision, 1);
        await updateDoc(membership(owner, guest.uid), { status: MEMBER.kicked });
        await denied(getDocFromServer(room(guest)));
        await denied(deleteDoc(membership(guest)));
        await denied(setDoc(membership(guest), newMember('Sam')));

        await updateDoc(room(owner), { endedAt: serverTimestamp() });
        assert.ok((await getDocFromServer(room(owner))).data().endedAt);
        await denied(updateDoc(room(owner), { bufferSeconds: 5 }));
    } finally {
        unsubscribe?.();
        await Promise.all(apps.map(deleteApp));
    }
});
