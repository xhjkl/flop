import { randomBase64Url } from '../random'
import { parseRoomSecret, type RoomSecret } from '../rendezvous/secret'

const HISTORY_KEY = 'flopHostInvite'
const SESSION_INVITE_KEY = 'flop.hostInvite'
const SESSION_TAB_KEY = 'flop.tab'
const TAB_TOKEN_BYTES = 16

type HostInviteMarker = {
	kind: 'host-invite'
	secret: RoomSecret
	tab: string
}

const storage = () => {
	try {
		return window.sessionStorage
	} catch {
		return null
	}
}

const readJson = (key: string): unknown => {
	const store = storage()
	if (store == null) return null

	const text = store.getItem(key)
	if (text == null) return null

	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

const writeJson = (key: string, value: unknown) => {
	const store = storage()
	if (store == null) return

	store.setItem(key, JSON.stringify(value))
}

const removeItem = (key: string) => {
	storage()?.removeItem(key)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value != null
}

const tabToken = () => {
	const store = storage()
	const existing = store?.getItem(SESSION_TAB_KEY) ?? null
	if (existing != null && existing !== '') return existing

	const token = randomBase64Url(TAB_TOKEN_BYTES)
	store?.setItem(SESSION_TAB_KEY, token)
	return token
}

const hostInviteMarker = (value: unknown): HostInviteMarker | null => {
	if (!isRecord(value)) return null
	const marker = value
	if (marker.kind !== 'host-invite') return null
	if (typeof marker.tab !== 'string') return null
	if (typeof marker.secret !== 'string') return null

	const secret = parseRoomSecret(marker.secret)
	if (secret == null) return null

	return { kind: 'host-invite', secret, tab: marker.tab }
}

const currentState = () => {
	return isRecord(window.history.state) ? window.history.state : {}
}

const stateWithMarker = (marker: HostInviteMarker) => {
	return { ...currentState(), [HISTORY_KEY]: marker }
}

const stateWithoutMarker = () => {
	const { [HISTORY_KEY]: _marker, ...state } = currentState()
	return state
}

const replaceAddress = (state: unknown, url: string) => {
	try {
		window.history.replaceState(state, '', url)
	} catch {}
}

const currentHashSecret = () => {
	const hash = window.location.hash.replace(/^#/, '')
	if (hash === '') return null

	try {
		return parseRoomSecret(decodeURIComponent(hash))
	} catch {
		return parseRoomSecret(hash)
	}
}

const cleanUrl = () => {
	const url = new URL(window.location.href)
	url.hash = ''
	return url.href
}

const loadedByReload = () => {
	const [navigation] = performance.getEntriesByType('navigation')
	return (
		navigation != null && 'type' in navigation && navigation.type === 'reload'
	)
}

const ownedHostInviteMarker = () => {
	const tab = tabToken()
	const fromState = hostInviteMarker(currentState()[HISTORY_KEY])
	if (fromState != null && fromState.tab === tab) return fromState

	// Session storage is only a reload rescue; normal navigations are shared URLs.
	if (!loadedByReload()) return null

	const fromSession = hostInviteMarker(readJson(SESSION_INVITE_KEY))
	if (fromSession != null && fromSession.tab === tab) return fromSession

	return null
}

/** Host-owned invite hash, distinct from a shared invite opened by a guest. */
export const hostInviteFromAddressBar = () => {
	const marker = ownedHostInviteMarker()
	if (marker == null) return null
	if (currentHashSecret() !== marker.secret) return null

	return marker.secret
}

/** Show the host invite in the address bar without adding a dead room to Back. */
export const projectHostInvite = (secret: RoomSecret, inviteLink: string) => {
	const marker = {
		kind: 'host-invite',
		secret,
		tab: tabToken(),
	} satisfies HostInviteMarker

	writeJson(SESSION_INVITE_KEY, marker)
	replaceAddress(stateWithMarker(marker), inviteLink)
}

/** Remove only this tab's host-owned projection; guest invite URLs stay intact. */
export const clearProjectedHostInvite = () => {
	const marker = ownedHostInviteMarker()
	removeItem(SESSION_INVITE_KEY)
	if (marker == null) return

	const state = stateWithoutMarker()
	if (currentHashSecret() !== marker.secret) {
		replaceAddress(state, window.location.href)
		return
	}

	replaceAddress(state, cleanUrl())
}
