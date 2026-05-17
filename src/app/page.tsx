'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchGames, analyzeGame, aggregateErrors, ChessError, Game } from '@/lib/chess-analyzer';
import { ChessboardPanel } from '@/components/ChessboardPanel';
import { Terminal, ShieldAlert, Award, Activity, Search, RefreshCw, History, Zap, Bell } from 'lucide-react';

interface WeaknessExample {
  game: number;
  move: number;
  fen: string;
  best_move: string;
}

interface Weakness {
  name: string;
  examples: WeaknessExample[];
  tip: string;
}

interface PracticeData {
  weakness: Weakness;
  exampleIdx: number;
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

function saveLocalSession(username: string, gamesCount: number, weaknesses: Weakness[]) {
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
  const [pendingCount, setPendingCount] = useState(0);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker('/stockfish.js');
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Load history + pending count whenever username changes
  useEffect(() => {
    if (!username) return;
    setHistory(loadHistory(username));
    setPendingCount(0);

    // DB session history
    fetch(`/api/db/history?username=${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then(d => {
        if (d.sessions?.length) {
          setHistory(d.sessions.map((s: any) => ({
            date: new Date(s.created_at).toLocaleDateString(),
            games_count: s.games_count,
            weaknesses: (s.weaknesses as any[]).map((w: any) =>
              typeof w === 'string' ? w : (w.name ?? '').toLowerCase()
            ),
          })));
        }
      })
      .catch(() => {});

    // Pending games from overnight cron
    fetch(`/api/db/pending?username=${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then(d => { if (d.count > 0) setPendingCount(d.count); })
      .catch(() => {});
  }, [username]);

  const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Register user as tracked (so cron picks them up daily)
  async function ensureTracked(uname: string) {
    try {
      await fetch('/api/db/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uname }),
      });
    } catch { /* non-critical */ }
  }

  const startAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !workerRef.current) return;
    setStatus('fetching'); setLogs([]); setReport([]); setErrorMsg('');

    // Register for daily cron updates
    ensureTracked(username);

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

      // Check DB cache
      addLog('Checking cached analysis...');
      const gameUrls = fetchedGames.map(g => g.url);
      let cachedErrors: Record<string, ChessError[]> = {};
      try {
        const cacheRes = await fetch('/api/db/cached-games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, gameUrls }),
        });
        const cacheData = await cacheRes.json();
        cachedErrors = cacheData.cached ?? {};
        const cachedCount = Object.keys(cachedErrors).length;
        if (cachedCount > 0) addLog(`Cache hit: ${cachedCount}/${fetchedGames.length} games already analyzed.`);
      } catch { /* no cache */ }

      setStatus('analyzing');
      const allErrors: ChessError[] = [];
      const gameErrorsForDb: any[] = [];

      for (let i = 0; i < fetchedGames.length; i++) {
        const game = fetchedGames[i];

        if (cachedErrors[game.url]) {
          addLog(`  Game ${i + 1}: cached (${cachedErrors[game.url].length} errors).`);
          allErrors.push(...cachedErrors[game.url]);
          continue;
        }

        addLog(`Analyzing game ${i + 1}/${fetchedGames.length}...`);
        const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
        const gameErrors = await analyzeGame(game, username, workerRef.current!, 14, i, (move, total) => {
          if (move % 10 === 0 || move === total) addLog(`  Game ${i + 1}: move ${move}/${total}`);
        });
        addLog(`  Game ${i + 1}: ${gameErrors.length} errors (opening: ${gameErrors.filter(e => e.phase === 'opening').length}).`);
        allErrors.push(...gameErrors);
        gameErrorsForDb.push({
          url: game.url, pgn: game.pgn,
          white: game.white.username, black: game.black.username,
          whiteRating: game.white.rating ?? null, blackRating: game.black.rating ?? null,
          playerColor: isWhite ? 'white' : 'black',
          errors: gameErrors,
        });
      }

      setStatus('aggregating');
      addLog(`Aggregating ${allErrors.length} total errors (phase-stratified)...`);
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
      const weaknesses: Weakness[] = data.weaknesses;
      setReport(weaknesses);
      setStatus('done');
      addLog('Analysis complete.');

      // Save to DB + localStorage
      saveLocalSession(username, parseInt(gamesCount), weaknesses);
      setHistory(h => [...h, {
        date: new Date().toLocaleDateString(),
        games_count: parseInt(gamesCount),
        weaknesses: weaknesses.map(w => w.name.toLowerCase()),
      }]);

