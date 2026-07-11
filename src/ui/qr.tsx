import type { QrCode } from './qr-code'

/** Scannable QR rendering paired with an adjacent selectable text value. */
export const QrCodeImage = (props: { code: QrCode }) => {
	return (
		<svg
			class="connection-copy-qr"
			viewBox={`0 0 ${props.code.size} ${props.code.size}`}
			aria-hidden="true"
		>
			<rect
				class="connection-copy-qr-paper"
				width={props.code.size}
				height={props.code.size}
			/>
			<path class="connection-copy-qr-ink" d={props.code.path} />
		</svg>
	)
}
