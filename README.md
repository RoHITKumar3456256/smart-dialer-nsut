# 📞 SmartDialer — Predictive & Progressive Call Pacing Engine

> **Tech Assignment Submission** — A production-grade prototype of an intelligent call dialing system with real-time state management, safety controls, and multi-worker concurrency.

---

## 🎯 What Is This?

SmartDialer solves a classic call-center problem: **agents sitting idle while phones are ringing unanswered, or calls being dropped because agents are overloaded.**

It implements two dialing modes with a live safety layer:

| Mode | How it works |
|------|-------------|
| **Progressive** | 1 call per available agent — safe, predictable |
| **Predictive** | Uses EWMA answer-rate tracking to launch multiple calls ahead of availability — maximizes utilization |

The system includes a **real-time React dashboard** that shows everything happening — agents transitioning states, calls being placed, safety controller decisions, and worker health — all live via WebSocket.

---

## ✨ Key Features

### 1. 🧠 Dual Pacing Engine
- **Progressive Mode**: `callsToStart = min(availableAgents, pendingBorrowers)` — safe 1:1 dialing
- **Predictive Mode**: Uses **EWMA (Exponentially Weighted Moving Average)** on answer rates:
  ```
  callsNeeded = targetConnected / answerRate
  newCalls    = callsNeeded - alreadyRinging - alreadyConnected
  ```
  Smooths out sudden answer rate swings without wild overcorrection

### 2. 🛡️ Safety Controller (Hard Guardrails)
Every pacing decision goes through a safety layer **before** any call is placed:
- Never exceed **1.5× oversubscription ratio** (configurable)
- Automatically **REDUCE** or **REJECT** if too many calls are already ringing
- Falls back to progressive mode under uncertainty
- Every decision is logged to DB with full reasoning

### 3. ⚡ Concurrent Multi-Worker Architecture
Multiple workers run in parallel, each independently polling the DB for work:
- **Optimistic Concurrency Control** prevents double-allocation:
  ```sql
  UPDATE agents SET status='RESERVED', version=version+1
  WHERE id=? AND status='AVAILABLE'
  -- Only 1 worker succeeds if both try simultaneously
  ```
- Workers are isolated — a crash in one doesn't affect others
- Simulates a distributed system on a single SQLite database

### 4. 🔄 Robust Call State Machine
Handles the real-world messiness of telecom provider events:

```
QUEUED → RESERVED → INITIATED → RINGING → ANSWERED → CONNECTED → COMPLETED
                                                                 → FAILED
                                                                 → CANCELLED
```

- **Out-of-order events** (e.g., `RINGING` arriving after `COMPLETED`): **silently ignored**
- **Duplicate events** (same state twice): **idempotent — no-op**
- **Provider idempotency keys** prevent double-recording the same event

### 5. 🏥 Automatic Recovery
- Heartbeat monitoring on all workers
- Stale calls stuck in `INITIATED`/`RINGING` automatically recovered → `FAILED`
- Agents freed back to `AVAILABLE` after recovery
- Worker crash resilience demonstrated live in UI

