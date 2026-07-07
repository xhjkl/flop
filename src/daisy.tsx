const DAISY_RADIUS = 10

const clampDaisyValue = (value: number, max: number) => {
	if (max <= 0) return 0
	return Math.max(0, Math.min(max, value))
}

const daisyTextSize = (text: string) => {
	const characters = Math.max(1, [...text].length)
	const rem = Math.max(0.4, Math.min(0.58, 1.35 / characters))
	return `${rem.toFixed(3)}rem`
}

/** Circular value meter with the number kept legible at every fill level. */
export const Daisy = (props: {
	ariaLabel?: string
	max: number
	text: string
	value: number
}) => {
	const value = () => clampDaisyValue(props.value, props.max)
	const fill = () => {
		if (props.max <= 0) return 0
		return value() / props.max
	}
	const textSize = () => daisyTextSize(props.text)

	return (
		<svg
			class="daisy"
			viewBox="0 0 32 32"
			role={props.ariaLabel == null ? undefined : 'img'}
			aria-hidden={props.ariaLabel == null ? 'true' : undefined}
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
