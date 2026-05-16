import { NextResponse } from 'next/server';
import { getSql, ensureSchema } from '@/lib/db';

export async function POST(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ ok: false, reason: 'no db configured' });

  try {
    const { username, gamesCount, rating, weaknesses, gameErrors } = await req.json();
    await ensureSchema(sql);

    await sql`
      INSERT INTO analysis_sessions (username, games_count, rating, weaknesses)
      VALUES (${username}, ${gamesCount}, ${rating}, ${JSON.stringify(weaknesses)})
    `;

    for (const ge of (gameErrors ?? [])) {
      await sql`
        INSERT INTO analyzed_games
          (username, game_url, pgn, white_username, black_username, white_rating, black_rating, player_color, errors)
        VALUES
          (${username}, ${ge.url}, ${ge.pgn}, ${ge.white}, ${ge.black},
           ${ge.whiteRating ?? null}, ${ge.blackRating ?? null}, ${ge.playerColor}, ${JSON.stringify(ge.errors)})
        ON CONFLICT (username, game_url)
        DO UPDATE SET errors = EXCLUDED.errors, analyzed_at = NOW()
      `;
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('DB save error:', e);
    return NextResponse.json({ ok: false, reason: e.message });
  }
}
