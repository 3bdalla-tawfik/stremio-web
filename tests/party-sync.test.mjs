import assert from 'node:assert/strict';
import test from 'node:test';
import { guestPlaybackAction, initialPlayback, nextPlayback, PARTY, STATUS, pointAt, positionAt, validCode, partyCode } from '../src/party/model.ts';

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

test('Firebase rules enforce room membership, host playback ownership, and kicking', { skip: process.env.PARTY_FIREBASE_EMULATOR !== '1' }, async () => {
    const { host, authPort, databasePort, projectId } = PARTY.emulator;
    const signup = async () => {
        const response = await fetch(`http://${host}:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${projectId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true }),
        });
        assert.equal(response.status, 200);
        return response.json();
    };
    const [owner, guest] = await Promise.all([signup(), signup()]);
    const code = partyCode();
    assert.ok(validCode(code));
    const request = (user, method, path = '', value) => {
        const url = new URL(`http://${host}:${databasePort}/${PARTY.root}/${code}${path}.json`);
        url.searchParams.set('ns', `${projectId}-default-rtdb`);
        if (user) url.searchParams.set('auth', user.idToken);
        return fetch(url, { method, body: value === undefined ? undefined : JSON.stringify(value) });
    };
    const playback = initialPlayback(0, Date.now());
    const created = await request(owner, 'PUT', '', {
        host: owner.localId,
        media: { type: 'movie', id: 'tt0000001', videoId: 'tt0000001' },
        bufferSeconds: 2,
        createdAt: { '.sv': 'timestamp' },
        playback,
        members: { [owner.localId]: 'active' },
    });
    assert.equal(created.status, 200, await created.text());
    try {
        assert.equal((await request(guest, 'GET')).status, 401);
        assert.equal((await request(null, 'GET')).status, 401);
        const guestMembership = `/members/${guest.localId}`;
        assert.equal((await request(guest, 'PUT', guestMembership, 'active')).status, 200);
        assert.equal((await request(guest, 'GET')).status, 200);
        const command = nextPlayback(playback, { kind: 'play', position: 0 }, Date.now());
        assert.equal((await request(guest, 'PUT', '/playback', command)).status, 401);
        assert.equal((await request(guest, 'PUT', '/bufferSeconds', 5)).status, 401);
        assert.equal((await request(owner, 'PUT', '/bufferSeconds', 5)).status, 200);
        assert.equal((await request(owner, 'PUT', '/playback', command)).status, 200);
        assert.equal((await request(owner, 'PUT', '/playback', command)).status, 401);
        assert.equal((await request(owner, 'PUT', guestMembership, 'kicked')).status, 200);
        assert.equal((await request(guest, 'GET')).status, 401);
        assert.equal((await request(guest, 'PUT', guestMembership, 'active')).status, 401);
    } finally {
        assert.equal((await request(owner, 'DELETE')).status, 200);
    }
});
