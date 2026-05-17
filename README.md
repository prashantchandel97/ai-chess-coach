# AI Chess Coach

Grandmaster-level analysis of your recurring chess weaknesses, powered by Stockfish and Claude AI.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Claude](https://img.shields.io/badge/Claude-Sonnet_4.6-orange)
![Stockfish](https://img.shields.io/badge/Stockfish-WASM-green)

---

## What it does

1. **Fetches your recent games** from Chess.com via their public API
2. **Runs Stockfish (depth 14)** on every position to detect inaccuracies, mistakes and blunders (>20cp drop)
3. **Clusters errors into patterns** using Claude — groups similar mistakes across multiple games into 3 key weaknesses, each with up to 5 examples
4. **Interactive review board** — navigate the full game, then drag a piece to instantly enter play-on mode against Stockfish calibrated to your opponent's actual ELO
5. **Caches analysis in Neon PostgreSQL** — re-running never re-analyzes already-seen games

## Features

- **Live console** — real-time Stockfish progress per game
- **Arrow key navigation** in review mode (`←` / `→`)
- **Auto play-on** — drag any piece in review mode to instantly start playing from that position (no toggle)
- **Tutor mode** — compares your move to Stockfish's best after each move, with a hint button
- **Puzzle mode** — find the best move in the critical position before playing on
- **Session history** — past weakness patterns tracked per username (Neon DB + localStorage fallback)
- **Opening detection** — automatically identifies your most-played openings as White and Black

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 App Router |
| Language | TypeScript 5 |
| Chess logic | chess.js |
| Board UI | react-chessboard v5 |
| Engine | Stockfish.js (Web Worker, WASM) |
| AI coaching | Anthropic Claude Sonnet 4.6 |
| Database | Neon PostgreSQL (`@neondatabase/serverless`) |
| Styling | Custom CSS (no Tailwind) |
| Deployment | Vercel |

## Getting started

### Prerequisites

- Node.js 18+
- A [Chess.com](https://chess.com) account with recent games
- An [Anthropic API key](https://console.anthropic.com)
- A [Neon](https://neon.tech) database (optional — falls back to localStorage without it)

### Local setup

```bash
git clone https://github.com/prashantchandel97/ai-chess-coach.git
cd ai-chess-coach
npm install
```

Create `.env.local`:

```env
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

```bash
npm run dev
# Open http://localhost:3000
```

The DB schema (`analyzed_games` and `analysis_sessions` tables) is created automatically on the first analysis run.

### Deploying to Vercel

1. Push to GitHub
2. Import the repo in [Vercel](https://vercel.com)
3. Add environment variables:
   - `ANTHROPIC_API_KEY` — from Anthropic console
   - `DATABASE_URL` — pooled connection string from Neon dashboard
4. Deploy

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude coaching |
| `DATABASE_URL` | No | Neon PostgreSQL pooled connection string. Without it the app works fine but skips DB caching and history |

## How the analysis works

```
Chess.com API → fetch N recent games
       ↓
Neon DB cache check → skip already-analyzed games
       ↓
Stockfish (depth 14, Web Worker) → eval every position
       ↓
Drop > 200cp → blunder | > 100cp → mistake | > 20cp → inaccuracy
       ↓
Top 30 errors sent to Claude Sonnet 4.6
       ↓
Claude clusters into 3 weakness patterns with up to 5 examples each
       ↓
Results cached to Neon DB
```

## License

MIT
