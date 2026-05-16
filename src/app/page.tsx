'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchGames, analyzeGame, aggregateErrors, ChessError, Game } from '@/lib/chess-analyzer';
import { ChessboardPanel } from '@/components/ChessboardPanel';
import { Terminal, ShieldAlert, Award, Activity, Search, RefreshCw, History, Zap } from 'lucide-react';

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
  opponentRating: number;
}

interface SessionRecord {
  date: string;
  games_count: number;
  weaknesses: string[];
}

function loadHistory(username: string): SessionRecord[] {
  try {
    const raw = localStorage.getItem(`chess_coach_${username.toLowerCase()}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSession(username: string, gamesCount: number, weaknesses: Weakness[]) {
  try {
    const h = loadHistory(username);
    h.push({ date: new Date().toLocaleDateString(), games_count: gamesCount, weaknesses: weaknesses.map(w => w.name.toLowerCase()) });
    localStorage.setItem(`chess_coach_${username.toLowerCase()}`, JSON.stringify(h));
  } catch { /* ignore */ }
}

function recurringCount(name: string, history: SessionRecord[]): number {
  return history.filter(s => s.weaknesses.includes(name.toLowerCase())).length;
}

const CARD_GRADIENTS = [
  { bar: 'linear-gradient(to bottom, #ef4444, #f97316)', num: 'linear-gradient(135deg,#ef4444,#f97316)' },
  { bar: 'linear-gradient(to bottom, #f97316, #eab308)', num: 'linear-gradient(135deg,#f97316,#eab308)' },
  { bar: 'linear-gradient(to bottom, #3b82f6, #8b5cf6)', num: 'linear-gradient(135deg,#3b82f6,#8b5cf6)' },
];

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
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    setHistory(loadHistory(username));
  }, [username]);

  const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const startAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !workerRef.current) return;
    setStatus('fetching'); setLogs([]); setReport([]); setErrorMsg('');

    try {
      addLog(`Fetching last ${gamesCount} games for ${username}...`);
      const fetchedGames = await fetchGames(username, parseInt(gamesCount));
      addLog(`Fetched ${fetchedGames.length} games.`);
      setGames(fetchedGames);
      if (fetchedGames.length === 0) throw new Error('No recent games found.');

      let lastRating = 'Unknown';
      const whiteOpenings: Record<string, number> = {};
      const blackOpenings: Record<string, number> = {};

      fetchedGames.forEach(g => {
        const isWhite = g.white.username.toLowerCase() === username.toLowerCase();
        if (isWhite && g.white.rating) lastRating = g.white.rating.toString();
        if (!isWhite && g.black.rating) lastRating = g.black.rating.toString();
        let eco = 'Unknown';
        if (g.pgn) {
          const m = g.pgn.match(/\[ECOUrl ".*\/openings\/(.*)"\]/);
          if (m?.[1]) eco = m[1].replace(/-/g, ' ');
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

      for (let i = 0; i < fetchedGames.length; i++) {
        addLog(`Analyzing game ${i + 1}/${fetchedGames.length}...`);
        const gameErrors = await analyzeGame(fetchedGames[i], username, workerRef.current!, 12, i, (move, total) => {
          if (move % 10 === 0 || move === total) addLog(`  Game ${i + 1}: move ${move}/${total}`);
        });
        addLog(`  Game ${i + 1}: ${gameErrors.length} errors.`);
        allErrors.push(...gameErrors);
      }

      setStatus('aggregating');
      addLog(`Aggregating ${allErrors.length} errors...`);
      const aggregatedData = aggregateErrors(allErrors);

      setStatus('generating');
      addLog('Requesting coaching report from Claude...');
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aggregatedData, rating: lastRating, white_opening: mostFreqWhite, black_opening: mostFreqBlack }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed to generate report'); }

      const data = await res.json();
      setReport(data.weaknesses);
      setStatus('done');
      addLog('Analysis complete.');

      const updatedHistory = loadHistory(username);
      saveSession(username, parseInt(gamesCount), data.weaknesses);
      setHistory([...updatedHistory, { date: new Date().toLocaleDateString(), games_count: parseInt(gamesCount), weaknesses: data.weaknesses.map((w: Weakness) => w.name.toLowerCase()) }]);

    } catch (err: any) {
      console.error(err); setStatus('error'); setErrorMsg(err.message); addLog(`Error: ${err.message}`);
    }
  };

  const openPractice = (weakness: Weakness) => {
    const game = games[weakness.game];
    if (!game) return;
    const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
    const opponentRating = (isWhite ? game.black.rating : game.white.rating) ?? 1200;
    setPracticeData({
      weakness, gamePgn: game.pgn,
      whitePlayer: game.white.username, blackPlayer: game.black.username,
      playerColor: isWhite ? 'white' : 'black',
      opponentRating,
    });
  };

  const isRunning = !['idle', 'done', 'error'].includes(status);

  return (
    <main className="container">
      {/* Hero */}
      <div className="text-center mb-8 animate-slide-up">
        <h1 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem' }}>
          <Award style={{ color: '#60a5fa', flexShrink: 0 }} size={42} />
          AI Chess Coach
        </h1>
        <p style={{ fontSize: '1rem', color: '#475569', marginTop: '0.25rem' }}>Grandmaster-level analysis of your recurring weaknesses</p>
      </div>

      <div className="grid md:grid-cols-2 gap-8">

        {/* ── Left column ── */}
        <div className="flex-col gap-6">

          {/* Analysis form */}
          <div className="glass-panel animate-slide-up" style={{ animationDelay: '0.05s' }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#e2e8f0' }}>
              <Activity size={22} style={{ color: '#60a5fa' }} /> Analysis Parameters
            </h2>
            <form onSubmit={startAnalysis} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
              <div>
                <label>Chess.com Username</label>
                <input type="text" className="glass-input" value={username} onChange={e => setUsername(e.target.value)} required disabled={isRunning} />
              </div>
              <div>
                <label>Games to Analyze</label>
                <select className="glass-input" value={gamesCount} onChange={e => setGamesCount(e.target.value)} disabled={isRunning}>
                  <option value="5">5 Games (Quick)</option>
                  <option value="10">10 Games (Standard)</option>
                  <option value="30">30 Games (Deep Pattern Search)</option>
                </select>
              </div>
              <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} disabled={isRunning}>
                {isRunning ? <><RefreshCw size={18} className="animate-spin" /> Analyzing...</> : <><Search size={18} /> Analyze My Games</>}
              </button>
            </form>
          </div>

          {/* Console */}
          {status !== 'idle' && (
            <div className="glass-panel mt-6 animate-slide-up" style={{ animationDelay: '0.1s' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#e2e8f0', marginBottom: '0.875rem' }}>
                <Terminal size={20} style={{ color: '#10b981' }} /> Live Console
              </h2>
              <div className="terminal-console">
                {logs.map((log, i) => <div key={i} className="terminal-line">{log}</div>)}
                {isRunning && <div className="terminal-line"><span className="animate-pulse">▋</span><span className="terminal-cursor" /></div>}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {/* Detected profile */}
          {detectedProfile && ['done','generating','aggregating','analyzing'].includes(status) && (
            <div className="glass-panel mt-4 animate-slide-up" style={{ animationDelay: '0.15s' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#334155', marginBottom: '0.75rem' }}>Detected Profile</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '0.625rem' }}>
                {[
                  { label: 'Rating', value: detectedProfile.rating, color: '#60a5fa' },
                  { label: 'As White', value: detectedProfile.white },
                  { label: 'As Black', value: detectedProfile.black },
                ].map(({ label, value, color }) => (
                  <div key={label} className="stat-box" style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.65rem', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px' }}>{label}</div>
                    <div style={{ fontWeight: 800, fontSize: '0.75rem', color: color || '#e2e8f0', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }} title={value}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Past sessions */}
          {history.length > 1 && (
            <div className="glass-panel mt-4 animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#334155', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <History size={13} /> Past Sessions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {history.slice(-5).reverse().map((session, i) => (
                  <div key={i} style={{ background: 'rgba(10,14,26,0.6)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.625rem', padding: '0.625rem 0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#334155', marginBottom: '6px' }}>
                      <span>{session.date}</span><span>{session.games_count} games</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {session.weaknesses.map((w, j) => (
                        <span key={j} style={{ fontSize: '0.68rem', background: 'rgba(30,41,59,0.7)', color: '#475569', border: '1px solid rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: '9999px' }}>{w}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right column ── */}
        <div>
          {status === 'idle' && (
            <div className="glass-panel animate-slide-up" style={{ animationDelay: '0.1s', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '300px', textAlign: 'center', opacity: 0.65 }}>
              <ShieldAlert size={56} style={{ color: '#1e293b', marginBottom: '1rem' }} />
              <h2 style={{ color: '#334155' }}>No Data Yet</h2>
              <p style={{ maxWidth: '260px' }}>Enter your username and analyze games to uncover recurring patterns.</p>
            </div>
          )}

          {status === 'error' && (
            <div className="glass-panel animate-slide-up" style={{ border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(127,29,29,0.12)' }}>
              <h2 style={{ color: '#f87171' }}>Analysis Failed</h2>
              <p style={{ color: '#fca5a5' }}>{errorMsg}</p>
            </div>
          )}

          {status === 'done' && report.length > 0 && (
            <div className="animate-slide-up" style={{ animationDelay: '0.15s', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Report header */}
              <div style={{ background: 'linear-gradient(135deg,rgba(10,14,26,0.95),rgba(15,10,30,0.95))', border: '1px solid rgba(139,92,246,0.18)', borderRadius: '1.125rem', padding: '1.125rem 1.375rem', boxShadow: '0 0 40px rgba(139,92,246,0.06)', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Zap size={28} style={{ color: '#a78bfa', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 900, fontSize: '1.2rem', color: '#e2e8f0', lineHeight: 1.2 }}>3 Key Weaknesses</div>
                    <div style={{ fontSize: '0.78rem', color: '#334155', marginTop: '2px' }}>Based on your last {gamesCount} games · Click to review &amp; practice</div>
                  </div>
                </div>
              </div>

              {/* Weakness cards */}
              {report.map((weakness, idx) => {
                const recurring = recurringCount(weakness.name, history.slice(0, -1));
                const g = CARD_GRADIENTS[idx] ?? CARD_GRADIENTS[2];
                return (
                  <div key={idx} className="weakness-card">
                    <div className="weakness-card-accent" style={{ background: g.bar }} />
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
                      {/* Number badge */}
                      <div style={{ width: '2.25rem', height: '2.25rem', borderRadius: '50%', background: g.num, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 900, color: '#fff', flexShrink: 0, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
                        {idx + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '3px' }}>
                          <span style={{ fontWeight: 900, color: '#f1f5f9', fontSize: '0.88rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{weakness.name}</span>
                          {recurring > 0 && (
                            <span style={{ fontSize: '0.68rem', fontWeight: 800, background: 'rgba(245,158,11,0.1)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.25)', padding: '1px 7px', borderRadius: '9999px' }}>
                              ⚠ ×{recurring + 1}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: '#334155', marginBottom: '6px' }}>
                          Game {weakness.game + 1} · Move {weakness.move}
                        </div>
                        <p style={{ fontSize: '0.84rem', color: '#64748b', lineHeight: '1.55', marginBottom: '10px' }}>{weakness.tip}</p>
                        {weakness.fen && weakness.best_move && games[weakness.game] && (
                          <button
                            onClick={() => openPractice(weakness)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.78rem', fontWeight: 800, background: 'rgba(59,130,246,0.08)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)', padding: '5px 12px', borderRadius: '7px', cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '0.01em' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.16)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.08)'; }}
                          >
                            Review &amp; Practice →
                          </button>
                        )}
                      </div>
                    </div>
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
          opponentRating={practiceData.opponentRating}
          onClose={() => setPracticeData(null)}
        />
      )}
    </main>
  );
}
