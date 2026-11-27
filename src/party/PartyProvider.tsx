import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, matchPath, matchRoutes, useLocation, useNavigate } from 'react-router';
import { LEGACY_META_DETAILS_PATH, META_DETAILS_PATH, PLAYER_PATH } from '../router/getBackFallback';
import { getRoomClient, logPartyFailure, PARTY_UNAVAILABLE } from './firebaseRoom';
import { getPartyName, getRecentParties, markPartyUnavailable, rememberParty, savePartyName } from './localPartySettings';
import {
    MEMBER, NO_PERMISSIONS, PARTY, PARTY_CONFIGURATION_REQUIRED, PERMISSION, STATUS,
    canControl, getPartyMedia, memberOnline, normalizeCode, sameMedia, validCode,
    type Media, type Member, type PartyStatus, type Permissions, type PlaybackIntent, type Room,
} from './model';
import styles from './styles.less';

type Session = { code: string; uid: string; host: boolean };
type Start = () => { media: Media; position: number };
type Selection = { key: string; media: Media };
type PartyState = {
    code: string | null;
    room: Room | null;
    isHost: boolean;
    members: Record<string, Member>;
    connected: boolean;
    permissions: Permissions;
    now: () => number;
    open: (start?: Start) => void;
    reportMovie: (key: string, media: Media) => void;
    publish: (intent: PlaybackIntent) => boolean;
    setStatus: (status: PartyStatus) => void;
};

const PartyContext = createContext<PartyState | null>(null);
const serverNow = () => getRoomClient().now();
const mediaRoutes = [META_DETAILS_PATH, LEGACY_META_DETAILS_PATH, PLAYER_PATH].map((path) => ({ path }));
const controlOptions = [
    { permission: PERMISSION.playPause, key: 'WATCH_PARTY_PERMISSION_PLAY_PAUSE', label: 'Play / Pause' },
    { permission: PERMISSION.seek, key: 'WATCH_PARTY_PERMISSION_SEEK', label: 'Seek' },
] as const;
const nameId = 'watch-party-name';
const codeId = 'watch-party-code';

export function useParty() {
    const party = useContext(PartyContext);
    if (party === null) throw new Error('PartyProvider must wrap the player.');
    return party;
}

