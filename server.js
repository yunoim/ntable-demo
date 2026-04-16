require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const roomsRouter = require('./routes/rooms');
const wsRouter = require('./routes/ws');

const app = express();

// CORS
app.use(cors({
  origin: ['https://demo.ntable.kr', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', authRouter);
app.use('/api', roomsRouter);

// Fallback: serve login.html for non-api routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// HTTP server (export for WebSocket in part2)
const server = http.createServer(app);

wsRouter.init(server);

const PORT = process.env.PORT || 3000;

// Init DB then start server
initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[server] Running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialize DB:', err);
    process.exit(1);
  });

module.exports = server;
