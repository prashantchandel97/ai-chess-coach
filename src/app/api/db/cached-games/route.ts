import { NextResponse } from 'next/server';
import { getSql, ensureSchema } from '@/lib/db';

export async function POST(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ cached: {} });

  try {
    const { username, gameUrls } = await req.json();
    await ensureSchema(sql);

    const rows = await sql`
      SELECT game_url, errors FROM analyzed_games
      WHERE username = ${username} AND game_url = ANY(${gameUrls})
    `;

    const cached: Record<string, unknown[]> = {};
    rows.forEach((r: any) => { cached[r.game_url] = r.errors; });
    return NextResponse.json({ cached });
  } catch {
    return NextResponse.json({ cached: {} });
  }
}
