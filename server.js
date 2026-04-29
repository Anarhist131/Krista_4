// server.js — Криста 4.1 (исправления истории, аватары чатов, файлы)
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

// Модели
const profileSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  login: { type: String, unique: true },
  passwordHash: String,
  token: String,
  nick: String,
  color: { type: String, default: '#7aa2f7' },
  description: { type: String, default: '' },
  avatar: { type: String, default: '' },
  theme: { type: String, default: 'dark' },
  lastSeen: Date,
  blockedUsers: [String],
  contacts: [String],
  subscribedRooms: [String]
});
const Profile = mongoose.model('Profile', profileSchema);

const roomSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  type: { type: String, enum: ['chat', 'channel', 'favorites'], default: 'chat' },
  creator: String,
  avatar: { type: String, default: '' }, // аватар чата/канала
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
  key: { type: String, unique: true },
  users: { type: Number, default: 0 },
  chats: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// ========== ФУНКЦИИ ==========
function getCurrentYYYYMM() {
  const d = new Date();
  return String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
}
async function generateUserId() {
  const key = getCurrentYYYYMM();
  const c = await Counter.findOneAndUpdate({ key }, { $inc: { users: 1 } }, { upsert: true, new: true });
  return key + String(c.users).padStart(3, '0');
}
async function generateChatId() {
  const key = getCurrentYYYYMM();
  const c = await Counter.findOneAndUpdate({ key }, { $inc: { chats: 1 } }, { upsert: true, new: true });
  return '6' + key + String(c.chats).padStart(3, '0');
}
function getCurrentTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function joinRoom(socket, roomId) {
  // Подменяем id избранного на персональное
  if (roomId === 'favorites') roomId = 'favorites_' + socket.userId;

  const room = await Room.findOne({ id: roomId });
  if (!room) {
    if (roomId.startsWith('favorites_')) {
      const profile = await Profile.findOne({ id: socket.userId });
      const newRoom = await Room.create({
        id: roomId,
        name: 'Избранное',
        type: 'favorites',
        creator: socket.userId,
        admins: [socket.userId],
        participants: [socket.userId],
        messages: []
      });
      socket.join(roomId);
      socket.emit('roomInfo', {
        roomId,
        name: newRoom.name,
        type: newRoom.type,
        avatar: newRoom.avatar,
        creator: newRoom.creator,
        participants: [],
        messages: []
      });
      await Profile.findOneAndUpdate({ id: socket.userId }, { $addToSet: { subscribedRooms: roomId } });
      return;
    } else {
      return;
    }
  }

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
    avatar: room.avatar,
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

// ========== REST ДЛЯ СОЗДАНИЯ КОМНАТЫ С АВАТАРОМ ==========
app.post('/createRoom', uploadAvatar.single('avatar'), async (req, res) => {
  try {
    const { name, type, userId } = req.body;
    if (!name || !type || !userId) return res.status(400).json({ error: 'Не хватает данных' });
    const chatId = await generateChatId();
    const roomData = {
      id: chatId,
      name,
      type,
      creator: userId,
      admins: [userId],
      participants: [userId],
      messages: []
    };
    if (req.file) {
      roomData.avatar = req.file.filename;
    }
    const room = await Room.create(roomData);
    // Подписываем создателя
    await Profile.findOneAndUpdate({ id: userId }, { $addToSet: { subscribedRooms: chatId } });
    // Оповещаем через сокет (если есть активный сокет)
    const socket = [...io.sockets.sockets.values()].find(s => s.userId === userId);
    if (socket) {
      socket.emit('roomCreated', { roomId: chatId, name, type });
      joinRoom(socket, chatId);
    }
    res.json({ roomId: chatId, name, type });
  } catch (err) {
    console.error('Ошибка создания комнаты:', err);
    res.status(500).json({ error: 'Внутренняя ошибка' });
  }
});

// ========== ЗАГРУЗКА ФАЙЛА ==========
app.post('/upload/file', uploadFile.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const fileUrl = '/files/' + req.file.filename;
  res.json({ url: fileUrl });
});

// ========== ЗАГРУЗКА АВАТАРА ПОЛЬЗОВАТЕЛЯ ==========
app.post('/upload/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  await Profile.findOneAndUpdate({ id: req.body.userId }, { avatar: req.file.filename });
  res.json({ avatar: req.file.filename });
});

