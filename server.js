require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const roomsRouter = require('./routes/rooms');
const wsRouter = require('./routes/ws');
const adminRouter = require('./routes/admin');
const surveyRouter = require('./routes/survey');
const aiRouter = require('./routes/ai');
const panelRouter = require('./routes/panel');

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
app.use('/api', adminRouter);
app.use('/api', surveyRouter);
app.use('/api', aiRouter);
app.use('/api', panelRouter);

// Page routes
app.get('/room/:code/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});
app.get('/survey', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey.html'));
});
app.get('/result', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'result.html'));
});
app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback: serve login.html for non-api routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// HTTP server
const server = http.createServer(app);

wsRouter.init(server);
adminRouter.init(require('./db').pool, wsRouter);

const PORT = process.env.PORT || 8080;

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
