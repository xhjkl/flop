export type { BeaconPresence } from '../../contracts/beacon'

/** Beacon socket lifecycle state projected into invite-link UI. */
export type BeaconStatus = 'failed' | 'finding' | 'idle' | 'ready'
