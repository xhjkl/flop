import { log } from '../log'

export const ROOM_DATA_CHANNEL_LABEL = 'data'

export type DataChannelHandlers = {
	onOpen: (() => void) | null
	onMessage: ((text: string) => void) | null
}

type RoomDataChannel = Pick<RTCDataChannel, 'close' | 'label'>

/** Accept the room's one expected packet lane and close every extra channel. */
export const acceptRoomDataChannel = (
	current: RoomDataChannel | null,
	candidate: RoomDataChannel,
) => {
	if (current == null && candidate.label === ROOM_DATA_CHANNEL_LABEL)
		return true

	candidate.close()
	return false
}

// The data channel is the room bus. Unexpected payloads should not change room state.
export const bindChannel = (
	channel: RTCDataChannel,
	handlers: DataChannelHandlers,
	onClose: () => void,
) => {
	channel.onopen = () => {
		// Open means packets can finally leave the browser.
		handlers.onOpen?.()
	}
	channel.onclose = () => {
		// A closed lane is a closed peer for this app.
		onClose()
	}
	channel.onerror = (event) => {
		// Errors rarely explain themselves, but the room should stop trusting the lane.
		log('warn', 'rtc', 'datachannel.error', {
			channel: channel.label,
			type: event.type,
		})
		onClose()
	}
	channel.onmessage = (event) => {
		// The protocol is text-only so files and signals pass through one encoder.
		if (typeof event.data !== 'string') return

		handlers.onMessage?.(event.data)
	}
}