### 6. 🎭 Mock Telecom Providers
Two providers (A and B) with configurable behaviors:
- **Provider A**: Reliable, ordered events, 500ms avg setup time  
- **Provider B**: Occasionally sends **duplicate ANSWERED** events, **out-of-order completions** — the state machine handles all of it

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   React Frontend (Vite)                  │
│         Dashboard  ←──── WebSocket ────→  REST API       │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP + WS
┌──────────────────────────▼──────────────────────────────┐
│                 Express API Server (:3001)               │
│                                                         │
│   ┌─────────────┐    ┌──────────────────────────────┐   │
│   │   Pacing    │    │      Safety Controller       │   │
│   │   Engine    │──→ │  (Approve / Reduce / Reject) │   │
│   │Progressive  │    └──────────────┬───────────────┘   │
│   │Predictive   │                   │                   │
│   └─────────────┘    ┌──────────────▼───────────────┐   │
│                      │       Call Allocator          │   │
│                      │  (Atomic SQL concurrency)     │   │
│                      └──────────────┬───────────────┘   │
│                                     │                   │
│   ┌──────────┐  ┌──────────┐        │                   │
│   │ Worker 1 │  │ Worker 2 │◄───────┘                   │
│   └────┬─────┘  └────┬─────┘                           │
│        │              │                                  │
│   ┌────▼──────────────▼────┐                           │
│   │    SQLite (WAL Mode)    │                           │
│   │  agents · calls · etc  │                           │
│   └────────────────────────┘                           │
│                                                         │
│   ┌─────────────┐    ┌─────────────┐                   │
│   │  Provider A │    │  Provider B │  (Mock Telecom)   │
│   │  (Reliable) │    │  (Quirky)   │                   │
│   └─────────────┘    └─────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

### Database Schema (SQLite WAL)
| Table | Purpose |
|-------|---------|
| `campaigns` | Campaign config (mode, oversubscription limit) |
| `agents` | Agent state + optimistic version counter |
| `borrowers` | Lead/contact list with status tracking |
| `calls` | Full call lifecycle with timestamps |
| `call_events` | Raw provider events with idempotency keys |
| `pacing_decisions` | Every safety decision with reasoning |

---

## 🗂️ Project Structure

```
smart-dialer-nsut/
├── backend/
│   ├── src/
│   │   ├── api/          # Express routes + WebSocket broadcaster
│   │   ├── allocator/    # Atomic call+agent reservation logic
│   │   ├── db/           # SQLite setup, WAL mode, schema
│   │   ├── pacing/       # ProgressiveEngine + PredictiveEngine (EWMA)
│   │   ├── providers/    # Mock Provider A (reliable) & B (quirky)
│   │   ├── safety/       # SafetyController — hard guardrails
│   │   ├── simulation/   # Scenario runner (A/B/C/D from PDF)
│   │   ├── state/        # AgentStateMachine + CallStateMachine
│   │   ├── workers/      # Concurrent DialerWorker instances
│   │   └── index.ts      # Entry point
│   └── tests/
│       ├── simulation.test.ts    # Predictive engine + EWMA tests
│       ├── stateMachine.test.ts  # OOO events, idempotency, recovery
│       ├── safetyController.test.ts # Guardrail logic tests
│       └── concurrency.test.ts   # Concurrent worker collision tests
├── frontend/
│   └── src/
│       ├── App.tsx        # Dashboard UI with live charts
│       └── index.css      # Premium dark design system
├── docs/
│   └── ARCHITECTURE.md   # Deep-dive design decisions + diagrams
└── README.md             # This file
```

---

## 🚀 Setup & Running

