## flop

Flop is a single-page, browser-to-browser room for sending files and small notes. It is built with Solid and Vite, with WebRTC data channels for the direct peer path.

### Product Shape

The UI is one portrait strip. Your own portrait comes first, peer portraits follow, and room actions appear as utility portraits instead of dashboards or modal flows.

### Visible Flows

#### Start

Opening the app starts as a host and creates an invite. The welcome portrait explains the loop: share one invite, paste back one reply, then send files device-to-device.

#### Camera And Microphone

The welcome portrait has one explicit `enable camera + mic` action. If permission works, the same card becomes a local mirror with camera and microphone toggles; if it fails, the card says whether access was denied, devices are missing, the browser is unsupported, or capture failed.

#### Invite Someone

The host connection card shows a copyable invite and one reply input. Send the invite to another device, then paste the reply back to let that guest in.

#### Join Someone

A guest can open an invite link or choose to join instead. The reply card accepts the invite, creates a copyable reply, and waits for the host to paste it.

#### Live Room

Once connected, people show as portraits in the strip. The host introduces guests to each other, then guest-to-guest links are created directly instead of routing room traffic through the host.

#### Files

Drop files anywhere on the page to send them to connected peers. File chips appear under the sender’s portrait, show sending/receiving/ready/error state, and received files become download links.

#### Blips

A blip is the small text line on a portrait. Write it any time; Flop keeps it locally and sends it to peers as direct links come alive.

#### Closed Room

If a guest loses the host, the room becomes closed and offers host-or-join recovery inside the connection card. If a non-host guest leaves, the host room stays alive.

### Dev

```bash
bun install
bun run dev
bun run sculpt
```

`bun run sculpt` opens the fixture surface for shaping UI states against the same card renderer.

### Build

```bash
bun run check
bun run typecheck
bun run build
bun run preview
```

The production build emits `dist/`. Fixtures are dev-only, and future publishing should be a dedicated action rather than a checked-in build folder.

### Publish

GitHub Pages is published by `.github/workflows/publish.yml`: every push to `main` installs, checks, typechecks, builds, and uploads `dist/` as a Pages artifact. In the GitHub repository settings, set Pages source to `GitHub Actions`; after that, pushes to `main` publish the HTTPS build.
