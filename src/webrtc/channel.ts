import type { RtcDebug } from './debug'

export type DataChannelHandlers = {
	onOpen?: () => void
	onMessage?: (text: string) => void
}

export function bindChannel(
	channel: RTCDataChannel,
	handlers: DataChannelHandlers,
	onClose: () => void,
	debug: RtcDebug,
) {
	channel.onopen = () => {
		debug('datachannel.open', {
			bufferedAmount: channel.bufferedAmount,
			channel: channel.label,
		})
		handlers.onOpen?.()
	}
	channel.onclose = () => {
		debug('datachannel.close', { channel: channel.label })
		onClose()
	}
	channel.onerror = (event) => {
		debug('datachannel.error', { channel: channel.label, type: event.type })
	}
	channel.onmessage = (event) => {
		if (typeof event.data !== 'string') return

		debug('datachannel.message', {
			channel: channel.label,
			length: event.data.length,
		})
		handlers.onMessage?.(event.data)
	}
}
