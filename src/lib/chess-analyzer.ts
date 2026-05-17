import { Chess } from 'chess.js';

export interface Game {
  pgn: string;
  url: string;
  eco?: string;
  white: { username: string; rating?: number };
  black: { username: string; rating?: number };
}

export interface ChessError {
  game_index: number;
  game_url: string;
  best_move: string; // UCI format e.g. "e2e4"
  move_number: number;
  phase: string;
  piece_moved: string;
  eval_before: number;
  eval_after: number;
  drop: number;
  type: string;
  fen: string;
  color: string;
}

export async function fetchGames(username: string, count: number): Promise<Game[]> {
  const archivesRes = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`);
  if (!archivesRes.ok) throw new Error('Failed to fetch user archives from Chess.com');
  const data = await archivesRes.json();
  const archives: string[] = data.archives.reverse();

  let allGames: Game[] = [];
  for (const archiveUrl of archives) {
    if (allGames.length >= count) break;

    const gamesRes = await fetch(archiveUrl);
    if (!gamesRes.ok) continue;
    const gamesData = await gamesRes.json();

    const sortedGames = gamesData.games.sort((a: any, b: any) => (b.end_time || 0) - (a.end_time || 0));

    for (const game of sortedGames) {
      if (game.rules === 'chess' && game.pgn) {
        allGames.push(game);
      }
      if (allGames.length >= count) break;
    }
  }

  return allGames;
}

export function evaluatePosition(fen: string, depth: number, stockfish: Worker): Promise<{ score: number; bestMove: string }> {
  return new Promise((resolve) => {
    let latestScore = 0;
    let bestMove = '';

    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (typeof msg === 'string') {
        const scoreMatch = msg.match(/score (cp|mate) (-?\d+)/);
        if (scoreMatch) {
          const type = scoreMatch[1];
          const val = parseInt(scoreMatch[2], 10);
          latestScore = type === 'mate' ? (val > 0 ? 10000 - val : -10000 - val) : val;
        }

        if (msg.startsWith('bestmove')) {
          const parts = msg.split(' ');
          bestMove = parts[1] === '(none)' ? '' : (parts[1] || '');
          stockfish.removeEventListener('message', handler);
          resolve({ score: latestScore, bestMove });
        }
      }
    };
    stockfish.addEventListener('message', handler);
    stockfish.postMessage(`position fen ${fen}`);
    stockfish.postMessage(`go depth ${depth}`);
  });
}

export async function analyzeGame(
  game: Game,
  username: string,
  stockfish: Worker,
  depth: number = 12,
  gameIndex: number = 0,
  onProgress?: (moveNum: number, totalMoves: number) => void
): Promise<ChessError[]> {
  const chess = new Chess();
  chess.loadPgn(game.pgn);

  const history = chess.history({ verbose: true });
  const errors: ChessError[] = [];
  const playerColor = game.white.username.toLowerCase() === username.toLowerCase() ? 'w' : 'b';

  const board = new Chess();
  let prevScore: number | null = null;

  // Disable opening book so Stockfish evaluates every position from scratch
  stockfish.postMessage('setoption name OwnBook value false');
  stockfish.postMessage('ucinewgame');

  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    const { score, bestMove } = await evaluatePosition(board.fen(), depth, stockfish);
    const normalizedScore = board.turn() === 'w' ? score : -score;

    if (prevScore !== null && move.color === playerColor) {
      const drop = playerColor === 'w' ? prevScore - normalizedScore : normalizedScore - prevScore;

      // Lower threshold in the opening (moves 1-20) to catch subtle positional errors
      const isOpening = i < 40; // half-moves, so 40 = move 20
      const threshold = isOpening ? 15 : 20;

      if (drop > threshold) {
        const fullMove = Math.floor(i / 2) + 1;
        const phase = i < 40 ? "opening" : i < 70 ? "middlegame" : "endgame";
        errors.push({
          game_index: gameIndex,
          game_url: game.url,
          best_move: bestMove,
          move_number: fullMove,
          phase,
          piece_moved: move.piece.toUpperCase(),
          eval_before: prevScore,
          eval_after: normalizedScore,
          drop: drop,
          type: drop > 200 ? "blunder" : drop > 100 ? "mistake" : "inaccuracy",
          fen: board.fen(),
          color: playerColor === 'w' ? "white" : "black"
        });
      }
    }

    prevScore = normalizedScore;
    board.move(move);
    if (onProgress) onProgress(i + 1, history.length);
  }

  return errors;
}

export function aggregateErrors(allErrors: ChessError[]) {
  // Phase-stratified sampling — guarantees opening errors always reach Claude
  // instead of always being buried below bigger middlegame/endgame blunders
  const byPhase = { opening: [] as ChessError[], middlegame: [] as ChessError[], endgame: [] as ChessError[] };
  allErrors.forEach(e => {
    const phase = e.phase as keyof typeof byPhase;
    if (byPhase[phase]) byPhase[phase].push(e);
  });
  const topPerPhase = (arr: ChessError[], n: number) =>
    [...arr].sort((a, b) => b.drop - a.drop).slice(0, n);

  const stratifiedErrors = [
    ...topPerPhase(byPhase.opening, 12),
    ...topPerPhase(byPhase.middlegame, 12),
    ...topPerPhase(byPhase.endgame, 6),
  ];

  const aggregated = {
    total_blunders: 0,
    total_mistakes: 0,
    errors_by_phase: {
      opening: { blunders: 0, mistakes: 0 },
      middlegame: { blunders: 0, mistakes: 0 },
      endgame: { blunders: 0, mistakes: 0 }
    },
    errors_by_piece: { R: 0, N: 0, B: 0, Q: 0, P: 0, K: 0 } as Record<string, number>,
    all_errors: stratifiedErrors,
  };

  allErrors.forEach(err => {
    if (err.type === 'blunder') aggregated.total_blunders++;
    if (err.type === 'mistake') aggregated.total_mistakes++;

    if (aggregated.errors_by_phase[err.phase as keyof typeof aggregated.errors_by_phase]) {
      if (err.type === 'blunder') aggregated.errors_by_phase[err.phase as keyof typeof aggregated.errors_by_phase].blunders++;
      if (err.type === 'mistake') aggregated.errors_by_phase[err.phase as keyof typeof aggregated.errors_by_phase].mistakes++;
    }

    if (aggregated.errors_by_piece[err.piece_moved] !== undefined) {
      aggregated.errors_by_piece[err.piece_moved]++;
    }
  });

  return aggregated;
}
