/** Beacon socket lifecycle state projected into invite-link UI. */
export type BeaconStatus = 'failed' | 'finding' | 'idle' | 'ready'

/** Beacon room presence summary; no room identity or content leaves the browser. */
export type BeaconPresence = {
	guests: number
	hosts: number
	peers: number
}
