// server.js - Auto-detect SQLite (local) + PostgreSQL (Railway)
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const socketio = require('socket.io');
const multer = require('multer');
const bodyParser = require('body-parser');

const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);

const io = socketio(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Create directories
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Static + parsers
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ----------------------------
// DATABASE AUTO-DETECT SYSTEM
// ----------------------------

let dbType = "";
let pool = null;
let sqliteDB = null;

if (process.env.DATABASE_URL) {
  dbType = "postgres";
  console.log("📌 Using PostgreSQL (Railway)");

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  (async () => {
    try {
      await pool.query('SELECT 1');
      console.log('✅ PostgreSQL connected');
    } catch (err) {
      console.error('❌ PostgreSQL failed:', err);
    }
  })();

} else {
  dbType = "sqlite";
  console.log("📌 Using SQLite (Local)");

  sqliteDB = new sqlite3.Database('./local.db', (err) => {
    if (err) console.error(err);
    else console.log("✅ SQLite connected");
  });
}

// ------------------------------------
// CREATE TABLES (Works for both DBs)
// ------------------------------------

function createTables() {
  if (dbType === "postgres") {
    pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        profile_pic TEXT,
        usb_key TEXT
      );
    `);

    pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

  } else {
    sqliteDB.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        profile_pic TEXT,
        usb_key TEXT
      );
    `);

    sqliteDB.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}

createTables();

// ------------------------------------
// UNIVERSAL QUERY FUNCTION
// ------------------------------------
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (dbType === "postgres") {
      pool.query(sql, params)
        .then(result => resolve(result.rows))
        .catch(err => reject(err));
    } else {
      sqliteDB.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    }
  });
}

function runExecute(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (dbType === "postgres") {
      pool.query(sql, params)
        .then(result => resolve(result))
        .catch(err => reject(err));
    } else {
      sqliteDB.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    }
  });
}

// ------------------------------------
// IMAGE UPLOAD SETUP
// ------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ------------------------------------
// ROUTES
// ------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Register
app.post('/register', upload.single('profile_pic'), async (req, res) => {
  try {
    const { username, password, usb_key } = req.body;
    const profile_pic = req.file ? `/uploads/${req.file.filename}` : '';

    await runExecute(
      `INSERT INTO users(username,password,profile_pic,usb_key) VALUES(?,?,?,?)`,
      [username, password, profile_pic, usb_key || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Username exists" });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { username, password, usb_present } = req.body;

    const rows = await runQuery(
      `SELECT * FROM users WHERE username=? AND password=?`,
      [username, password]
    );

    const user = rows[0];
    if (!user) return res.json({ success: false, message: "Invalid login" });

    if (user.usb_key && !usb_present)
      return res.json({ success: false, message: "USB required" });

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// Get messages
app.get('/messages', async (req, res) => {
  try {
    const rows = await runQuery(`SELECT * FROM messages ORDER BY timestamp ASC`);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// Post message
app.post('/message', async (req, res) => {
  try {
    const { sender, message } = req.body;

    await runExecute(
      `INSERT INTO messages(sender,message) VALUES(?,?)`,
      [sender, message]
    );

    io.emit('newMessage', {
      sender,
      message,
      timestamp: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ------------------------------------
// SOCKET.IO
// ------------------------------------
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
    for (let u in onlineUsers) {
      if (onlineUsers[u] === socket.id) {
        delete onlineUsers[u];
        io.emit('updateOnline', Object.keys(onlineUsers));
      }
    }
  });
});

// ------------------------------------
// START SERVER
// ------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
