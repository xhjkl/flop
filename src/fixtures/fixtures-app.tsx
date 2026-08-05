import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { PortraitStrip } from '../portraits'
import { uiFixtures } from './fixtures'
import '../app.css'
import './fixtures.css'

const readFixtureId = () => {
	return new URLSearchParams(window.location.search).get('fixture')
}

const writeFixtureId = (id: string | null) => {
	const url = new URL(window.location.href)
	if (id == null) url.searchParams.delete('fixture')
	else url.searchParams.set('fixture', id)
	window.history.replaceState(null, '', url)
}

const FixturesApp = () => {
	const [fixtureId, setFixtureId] = createSignal<string | null>(readFixtureId())

	const activeFixture = createMemo(
		() => uiFixtures.find((fixture) => fixture.id === fixtureId()) ?? null,
	)

	createEffect(() => {
		writeFixtureId(fixtureId())
	})

	return (
		<div class="fixture-shell">
			<section class="fixtures">
				<div class="fixture-actions scrollbarless">
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
			</section>
			<Show
				keyed
				when={activeFixture()}
				fallback={<PortraitStrip themeSeed="fixtures-idle" />}
			>
				{(fixture) => fixture.render()}
			</Show>
		</div>
	)
}

export default FixturesApp
