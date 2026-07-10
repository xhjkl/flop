/** WebRTC offer shared by manual codes, beacon messages, and room mesh packets. */
export type OfferDescription = {
	sdp: string
	type: 'offer'
}

/** WebRTC answer shared by manual codes, beacon messages, and room mesh packets. */
export type AnswerDescription = {
	sdp: string
	type: 'answer'
}

export type SignalDescription = AnswerDescription | OfferDescription

const signalRecord = (value: unknown) => {
	if (typeof value !== 'object' || value == null) return null
	return value as Record<string, unknown>
}

/** Runtime guard for an offer crossing a signaling boundary. */
export const isOfferDescription = (
	value: unknown,
): value is OfferDescription => {
	const signal = signalRecord(value)
	return (
		signal != null && signal.type === 'offer' && typeof signal.sdp === 'string'
	)
}

/** Runtime guard for an answer crossing a signaling boundary. */
export const isAnswerDescription = (
	value: unknown,
): value is AnswerDescription => {
	const signal = signalRecord(value)
	return (
		signal != null && signal.type === 'answer' && typeof signal.sdp === 'string'
	)
}

/** Runtime guard for SDP passed through rendezvous and room packets. */
export const isSignalDescription = (
	value: unknown,
): value is SignalDescription => {
	return isOfferDescription(value) || isAnswerDescription(value)
}
