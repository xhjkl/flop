const QR_MAX_VERSION = 40
const QR_LEVELS = ['H', 'Q', 'M', 'L'] as const
const QR_FORMAT_BITS = { H: 2, L: 1, M: 0, Q: 3 } as const
const QR_TABLE_INDEX = { H: 3, L: 0, M: 1, Q: 2 } as const
const QR_PAD_CODEWORDS = [0xec, 0x11]
const QR_ECC_CODEWORDS = [
	[
		-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30,
		28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		30, 30, 30,
	],
	[
		-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
		26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
		28, 28, 28,
	],
	[
		-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28,
		26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		30, 30, 30,
	],
	[
		-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28,
		26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		30, 30, 30,
	],
] as const
const QR_ERROR_BLOCKS = [
	[
		-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10,
		12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
	],
	[
		-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17,
		17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
	],
	[
		-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23,
		23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
	],
	[
		-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
		25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77,
		81,
	],
] as const

type QrLevel = (typeof QR_LEVELS)[number]

type QrGrid = {
	modules: boolean[][]
	reserved: boolean[][]
	size: number
}

type QrCode = {
	path: string
	size: number
}

const textEncoder = new TextEncoder()

const emptyGrid = (size: number): QrGrid => ({
	modules: Array.from({ length: size }, () => Array(size).fill(false)),
	reserved: Array.from({ length: size }, () => Array(size).fill(false)),
	size,
})

const setFunction = (grid: QrGrid, x: number, y: number, dark: boolean) => {
	if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return

	grid.modules[y][x] = dark
	grid.reserved[y][x] = true
}

const bit = (value: number, index: number) => (value >>> index) & 1

const rawDataModules = (version: number) => {
	const base = (16 * version + 128) * version + 64
	if (version === 1) return base

	const alignments = Math.floor(version / 7) + 2
	const modules = base - ((25 * alignments - 10) * alignments - 55)
	// Versions 7–40 reserve two 18-bit version-information blocks.
	return version < 7 ? modules : modules - 36
}

const rawCodewords = (version: number) =>
	Math.floor(rawDataModules(version) / 8)

const tableIndex = (level: QrLevel) => QR_TABLE_INDEX[level]

const dataCodewords = (version: number, level: QrLevel) => {
	const row = tableIndex(level)
	return (
		rawCodewords(version) -
		QR_ECC_CODEWORDS[row][version] * QR_ERROR_BLOCKS[row][version]
	)
}

const chooseVersion = (bytes: Uint8Array) => {
	for (const level of QR_LEVELS) {
		for (let version = 1; version <= QR_MAX_VERSION; version++) {
			const requiredBits = 4 + characterCountBits(version) + bytes.length * 8
			if (requiredBits <= dataCodewords(version, level) * 8) {
				return { level, version }
			}
		}
	}

	return null
}

const characterCountBits = (version: number) => (version < 10 ? 8 : 16)

const appendBits = (bits: number[], value: number, length: number) => {
	for (let index = length - 1; index >= 0; index--) {
		bits.push(bit(value, index))
	}
}

const encodeData = (bytes: Uint8Array, version: number, level: QrLevel) => {
	const bits: number[] = []
	const capacity = dataCodewords(version, level) * 8

	appendBits(bits, 0b0100, 4)
	appendBits(bits, bytes.length, characterCountBits(version))
	for (const byte of bytes) appendBits(bits, byte, 8)

	const terminator = Math.min(4, capacity - bits.length)
	for (let index = 0; index < terminator; index++) bits.push(0)
	while (bits.length % 8 !== 0) bits.push(0)

	const codewords: number[] = []
	for (let index = 0; index < bits.length; index += 8) {
		let codeword = 0
		for (let offset = 0; offset < 8; offset++) {
			codeword = (codeword << 1) | bits[index + offset]
		}
		codewords.push(codeword)
	}

	for (
		let index = 0;
		codewords.length < dataCodewords(version, level);
		index++
	) {
		codewords.push(QR_PAD_CODEWORDS[index % QR_PAD_CODEWORDS.length])
	}

	return codewords
}

const gfMultiply = (left: number, right: number) => {
	let product = 0
	for (let index = 7; index >= 0; index--) {
		product = (product << 1) ^ ((product >>> 7) * 0x11d)
		product ^= bit(right, index) * left
	}
	return product
}

const reedSolomonDivisor = (degree: number) => {
	const result = Array(degree).fill(0)
	result[degree - 1] = 1

	let root = 1
	for (let index = 0; index < degree; index++) {
		for (let item = 0; item < result.length; item++) {
			result[item] = gfMultiply(result[item], root)
			if (item + 1 < result.length) result[item] ^= result[item + 1]
		}
		root = gfMultiply(root, 2)
	}

	return result
}

const reedSolomonRemainder = (data: number[], divisor: number[]) => {
	const result = divisor.map(() => 0)
	for (const codeword of data) {
		const factor = codeword ^ (result.shift() ?? 0)
		result.push(0)
		for (const [index, coefficient] of divisor.entries()) {
			result[index] ^= gfMultiply(coefficient, factor)
		}
	}

	return result
}

