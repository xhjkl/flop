declare module 'cloudflare:workers' {
	export class DurableObject {
		protected ctx: DurableObjectState
		protected env: unknown

		constructor(ctx: DurableObjectState, env: unknown)
	}
}

type DurableObjectId = object

interface DurableObjectNamespace {
	idFromName(name: string): DurableObjectId
	get(id: DurableObjectId): DurableObjectStub
}

interface DurableObjectState {
	acceptWebSocket(socket: WebSocket): void
	getWebSockets(): WebSocket[]
	storage: DurableObjectStorage
}

interface DurableObjectStorage {
	transaction<T>(
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T>
}

interface DurableObjectTransaction {
	get<T = unknown>(key: string): Promise<T | undefined>
	put(entries: Record<string, unknown>): Promise<void>
}

interface DurableObjectStub {
	fetch(request: Request): Response | Promise<Response>
}

interface ResponseInit {
	webSocket?: WebSocket
}

interface WebSocket {
	deserializeAttachment(): unknown
	serializeAttachment(attachment: unknown): void
}

declare class WebSocketPair {
	readonly 0: WebSocket
	readonly 1: WebSocket
}
