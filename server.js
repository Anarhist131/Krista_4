// server.js — Криста 8
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ========== Папки ==========
['public/avatars', 'public/files', 'public/music'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ========== Rate Limiter (защита от перебора) ==========
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 мин
  max: 100,
  message: 'Слишком много запросов, попробуйте позже'
});
app.use('/api/', limiter);
app.use('/upload/', limiter);

// ========== MULTER ==========
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/avatars'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.body.userId + '_avatar' + ext);
  }
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 2 * 1024 * 1024 } });

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/files'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadFile = multer({ storage: fileStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const musicStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/music'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '.ogg');
  }
});
const uploadMusic = multer({
  storage: musicStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'audio/ogg' || file.mimetype === 'application/ogg') {
      cb(null, true);
    } else {
      cb(new Error('Только OGG-файлы'), false);
    }
  }
});

// ========== МОДЕЛИ MONGODB ==========
const userSchema = new mongoose.Schema({
  uin: { type: String, unique: true },
  nick: String,
  description: { type: String, default: '' },
  avatar: { type: String, default: '' },
  passwordHash: String,
  token: String,
  lastSeen: Date,
  blockedUsers: [String],
  contacts: [String] // UIN'ы контактов
});
const User = mongoose.model('User', userSchema);

const roomSchema = new mongoose.Schema({
  id: { type: String, unique: true },    // Nano ID
  name: String,
  type: { type: String, enum: ['chat', 'channel'], default: 'chat' },
  creator: String,                       // UIN создателя
  admins: [String],
  participants: [String],
  messages: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    createdAt: { type: Date, default: Date.now },
    time: String,                        // HH:MM для отображения
    user: String,
    userId: String,
    text: String,
    fileUrl: String,
    edited: { type: Boolean, default: false }
  }]
});
const Room = mongoose.model('Room', roomSchema);

const musicSchema = new mongoose.Schema({
  id: { type: String, unique: true },    // Nano ID
  title: String,
  userId: String,
  url: String,
  uploadedAt: { type: Date, default: Date.now }
});
const Music = mongoose.model('Music', musicSchema);

const playlistSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  userId: String,
  tracks: [String] // массив music.id
});
const Playlist = mongoose.model('Playlist', playlistSchema);

// ========== ГЕНЕРАЦИЯ ID ==========
function generateNanoId(length = 8) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[crypto.randomInt(chars.length)];
  }
  return result;
}

async function generateUniqueUIN() {
  let uin;
  let exists = true;
  while (exists) {
    const digits = [];
    while (digits.length < 6) {
      const d = crypto.randomInt(10).toString();
      if (!digits.includes(d)) digits.push(d);
    }
    uin = digits.join('');
    exists = await User.exists({ uin });
  }
  return uin;
}

// ========== УТИЛИТЫ ==========
function getCurrentTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isUserOnline(userId) {
  return [...io.sockets.sockets.values()].some(s => s.userId === userId);
}

// ========== REST API ==========
app.post('/upload/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  await User.findOneAndUpdate({ uin: req.body.userId }, { avatar: req.file.filename });
  res.json({ avatar: req.file.filename });
});

app.post('/upload/file', uploadFile.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/files/' + req.file.filename });
});

app.post('/upload/music', uploadMusic.single('music'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const title = req.body.title || req.file.originalname.replace(/\.ogg$/, '');
    const userId = req.body.userId;
    const id = generateNanoId(10);
    const url = '/music/' + req.file.filename;
    await Music.create({ id, title, userId, url });
    res.json({ id, title, url });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось сохранить трек' });
  }
});

app.get('/api/music', async (req, res) => {
  const tracks = await Music.find({}).sort({ uploadedAt: -1 }).limit(200).lean();
  res.json(tracks);
});

// Плейлисты
app.get('/api/playlists/:userId', async (req, res) => {
  const playlists = await Playlist.find({ userId: req.params.userId }).lean();
  res.json(playlists);
});

