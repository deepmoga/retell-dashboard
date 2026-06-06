require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const { initDatabase, seedAdmin } = require('./database/db');
const { startSyncJob, setSocketIO: setSyncSocketIO } = require('./services/sync');
const { router: webhookRouter, setSocketIO: setWebhookSocketIO } = require('./webhooks/retell');
const { router: vapiWebhookRouter, setSocketIO: setVapiWebhookSocketIO } = require('./webhooks/vapi');

const authRoutes = require('./routes/auth');
const callRoutes = require('./routes/calls');
const leadRoutes = require('./routes/leads');
const costRoutes = require('./routes/costs');
const liveRoutes = require('./routes/live');
const clientRoutes = require('./routes/clients');
const appointmentRoutes = require('./routes/appointments');
const agentRoutes = require('./routes/agents');
const vapiToolRoutes = require('./routes/vapi-tools');

// --- Init ---
initDatabase();
seedAdmin();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Pass io to services
setSyncSocketIO(io);
setWebhookSocketIO(io);
setVapiWebhookSocketIO(io);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Parse cookies manually (lightweight)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      req.cookies[k.trim()] = decodeURIComponent(v.join('='));
    });
  }
  next();
});

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/costs', costRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/vapi-tools', vapiToolRoutes);

// Dashboard stats endpoint
const authMiddleware = require('./middleware/auth');
const { getDashboardStats } = require('./database/db');
app.get('/api/dashboard/stats', authMiddleware, (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;
    const stats = getDashboardStats(userId);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhooks (no auth)
app.use('/webhook/retell', webhookRouter);
app.use('/webhook/vapi', vapiWebhookRouter);

// --- SPA fallback for HTML pages ---
const pages = ['dashboard', 'calls', 'live', 'leads', 'costs', 'clients', 'settings', 'appointments', 'agents'];
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✓ Server running at http://localhost:${PORT}`);
  console.log(`✓ Login with: ${process.env.ADMIN_EMAIL || 'admin@yourdomain.com'}`);
  console.log(`✓ Webhook URL: http://localhost:${PORT}/webhook/retell\n`);
  startSyncJob();
});

module.exports = { app, io };
