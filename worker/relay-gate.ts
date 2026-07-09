import { DurableObject } from 'cloudflare:workers'
import {
	RELAY_GRANT_BYTES,
	RELAY_PATH,
	RELAY_REQUEST_HEADER,
} from '../spec/relay'
import { type Env, type JsonBody, json } from './common'

const RELAY_BUCKET_DAY_GRANTS = 4
const RELAY_BUCKET_MONTH_GRANTS = 12
const RELAY_GATE_NAME = 'relay-gate'
const RELAY_GLOBAL_MONTH_BYTES = 800_000_000_000
/** TURN credential TTL; the UI advertises 120 minutes and keeps 8 minutes grace. */
const RELAY_TTL_SECONDS = 128 * 60
const RELAY_BUCKET_PATTERN = /^[a-f0-9]{32}$/

type RelayGateReserveMessage = {
	bucket: string
}

export const isRelayCredentialsRequest = (request: Request) => {
	const { pathname } = new URL(request.url)
	return pathname === RELAY_PATH
}

const isRelayGateReserveMessage = (
	message: JsonBody,
): message is RelayGateReserveMessage => {
	return (
		typeof message.bucket === 'string' &&
		RELAY_BUCKET_PATTERN.test(message.bucket)
	)
}

const readCounter = (value: unknown) => {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const calendarKeys = (date = new Date()) => {
	const day = date.toISOString().slice(0, 10)
	return {
		day,
		month: day.slice(0, 7),
	}
}

const clientIp = (request: Request) => {
	const connectingIp = request.headers.get('cf-connecting-ip')?.trim()
	if (connectingIp != null && connectingIp !== '') return connectingIp

	const { hostname } = new URL(request.url)
	if (
		hostname !== 'localhost' &&
		hostname !== '127.0.0.1' &&
		hostname !== '[::1]'
	) {
		return null
	}

	return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

const parseIpv4 = (ip: string) => {
	const pieces = ip.split('.')
	if (pieces.length !== 4) return null

	const octets = pieces.map((piece) => {
		if (!/^\d{1,3}$/.test(piece)) return null
		const octet = Number(piece)
		return octet >= 0 && octet <= 255 ? octet : null
	})

	return octets.every((octet) => octet != null) ? octets : null
}

const parseIpv6 = (ip: string) => {
	const address = ip.toLowerCase().split('%')[0]
	if (address.includes('.')) return null

	const halves = address.split('::')
	if (halves.length > 2) return null

	const left = halves[0] === '' ? [] : halves[0].split(':')
	const right =
		halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':')
	const missing = 8 - left.length - right.length

	if (halves.length === 1 && missing !== 0) return null
	if (halves.length === 2 && missing < 1) return null

	const groups = [...left, ...Array(missing).fill('0'), ...right]
	if (groups.length !== 8) return null

	const hextets = groups.map((group) => {
		if (!/^[\da-f]{1,4}$/.test(group)) return null
		const hextet = Number.parseInt(group, 16)
		return hextet >= 0 && hextet <= 0xffff ? hextet : null
	})

	return hextets.every((hextet) => hextet != null) ? hextets : null
}

const maskIp = (ip: string) => {
	const ipv4 = parseIpv4(ip)
	if (ipv4 != null) {
		const [a, b, c] = ipv4
		return `${a}.${b}.${c}.0/24`
	}

	const ipv6 = parseIpv6(ip)
	if (ipv6 == null) return null

	return ipv6
		.map((hextet, index) => {
			if (index < 3) return hextet
			if (index === 3) return hextet & 0xff00
			return 0
		})
		.map((hextet) => hextet.toString(16).padStart(4, '0'))
		.join(':')
		.concat('/56')
}

const hashRelayBucket = async (maskedIp: string, secret: string) => {
	const encoder = new TextEncoder()
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(maskedIp),
	)

	return Array.from(new Uint8Array(signature).slice(0, 16))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

const relayBucket = async (request: Request, env: Env) => {
	if (env.RELAY_HASH_SECRET == null || env.RELAY_HASH_SECRET.trim() === '') {
		return null
	}

	const ip = clientIp(request)
	if (ip == null) return null

	const maskedIp = maskIp(ip)
	return maskedIp == null
		? null
		: await hashRelayBucket(maskedIp, env.RELAY_HASH_SECRET)
}

const reserveRelayGrant = async (request: Request, env: Env) => {
	const bucket = await relayBucket(request, env)
	if (bucket == null) {
		return json({ error: 'relay client unavailable' }, { status: 403 })
	}

	const id = env.RELAY_GATE.idFromName(RELAY_GATE_NAME)
	const response = await env.RELAY_GATE.get(id).fetch(
		new Request('https://relay-gate.local/reserve', {
			body: JSON.stringify({ bucket }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		}),
	)

	if (response.ok) return null

	return new Response(response.body, {
		headers: {
			'cache-control': 'no-store',
			'content-type':
				response.headers.get('content-type') ??
				'application/json; charset=utf-8',
		},
		status: response.status,
	})
}

export const issueRelayCredentials = async (request: Request, env: Env) => {
	if (request.method !== 'POST') {
		return json({ error: 'method not allowed' }, { status: 405 })
	}

	// Same-origin fetches can set this header; cross-site forms cannot.
	if (request.headers.get(RELAY_REQUEST_HEADER) !== '1') {
		return json({ error: 'relay request required' }, { status: 403 })
	}

	if (env.RELAY_ENABLED !== 'true') {
		return json({ error: 'relay disabled' }, { status: 503 })
	}

	if (
		env.RELAY_HASH_SECRET == null ||
		env.RELAY_HASH_SECRET.trim() === '' ||
		env.TURN_KEY_ID == null ||
		env.TURN_KEY_ID.trim() === '' ||
		env.TURN_KEY_API_TOKEN == null ||
		env.TURN_KEY_API_TOKEN.trim() === ''
	) {
		return json({ error: 'relay not configured' }, { status: 503 })
	}

	const reserved = await reserveRelayGrant(request, env)
	if (reserved != null) return reserved

	const response = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
		{
			body: JSON.stringify({ ttl: RELAY_TTL_SECONDS }),
			headers: {
				authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
				'content-type': 'application/json',
			},
			method: 'POST',
		},
	)

	if (!response.ok) {
		return json({ error: 'relay unavailable' }, { status: 502 })
	}

	return new Response(response.body, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json; charset=utf-8',
		},
		status: response.status,
	})
}

