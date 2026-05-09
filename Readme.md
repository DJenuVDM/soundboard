# 🎛️ Soundboard

A phone-controlled soundboard for Arch Linux / Hyprland, built on PipeWire. Run it on your PC, open the URL on your phone, and trigger sounds from anywhere in the room. No app installs, no dependencies beyond Node.js and ffmpeg — just a browser.

![Arch Linux](https://img.shields.io/badge/Arch_Linux-1793D1?style=flat&logo=arch-linux&logoColor=white)
![PipeWire](https://img.shields.io/badge/PipeWire-required-blue?style=flat)
![Node.js](https://img.shields.io/badge/Node.js-required-green?style=flat&logo=node.js)

---

## Features

- **Phone UI** — tap a button on your phone's browser to fire a sound on your PC instantly
- **Real-time sync** — WebSocket keeps all connected clients in sync; playing/stopped state updates everywhere
- **PipeWire integration** — creates named nodes (`Soundboard Output`, `Soundboard Mic [in/out]`) that show up in qpwgraph for flexible routing
- **Mic monitor toggle** — hear your own mic through your headset and mute/unmute it from your phone without affecting Discord or any other app
- **No npm dependencies** — server is a single vanilla Node.js file; WebSocket protocol is implemented from scratch
- **Fallback playback** — if the PipeWire sink node isn't ready, audio falls back to `ffplay` automatically
- **Hot reload** — press ↻ on the phone to pick up new sound files without restarting the server
- **Supports** `.mp3` `.wav` `.ogg` `.flac` `.aac` `.m4a` `.opus` `.weba` `.webm`

---

## Requirements

| Tool | Purpose |
|---|---|
| `node` | Runs the server |
| `ffmpeg` / `ffplay` | Audio decoding and playback |
| `pw-cat` | PipeWire sink node for sound output |
| `pw-loopback` | PipeWire loopback node for mic monitor |
| `wpctl` | Mic mute/unmute control |
| `pw-dump` | Node ID lookup for wpctl |
| `qpwgraph` | *(optional)* GUI for wiring nodes |

All of these are available in the Arch repos. The installer will handle `node` and `ffmpeg` automatically via `pacman`.

---

## Installation

```bash
git clone https://github.com/yourusername/soundboard.git
cd soundboard
bash install.sh
```

The installer will:
- Check for / install Node.js and ffmpeg via pacman
- Create `~/Music/soundboard/` as your sounds folder
- Add `soundboard`, `soundboard-update`, and `soundboard-uninstall` commands to `~/.local/bin`
- Create a `.desktop` entry so it's searchable in the KDE/Hyprland app launcher

> **Note:** Make sure `~/.local/bin` is in your `$PATH`. If it isn't, the installer will tell you what to add to your `.bashrc` / `.zshrc`.

---

## Usage

```bash
soundboard
```

The terminal will print your local IP addresses:

```
🎛️  Soundboard server running!

  Sounds folder : /home/you/Music/soundboard
  Local         : http://localhost:3000
  Phone (LAN)   : http://192.168.1.42:3000
```

Open the phone URL in your phone's browser and you're good to go. Drop audio files into the sounds folder and press ↻ to reload.

### Custom sounds folder or port

```bash
soundboard /path/to/sounds 8080
```

---

## PipeWire / qpwgraph setup

When the server starts it registers three named nodes in PipeWire:

### Soundboard Output
Carries all sound effect playback. Wire this in qpwgraph to wherever you want sounds to come out — your speakers, a virtual cable into Discord, OBS, etc.

```
[Soundboard Output] ──► [Headset / Virtual Cable / OBS]
```

### Soundboard Mic [in] & [out]
A loopback pair for mic monitoring. Wire your mic source into `[in]` and `[out]` to your headset so you can hear yourself. The **MIC** button on the phone mutes/unmutes the `[out]` node — this only affects what you hear in your headset. Discord connects directly to your system default mic and is completely unaffected.

```
[Microphone] ──► [Soundboard Mic [in]] ──► [Soundboard Mic [out]] ──► [Headset]
                                  │
                                  └──► [Discord] (system default — unaffected by mute)
```

---

## Phone UI

| Control | Action |
|---|---|
| Sound button | Play that sound (stops whatever was playing) |
| ⏹ | Stop the currently playing sound |
| **MIC OFF / MIC ON** | Toggle mic monitor to headset |
| ↻ | Reload the sound list from disk |

The "now playing" bar at the top shows what's currently active and syncs across all connected devices.

---

## Updating

```bash
soundboard-update
```

Pulls the latest changes from git, stops the server if it was running, and tells you to restart. Re-registers the `soundboard-update` command itself in case `update.sh` changed.

---

## Uninstalling

```bash
soundboard-uninstall
```

Removes the launcher commands and `.desktop` entry. Optionally removes your sounds folder too — it'll ask before touching it.

---

## File structure

```
soundboard/
├── server.js          # Node.js server — HTTP + WebSocket + PipeWire nodes
├── public/
│   └── index.html     # Phone UI (served to the browser)
├── install.sh         # First-time setup
├── update.sh          # Pull latest + restart
└── README.md
```

Sounds live outside the repo at `~/Music/soundboard/` by default so they don't get wiped on updates.

---

## How it works

The server speaks plain HTTP and implements the WebSocket protocol from scratch (no npm packages). When you tap a sound button:

1. The phone sends a WebSocket message (`{ type: "play", file: "..." }`)
2. The server spawns `ffmpeg` to decode the file to raw 48 kHz stereo PCM
3. That PCM is piped into the stdin of a persistent `pw-cat --playback` process (the `Soundboard Output` node)
4. All connected clients receive a `{ type: "playing" }` broadcast so their UI updates in sync

If the `pw-cat` sink isn't ready yet (e.g. still starting up), playback falls back to `ffplay` which spawns its own temporary PipeWire node.

The mic monitor uses `pw-loopback` instead of `pw-cat --record` because a loopback node is a real session-managed stream — `wpctl set-volume` actually gates the audio at the port level. Muting via `pw-cli Props` on a record node doesn't stop audio flowing through wired links, which is why earlier approaches didn't work.