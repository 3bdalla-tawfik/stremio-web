import { useCallback, useEffect } from 'react';
import useLiveRef from 'stremio/common/useLiveRef';
import { useParty } from './PartyProvider';
import { COMMAND, PARTY, STATUS, guestPlaybackAction, memberOnline, playbackReady, pointAt, positionAt, sameMedia, type Media, type PlaybackState } from './model';

type Video = {
    state: PlaybackState & {
        stream: object | null;
        buffered: number | null;
    };
    setPaused: (paused: boolean) => void;
    setTime: (position: number) => void;
};

function enoughVideo(state: Video['state'], position: number, seconds: number, readyFor: number) {
    if (state.buffering || !state.loaded || state.duration === null) return false;
    const requiredEnd = Math.min(state.duration, position + seconds * 1000);
    if (state.buffered !== null) return state.buffered >= requiredEnd - PARTY.tickMs;
    // Some sources never report cache duration. Give them time to read ahead while paused.
    return readyFor >= seconds * 1000;
}

export default function usePartyPlayback(video: Video, media: Media | null, focused: boolean) {
    const party = useParty();
    const { code, room, isHost, setStatus } = party;
    const active = focused && room !== null && room.media !== null && sameMedia(media, room.media);
    const mediaRevision = room?.mediaRevision;
    const canPlayPause = !active || isHost || party.permissions.playPause;
    const canSeek = !active || isHost || party.permissions.seek;
    const latest = useLiveRef({ party, video });

    useEffect(() => {
        if (!active || !code) return;
        let lastSeek = -Infinity;
        let lastPosition = 0;
        let waitingForBuffer = true;
        let readySince: number | null = null;
        let lastStream: object | null = null;
        let lastPointAt: number | null = null;
        let hostWasOffline = false;

        const synchronize = () => {
            const { party: current, video: player } = latest.current;
            const state: Video['state'] = player.state;
            if (!current.room || current.room.mediaRevision !== mediaRevision || current.code !== code) return;
            if (state.stream !== lastStream) {
                lastStream = state.stream;
                lastSeek = -Infinity;
                readySince = null;
                waitingForBuffer = true;
            }
            const { playback, host, bufferSeconds } = current.room;
            const now = current.now();
            // mpv emits its ready event after the first frame. Let the original
            // load finish before the party sends pause or seek commands.
            if (!playbackReady(state)) {
                setStatus(STATUS.loading);
                return;
            }
            const { time, duration } = state;
            if (!current.connected || (!current.isHost && !memberOnline(current.members[host], now))) {
                if (state.paused === false) player.setPaused(true);
                waitingForBuffer = true;
                readySince = null;
                hostWasOffline = current.isHost;
                setStatus(current.connected ? STATUS.waitingHost : STATUS.reconnecting);
                return;
            }
            lastPosition = time;
            if (hostWasOffline && (playback.target.playing || playback.autoResume)) {
                if (current.publish({ kind: 'hold', position: time })) hostWasOffline = false;
                return;
            }
            hostWasOffline = false;

            const point = pointAt(playback, now);
            const position = Math.min(duration, positionAt(point, now));
            const drift = position - time;
            const distance = Math.abs(drift);
            const nextPoint = lastPointAt !== point.at;
            lastPointAt = point.at;
            const canSeek = now - lastSeek >= PARTY.seekCooldownMs;

            if (!current.isHost) {
                const action = guestPlaybackAction(state, point, now, canSeek || (!point.playing && nextPoint));
                if (action.paused === true) player.setPaused(true);
                if (action.seekTo !== undefined) {
                    player.setTime(action.seekTo);
                    lastSeek = now;
                }
                if (action.paused === false) player.setPaused(false);
                setStatus(action.status);
                return;
            }

            readySince = state.buffering ? null : readySince ?? now;
            const readyFor = readySince === null ? 0 : now - readySince;
            const canResume = enoughVideo(state, Math.max(time, position), bufferSeconds, readyFor);

            if (!point.playing) {
                if (!state.paused) player.setPaused(true);
                if (distance > PARTY.softDriftMs && (nextPoint || canSeek)) {
                    player.setTime(position);
                    lastSeek = now;
                    readySince = null;
                    waitingForBuffer = true;
                    setStatus(STATUS.syncing);
                    return;
                }
                const newTitle = current.room.mediaRevision > 0 && playback.kind === COMMAND.initial;
                if ((newTitle || playback.autoResume) && !playback.target.playing && now >= playback.target.at) {
                    setStatus(STATUS.hostBuffering);
                    if (canResume && distance <= PARTY.softDriftMs) current.publish({ kind: 'play', position });
                } else {
                    setStatus(canResume ? STATUS.paused : STATUS.buffering);
                }
                return;
            }

            if (state.buffering) {
                waitingForBuffer = true;
                if (!state.paused) player.setPaused(true);
                if (playback.target.playing) current.publish({ kind: 'buffer', position: time });
                setStatus(STATUS.buffering);
                return;
            }
            if (waitingForBuffer && !canResume) {
                if (!state.paused) player.setPaused(true);
                if (playback.target.playing) current.publish({ kind: 'buffer', position: time });
                setStatus(STATUS.buffering);
                return;
            }
            if (distance > PARTY.hardDriftMs && canSeek) {
                player.setTime(position);
                lastSeek = now;
                setStatus(STATUS.syncing);
            } else {
                setStatus(STATUS.synced);
            }
            waitingForBuffer = false;
            if (state.paused && position < duration) player.setPaused(false);
        };

        synchronize();
        const interval = window.setInterval(synchronize, PARTY.tickMs);
        return () => {
            window.clearInterval(interval);
            const current = latest.current;
            if (current.video.state.loaded && current.video.state.stream === lastStream) current.video.setPaused(true);
            const playback = current.party.room?.playback;
            if (isHost && current.party.code === code && current.party.room?.mediaRevision === mediaRevision &&
                (playback?.target.playing || playback?.autoResume)) {
                current.party.publish({ kind: 'hold', position: lastPosition });
            }
            setStatus(STATUS.loading);
        };
    }, [active, code, isHost, latest, mediaRevision, setStatus]);

    const request = useCallback((playing: boolean) => {
        const { party: current, video: player } = latest.current;
        if (!active || !current.room || !canPlayPause) return;
        if (!current.isHost) {
            current.publish({ kind: playing ? COMMAND.play : COMMAND.pause, position: 0 });
            return;
        }
        const time = player.state.time ?? (playing ? null : player.state.duration);
        if (time === null) return;
        if (playing && (player.state.buffered === null || !enoughVideo(player.state, time, current.room.bufferSeconds, 0))) {
            current.publish({ kind: 'buffer', position: time });
        } else {
            current.publish({ kind: playing ? 'play' : 'pause', position: time });
        }
    }, [active, canPlayPause, latest]);

    const seek = useCallback((position: number) => {
        if (active) latest.current.party.publish({ kind: 'seek', position });
    }, [active, latest]);

    const open = useCallback(() => {
        party.open(media && video.state.time !== null && video.state.loaded ? () => ({
            media,
            position: latest.current.video.state.time ?? 0,
        }) : undefined);
    }, [latest, media, party.open, video.state.time, video.state.loaded]);

    const paused = active && room ? !(room.playback.target.playing || room.playback.autoResume) : video.state.paused;
    return { active, isHost, canPlayPause, canSeek, open, request, seek, paused };
}