/** Global relay cashier; reserves TURN budget before credentials are minted. */
export class RelayGate extends DurableObject {
	async fetch(request: Request) {
		if (request.method !== 'POST') {
			return json({ error: 'method not allowed' }, { status: 405 })
		}

		const message = await request.json().catch(() => null)
		if (
			typeof message !== 'object' ||
			message == null ||
			!isRelayGateReserveMessage(message as JsonBody)
		) {
			return json({ error: 'invalid relay reservation' }, { status: 400 })
		}

		return await this.reserve(message.bucket)
	}

	async reserve(bucket: string) {
		const { day, month } = calendarKeys()
		const globalMonthKey = `global:${month}:bytes`
		const bucketDayKey = `bucket:${day}:${bucket}:grants`
		const bucketMonthKey = `bucket:${month}:${bucket}:grants`

		return await this.ctx.storage.transaction(async (transaction) => {
			const globalMonthBytes = readCounter(
				await transaction.get(globalMonthKey),
			)
			const bucketDayGrants = readCounter(await transaction.get(bucketDayKey))
			const bucketMonthGrants = readCounter(
				await transaction.get(bucketMonthKey),
			)

			if (globalMonthBytes + RELAY_GRANT_BYTES > RELAY_GLOBAL_MONTH_BYTES) {
				return json({ error: 'relay monthly budget spent' }, { status: 429 })
			}

			if (bucketDayGrants >= RELAY_BUCKET_DAY_GRANTS) {
				return json({ error: 'relay daily budget spent' }, { status: 429 })
			}

			if (bucketMonthGrants >= RELAY_BUCKET_MONTH_GRANTS) {
				return json({ error: 'relay monthly bucket spent' }, { status: 429 })
			}

			await transaction.put({
				[globalMonthKey]: globalMonthBytes + RELAY_GRANT_BYTES,
				[bucketDayKey]: bucketDayGrants + 1,
				[bucketMonthKey]: bucketMonthGrants + 1,
			})

			return json({
				granted: 1,
				reservedBytes: RELAY_GRANT_BYTES,
			})
		})
	}
}