// ========== САМЫЙ ГЛАВНЫЙ КОД ==========
io.on('connection', (socket) => {
  console.log('+ соединение:', socket.id);

  // Регистрация, вход, вход по токену (аналогично предыдущим версиям, только исправлено сохранение избранного)
  socket.on('register', async (data) => {
    try {
      const { password, nick } = data;
      if (!password) return socket.emit('authError', 'Пароль обязателен');
      const userId = await generateUserId();
      const hash = await bcrypt.hash(password, 10);
      const token = generateToken();
      const profile = await Profile.create({
        id: userId,
        login: userId,
        passwordHash: hash,
        token,
        nick: nick || 'User' + userId,
        lastSeen: new Date()
      });
      socket.userId = userId;
      socket.emit('authSuccess', profile.toObject());

      // Создаём избранное и подписываемся на общий чат
      await Room.create({
        id: 'favorites_' + userId,
        name: 'Избранное',
        type: 'favorites',
        creator: userId,
        participants: [userId],
        messages: []
      });
      await Profile.findOneAndUpdate({ id: userId }, {
        $addToSet: {
          subscribedRooms: ['general', 'favorites_' + userId]
        }
      });
      joinRoom(socket, 'general');
    } catch (e) { socket.emit('authError', 'Ошибка регистрации'); }
  });

  socket.on('login', async (data) => {
    try {
      const { login, password } = data;
      const profile = await Profile.findOne({ login });
      if (!profile) return socket.emit('authError', 'Неверный ID или пароль');
      const valid = await bcrypt.compare(password, profile.passwordHash);
      if (!valid) return socket.emit('authError', 'Неверный ID или пароль');
      profile.token = generateToken();
      profile.lastSeen = new Date();
      await profile.save();
      socket.userId = profile.id;
      socket.emit('authSuccess', profile.toObject());
      joinRoom(socket, 'general');
    } catch (e) { socket.emit('authError', 'Ошибка входа'); }
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
    if (data.color) updates.color = data.color;
    if (data.description !== undefined) updates.description = data.description;
    const profile = await Profile.findOneAndUpdate({ id: userId }, updates, { new: true });
    if (!profile) return;
    socket.emit('profileUpdated', profile.toObject());
  });

  // Глобальный поиск
  socket.on('globalSearch', async ({ query }) => {
    const room = await Room.findOne({ id: query });
    if (room) {
      return socket.emit('globalSearchResult', { type: 'room', id: room.id, name: room.name, avatar: room.avatar });
    }
    const user = await Profile.findOne({ id: query });
    if (user) {
      return socket.emit('globalSearchResult', { type: 'user', id: user.id, name: user.nick, avatar: user.avatar });
    }
    socket.emit('globalSearchResult', { type: 'none' });
  });

  // Присоединение к комнате из поиска
  socket.on('findAndJoinRoom', (roomId) => joinRoom(socket, roomId));

  // Начать личный чат
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

  // Получение главного списка
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

    const rooms = await Room.find({
      id: { $in: profile.subscribedRooms },
      type: { $ne: 'favorites' }
    });
    const roomList = rooms.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      avatar: r.avatar,
      creator: r.creator
    }));

    socket.emit('mainList', {
      onlineContacts,
      offlineContacts,
      rooms: roomList
    });
  });

  // Выход из комнаты
  socket.on('leaveRoom', async (roomId) => {
    const userId = socket.userId;
    if (roomId === 'favorites') roomId = 'favorites_' + userId;
    const room = await Room.findOne({ id: roomId });
    if (!room) return;
    room.participants = room.participants.filter(id => id !== userId);
    await room.save();
    socket.leave(roomId);
    io.to(roomId).emit('userLeft', userId);
  });

  // Сообщения
  socket.on('chatMessage', async (data) => {
    let { roomId, text } = data;
    const userId = socket.userId;
    if (!userId || !text) return;

    if (roomId === 'favorites') roomId = 'favorites_' + userId;

    const profile = await Profile.findOne({ id: userId });
    const room = await Room.findOne({ id: roomId });
    if (!profile || !room) return;

    // Проверки для канала и блокировки
    if (room.type === 'channel' && !room.admins.includes(userId)) {
      return socket.emit('systemMessage', { text: 'В канале могут писать только администраторы' });
    }
    if (roomId.startsWith('private_')) {
      const ids = roomId.split('_').slice(1);
      const otherId = ids.find(id => id !== userId);
      if (otherId) {
        const other = await Profile.findOne({ id: otherId });
        if (other && other.blockedUsers.includes(userId)) {
          return socket.emit('systemMessage', { text: 'Вы заблокированы' });
        }
      }
    }

    if (text.startsWith('/')) {
      handleCommand(room, userId, text.trim(), socket);
      return;
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

  // Подписка/отписка, блокировка — оставляем без изменений
  socket.on('subscribeRoom', async (roomId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile || profile.subscribedRooms.includes(roomId)) return;
    profile.subscribedRooms.push(roomId);
    await profile.save();
    const room = await Room.findOne({ id: roomId });
    if (room && !room.participants.includes(userId)) {
      room.participants.push(userId);
      await room.save();
    }
    socket.emit('subscribed', roomId);
  });
  socket.on('unsubscribeRoom', async (roomId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    profile.subscribedRooms = profile.subscribedRooms.filter(r => r !== roomId);
    await profile.save();
    socket.emit('unsubscribed', roomId);
  });
  socket.on('blockUser', async (targetId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile || profile.blockedUsers.includes(targetId)) return;
    profile.blockedUsers.push(targetId);
    await profile.save();
    socket.emit('userBlocked', targetId);
  });
  socket.on('unblockUser', async (targetId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    profile.blockedUsers = profile.blockedUsers.filter(id => id !== targetId);
    await profile.save();
    socket.emit('userUnblocked', targetId);
  });

  // Профиль
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

  // Индикатор печати
  socket.on('typing', ({ roomId }) => {
    if (roomId === 'favorites') roomId = 'favorites_' + socket.userId;
    Profile.findOne({ id: socket.userId }).then(profile => {
      if (profile) socket.to(roomId).emit('typing', { userId: socket.userId, nick: profile.nick });
    });
  });
  socket.on('stopTyping', ({ roomId }) => {
    if (roomId === 'favorites') roomId = 'favorites_' + socket.userId;
    socket.to(roomId).emit('stopTyping', { userId: socket.userId });
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId) {
      await Profile.findOneAndUpdate({ id: userId }, { lastSeen: new Date() });
    }
  });
});

