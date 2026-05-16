'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Chess } from 'chess.js';
import { X, ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';

type DraggingPieceDataType = { isSparePiece: boolean; position: string; pieceType: string };

const Chessboard = dynamic(() => import('react-chessboard').then(m => m.Chessboard), { ssr: false });

// ---------- Stockfish helpers ----------

function ratingToSkill(rating: number): { skill: number; depth: number } {
  const skill = Math.max(0, Math.min(20, Math.round((rating - 800) / 100)));
  return { skill, depth: Math.max(3, Math.min(15, skill + 3)) };
}

async function sfGetMove(fen: string, worker: Worker, skill: number, depth: number): Promise<string> {
  return new Promise(resolve => {
    const h = (e: MessageEvent) => {
      if (typeof e.data === 'string' && e.data.startsWith('bestmove')) {
        worker.removeEventListener('message', h);
        const p = e.data.split(' ');
        resolve(p[1] === '(none)' ? '' : p[1] || '');
      }
    };
    worker.addEventListener('message', h);
    worker.postMessage(`setoption name Skill Level value ${skill}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

async function sfGetBest(fen: string, worker: Worker): Promise<string> {
  return new Promise(resolve => {
    const h = (e: MessageEvent) => {
      if (typeof e.data === 'string' && e.data.startsWith('bestmove')) {
        worker.removeEventListener('message', h);
        const p = e.data.split(' ');
        resolve(p[1] === '(none)' ? '' : p[1] || '');
      }
    };
    worker.addEventListener('message', h);
    worker.postMessage('setoption name Skill Level value 20');
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth 14`);
  });
}

// ---------- Tutor ----------

type TutorType = 'excellent' | 'good' | 'inaccuracy' | 'hint' | 'info';
interface TutorMsg { text: string; type: TutorType }

const tutorColor: Record<TutorType, string> = {
  excellent: '#4ade80',
  good: '#86efac',
  inaccuracy: '#fbbf24',
  hint: '#60a5fa',
  info: '#64748b',
};

function tutorFeedback(uciPlayed: string, pendingBest: string, preFen: string, moveSan: string): TutorMsg {
  if (!pendingBest) return { text: `You played ${moveSan}.`, type: 'info' };
  if (uciPlayed.slice(0, 4) === pendingBest.slice(0, 4)) {
    return { text: `★ Best move! Exactly what Stockfish recommends.`, type: 'excellent' };
  }
  let bestSan = pendingBest.slice(0, 4);
  try {
    const tc = new Chess(preFen);
    const bm = tc.move({ from: pendingBest.slice(0, 2), to: pendingBest.slice(2, 4), promotion: (pendingBest[4] as any) || undefined });
    if (bm) bestSan = bm.san;
  } catch { /* fallback */ }
  return { text: `You played ${moveSan}. Stockfish preferred ${bestSan}.`, type: 'inaccuracy' };
}

// ---------- Move list ----------

interface MovePair {
  num: number;
  white?: { san: string; idx: number };
  black?: { san: string; idx: number };
}

interface ContinueMove { san: string; isPlayer: boolean; tutorMsg?: TutorMsg }

function MoveCell({ san, idx, curIdx, mistakeIdx, onClick }: {
  san?: string; idx?: number; curIdx: number; mistakeIdx: number; onClick: (i: number) => void;
}) {
  if (!san || idx === undefined) return <span className="py-0.5" />;
  const isCur = idx === curIdx, isMist = idx === mistakeIdx;
  return (
    <button id={`mv-${idx}`} onClick={() => onClick(idx)}
      style={{
        textAlign: 'left', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace',
        fontSize: '0.82rem', width: '100%', border: 'none', cursor: 'pointer', transition: 'all 0.1s',
        background: isCur ? '#3b82f6' : isMist ? 'rgba(239,68,68,0.18)' : 'transparent',
        color: isCur ? '#fff' : isMist ? '#fca5a5' : '#94a3b8',
        fontWeight: isCur ? 700 : 400,
      }}>
      {san}{isMist && !isCur ? <span style={{ color: '#f87171', fontSize: '0.7rem', marginLeft: 2 }}>!</span> : null}
    </button>
  );
}

// ---------- Props ----------

interface Props {
  fen: string;
  bestMove: string;
  playerColor: 'white' | 'black';
  weaknessName: string;
  tip: string;
  gameNum: number;
  moveNum: number;
  gamePgn: string;
  whitePlayer: string;
  blackPlayer: string;
  opponentRating?: number;
  onClose: () => void;
}

type Mode = 'review' | 'puzzle' | 'continue';

// ---------- Component ----------

export function ChessboardPanel({
  fen, bestMove, playerColor, weaknessName, tip,
  gameNum, moveNum, gamePgn, whitePlayer, blackPlayer,
  opponentRating = 1200, onClose,
}: Props) {

  const stockfishRef = useRef<Worker | null>(null);
  const isThinkingRef = useRef(false);
  const pendingBestRef = useRef('');
  const preMoveChessFenRef = useRef('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    stockfishRef.current = new Worker('/stockfish.js');
    stockfishRef.current.postMessage('uci');
    return () => stockfishRef.current?.terminate();
  }, []);

  const { skill, depth: sfDepth } = ratingToSkill(opponentRating);

  // Parse PGN → precompute all positions
  const { allMoves, positions } = useMemo(() => {
    const p = new Chess(); try { p.loadPgn(gamePgn); } catch { /* ok */ }
    const moves = p.history({ verbose: true });
    const r = new Chess(); const fens = [r.fen()];
    for (const m of moves) { r.move(m); fens.push(r.fen()); }
    return { allMoves: moves, positions: fens };
  }, [gamePgn]);

  const mistakeIdx = useMemo(() => {
    const i = (moveNum - 1) * 2 + (playerColor === 'black' ? 1 : 0);
    return Math.min(i, Math.max(0, positions.length - 1));
  }, [moveNum, playerColor, positions.length]);

  // Mode
  const [mode, setMode] = useState<Mode>('review');
  const [tutorEnabled, setTutorEnabled] = useState(true);

  // Review
  const [curIdx, setCurIdx] = useState(mistakeIdx);

  // Puzzle
  const puzzleChessRef = useRef(new Chess(fen));
  const [puzzleFen, setPuzzleFen] = useState(fen);
  const [puzzleFeedback, setPuzzleFeedback] = useState<'idle' | 'correct' | 'wrong'>('idle');
  const [puzzleAttempts, setPuzzleAttempts] = useState(0);
  const [puzzleSolved, setPuzzleSolved] = useState(false);

  // Continue
  const continueChessRef = useRef<Chess | null>(null);
  const [continueFen, setContinueFen] = useState('');
  const [continueMovelist, setContinueMovelist] = useState<ContinueMove[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameResult, setGameResult] = useState('');
  const [tutorMsg, setTutorMsg] = useState<TutorMsg | null>(null);

  const bestFrom = bestMove.slice(0, 2);
  const bestTo = bestMove.slice(2, 4);
  const actualMoveSan = allMoves[mistakeIdx]?.san ?? '?';
  const atMistake = curIdx === mistakeIdx;

  const continueListRef = useRef<HTMLDivElement>(null);
  const moveListRef = useRef<HTMLDivElement>(null);

  // Scroll move list
  useEffect(() => { document.getElementById(`mv-${curIdx}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [curIdx]);
  useEffect(() => { continueListRef.current?.scrollTo({ top: continueListRef.current.scrollHeight, behavior: 'smooth' }); }, [continueMovelist]);

  // Pre-fetch Stockfish best when player's turn in continue mode
  useEffect(() => {
    const chess = continueChessRef.current;
    if (mode !== 'continue' || !chess || isThinkingRef.current || gameOver) return;
    const isPlayerTurn = (playerColor === 'white') === (chess.turn() === 'w');
    if (!isPlayerTurn || !stockfishRef.current) return;
    pendingBestRef.current = '';
    preMoveChessFenRef.current = chess.fen();
    sfGetBest(chess.fen(), stockfishRef.current).then(best => { pendingBestRef.current = best; });
  }, [continueFen, mode, playerColor, gameOver]);

  // Arrow key navigation in review mode
  useEffect(() => {
    if (mode !== 'review') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setCurIdx(i => Math.max(0, i - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setCurIdx(i => Math.min(positions.length - 1, i + 1)); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, positions.length]);

  // ---- Review navigation ----
  function goTo(idx: number) {
    setCurIdx(Math.max(0, Math.min(idx, positions.length - 1)));
    if (mode !== 'review') setMode('review');
  }

  // ---- Unified continue mode initializer ----
  const initContinueMode = useCallback(async (chess: Chess, initialMoves: ContinueMove[]) => {
    if (isThinkingRef.current) return;

    continueChessRef.current = chess;
    setContinueFen(chess.fen());
    setContinueMovelist(initialMoves);
    setGameOver(false);
    setGameResult('');
    setTutorMsg({ text: `Play on — Stockfish plays at ${opponentRating} ELO (Skill ${skill}).`, type: 'info' });
    setMode('continue');

    if (chess.isGameOver()) {
      setGameOver(true);
      setGameResult(chess.isCheckmate() ? 'Checkmate!' : 'Draw');
      return;
    }

    const isOpponentTurn = (playerColor === 'white') === (chess.turn() === 'b') ||
                           (playerColor === 'black') === (chess.turn() === 'w');

    if (isOpponentTurn && stockfishRef.current) {
      isThinkingRef.current = true;
      setIsThinking(true);
      const uci = await sfGetMove(chess.fen(), stockfishRef.current, skill, sfDepth);
      if (uci && continueChessRef.current) {
        const m = continueChessRef.current.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as any) || undefined });
        if (m) {
          setContinueFen(continueChessRef.current.fen());
          setContinueMovelist(prev => [...prev, { san: m.san, isPlayer: false }]);
          if (continueChessRef.current.isGameOver()) {
            setGameOver(true);
            setGameResult(continueChessRef.current.isCheckmate() ? 'Checkmate!' : 'Draw');
          }
        }
      }
      isThinkingRef.current = false;
      setIsThinking(false);
    }
  }, [opponentRating, playerColor, skill, sfDepth]);

  // ---- Puzzle ----
  function handlePuzzleDrop({ piece, sourceSquare, targetSquare }: { piece: DraggingPieceDataType; sourceSquare: string; targetSquare: string | null }): boolean {
    if (puzzleSolved || !targetSquare) return false;
    try {
      const pt = piece.pieceType.toLowerCase();
      const isPromo = pt[1] === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1');
      const move = puzzleChessRef.current.move({ from: sourceSquare, to: targetSquare, promotion: isPromo ? 'q' : undefined });
      if (!move) return false;
      setPuzzleAttempts(a => a + 1);
      setPuzzleFen(puzzleChessRef.current.fen());
      if (sourceSquare === bestFrom && targetSquare === bestTo) {
        setPuzzleFeedback('correct');
        setPuzzleSolved(true);
      } else {
        setPuzzleFeedback('wrong');
        setTimeout(() => { puzzleChessRef.current.undo(); setPuzzleFen(fen); setPuzzleFeedback('idle'); }, 1200);
      }
      return true;
    } catch { return false; }
  }

  // ---- Review drag → auto play-on ----
  function handleReviewDrop({ piece, sourceSquare, targetSquare }: { piece: DraggingPieceDataType; sourceSquare: string; targetSquare: string | null }): boolean {
    if (!targetSquare || isThinkingRef.current) return false;
    try {
      const chess = new Chess(positions[curIdx]);
      const isPlayerTurn = (playerColor === 'white') === (chess.turn() === 'w');
      if (!isPlayerTurn) return false;
      const pt = piece.pieceType.toLowerCase();
      const isPromo = pt[1] === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1');
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: isPromo ? 'q' : undefined });
      if (!move) return false;
      initContinueMode(chess, [{ san: move.san, isPlayer: true }]);
      return true;
    } catch { return false; }
  }

  // ---- Continue drop ----
  function handleContinueDrop({ piece, sourceSquare, targetSquare }: { piece: DraggingPieceDataType; sourceSquare: string; targetSquare: string | null }): boolean {
    const chess = continueChessRef.current;
    if (!chess || isThinkingRef.current || gameOver || !targetSquare) return false;
    const isPlayerTurn = (playerColor === 'white') === (chess.turn() === 'w');
    if (!isPlayerTurn) return false;
    try {
      const pt = piece.pieceType.toLowerCase();
      const isPromo = pt[1] === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1');
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: isPromo ? 'q' : undefined });
      if (!move) return false;

      setContinueFen(chess.fen());
      setContinueMovelist(prev => [...prev, { san: move.san, isPlayer: true }]);

      if (chess.isGameOver()) {
        setGameOver(true);
        setGameResult(chess.isCheckmate() ? 'Checkmate!' : chess.isDraw() ? 'Draw' : 'Game over');
        return true;
      }

      const capturedUci = sourceSquare + targetSquare;
      const capturedMoveSan = move.san;
      const capturedPendingBest = pendingBestRef.current;
      const capturedPreFen = preMoveChessFenRef.current;
      const capturedTutor = tutorEnabled;
      const sf = stockfishRef.current;

      isThinkingRef.current = true;
      setIsThinking(true);

      (async () => {
        if (capturedTutor && capturedPendingBest) {
          const msg = tutorFeedback(capturedUci, capturedPendingBest, capturedPreFen, capturedMoveSan);
          setTutorMsg(msg);
          setContinueMovelist(prev => {
            const list = [...prev];
            const li = list.length - 1;
            if (li >= 0 && list[li].isPlayer) list[li] = { ...list[li], tutorMsg: msg };
            return list;
          });
        }
        if (sf && continueChessRef.current) {
          const uci = await sfGetMove(continueChessRef.current.fen(), sf, skill, sfDepth);
          const c = continueChessRef.current;
          if (uci && c) {
            const om = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as any) || undefined });
            if (om) {
              setContinueFen(c.fen());
              setContinueMovelist(prev => [...prev, { san: om.san, isPlayer: false }]);
              if (c.isGameOver()) {
                setGameOver(true);
                setGameResult(c.isCheckmate() ? 'Checkmate!' : 'Draw');
              }
            }
          }
        }
        isThinkingRef.current = false;
        setIsThinking(false);
      })();

      return true;
    } catch { return false; }
  }

  // Board options
  const puzzleStyles: Record<string, React.CSSProperties> = {};
  if (mode === 'puzzle' && puzzleAttempts >= 2 && !puzzleSolved)
    puzzleStyles[bestFrom] = { background: 'rgba(59,130,246,0.35)', borderRadius: '50%' };

  let boardOptions: any;
  if (mode === 'puzzle') {
    boardOptions = { position: puzzleFen, boardOrientation: playerColor, squareStyles: puzzleStyles, allowDragging: !puzzleSolved, onPieceDrop: handlePuzzleDrop };
  } else if (mode === 'continue') {
    boardOptions = { position: continueFen, boardOrientation: playerColor, allowDragging: !isThinking && !gameOver, onPieceDrop: handleContinueDrop };
  } else {
    // Review mode: allow dragging — any valid move auto-enters play-on
    boardOptions = { position: positions[curIdx], boardOrientation: playerColor, allowDragging: true, onPieceDrop: handleReviewDrop };
  }

  // Move pairs for review list
  const movePairs: MovePair[] = [];
  allMoves.forEach((m, i) => {
    const p = Math.floor(i / 2);
    if (!movePairs[p]) movePairs[p] = { num: p + 1 };
    if (m.color === 'w') movePairs[p].white = { san: m.san, idx: i + 1 };
    else movePairs[p].black = { san: m.san, idx: i + 1 };
  });

  // ---- Render ----
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(12px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', overflowY: 'auto' }}>
      <div style={{ background: 'linear-gradient(150deg,#0b1120 0%,#080d1a 100%)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '1.25rem', padding: '1.375rem', width: '100%', maxWidth: '920px', boxShadow: '0 32px 80px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.05) inset' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', gap: '0.75rem' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '4px' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)', padding: '2px 8px', borderRadius: '9999px' }}>Weakness</span>
              <span style={{ fontWeight: 900, color: '#f1f5f9', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{weaknessName}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', border: '1px solid #64748b', display: 'inline-block' }} />
                <span style={{ color: '#fff', fontWeight: 700 }}>{whitePlayer}</span>
              </span>
              <span style={{ color: '#334155', fontSize: '0.7rem' }}>vs</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#1e293b', border: '1px solid #64748b', display: 'inline-block' }} />
                <span style={{ color: '#cbd5e1', fontWeight: 700 }}>{blackPlayer}</span>
                <span style={{ color: '#334155', fontSize: '0.7rem' }}>({opponentRating})</span>
              </span>
              <span style={{ color: '#334155', fontSize: '0.7rem' }}>· Game {gameNum + 1}</span>
            </div>
          </div>

          {/* Mode tabs + tutor toggle + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, flexWrap: 'wrap' }}>
            {(['review', 'puzzle'] as Mode[]).map(m => (
              <button key={m} onClick={() => setMode(m)} style={{ fontSize: '0.72rem', padding: '4px 12px', borderRadius: '9999px', fontWeight: 700, border: 'none', cursor: 'pointer', transition: 'all 0.15s', background: mode === m ? '#3b82f6' : 'rgba(30,41,59,0.8)', color: mode === m ? '#fff' : '#64748b' }}>
                {m === 'review' ? '📖 Review' : '🧩 Puzzle'}
              </button>
            ))}
            {puzzleSolved && (
              <button onClick={() => initContinueMode(new Chess(puzzleFen), [])} style={{ fontSize: '0.72rem', padding: '4px 12px', borderRadius: '9999px', fontWeight: 700, border: 'none', cursor: 'pointer', transition: 'all 0.15s', background: mode === 'continue' ? '#059669' : 'rgba(6,78,59,0.5)', color: mode === 'continue' ? '#fff' : '#34d399' }}>
                ▶ Play On
              </button>
            )}
            <button onClick={() => setTutorEnabled(t => !t)} title="Toggle tutor" style={{ fontSize: '0.72rem', padding: '4px 10px', borderRadius: '9999px', fontWeight: 700, border: `1px solid ${tutorEnabled ? 'rgba(245,158,11,0.35)' : 'rgba(255,255,255,0.06)'}`, cursor: 'pointer', background: tutorEnabled ? 'rgba(245,158,11,0.1)' : 'rgba(15,23,42,0.5)', color: tutorEnabled ? '#fbbf24' : '#334155', transition: 'all 0.15s' }}>
              🎓 {tutorEnabled ? 'Tutor ON' : 'Tutor OFF'}
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', padding: '4px', lineHeight: 1 }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ── Main grid ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 210px', gap: '14px' }}>

          {/* Left: board + controls */}
          <div>
            <div style={{ borderRadius: '12px', overflow: 'hidden', marginBottom: '10px', boxShadow: '0 12px 36px rgba(0,0,0,0.6)' }}>
              <Chessboard options={boardOptions} />
            </div>

            {/* Review nav */}
            {mode === 'review' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '10px' }}>
                  <button onClick={() => goTo(0)} className="nav-btn">⏮</button>
                  <button onClick={() => goTo(curIdx - 1)} disabled={curIdx === 0} className="nav-btn"><ChevronLeft size={14} /></button>
                  <span style={{ flex: 1, textAlign: 'center', fontSize: '0.72rem', color: '#475569' }}>
                    {curIdx === 0 ? 'Start' : `Move ${Math.ceil(curIdx / 2)} · ${curIdx % 2 === 1 ? 'White' : 'Black'}`}
                    <span style={{ color: '#1e293b', marginLeft: '6px', fontSize: '0.65rem' }}>← → to navigate · drag to play</span>
                  </span>
                  <button onClick={() => goTo(curIdx + 1)} disabled={curIdx >= positions.length - 1} className="nav-btn"><ChevronRight size={14} /></button>
                  <button onClick={() => goTo(positions.length - 1)} className="nav-btn">⏭</button>
                </div>
                {atMistake && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                    <div style={{ borderRadius: '10px', padding: '10px 12px', textAlign: 'center', background: 'rgba(127,29,29,0.22)', border: '1px solid rgba(239,68,68,0.22)' }}>
                      <div style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#fca5a5', marginBottom: '4px' }}>You played</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.6rem', color: '#fff' }}>{actualMoveSan}</div>
                    </div>
                    <div style={{ borderRadius: '10px', padding: '10px 12px', textAlign: 'center', background: 'rgba(6,78,59,0.22)', border: '1px solid rgba(34,197,94,0.22)' }}>
                      <div style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#86efac', marginBottom: '4px' }}>Best move</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.6rem', color: '#fff' }}>{bestFrom}{bestTo}</div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Puzzle status */}
            {mode === 'puzzle' && (
              <div style={{ borderRadius: '10px', padding: '10px 14px', textAlign: 'center', fontSize: '0.85rem', marginBottom: '10px', fontWeight: puzzleSolved ? 700 : 400, background: puzzleSolved ? 'rgba(6,78,59,0.22)' : puzzleFeedback === 'wrong' ? 'rgba(127,29,29,0.22)' : 'rgba(15,23,42,0.5)', border: `1px solid ${puzzleSolved ? 'rgba(34,197,94,0.28)' : puzzleFeedback === 'wrong' ? 'rgba(239,68,68,0.28)' : 'rgba(255,255,255,0.05)'}`, color: puzzleSolved ? '#4ade80' : puzzleFeedback === 'wrong' ? '#f87171' : '#475569' }}>
                {puzzleSolved ? `✓ Correct! ${bestFrom}${bestTo} was the best move. Hit "Play On" to continue.` : puzzleFeedback === 'wrong' ? `✗ Not quite.${puzzleAttempts >= 2 ? ' Hint: blue square.' : ' Try again.'}` : `Find the best move for ${playerColor}.`}
              </div>
            )}

            {/* Continue status */}
            {mode === 'continue' && (
              <div style={{ marginBottom: '10px' }}>
                {isThinking && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderRadius: '8px', fontSize: '0.8rem', background: 'rgba(15,23,42,0.6)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.15)' }}>
                    <span className="animate-spin" style={{ display: 'inline-block' }}>⚙</span>
                    Stockfish thinking... ({opponentRating} ELO, depth {sfDepth})
                  </div>
                )}
                {gameOver && (
                  <div style={{ padding: '10px', borderRadius: '10px', textAlign: 'center', fontWeight: 800, fontSize: '1rem', background: 'rgba(30,41,59,0.8)', color: '#f1f5f9', border: '1px solid rgba(255,255,255,0.1)' }}>
                    {gameResult}
                  </div>
                )}
                {tutorEnabled && tutorMsg && !isThinking && !gameOver && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 12px', borderRadius: '8px', fontSize: '0.8rem', background: 'rgba(15,23,42,0.6)', border: `1px solid ${tutorColor[tutorMsg.type]}30`, color: tutorColor[tutorMsg.type] }}>
                    <span>🎓</span><span>{tutorMsg.text}</span>
                  </div>
                )}
              </div>
            )}

            {/* Tip */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '9px 12px', borderRadius: '10px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.12)' }}>
              <Lightbulb size={13} style={{ color: '#f59e0b', marginTop: 2, flexShrink: 0 }} />
              <span style={{ color: '#fcd34d', fontSize: '0.8rem', lineHeight: 1.5 }}>{tip}</span>
            </div>
          </div>

          {/* Right: move list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {mode !== 'continue' ? (
              <>
                <div style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#334155' }}>Game History</div>
                <div ref={moveListRef} style={{ background: 'rgba(8,12,22,0.8)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '8px', overflowY: 'auto', maxHeight: '420px', flex: 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: '1px' }}>
                    {movePairs.map(pair => (
                      <div key={pair.num} style={{ display: 'contents' }}>
                        <span style={{ textAlign: 'right', paddingRight: '4px', color: '#1e293b', fontSize: '0.72rem', lineHeight: '1.7', userSelect: 'none' }}>{pair.num}.</span>
                        <MoveCell san={pair.white?.san} idx={pair.white?.idx} curIdx={curIdx} mistakeIdx={mistakeIdx} onClick={goTo} />
                        <MoveCell san={pair.black?.san} idx={pair.black?.idx} curIdx={curIdx} mistakeIdx={mistakeIdx} onClick={goTo} />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#334155' }}>Continuation</div>
                <div style={{ fontSize: '0.65rem', color: '#1e293b' }}>SF skill {skill} · depth {sfDepth} · {opponentRating} ELO</div>
                <div ref={continueListRef} style={{ background: 'rgba(8,12,22,0.8)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px', overflowY: 'auto', maxHeight: '300px', flex: 1 }}>
                  {continueMovelist.length === 0
                    ? <div style={{ color: '#1e293b', fontSize: '0.75rem', textAlign: 'center', padding: '16px 0' }}>Moves appear here</div>
                    : continueMovelist.map((m, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700, color: m.isPlayer ? '#60a5fa' : '#64748b' }}>{m.san}</span>
                        {m.tutorMsg && tutorEnabled && (
                          <span style={{ fontSize: '0.7rem', color: tutorColor[m.tutorMsg.type] }}>
                            {m.tutorMsg.type === 'excellent' ? '★' : m.tutorMsg.type === 'good' ? '✓' : '?!'}
                          </span>
                        )}
                      </div>
                    ))
                  }
                </div>
                {tutorEnabled && !isThinking && !gameOver && (
                  <button
                    onClick={() => { if (pendingBestRef.current) setTutorMsg({ text: `Hint: consider ${pendingBestRef.current.slice(0,2)}→${pendingBestRef.current.slice(2,4)}`, type: 'hint' }); }}
                    style={{ fontSize: '0.75rem', padding: '6px 12px', borderRadius: '8px', fontWeight: 700, border: '1px solid rgba(59,130,246,0.2)', background: 'rgba(59,130,246,0.08)', color: '#60a5fa', cursor: 'pointer', transition: 'all 0.15s' }}
                  >
                    💡 Get Hint
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
