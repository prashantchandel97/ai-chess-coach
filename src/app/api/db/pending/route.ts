import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';

// GET /api/db/pending?username=X  → pending game count + PGNs
export async function GET(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ count: 0, games: [] });

  try {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get('username');
    if (!username) return NextResponse.json({ count: 0, games: [] });

    const rows = await sql`
      SELECT game_url, pgn, end_time FROM pending_games
      WHERE username = ${username}
      ORDER BY end_time DESC
    `;

    return NextResponse.json({ count: rows.length, games: rows });
  } catch {
    return NextResponse.json({ count: 0, games: [] });
  }
}

// DELETE /api/db/pending  → clear pending after analysis
export async function DELETE(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ ok: false });

  try {
    const { username } = await req.json();
    if (!username) return NextResponse.json({ ok: false });

    await sql`DELETE FROM pending_games WHERE username = ${username}`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
