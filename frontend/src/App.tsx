import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

const API_BASE = 'http://localhost:3001/api';
const WS_URL   = 'ws://localhost:3001/ws';

// ─── Types ────────────────────────────────────────────────────
interface AgentCounts {
  AVAILABLE: number; RESERVED: number; DIALING: number;
  CONNECTED: number; WRAP_UP: number; OFFLINE: number; PAUSED: number;
}
interface CallCounts {
  QUEUED: number; RESERVED: number; INITIATED: number; RINGING: number;
  ANSWERED: number; CONNECTED: number; COMPLETED: number; FAILED: number; CANCELLED: number;
}
interface Metrics {
  agents: AgentCounts;
  calls: CallCounts;
  utilization: string;
  workerStats: WorkerStat[];
  timestamp: number;
  campaignId?: string;
}
interface WorkerStat {
  workerId: string; isRunning: boolean; tickCount: number;
  callsStarted: number; callsFailed: number; agentsRecovered: number;
}
interface SafetyDecision {
  id: string; mode: string; requested_calls: number; approved_calls: number;
  safety_action: string; available_agents: number; connected_calls: number;
  ringing_calls: number; answer_rate: number; reasoning: string; created_at: number;
}
interface LogEntry {
  id: number; time: string; type: string; category: string; msg: string;
}

const SCENARIOS_INFO: Record<string, { name: string; answerRate: string; talkTime: string; color: string; mode: string; icon: string }> = {
  A: { name: 'Scenario A', answerRate: '20%', talkTime: '120s', color: '#f43f5e',  mode: 'predictive',  icon: '📉' },
  B: { name: 'Scenario B', answerRate: '50%', talkTime: '90s',  color: '#f59e0b',  mode: 'predictive',  icon: '📊' },
  C: { name: 'Scenario C', answerRate: '70%', talkTime: '180s', color: '#10b981',  mode: 'predictive',  icon: '📈' },
  D: { name: 'Scenario D', answerRate: 'Adaptive', talkTime: 'Adaptive', color: '#a855f7', mode: 'predictive', icon: '🔮' },
};

let _logId = 0;

