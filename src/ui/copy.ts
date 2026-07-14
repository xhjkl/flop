import type { TransferIssue } from '../room/activity/blip'
import type { EntryIssue } from '../room/entry/state'

/** Connection-card copy for entry failures emitted by the room engine. */
export const entryIssueCopy: Record<EntryIssue, string> = {
	'direct-connection-failed':
		'The invite was understood, but the direct browser connection did not open. Try another network or device, or ask for a fresh invite.',
	'discovery-unreachable':
		'This browser cannot reach invite-link discovery. Ask for an invite code, or leave this tab open in case it reconnects.',
	'host-reply-failed':
		'The reply code was understood, but the direct browser connection did not open. Try a fresh reply first; if it keeps failing, switch networks or devices.',
	'invite-creation-failed': 'Could not create an invite link or invite code.',
	'invite-invalid':
		'That invite could not be read or used. Ask for a fresh invite link or code.',
	'relay-quota-exceeded':
		'Free relay quota is spent. Try again tomorrow, or connect from a network that can reach peers directly.',
	'relay-unavailable':
		'The relay could not be started. Try another network, or ask for an invite code.',
	'reply-still-waiting':
		'Still waiting for the host to paste your reply code. Send it again, or ask for a fresh invite if they started over.',
}

export const hostInviteLinkFailureCopy =
	'This browser cannot reach invite-link discovery. The invite code may still work; try switching to code.'

/** Blip-composer copy for file-transfer issue codes. */
export const transferIssueCopy: Record<TransferIssue, string> = {
	'no-peers': 'Connect another device before sending files.',
	'partial-delivery':
		'Some peers disconnected before the file reached everyone.',
	stopped: 'File transfer stopped before it finished.',
}
