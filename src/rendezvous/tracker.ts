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
	'wss://tracker.webtorrent.dev',
	'wss://tracker.files.fm:7073/announce',
]

const ANNOUNCE_OFFER_COUNT = 1
const DEFAULT_ANNOUNCE_INTERVAL_MS = 30_000
const OFFER_ID_BYTES = 20
const RECONNECT_MAXIMUM_MS = 60_000
const RECONNECT_MINIMUM_MS = 10_000
const RECONNECT_VARIANCE_MS = 5_000

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
	const announceTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()
	const sockets = new Set<WebSocket>()
	const socketUrls = new WeakMap<WebSocket, string>()
	const announceIntervals = new Map<string, number>()
	const endpointStatuses = new Map<string, EndpointStatus>(
		trackerUrls.map((url) => [url, 'pending']),
	)
	const reconnectAttempts = new Map<string, number>()
	const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
	const timers = new Set<ReturnType<typeof setTimeout>>()
	const trackerIds = new Map<string, string>()
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
		} else if (statuses.some((status) => status === 'pending')) {
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

	const trackerBaseMessage = (url: string): Record<string, unknown> => {
		const trackerId = trackerIds.get(url)
		return {
			action: 'announce',
			info_hash: infoHash,
			peer_id: peerId,
			...(trackerId == null ? {} : { trackerid: trackerId }),
		}
	}

	const send = (socket: WebSocket, message: Record<string, unknown>) => {
		if (socket.readyState !== WebSocket.OPEN) return

		const url = socketUrls.get(socket) ?? socket.url
		try {
			socket.send(JSON.stringify({ ...trackerBaseMessage(url), ...message }))
		} catch (error) {
			warnTracker('socket.send.failed', { error, url })
			socket.close()
		}
	}

	const scheduleReconnect = (url: string) => {
		if (closed) return
		if (reconnectTimers.has(url)) return

		const attempt = reconnectAttempts.get(url) ?? 0
		const delay =
			Math.min(2 ** attempt * RECONNECT_MINIMUM_MS, RECONNECT_MAXIMUM_MS) +
			Math.floor(Math.random() * RECONNECT_VARIANCE_MS)
		infoTracker('socket.reconnect.scheduled', { delay, url })
		const timer = setTimeout(() => {
			timers.delete(timer)
			reconnectTimers.delete(url)
			if (closed) return

			reconnectAttempts.set(url, attempt + 1)
			openSocket(url)
		}, delay)
		reconnectTimers.set(url, timer)
		timers.add(timer)
	}

	const announceDelay = (socket: WebSocket) => {
		const url = socketUrls.get(socket) ?? socket.url
		return announceIntervals.get(url) ?? DEFAULT_ANNOUNCE_INTERVAL_MS
	}

	const clearAnnounceTimer = (socket: WebSocket) => {
		const timer = announceTimers.get(socket)
		if (timer == null) return

		clearTimeout(timer)
		timers.delete(timer)
		announceTimers.delete(socket)
	}

	const scheduleNextAnnounce = (
		socket: WebSocket,
		delay = announceDelay(socket),
	) => {
		clearAnnounceTimer(socket)
		const timer = setTimeout(() => {
			timers.delete(timer)
			announceTimers.delete(socket)
			announce(socket)
		}, delay)
		announceTimers.set(socket, timer)
		timers.add(timer)
	}

	const announceWithOffer = (socket: WebSocket) => {
		if (options.createOffer == null) return

		const offers = Array.from({ length: ANNOUNCE_OFFER_COUNT }, () => {
			const offerId = randomOfferId()
			return options.createOffer?.(offerId).then((offer) => {
				return offer == null ? null : { offer, offer_id: offerId }
			})
		})

		void Promise.all(offers)
			.then((items) => {
				if (closed) return

				const nextOffers = items.filter((item) => item != null)
				if (nextOffers.length === 0) return

				infoTracker('announce.sent', {
					offers: nextOffers.length,
					role: options.role,
					url: socketUrls.get(socket) ?? socket.url,
				})
				send(socket, {
					downloaded: 0,
					numwant: nextOffers.length,
					offers: nextOffers,
					uploaded: 0,
				})
			})
			.catch((error) => warnTracker('offer.create.failed', { error }))
	}

	const announce = (socket: WebSocket) => {
		if (socket.readyState !== WebSocket.OPEN) return

		announceWithOffer(socket)

		if (!closed) scheduleNextAnnounce(socket, DEFAULT_ANNOUNCE_INTERVAL_MS)
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

		if (
			typeof message.info_hash === 'string' &&
			message.info_hash !== infoHash
		) {
			warnTracker('message.info-hash.mismatch', { url })
			return
		}

		if (typeof message.peer_id === 'string' && message.peer_id === peerId) {
			infoTracker('message.self.ignored', { url })
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

		const trackerId = message['tracker id']
		if (typeof trackerId === 'string') {
			trackerIds.set(url, trackerId)
			infoTracker('tracker-id.received', { url })
		}

		const nextInterval =
			typeof message.interval === 'number'
				? message.interval
				: typeof message['min interval'] === 'number'
					? message['min interval']
					: null
		if (nextInterval != null && nextInterval > 0) {
			const nextIntervalMs = nextInterval * 1000
			if (announceIntervals.get(url) !== nextIntervalMs) {
				announceIntervals.set(url, nextIntervalMs)
				infoTracker('announce.interval', { intervalMs: nextIntervalMs, url })
			}
		}

		if (
			typeof message.offer_id === 'string' &&
			typeof message.peer_id === 'string' &&
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
			scheduleNextAnnounce(socket)
		}

		if (
			typeof message.offer_id === 'string' &&
			typeof message.peer_id === 'string' &&
			isSignalDescription(message.offer)
		) {
			infoTracker('offer.received', { url })
			options.onOffer?.(message.offer, (answer) => {
				infoTracker('answer.sent', { url })
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
		if (closed) return

		markEndpoint(url, 'pending')
		let socket: WebSocket
		try {
			socket = new WebSocket(url)
		} catch (error) {
			warnTracker('socket.create.failed', { error, url })
			markEndpoint(url, 'failed')
			scheduleReconnect(url)
			return
		}
		sockets.add(socket)
		socketUrls.set(socket, url)

		socket.onopen = () => {
			infoTracker('socket.open', { url })
			reconnectAttempts.set(url, 0)
			markEndpoint(url, 'open')
			announce(socket)
		}
		socket.onmessage = (event) => handleMessage(socket, event.data)
		socket.onclose = () => {
			sockets.delete(socket)
			clearAnnounceTimer(socket)
			if (closed) return

			markEndpoint(url, 'failed')
			scheduleReconnect(url)
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
			reconnectTimers.clear()
			for (const socket of sockets) socket.close()
			sockets.clear()
		},
	}
}
