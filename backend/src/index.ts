/**
 * SmartDialer Backend — Entry Point
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import { router, initWebSocket } from './api/routes';

const PORT = process.env.PORT ?? 3001;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Mount API routes
app.use('/api', router);

// Root health check
app.get('/', (_req, res) => {
  res.json({
    name: 'SmartDialer API',
    version: '1.0.0',
    docs: 'See README.md for API documentation',
    timestamp: Date.now(),
  });
});

const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  console.log(`\n🚀 SmartDialer backend running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`📊 API docs: http://localhost:${PORT}/api/health\n`);
});

export default app;
