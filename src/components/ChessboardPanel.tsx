'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Chess } from 'chess.js';
import { X, ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';

type DraggingPieceDataType = { isSparePiece: boolean; position: string; pieceType: string };

const Chessboard = dynamic(() => import('react-chessboard').then(m => m.Chessboard), { ssr: false });

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
  onClose: () => void;
}

interface MovePair {
  num: number;
  white?: { san: string; idx: number };
  black?: { san: string; idx: number };
}

function MoveCell({ san, idx, curIdx, mistakeIdx, onClick }: {
  san?: string; idx?: number; curIdx: number; mistakeIdx: number;
  onClick: (idx: number) => void;
}) {
  if (!san || idx === undefined) return <span className="py-0.5" />;
  const isCurrent = idx === curIdx;
  const isMistake = idx === mistakeIdx;
  return (
    <button
      id={`move-${idx}`}
      onClick={() => onClick(idx)}
      className={`text-left px-1.5 py-0.5 rounded transition-colors font-mono text-sm w-full ${
        isCurrent
          ? 'bg-primary text-white font-bold'
          : isMistake
          ? 'bg-red-900/50 text-red-300 hover:bg-red-800/60'
          : 'text-slate-300 hover:bg-slate-700/50'
      }`}
    >
      {san}{isMistake && !isCurrent ? <span className="ml-0.5 text-red-400 text-xs">!</span> : null}
    </button>
  );
}

