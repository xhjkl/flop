import { warnLog } from '../log'
import {
	parseRoomSecret,
	ROOM_SECRET_LENGTH,
	type RoomSecret,
} from '../rendezvous/secret'

export type InviteInput =
	| { type: 'auto-link'; secret: RoomSecret }
	| { type: 'empty' }
	| { code: string; type: 'manual-code' }

export const copyText = (text: string) => {
	return navigator.clipboard?.writeText(text).catch(() => null) ?? null
}

const shareDataFromText = (text: string): ShareData => {
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
	try {
		return decodeURIComponent(value)
	} catch (error) {
		warnLog('invite', 'hash-decode.failed', {
			error,
			length: value.length,
		})
		return value
	}
}

export const inviteFromHash = (hashText: string): InviteInput => {
	const hash = hashText.replace(/^#/, '')
	if (hash.trim() === '') return { type: 'empty' }

	const decoded = safeDecodeURIComponent(hash)
	const secret = parseRoomSecret(decoded)
	if (secret != null) return { secret, type: 'auto-link' }
	if (decoded.trim().length === ROOM_SECRET_LENGTH) {
		warnLog('invite', 'invalid-room-secret-hash', {
			length: decoded.trim().length,
		})
	}

	return { code: decoded, type: 'manual-code' }
}

export const inviteFromInput = (text: string): InviteInput => {
	const input = text.trim()
	if (input === '') return { type: 'empty' }

	const secret = parseRoomSecret(input)
	if (secret != null) return { secret, type: 'auto-link' }

	// People paste full links, hashes, and raw codes. Make all of them feel like the same gesture.
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
	return inviteFromHash(window.location.hash)
}

const currentUrlWithHash = (hash: string) => {
	const url = new URL(window.location.href)
	url.hash = hash
	return url.href
}

export const autoInviteLinkFromSecret = (secret: RoomSecret) => {
	return currentUrlWithHash(secret)
}

export const manualInviteLinkFromCode = (inviteCode: string) => {
	return currentUrlWithHash(inviteCode)
}
