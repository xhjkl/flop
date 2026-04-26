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

const safeDecodeURIComponent = (value: string) => {
	try {
		return decodeURIComponent(value)
	} catch (error) {
		console.warn('[flop:invite] hash-decode.failed', {
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
		console.warn('[flop:invite] invalid-room-secret-hash', {
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

export const clearInviteHash = () => {
	if (window.location.hash === '') return

	const url = new URL(window.location.href)
	url.hash = ''
	window.history.replaceState(null, '', url)
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
