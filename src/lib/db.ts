import { neon } from '@neondatabase/serverless';

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureSchema(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS analyzed_games (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      game_url TEXT NOT NULL,
      pgn TEXT,
      white_username TEXT,
      black_username TEXT,
      white_rating INTEGER,
      black_rating INTEGER,
      player_color TEXT,
      errors JSONB DEFAULT '[]',
      analyzed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(username, game_url)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analysis_sessions (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      games_count INTEGER,
      rating TEXT,
      weaknesses JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}
