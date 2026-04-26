const DEFAULT_HUE = 204
// Room color is host identity snapped to a curated set, not a raw rainbow spin.
const ROOM_HUES = [
	18, // tomato
	42, // marigold
	118, // wasabi
	152, // green
	184, // pool
	214, // blue
	262, // grape
	304, // magenta
	338, // cherry
]

const hashSeed = (seed: string | null): number | null => {
	if (seed == null || seed === '') return null

	let hash = 97
	for (let i = 0; i < seed.length; i++) {
		hash = (hash * 33 + seed.charCodeAt(i) + 41) % 360
	}

	return hash
}

export const hueFromSeed = (seed: string | null, offset = 0): number => {
	const hue = hashSeed(seed) ?? DEFAULT_HUE
	return (hue + offset) % 360
}

export const themeHueFromSeed = (seed: string | null): number => {
	const hash = hashSeed(seed)
	if (hash == null) return DEFAULT_HUE

	return ROOM_HUES[hash % ROOM_HUES.length]
}
