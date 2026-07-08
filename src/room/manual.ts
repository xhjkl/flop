import type { RoomLink } from './link'

/** Manual copy-paste admission should feel stuck before users give up. */
export const MANUAL_ADMISSION_TIMEOUT_MS = 60_000

/** Deferred admission timeout shared by manual host and guest rendezvous lanes. */
export const watchRendezvousAdmission = (options: {
	delayMs: number
	link: RoomLink
	linkStillCurrent: (link: RoomLink) => boolean
	onTimeout: () => void
	stillWaiting: () => boolean
	version: number
	versionStillCurrent: (version: number) => boolean
}) => {
	setTimeout(() => {
		if (!options.versionStillCurrent(options.version)) return
		if (!options.linkStillCurrent(options.link)) return
		if (options.link.remoteId != null) return
		if (!options.stillWaiting()) return

		options.onTimeout()
	}, options.delayMs)
}