const interleaveBlocks = (data: number[], version: number, level: QrLevel) => {
	const blocks: number[][] = []
	const row = tableIndex(level)
	const blockCount = QR_ERROR_BLOCKS[row][version]
	const eccLength = QR_ECC_CODEWORDS[row][version]
	const rawLength = rawCodewords(version)
	const shortBlocks = blockCount - (rawLength % blockCount)
	const shortBlockLength = Math.floor(rawLength / blockCount)
	const divisor = reedSolomonDivisor(eccLength)

	let cursor = 0
	for (let block = 0; block < blockCount; block++) {
		const dataLength =
			shortBlockLength - eccLength + (block < shortBlocks ? 0 : 1)
		const chunk = data.slice(cursor, cursor + dataLength)
		cursor += dataLength
		const ecc = reedSolomonRemainder(chunk, divisor)
		if (block < shortBlocks) chunk.push(0)
		blocks.push([...chunk, ...ecc])
	}

	const output: number[] = []
	for (let index = 0; index < blocks[0].length; index++) {
		for (let block = 0; block < blocks.length; block++) {
			if (index === shortBlockLength - eccLength && block < shortBlocks) {
				continue
			}
			output.push(blocks[block][index])
		}
	}

	return output
}

const drawFinder = (grid: QrGrid, left: number, top: number) => {
	for (let y = -1; y <= 7; y++) {
		for (let x = -1; x <= 7; x++) {
			const xx = left + x
			const yy = top + y
			const inFinder = x >= 0 && x <= 6 && y >= 0 && y <= 6
			const dark =
				inFinder &&
				(x === 0 ||
					x === 6 ||
					y === 0 ||
					y === 6 ||
					(x >= 2 && x <= 4 && y >= 2 && y <= 4))

			setFunction(grid, xx, yy, dark)
		}
	}
}

const drawAlignment = (grid: QrGrid, centerX: number, centerY: number) => {
	for (let y = -2; y <= 2; y++) {
		for (let x = -2; x <= 2; x++) {
			setFunction(
				grid,
				centerX + x,
				centerY + y,
				Math.max(Math.abs(x), Math.abs(y)) !== 1,
			)
		}
	}
}

const formatBits = (level: QrLevel, mask: number) => {
	const data = (QR_FORMAT_BITS[level] << 3) | mask
	let remainder = data
	for (let index = 0; index < 10; index++) {
		remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
	}
	return ((data << 10) | remainder) ^ 0x5412
}

const drawFormat = (grid: QrGrid, level: QrLevel, mask: number) => {
	const bits = formatBits(level, mask)
	for (let index = 0; index <= 5; index++)
		setFunction(grid, 8, index, bit(bits, index) === 1)
	setFunction(grid, 8, 7, bit(bits, 6) === 1)
	setFunction(grid, 8, 8, bit(bits, 7) === 1)
	setFunction(grid, 7, 8, bit(bits, 8) === 1)
	for (let index = 9; index < 15; index++) {
		setFunction(grid, 14 - index, 8, bit(bits, index) === 1)
	}
	for (let index = 0; index < 8; index++) {
		setFunction(grid, grid.size - 1 - index, 8, bit(bits, index) === 1)
	}
	for (let index = 8; index < 15; index++) {
		setFunction(grid, 8, grid.size - 15 + index, bit(bits, index) === 1)
	}
	setFunction(grid, 8, grid.size - 8, true)
}

const alignmentPositions = (version: number) => {
	if (version === 1) return []

	const size = 17 + version * 4
	const count = Math.floor(version / 7) + 2
	const step =
		version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
	const positions = [6]
	for (let position = size - 7; positions.length < count; position -= step) {
		positions.splice(1, 0, position)
	}

	return positions
}

const drawVersion = (grid: QrGrid, version: number) => {
	if (version < 7) return

	let remainder = version
	for (let index = 0; index < 12; index++) {
		remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
	}

	const bits = (version << 12) | remainder
	for (let index = 0; index < 18; index++) {
		const dark = bit(bits, index) === 1
		const near = grid.size - 11 + (index % 3)
		const far = Math.floor(index / 3)
		setFunction(grid, near, far, dark)
		setFunction(grid, far, near, dark)
	}
}

const drawFunctionPatterns = (
	grid: QrGrid,
	version: number,
	level: QrLevel,
) => {
	for (let index = 0; index < grid.size; index++) {
		setFunction(grid, 6, index, index % 2 === 0)
		setFunction(grid, index, 6, index % 2 === 0)
	}

	drawFinder(grid, 0, 0)
	drawFinder(grid, grid.size - 7, 0)
	drawFinder(grid, 0, grid.size - 7)

	const positions = alignmentPositions(version)
	for (const y of positions) {
		for (const x of positions) {
			if (grid.reserved[y][x]) continue
			drawAlignment(grid, x, y)
		}
	}

	drawFormat(grid, level, 0)
	drawVersion(grid, version)
}

