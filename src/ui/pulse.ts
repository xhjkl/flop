import { createSignal, onCleanup } from 'solid-js'

/** Short-lived success state for controls that briefly acknowledge a commit. */
export const createPulse = (durationMs: number) => {
	let timeout: ReturnType<typeof setTimeout> | null = null
	const [active, setActive] = createSignal(false)

	const clear = () => {
		if (timeout != null) {
			clearTimeout(timeout)
			timeout = null
		}
		setActive(false)
	}

	const trigger = () => {
		clear()
		setActive(true)
		timeout = setTimeout(clear, durationMs)
	}

	onCleanup(clear)

	return { active, clear, trigger }
}
