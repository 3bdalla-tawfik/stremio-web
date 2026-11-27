export const PARTY = {
    root: 'watchParties',
    codeAlphabet: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
    codeLength: 8,
    maxRoomAge: 12 * 60 * 60 * 1000,
    defaultBufferSeconds: 2,
    bufferChoices: [1, 2, 3, 5, 10, 15],
    connectionTimeoutMs: 8000,
    commandLeadMs: 750,
    tickMs: 100,
    softDriftMs: 200,
    hardDriftMs: 1200,
    seekCooldownMs: 4000,
    clockOffset: '/.info/serverTimeOffset',
    connected: '/.info/connected',
    emulator: { projectId: 'demo-stremio-party', host: '127.0.0.1', authPort: 9099, databasePort: 9000 },
} as const;

export const MEMBER = { active: 'active', kicked: 'kicked' } as const;
export const PARTY_CONFIGURATION_REQUIRED = 'Watch Party needs a Firebase project. See the Watch Party setup guide.';
export const STATUS = {
    loading: ['WATCH_PARTY_LOADING', 'Loading stream…'],
    syncing: ['WATCH_PARTY_SYNCING', 'Syncing playback…'],
    buffering: ['WATCH_PARTY_BUFFERING', 'Buffering…'],
    hostBuffering: ['WATCH_PARTY_HOST_BUFFERING', 'Waiting for host to buffer…'],
    reconnecting: ['WATCH_PARTY_RECONNECTING', 'Reconnecting to the party…'],
    waitingHost: ['WATCH_PARTY_WAITING_HOST', 'Waiting for the host…'],
    synced: ['WATCH_PARTY_SYNCED', 'In sync'],
    paused: ['WATCH_PARTY_PAUSED', 'Paused'],
} as const;
export type PartyStatus = typeof STATUS[keyof typeof STATUS];

export type Media = { type: 'movie' | 'series'; id: string; videoId: string };
export type PlaybackPoint = { position: number; playing: boolean; at: number };
export type PlaybackState = {
    loaded?: boolean;
    time: number | null;
    duration: number | null;
    paused: boolean | null;
    buffering: boolean | null;
};
export type Playback = { previous: PlaybackPoint; target: PlaybackPoint; revision: number; autoResume: boolean };
export type Room = {
    host: string;
    media: Media;
    createdAt: number;
    bufferSeconds: number;
    playback: Playback;
    members: Record<string, typeof MEMBER[keyof typeof MEMBER]>;
    presence?: Record<string, Record<string, true>>;
};
export type PlaybackIntent =
    | { kind: 'play' | 'pause'; position: number }
    | { kind: 'seek'; position: number }
    | { kind: 'buffer' | 'hold'; position: number };

export function partyCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(PARTY.codeLength));
    return Array.from(bytes, (byte) => PARTY.codeAlphabet[byte % PARTY.codeAlphabet.length]).join('');
}

export function normalizeCode(value: string) {
    return value.toUpperCase().replace(/[\s-]/g, '');
}

export function validCode(value: string) {
    return value.length === PARTY.codeLength && Array.from(value).every((character) => PARTY.codeAlphabet.includes(character));
}

export function sameMedia(left: Media | null, right: Media) {
    return left?.type === right.type && left.id === right.id && left.videoId === right.videoId;
}

const MEDIA_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function getPartyMedia(type: string | undefined, id: string | undefined, videoId: string | undefined): Media | null {
    if ((type !== 'movie' && type !== 'series') || !id || !videoId || !MEDIA_ID.test(id) || !MEDIA_ID.test(videoId)) return null;
    return { type, id, videoId };
}

export function pointAt(playback: Playback, now: number) {
    return now < playback.target.at ? playback.previous : playback.target;
}

export function positionAt(point: PlaybackPoint, now: number) {
    return point.position + (point.playing ? Math.max(0, now - point.at) : 0);
}

export function playbackReady(state: PlaybackState): state is PlaybackState & { loaded: true; time: number; duration: number; paused: boolean } {
    return state.loaded === true && state.time !== null && state.duration !== null && state.paused !== null;
}

export function guestPlaybackAction(state: PlaybackState, point: PlaybackPoint, now: number, canSeek: boolean): {
    status: PartyStatus;
    paused?: boolean;
    seekTo?: number;
} {
    if (!playbackReady(state)) return { status: STATUS.loading };
    const { time, duration, paused, buffering } = state;

    const position = Math.min(duration, positionAt(point, now));
    const playing = point.playing && position < duration;
    const shouldPause = !playing;
    const pauseChanged = paused === shouldPause ? undefined : shouldPause;

    // Keep a play request in place while the engine fills its own cache.
    if (playing && buffering) return { status: STATUS.buffering, paused: pauseChanged };

    const drift = Math.abs(position - time);
    const threshold = playing ? PARTY.hardDriftMs : PARTY.softDriftMs;
    const seekTo = canSeek && !buffering && drift > threshold ? position : undefined;
    return { status: seekTo !== undefined ? STATUS.syncing : playing ? STATUS.synced : STATUS.paused, paused: pauseChanged, seekTo };
}

export function initialPlayback(position: number, now: number): Playback {
    const point = { position, playing: false, at: now };
    return { previous: point, target: point, revision: 0, autoResume: false };
}

export function nextPlayback(playback: Playback, intent: PlaybackIntent, now: number): Playback {
    const current = pointAt(playback, now);
    const previous = { ...current, at: now, position: positionAt(current, now) };
    const at = intent.kind === 'buffer' || intent.kind === 'hold' ? now : now + PARTY.commandLeadMs;
    const position = intent.kind === 'pause' && current.playing ? positionAt(current, at) : intent.position;
    return {
        previous,
        target: { at, position: Math.round(Math.max(0, position)), playing: intent.kind === 'play' },
        revision: playback.revision + 1,
        autoResume: intent.kind === 'buffer' || (intent.kind === 'seek' && (playback.target.playing || playback.autoResume)),
    };
}
