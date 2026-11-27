import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, useNavigate } from 'react-router';
import { META_DETAILS_PATH } from '../router/getBackFallback';
import { getRoomClient, logPartyFailure } from './firebaseRoom';
import { MEMBER, PARTY, PARTY_CONFIGURATION_REQUIRED, STATUS, nextPlayback, normalizeCode, validCode, type Media, type PartyStatus, type PlaybackIntent, type Room } from './model';
import styles from './styles.less';

type Session = { code: string; uid: string };
type Start = () => { media: Media; position: number };
type PartyState = {
    code: string | null;
    room: Room | null;
    isHost: boolean;
    connected: boolean;
    now: () => number;
    open: (start?: Start) => void;
    publish: (intent: PlaybackIntent) => boolean;
    setStatus: (status: PartyStatus) => void;
};

const PartyContext = createContext<PartyState | null>(null);
const serverNow = () => getRoomClient().now();

export function useParty() {
    const party = useContext(PartyContext);
    if (party === null) throw new Error('PartyProvider must wrap the player.');
    return party;
}

export function PartyProvider({ children }: React.PropsWithChildren) {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const dialog = useRef<HTMLDialogElement>(null);
    const start = useRef<Start | undefined>(undefined);
    const [session, setSession] = useState<Session | null>(null);
    const [room, setRoom] = useState<Room | null>(null);
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState<PartyStatus>(STATUS.loading);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [codeInput, setCodeInput] = useState('');
    const [copied, setCopied] = useState(false);
    const [canCreate, setCanCreate] = useState(false);
    const writing = useRef(false);
    const leaving = useRef(false);
    const isHost = session !== null && room?.host === session.uid;

    const open = useCallback((getStart?: Start) => {
        start.current = getStart;
        setCanCreate(getStart !== undefined);
        setCopied(false);
        if (!dialog.current?.open) dialog.current?.showModal();
    }, []);

    const clearSession = useCallback(() => {
        setSession(null);
        setRoom(null);
        setConnected(false);
        setStatus(STATUS.loading);
    }, []);

    useEffect(() => {
        if (!session) return;
        const close = (message: string) => {
            if (leaving.current) return;
            clearSession();
            setError(message);
            open();
        };
        const unsubscribe = getRoomClient().watch(session.code, session.uid, (snapshot) => {
            if (!snapshot) {
                close(t('WATCH_PARTY_ENDED', { defaultValue: 'This party has ended.' }));
            } else {
                setRoom(snapshot);
            }
        }, setConnected, (failure) => {
            logPartyFailure('subscription', failure);
            close(t('WATCH_PARTY_REMOVED', { defaultValue: 'You were removed from the party, or the party ended.' }));
        });
        return unsubscribe;
    }, [session, clearSession, open, t]);

    const createdAt = room?.createdAt;
    useEffect(() => {
        if (createdAt === undefined) return;
        const timer = window.setTimeout(() => {
            clearSession();
            setError(t('WATCH_PARTY_EXPIRED', { defaultValue: 'This party has expired.' }));
            open();
        }, Math.max(0, createdAt + PARTY.maxRoomAge - serverNow()));
        return () => window.clearTimeout(timer);
    }, [createdAt, clearSession, open, t]);

    const run = async (operation: () => Promise<void>, message: string) => {
        setError('');
        setPending(true);
        try {
            await operation();
        } catch (failure) {
            logPartyFailure(message, failure);
            setError(failure instanceof Error && failure.message === PARTY_CONFIGURATION_REQUIRED ?
                t('WATCH_PARTY_CONFIGURATION_REQUIRED', { defaultValue: PARTY_CONFIGURATION_REQUIRED }) : message);
        } finally {
            setPending(false);
        }
    };

    const publish = useCallback((intent: PlaybackIntent) => {
        if (!session || !room || !isHost || !connected || writing.current) return false;
        const client = getRoomClient();
        writing.current = true;
        client.publish(session.code, nextPlayback(room.playback, intent, client.now())).catch((failure) => {
            logPartyFailure('playback command', failure);
            setError(t('WATCH_PARTY_PLAYBACK_ERROR', { defaultValue: 'Could not send the playback command. Try again.' }));
            open();
        }).finally(() => { writing.current = false; });
        return true;
    }, [session, room, isHost, connected, open, t]);

    const create = () => run(async () => {
        if (!start.current) return;
        leaving.current = false;
        setSession(await getRoomClient().create(start.current));
    }, t('WATCH_PARTY_CREATE_ERROR', { defaultValue: 'Could not create a party. Check the connection and try again.' }));

    const openMedia = (media: Media) => {
        navigate(generatePath(META_DETAILS_PATH, {
            type: media.type,
            id: encodeURIComponent(media.id),
            videoId: encodeURIComponent(media.videoId),
        }));
        dialog.current?.close();
    };

    const join = (event: React.FormEvent) => {
        event.preventDefault();
        const code = normalizeCode(codeInput);
        if (!validCode(code)) {
            setError(t('WATCH_PARTY_INVALID_CODE', { defaultValue: 'Enter the 8-character party code.' }));
            return;
        }
        void run(async () => {
            leaving.current = false;
            const { room: joinedRoom, ...joinedSession } = await getRoomClient().join(code);
            setRoom(joinedRoom);
            setSession(joinedSession);
            openMedia(joinedRoom.media);
        }, t('WATCH_PARTY_JOIN_ERROR', { defaultValue: 'Could not join. Check the code and ask the host whether the party is still open.' }));
    };

    const leave = () => run(async () => {
        if (!session || !room) return;
        const client = getRoomClient();
        leaving.current = true;
        try {
            if (isHost) await client.end(session.code);
            else await client.leave(session.code, session.uid);
        } catch (failure) {
            leaving.current = false;
            throw failure;
        }
        clearSession();
        dialog.current?.close();
    }, t('WATCH_PARTY_LEAVE_ERROR', { defaultValue: 'Could not leave the party. Check the connection and try again.' }));

    const players = room ? Object.keys(room.members).filter((uid) => room.members[uid] === MEMBER.active) : [];
    const title = t('WATCH_PARTY_TITLE', { defaultValue: 'Watch Party' });
    const [statusKey, statusText] = connected ? status : STATUS.reconnecting;

    return (
        <PartyContext.Provider value={{ code: session?.code ?? null, room, isHost, connected, now: serverNow, open, publish, setStatus }}>
            {children}
            <dialog className={styles.dialog} ref={dialog} aria-label={title} onClose={() => setCopied(false)}>
                <header className={styles.header}>
                    <h2>{title}</h2>
                    <button type={'button'} onClick={() => dialog.current?.close()}>{t('BUTTON_CLOSE')}</button>
                </header>
                {session && room ? (
                    <>
                        <p className={styles.row}>
                            <strong className={styles.code}>{session.code}</strong>
                            <button type={'button'} onClick={() => void run(async () => {
                                await navigator.clipboard.writeText(session.code);
                                setCopied(true);
                            }, t('WATCH_PARTY_COPY_ERROR', { defaultValue: 'Could not copy the code. Select it to copy manually.' }))}>
                                {copied ? t('WATCH_PARTY_COPIED', { defaultValue: 'Copied' }) : t('WATCH_PARTY_COPY', { defaultValue: 'Copy code' })}
                            </button>
                        </p>
                        <p role={'status'}>{t(statusKey, { defaultValue: statusText })}</p>
                        {isHost ? (
                            <label className={styles.row}>
                                {t('WATCH_PARTY_PREBUFFER', { defaultValue: 'Prebuffer' })}
                                <select value={room.bufferSeconds} disabled={pending || !connected} onChange={(event) => {
                                    const seconds = Number(event.currentTarget.value);
                                    void run(() => getRoomClient().setBuffer(session.code, seconds), t('WATCH_PARTY_PREBUFFER_ERROR', { defaultValue: 'Could not update the prebuffer.' }));
                                }}>
                                    {PARTY.bufferChoices.map((seconds) => <option key={seconds} value={seconds}>{t('WATCH_PARTY_BUFFER_SECONDS', { defaultValue: '{{seconds}} s', seconds })}</option>)}
                                </select>
                            </label>
                        ) : null}
                        <button type={'button'} onClick={() => openMedia(room.media)}>{t('WATCH_PARTY_CHOOSE_STREAM', { defaultValue: 'Choose stream' })}</button>
                        <ul className={styles.members} aria-label={t('WATCH_PARTY_MEMBERS', { defaultValue: 'Party members' })}>
                            {players.map((uid, index) => (
                                <li className={styles.row} key={uid}>
                                    <span>
                                        {uid === room.host ? t('WATCH_PARTY_HOST', { defaultValue: 'Host' }) : t('WATCH_PARTY_GUEST', { defaultValue: 'Guest {{number}}', number: index + 1 })}
                                        {uid === session.uid ? t('WATCH_PARTY_YOU', { defaultValue: ' (you)' }) : ''}
                                    </span>
                                    <span>{room.presence?.[uid] ? t('WATCH_PARTY_ONLINE', { defaultValue: 'Online' }) : t('WATCH_PARTY_OFFLINE', { defaultValue: 'Offline' })}</span>
                                    {isHost && uid !== session.uid && (
                                        <button type={'button'} aria-label={t('WATCH_PARTY_KICK_GUEST', { defaultValue: 'Kick guest {{number}}', number: index + 1 })} disabled={pending || !connected} onClick={() => void run(
                                            () => getRoomClient().kick(session.code, uid), t('WATCH_PARTY_KICK_ERROR', { defaultValue: 'Could not remove this guest.' }),
                                        )}>{t('WATCH_PARTY_KICK', { defaultValue: 'Kick' })}</button>
                                    )}
                                </li>
                            ))}
                        </ul>
                        <button type={'button'} disabled={pending || !connected} onClick={() => void leave()}>
                            {isHost ? t('WATCH_PARTY_END', { defaultValue: 'End party' }) : t('WATCH_PARTY_LEAVE', { defaultValue: 'Leave party' })}
                        </button>
                    </>
                ) : session ? (
                    <p role={'status'}>{t('WATCH_PARTY_OPENING', { defaultValue: 'Opening party…' })}</p>
                ) : (
                    <>
                        {canCreate ? (
                            <button type={'button'} disabled={pending} onClick={() => void create()}>{t('WATCH_PARTY_CREATE', { defaultValue: 'Create party' })}</button>
                        ) : (
                            <p>{t('WATCH_PARTY_CREATE_HINT', { defaultValue: 'Open a movie or episode to create a party.' })}</p>
                        )}
                        <form className={styles.row} onSubmit={join}>
                            <label htmlFor={'watch-party-code'}>{t('WATCH_PARTY_CODE', { defaultValue: 'Party code' })}</label>
                            <input id={'watch-party-code'} autoComplete={'off'} spellCheck={false} value={codeInput} onChange={(event) => setCodeInput(event.target.value)} />
                            <button type={'submit'} disabled={pending}>{t('WATCH_PARTY_JOIN', { defaultValue: 'Join' })}</button>
                        </form>
                    </>
                )}
                {error && <p role={'alert'}>{error}</p>}
            </dialog>
        </PartyContext.Provider>
    );
}