export function PartyProvider({ children }: React.PropsWithChildren) {
    const navigate = useNavigate();
    const location = useLocation();
    const { t } = useTranslation();
    const dialog = useRef<HTMLDialogElement>(null);
    const start = useRef<Start | undefined>(undefined);
    const [session, setSession] = useState<Session | null>(null);
    const [room, setRoom] = useState<Room | null>(null);
    const [members, setMembers] = useState<Record<string, Member>>({});
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState<PartyStatus>(STATUS.loading);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [codeInput, setCodeInput] = useState('');
    const [nameInput, setNameInput] = useState(getPartyName);
    const [recent, setRecent] = useState(getRecentParties);
    const [copied, setCopied] = useState(false);
    const [movie, setMovie] = useState<Selection | null>(null);
    const [sharing, setSharing] = useState(false);
    const [failedSelection, setFailedSelection] = useState<string | null>(null);
    const followed = useRef<{ code: string; revision: number } | null>(null);
    const lastSharedSelection = useRef<string | null>(null);
    const previousSubscription = useRef<Session | null>(null);
    const writing = useRef(false);
    const leaving = useRef(false);
    const running = useRef(false);
    const isHost = session?.host === true;
    const permissions = session ? members[session.uid]?.permissions ?? NO_PERMISSIONS : NO_PERMISSIONS;
    const selectedMedia = useMemo(() => {
        const match = matchRoutes(mediaRoutes, location)?.[0];
        if (!match) return null;
        const { type, id, videoId } = match.params;
        return getPartyMedia(type, id, videoId) ?? (movie?.key === location.key ? movie.media : null);
    }, [location, movie]);
    const reportMovie = useCallback((key: string, media: Media) => {
        setMovie((current) => current?.key === key && sameMedia(current.media, media) ? current : { key, media });
    }, []);

    const open = useCallback((getStart?: Start) => {
        start.current = getStart;
        setCopied(false);
        if (!dialog.current?.open) dialog.current?.showModal();
    }, []);

    const openMedia = useCallback((media: Media, replace = false) => {
        const path = generatePath(META_DETAILS_PATH, {
            type: media.type,
            id: encodeURIComponent(media.id),
            videoId: encodeURIComponent(media.videoId),
        });
        if (location.pathname !== path) navigate(path, { replace, state: { [PARTY.pickerStateKey]: true } });
        dialog.current?.close();
    }, [location.pathname, navigate]);

    const clearSession = useCallback(() => {
        previousSubscription.current = null;
        followed.current = null;
        lastSharedSelection.current = null;
        setSession(null);
        setRoom(null);
        setMembers({});
        setConnected(false);
        setFailedSelection(null);
        setStatus(STATUS.loading);
    }, []);

    useEffect(() => {
        if (!session) return;
        const close = (message: string) => {
            if (leaving.current || previousSubscription.current !== session) return;
            clearSession();
            setRecent(markPartyUnavailable(session.code));
            setError(message);
            open();
        };
        const unsubscribe = getRoomClient().watch(session.code, session.uid, session.host, (snapshot) => {
            if (!snapshot || snapshot.endedAt !== null) {
                close(t('WATCH_PARTY_ENDED', { defaultValue: 'This party has ended.' }));
            } else if (previousSubscription.current === session) {
                setRoom(snapshot);
            }
        }, (updated) => {
            if (previousSubscription.current !== session) return;
            if (updated[session.uid]?.status !== MEMBER.active) {
                close(t('WATCH_PARTY_REMOVED', { defaultValue: 'You were removed from the party, or the party ended.' }));
            } else {
                setMembers(updated);
            }
        }, (available) => {
            if (previousSubscription.current === session) setConnected(available);
        }, (failure) => {
            logPartyFailure('subscription', failure);
            close(t('WATCH_PARTY_REMOVED', { defaultValue: 'You were removed from the party, or the party ended.' }));
        });
        return unsubscribe;
    }, [session, clearSession, open, t]);

    const createdAt = room?.createdAt;
    useEffect(() => {
        if (createdAt === undefined || !session) return;
        const timer = window.setTimeout(() => {
            clearSession();
            setRecent(markPartyUnavailable(session.code));
            setError(t('WATCH_PARTY_EXPIRED', { defaultValue: 'This party has expired.' }));
            open();
        }, Math.max(0, createdAt + PARTY.maxRoomAge - serverNow()));
        return () => window.clearTimeout(timer);
    }, [createdAt, session, connected, clearSession, open, t]);

    useEffect(() => {
        if (!session || isHost || !room?.media) return;
        const previous = followed.current;
        if (previous?.code === session.code && previous.revision === room.mediaRevision) return;
        followed.current = { code: session.code, revision: room.mediaRevision };
        openMedia(room.media, previous?.code === session.code);
    }, [session, room, isHost, openMedia]);

    const selectionKey = session && selectedMedia ? JSON.stringify([session.code, location.key, selectedMedia]) : null;
    useEffect(() => {
        if (selectionKey === null) lastSharedSelection.current = null;
        if (!session || !isHost || !connected || !room || !selectedMedia || sharing ||
            selectionKey === failedSelection || selectionKey === lastSharedSelection.current) return;
        lastSharedSelection.current = selectionKey;
        if (sameMedia(room.media, selectedMedia)) return;
        setSharing(true);
        getRoomClient().share(session.code, selectedMedia).catch((failure) => {
            if (previousSubscription.current !== session) return;
            lastSharedSelection.current = null;
            logPartyFailure('share title', failure);
            setFailedSelection(selectionKey);
            setError(t('WATCH_PARTY_SHARE_ERROR', { defaultValue: 'Could not open this title for the party.' }));
            open();
        }).finally(() => setSharing(false));
    }, [session, isHost, connected, room, selectedMedia, sharing, selectionKey, failedSelection, open, t]);

    const run = async (operation: () => Promise<void>, message: string) => {
        if (running.current) return;
        running.current = true;
        setError('');
        setPending(true);
        try {
            await operation();
        } catch (failure) {
            logPartyFailure(message, failure);
            setError(failure instanceof Error && failure.message === PARTY_CONFIGURATION_REQUIRED ?
                t('WATCH_PARTY_CONFIGURATION_REQUIRED', { defaultValue: PARTY_CONFIGURATION_REQUIRED }) :
                failure instanceof Error && failure.message === PARTY_UNAVAILABLE ?
                    t('WATCH_PARTY_UNAVAILABLE', { defaultValue: PARTY_UNAVAILABLE }) : message);
        } finally {
            running.current = false;
            setPending(false);
        }
    };

    const hostOnline = room !== null && connected && memberOnline(members[room.host], serverNow());

    const publish = useCallback((intent: PlaybackIntent) => {
        if (!session || !room || !connected || (!isHost && !hostOnline) || writing.current || !canControl(isHost, permissions, intent)) return false;
        writing.current = true;
        getRoomClient().publish(session.code, room.mediaRevision, room.playback.revision, intent).catch((failure) => {
            if (previousSubscription.current !== session) return;
            logPartyFailure('playback command', failure);
            setError(t('WATCH_PARTY_PLAYBACK_ERROR', { defaultValue: 'Could not send the playback command. Try again.' }));
            open();
        }).finally(() => { writing.current = false; });
        return true;
    }, [session, room, isHost, hostOnline, permissions, connected, open, t]);

    const establish = ({ room: nextRoom, ...nextSession }: Session & { room: Room }, name: string) => {
        leaving.current = false;
        previousSubscription.current = nextSession;
        setRoom(nextRoom);
        setSession(nextSession);
        savePartyName(name);
        setNameInput(name);
        setRecent(rememberParty({ code: nextSession.code, createdAt: nextRoom.createdAt, unavailable: false }));
    };

    const create = () => run(async () => {
        const name = nameInput.trim();
        const getStart = start.current ?? (() => ({ media: selectedMedia, position: 0 }));
        establish(await getRoomClient().create(getStart, name), name);
    }, t('WATCH_PARTY_CREATE_ERROR', { defaultValue: 'Could not create a party. Check the connection and try again.' }));

    const join = (code: string) => {
        if (!validCode(code)) {
            setError(t('WATCH_PARTY_INVALID_CODE', { defaultValue: 'Enter the 8-character party code.' }));
            return;
        }
        void run(async () => {
            const name = nameInput.trim();
            try {
                const joined = await getRoomClient().join(code, name);
                if (joined.host && joined.room.media) openMedia(joined.room.media);
                establish(joined, name);
            } catch (failure) {
                if (failure instanceof Error && failure.message === PARTY_UNAVAILABLE) setRecent(markPartyUnavailable(code));
                throw failure;
            }
        }, t('WATCH_PARTY_JOIN_ERROR', { defaultValue: 'Could not join. Check the code and your connection, then try again.' }));
    };

    const leave = () => run(async () => {
        if (!session || !room) return;
        const client = getRoomClient();
        leaving.current = true;
        try {
            if (isHost) {
                await client.end(session.code);
                setRecent(markPartyUnavailable(session.code));
            } else {
                await client.leave(session.code, session.uid);
            }
        } catch (failure) {
            leaving.current = false;
            throw failure;
        }
        clearSession();
        dialog.current?.close();
    }, t('WATCH_PARTY_LEAVE_ERROR', { defaultValue: 'Could not leave the party. Check the connection and try again.' }));

    const players = Object.entries(members).filter(([, member]) => member.status === MEMBER.active);
    const title = t('WATCH_PARTY_TITLE', { defaultValue: 'Watch Party' });
    const inPlayer = matchPath(PLAYER_PATH, location.pathname) !== null;
    const [statusKey, statusText] = connected ? status : STATUS.reconnecting;
    const nameField = (
        <label className={styles.row} htmlFor={nameId}>
            {t('WATCH_PARTY_DISPLAY_NAME', { defaultValue: 'Display name' })}
            <input id={nameId} value={nameInput} maxLength={PARTY.maxNameLength} onChange={(event) => setNameInput(event.target.value)} />
        </label>
    );

    return (
        <PartyContext.Provider value={{
            code: session?.code ?? null, room, isHost, members, connected, permissions, now: serverNow, open, reportMovie, publish, setStatus,
        }}>
            {children}
            <dialog className={styles.dialog} ref={dialog} aria-label={title} onClose={() => setCopied(false)}>
                <header className={styles.header}>
                    <h2>{title}</h2>
                    <button type={'button'} onClick={() => dialog.current?.close()}>{t('BUTTON_CLOSE')}</button>
                </header>
                {session && room ? (
                    <>
                        <p className={`${styles.row} ${styles.codeCard}`}>
                            <strong className={styles.code}>{session.code}</strong>
                            <button type={'button'} onClick={() => void run(async () => {
                                await navigator.clipboard.writeText(session.code);
                                setCopied(true);
                            }, t('WATCH_PARTY_COPY_ERROR', { defaultValue: 'Could not copy the code. Select it to copy manually.' }))}>
                                {copied ? t('WATCH_PARTY_COPIED', { defaultValue: 'Copied' }) : t('WATCH_PARTY_COPY', { defaultValue: 'Copy code' })}
                            </button>
                        </p>
                        {room.media === null ? (
                            <p role={'status'}>{isHost ?
                                t('WATCH_PARTY_PICK_TITLE', { defaultValue: 'Open a movie or episode to send everyone to its stream picker.' }) :
                                t('WATCH_PARTY_WAIT_FOR_TITLE', { defaultValue: 'Waiting for the host to pick a movie or episode.' })}</p>
                        ) : (!connected || inPlayer) && (
                            <p role={'status'}>{t(statusKey, { defaultValue: statusText })}</p>
                        )}
                        {isHost && selectionKey !== null && selectionKey === failedSelection && (
                            <button type={'button'} onClick={() => { setError(''); setFailedSelection(null); }}>
                                {t('WATCH_PARTY_RETRY_SHARE', { defaultValue: 'Retry sharing this title' })}
                            </button>
                        )}
                        {room.media !== null && (
                            <button className={styles.primary} type={'button'} onClick={() => { if (room.media) openMedia(room.media); }}>
                                {t('WATCH_PARTY_CHOOSE_STREAM', { defaultValue: 'Choose stream' })}
                            </button>
                        )}
                        <form className={styles.row} onSubmit={(event) => {
                            event.preventDefault();
                            void run(async () => {
                                const name = nameInput.trim();
                                await getRoomClient().setName(session.code, session.uid, name);
                                savePartyName(name);
                                setNameInput(name);
                            }, t('WATCH_PARTY_NAME_ERROR', { defaultValue: 'Could not save your display name.' }));
                        }}>
                            {nameField}
                            <button type={'submit'} disabled={pending || !connected || nameInput.trim() === members[session.uid]?.name}>
                                {t('WATCH_PARTY_SAVE_NAME', { defaultValue: 'Save name' })}
                            </button>
                        </form>
                        {isHost && (
                            <label className={styles.row}>
                                {t('WATCH_PARTY_PREBUFFER', { defaultValue: 'Prebuffer' })}
                                <select value={room.bufferSeconds} disabled={pending || !connected} onChange={(event) => {
                                    const seconds = Number(event.currentTarget.value);
                                    void run(() => getRoomClient().setBuffer(session.code, seconds), t('WATCH_PARTY_PREBUFFER_ERROR', { defaultValue: 'Could not update the prebuffer.' }));
                                }}>
                                    {PARTY.bufferChoices.map((seconds) => <option key={seconds} value={seconds}>{t('WATCH_PARTY_BUFFER_SECONDS', { defaultValue: '{{seconds}} s', seconds })}</option>)}
                                </select>
                            </label>
                        )}
                        <ul className={styles.members} aria-label={t('WATCH_PARTY_MEMBERS', { defaultValue: 'Party members' })}>
                            {players.map(([uid, member], index) => {
                                const role = uid === room.host ? t('WATCH_PARTY_HOST', { defaultValue: 'Host' }) :
                                    t('WATCH_PARTY_GUEST', { defaultValue: 'Guest {{number}}', number: index + 1 });
                                const name = member.name ? `${member.name} · ${role}` : role;
                                return (
                                    <li key={uid}>
                                        <div className={styles.row}>
                                            <span className={styles.memberName}>
                                                {name}{uid === session.uid ? t('WATCH_PARTY_YOU', { defaultValue: ' (you)' }) : ''}
                                            </span>
                                            <span>{memberOnline(member, serverNow()) ?
                                                t('WATCH_PARTY_ONLINE', { defaultValue: 'Online' }) : t('WATCH_PARTY_OFFLINE', { defaultValue: 'Offline' })}</span>
                                            {isHost && uid !== session.uid && (
                                                <button type={'button'} aria-label={t('WATCH_PARTY_KICK_MEMBER', { defaultValue: 'Remove {{name}}', name })} disabled={pending || !connected} onClick={() => void run(
                                                    () => getRoomClient().kick(session.code, uid), t('WATCH_PARTY_KICK_ERROR', { defaultValue: 'Could not remove this guest.' }),
                                                )}>{t('WATCH_PARTY_KICK', { defaultValue: 'Kick' })}</button>
                                            )}
                                        </div>
                                        {isHost && uid !== session.uid && (
                                            <fieldset className={styles.permissionList} disabled={pending || !connected}>
                                                <legend>{t('WATCH_PARTY_MEMBER_PERMISSIONS', { defaultValue: 'Playback permissions' })}</legend>
                                                {controlOptions.map(({ permission, key, label }) => (
                                                    <label className={styles.row} key={permission}>
                                                        <input type={'checkbox'} checked={member.permissions[permission]} onChange={(event) => {
                                                            const enabled = event.currentTarget.checked;
                                                            void run(() => getRoomClient().setPermission(session.code, uid, permission, enabled),
                                                                t('WATCH_PARTY_PERMISSIONS_ERROR', { defaultValue: 'Could not update playback permissions.' }));
                                                        }} />
                                                        {t(key, { defaultValue: label })}
                                                    </label>
                                                ))}
                                            </fieldset>
                                        )}
                                        {!isHost && uid === session.uid && (
                                            <small>{controlOptions.filter(({ permission }) => member.permissions[permission])
                                                .map(({ key, label }) => t(key, { defaultValue: label })).join(' · ') ||
                                                t('WATCH_PARTY_NO_PERMISSIONS', { defaultValue: 'Watching only' })}</small>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        <button className={styles.leave} type={'button'} disabled={pending || !connected} onClick={() => void leave()}>
                            {isHost ? t('WATCH_PARTY_END', { defaultValue: 'End party' }) : t('WATCH_PARTY_LEAVE', { defaultValue: 'Leave party' })}
                        </button>
                    </>
                ) : session ? (
                    <p role={'status'}>{t('WATCH_PARTY_OPENING', { defaultValue: 'Opening party…' })}</p>
                ) : (
                    <>
                        {nameField}
                        <button className={styles.primary} type={'button'} disabled={pending} onClick={() => void create()}>
                            {t('WATCH_PARTY_CREATE', { defaultValue: 'Create party' })}
                        </button>
                        <form className={styles.row} onSubmit={(event) => { event.preventDefault(); join(normalizeCode(codeInput)); }}>
                            <label htmlFor={codeId}>{t('WATCH_PARTY_CODE', { defaultValue: 'Party code' })}</label>
                            <input id={codeId} className={styles.codeInput} autoComplete={'off'} spellCheck={false} value={codeInput} onChange={(event) => setCodeInput(event.target.value)} />
                            <button type={'submit'} disabled={pending}>{t('WATCH_PARTY_JOIN', { defaultValue: 'Join' })}</button>
                        </form>
                        {recent.length > 0 && (
                            <section>
                                <h3>{t('WATCH_PARTY_RECENT', { defaultValue: 'Recent parties' })}</h3>
                                <ul className={styles.members}>
                                    {recent.map((entry) => {
                                        const expired = entry.createdAt + PARTY.maxRoomAge <= Date.now();
                                        return (
                                            <li key={entry.code} className={styles.row}>
                                                <span className={styles.code}>{entry.code}</span>
                                                {expired || entry.unavailable ? (
                                                    <span>{expired ? t('WATCH_PARTY_RECENT_EXPIRED', { defaultValue: 'Expired' }) :
                                                        t('WATCH_PARTY_RECENT_UNAVAILABLE', { defaultValue: 'Unavailable' })}</span>
                                                ) : (
                                                    <button type={'button'} disabled={pending} onClick={() => join(entry.code)}
                                                        aria-label={t('WATCH_PARTY_REJOIN_CODE', { defaultValue: 'Rejoin party {{code}}', code: entry.code })}>
                                                        {t('WATCH_PARTY_REJOIN', { defaultValue: 'Rejoin' })}
                                                    </button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        )}
                    </>
                )}
                {error && <p role={'alert'}>{error}</p>}
            </dialog>
        </PartyContext.Provider>
    );
}
