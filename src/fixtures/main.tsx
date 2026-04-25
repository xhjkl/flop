import { render } from 'solid-js/web'
import FixturesApp from './fixtures-app'

const root = document.getElementById('app')
if (root != null) render(() => <FixturesApp />, root)
