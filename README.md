## 🌀 flop

Flop is a single-page browser room for conferencing directly over WebRTC with anyone who has an invite link: no account, meeting lobby, upload step, or storage server in the middle.

The whole interface is a strip of portraits: you, peers, and special utility portraits for connection or room actions, which keeps the implementation small and the room easy to scan.

A tiny Cloudflare Durable Object beacon helps the browsers find each other; if that stalls, manual invite and reply codes carry the same WebRTC setup through any channel you already have. Once inside the same room, browsers carry audio, video, notes, and files directly over their peer connection; no one else sees or stores the contents.

<details>
<summary>How It Works</summary>

Flop starts with the easy path: send an invite link, and the two browsers try to find each other through the same-origin rendezvous beacon at `/-/<discovery-id>`. If the beacon path stalls, the same WebRTC setup can be carried manually with copy-paste codes.

The invite link contains a random room secret. Browsers turn that secret into two separate values: a short public discovery id and an HMAC auth key. The Worker routes each discovery id to its own Durable Object beacon, and that object fans out WebRTC offers and answers between connected browsers. It stores no files, no room messages, and no room secret.

The discovery id is not enough to enter a room. When a peer reaches the room through the beacon, it still has to prove it knows the invite link's room secret by answering fresh HMAC challenges. That keeps the beacon small while making it effectively impossible in practice to brute-force or prank your way into someone else's room.

Manual invite and reply codes are the same WebRTC offer and answer exchange with the beacon removed. The host copies an invite code, the guest turns it into a reply code, and the host pastes that reply back. Any chat, email, QR code, terminal, or sticky note can be the signaling channel.

Flop is meant for lightweight, direct live rooms, not hostile-network anonymity. Anyone with the invite link or manual codes should be treated as invited.

</details>

### Development

It's a Vite/Solid app plus a Cloudflare Worker Durable Object beacon; the app owns the room UI and WebRTC state, while the Worker only handles `/-/*` rendezvous WebSockets. For UI-only work, run `bun run dev`; for invite-link testing, run `bun run dev:beacon` and `bun run dev` in separate terminals. Vite proxies `/-/*` WebSockets to Wrangler on `127.0.0.1:8787`, so local invite links keep the same same-origin shape as production.

Use `bun run sculpt` for UI fixtures, and `bun run check && bun run typecheck && bun run build` before shipping changes.

### Product

Flop was born from the frustration that a small live room usually turns into accounts, meeting links, paywalls, or an otherwise clunky experience. It is a thin skin over the browser's built-in WebRTC, meant to bring old phone-number simplicity to the web: know the secret, meet up. Enjoy responsibly.
