// server.js - PostgreSQL primary, Railway-ready
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const socketio = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ------------------------
// DIRECTORIES
// ------------------------
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ------------------------
// STATIC + BODY PARSER
// ------------------------
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ------------------------
// POSTGRESQL SETUP
// ------------------------
if (!process.env.DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL not set. Server will not connect to PostgreSQL.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------------
// CREATE TABLES
// ------------------------
(async function createTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        profile_pic TEXT,
        usb_key TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ PostgreSQL tables ready');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
})();

// ------------------------
// UNIVERSAL QUERY FUNCTIONS
// ------------------------
async function runQuery(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    return res.rows;
  } catch (err) {
    console.error('DB query error:', err);
    throw err;
  }
}

async function runExecute(sql, params = []) {
  try {
    await pool.query(sql, params);
  } catch (err) {
    console.error('DB execute error:', err);
    throw err;
  }
}

// ------------------------
// IMAGE UPLOAD
// ------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ------------------------
// ROUTES
// ------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// REGISTER
app.post('/register', upload.single('profile_pic'), async (req, res) => {
  try {
    const { username, password, usb_key } = req.body;
    const profile_pic = req.file ? `/uploads/${req.file.filename}` : '';

    await runExecute(
      `INSERT INTO users(username,password,profile_pic,usb_key) VALUES($1,$2,$3,$4)`,
      [username, password, profile_pic, usb_key || null]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: "Username exists or invalid data" });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { username, password, usb_present } = req.body;
    const rows = await runQuery(
      `SELECT * FROM users WHERE username=$1 AND password=$2`,
      [username, password]
    );
    const user = rows[0];
    if (!user) return res.status(400).json({ success: false, message: "Invalid username/password" });
    if (user.usb_key && !usb_present) return res.status(400).json({ success: false, message: "USB not inserted" });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET MESSAGES
app.get('/messages', async (req, res) => {
  try {
    const rows = await runQuery(`SELECT * FROM messages ORDER BY timestamp ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// POST MESSAGE
app.post('/message', async (req, res) => {
  try {
    const { sender, message } = req.body;
    await runExecute(
      `INSERT INTO messages(sender,message) VALUES($1,$2)`,
      [sender, message]
    );

    io.emit('newMessage', { sender, message, timestamp: new Date() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ------------------------
// SOCKET.IO
// ------------------------
let onlineUsers = {};

io.on('connection', (socket) => {
  socket.on('userOnline', (username) => {
    if (Object.keys(onlineUsers).length < 4) {
      onlineUsers[username] = socket.id;
      io.emit('updateOnline', Object.keys(onlineUsers));
    }
  });

  socket.on('userTyping', (username) => {
    socket.broadcast.emit('userTyping', username);
  });

  socket.on('disconnect', () => {
    for (const u in onlineUsers) {
      if (onlineUsers[u] === socket.id) {
        delete onlineUsers[u];
        io.emit('updateOnline', Object.keys(onlineUsers));
      }
    }
  });
});

// ------------------------
// START SERVER
// ------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
