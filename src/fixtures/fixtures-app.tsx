import { createEffect, createSignal, For, Show } from 'solid-js'
import { Room } from '../room-ui'
import { getFixture, uiFixtures } from './fixtures'
import '../app.css'
import './fixtures.css'

function readFixtureId() {
	return new URLSearchParams(window.location.search).get('fixture')
}

function writeFixtureId(id: string | null) {
	const url = new URL(window.location.href)
	if (id == null) url.searchParams.delete('fixture')
	else url.searchParams.set('fixture', id)
	window.history.replaceState(null, '', url)
}

export default function FixturesApp() {
	const [fixtureId, setFixtureId] = createSignal<string | null>(readFixtureId())

	const activeFixture = () => getFixture(fixtureId())

	createEffect(() => {
		writeFixtureId(fixtureId())
	})

	return (
		<div class="fixture-shell">
			<section class="fixtures">
				<div class="fixture-banner">
					<strong>fixtures</strong>
					<span>one button per room state, exact same renderer as the app</span>
				</div>
				<div class="fixture-actions">
					<For each={uiFixtures}>
						{(fixture) => (
							<button
								type="button"
								onClick={() => setFixtureId(fixture.id)}
								classList={{ active: fixture.id === fixtureId() }}
							>
								{fixture.title}
							</button>
						)}
					</For>
					<button
						type="button"
						onClick={() => setFixtureId(null)}
						disabled={fixtureId() == null}
					>
						clear
					</button>
				</div>
				<div class="fixture-meta">
					<small>active: {fixtureId() ?? 'none'}</small>
					<small>
						ids: {uiFixtures.map((fixture) => fixture.id).join(', ')}
					</small>
					<Show when={activeFixture()?.description}>
						{(description) => <small>{description()}</small>}
					</Show>
				</div>
			</section>
			<Show
				when={activeFixture()}
				fallback={<Room themeSeed="fixtures-idle" />}
			>
				{(fixture) => fixture().render()}
			</Show>
		</div>
	)
}
