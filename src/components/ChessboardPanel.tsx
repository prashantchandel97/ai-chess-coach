'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Chess } from 'chess.js';
import { X, CheckCircle, XCircle } from 'lucide-react';

const Chessboard = dynamic(() => import('react-chessboard').then(m => m.Chessboard), { ssr: false });

interface Props {
  fen: string;
  bestMove: string; // UCI format e.g. "e2e4"
  playerColor: 'white' | 'black';
  weaknessName: string;
  tip: string;
  gameNum: number;
  moveNum: number;
  onClose: () => void;
}

export function ChessboardPanel({ fen, bestMove, playerColor, weaknessName, tip, gameNum, moveNum, onClose }: Props) {
  const [chess] = useState(() => new Chess(fen));
  const [currentFen, setCurrentFen] = useState(fen);
  const [feedback, setFeedback] = useState<'idle' | 'correct' | 'wrong'>('idle');
  const [attempts, setAttempts] = useState(0);
  const [solved, setSolved] = useState(false);

  const bestFrom = bestMove.slice(0, 2);
  const bestTo = bestMove.slice(2, 4);

  const customSquareStyles: Record<string, React.CSSProperties> = {};
  if (attempts >= 2 && !solved) {
    // Hint: highlight the from-square after 2 wrong attempts
    customSquareStyles[bestFrom] = { background: 'rgba(59, 130, 246, 0.4)', borderRadius: '50%' };
  }

  function handlePieceDrop({ piece, sourceSquare, targetSquare }: { piece: string; sourceSquare: string; targetSquare: string }): boolean {
    if (solved) return false;
    try {
      const isPromotion =
        piece.toLowerCase()[1] === 'p' &&
        (targetSquare[1] === '8' || targetSquare[1] === '1');
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: isPromotion ? 'q' : undefined });
      if (!move) return false;

      const isCorrect = sourceSquare === bestFrom && targetSquare === bestTo;
      setCurrentFen(chess.fen());
      setAttempts(a => a + 1);

      if (isCorrect) {
        setFeedback('correct');
        setSolved(true);
      } else {
        setFeedback('wrong');
        setTimeout(() => {
          chess.undo();
          setCurrentFen(fen);
          setFeedback('idle');
        }, 1200);
      }
      return true;
    } catch {
      return false;
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-md relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <div className="mb-3">
          <span className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Practice Position</span>
          <h3 className="text-primary font-bold text-lg mt-1">{weaknessName}</h3>
          <p className="text-slate-400 text-sm mt-1">Game {gameNum + 1} · Move {moveNum}</p>
        </div>

        <div className="rounded-lg overflow-hidden mb-3">
          <Chessboard
            options={{
              position: currentFen,
              boardOrientation: playerColor,
              squareStyles: customSquareStyles,
              allowDragging: !solved,
              onPieceDrop: handlePieceDrop,
            }}
          />
        </div>

        {feedback === 'correct' || solved ? (
          <div className="flex items-center gap-2 p-3 bg-emerald-900/30 border border-emerald-500/30 rounded-lg text-emerald-400 font-semibold">
            <CheckCircle size={18} />
            Correct! {bestFrom}{bestTo} was the best move.
          </div>
        ) : feedback === 'wrong' ? (
          <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-400">
            <XCircle size={18} />
            Not the best — try again.{attempts >= 2 ? ' (hint: highlighted square)' : ''}
          </div>
        ) : (
          <div className="p-3 bg-slate-800/60 rounded-lg text-slate-300 text-sm">
            <span className="text-slate-500 text-xs uppercase font-semibold block mb-1">Coach says</span>
            {tip}
          </div>
        )}
      </div>
    </div>
  );
}
