/** Connection-card copy for people trying to get one browser call connected. */
export const statusCopy = {
	directConnectionFailed:
		'This browser connection did not complete. The host may not have accepted the reply, or the network blocked WebRTC. Ask for a fresh invite and try again.',
	hostInviteLinkFailed:
		'Invite-link discovery is offline here. The invite code still works; switch to code.',
	hostReplyFailed:
		'That reply code could not form a direct browser connection. Ask for a fresh reply code. If it keeps failing, try another network or device.',
	inviteFailed:
		'That invite did not work. Ask for a fresh invite link or code and try again.',
	inviteLinkUnreachable:
		'The invite-link service cannot be reached. It may reconnect automatically. For the fastest path, ask for an invite code.',
	replyStillWaiting:
		'Still waiting for the host to let this browser in. Send the reply code again, or ask for a fresh invite.',
} as const

/** Blip-composer issue copy for file transfer feedback. */
export const blipIssueCopy = {
	fileNoPeers: 'Connect another device before sending files.',
	filePartialDelivery:
		'Some peers disconnected before the file reached everyone.',
	fileStopped: 'File transfer stopped before it finished.',
} as const
