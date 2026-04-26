import { infoLog, warnLog } from '../log'
import type { SignalDescription } from '../signal'

export type TrackerStatus = 'failed' | 'finding' | 'idle'

export type TrackerRendezvous = {
	close: () => void
}

type EndpointStatus = 'failed' | 'open' | 'pending'

type TrackerOptions = {
	createOffer?: (offerId: string) => Promise<SignalDescription | null>
	infoHash: Uint8Array
	onAnswer?: (offerId: string, answer: SignalDescription) => void
	onOffer?: (
		offer: SignalDescription,
		reply: (answer: SignalDescription) => void,
	) => void
	onStatus?: (status: TrackerStatus) => void
	role: 'guest' | 'host'
	trackers?: string[]
}

const TRACKERS = [
	'wss://tracker.openwebtorrent.com',
	'wss://tracker.btorrent.xyz',
	'wss://tracker.webtorrent.dev',
]

const ANNOUNCE_INTERVAL_MS = 14_000
const OFFER_ID_BYTES = 20

const warnTracker = (event: string, details: Record<string, unknown> = {}) => {
	warnLog('tracker', event, details)
}

const infoTracker = (event: string, details: Record<string, unknown> = {}) => {
	infoLog('tracker', event, details)
}

const bytesToBinaryString = (bytes: Uint8Array) => {
	let output = ''

	for (const byte of bytes) {
		output += String.fromCharCode(byte)
	}

	return output
}

const randomBinaryString = (length: number) => {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return bytesToBinaryString(bytes)
}

const randomOfferId = () => {
	const bytes = new Uint8Array(OFFER_ID_BYTES)
	crypto.getRandomValues(bytes)
	return bytesToBinaryString(bytes)
}

const isSignalDescription = (value: unknown): value is SignalDescription => {
	if (typeof value !== 'object' || value == null) return false

	const signal = value as SignalDescription
	return (
		(signal.type === 'offer' || signal.type === 'answer') &&
		typeof signal.sdp === 'string'
	)
}

const decodeTrackerMessage = (data: unknown) => {
	if (typeof data !== 'string') return null

	try {
		const message = JSON.parse(data) as Record<string, unknown>
		return typeof message === 'object' && message != null ? message : null
	} catch {
		return null
	}
}

