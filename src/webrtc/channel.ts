import { warnLog } from '../log'

export type DataChannelHandlers = {
	onOpen?: () => void
	onMessage?: (text: string) => void
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
		warnLog('rtc', 'datachannel.error', {
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
