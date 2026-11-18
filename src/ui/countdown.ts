import { createEffect, createSignal, untrack } from 'solid-js'

/** Milliseconds left until a `Date.now()` deadline, refreshed every frame until it passes. */
export const createCountdown = (endsAt: () => number) => {
	const msLeftAt = (deadline: number) => Math.max(0, deadline - Date.now())
	const initialDeadline = untrack(endsAt)
	const [msLeft, setMsLeft] = createSignal(msLeftAt(initialDeadline))

	createEffect(endsAt, (deadline) => {
		let frame: number | null = null
		const tick = () => {
			const left = msLeftAt(deadline)
			setMsLeft(left)
			frame = left > 0 ? requestAnimationFrame(tick) : null
		}

		tick()
		return () => {
			if (frame != null) cancelAnimationFrame(frame)
		}
	})

	return msLeft
}
