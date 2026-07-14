/** Crop alignment matching a pointer's proportional position over the video. */
export const viewfinderObjectPosition = (
	clientX: number,
	clientY: number,
	bounds: Pick<DOMRectReadOnly, 'height' | 'left' | 'top' | 'width'>,
	mirrored: boolean,
) => {
	const inline = Math.min(
		100,
		Math.max(0, ((clientX - bounds.left) / bounds.width) * 100),
	)
	const block = Math.min(
		100,
		Math.max(0, ((clientY - bounds.top) / bounds.height) * 100),
	)

	// Object positioning happens before the self-preview mirror transform.
	const visibleInline = mirrored ? 100 - inline : inline
	return `${visibleInline}% ${block}%`
}
