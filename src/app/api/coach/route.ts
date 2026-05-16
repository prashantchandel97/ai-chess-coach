import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { aggregatedData, rating, white_opening, black_opening } = body;

    const systemPrompt = `You are a chess coach with grandmaster-level knowledge. You speak directly and practically. You do not flatter. When you identify a weakness you name it precisely, explain why it keeps happening at the player's level, and give one concrete drill to fix it this week. Your output is always valid JSON.`;

    const userPromptTemplate = `I am a chess player rated ${rating || 'unknown'}. I play ${white_opening || 'any'} as white and ${black_opening || 'any'} as black.

You have analyzed my last recent games. Here is the aggregated error data:

${JSON.stringify(aggregatedData, null, 2)}

Identify my 3 most damaging recurring weaknesses. Ignore one-off blunders - focus only on patterns that appear across multiple games.

For each weakness return:
1. name: a plain 3-5 word label (e.g. 'rook activation in endgames')
2. diagnosis: 2-3 sentences explaining why this keeps happening and why it costs me games
3. example: the game number and move where this was clearest (infer from data if you can, or provide a generic structural example based on the data)
4. drill: one specific exercise I can do this week to fix it. Be concrete - name the tool, the position type, the number of reps.

Be brutal. Do not soften findings. Return ONLY valid JSON array, no preamble:
[{"name": "", "diagnosis": "", "example": "", "drill": ""}]`;

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: userPromptTemplate
      }]
    });

    const content = response.content[0];
    if (content.type === 'text') {
      let jsonText = content.text;
      
      // Attempt to clean up if Claude included markdown formatting
      if (jsonText.includes('\`\`\`json')) {
        jsonText = jsonText.split('\`\`\`json')[1].split('\`\`\`')[0];
      } else if (jsonText.includes('\`\`\`')) {
        jsonText = jsonText.split('\`\`\`')[1].split('\`\`\`')[0];
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