export function ChessboardPanel({
  fen, bestMove, playerColor, weaknessName, tip,
  gameNum, moveNum, gamePgn, whitePlayer, blackPlayer, onClose,
}: Props) {

  // Parse PGN and precompute all positions once
  const { allMoves, positions } = useMemo(() => {
    const parser = new Chess();
    try { parser.loadPgn(gamePgn); } catch { /* bad pgn */ }
    const moves = parser.history({ verbose: true });
    const replayer = new Chess();
    const fens: string[] = [replayer.fen()];
    for (const m of moves) { replayer.move(m); fens.push(replayer.fen()); }
    return { allMoves: moves, positions: fens };
  }, [gamePgn]);

  // Index into positions[] of the mistake (= moves played before bad move)
  const mistakeIdx = useMemo(() => {
    const idx = (moveNum - 1) * 2 + (playerColor === 'black' ? 1 : 0);
    return Math.min(idx, Math.max(0, positions.length - 1));
  }, [moveNum, playerColor, positions.length]);

  const [curIdx, setCurIdx] = useState(mistakeIdx);
  const [practiceMode, setPracticeMode] = useState(false);

  // Practice puzzle state
  const [practiceChess] = useState(() => new Chess(fen));
  const [practiceFen, setPracticeFen] = useState(fen);
  const [feedback, setFeedback] = useState<'idle' | 'correct' | 'wrong'>('idle');
  const [attempts, setAttempts] = useState(0);
  const [solved, setSolved] = useState(false);

  const bestFrom = bestMove.slice(0, 2);
  const bestTo = bestMove.slice(2, 4);

  const moveListRef = useRef<HTMLDivElement>(null);

  // Scroll current move into view
  useEffect(() => {
    document.getElementById(`move-${curIdx}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [curIdx]);

  function goTo(idx: number) {
    const clamped = Math.max(0, Math.min(idx, positions.length - 1));
    setCurIdx(clamped);
    setPracticeMode(false);
    setFeedback('idle');
  }

  function handlePieceDrop({ piece, sourceSquare, targetSquare }: {
    piece: DraggingPieceDataType; sourceSquare: string; targetSquare: string | null;
  }): boolean {
    if (!practiceMode || solved || !targetSquare) return false;
    try {
      const pt = piece.pieceType.toLowerCase();
      const isPromo = pt[1] === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1');
      const move = practiceChess.move({ from: sourceSquare, to: targetSquare, promotion: isPromo ? 'q' : undefined });
      if (!move) return false;

      setAttempts(a => a + 1);
      setPracticeFen(practiceChess.fen());

      if (sourceSquare === bestFrom && targetSquare === bestTo) {
        setFeedback('correct');
        setSolved(true);
      } else {
        setFeedback('wrong');
        setTimeout(() => {
          practiceChess.undo();
          setPracticeFen(fen);
          setFeedback('idle');
        }, 1200);
      }
      return true;
    } catch { return false; }
  }

  const squareStyles: Record<string, React.CSSProperties> = {};
  if (practiceMode && attempts >= 2 && !solved) {
    squareStyles[bestFrom] = { background: 'rgba(59,130,246,0.4)', borderRadius: '50%' };
  }

  const displayFen = practiceMode ? practiceFen : positions[curIdx];
  const atMistake = curIdx === mistakeIdx;
  const actualMoveSan = allMoves[mistakeIdx]?.san ?? '?';

  // Group moves into pairs for the move list
  const movePairs: MovePair[] = [];
  allMoves.forEach((m, i) => {
    const p = Math.floor(i / 2);
    if (!movePairs[p]) movePairs[p] = { num: p + 1 };
    if (m.color === 'w') movePairs[p].white = { san: m.san, idx: i + 1 };
    else movePairs[p].black = { san: m.san, idx: i + 1 };
  });

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-auto">
      <div className="glass-panel w-full" style={{ maxWidth: '820px' }}>

        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <span className="text-xs uppercase tracking-wider text-slate-500 font-semibold">{weaknessName}</span>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full bg-white border border-slate-500" />
                <span className="text-white font-bold text-sm">{whitePlayer}</span>
              </span>
              <span className="text-slate-500 text-xs">vs</span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full bg-slate-800 border border-slate-400" />
                <span className="text-slate-300 font-bold text-sm">{blackPlayer}</span>
              </span>
              <span className="text-slate-600 text-xs">· Game {gameNum + 1}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors ml-4 flex-shrink-0">
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: '1rem' }}>

          {/* Left: board + controls */}
          <div>
            <div className="rounded-lg overflow-hidden mb-2">
              <Chessboard
                options={{
                  position: displayFen,
                  boardOrientation: playerColor,
                  squareStyles,
                  allowDragging: practiceMode && !solved,
                  onPieceDrop: handlePieceDrop,
                }}
              />
            </div>

            {/* Navigation bar */}
            <div className="flex items-center gap-1 mb-2">
              <button onClick={() => goTo(0)} className="nav-btn text-xs px-2">⏮</button>
              <button onClick={() => goTo(curIdx - 1)} disabled={curIdx === 0} className="nav-btn">
                <ChevronLeft size={16} />
              </button>
              <span className="text-slate-400 text-xs flex-1 text-center">
                {curIdx === 0 ? 'Start' : `Move ${Math.ceil(curIdx / 2)} · ${curIdx % 2 === 1 ? 'White' : 'Black'}`}
              </span>
              <button onClick={() => goTo(curIdx + 1)} disabled={curIdx >= positions.length - 1} className="nav-btn">
                <ChevronRight size={16} />
              </button>
              <button onClick={() => goTo(positions.length - 1)} className="nav-btn text-xs px-2">⏭</button>
              {atMistake && bestMove && !practiceMode && (
                <button onClick={() => setPracticeMode(true)} className="btn-small-primary ml-1">
                  Practice
                </button>
              )}
              {practiceMode && (
                <button onClick={() => { setPracticeMode(false); setFeedback('idle'); }} className="btn-small-secondary ml-1">
                  Exit
                </button>
              )}
            </div>

            {/* Move comparison — shown at mistake position */}
            {atMistake && !practiceMode && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(127,29,29,0.3)', border: '1px solid rgba(239,68,68,0.3)' }}>
                  <div className="text-xs uppercase tracking-wider mb-1" style={{ color: '#f87171' }}>You played</div>
                  <div className="font-mono font-bold text-white text-lg">{actualMoveSan}</div>
                </div>
                <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(6,78,59,0.3)', border: '1px solid rgba(34,197,94,0.3)' }}>
                  <div className="text-xs uppercase tracking-wider mb-1" style={{ color: '#4ade80' }}>Best move</div>
                  <div className="font-mono font-bold text-white text-lg">{bestFrom}{bestTo}</div>
                </div>
              </div>
            )}

            {/* Practice feedback */}
            {practiceMode && (
              <div className="rounded-lg p-2 text-center text-sm mb-2" style={{
                background: solved ? 'rgba(6,78,59,0.3)' : feedback === 'wrong' ? 'rgba(127,29,29,0.3)' : 'rgba(30,41,59,0.6)',
                border: `1px solid ${solved ? 'rgba(34,197,94,0.3)' : feedback === 'wrong' ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.06)'}`,
                color: solved ? '#4ade80' : feedback === 'wrong' ? '#f87171' : '#94a3b8',
              }}>
                {solved
                  ? `Correct! ${bestFrom}${bestTo} was the best move.`
                  : feedback === 'wrong'
                  ? `Not quite — try again.${attempts >= 2 ? ' (hint: blue square)' : ''}`
                  : 'Find the best move for this position.'}
              </div>
            )}

            {/* Coach tip */}
            <div className="flex items-start gap-2 p-2 rounded-lg" style={{ background: 'rgba(30,41,59,0.5)' }}>
              <Lightbulb size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
              <p className="text-slate-300 text-sm">{tip}</p>
            </div>
          </div>

          {/* Right: move list */}
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">Game History</div>
            <div
              ref={moveListRef}
              className="rounded-lg p-2 overflow-y-auto"
              style={{ background: 'rgba(15,23,42,0.7)', border: '1px solid rgba(255,255,255,0.06)', height: '420px' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '22px 1fr 1fr', gap: '1px' }}>
                {movePairs.map(pair => (
                  <div key={pair.num} style={{ display: 'contents' }}>
                    <span className="text-right pr-1 select-none py-0.5 text-xs" style={{ color: '#475569', lineHeight: '1.6' }}>
                      {pair.num}.
                    </span>
                    <MoveCell san={pair.white?.san} idx={pair.white?.idx} curIdx={curIdx} mistakeIdx={mistakeIdx} onClick={goTo} />
                    <MoveCell san={pair.black?.san} idx={pair.black?.idx} curIdx={curIdx} mistakeIdx={mistakeIdx} onClick={goTo} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