export const createTrackerRendezvous = (
	options: TrackerOptions,
): TrackerRendezvous => {
	const trackerUrls = options.trackers ?? TRACKERS
	const infoHash = bytesToBinaryString(options.infoHash)
	const peerId = `-FL0001-${randomBinaryString(12)}`
	const sockets = new Set<WebSocket>()
	const socketUrls = new WeakMap<WebSocket, string>()
	const endpointStatuses = new Map<string, EndpointStatus>(
		trackerUrls.map((url) => [url, 'pending']),
	)
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let closed = false
	let currentStatus: TrackerStatus | null = null

	const setStatus = (status: TrackerStatus) => {
		if (status === currentStatus) return

		currentStatus = status
		options.onStatus?.(status)
	}

	const updateStatus = () => {
		if (closed) return

		const statuses = [...endpointStatuses.values()]
		if (statuses.some((status) => status === 'open')) {
			setStatus('finding')
		} else if (
			statuses.length === 0 ||
			statuses.every((status) => status === 'failed')
		) {
			setStatus('failed')
		}
	}

	const markEndpoint = (url: string, status: EndpointStatus) => {
		endpointStatuses.set(url, status)
		updateStatus()
	}

	const send = (socket: WebSocket, message: Record<string, unknown>) => {
		if (socket.readyState !== WebSocket.OPEN) return

		const url = socketUrls.get(socket) ?? socket.url
		try {
			socket.send(
				JSON.stringify({
					action: 'announce',
					downloaded: 0,
					info_hash: infoHash,
					left: 0,
					peer_id: peerId,
					port: 0,
					uploaded: 0,
					...message,
				}),
			)
		} catch (error) {
			warnTracker('socket.send.failed', { error, url })
			markEndpoint(url, 'failed')
			socket.close()
		}
	}

	const schedule = (callback: () => void, delay: number) => {
		const timer = setTimeout(() => {
			timers.delete(timer)
			callback()
		}, delay)
		timers.add(timer)
	}

	const announceGuest = (socket: WebSocket) => {
		infoTracker('announce.sent', {
			offers: 0,
			role: options.role,
			url: socketUrls.get(socket) ?? socket.url,
		})
		send(socket, { event: 'started', numwant: 0 })
	}

	const announceHost = (socket: WebSocket) => {
		if (options.createOffer == null) return

		const offerId = randomOfferId()
		void options
			.createOffer(offerId)
			.then((offer) => {
				if (closed || offer == null) return

				infoTracker('announce.sent', {
					offers: 1,
					role: options.role,
					url: socketUrls.get(socket) ?? socket.url,
				})
				send(socket, {
					event: 'started',
					numwant: 1,
					offers: [{ offer, offer_id: offerId }],
				})
			})
			.catch((error) => {
				warnTracker('offer.create.failed', { error, offerId })
			})
	}

	const announce = (socket: WebSocket) => {
		if (socket.readyState !== WebSocket.OPEN) return

		if (options.role === 'host') announceHost(socket)
		else announceGuest(socket)

		if (!closed) {
			schedule(() => announce(socket), ANNOUNCE_INTERVAL_MS)
		}
	}

	const handleMessage = (socket: WebSocket, data: unknown) => {
		const message = decodeTrackerMessage(data)
		const url = socketUrls.get(socket) ?? socket.url
		if (message == null) {
			warnTracker('message.decode.failed', {
				length: typeof data === 'string' ? data.length : null,
				url,
			})
			return
		}

		const failureReason = message['failure reason']
		if (typeof failureReason === 'string') {
			warnTracker('announce.failed', { reason: failureReason, url })
			markEndpoint(url, 'failed')
			socket.close()
			return
		}

		const warningMessage = message['warning message']
		if (typeof warningMessage === 'string') {
			warnTracker('announce.warning', {
				message: warningMessage,
				url,
			})
		}

		if (
			typeof message.offer_id === 'string' &&
			isSignalDescription(message.answer)
		) {
			infoTracker('answer.received', { url })
			options.onAnswer?.(message.offer_id, message.answer)
			return
		}

		if (message.action === 'announce') {
			infoTracker('announce.accepted', {
				complete:
					typeof message.complete === 'number' ? message.complete : null,
				incomplete:
					typeof message.incomplete === 'number' ? message.incomplete : null,
				url,
			})
		}

		if (
			typeof message.offer_id === 'string' &&
			typeof message.peer_id === 'string' &&
			isSignalDescription(message.offer)
		) {
			infoTracker('offer.received', { url })
			options.onOffer?.(message.offer, (answer) => {
				send(socket, {
					answer,
					offer_id: message.offer_id,
					to_peer_id: message.peer_id,
				})
			})
			return
		}

		if (typeof message.offer_id === 'string') {
			warnTracker('message.signal.invalid', { url })
		}
	}

	const openSocket = (url: string) => {
		let socket: WebSocket
		try {
			socket = new WebSocket(url)
		} catch (error) {
			warnTracker('socket.create.failed', { error, url })
			return
		}
		sockets.add(socket)
		socketUrls.set(socket, url)

		socket.onopen = () => {
			infoTracker('socket.open', { url })
			markEndpoint(url, 'open')
			announce(socket)
		}
		socket.onmessage = (event) => handleMessage(socket, event.data)
		socket.onclose = () => {
			sockets.delete(socket)
			if (closed) return

			if (endpointStatuses.get(url) !== 'failed') {
				markEndpoint(url, 'failed')
			}
		}
		socket.onerror = (event) => {
			warnTracker('socket.error', { type: event.type, url })
			markEndpoint(url, 'failed')
			socket.close()
		}
	}

	setStatus('idle')
	for (const tracker of trackerUrls) {
		openSocket(tracker)
	}

	return {
		close: () => {
			closed = true
			setStatus('idle')
			for (const timer of timers) clearTimeout(timer)
			timers.clear()
			for (const socket of sockets) socket.close()
			sockets.clear()
		},
	}
}
