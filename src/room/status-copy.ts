/** Connection-card copy for people trying to get one browser call connected. */
export const statusCopy = {
	directConnectionFailed:
		'The invite was understood, but the direct browser connection did not open. Try another network or device, or ask for a fresh invite.',
	hostInviteLinkFailed:
		'This browser cannot reach invite-link discovery. The invite code may still work; try switching to code.',
	hostReplyFailed:
		'The reply code was understood, but the direct browser connection did not open. Try a fresh reply first; if it keeps failing, switch networks or devices.',
	inviteFailed:
		'That invite could not be read or used. Ask for a fresh invite link or code.',
	inviteLinkUnreachable:
		'This browser cannot reach invite-link discovery. Ask for an invite code, or leave this tab open in case it reconnects.',
	relayQuotaExceeded:
		'Free relay quota is spent. Try again tomorrow, or connect from a network that can reach peers directly.',
	relayUnavailable:
		'The relay could not be started. Try another network, or ask for an invite code.',
	replyStillWaiting:
		'Still waiting for the host to paste your reply code. Send it again, or ask for a fresh invite if they started over.',
} as const

/** Blip-composer issue copy for file transfer feedback. */
export const blipIssueCopy = {
	fileNoPeers: 'Connect another device before sending files.',
	filePartialDelivery:
		'Some peers disconnected before the file reached everyone.',
	fileStopped: 'File transfer stopped before it finished.',
} as const
