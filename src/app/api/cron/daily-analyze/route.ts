import { NextResponse } from 'next/server';
import { getSql, ensureSchema } from '@/lib/db';

// Vercel calls this daily. Protected by CRON_SECRET env var.
// It only fetches + queues new game PGNs — Stockfish stays client-side.

export const maxDuration = 60;

async function fetchLatestGames(username: string, count = 10) {
  try {
    const archivesRes = await fetch(
      `https://api.chess.com/pub/player/${username}/games/archives`,
      { headers: { 'User-Agent': 'ai-chess-coach/1.0' }, next: { revalidate: 0 } }
    );
    if (!archivesRes.ok) return [];
    const { archives } = await archivesRes.json();
    const recentArchive = archives[archives.length - 1];
    if (!recentArchive) return [];

    const gamesRes = await fetch(recentArchive, { next: { revalidate: 0 } });
    if (!gamesRes.ok) return [];
    const { games } = await gamesRes.json();

    return (games as any[])
      .filter(g => g.rules === 'chess' && g.pgn)
      .sort((a, b) => (b.end_time || 0) - (a.end_time || 0))
      .slice(0, count);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sql = getSql();
  if (!sql) return NextResponse.json({ skipped: true, reason: 'no db' });

  try {
    await ensureSchema(sql);

    // Get all tracked users
    const users = await sql`SELECT username FROM tracked_users ORDER BY last_fetched ASC NULLS FIRST`;
    if (users.length === 0) return NextResponse.json({ ok: true, queued: 0, users: 0 });

    let totalQueued = 0;

    for (const { username } of users) {
      // Fetch their recent games from Chess.com
      const games = await fetchLatestGames(username, 10);
      if (games.length === 0) continue;

      // Find which ones are already analyzed
      const urls = games.map((g: any) => g.url);
      const analyzed = await sql`
        SELECT game_url FROM analyzed_games
        WHERE username = ${username} AND game_url = ANY(${urls})
      `;
      const analyzedUrls = new Set(analyzed.map((r: any) => r.game_url));

      // Queue only the new ones
      const newGames = games.filter((g: any) => !analyzedUrls.has(g.url));
      for (const game of newGames) {
        await sql`
          INSERT INTO pending_games (username, game_url, pgn, end_time)
          VALUES (${username}, ${game.url}, ${game.pgn}, ${game.end_time ?? null})
          ON CONFLICT (username, game_url) DO NOTHING
        `;
        totalQueued++;
      }

      // Update last_fetched timestamp
      await sql`
        UPDATE tracked_users SET last_fetched = NOW() WHERE username = ${username}
      `;
    }

    return NextResponse.json({ ok: true, queued: totalQueued, users: users.length });
  } catch (e: any) {
    console.error('Cron error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
