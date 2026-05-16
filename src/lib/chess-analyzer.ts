import { Chess } from 'chess.js';

export interface Game {
  pgn: string;
  url: string;
  eco?: string;
  white: { username: string; rating?: number };
  black: { username: string; rating?: number };
}

export interface ChessError {
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
  const archives: string[] = data.archives.reverse(); // Most recent first
  
  let allGames: Game[] = [];
  for (const archiveUrl of archives) {
    if (allGames.length >= count) break;
    
    const gamesRes = await fetch(archiveUrl);
    if (!gamesRes.ok) continue;
    const gamesData = await gamesRes.json();
    
    // Sort games by end_time descending to get most recent
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

export function evaluatePosition(fen: string, depth: number, stockfish: Worker): Promise<number> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (typeof msg === 'string' && msg.startsWith('info depth ' + depth)) {
        // Parse score
        const scoreMatch = msg.match(/score (cp|mate) (-?\d+)/);
        if (scoreMatch) {
          const type = scoreMatch[1];
          const val = parseInt(scoreMatch[2], 10);
          stockfish.removeEventListener('message', handler);
          if (type === 'mate') {
            resolve(val > 0 ? 10000 - val : -10000 - val);
          } else {
            resolve(val); // centipawns
          }
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
  onProgress?: (moveNum: number, totalMoves: number) => void
): Promise<ChessError[]> {
  const chess = new Chess();
  chess.loadPgn(game.pgn);
  
  const history = chess.history({ verbose: true });
  const errors: ChessError[] = [];
  const playerColor = game.white.username.toLowerCase() === username.toLowerCase() ? 'w' : 'b';
  
  // Create a new board to replay the game
  const board = new Chess();
  let prevScore: number | null = null;
  
  // Setup Stockfish
  stockfish.postMessage('ucinewgame');
  
  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    
    // Check if it's the player's turn to evaluate their mistakes
    // Wait, the player makes a move, we want to know if their move caused a drop.
    // So we evaluate before the player moves, and after the player moves.
    // Actually, we can evaluate every position.
    const score = await evaluatePosition(board.fen(), depth, stockfish);
    
    // Normalize score to be from White's perspective
    // Stockfish score is from the perspective of the side to move
    const normalizedScore = board.turn() === 'w' ? score : -score;
    
    if (prevScore !== null && score !== null && move.color === playerColor) {
      // If white played, a bad move drops the normalized score.
      // If black played, a bad move increases the normalized score.
      const drop = playerColor === 'w' ? prevScore - normalizedScore : normalizedScore - prevScore;
      
      if (drop > 50) {
        errors.push({
          move_number: Math.floor(i / 2) + 1,
          phase: i < 30 ? "opening" : i < 70 ? "middlegame" : "endgame",
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
  const aggregated = {
    total_blunders: 0,
    total_mistakes: 0,
    errors_by_phase: {
      opening: { blunders: 0, mistakes: 0 },
      middlegame: { blunders: 0, mistakes: 0 },
      endgame: { blunders: 0, mistakes: 0 }
    },
    errors_by_piece: { R: 0, N: 0, B: 0, Q: 0, P: 0, K: 0 } as Record<string, number>,
    all_errors: allErrors
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
