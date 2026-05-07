# Stories of the Masters — Tales & Parables of Sri Ramakrishna

A static, installable Progressive Web App for reading 201 parables of Sri Ramakrishna with companion audio narration in a male English voice.

🌐 **Live:** https://story-website-lemon.vercel.app

## Features

- **201 cleaned stories** — Tales & Parables of Sri Ramakrishna (Sri Ramakrishna Math, Chennai), passed through DeepSeek to remove PDF artifacts (footnote injections, page-headers, OCR errors) while preserving original wording.
- **Reader-mode typography** — Cormorant Garamond + Crimson Pro, generous spacing, drop caps, justified body, dark/light themes.
- **PWA** — installable on iOS/macOS/Android via "Add to Home Screen". Manifest, service worker, offline support.
- **Audio narration** — every story narrated by Sarvam's `bulbul:v3` (voice: aditya, en-IN, male). Player has scrub, speed (0.85× → 2×), and a continuous-play toggle that auto-advances between stories.
- **Bookmarks** — anonymous bookmarks via localStorage, optional sign-up that syncs across devices (Express + SQLite + bcrypt session cookies — works locally, not on Vercel's serverless functions).
- **Search** — full-text search across titles and bodies.
- **Random parable** button.

## Run locally

```sh
npm install
npm start         # http://localhost:3030
```

The Node server (`server.js`) handles auth + bookmarks. Without it, the static files in this directory work standalone — open `index.html` and bookmarks fall back to localStorage.

## Project layout

```
.
├── index.html              The whole frontend — single-file static SPA
├── stories.json            201 cleaned stories
├── audio/                  Per-story MP3s (story-1.mp3 … story-201.mp3)
├── audio_manifest.json     Index of which audio files exist
├── icons/                  PWA icons (192/512 + maskable + apple-touch)
├── manifest.webmanifest    PWA manifest
├── sw.js                   Service worker (cache-first for static, no-cache for /api)
├── server.js               Express + better-sqlite3 + bcrypt (local-only)
├── scripts/
│   └── generate_audio.py   Sarvam TTS generator (chunks long stories, joins via ffmpeg)
├── package.json
└── vercel.json             Static-only deploy config + cache headers
```

## Tech notes

- **Why single-file frontend?** Stories are <500KB, the whole index loads instantly, hash-routing means no build step. The PWA caches it after the first visit.
- **Audio chunking** — Sarvam caps inputs at 2,500 chars per call. The generator splits longer stories at paragraph then sentence boundaries, then re-encodes the joined wavs to 64 kbps mono mp3 with ffmpeg.
- **Auth on Vercel** — `better-sqlite3` requires a persistent disk, which Vercel functions don't provide. To run auth on Vercel, port the routes to a hosted Postgres (Neon) or Vercel KV.

## Source

Stories are from *Tales and Parables of Sri Ramakrishna*, Sri Ramakrishna Math, Chennai. Public-domain hagiographic literature.
