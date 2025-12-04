const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const socketio = require('socket.io');
const multer = require('multer');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// SQLite DB
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite DB');
});

// Tables
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  profile_pic TEXT,
  usb_key TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Multer for profile pics
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './public/uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Register
app.post('/register', upload.single('profile_pic'), (req, res) => {
  const { username, password, usb_key } = req.body;
  const profile_pic = req.file ? `/uploads/${req.file.filename}` : '';
  db.run('INSERT INTO users(username,password,profile_pic,usb_key) VALUES(?,?,?,?)',
    [username, password, profile_pic, usb_key||null],
    function(err){
      if(err) return res.status(400).json({success:false,message:'Username already exists'});
      res.json({success:true});
    });
});

// Login
app.post('/login', (req,res)=>{
  const {username,password,usb_present} = req.body;
  db.get('SELECT * FROM users WHERE username=? AND password=?',[username,password],(err,user)=>{
    if(err) return res.status(500).json({success:false,message:'Server error'});
    if(!user) return res.status(400).json({success:false,message:'Invalid username/password'});
    if(user.usb_key && !usb_present) return res.status(400).json({success:false,message:'USB not inserted'});
    res.json({success:true,user});
  });
});

// Get messages
app.get('/messages',(req,res)=>{
  db.all('SELECT * FROM messages ORDER BY timestamp ASC',[],(err,rows)=>{
    if(err) return res.status(500).json({success:false,message:'Server error'});
    res.json(rows);
  });
});

// Post message
app.post('/message',(req,res)=>{
  const {sender,message} = req.body;
  db.run('INSERT INTO messages(sender,message) VALUES(?,?)',[sender,message],function(err){
    if(err) return res.status(500).json({success:false,message:'Server error'});
    io.emit('newMessage',{sender,message,timestamp:new Date()});
    res.json({success:true});
  });
});

// Socket.io
let onlineUsers={};
io.on('connection',(socket)=>{
  socket.on('userOnline',(username)=>{
    if(Object.keys(onlineUsers).length < 4){ // Max 4 users
      onlineUsers[username]=socket.id;
      io.emit('updateOnline',Object.keys(onlineUsers));
    }
  });
  socket.on('userTyping',(username)=>{
    socket.broadcast.emit('userTyping',username);
  });
  socket.on('disconnect',()=>{
    for(let u in onlineUsers){
      if(onlineUsers[u]===socket.id){
        delete onlineUsers[u];
        io.emit('updateOnline',Object.keys(onlineUsers));
        break;
      }
    }
  });
});

server.listen(PORT,()=>console.log(`Server running on http://localhost:${PORT}`));
