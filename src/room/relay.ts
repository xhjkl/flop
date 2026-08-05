import {
	RELAY_GRANT_BYTES,
	RELAY_GRANT_SECONDS,
	RELAY_PATH,
	RELAY_REQUEST_HEADER,
} from '../../contracts/relay'
import type { RoomConnection } from './link'

export const RELAY_FALLBACK_WAIT_SECONDS = 8

const RELAY_STATS_INTERVAL_MS = 3000

/** Shared TURN usage remaining for a relayed room. */
export type RelayMetering = {
	bytesLeft: number
	secondsLeft: number
}

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

type RelaySession = {
	connectionBytes: Map<RoomConnection, number>
	expiresAt: number
	iceServers: RTCIceServer[]
	timer: ReturnType<typeof setInterval> | null
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
export const requestRelayIceServers = async (signal: AbortSignal) => {
	const response = await fetch(RELAY_PATH, {
		headers: {
			accept: 'application/json',
			[RELAY_REQUEST_HEADER]: '1',
		},
		method: 'POST',
		signal,
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

/** TURN configuration and local usage estimate for the active relay grant. */
export const createRoomRelay = (options: {
	connections: () => RoomConnection[]
	onStatsError: (error: unknown, connection: RoomConnection) => void
	setMetering: (metering: RelayMetering | null) => void
}) => {
	let activeSession: RelaySession | null = null

	const clear = (clearOptions: { keepMetering?: boolean } = {}) => {
		const session = activeSession
		activeSession = null
		if (session?.timer != null) clearInterval(session.timer)
		if (!clearOptions.keepMetering) options.setMetering(null)
	}

	const start = (servers: RTCIceServer[], onExpired: () => void) => {
		clear()
		const session: RelaySession = {
			connectionBytes: new Map(),
			expiresAt: Date.now() + RELAY_GRANT_SECONDS * 1000,
			iceServers: servers,
			timer: null,
		}
		activeSession = session
		let bytesSpent = 0
		let lastStatsAt = 0
		let updateRunning = false

		const update = async () => {
			if (activeSession !== session || updateRunning) return

			updateRunning = true
			try {
				if (Date.now() - lastStatsAt >= RELAY_STATS_INTERVAL_MS) {
					await Promise.all(
						options.connections().map(async (connection) => {
							const bytes = await connection.rtc
								.relayBytes()
								.catch((error: unknown) => {
									if (activeSession === session) {
										options.onStatsError(error, connection)
									}
									return null
								})
							if (activeSession !== session || bytes == null) return

							session.connectionBytes.set(
								connection,
								Math.max(session.connectionBytes.get(connection) ?? 0, bytes),
							)
						}),
					)
					if (activeSession !== session) return

					bytesSpent = [...session.connectionBytes.values()].reduce(
						(sum, bytes) => sum + bytes,
						0,
					)
					lastStatsAt = Date.now()
				}
				if (activeSession !== session) return

				const now = Date.now()
				const secondsLeft = Math.max(
					0,
					Math.ceil((session.expiresAt - now) / 1000),
				)
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
		session.timer = setInterval(() => void update(), 1000)
	}
	const peerOptions = (): RelayPeerOptions => {
		return activeSession == null
			? {}
			: {
					iceServers: activeSession.iceServers,
					iceTransportPolicy: 'relay',
				}
	}

	return {
		active: () => activeSession != null,
		clear,
		peerOptions,
		start,
	}
}
