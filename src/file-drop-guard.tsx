import { onCleanup, onMount } from 'solid-js'

function dragHasFiles(event: DragEvent) {
	return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function droppedFiles(event: DragEvent) {
	return Array.from(event.dataTransfer?.files ?? [])
}

export function FileDropGuard(props: { onDropFiles: (files: File[]) => void }) {
	onMount(() => {
		// The canvas is the drop target; the browser should not navigate away with the file.
		function preventBrowserFileOpen(event: DragEvent) {
			if (!dragHasFiles(event)) return
			event.preventDefault()
		}

		function dropFiles(event: DragEvent) {
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