// ========== КОМАНДЫ (без изменений) ==========
async function handleCommand(room, userId, cmd, socket) {
  const parts = cmd.split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  const sendSystem = async (text) => {
    const msg = { time: getCurrentTime(), user: 'System', text, color: '#ffaa00' };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    await room.save();
    io.to(room.id).emit('newMessage', msg);
  };
  if (command === '/namechat') {
    if (!room.admins.includes(userId) && room.creator !== userId) {
      await sendSystem('Ошибка: Только администратор может менять название.');
      return;
    }
    const newName = args.trim();
    if (!newName) { await sendSystem('Использование: /namechat [Новое название]'); return; }
    room.name = newName;
    await room.save();
    io.to(room.id).emit('roomNameChanged', newName);
    await sendSystem(`Название изменено на: ${newName}`);
  } else if (command === '/op') {
    if (room.creator !== userId) { await sendSystem('Ошибка: Только создатель может назначать администраторов.'); return; }
    const targetNick = args.trim();
    if (!targetNick) { await sendSystem('Использование: /op [Никнейм]'); return; }
    const targetUser = await Profile.findOne({ nick: targetNick, id: { $in: room.participants } });
    if (!targetUser) { await sendSystem(`Участник с ником ${targetNick} не найден.`); return; }
    if (room.admins.includes(targetUser.id)) { await sendSystem(`${targetNick} уже администратор.`); return; }
    room.admins.push(targetUser.id);
    await room.save();
    await sendSystem(`${targetNick} теперь администратор.`);
  } else if (command === '/whatid') {
    const list = await Promise.all(room.participants.map(async p => {
      const profile = await Profile.findOne({ id: p });
      return `${profile?.nick || 'Unknown'} [${p}]`;
    }));
    await sendSystem(`Чат: ${room.name} [${room.id}]\nУчастники: ${list.join(', ')}`);
  } else {
    await sendSystem('Доступные команды: /namechat, /op, /Whatid');
  }
}

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/krista4';
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB подключена');
    if (!(await Room.findOne({ id: 'general' }))) {
      await Room.create({ id: 'general', name: 'Общий чат', type: 'chat', creator: 'system', participants: [], messages: [] });
      console.log('Общий чат создан');
    }
    server.listen(PORT, () => console.log(`Криста 4.1 запущена на порту ${PORT}`));
  })
  .catch(err => {
    console.error('Ошибка MongoDB:', err);
    process.exit(1);
  });