      if (gameErrorsForDb.length > 0) {
        fetch('/api/db/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, gamesCount: parseInt(gamesCount), rating: lastRating, weaknesses, gameErrors: gameErrorsForDb }),
        }).catch(() => {});
      }

      // Clear pending games now that we've analyzed
      if (pendingCount > 0) {
        fetch('/api/db/pending', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        }).then(() => setPendingCount(0)).catch(() => {});
      }

    } catch (err: any) {
      console.error(err); setStatus('error'); setErrorMsg(err.message); addLog(`Error: ${err.message}`);
    }
  };

  const openPractice = (weakness: Weakness, exampleIdx = 0) => {
    const ex = weakness.examples[exampleIdx];
    if (!ex) return;
    const game = games[ex.game];
    if (!game) return;
    const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
    const opponentRating = (isWhite ? game.black.rating : game.white.rating) ?? 1200;
    setPracticeData({
      weakness, exampleIdx,
      gamePgn: game.pgn,
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

      {/* Pending games banner */}
      {pendingCount > 0 && (
        <div className="animate-slide-up" style={{ marginBottom: '1.5rem', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: '1rem', padding: '0.875rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Bell size={18} style={{ color: '#60a5fa', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: 700, color: '#93c5fd', fontSize: '0.9rem' }}>
              {pendingCount} new game{pendingCount !== 1 ? 's' : ''} since your last analysis
            </span>
            <span style={{ color: '#475569', fontSize: '0.82rem', marginLeft: '0.5rem' }}>— fetched overnight · click Analyze to get your updated report</span>
          </div>
          <button
            onClick={() => document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))}
            style={{ fontSize: '0.78rem', fontWeight: 800, background: '#3b82f6', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '7px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            Analyze now →
          </button>
        </div>
      )}

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
                {isRunning
                  ? <><RefreshCw size={18} className="animate-spin" /> Analyzing...</>
                  : <><Search size={18} /> {pendingCount > 0 ? `Analyze (${pendingCount} new)` : 'Analyze My Games'}</>
                }
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
                    <div style={{ fontSize: '0.78rem', color: '#334155', marginTop: '2px' }}>Based on your last {gamesCount} games · Click any example to review &amp; practice</div>
                  </div>
                </div>
              </div>

              {/* Weakness cards */}
              {report.map((weakness, idx) => {
                const recurring = recurringCount(weakness.name, history.slice(0, -1));
                const g = CARD_GRADIENTS[idx] ?? CARD_GRADIENTS[2];
                const primaryEx = weakness.examples[0];
                return (
                  <div key={idx} className="weakness-card">
                    <div className="weakness-card-accent" style={{ background: g.bar }} />
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
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
                          <span style={{ fontSize: '0.68rem', color: '#334155' }}>{weakness.examples.length} example{weakness.examples.length !== 1 ? 's' : ''}</span>
                        </div>
                        <p style={{ fontSize: '0.84rem', color: '#64748b', lineHeight: '1.55', marginBottom: '10px' }}>{weakness.tip}</p>

                        {/* Example chips */}
                        {weakness.examples.length > 0 && games[primaryEx?.game] && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {weakness.examples.map((ex, ei) => (
                              games[ex.game] && ex.fen && ex.best_move ? (
                                <button
                                  key={ei}
                                  onClick={() => openPractice(weakness, ei)}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    fontSize: '0.74rem', fontWeight: 700,
                                    background: ei === 0 ? 'rgba(59,130,246,0.1)' : 'rgba(30,41,59,0.7)',
                                    color: ei === 0 ? '#60a5fa' : '#475569',
                                    border: `1px solid ${ei === 0 ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.06)'}`,
                                    padding: '4px 10px', borderRadius: '7px', cursor: 'pointer', transition: 'all 0.15s',
                                  }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.18)'; (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = ei === 0 ? 'rgba(59,130,246,0.1)' : 'rgba(30,41,59,0.7)'; (e.currentTarget as HTMLButtonElement).style.color = ei === 0 ? '#60a5fa' : '#475569'; }}
                                >
                                  G{ex.game + 1}·M{ex.move} {ei === 0 ? '→' : ''}
                                </button>
                              ) : null
                            ))}
                          </div>
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
          fen={practiceData.weakness.examples[practiceData.exampleIdx].fen}
          bestMove={practiceData.weakness.examples[practiceData.exampleIdx].best_move}
          playerColor={practiceData.playerColor}
          weaknessName={practiceData.weakness.name}
          tip={practiceData.weakness.tip}
          gameNum={practiceData.weakness.examples[practiceData.exampleIdx].game}
          moveNum={practiceData.weakness.examples[practiceData.exampleIdx].move}
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
