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

/** Correlation id binding one offer to its answer across a signaling path. */
export type SignalExchangeId = string & {
	readonly SignalExchangeId: unique symbol
}

const SIGNAL_EXCHANGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Validate a signaling exchange id at an untrusted boundary. */
export const parseSignalExchangeId = (
	value: unknown,
): SignalExchangeId | null => {
	return typeof value === 'string' && SIGNAL_EXCHANGE_ID_PATTERN.test(value)
		? (value as SignalExchangeId)
		: null
}

const isOfferDescription = (value: unknown): value is OfferDescription => {
	return (
		typeof value === 'object' &&
		value != null &&
		'type' in value &&
		'sdp' in value &&
		value.type === 'offer' &&
		typeof value.sdp === 'string'
	)
}

const isAnswerDescription = (value: unknown): value is AnswerDescription => {
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
