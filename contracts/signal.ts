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

/** Runtime guard for an offer crossing a signaling boundary. */
export const isOfferDescription = (
	value: unknown,
): value is OfferDescription => {
	return (
		typeof value === 'object' &&
		value != null &&
		'type' in value &&
		'sdp' in value &&
		value.type === 'offer' &&
		typeof value.sdp === 'string'
	)
}

/** Runtime guard for an answer crossing a signaling boundary. */
export const isAnswerDescription = (
	value: unknown,
): value is AnswerDescription => {
	return (
		typeof value === 'object' &&
		value != null &&
		'type' in value &&
		'sdp' in value &&
		value.type === 'answer' &&
		typeof value.sdp === 'string'
	)
}

/** Runtime guard for SDP passed through rendezvous and room packets. */
export const isSignalDescription = (
	value: unknown,
): value is SignalDescription => {
	return isOfferDescription(value) || isAnswerDescription(value)
}
