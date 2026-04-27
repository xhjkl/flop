## 🌀 flop

Flop is a single-page browser room for sending files and short notes directly over WebRTC to anyone with an invite link: no account, inbox, upload step, or storage server in the middle.

The whole interface is a strip of portraits: you, peers, and special utility portraits for connection or room actions, which keeps the implementation small and the room easy to scan.

Open Flop, send one invite link, and drop files once another browser joins. The link tries to find the room automatically by borrowing public WebTorrent trackers for rendezvous; if that path stalls, people can use manual invite and reply codes instead. Those codes are Flop's copy-paste wrapper around the WebRTC offer and answer browsers normally exchange through an app-owned signaling service, so any third channel of communication can become the rendezvous path. Once inside the same room, browsers carry data directly over their peer connection; no one else sees or stores the contents.

<details>
<summary>How It Works</summary>

Flop starts with the easy path: send an invite link, and the two browsers try to find each other through public WebTorrent trackers. If that does not work on a particular network, the same connection can be made manually with copy-paste codes.

The invite link contains a random room secret. Browsers turn that secret into two separate values: a short discovery hash and an HMAC auth key. The discovery hash is shaped like a BitTorrent `info_hash`, so public WebTorrent trackers can be used as a tiny "who else is here?" noticeboard. This is the pseudotorrent bit: Flop announces no real torrent, uploads no file to a tracker, and only borrows tracker infrastructure to swap WebRTC offers and answers. That means Flop does not need an app-owned rendezvous matchmaker server just to introduce two browsers.

The public tracker bucket is not enough to enter a room. A tracker can introduce some random peer that noticed the BitTorrent-shaped traffic, but that peer still has to answer an HMAC challenge derived from the room secret in the invite link. That keeps the design small while making it effectively impossible in practice to brute-force or prank your way into someone else's room.

Manual invite and reply codes are the same WebRTC offer and answer exchange with the tracker removed. The host copies an invite code, the guest turns it into a reply code, and the host pastes that reply back. Any chat, email, QR code, terminal, or sticky note can be the signaling channel.

Flop is meant for lightweight, direct sharing, not hostile-network anonymity. Anyone with the invite link or manual codes should be treated as invited.

</details>

### Development

```bash
bun install
bun run dev
```

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

GitHub Pages is published by `.github/workflows/publish.yml`: every push to `main` installs, checks, typechecks, builds, and uploads `dist/` as a Pages artifact. In the GitHub repository settings, set Pages source to `GitHub Actions`; after that, pushes to `main` publish the HTTPS build.
