import {
	FlopRoom,
	isRendezvousRequest,
	roomNameFromRequest,
	websocketResponse,
} from './beacon'
import { type Env, json } from './common'
import {
	isRelayCredentialsRequest,
	issueRelayCredentials,
	RelayGate,
} from './relay-gate'

export { FlopRoom, RelayGate }

/** Public Worker route shared by rendezvous sockets and relay credentials. */
export default {
	fetch(request: Request, env: Env) {
		if (isRelayCredentialsRequest(request)) {
			return issueRelayCredentials(request, env)
		}

		if (isRendezvousRequest(request) && roomNameFromRequest(request) == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const discoveryId = roomNameFromRequest(request)
		if (discoveryId != null) {
			if (request.headers.get('upgrade') !== 'websocket') {
				return websocketResponse()
			}

			const id = env.ROOMS.idFromName(discoveryId)
			return env.ROOMS.get(id).fetch(request)
		}

		return json({ error: 'not found' }, { status: 404 })
	},
}