export default function App() {
  const [wsConnected,     setWsConnected]     = useState(false);
  const [metrics,         setMetrics]         = useState<Metrics | null>(null);
  const [metricsHistory,  setMetricsHistory]  = useState<Array<{ time: number; utilization: number; ringing: number; connected: number }>>([]);
  const [safetyDecisions, setSafetyDecisions] = useState<SafetyDecision[]>([]);
  const [logs,            setLogs]            = useState<LogEntry[]>([]);
  const [activeScenario,  setActiveScenario]  = useState<string | null>(null);
  const [isRunning,       setIsRunning]       = useState(false);
  const [toasts,          setToasts]          = useState<Array<{ id: number; msg: string; type: string }>>([]);
  const [agentList,       setAgentList]       = useState<Array<{ id: string; name: string; status: string }>>([]);

  const wsRef  = useRef<WebSocket | null>(null);

  const addLog = useCallback((type: string, category: string, msg: string) => {
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    setLogs(prev => [{ id: _logId++, time, type, category, msg }, ...prev].slice(0, 300));
  }, []);

  const addToast = useCallback((msg: string, type = 'info') => {
    const id = _logId++;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  // ── WebSocket ──────────────────────────────────────────────
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen  = () => { setWsConnected(true);  addLog('SYS', 'system', '✅ Connected to SmartDialer WebSocket'); };
      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => setWsConnected(false);
      ws.onmessage = (e) => {
        try { handleWsMessage(JSON.parse(e.data)); } catch {}
      };
    }

    connect();
    return () => { clearTimeout(reconnectTimer); wsRef.current?.close(); };
  }, []);  // eslint-disable-line

  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    if (data.type === 'metrics') {
      const m = data as unknown as Metrics & { type: string };
      setMetrics(m);
      setMetricsHistory(prev => {
        const entry = {
          time: Date.now(),
          utilization: parseFloat(m.utilization),
          ringing:   (m.calls.RINGING || 0) + (m.calls.INITIATED || 0),
          connected: (m.calls.CONNECTED || 0) + (m.calls.ANSWERED || 0),
        };
        return [...prev, entry].slice(-60);
      });
    }

    if (data.type === 'worker_event') {
      const ev = (data as any).event as string;
      const d  = (data as any).data as any;
      if (ev === 'safety_decision') {
        const dec = d.decision;
        addLog(dec.action, 'safety', `${dec.action}: ${d.requested}→${dec.approvedCalls} | ${dec.reasoning?.[dec.reasoning.length - 1] || ''}`);
        fetchSafetyDecisions();
      } else if (ev === 'call_started')      { addLog('CALL', 'call', `Call started → Agent ${d.agentId?.slice(0,8)}`); }
        else if (ev === 'call_ended')        { addLog('END',  'call', `Call ended → ${d.event?.type}`); }
        else if (ev === 'duplicate_event')   { addLog('DUP',  'duplicate', `Duplicate ignored: ${d.event?.type} for ${d.callId?.slice(0,8)}`); }
        else if (ev === 'recovery')          { addLog('RECOVER', 'recovery', `Recovered ${d.recoveredAgents} agents, ${d.recoveredCalls} calls`); }
        else if (ev === 'worker_crashed')    { addLog('CRASH', 'failure', `Worker ${d.workerId} crashed`); }
    }

    if (data.type === 'scenario_start')  { addLog('START', 'system', `Scenario ${(data as any).scenarioKey} started`); setIsRunning(true); }
    if (data.type === 'scenario_change') { const msg = (data as any).message; addLog('CHG', 'system', msg); addToast(msg, 'warning'); }
    if (data.type === 'failure_demo') {
      const d = data as any;
      addLog('FAIL', 'failure', d.message);
      addToast(d.message, d.type?.includes('recovery') ? 'success' : 'warning');
    }
  }, [addLog, addToast]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.onmessage = (e) => { try { handleWsMessage(JSON.parse(e.data)); } catch {} };
  }, [handleWsMessage, wsConnected]);

  const fetchSafetyDecisions = async () => {
    try { const r = await fetch(`${API_BASE}/safety/decisions`); if (r.ok) setSafetyDecisions(await r.json()); } catch {}
  };

  const fetchAgents = async () => {
    try { const r = await fetch(`${API_BASE}/agents`); if (r.ok) setAgentList(await r.json()); } catch {}
  };

  useEffect(() => {
    const interval = setInterval(() => { fetchSafetyDecisions(); fetchAgents(); }, 2000);
    return () => clearInterval(interval);
  }, []);

  const runScenario = async (key: string) => {
    setActiveScenario(key);
    setIsRunning(true);
    setMetricsHistory([]);
    addLog('RUN', 'system', `Starting ${SCENARIOS_INFO[key].name}...`);
    try {
      const res  = await fetch(`${API_BASE}/scenarios/${key}/run`, { method: 'POST' });
      const data = await res.json();
      if (data.success) addToast(`${SCENARIOS_INFO[key].name} started!`, 'success');
    } catch {
      addToast('Failed to connect to backend', 'error');
      setIsRunning(false);
    }
  };

  const stopSimulation = async () => {
    await fetch(`${API_BASE}/scenarios/stop`, { method: 'POST' });
    setIsRunning(false);
    addLog('STOP', 'system', 'Simulation stopped');
    addToast('Simulation stopped', 'info');
  };

  const triggerFailure = async (endpoint: string, body: object, label: string) => {
    addLog('DEMO', 'failure', `Triggering: ${label}`);
    try {
      await fetch(`${API_BASE}/failure/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { addToast('Backend not connected', 'error'); }
  };

  const ag = metrics?.agents ?? { AVAILABLE: 0, RESERVED: 0, DIALING: 0, CONNECTED: 0, WRAP_UP: 0, OFFLINE: 0, PAUSED: 0 };
  const ca = metrics?.calls  ?? { QUEUED: 0, RESERVED: 0, INITIATED: 0, RINGING: 0, ANSWERED: 0, CONNECTED: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 };
  const totalAgents = Object.values(ag).reduce((a, b) => a + b, 0);
  const utilNum     = parseFloat(metrics?.utilization ?? '0');

  return (
    <div className="app">

      {/* ══ Header ════════════════════════════════════════════ */}
      <header className="header">
        <div className="header-logo">
          <div className="header-logo-icon">📞</div>
          <div>
            <div className="header-title">SmartDialer</div>
            <div className="header-subtitle">Predictive &amp; Progressive Call Intelligence</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {activeScenario && (
            <span className={`mode-badge ${SCENARIOS_INFO[activeScenario]?.mode}`}>
              {SCENARIOS_INFO[activeScenario]?.mode}
            </span>
          )}
          {isRunning && (
            <span className="running-badge">
              <span className="status-dot connected" style={{ animation: 'pulse 1s infinite' }} />
              Live
            </span>
          )}
          <div className="status-indicator">
            <span className={`status-dot ${wsConnected ? 'connected' : ''}`} />
            {wsConnected ? 'WebSocket Live' : 'Disconnected'}
          </div>
        </div>
      </header>

      <div className="main-content">

        {/* ══ Sidebar ══════════════════════════════════════════ */}
        <aside className="sidebar">

          {/* Scenarios */}
          <div>
            <div className="section-label">⚡ Scenarios</div>
            {Object.entries(SCENARIOS_INFO).map(([key, info]) => (
              <button
                key={key}
                className={`scenario-btn ${activeScenario === key ? 'active' : ''}`}
                onClick={() => runScenario(key)}
                id={`scenario-btn-${key}`}
                style={{ marginBottom: 6 }}
              >
                <div className="scenario-btn-label">
                  <span style={{ marginRight: 6 }}>{info.icon}</span>
                  <span style={{ color: info.color }}>●</span>
                  {' '}{info.name}
                </div>
                <div className="scenario-btn-sub">
                  AR: {info.answerRate} · Talk: {info.talkTime} · {info.mode}
                </div>
              </button>
            ))}
            {isRunning && (
              <button
                className="btn btn-danger btn-sm"
                style={{ width: '100%', marginTop: 6 }}
                onClick={stopSimulation}
                id="stop-btn"
              >
                ⏹ Stop Simulation
              </button>
            )}
          </div>

          {/* Failure Demos */}
          <div>
            <div className="section-label">💥 Failure Demos</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="failure-btn red" id="fail-worker-crash"
                onClick={() => triggerFailure('worker-crash', {}, 'Worker Crash')}>
                💥 Worker Crash
              </button>
              <button className="failure-btn red" id="fail-outage-a"
                onClick={() => triggerFailure('provider-outage', { provider: 'A' }, 'Provider A Outage')}>
                🔴 Provider A Outage
              </button>
              <button className="failure-btn red" id="fail-outage-b"
                onClick={() => triggerFailure('provider-outage', { provider: 'B' }, 'Provider B Outage')}>
                🔴 Provider B Outage
              </button>
              <button className="failure-btn yellow" id="fail-agent-dropout"
                onClick={() => triggerFailure('agent-dropout', { count: 10 }, 'Agent Dropout (10)')}>
                👤 Agent Dropout (10)
              </button>
              <button className="failure-btn green" id="add-agents"
                onClick={() => triggerFailure('add-agents', { count: 10 }, 'Add 10 Agents')}>
                ✚ Add 10 Agents
              </button>
            </div>
          </div>

          {/* Workers */}
          <div>
            <div className="section-label">⚙️ Workers</div>
            {metrics?.workerStats?.length ? (
              metrics.workerStats.map(w => (
                <div key={w.workerId} className="worker-stat">
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', marginBottom: 4 }}>
                    Worker {w.workerId}
                    <span style={{ marginLeft: 8, color: w.isRunning ? 'var(--accent-green)' : 'var(--accent-red)', fontSize: '0.62rem' }}>
                      {w.isRunning ? '● RUNNING' : '● STOPPED'}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    Calls: {w.callsStarted} started / {w.callsFailed} failed
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    Recovered: {w.agentsRecovered} agents
                  </div>
                </div>
              ))
            ) : (
              <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                No active workers.<br />Run a scenario to begin.
              </div>
            )}
          </div>
        </aside>

        {/* ══ Dashboard ════════════════════════════════════════ */}
        <main className="dashboard-area">

          {/* Hero Banner */}
          <div className="hero-card">
            <div className="hero-left">
              <h2>
                {activeScenario
                  ? `${SCENARIOS_INFO[activeScenario].icon} ${SCENARIOS_INFO[activeScenario].name} — Active`
                  : '🚀 SmartDialer Control Center'}
              </h2>
              <p>
                {activeScenario
                  ? `Running ${SCENARIOS_INFO[activeScenario].mode} mode · AR: ${SCENARIOS_INFO[activeScenario].answerRate} · Avg Talk: ${SCENARIOS_INFO[activeScenario].talkTime}`
                  : 'Predictive & Progressive call pacing with Safety Controller, concurrent workers, and real-time state machine resilience.'}
              </p>
              <div className="hero-badges">
                <span className="hero-badge purple">EWMA Pacing</span>
                <span className="hero-badge pink">Safety Controller</span>
                <span className="hero-badge green">Stale Recovery</span>
                {isRunning && <span className="hero-badge purple">● Live Simulation</span>}
              </div>
            </div>
            <div className="hero-right">
              <div className="hero-stat">
                <div className="hero-stat-value">{utilNum.toFixed(0)}%</div>
                <div className="hero-stat-label">Utilization</div>
              </div>
              <div className="hero-stat">
                <div className="hero-stat-value">{ca.COMPLETED}</div>
                <div className="hero-stat-label">Completed</div>
              </div>
              <div className="hero-stat">
                <div className="hero-stat-value">{totalAgents}</div>
                <div className="hero-stat-label">Total Agents</div>
              </div>
            </div>
          </div>

          {/* Metric Cards */}
          <div className="metrics-grid">
            <MetricCard
              icon="📊" label="Agent Utilization" value={`${utilNum.toFixed(1)}%`}
              sub={`${ag.CONNECTED + ag.DIALING} / ${totalAgents} agents busy`}
              accentColor="var(--accent-purple)" progressValue={utilNum}
            />
            <MetricCard
              icon="📞" label="Calls Connected" value={ca.CONNECTED + ca.ANSWERED}
              sub={`${ca.RINGING + ca.INITIATED} ringing now`}
              accentColor="var(--accent-blue)"
            />
            <MetricCard
              icon="✅" label="Calls Completed" value={ca.COMPLETED}
              sub={`${ca.FAILED} failed · ${ca.CANCELLED} cancelled`}
              accentColor="var(--accent-green)"
            />
            <MetricCard
              icon="👥" label="Available Agents" value={ag.AVAILABLE}
              sub={`${ag.RESERVED + ag.DIALING} reserved/dialing`}
              accentColor="var(--accent-cyan)"
            />
          </div>

          {/* Agent States + Chart */}
          <div className="grid-2">
            {/* Agent Visual Grid */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">👤 Agent States
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                    ({totalAgents} total)
                  </span>
                </div>
              </div>
              <div className="agent-legend">
                {([
                  ['AVAILABLE', 'var(--state-available)'],
                  ['RESERVED',  'var(--state-reserved)'],
                  ['DIALING',   'var(--state-dialing)'],
                  ['CONNECTED', 'var(--state-connected)'],
                  ['WRAP_UP',   'var(--state-wrap-up)'],
                  ['OFFLINE',   'var(--state-offline)'],
                ] as [string, string][]).map(([status, color]) => (
                  <div key={status} className="legend-item">
                    <div className="legend-dot" style={{ background: color }} />
                    <span>{status} ({((ag as unknown) as Record<string, number>)[status] ?? 0})</span>
                  </div>
                ))}
              </div>
              <div className="agent-grid">
                {agentList.slice(0, 100).map(agent => (
                  <div
                    key={agent.id}
                    className={`agent-dot ${agent.status}`}
                    title={`${agent.name} — ${agent.status}`}
                  >
                    {agent.status === 'AVAILABLE' ? '✓' :
                     agent.status === 'CONNECTED' ? '📞' :
                     agent.status === 'DIALING'   ? '↗' :
                     agent.status === 'WRAP_UP'   ? '✍' :
                     agent.status === 'OFFLINE'   ? '○' : '●'}
                  </div>
                ))}
                {agentList.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', gridColumn: '1/-1', padding: '1rem 0' }}>
                    Run a scenario to see agents populate...
                  </div>
                )}
              </div>
            </div>

            {/* Live Neon Chart */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">📈 Live Metrics</div>
                <div style={{ display: 'flex', gap: 12, fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  <span><span style={{ color: '#a855f7' }}>—</span> Util %</span>
                  <span><span style={{ color: '#6366f1' }}>---</span> Ringing</span>
                  <span><span style={{ color: '#22d3ee' }}>—</span> Connected</span>
                </div>
              </div>
              <NeonLineChart data={metricsHistory} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
                <StatPill label="Ringing"   value={ca.RINGING + ca.INITIATED}      color="var(--accent-blue)" />
                <StatPill label="Connected" value={ca.CONNECTED + ca.ANSWERED}     color="var(--accent-purple)" />
                <StatPill label="Completed" value={ca.COMPLETED}                   color="var(--accent-green)" />
              </div>
            </div>
          </div>

          {/* Safety + Event Log */}
          <div className="grid-2">

            {/* Safety Controller */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">🛡️ Safety Controller Decisions</div>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Last 20</span>
              </div>
              <div className="safety-decisions">
                {safetyDecisions.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', padding: '1rem 0' }}>
                    No decisions yet. Start a scenario.
                  </div>
                )}
                {safetyDecisions.slice(0, 20).map(d => (
                  <div key={d.id} className="safety-item">
                    <span className={`safety-badge ${d.safety_action}`}>{d.safety_action}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'var(--text-primary)', fontSize: '0.77rem' }}>
                        {d.requested_calls}→{d.approved_calls} calls &nbsp;|&nbsp;
                        AR: {(d.answer_rate * 100).toFixed(0)}% &nbsp;|&nbsp;
                        Avail: {d.available_agents}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.67rem', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {JSON.parse(d.reasoning || '[]').slice(-1)[0] ?? '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Event Stream */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">📋 Event Stream</div>
                <button
                  className="btn btn-sm"
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.7rem' }}
                  onClick={() => setLogs([])}
                >
                  Clear
                </button>
              </div>
              <div className="event-log" id="event-log">
                {logs.map(entry => (
                  <div key={entry.id} className="log-entry">
                    <span className="log-time">{entry.time}</span>
                    <span className={`log-type ${entry.category}`}>{entry.type}</span>
                    <span className="log-msg">{entry.msg}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>Waiting for events...</div>
                )}
              </div>
            </div>
          </div>

          {/* Call State Summary */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">📞 Call State Breakdown</div>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Real-time from state machine</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 8 }}>
              {Object.entries(ca).map(([status, count]) => (
                <CallStatePill key={status} status={status} count={count as number} />
              ))}
            </div>
          </div>

        </main>
      </div>

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === 'error' ? '❌' : t.type === 'success' ? '✅' : t.type === 'warning' ? '⚠️' : 'ℹ️'}</span>
            <span style={{ color: 'var(--text-primary)' }}>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

function MetricCard({ icon, label, value, sub, accentColor, progressValue }: {
  icon: string; label: string; value: string | number; sub: string; accentColor: string; progressValue?: number;
}) {
  return (
    <div className="metric-card" style={{ '--accent-color': accentColor } as React.CSSProperties}>
      <span className="metric-icon">{icon}</span>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color: accentColor }}>{value}</div>
      <div className="metric-sub">{sub}</div>
      {progressValue !== undefined && (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${Math.min(progressValue, 100)}%`, background: accentColor }} />
        </div>
      )}
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm)',
      padding: '8px 10px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '1.25rem', fontWeight: 800, color, letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function CallStatePill({ status, count }: { status: string; count: number }) {
  const palette: Record<string, string> = {
    QUEUED: '#5c5278', RESERVED: '#f59e0b', INITIATED: '#6366f1', RINGING: '#22d3ee',
    ANSWERED: '#a855f7', CONNECTED: '#a855f7', COMPLETED: '#10b981', FAILED: '#f43f5e', CANCELLED: '#374151',
  };
  const c = palette[status] ?? '#5c5278';
  return (
    <div style={{
      background: `${c}18`,
      border: `1px solid ${c}45`,
      borderRadius: 'var(--r-sm)',
      padding: '10px 6px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: c, lineHeight: 1, marginBottom: 4 }}>{count}</div>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{status}</div>
    </div>
  );
}

function NeonLineChart({ data }: { data: Array<{ time: number; utilization: number; ringing: number; connected: number }> }) {
  if (data.length < 2) {
    return (
      <div style={{
        height: 150,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: '0.8rem', gap: 8,
        background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--r-sm)', border: '1px dashed var(--border)',
      }}>
        <span style={{ fontSize: '1.5rem' }}>📡</span>
        Start a scenario to see live metrics
      </div>
    );
  }

  const W = 500, H = 150;
  const pad = { top: 12, right: 12, bottom: 20, left: 32 };
  const iW = W - pad.left - pad.right;
  const iH = H - pad.top - pad.bottom;

  const maxUtil  = 100;
  const maxCount = Math.max(...data.map(d => Math.max(d.ringing, d.connected)), 1);

  const makePath = (vals: number[], max: number) =>
    data.map((_, i) => {
      const x = pad.left + (i / (data.length - 1)) * iW;
      const y = pad.top + iH - (vals[i] / max) * iH;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');

  const utilPath     = makePath(data.map(d => d.utilization), maxUtil);
  const ringingPath  = makePath(data.map(d => d.ringing), maxCount);
  const connectedPath= makePath(data.map(d => d.connected), maxCount);

  // area fill for util
  const firstX = pad.left;
  const lastX  = pad.left + iW;
  const baseY  = pad.top + iH;
  const areaPath = `${utilPath} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}>
      <defs>
        <linearGradient id="utilArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#a855f7" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
        </linearGradient>
        <filter id="glow-purple">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="glow-blue">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Grid lines */}
      {[0.25, 0.5, 0.75, 1].map(r => (
        <line key={r}
          x1={pad.left} y1={pad.top + iH * (1 - r)}
          x2={pad.left + iW} y2={pad.top + iH * (1 - r)}
          stroke="rgba(139,92,246,0.08)" strokeWidth="1"
        />
      ))}

      {/* Y axis labels */}
      {[0, 50, 100].map(v => (
        <text key={v}
          x={pad.left - 4} y={pad.top + iH - (v / 100) * iH + 4}
          textAnchor="end" fontSize="9" fill="rgba(139,92,246,0.4)" fontFamily="JetBrains Mono, monospace"
        >{v}%</text>
      ))}

      {/* Area fill */}
      <path d={areaPath} fill="url(#utilArea)" />

      {/* Utilization neon line */}
      <path d={utilPath} fill="none" stroke="#a855f7" strokeWidth="2.5" strokeLinejoin="round" filter="url(#glow-purple)" />

      {/* Ringing dashed */}
      <path d={ringingPath} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="5,3" strokeLinejoin="round" filter="url(#glow-blue)" />

      {/* Connected line */}
      <path d={connectedPath} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