[![SmartDialer CI](https://github.com/RoHITKumar3456256/smart-dialer-nsut/actions/workflows/ci.yml/badge.svg)](https://github.com/RoHITKumar3456256/smart-dialer-nsut/actions/workflows/ci.yml)

### Option A — One-Click Docker Startup (Recommended)

```bash
docker compose up --build
```
- Frontend Dashboard: `http://localhost:5173`
- Backend REST API: `http://localhost:3001`
- WebSocket Server: `ws://localhost:3001/ws`

---

### Option B — Local Node.js Startup

#### Prerequisites
- **Node.js v18+** ([download](https://nodejs.org))
- npm

#### Step 1 — Start the Backend

```bash
cd backend
npm install
npm run dev
```

Backend starts at → `http://localhost:3001`  
WebSocket at → `ws://localhost:3001/ws`

### Step 2 — Start the Frontend

```bash
# New terminal window
cd frontend
npm install
npm run dev
```

Open → **`http://localhost:5173`**

### Step 3 — Run All Tests & Benchmarks

```bash
cd backend
npm test         # Run all 35 unit, integration & load tests
npm run test:load # Run dedicated 500-agent load test benchmark
```

Expected: ✅ **35 tests pass** across 5 test files

---

## 🧪 Test Coverage & Benchmarks

| Test File | What It Tests |
|-----------|--------------|
| `simulation.test.ts` | EWMA smoothing, pacing math, answer-rate floor protection |
| `stateMachine.test.ts` | Out-of-order events, duplicate idempotency, stale recovery |
| `safetyController.test.ts` | Oversubscription limits, APPROVE/REDUCE/REJECT logic |
| `concurrency.test.ts` | Two workers trying to reserve the same agent simultaneously |
| `load.test.ts` | **50 workers, 500 agents, 1000 borrowers load benchmark (101 allocations/sec, 0 collisions)** |

> 📚 **Looking for Technical Discussion & Interview Q&A?**  
> See [docs/INTERVIEW_DEFENSE.md](docs/INTERVIEW_DEFENSE.md) for deep-dive answers to all scale, cache-invalidation, and failure-mode interview questions.

---

## 🎬 Running Demo Scenarios

Once both servers are running, open the dashboard and click a scenario:

| Scenario | Answer Rate | Talk Time | Tests |
|----------|-------------|-----------|-------|
| **A** | 20% (low) | 120s | Predictive scales up aggressively to compensate |
| **B** | 50% (medium) | 90s | Balanced predictive pacing |
| **C** | 70% (high) | 180s | Conservative pacing, high utilization |
| **D** | Adaptive | Changing | EWMA reacts to mid-run rate changes |

### Failure Demos (Test Resilience)
Click these in the sidebar to see recovery in action:
- **💥 Worker Crash** — one worker dies; system continues; stale calls recovered
- **🔴 Provider A/B Outage** — simulates call failures, state machine stays consistent
- **👤 Agent Dropout** — 10 agents go offline; safety controller auto-adjusts
- **✚ Add Agents** — 10 new agents join; pacing engine immediately utilizes them

---

## 🧠 Design Decisions

### Why SQLite instead of PostgreSQL?
SQLite in **WAL mode** allows concurrent readers + single writer, making it perfect for demonstrating atomic state transitions locally without infra overhead. In production: replace with PostgreSQL + Redis.

### Why EWMA for answer rate?
Simple moving average reacts too violently to single-call spikes. EWMA (α=0.2) gives 80% weight to historical data and 20% to new observations — smoothly adapting without wild oscillations.

### Why a separate Safety Controller?
The pacing engine is an optimizer — it can propose risky numbers. The Safety Controller is a **separate, auditable layer** with hard ceilings that cannot be bypassed. This separation ensures production safety even if the algorithm has a bug.

### Scale Bottleneck at 10,000 Agents?
The first thing to break: **SQLite write contention** on agent status updates.  
Fix: Move ephemeral state (agent/call status) to **Redis**, use **Kafka** for the work queue, and keep SQLite/Postgres only for durable records.

### Utilization vs. Safety Trade-off?
**Answer**: Dynamic hybrid model.
- Start in **Progressive** mode (safe, deterministic)
- Switch to **Predictive** as data accumulates (efficient, EWMA-smoothed)
- Safety Controller acts as a **non-negotiable hard ceiling** regardless of mode
- The predictive engine is advisory; the Safety Controller is law

---

## 📊 Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Backend | **Node.js + TypeScript** | Type-safe, fast async I/O |
| Framework | **Express v5** | Stable, lightweight routing |
| Database | **SQLite (better-sqlite3, WAL)** | ACID + concurrent reads, zero infra |
| Real-time | **WebSocket (ws)** | Low-latency live metrics push |
| Frontend | **React + Vite + TypeScript** | Fast HMR, type-safe components |
| Testing | **Vitest** | Fast, ESM-native test runner |

---

*Built for the SmartDialer Tech Assignment — demonstrating distributed system design, concurrent state management, and production-grade resilience patterns.*
