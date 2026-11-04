# WebTalk

A chatting application with sound and camera support.

WebTalk is a small, self-hosted video chat: open the page, pick a name and a room, share the link, talk. Audio and video go peer-to-peer over WebRTC; a tiny Node.js server only introduces participants to each other and relays text chat.

## Features

- **Voice and video calls** for up to 8 people per room (full mesh, configurable)
- **Text chat** alongside the call, with unread badge
- **Screen sharing** (desktop browsers)
- **Mute / camera off**, with state shown to everyone; turning the camera off releases the device so the light goes off
- **Lobby preview** to check camera and mic before joining
- **Speaking indicator** around whoever is talking
- **Invite links** (`/?room=<name>`), random room names, no accounts
- Works without a camera or mic: you can still see, hear and chat
- Responsive layout for phones
- Automatic rejoin after a dropped connection, ICE restart on failed peer links

## Quick start

```bash
npm install
npm start
# open http://localhost:3000 in two tabs (or two devices)
```

Browsers only allow camera and microphone on **HTTPS or `localhost`**. To try it from a phone on your network, put it behind HTTPS (e.g. a reverse proxy, `cloudflared tunnel`, or `ngrok http 3000`).

### Docker

```bash
docker build -t webtalk .
docker run -p 3000:3000 webtalk
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_PEERS` | `8` | Max participants per room |
| `STUN_URLS` | Google public STUN | Comma-separated STUN URLs (empty string disables) |
| `TURN_URLS` | – | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | TURN credentials |

STUN is enough on most home networks. Behind strict corporate or mobile carrier NATs, peers may not reach each other without a TURN server (e.g. [coturn](https://github.com/coturn/coturn)).

## How it works

```
 Browser A ──┐                         ┌── Browser B
             │  socket.io (signaling,  │
             └────►  WebTalk server ◄──┘
                     chat, presence)
 Browser A ◄════════ WebRTC media ═════════► Browser B
```

- `server/index.js` — Express static server + Socket.IO. Events: `join`, `signal` (relayed only within the same room), `media-state`, `chat`, `leave`.
- `server/rooms.js` — in-memory room membership and validation.
- `public/app.js` — client. The newcomer creates one audio and one video transceiver per peer and sends the offer; existing members answer and attach their tracks. Mute, camera and screen share all use `replaceTrack`, so the first offer/answer is the only negotiation. Perfect-negotiation guards handle ICE restarts.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl/⌘ + D | Toggle microphone |
| Ctrl/⌘ + E | Toggle camera |
| Enter / Shift + Enter | Send message / new line |
| Esc | Close chat |

## Tests

```bash
npm test          # server unit + signaling integration tests
npm run test:e2e  # real calls in headless Chrome with fake devices
```

The E2E suite needs Chrome or Chromium (`CHROME_PATH=/path/to/chrome` if it isn't found automatically). It runs a three-person call and checks that video, audio, mute/camera state, chat and leaving propagate, plus a participant with no camera/mic.

## Limits

Mesh calls send your stream to every participant, so upload bandwidth grows with room size; 4–6 people is comfortable on typical connections. Rooms and chat history live in memory and disappear when the server restarts or everyone leaves.

## License

MIT
