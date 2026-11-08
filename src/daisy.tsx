const DAISY_RADIUS = 10

/** Render a circular meter with the number legible at every fill level. */
export const Daisy = (props: {
	ariaLabel: string
	max: number
	text: string
	value: number
}) => {
	const fill = () => {
		if (props.max <= 0) return 0
		return Math.max(0, Math.min(props.max, props.value)) / props.max
	}
	const textSize = () => {
		const characters = Math.max(1, [...props.text].length)
		const rem = Math.max(0.4, Math.min(0.58, 1.35 / characters))
		return `${rem.toFixed(3)}rem`
	}

	return (
		<svg
			class="daisy"
			viewBox="0 0 32 32"
			role="img"
			aria-label={props.ariaLabel}
			style={`--daisy-fill: ${fill()}; --daisy-value-size: ${textSize()};`}
		>
			<circle class="daisy-track" cx="16" cy="16" r={DAISY_RADIUS} />
			<circle
				class="daisy-segment"
				cx="16"
				cy="16"
				r={DAISY_RADIUS}
				pathLength="1"
			/>
			<text class="daisy-value" x="16" y="16">
				{props.text}
			</text>
		</svg>
	)
}
