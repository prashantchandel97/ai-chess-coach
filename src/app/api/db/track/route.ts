import { NextResponse } from 'next/server';
import { getSql, ensureSchema } from '@/lib/db';

// POST /api/db/track — register a username so the daily cron picks it up
export async function POST(req: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ ok: false });

  try {
    const { username } = await req.json();
    if (!username) return NextResponse.json({ ok: false });

    await ensureSchema(sql);

    await sql`
      INSERT INTO tracked_users (username)
      VALUES (${username.toLowerCase()})
      ON CONFLICT (username) DO NOTHING
    `;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: e.message });
  }
}
