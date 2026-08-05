import { RendezvousRoom, rendezvousRoute, websocketResponse } from './beacon'
import { type Env, json } from './common'
import {
	isRelayCredentialsRequest,
	issueRelayCredentials,
	RelayGate,
} from './relay-gate'

export { RelayGate, RendezvousRoom }

/** Public Worker route shared by rendezvous sockets and relay credentials. */
export default {
	fetch(request: Request, env: Env) {
		if (isRelayCredentialsRequest(request)) {
			return issueRelayCredentials(request, env)
		}

		const rendezvous = rendezvousRoute(request)
		if (rendezvous != null) {
			if (rendezvous.discoveryId == null) {
				return json({ error: 'invalid room' }, { status: 400 })
			}
			if (request.headers.get('upgrade') !== 'websocket') {
				return websocketResponse()
			}

			const id = env.ROOMS.idFromName(rendezvous.discoveryId)
			return env.ROOMS.get(id).fetch(request)
		}

		return json({ error: 'not found' }, { status: 404 })
	},
}
