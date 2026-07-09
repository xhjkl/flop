import {
	RELAY_GRANT_BYTES,
	RELAY_GRANT_SECONDS,
	RELAY_PATH,
	RELAY_REQUEST_HEADER,
} from '../../spec/relay'
import type { RelayMetering } from '../state'
import type { LinkId, RoomLink } from './link'

export { RELAY_GRANT_BYTES, RELAY_GRANT_SECONDS } from '../../spec/relay'
export const RELAY_FALLBACK_WAIT_SECONDS = 8

const RELAY_STATS_INTERVAL_MS = 3000

/** Relay mint refusal after the shared free allowance has been spent. */
export class RelayQuotaExceededError extends Error {
	constructor() {
		super('Relay quota exceeded')
		this.name = 'RelayQuotaExceededError'
	}
}

type RelayPeerOptions = {
	iceServers?: RTCIceServer[]
	iceTransportPolicy?: RTCIceTransportPolicy
}

export type RoomRelay = {
	active: () => boolean
	clear: (options?: { keepMetering?: boolean }) => void
	peerOptions: () => RelayPeerOptions
	start: (iceServers: RTCIceServer[], onExpired: () => void) => void
}

const isTurnUrl = (url: string) => /^turns?:/i.test(url)

const turnUrls = (value: unknown): RTCIceServer['urls'] | null => {
	if (typeof value === 'string') return isTurnUrl(value) ? value : null
	if (!Array.isArray(value)) return null

	const urls = value.filter((item): item is string => typeof item === 'string')
	if (urls.length !== value.length) return null

	const relayUrls = urls.filter(isTurnUrl)
	return relayUrls.length === 0 ? null : relayUrls
}

const relayIceServer = (value: unknown): RTCIceServer | null => {
	if (typeof value !== 'object' || value == null) return null
	if (!('urls' in value)) return null

	const urls = turnUrls(value.urls)
	if (urls == null) return null

	const server: RTCIceServer = { urls }
	if ('username' in value && typeof value.username === 'string') {
		server.username = value.username
	}
	if ('credential' in value && typeof value.credential === 'string') {
		server.credential = value.credential
	}

	return server
}

const relayIceServers = (value: unknown) => {
	if (typeof value !== 'object' || value == null) return null
	if (!('iceServers' in value) || !Array.isArray(value.iceServers)) return null

	const servers = value.iceServers.flatMap((item) => {
		const server = relayIceServer(item)
		return server == null ? [] : [server]
	})

	return servers.length === 0 ? null : servers
}

/** Same-origin TURN mint used only after direct invite-link discovery stalls. */
export const requestRelayIceServers = async () => {
	const response = await fetch(RELAY_PATH, {
		headers: {
			accept: 'application/json',
			[RELAY_REQUEST_HEADER]: '1',
		},
		method: 'POST',
	})

	if (!response.ok) {
		if (response.status === 429) throw new RelayQuotaExceededError()

		throw new Error(`Relay credentials unavailable: ${response.status}`)
	}

	const body: unknown = await response.json()
	const servers = relayIceServers(body)
	if (servers == null) throw new Error('Relay credentials did not include TURN')

	return servers
}

/** Active relay state and honest local usage meter for the current room. */
export const createRoomRelay = (options: {
	links: Map<LinkId, RoomLink>
	onStatsError: (error: unknown, link: RoomLink) => void
	setMetering: (metering: RelayMetering | null) => void
}): RoomRelay => {
	const linkBytes = new Map<LinkId, number>()
	let iceServers: RTCIceServer[] | null = null
	let meterTimer: ReturnType<typeof setInterval> | null = null

	const clear = (clearOptions: { keepMetering?: boolean } = {}) => {
		if (meterTimer != null) {
			clearInterval(meterTimer)
			meterTimer = null
		}

		linkBytes.clear()
		iceServers = null
		if (!clearOptions.keepMetering) options.setMetering(null)
	}

	const sampleBytes = async () => {
		await Promise.all(
			[...options.links.values()].map(async (link) => {
				const stats = await link.peer.relayStats().catch((error: unknown) => {
					options.onStatsError(error, link)
					return null
				})
				if (stats == null) return

				linkBytes.set(
					link.id,
					Math.max(linkBytes.get(link.id) ?? 0, stats.bytes),
				)
			}),
		)

		return [...linkBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
	}

	const start = (servers: RTCIceServer[], onExpired: () => void) => {
		clear()
		iceServers = servers

		const expiresAt = Date.now() + RELAY_GRANT_SECONDS * 1000
		let bytesSpent = 0
		let lastStatsAt = 0
		let updateRunning = false

		const update = async () => {
			if (updateRunning) return

			updateRunning = true
			try {
				const now = Date.now()
				if (now - lastStatsAt >= RELAY_STATS_INTERVAL_MS) {
					bytesSpent = await sampleBytes()
					lastStatsAt = now
				}

				const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000))
				const bytesLeft = Math.max(0, RELAY_GRANT_BYTES - bytesSpent)
				options.setMetering({ bytesLeft, secondsLeft })
				if (secondsLeft > 0 && bytesLeft > 0) return

				options.setMetering({ bytesLeft: 0, secondsLeft: 0 })
				clear({ keepMetering: true })
				onExpired()
			} finally {
				updateRunning = false
			}
		}

		void update()
		meterTimer = setInterval(() => void update(), 1000)
	}

	return {
		active: () => iceServers != null,
		clear,
		peerOptions: () =>
			iceServers == null
				? {}
				: { iceServers, iceTransportPolicy: 'relay' as const },
		start,
	}
}

export type RelayFallbackTimer = {
	hide: () => void
	start: () => void
	stop: () => void
}

/** Direct-first wait meter before the guest is allowed to request relay credentials. */
export const createRelayFallbackTimer = (options: {
	active: () => boolean
	currentSecondsLeft: () => number | null
	finding: () => boolean
	setSecondsLeft: (seconds: number | null) => void
}): RelayFallbackTimer => {
	let timer: ReturnType<typeof setTimeout> | null = null
	let endsAt = 0

	const stop = () => {
		if (timer == null) return

		clearTimeout(timer)
		timer = null
	}

	const hide = () => {
		stop()
		options.setSecondsLeft(null)
	}

	const tick = () => {
		if (timer == null) return
		if (!options.finding()) {
			stop()
			return
		}
		if (options.active()) {
			hide()
			return
		}

		const secondsLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
		options.setSecondsLeft(secondsLeft)
		if (secondsLeft <= 0) {
			stop()
			return
		}

		timer = setTimeout(tick, 1000)
	}

	const start = () => {
		if (options.active()) return
		if (timer != null) return
		if (options.currentSecondsLeft() === 0) return

		endsAt = Date.now() + RELAY_FALLBACK_WAIT_SECONDS * 1000
		options.setSecondsLeft(RELAY_FALLBACK_WAIT_SECONDS)
		timer = setTimeout(tick, 1000)
	}

	return { hide, start, stop }
}
