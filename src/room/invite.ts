export const copyText = (text: string) => {
	return navigator.clipboard?.writeText(text).catch(() => null) ?? null
}

const safeDecodeURIComponent = (value: string) => {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

export const inviteCodeFromHash = (hashText: string) => {
	const hash = hashText.replace(/^#/, '')
	if (hash.trim() === '') return null

	return safeDecodeURIComponent(hash)
}

export const inviteCodeFromInput = (text: string) => {
	const input = text.trim()
	if (input === '') return ''

	// People paste full links, hashes, and raw codes. Make all of them feel like the same gesture.
	try {
		const url = new URL(input)
		const inviteCode = inviteCodeFromHash(url.hash)
		if (inviteCode != null) return inviteCode
	} catch {}

	if (input.startsWith('#')) {
		const inviteCode = inviteCodeFromHash(input)
		if (inviteCode != null) return inviteCode
	}

	return input
}

export const readInviteFromHash = () => {
	return inviteCodeFromHash(window.location.hash)
}

export const clearInviteHash = () => {
	if (window.location.hash === '') return

	const url = new URL(window.location.href)
	url.hash = ''
	window.history.replaceState(null, '', url)
}

export const inviteLinkFromCode = (inviteCode: string) => {
	const url = new URL(window.location.href)
	url.hash = inviteCode
	return url.href
}
