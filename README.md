# 🎙️ LiveVoice

Real-time voice-to-text broadcasting. A **Speaker** talks into their mic on one
device, and the transcribed text appears **live (sub-second)** on a **Receiver**
device's screen — anywhere on the internet, not just the same network.

- Streams **word-by-word / phrase-by-phrase** (interim results shown immediately,
  then replaced by finalized text).
- **Multiple concurrent rooms** — each speaker/receiver pair is isolated.
- Speech-to-text runs **server-side** (Deepgram by default, AssemblyAI swappable),
  so it works across browsers — not just Chrome.
- **BYOK (bring your own key):** each speaker uses their *own* free Deepgram API
  key, entered once in their browser. The deployed server needs no key and
  never stores anyone's key. Receivers need nothing.
- **One deployable service**: Node + Express serves the web UI and the WebSocket
  relay together. No build step.

---

## How it works

```
Speaker browser ──mic PCM16 (WebSocket)──▶  Node/Express + ws  ──audio──▶  Deepgram/AssemblyAI
      ▲                                            │   ▲                         │
      └──────────── transcript events ─────────────┘   └──── transcripts ────────┘
                                                    │
Receiver browser ◀───────── transcript events ──────┘   (same room only)
```

- The browser captures mic audio with an `AudioWorklet`, converts it to
  **PCM16 @ 16 kHz**, and streams it over a WebSocket.
- The server pipes that audio to the configured **streaming STT provider** and
  relays `interim`/`final` transcript events to everyone in the room.
- Rooms are identified by short, unambiguous codes (e.g. `K7M2Q`) and a shareable
  link `/room/K7M2Q`.

---

## Project structure

```
livevoice/
├─ server/
│  ├─ index.js          # Express + WebSocket relay, room lifecycle
│  ├─ rooms.js          # in-memory room registry + code generation
│  └─ stt/
│     ├─ index.js       # provider factory (reads STT_PROVIDER)
│     ├─ deepgram.js    # Deepgram streaming provider
│     └─ assemblyai.js  # AssemblyAI streaming provider
├─ public/
│  ├─ index.html        # landing / mode select
│  ├─ speaker.html      # speaker UI
│  ├─ receiver.html     # receiver UI
│  ├─ css/style.css
│  └─ js/
│     ├─ pcm-worklet.js # mic capture -> PCM16 frames
│     ├─ speaker.js
│     ├─ receiver.js
│     └─ theme.js
├─ .env.example
├─ package.json
└─ README.md
```

---

## 1. Get an API key (speakers only)

Each **speaker** needs their own Deepgram key — pasted once into the speaker
page in the browser (verified live, kept in that browser + used in-memory for
the session; never stored on the server). **Receivers need nothing.**

1. Sign up at **https://console.deepgram.com/** (new accounts get free credit).
2. Go to **API Keys → Create a Key**.
3. Copy it — the speaker page will ask for it the first time.

---

## 2. Run locally

Requires **Node.js 18+**.

```bash
# from the livevoice/ folder
npm install
npm start                   # or: npm run dev  (auto-restart)
```

Open **http://localhost:3000**.

Optional: to skip the in-browser key prompt on your own machine, copy
`.env.example` to `.env` and set `DEEPGRAM_API_KEY` — a local-dev fallback only.

### Try it on one machine
1. Open **http://localhost:3000/speaker.html**, click **Start speaking**, allow the
   mic. Note the room code (e.g. `K7M2Q`).
2. In another tab/window, open **http://localhost:3000/room/K7M2Q** (or enter the
   code on the Receiver page).
3. Speak — text appears live in both tabs.

> `localhost` is treated as a secure context, so the mic works without HTTPS
> during local development.

### Try it across devices / the internet
Mic capture requires **HTTPS** on any non-localhost host. Easiest options:
- Deploy (below), or
- Use a tunnel: `npx localtunnel --port 3000` or `ngrok http 3000`, then open the
  **https** URL it gives you on both devices.

---

## 3. Switch STT provider

In `.env`:

```env
STT_PROVIDER=assemblyai        # or: deepgram
ASSEMBLYAI_API_KEY=...
```

No code changes needed — the provider is selected at runtime by the factory in
`server/stt/index.js`. Both providers consume the same PCM16 @ 16 kHz audio and
emit the same `{ text, isFinal }` events.

---

## 4. Deploy (single service)

Works on **Render**, **Railway**, or **Fly.io** — anywhere that runs a Node web
service and supports WebSockets (all three do).

**Common settings**
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: **none required** (BYOK — speakers bring their own
  keys). Optionally set `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE`.
- Do **not** set `PORT` manually if the platform injects it — the app reads
  `process.env.PORT`.

### Render (example)
1. Push this repo to GitHub.
2. New → **Web Service** → connect the repo.
3. Runtime: Node. Build: `npm install`. Start: `npm start`.
4. Add the env vars above. Deploy.
5. Open the `https://...onrender.com` URL. WebSockets and HTTPS work out of the box.

### Railway / Fly.io
Same idea: Node service, `npm start`, set the env vars. Fly needs a `fly.toml`
(`fly launch` generates one) with internal port `3000`.

---

## Configuration reference

All optional — speakers bring their own keys (BYOK).

| Variable            | Default   | Purpose                                              |
|---------------------|-----------|------------------------------------------------------|
| `STT_PROVIDER`      | `deepgram`| `deepgram` or `assemblyai`                            |
| `DEEPGRAM_API_KEY`  | —         | Local-dev fallback key (skips the in-browser prompt)  |
| `DEEPGRAM_MODEL`    | `nova-2`  | Deepgram model                                        |
| `DEEPGRAM_LANGUAGE` | `en-IN`   | Transcription language (English – India)              |
| `ASSEMBLYAI_API_KEY`| —         | AssemblyAI fallback key (only if provider = assemblyai) |
| `PORT`              | `3000`    | HTTP/WebSocket port                                   |

---

## Features checklist

- ✅ Sub-second live transcript (interim → final)
- ✅ Multiple isolated rooms, one-to-one (one speaker + one receiver each)
- ✅ Server-side STT relay, BYOK (each speaker's own key, never stored server-side), provider swappable by config
- ✅ Speaker + Receiver modes; shareable room code and `/room/CODE` link
- ✅ Auto-reconnect (exponential backoff) for both roles, room survives brief drops
- ✅ Mic permission / unsupported-browser / offline error states
- ✅ Mobile-responsive UI, pulsing **live** indicator on both screens
- ✅ Receiver font-size control, dark/light theme toggle
- ✅ Fully ephemeral — no transcripts stored server-side

---

## Notes & limits
- Transcripts are **not persisted** anywhere by design.
- One-to-one by design: a second receiver on the same room is rejected
  (`room_full`). To allow many viewers, change `receiver` to a `Set` in
  `server/rooms.js` and broadcast to all of them in `server/index.js`.
- STT usage is billed by your provider — the server stops streaming as soon as the
  speaker stops or disconnects.

## License
MIT