const drawCodewords = (grid: QrGrid, codewords: number[]) => {
	let bitIndex = 0
	for (let right = grid.size - 1; right >= 1; right -= 2) {
		const column = right === 6 ? 5 : right
		if (right === 6) right = 5

		for (let vertical = 0; vertical < grid.size; vertical++) {
			for (let offset = 0; offset < 2; offset++) {
				const x = column - offset
				const upward = ((column + 1) & 2) === 0
				const y = upward ? grid.size - 1 - vertical : vertical
				if (grid.reserved[y][x]) continue

				const codeword = codewords[bitIndex >>> 3]
				grid.modules[y][x] =
					codeword != null && bit(codeword, 7 - (bitIndex & 7)) === 1
				bitIndex++
			}
		}
	}
}

const maskBit = (mask: number, x: number, y: number) => {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0
		case 1:
			return y % 2 === 0
		case 2:
			return x % 3 === 0
		case 3:
			return (x + y) % 3 === 0
		case 4:
			return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
	}
}

const cloneGrid = (grid: QrGrid): QrGrid => ({
	modules: grid.modules.map((row) => [...row]),
	reserved: grid.reserved.map((row) => [...row]),
	size: grid.size,
})

const applyMask = (grid: QrGrid, level: QrLevel, mask: number) => {
	for (let y = 0; y < grid.size; y++) {
		for (let x = 0; x < grid.size; x++) {
			if (!grid.reserved[y][x] && maskBit(mask, x, y)) {
				grid.modules[y][x] = !grid.modules[y][x]
			}
		}
	}
	drawFormat(grid, level, mask)
}

const runPenalty = (values: boolean[]) => {
	let penalty = 0
	let runColor = values[0]
	let runLength = 1

	for (const value of values.slice(1)) {
		if (value === runColor) {
			runLength++
			if (runLength === 5) penalty += 3
			else if (runLength > 5) penalty++
			continue
		}

		runColor = value
		runLength = 1
	}

	return penalty
}

const finderPenalty = (values: boolean[]) => {
	let penalty = 0
	for (let index = 0; index <= values.length - 11; index++) {
		const pattern = values
			.slice(index, index + 11)
			.map((value) => (value ? 1 : 0))
			.join('')
		if (pattern === '10111010000' || pattern === '00001011101') penalty += 40
	}
	return penalty
}

const penaltyScore = (grid: QrGrid) => {
	let penalty = 0
	let dark = 0

	for (let y = 0; y < grid.size; y++) {
		const row = grid.modules[y]
		penalty += runPenalty(row) + finderPenalty(row)
		for (const value of row) if (value) dark++
	}

	for (let x = 0; x < grid.size; x++) {
		const column = grid.modules.map((row) => row[x])
		penalty += runPenalty(column) + finderPenalty(column)
	}

	for (let y = 0; y < grid.size - 1; y++) {
		for (let x = 0; x < grid.size - 1; x++) {
			const value = grid.modules[y][x]
			if (
				value === grid.modules[y][x + 1] &&
				value === grid.modules[y + 1][x] &&
				value === grid.modules[y + 1][x + 1]
			) {
				penalty += 3
			}
		}
	}

	const total = grid.size * grid.size
	penalty += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
	return penalty
}

const bestMaskedGrid = (grid: QrGrid, level: QrLevel) => {
	let best = grid
	let bestPenalty = Number.POSITIVE_INFINITY

	for (let mask = 0; mask < 8; mask++) {
		const candidate = cloneGrid(grid)
		applyMask(candidate, level, mask)
		const penalty = penaltyScore(candidate)
		if (penalty < bestPenalty) {
			best = candidate
			bestPenalty = penalty
		}
	}

	return best
}

const qrPath = (grid: QrGrid) => {
	const commands: string[] = []
	for (let y = 0; y < grid.size; y++) {
		let start: number | null = null
		for (let x = 0; x <= grid.size; x++) {
			const dark = x < grid.size && grid.modules[y][x]
			if (dark && start == null) start = x
			if ((!dark || x === grid.size) && start != null) {
				commands.push(`M${start} ${y}h${x - start}v1H${start}z`)
				start = null
			}
		}
	}

	return commands.join('')
}

/** Byte-mode QR for invite URLs; uses strongest correction that fits. */
export const encodeQrCode = (value: string): QrCode | null => {
	const bytes = textEncoder.encode(value)
	const choice = chooseVersion(bytes)
	if (choice == null) return null

	const { level, version } = choice

	const grid = emptyGrid(17 + version * 4)
	drawFunctionPatterns(grid, version, level)
	drawCodewords(
		grid,
		interleaveBlocks(encodeData(bytes, version, level), version, level),
	)

	const masked = bestMaskedGrid(grid, level)
	return { path: qrPath(masked), size: masked.size }
}
