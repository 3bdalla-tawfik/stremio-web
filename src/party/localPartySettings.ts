import { PARTY, validCode } from './model';
import { logPartyFailure } from './firebaseRoom';

export type RecentParty = { code: string; createdAt: number; unavailable: boolean };

function read(key: string) {
    try {
        return window.localStorage.getItem(key);
    } catch (failure) {
        logPartyFailure('read local party settings', failure);
        return null;
    }
}

function save(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value);
    } catch (failure) {
        logPartyFailure('save local party settings', failure);
    }
}

export function getRecentParties(): RecentParty[] {
    try {
        const value: unknown = JSON.parse(read(PARTY.recentStorage) ?? '[]');
        if (!Array.isArray(value)) return [];
        return value.filter((entry) => entry && typeof entry.code === 'string' && validCode(entry.code) &&
            Number.isFinite(entry.createdAt) && typeof entry.unavailable === 'boolean').slice(0, PARTY.recentLimit);
    } catch (failure) {
        logPartyFailure('read recent parties', failure);
        return [];
    }
}

export function rememberParty(entry: RecentParty) {
    const recent = [entry, ...getRecentParties().filter(({ code }) => code !== entry.code)].slice(0, PARTY.recentLimit);
    save(PARTY.recentStorage, JSON.stringify(recent));
    return recent;
}

export function markPartyUnavailable(code: string) {
    const recent = getRecentParties().map((entry) => entry.code === code ? { ...entry, unavailable: true } : entry);
    save(PARTY.recentStorage, JSON.stringify(recent));
    return recent;
}

export function getPartyName() {
    return read(PARTY.nameStorage)?.slice(0, PARTY.maxNameLength) ?? '';
}

export function savePartyName(name: string) {
    save(PARTY.nameStorage, name);
}
