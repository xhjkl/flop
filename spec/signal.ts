/** SDP shape shared by manual codes, beacon offers, and room mesh packets. */
export type SignalDescription = {
	sdp: string
	type: 'answer' | 'offer'
}

/** Runtime guard for SDP passed through rendezvous and room packets. */
export const isSignalDescription = (
	value: unknown,
): value is SignalDescription => {
	if (typeof value !== 'object' || value == null) return false

	const signal = value as SignalDescription
	return (
		(signal.type === 'offer' || signal.type === 'answer') &&
		typeof signal.sdp === 'string'
	)
}
