'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchGames, analyzeGame, aggregateErrors, ChessError, Game } from '@/lib/chess-analyzer';
import { ChessboardPanel } from '@/components/ChessboardPanel';
import { Terminal, ShieldAlert, Award, Activity, Search, RefreshCw, ChevronRight, History, AlertTriangle } from 'lucide-react';

interface Weakness {
  name: string;
  game: number;
  move: number;
  fen: string;
  best_move: string;
  tip: string;
}

interface PracticeData {
  weakness: Weakness;
  gamePgn: string;
  whitePlayer: string;
  blackPlayer: string;
  playerColor: 'white' | 'black';
}

interface SessionRecord {
  date: string;
  games_count: number;
  weaknesses: string[]; // weakness names only
}

function loadHistory(username: string): SessionRecord[] {
  try {
    const raw = localStorage.getItem(`chess_coach_${username.toLowerCase()}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSession(username: string, gamesCount: number, weaknesses: Weakness[]) {
  try {
    const history = loadHistory(username);
    history.push({
      date: new Date().toLocaleDateString(),
      games_count: gamesCount,
      weaknesses: weaknesses.map(w => w.name.toLowerCase()),
    });
    localStorage.setItem(`chess_coach_${username.toLowerCase()}`, JSON.stringify(history));
  } catch { /* ignore */ }
}

function recurringCount(name: string, history: SessionRecord[]): number {
  return history.filter(s => s.weaknesses.includes(name.toLowerCase())).length;
}

export default function Home() {
  const [username, setUsername] = useState('prashant_chandel');
  const [gamesCount, setGamesCount] = useState('10');
  const [detectedProfile, setDetectedProfile] = useState<{ rating: string; white: string; black: string } | null>(null);

  const [status, setStatus] = useState<'idle' | 'fetching' | 'analyzing' | 'aggregating' | 'generating' | 'done' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [report, setReport] = useState<Weakness[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [history, setHistory] = useState<SessionRecord[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [practiceData, setPracticeData] = useState<PracticeData | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker('/stockfish.js');
    return () => { workerRef.current?.terminate(); };
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  useEffect(() => {
    setHistory(loadHistory(username));
  }, [username]);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const startAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !workerRef.current) return;

    setStatus('fetching');
    setLogs([]);
    setReport([]);
    setErrorMsg('');

    try {
      addLog(`Fetching last ${gamesCount} games for ${username}...`);
      const games = await fetchGames(username, parseInt(gamesCount));
      addLog(`Fetched ${games.length} games.`);
      setGames(games);

      if (games.length === 0) throw new Error("No recent games found.");

      let lastRating = 'Unknown';
      const whiteOpenings: Record<string, number> = {};
      const blackOpenings: Record<string, number> = {};

      games.forEach(g => {
        const isWhite = g.white.username.toLowerCase() === username.toLowerCase();
        if (isWhite && g.white.rating) lastRating = g.white.rating.toString();
        if (!isWhite && g.black.rating) lastRating = g.black.rating.toString();

        let eco = 'Unknown';
        if (g.pgn) {
          const match = g.pgn.match(/\[ECOUrl ".*\/openings\/(.*)"\]/);
          if (match && match[1]) eco = match[1].replace(/-/g, ' ');
          else if (g.eco) eco = g.eco.split('/').pop()?.replace(/-/g, ' ') || 'Unknown';
        }
        if (isWhite) whiteOpenings[eco] = (whiteOpenings[eco] || 0) + 1;
        else blackOpenings[eco] = (blackOpenings[eco] || 0) + 1;
      });

      const mostFreqWhite = Object.entries(whiteOpenings).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
      const mostFreqBlack = Object.entries(blackOpenings).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
      setDetectedProfile({ rating: lastRating, white: mostFreqWhite, black: mostFreqBlack });

      setStatus('analyzing');
      const allErrors: ChessError[] = [];

      for (let i = 0; i < games.length; i++) {
        addLog(`Analyzing game ${i + 1}/${games.length}...`);
        const gameErrors = await analyzeGame(
          games[i],
          username,
          workerRef.current!,
          12,
          i,
          (move, total) => {
            if (move % 10 === 0 || move === total) addLog(`  Game ${i + 1}: move ${move}/${total}`);
          }
        );
        addLog(`  Game ${i + 1}: ${gameErrors.length} errors found.`);
        allErrors.push(...gameErrors);
      }

      setStatus('aggregating');
      addLog(`Aggregating ${allErrors.length} errors...`);
      const aggregatedData = aggregateErrors(allErrors);

      setStatus('generating');
      addLog(`Getting coaching report...`);

      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aggregatedData, rating: lastRating, white_opening: mostFreqWhite, black_opening: mostFreqBlack })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to generate report");
      }

      const data = await response.json();
      setReport(data.weaknesses);
      setStatus('done');
      addLog(`Done.`);

      const updatedHistory = loadHistory(username);
      saveSession(username, parseInt(gamesCount), data.weaknesses);
      setHistory([...updatedHistory, {
        date: new Date().toLocaleDateString(),
        games_count: parseInt(gamesCount),
        weaknesses: data.weaknesses.map((w: Weakness) => w.name.toLowerCase()),
      }]);

    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMsg(err.message);
      addLog(`Error: ${err.message}`);
    }
  };

  const isRunning = status !== 'idle' && status !== 'done' && status !== 'error';

  return (
    <main className="container">
      <div className="text-center mb-8 animate-slide-up">
        <h1 className="flex items-center justify-center gap-3">
          <Award className="text-primary" size={40} />
          AI Chess Coach
        </h1>
        <p>Grandmaster-level analysis of your recurring weaknesses</p>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Left: Form + Logs */}
        <div className="flex-col gap-6">
          <div className="glass-panel animate-slide-up" style={{ animationDelay: '0.1s' }}>
            <h2 className="flex items-center gap-2">
              <Activity size={24} className="text-primary" />
              Analysis Parameters
            </h2>
            <form onSubmit={startAnalysis} className="flex-col gap-4 mt-4">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label>Chess.com Username</label>
                  <input
                    type="text"
                    className="glass-input"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    required
                    disabled={isRunning}
                  />
                </div>
                <div className="col-span-2">
                  <label>Games to Analyze</label>
                  <select
                    className="glass-input"
                    value={gamesCount}
                    onChange={e => setGamesCount(e.target.value)}
                    disabled={isRunning}
                  >
                    <option value="5">5 Games (Quick)</option>
                    <option value="10">10 Games (Standard)</option>
                    <option value="30">30 Games (Deep Pattern Search)</option>
                  </select>
                </div>
              </div>
              <button type="submit" className="btn-primary flex items-center justify-center gap-2" disabled={isRunning}>
                {isRunning ? (
                  <><RefreshCw size={20} className="animate-spin" /> Processing...</>
                ) : (
                  <><Search size={20} /> Analyze My Games</>
                )}
              </button>
            </form>
          </div>

          {status !== 'idle' && (
            <div className="glass-panel mt-8 animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <h2 className="flex items-center gap-2 mb-4">
                <Terminal size={24} className="text-primary" />
                Live Analysis Console
              </h2>
              <div className="terminal-console">
                {logs.map((log, idx) => (
                  <div key={idx} className="terminal-line">{log}</div>
                ))}
                {isRunning && (
                  <div className="terminal-line">
                    <span className="animate-pulse">...</span>
                    <span className="terminal-cursor"></span>
                  </div>
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {detectedProfile && (status === 'done' || status === 'generating' || status === 'aggregating' || status === 'analyzing') && (
            <div className="glass-panel mt-6 animate-slide-up" style={{ animationDelay: '0.3s' }}>
              <h3 className="text-slate-300 text-sm font-semibold mb-3 uppercase tracking-wider">Detected Profile</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700">
                  <div className="text-xs text-slate-400 mb-1">Rating</div>
                  <div className="font-bold text-primary">{detectedProfile.rating}</div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700">
                  <div className="text-xs text-slate-400 mb-1">White</div>
                  <div className="font-bold text-slate-200 text-sm truncate" title={detectedProfile.white}>{detectedProfile.white}</div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700">
                  <div className="text-xs text-slate-400 mb-1">Black</div>
                  <div className="font-bold text-slate-200 text-sm truncate" title={detectedProfile.black}>{detectedProfile.black}</div>
                </div>
              </div>
            </div>
          )}

          {/* Past Sessions */}
          {history.length > 1 && (
            <div className="glass-panel mt-6 animate-slide-up" style={{ animationDelay: '0.4s' }}>
              <h3 className="flex items-center gap-2 text-slate-300 text-sm font-semibold mb-3 uppercase tracking-wider">
                <History size={16} />
                Past Sessions
              </h3>
              <div className="flex-col gap-2">
                {history.slice(-5).reverse().map((session, idx) => (
                  <div key={idx} className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50 text-sm">
                    <div className="flex justify-between text-slate-400 text-xs mb-1">
                      <span>{session.date}</span>
                      <span>{session.games_count} games</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {session.weaknesses.map((w, i) => (
                        <span key={i} className="text-xs bg-slate-700/60 text-slate-300 px-2 py-0.5 rounded-full">{w}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Report */}
        <div>
          {status === 'idle' && (
            <div className="glass-panel flex-col items-center justify-center h-full text-center animate-slide-up" style={{ animationDelay: '0.2s', opacity: 0.7 }}>
              <ShieldAlert size={64} className="text-slate-600 mb-4" />
              <h2>No Data Yet</h2>
              <p>Enter your details and click analyze to discover your recurring weaknesses.</p>
            </div>
          )}

          {status === 'error' && (
            <div className="glass-panel border-red-500/50 bg-red-950/20 animate-slide-up">
              <h2 className="text-red-400">Analysis Failed</h2>
              <p className="text-red-200">{errorMsg}</p>
            </div>
          )}

          {status === 'done' && report.length > 0 && (
            <div className="flex-col gap-4 animate-slide-up" style={{ animationDelay: '0.3s' }}>
              <div className="glass-panel border-green-500/30 mb-2">
                <h2 className="text-green-400 m-0">3 Recurring Weaknesses</h2>
                <p className="text-sm">Based on your last {gamesCount} games.</p>
              </div>

              {report.map((weakness, idx) => {
                const recurring = recurringCount(weakness.name, history.slice(0, -1));
                return (
                  <div key={idx} className="glass-panel relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1 h-full bg-primary"></div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">
                            {idx + 1}
                          </span>
                          <h3 className="font-bold text-white text-sm uppercase tracking-wide">{weakness.name}</h3>
                          {recurring > 0 && (
                            <span className="flex items-center gap-1 text-xs bg-amber-900/40 text-amber-400 border border-amber-700/40 px-2 py-0.5 rounded-full">
                              <AlertTriangle size={10} />
                              Recurring ×{recurring + 1}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mb-2">Game {weakness.game + 1} · Move {weakness.move}</p>
                        <p className="text-slate-400 text-sm">{weakness.tip}</p>
                      </div>
                    </div>
                    {weakness.fen && weakness.best_move && games[weakness.game] && (
                      <button
                        onClick={() => {
                          const game = games[weakness.game];
                          const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
                          setPracticeData({
                            weakness,
                            gamePgn: game.pgn,
                            whitePlayer: game.white.username,
                            blackPlayer: game.black.username,
                            playerColor: isWhite ? 'white' : 'black',
                          });
                        }}
                        className="mt-3 flex items-center gap-1 text-sm text-primary hover:text-blue-300 font-semibold transition-colors"
                      >
                        Review &amp; Practice <ChevronRight size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {practiceData && (
        <ChessboardPanel
          fen={practiceData.weakness.fen}
          bestMove={practiceData.weakness.best_move}
          playerColor={practiceData.playerColor}
          weaknessName={practiceData.weakness.name}
          tip={practiceData.weakness.tip}
          gameNum={practiceData.weakness.game}
          moveNum={practiceData.weakness.move}
          gamePgn={practiceData.gamePgn}
          whitePlayer={practiceData.whitePlayer}
          blackPlayer={practiceData.blackPlayer}
          onClose={() => setPracticeData(null)}
        />
      )}
    </main>
  );
}
