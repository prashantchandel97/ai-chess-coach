import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { aggregatedData, rating, white_opening, black_opening } = body;

    const systemPrompt = `You are a chess coach. Return only valid JSON. Be brutal and concise.`;

    const userPrompt = `Player rated ${rating || 'unknown'}. Openings: ${white_opening || 'any'} (white), ${black_opening || 'any'} (black).

Error data (top 30 worst mistakes, each has game_index, move_number, fen, best_move in UCI format, drop in centipawns):
${JSON.stringify(aggregatedData, null, 2)}

Identify 3 recurring weakness PATTERNS. For each pattern, collect ALL errors from all_errors that fit it (up to 5 examples, sorted by drop desc).

Return ONLY this JSON (no preamble, no markdown):
[{"name":"3-5 word label","examples":[{"game":game_index,"move":move_number,"fen":"fen string","best_move":"uci e.g. e2e4"}],"tip":"one sentence max 12 words"}]`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const content = response.content[0];
    if (content.type === 'text') {
      let jsonText = content.text;
      if (jsonText.includes('```json')) {
        jsonText = jsonText.split('```json')[1].split('```')[0];
      } else if (jsonText.includes('```')) {
        jsonText = jsonText.split('```')[1].split('```')[0];
      }
      const weaknesses = JSON.parse(jsonText.trim());
      return NextResponse.json({ weaknesses });
    }

    throw new Error('Unexpected response type from Claude');

  } catch (error: any) {
    console.error("Error in coach API:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
