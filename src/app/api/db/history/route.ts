import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';

export async function GET(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ sessions: [] });

  try {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get('username');
    if (!username) return NextResponse.json({ sessions: [] });

    const rows = await sql`
      SELECT created_at, games_count, weaknesses
      FROM analysis_sessions
      WHERE username = ${username}
      ORDER BY created_at DESC
      LIMIT 10
    `;

    return NextResponse.json({ sessions: rows });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
