import type { RoomConnection } from '../link'
import type { RendezvousAttempt } from '../session'

const MANUAL_ADMISSION_TIMEOUT_MS = 60_000

/** Maximum wait after manual SDP exchange before surfacing retry guidance. */
export const scheduleAdmissionTimeout = (options: {
	attempt: RendezvousAttempt
	connection: RoomConnection
	isCurrent: (attempt: RendezvousAttempt) => boolean
	isUnassigned: (connection: RoomConnection) => boolean
	onTimeout: () => void
	stillWaiting: () => boolean
}) => {
	options.attempt.scheduleTimeout(() => {
		if (!options.isCurrent(options.attempt)) return
		if (!options.isUnassigned(options.connection)) return
		if (!options.stillWaiting()) return

		options.onTimeout()
	}, MANUAL_ADMISSION_TIMEOUT_MS)
}
