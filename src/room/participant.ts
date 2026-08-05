import type { ParticipantId } from '../protocol'
import type { RoomConnection } from './link'

/** User-facing outcome of the latest outbound file batch. */
export type FileTransferIssue = 'no-peers' | 'partial-delivery' | 'stopped'

type SharedFileFields = {
	id: string
	name: string
	size: number
	/** Bytes sent or received so far. */
	transferredBytes: number
}

/** Completed incoming files alone carry a browser download URL. */
export type SharedFile =
	| (SharedFileFields & {
			state: 'failed' | 'receiving' | 'sending' | 'sent'
			url: null
	  })
	| (SharedFileFields & { state: 'download'; url: string })

/** File state that would be interrupted by leaving the page. */
export const isFileTransferActive = (file: SharedFile) => {
	return file.state === 'sending' || file.state === 'receiving'
}

/** Stable remote participant with reactive activity and replaceable transport. */
export type RoomPeer = {
	blip: string | null
	connection: RoomConnection | null
	files: SharedFile[]
	readonly id: ParticipantId
}
