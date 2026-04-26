export type DataChannelHandlers = {
	onOpen?: () => void
	onMessage?: (text: string) => void
}

export const bindChannel = (
	channel: RTCDataChannel,
	handlers: DataChannelHandlers,
	onClose: () => void,
) => {
	channel.onopen = () => {
		handlers.onOpen?.()
	}
	channel.onclose = () => {
		onClose()
	}
	channel.onerror = (event) => {
		console.warn('[flop:rtc] datachannel.error', {
			channel: channel.label,
			type: event.type,
		})
		onClose()
	}
	channel.onmessage = (event) => {
		if (typeof event.data !== 'string') return

		handlers.onMessage?.(event.data)
	}
}