app.post('/api/playlists', express.json(), async (req, res) => {
  const { name, userId, trackIds } = req.body;
  const id = generateNanoId(10);
  await Playlist.create({ id, name, userId, tracks: trackIds || [] });
  res.json({ id });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  console.log('+ соединение:', socket.id);

  socket.on('register', async (data) => {
    try {
      const { password, nick } = data;
      if (!password || password.length < 4) return socket.emit('authError', 'Пароль должен быть не менее 4 символов');
      if (!nick || nick.trim().length < 1) return socket.emit('authError', 'Никнейм обязателен');
      const uin = await generateUniqueUIN();
      const hash = await bcrypt.hash(password, 10);
      const token = generateToken();
      const user = await User.create({
        uin,
        nick: nick.trim(),
        passwordHash: hash,
        token,
        lastSeen: new Date()
      });
      socket.userId = uin;
      socket.emit('authSuccess', { uin, nick: user.nick, avatar: user.avatar, token: user.token });
    } catch (e) {
      socket.emit('authError', 'Ошибка регистрации');
    }
  });

  socket.on('login', async (data) => {
    try {
      const { login, password } = data;
      const user = await User.findOne({ uin: login });
      if (!user) return socket.emit('authError', 'Неверный UIN или пароль');
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return socket.emit('authError', 'Неверный UIN или пароль');
      user.token = generateToken();
      user.lastSeen = new Date();
      await user.save();
      socket.userId = user.uin;
      socket.emit('authSuccess', { uin: user.uin, nick: user.nick, avatar: user.avatar, token: user.token });
    } catch (e) {
      socket.emit('authError', 'Ошибка входа');
    }
  });

  socket.on('loginByToken', async (token) => {
    const user = await User.findOne({ token });
    if (!user) return socket.emit('tokenLoginResult', { success: false });
    user.lastSeen = new Date();
    await user.save();
    socket.userId = user.uin;
    socket.emit('tokenLoginResult', { success: true, profile: { uin: user.uin, nick: user.nick, avatar: user.avatar, token: user.token } });
  });

  socket.on('updateProfile', async (data) => {
    const userId = socket.userId;
    if (!userId) return;
    const updates = {};
    if (data.nick) updates.nick = data.nick.trim();
    if (data.description !== undefined) updates.description = data.description;
    const user = await User.findOneAndUpdate({ uin: userId }, updates, { new: true });
    socket.emit('profileUpdated', { uin: user.uin, nick: user.nick, description: user.description, avatar: user.avatar });
  });

  socket.on('createRoom', async (data) => {
    try {
      const { name, type } = data;
      const userId = socket.userId;
      if (!name) return;
      const roomId = generateNanoId(7);
      const room = await Room.create({
        id: roomId,
        name,
        type: type || 'chat',
        creator: userId,
        admins: [userId],
        participants: [userId],
        messages: []
      });
      socket.emit('roomCreated', { roomId, name, type });
    } catch (e) {
      socket.emit('systemMessage', { text: 'Ошибка создания комнаты' });
    }
  });

  socket.on('deleteRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room || room.creator !== userId) return;
    // Полное удаление комнаты (только создатель)
    io.to(roomId).emit('roomDeleted', roomId);
    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) sock.leave(roomId);
    await Room.deleteOne({ id: roomId });
  });

  socket.on('leaveRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    room.participants = room.participants.filter(id => id !== userId);
    await room.save();
    socket.leave(roomId);
    io.to(roomId).emit('userLeft', userId);
  });

  socket.on('globalSearch', async ({ query }) => {
    if (!query) return;
    const room = await Room.findOne({ id: query });
    if (room) return socket.emit('globalSearchResult', { type: 'room', id: room.id, name: room.name });
    const user = await User.findOne({ uin: query });
    if (user) return socket.emit('globalSearchResult', { type: 'user', uin: user.uin, nick: user.nick, avatar: user.avatar });
    // Поиск по нику (нечеткий)
    const users = await User.find({ nick: { $regex: query, $options: 'i' } }).limit(5).lean();
    if (users.length > 0) {
      return socket.emit('searchResults', users.map(u => ({ type: 'user', uin: u.uin, nick: u.nick, avatar: u.avatar })));
    }
    const rooms = await Room.find({ name: { $regex: query, $options: 'i' } }).limit(5).lean();
    socket.emit('searchResults', rooms.map(r => ({ type: r.type, id: r.id, name: r.name })));
  });

  socket.on('joinRoom', async (roomId) => {
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    const userId = socket.userId;
    if (!room.participants.includes(userId)) {
      room.participants.push(userId);
      await room.save();
    }
    socket.join(roomId);

    // Информация о комнате
    const participantsInfo = await Promise.all(room.participants.map(async uin => {
      const u = await User.findOne({ uin });
      return {
        uin,
        nick: u?.nick || 'Unknown',
        avatar: u?.avatar || '',
        online: isUserOnline(uin)
      };
    }));

    socket.emit('roomInfo', {
      roomId,
      name: room.name,
      type: room.type,
      creator: room.creator,
      participants: participantsInfo,
      messages: room.messages.slice(-100)
    });

    // Оповещаем других участников
    const me = await User.findOne({ uin: userId });
    socket.to(roomId).emit('userJoined', {
      uin: userId,
      nick: me?.nick || 'Unknown',
      avatar: me?.avatar || ''
    });
  });

  socket.on('chatMessage', async (data) => {
    const { roomId, text, fileUrl } = data;
    const userId = socket.userId;
    if (!userId || (!text && !fileUrl)) return;

    const user = await User.findOne({ uin: userId });
    const room = await Room.findOne({ id: roomId });
    if (!user || !room) return;

    // Проверка прав: в канале пишут только админы
    if (room.type === 'channel' && !room.admins.includes(userId)) return;

    // Проверка блокировки в личных чатах
    if (roomId.startsWith('private_')) {
      const ids = roomId.split('_').slice(1);
      const otherId = ids.find(id => id !== userId);
      if (otherId) {
        const other = await User.findOne({ uin: otherId });
        if (other && other.blockedUsers.includes(userId)) return;
      }
    }

    const now = new Date();
    const msg = {
      createdAt: now,
      time: getCurrentTime(),
      user: user.nick,
      userId,
      text: text || '',
      fileUrl: fileUrl || '',
      edited: false
    };
    room.messages.push(msg);
    if (room.messages.length > 1000) room.messages = room.messages.slice(-1000);
    await room.save();
    const newMsg = room.messages[room.messages.length - 1].toObject();
    io.to(roomId).emit('newMessage', newMsg);
  });

  socket.on('editMessage', async (data) => {
    const { roomId, messageId, newText } = data;
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    const msg = room.messages.id(messageId);
    if (!msg || msg.userId !== userId) return;
    msg.text = newText;
    msg.edited = true;
    await room.save();
    io.to(roomId).emit('messageEdited', { roomId, messageId, newText, edited: true });
  });

  socket.on('deleteMessage', async (data) => {
    const { roomId, messageId } = data;
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    const msg = room.messages.id(messageId);
    if (!msg || msg.userId !== userId) return;
    msg.text = 'Сообщение удалено';
    msg.fileUrl = '';
    msg.edited = true;
    await room.save();
    io.to(roomId).emit('messageDeleted', { roomId, messageId });
  });

  socket.on('blockUser', async (targetUin) => {
    const userId = socket.userId;
    const user = await User.findOne({ uin: userId });
    if (!user || user.blockedUsers.includes(targetUin)) return;
    user.blockedUsers.push(targetUin);
    await user.save();
    socket.emit('userBlocked', targetUin);
  });

  socket.on('unblockUser', async (targetUin) => {
    const userId = socket.userId;
    const user = await User.findOne({ uin: userId });
    if (!user) return;
    user.blockedUsers = user.blockedUsers.filter(id => id !== targetUin);
    await user.save();
    socket.emit('userUnblocked', targetUin);
  });

  socket.on('getUserProfile', async (uin) => {
    const user = await User.findOne({ uin });
    if (user) {
      socket.emit('userProfile', {
        uin: user.uin,
        nick: user.nick,
        avatar: user.avatar,
        description: user.description,
        lastSeen: user.lastSeen
      });
    }
  });

  socket.on('getFeed', async () => {
    const userId = socket.userId;
    const rooms = await Room.find({ participants: userId });
    let messages = [];
    for (const room of rooms) {
      const lastMsgs = room.messages.slice(-3);
      for (const msg of lastMsgs) {
        messages.push({
          ...msg.toObject(),
          roomId: room.id,
          roomName: room.name,
          roomType: room.type
        });
      }
    }
    messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    socket.emit('feed', messages.slice(0, 50));
  });

  socket.on('deleteAccount', async () => {
    const userId = socket.userId;
    const user = await User.findOne({ uin: userId });
    if (!user) return;
    const password = data.password; // нужно передать пароль для подтверждения, но пока упростим
    // Удаляем аватар с диска
    if (user.avatar) {
      const avatarPath = path.join(__dirname, 'public/avatars', user.avatar);
      if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
    }
    // Заменяем автора во всех сообщениях
    await Room.updateMany(
      { 'messages.userId': userId },
      { $set: { 'messages.$[elem].user': 'Удалённый пользователь' } },
      { arrayFilters: [{ 'elem.userId': userId }] }
    );
    // Выходим из всех комнат
    await Room.updateMany(
      { participants: userId },
      { $pull: { participants: userId } }
    );
    // Удаляем пользователя
    await User.deleteOne({ uin: userId });
    socket.emit('accountDeleted');
    socket.disconnect();
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId) {
      await User.findOneAndUpdate({ uin: userId }, { lastSeen: new Date() });
    }
  });
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/krista8';

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB подключена');
    server.listen(PORT, () => console.log(`Криста 8 запущена на порту ${PORT}`));
  })
  .catch(err => {
    console.error('Ошибка MongoDB:', err);
    process.exit(1);
  });
