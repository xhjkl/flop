import { log } from '../log'
import {
	parseRoomSecret,
	ROOM_SECRET_LENGTH,
	type RoomSecret,
} from '../rendezvous/secret'

export type InviteInput =
	| { type: 'empty' }
	| { type: 'invite-link'; secret: RoomSecret }
	| { code: string; type: 'manual-code' }

export const copyText = (text: string) => {
	// Copy is best-effort; the UI already gave the person the text.
	return navigator.clipboard?.writeText(text).catch(() => null) ?? null
}

const shareDataFromText = (text: string): ShareData => {
	// Share sheets treat URLs better than plain text when we can prove one.
	const value = text.trim()

	try {
		const url = new URL(value)
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return { title: 'Flop invite', url: url.href }
		}
	} catch {}

	return { text: value, title: 'Flop invite' }
}

export const canShareText = (text: string) => {
	// Native share is a bonus path, never a requirement.
	if (typeof navigator === 'undefined') return false
	if (typeof navigator.share !== 'function') return false

	const data = shareDataFromText(text)
	try {
		return navigator.canShare?.(data) ?? true
	} catch {
		return false
	}
}

export const shareText = (text: string) => {
	if (!canShareText(text)) return null
	return navigator.share(shareDataFromText(text)).catch(() => null)
}

const safeDecodeURIComponent = (value: string) => {
	// A mangled hash can still be a pasted manual code, so keep the raw text.
	try {
		return decodeURIComponent(value)
	} catch (error) {
		log('warn', 'invite', 'hash-decode.failed', {
			error,
			length: value.length,
		})
		return value
	}
}

export const inviteFromHash = (hashText: string): InviteInput => {
	// Hashes carry either the invite link secret or a manual WebRTC signal.
	const hash = hashText.replace(/^#/, '')
	if (hash.trim() === '') return { type: 'empty' }

	const decoded = safeDecodeURIComponent(hash)
	const secret = parseRoomSecret(decoded)
	if (secret != null) return { secret, type: 'invite-link' }
	if (decoded.trim().length === ROOM_SECRET_LENGTH) {
		log('warn', 'invite', 'invalid-room-secret-hash', {
			length: decoded.trim().length,
		})
	}

	return { code: decoded, type: 'manual-code' }
}

export const inviteFromInput = (text: string): InviteInput => {
	// Pasting should feel forgiving: link, hash, secret, or raw code.
	const input = text.trim()
	if (input === '') return { type: 'empty' }

	const secret = parseRoomSecret(input)
	if (secret != null) return { secret, type: 'invite-link' }

	try {
		const url = new URL(input)
		return inviteFromHash(url.hash)
	} catch {}

	if (input.startsWith('#')) {
		return inviteFromHash(input)
	}

	return { code: input, type: 'manual-code' }
}

export const readInviteFromHash = () => {
	// Opening a shared URL should join before the user has to touch anything.
	return inviteFromHash(window.location.hash)
}

const currentUrlWithHash = (hash: string) => {
	// Wrap codes in the current URL so share sheets and copy-paste both work.
	const url = new URL(window.location.href)
	url.hash = hash
	return url.href
}

export const inviteLinkFromSecret = (secret: RoomSecret) => {
	// The link hides only a room secret; beacon auth comes from derived keys.
	return currentUrlWithHash(secret)
}

export const inviteCodeFromSignal = (signal: string) => {
	// Manual "code" is just the WebRTC signal in a paste-friendly wrapper.
	return currentUrlWithHash(signal)
}
