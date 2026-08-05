export type Env = {
	RELAY_GATE: DurableObjectNamespace
	RELAY_ENABLED?: string
	RELAY_HASH_SECRET?: string
	ROOMS: DurableObjectNamespace
	TURN_KEY_API_TOKEN?: string
	TURN_KEY_ID?: string
}

type JsonResponseInit = ResponseInit & {
	headers?: Record<string, string>
}

export const json = (
	body: Record<string, unknown>,
	init: JsonResponseInit = {},
) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json; charset=utf-8',
			...init.headers,
		},
	})
