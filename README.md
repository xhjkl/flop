## 🌀 flop

Flop is a single-page browser room for sending files and short notes directly over WebRTC to anyone with an invite link: no account, inbox, upload step, or storage server in the middle.

The whole interface is a strip of portraits: you, peers, and special utility portraits for connection or room actions, which keeps the implementation small and the room easy to scan.

Open Flop, send one invite link, and drop files once another browser joins. The link finds the room through a tiny Cloudflare Worker + Durable Object rendezvous beacon; if that path stalls, people can use manual invite and reply codes instead. Those codes are Flop's copy-paste wrapper around the same WebRTC offer and answer the beacon normally exchanges, so any third channel of communication can become the rendezvous path. Once inside the same room, browsers carry data directly over their peer connection; no one else sees or stores the contents.

<details>
<summary>How It Works</summary>

Flop starts with the easy path: send an invite link, and the two browsers try to find each other through the same-origin rendezvous beacon at `/-/<discovery-id>`. If that does not work on a particular network, the same connection can be made manually with copy-paste codes.

The invite link contains a random room secret. Browsers turn that secret into two separate values: a short public discovery id and an HMAC auth key. The Worker routes each discovery id to its own Durable Object beacon, and that object fans out WebRTC offers and answers between connected browsers. It stores no files, no room messages, and no room secret.

The discovery id is not enough to enter a room. A browser introduced by the beacon still has to answer an HMAC challenge derived from the room secret in the invite link. That keeps the beacon small while making it effectively impossible in practice to brute-force or prank your way into someone else's room.

Manual invite and reply codes are the same WebRTC offer and answer exchange with the beacon removed. The host copies an invite code, the guest turns it into a reply code, and the host pastes that reply back. Any chat, email, QR code, terminal, or sticky note can be the signaling channel.

Flop is meant for lightweight, direct sharing, not hostile-network anonymity. Anyone with the invite link or manual codes should be treated as invited.

</details>

### Development

```bash
bun install
bun run dev
```

`bun run dev` starts the Vite app for UI work. Automatic invite links need the beacon too; for full local testing, run these in two terminals:

```bash
bun run dev:beacon
bun run dev
```

Vite proxies `/-/*` WebSockets to Wrangler on `127.0.0.1:8787`, so local invite links keep the same same-origin shape as production.

### UI Fixtures

```bash
bun run sculpt
```

`bun run sculpt` opens the fixture surface for shaping UI states against the same card renderer used by the app.

### Build

```bash
bun run check
bun run typecheck
bun run build
bun run preview
```

The production build emits `dist/`. Fixtures are dev-only.

### Publish

Flop is deployed as a Cloudflare Pages site plus a narrow Cloudflare Worker beacon.

Create a Cloudflare Pages project from the repository with:

```text
Build command: bun run build
Build output directory: dist
```

Deploy the rendezvous Worker separately:

```bash
bunx wrangler login
bun run deploy:beacon
```

The beacon Worker config lives at `worker/wrangler.toml` so Cloudflare Pages can treat the repository root as a plain Vite app.

Then attach the Worker to the Pages hostname at `/-/*`, for example:

```text
flop.example.com/-/*
```

The Pages project owns the static app. The Worker owns only rendezvous WebSockets and routes each discovery id to a Durable Object. File and note traffic stays on WebRTC between browsers.
