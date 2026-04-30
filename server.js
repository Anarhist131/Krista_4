// server.js — Криста 6 (без команд, с аватарками)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ========== Папки ==========
['public/avatars', 'public/files'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

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

// ========== МОДЕЛИ ==========
const profileSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  nick: String,
  color: { type: String, default: '#7aa2f7' },
  description: { type: String, default: '' },
  avatar: { type: String, default: '' },
  passwordHash: String,
  token: String,
  lastSeen: Date,
  blockedUsers: [String],
  contacts: [String]
});
const Profile = mongoose.model('Profile', profileSchema);

const roomSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  type: { type: String, enum: ['chat', 'channel'], default: 'chat' },
  creator: String,
  admins: [String],
  participants: [String],
  messages: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    time: String,
    user: String,
    userId: String,
    color: String,
    text: String,
    fileUrl: String
  }]
});
const Room = mongoose.model('Room', roomSchema);

const counterSchema = new mongoose.Schema({
  year: { type: String, unique: true },
  users: { type: Number, default: 0 },
  chats9: { type: Number, default: 0 },
  chats8: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// ========== ГЕНЕРАЦИЯ ID ==========
function getCurrentYY() { return String(new Date().getFullYear()).slice(-2); }

async function generateUserId() {
  const year = getCurrentYY();
  const c = await Counter.findOneAndUpdate(
    { year }, { $inc: { users: 1 } }, { upsert: true, new: true }
  );
  return year + String(c.users).padStart(3, '0');
}

async function generateChatId() {
  const year = getCurrentYY();
  const c = await Counter.findOneAndUpdate(
    { year }, { $inc: { chats9: 1 } }, { upsert: true, new: true }
  );
  return year + '9' + String(c.chats9).padStart(2, '0');
}

async function generateChannelId() {
  const year = getCurrentYY();
  const c = await Counter.findOneAndUpdate(
    { year }, { $inc: { chats8: 1 } }, { upsert: true, new: true }
  );
  return year + '8' + String(c.chats8).padStart(2, '0');
}

function getCurrentTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function joinRoom(socket, roomId) {
  const room = await Room.findOne({ id: roomId });
  if (!room) return;

  const userId = socket.userId;
  if (!room.participants.includes(userId)) {
    room.participants.push(userId);
    await room.save();
  }
  socket.join(roomId);

  const participantsInfo = await Promise.all(room.participants.map(async id => {
    const p = await Profile.findOne({ id });
    return {
      id,
      nick: p?.nick || 'Unknown',
      color: p?.color || '#ccc',
      avatar: p?.avatar || '',
      online: isUserOnline(id)
    };
  }));

  socket.emit('roomInfo', {
    roomId,
    name: room.name,
    type: room.type,
    creator: room.creator,
    participants: participantsInfo,
    messages: room.messages.slice(-500)
  });

  const me = await Profile.findOne({ id: userId });
  socket.to(roomId).emit('userJoined', {
    id: userId,
    nick: me?.nick || 'Unknown',
    color: me?.color || '#7aa2f7',
    avatar: me?.avatar || ''
  });
}

function isUserOnline(userId) {
  return [...io.sockets.sockets.values()].some(s => s.userId === userId);
}

// ========== REST: загрузка файлов ==========
app.post('/upload/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  await Profile.findOneAndUpdate({ id: req.body.userId }, { avatar: req.file.filename });
  res.json({ avatar: req.file.filename });
});

app.post('/upload/file', uploadFile.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/files/' + req.file.filename });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  console.log('+ соединение:', socket.id);

  socket.on('register', async (data) => {
    try {
      const { password, nick } = data;
      if (!password) return socket.emit('authError', 'Пароль обязателен');
      const userId = await generateUserId();
      const hash = await bcrypt.hash(password, 10);
      const token = generateToken();
      const profile = await Profile.create({
        id: userId,
        nick: nick || 'User' + userId,
        passwordHash: hash,
        token,
        lastSeen: new Date()
      });
      socket.userId = userId;
      socket.emit('authSuccess', profile.toObject());
      joinRoom(socket, 'general');
    } catch (e) {
      socket.emit('authError', 'Ошибка регистрации');
    }
  });

  socket.on('login', async (data) => {
    try {
      const { login, password } = data;
      const profile = await Profile.findOne({ id: login });
      if (!profile) return socket.emit('authError', 'Неверный ID или пароль');
      const valid = await bcrypt.compare(password, profile.passwordHash);
      if (!valid) return socket.emit('authError', 'Неверный ID или пароль');
      profile.token = generateToken();
      profile.lastSeen = new Date();
      await profile.save();
      socket.userId = profile.id;
      socket.emit('authSuccess', profile.toObject());
      joinRoom(socket, 'general');
    } catch (e) {
      socket.emit('authError', 'Ошибка входа');
    }
  });

  socket.on('loginByToken', async (token) => {
    const profile = await Profile.findOne({ token });
    if (!profile) return socket.emit('tokenLoginResult', { success: false });
    profile.lastSeen = new Date();
    await profile.save();
    socket.userId = profile.id;
    socket.emit('tokenLoginResult', { success: true, profile: profile.toObject() });
    joinRoom(socket, 'general');
  });

  socket.on('updateProfile', async (data) => {
    const userId = socket.userId;
    if (!userId) return;
    const updates = {};
    if (data.nick) updates.nick = data.nick.trim();
    if (data.description !== undefined) updates.description = data.description;
    if (data.color) updates.color = data.color;
    const profile = await Profile.findOneAndUpdate({ id: userId }, updates, { new: true });
    if (!profile) return;
    socket.emit('profileUpdated', profile.toObject());
  });

  socket.on('createRoom', async (data) => {
    try {
      const { name, type } = data;
      const userId = socket.userId;
      if (!name) return;
      const chatId = type === 'channel' ? await generateChannelId() : await generateChatId();
      const room = await Room.create({
        id: chatId,
        name,
        type: type || 'chat',
        creator: userId,
        admins: [userId],
        participants: [userId],
        messages: []
      });
      socket.emit('roomCreated', { roomId: chatId, name, type });
    } catch (e) {
      socket.emit('systemMessage', { text: 'Ошибка создания комнаты' });
    }
  });

  socket.on('deleteRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room || room.creator !== userId) return;
    io.to(roomId).emit('roomDeleted', roomId);
    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) sock.leave(roomId);
    await Room.deleteOne({ id: roomId });
  });

  socket.on('globalSearch', async ({ query }) => {
    const room = await Room.findOne({ id: query });
    if (room) return socket.emit('globalSearchResult', { type: 'room', id: room.id, name: room.name });
    const user = await Profile.findOne({ id: query });
    if (user) return socket.emit('globalSearchResult', { type: 'user', id: user.id, name: user.nick });
    socket.emit('globalSearchResult', { type: 'none' });
  });

  socket.on('joinRoom', (roomId) => joinRoom(socket, roomId));

  socket.on('leaveRoom', async (roomId) => {
    const userId = socket.userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    room.participants = room.participants.filter(id => id !== userId);
    await room.save();
    socket.leave(roomId);
    io.to(roomId).emit('userLeft', userId);
  });

  socket.on('startPrivateChat', async (targetId) => {
    const userId = socket.userId;
    const target = await Profile.findOne({ id: targetId });
    if (!target) return socket.emit('systemMessage', { text: 'Пользователь не найден' });
    await Profile.findOneAndUpdate({ id: userId }, { $addToSet: { contacts: targetId } });
    const ids = [userId, targetId].sort();
    const roomId = 'private_' + ids[0] + '_' + ids[1];
    let room = await Room.findOne({ id: roomId });
    if (!room) {
      const p1 = await Profile.findOne({ id: ids[0] });
      const p2 = await Profile.findOne({ id: ids[1] });
      room = await Room.create({
        id: roomId,
        name: `Личный: ${p1.nick} / ${p2.nick}`,
        type: 'chat',
        creator: 'system',
        participants: [ids[0], ids[1]],
        messages: []
      });
    }
    socket.emit('privateRoomReady', { roomId, targetId, targetNick: target.nick });
    joinRoom(socket, roomId);
  });

  socket.on('getMainList', async () => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;

    const contacts = await Promise.all(profile.contacts.map(async cid => {
      const p = await Profile.findOne({ id: cid });
      return {
        id: cid,
        nick: p?.nick || 'Unknown',
        color: p?.color || '#ccc',
        avatar: p?.avatar || '',
        online: isUserOnline(cid),
        lastSeen: p?.lastSeen
      };
    }));
    const onlineContacts = contacts.filter(c => c.online);
    const offlineContacts = contacts.filter(c => !c.online);

    const rooms = await Room.find({ participants: userId, type: { $ne: 'private' } });
    const roomList = rooms.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      creator: r.creator
    }));

    socket.emit('mainList', { onlineContacts, offlineContacts, rooms: roomList });
  });

  socket.on('chatMessage', async (data) => {
    const { roomId, text } = data;
    const userId = socket.userId;
    if (!userId || !text) return;

    const profile = await Profile.findOne({ id: userId });
    const room = await Room.findOne({ id: roomId });
    if (!profile || !room) return;

    if (room.type === 'channel' && !room.admins.includes(userId)) return;
    if (roomId.startsWith('private_')) {
      const ids = roomId.split('_').slice(1);
      const otherId = ids.find(id => id !== userId);
      if (otherId) {
        const other = await Profile.findOne({ id: otherId });
        if (other && other.blockedUsers.includes(userId)) return;
      }
    }

    const msg = {
      time: getCurrentTime(),
      user: profile.nick,
      userId,
      color: profile.color,
      text
    };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    await room.save();
    io.to(roomId).emit('newMessage', room.messages[room.messages.length - 1].toObject());
  });

  socket.on('typing', ({ roomId }) => {
    Profile.findOne({ id: socket.userId }).then(profile => {
      if (profile) socket.to(roomId).emit('typing', { userId: socket.userId, nick: profile.nick });
    });
  });
  socket.on('stopTyping', ({ roomId }) => {
    socket.to(roomId).emit('stopTyping', { userId: socket.userId });
  });

  socket.on('blockUser', async (targetId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    if (!profile.blockedUsers.includes(targetId)) {
      profile.blockedUsers.push(targetId);
      await profile.save();
      socket.emit('userBlocked', targetId);
    }
  });
  socket.on('unblockUser', async (targetId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    profile.blockedUsers = profile.blockedUsers.filter(id => id !== targetId);
    await profile.save();
    socket.emit('userUnblocked', targetId);
  });

  socket.on('getUserProfile', async (userId) => {
    const profile = await Profile.findOne({ id: userId });
    if (profile) {
      socket.emit('userProfile', {
        id: profile.id,
        nick: profile.nick,
        color: profile.color,
        avatar: profile.avatar,
        description: profile.description,
        lastSeen: profile.lastSeen
      });
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId) {
      await Profile.findOneAndUpdate({ id: userId }, { lastSeen: new Date() });
    }
  });
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/krista6';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB подключена');
    if (!(await Room.findOne({ id: 'general' }))) {
      await Room.create({
        id: 'general',
        name: 'Общий чат',
        type: 'chat',
        creator: 'system',
        participants: [],
        messages: []
      });
      console.log('Общий чат создан');
    }
    await Counter.findOneAndUpdate({ year: getCurrentYY() }, { $setOnInsert: { users: 0, chats9: 0, chats8: 0 } }, { upsert: true });
    server.listen(PORT, () => console.log(`Криста 6 запущена на порту ${PORT}`));
  })
  .catch(err => {
    console.error('Ошибка MongoDB:', err);
    process.exit(1);
  });
