/**
 * API Routes — REST + WebSocket
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { Simulator, SCENARIOS } from '../simulation/Simulator';
import { AgentStateMachine } from '../state/AgentStateMachine';
import { CallStateMachine } from '../state/CallStateMachine';
import { SafetyController } from '../safety/SafetyController';
import { getDb } from '../db/index';

export const router = Router();
const simulator = new Simulator();
const agentSM = new AgentStateMachine();
const callSM = new CallStateMachine();
const safetyController = new SafetyController();
const db = getDb();

// WebSocket clients
let wsClients: Set<WebSocket> = new Set();

export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));

    // Send initial state
    ws.send(JSON.stringify({ type: 'connected', message: 'SmartDialer WebSocket connected' }));
  });

  // Wire simulator events to WebSocket
  simulator.on('worker_event', (data) => broadcast({ type: 'worker_event', ...data }));
  simulator.on('scenario_start', (data) => broadcast({ type: 'scenario_start', ...data }));
  simulator.on('scenario_change', (data) => broadcast({ type: 'scenario_change', ...data }));
  simulator.on('failure_demo', (data) => broadcast({ type: 'failure_demo', ...data }));

  // Broadcast live metrics every second
  setInterval(() => {
    const campaignId = simulator.getActiveCampaignId();
    if (!campaignId) return;

    const agentCounts = agentSM.getAgentCounts();
    const callCounts = callSM.getCallCounts();
    const totalAgents = Object.values(agentCounts).reduce((a, b) => a + b, 0);
    const busyAgents = agentCounts.CONNECTED + agentCounts.DIALING;
    const utilization = totalAgents > 0 ? (busyAgents / totalAgents) * 100 : 0;

    broadcast({
      type: 'metrics',
      timestamp: Date.now(),
      campaignId,
      agents: agentCounts,
      calls: callCounts,
      utilization: utilization.toFixed(1),
      workerStats: simulator.getActiveWorkerStats(),
    });
  }, 1000);
}

function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── GET /api/health ────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ── GET /api/scenarios ─────────────────────────────────────────────────────
router.get('/scenarios', (_req: Request, res: Response) => {
  res.json(SCENARIOS);
});

// ── POST /api/scenarios/:key/run ──────────────────────────────────────────
router.post('/scenarios/:key/run', async (req: Request, res: Response) => {
  try {
    const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
    const campaignId = await simulator.runScenario(key);
    res.json({ success: true, campaignId, scenario: key });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ── POST /api/scenarios/stop ──────────────────────────────────────────────
router.post('/scenarios/stop', (_req: Request, res: Response) => {
  simulator.stopAll();
  res.json({ success: true, message: 'All workers stopped' });
});

// ── GET /api/metrics/live ─────────────────────────────────────────────────
router.get('/metrics/live', (_req: Request, res: Response) => {
  const campaignId = simulator.getActiveCampaignId();
  const agentCounts = agentSM.getAgentCounts();
  const callCounts = callSM.getCallCounts();
  const totalAgents = Object.values(agentCounts).reduce((a, b) => a + b, 0);
  const busyAgents = agentCounts.CONNECTED + agentCounts.DIALING;
  const utilization = totalAgents > 0 ? (busyAgents / totalAgents) * 100 : 0;

  res.json({
    campaignId,
    agents: agentCounts,
    calls: callCounts,
    utilization: Number(utilization.toFixed(1)),
    workerStats: simulator.getActiveWorkerStats(),
    timestamp: Date.now(),
  });
});

// ── GET /api/metrics/history ──────────────────────────────────────────────
router.get('/metrics/history', (req: Request, res: Response) => {
  const campaignId = simulator.getActiveCampaignId();
  if (!campaignId) return res.json([]);
  const rows = db.prepare(`
    SELECT * FROM metrics WHERE campaign_id=? ORDER BY ts DESC LIMIT 200
  `).all(campaignId);
  res.json(rows.reverse());
});

// ── GET /api/safety/decisions ─────────────────────────────────────────────
router.get('/safety/decisions', (req: Request, res: Response) => {
  const campaignId = simulator.getActiveCampaignId();
  if (!campaignId) return res.json([]);
  const decisions = safetyController.getRecentDecisions(campaignId, 50);
  res.json(decisions);
});

// ── GET /api/agents ───────────────────────────────────────────────────────
router.get('/agents', (_req: Request, res: Response) => {
  const agents = db.prepare('SELECT * FROM agents ORDER BY status, name LIMIT 200').all();
  res.json(agents);
});

// ── GET /api/calls ────────────────────────────────────────────────────────
router.get('/calls', (_req: Request, res: Response) => {
  const calls = db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT 100').all();
  res.json(calls);
});

// ── POST /api/failure/worker-crash ────────────────────────────────────────
router.post('/failure/worker-crash', (_req: Request, res: Response) => {
  const result = simulator.simulateWorkerCrash();
  res.json({ success: true, message: result });
});

// ── POST /api/failure/provider-outage ────────────────────────────────────
router.post('/failure/provider-outage', (req: Request, res: Response) => {
  const provider = req.body.provider ?? 'A';
  const result = simulator.simulateProviderOutage(provider);
  res.json({ success: true, message: result });
});

// ── POST /api/failure/agent-dropout ──────────────────────────────────────
router.post('/failure/agent-dropout', (req: Request, res: Response) => {
  const count = Number(req.body.count ?? 10);
  const result = simulator.simulateAgentDropout(count);
  res.json({ success: true, message: result });
});

// ── POST /api/failure/add-agents ─────────────────────────────────────────
router.post('/failure/add-agents', (req: Request, res: Response) => {
  const count = Number(req.body.count ?? 10);
  const result = simulator.addAgents(count);
  res.json({ success: true, message: result });
});

// ── GET /api/providers/health ─────────────────────────────────────────────
router.get('/providers/health', (_req: Request, res: Response) => {
  // Access providers via simulator — simplified
  res.json({
    ProviderA: { name: 'ProviderA', type: 'fast-reliable' },
    ProviderB: { name: 'ProviderB', type: 'slow-unreliable' },
  });
});
