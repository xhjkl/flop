import { render } from '@solidjs/web'
import App from './app'

const mount = document.getElementById('app')
if (mount == null) {
	throw new Error('Missing #app mount element')
}
render(() => <App />, mount)
