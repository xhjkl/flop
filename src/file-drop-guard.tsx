import { onCleanup, onMount } from 'solid-js'

const dragHasFiles = (event: DragEvent) => {
	return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

const droppedFiles = (event: DragEvent) => {
	return Array.from(event.dataTransfer?.files ?? [])
}

export const FileDropGuard = (props: {
	onDropFiles: (files: File[]) => void
}) => {
	onMount(() => {
		// The canvas is the drop target; the browser should not navigate away with the file.
		const preventBrowserFileOpen = (event: DragEvent) => {
			if (!dragHasFiles(event)) return
			event.preventDefault()
		}

		const dropFiles = (event: DragEvent) => {
			if (!dragHasFiles(event)) return

			const files = droppedFiles(event)
			event.preventDefault()
			if (files.length > 0) props.onDropFiles(files)
		}

		window.addEventListener('dragover', preventBrowserFileOpen)
		window.addEventListener('drop', dropFiles)

		onCleanup(() => {
			window.removeEventListener('dragover', preventBrowserFileOpen)
			window.removeEventListener('drop', dropFiles)
		})
	})

	return null
}
