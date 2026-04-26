import { createEffect, onCleanup } from 'solid-js'

export const BeforeUnloadGuard = (props: { when: boolean }) => {
	createEffect(() => {
		if (!props.when) return

		// Browsers will not let us customize the text, so only ask when the interruption is real.
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault()
			event.returnValue = ''
		}

		window.addEventListener('beforeunload', warnBeforeUnload)
		onCleanup(() => {
			window.removeEventListener('beforeunload', warnBeforeUnload)
		})
	})

	return null
}
