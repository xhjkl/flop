const DEFAULT_HUE = 110
// Room color is host identity snapped to a curated set, not a raw rainbow spin.
const ROOM_HUES = [
	23, // tangerine
	50, // dark jasmine
	136, // emerald
	168, // jade
	194, // lagoon
	224, // azure
	254, // indigo
	284, // violet
	314, // orchid
	338, // cherry
	354, // burgundy
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
	if (hash == null) return ROOM_HUES[1]

	return ROOM_HUES[hash % ROOM_HUES.length]
}
