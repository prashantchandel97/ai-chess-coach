'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchGames, analyzeGame, aggregateErrors, ChessError } from '@/lib/chess-analyzer';
import { Terminal, ShieldAlert, Award, Activity, Search, RefreshCw, ChevronRight } from 'lucide-react';

export default function Home() {
  const [username, setUsername] = useState('prashant_chandel');
  const [gamesCount, setGamesCount] = useState('10');
  const [detectedProfile, setDetectedProfile] = useState<{rating: string, white: string, black: string} | null>(null);
  
  const [status, setStatus] = useState<'idle' | 'fetching' | 'analyzing' | 'aggregating' | 'generating' | 'done' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [report, setReport] = useState<any[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // Initialize Web Worker
  useEffect(() => {
    workerRef.current = new Worker('/stockfish.js');
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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
      addLog(`Successfully fetched ${games.length} games.`);
      
      if (games.length === 0) {
        throw new Error("No recent games found.");
      }
      
      // Auto-detect profile from recent games
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
      
      setDetectedProfile({
        rating: lastRating,
        white: mostFreqWhite,
        black: mostFreqBlack
      });

      setStatus('analyzing');
      const allErrors: ChessError[] = [];
      
      for (let i = 0; i < games.length; i++) {
        addLog(`Analyzing game ${i + 1}/${games.length} with Stockfish...`);
        const gameErrors = await analyzeGame(
          games[i], 
          username, 
          workerRef.current, 
          12, // depth
          (move, total) => {
            if (move % 5 === 0 || move === total) {
              addLog(`  Game ${i + 1}: Evaluating move ${move}/${total}`);
            }
          }
        );
        addLog(`  Game ${i + 1} complete. Found ${gameErrors.length} mistakes/blunders.`);
        allErrors.push(...gameErrors);
      }

      setStatus('aggregating');
      addLog(`Aggregating patterns from ${allErrors.length} total errors...`);
      const aggregatedData = aggregateErrors(allErrors);
      
      setStatus('generating');
      addLog(`Requesting coaching report from Claude API...`);
      
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregatedData,
          rating: lastRating,
          white_opening: mostFreqWhite,
          black_opening: mostFreqBlack
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to generate report");
      }

      const data = await response.json();
      setReport(data.weaknesses);
      setStatus('done');
      addLog(`Analysis complete.`);
      
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMsg(err.message);
      addLog(`Error: ${err.message}`);
    }
  };

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
        {/* Left Column: Form / Logs */}
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
                    disabled={status !== 'idle' && status !== 'done' && status !== 'error'}
                  />
                </div>
                <div className="col-span-2">
                  <label>Games to Analyze</label>
                  <select 
                    className="glass-input"
                    value={gamesCount}
                    onChange={e => setGamesCount(e.target.value)}
                    disabled={status !== 'idle' && status !== 'done' && status !== 'error'}
                  >
                    <option value="5">5 Games (Quick)</option>
                    <option value="10">10 Games (Standard)</option>
                    <option value="30">30 Games (Deep Pattern Search)</option>
                  </select>
                </div>
              </div>

              <button 
                type="submit" 
                className="btn-primary flex items-center justify-center gap-2"
                disabled={status !== 'idle' && status !== 'done' && status !== 'error'}
              >
                {(status === 'idle' || status === 'done' || status === 'error') ? (
                  <>
                    <Search size={20} />
                    Analyze My Games
                  </>
                ) : (
                  <>
                    <RefreshCw size={20} className="animate-spin" />
                    Processing...
                  </>
                )}
              </button>
            </form>
          </div>

          {(status !== 'idle') && (
            <div className="glass-panel mt-8 animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <h2 className="flex items-center gap-2 mb-4">
                <Terminal size={24} className="text-primary" />
                Live Analysis Console
              </h2>
              <div className="terminal-console">
                {logs.map((log, idx) => (
                  <div key={idx} className="terminal-line">{log}</div>
                ))}
                {(status !== 'done' && status !== 'error') && (
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
                  <div className="text-xs text-slate-400 mb-1">White Opening</div>
                  <div className="font-bold text-slate-200 text-sm truncate" title={detectedProfile.white}>{detectedProfile.white}</div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700">
                  <div className="text-xs text-slate-400 mb-1">Black Opening</div>
                  <div className="font-bold text-slate-200 text-sm truncate" title={detectedProfile.black}>{detectedProfile.black}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Report */}
        <div>
          {status === 'idle' && (
            <div className="glass-panel flex-col items-center justify-center h-full text-center animate-slide-up" style={{ animationDelay: '0.2s', opacity: 0.7 }}>
              <ShieldAlert size={64} className="text-slate-600 mb-4" />
              <h2>No Data Yet</h2>
              <p>Enter your details and click analyze to discover your recurring chess weaknesses.</p>
            </div>
          )}

          {status === 'error' && (
            <div className="glass-panel border-red-500/50 bg-red-950/20 animate-slide-up">
              <h2 className="text-red-400">Analysis Failed</h2>
              <p className="text-red-200">{errorMsg}</p>
            </div>
          )}

          {status === 'done' && report.length > 0 && (
            <div className="flex-col gap-6 animate-slide-up" style={{ animationDelay: '0.3s' }}>
              <div className="glass-panel border-green-500/30 mb-6">
                <h2 className="text-green-400 m-0">Coaching Report Ready</h2>
                <p>Based on your last {gamesCount} games.</p>
              </div>

              {report.map((weakness, idx) => (
                <div key={idx} className="glass-panel mb-6 relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-1 h-full bg-primary"></div>
                  <h3 className="text-xl font-bold mb-3 flex items-center gap-2 text-primary">
                    <span className="bg-primary/20 text-primary w-8 h-8 rounded-full flex items-center justify-center text-sm">
                      {idx + 1}
                    </span>
                    {weakness.name.toUpperCase()}
                  </h3>
                  
                  <div className="mb-4">
                    <strong className="text-slate-300 block mb-1">Diagnosis:</strong>
                    <p>{weakness.diagnosis}</p>
                  </div>
                  
                  <div className="mb-4 bg-slate-800/50 p-3 rounded-md border border-slate-700/50">
                    <strong className="text-slate-300 block mb-1">Example:</strong>
                    <p className="text-sm font-mono text-slate-400">{weakness.example}</p>
                  </div>
                  
                  <div>
                    <strong className="text-emerald-400 block mb-1 flex items-center gap-2">
                      <ChevronRight size={16} /> Drill:
                    </strong>
                    <p className="text-emerald-100/80 bg-emerald-900/20 p-3 rounded-md border border-emerald-800/30">
                      {weakness.drill}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
