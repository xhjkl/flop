import { render } from '@solidjs/web'
import FixturesApp from './fixtures-app'

const root = document.getElementById('app')
if (root != null) render(() => <FixturesApp />, root)
