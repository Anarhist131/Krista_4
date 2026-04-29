// server.js — Криста 4 (полный backend)
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
['public/avatars'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ========== MULTER (аватарки) ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/avatars'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.body.userId + '_avatar' + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ========== МОДЕЛИ ==========
const profileSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  login: { type: String, unique: true }, // теперь это ID пользователя
  passwordHash: String,
  token: String,
  nick: String,
  color: { type: String, default: '#7aa2f7' },
  description: { type: String, default: '' },
  avatar: { type: String, default: '' },
  theme: { type: String, default: 'dark' },
  lastSeen: Date,
  blockedUsers: [String],
  contacts: [String],          // список ID контактов
  subscribedRooms: [String]    // комнаты и каналы
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
    replyTo: String,
    edited: { type: Boolean, default: false }
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
  const c = await Counter.findOneAndUpdate(
    { key }, { $inc: { users: 1 } }, { upsert: true, new: true }
  );
  return key + String(c.users).padStart(3, '0');
}
async function generateChatId() {
  const key = getCurrentYYYYMM();
  const c = await Counter.findOneAndUpdate(
    { key }, { $inc: { chats: 1 } }, { upsert: true, new: true }
  );
  return '6' + key + String(c.chats).padStart(3, '0');
}
function getCurrentTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' +
         d.getMinutes().toString().padStart(2,'0');
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
  // Отправляем историю (последние 500) и информацию
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
  // Оповещаем остальных
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

// ========== СОКЕТЫ ==========
io.on('connection', (socket) => {
  console.log('+ соединение:', socket.id);

  // --- РЕГИСТРАЦИЯ ---
  socket.on('register', async (data) => {
    const { login, password, nick } = data;
    if (!login || !password) return socket.emit('authError', 'Введите ID и пароль');
    if (await Profile.findOne({ login })) return socket.emit('authError', 'Такой ID уже существует');
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
    joinRoom(socket, 'general');
  });

  // --- ВХОД ---
  socket.on('login', async (data) => {
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
  });

  // --- ВХОД ПО ТОКЕНУ ---
  socket.on('loginByToken', async (token) => {
    const profile = await Profile.findOne({ token });
    if (!profile) return socket.emit('tokenLoginResult', { success: false });
    profile.lastSeen = new Date();
    await profile.save();
    socket.userId = profile.id;
    socket.emit('tokenLoginResult', { success: true, profile: profile.toObject() });
    joinRoom(socket, 'general');
  });

  // --- ОБНОВЛЕНИЕ ПРОФИЛЯ ---
  socket.on('updateProfile', async (data) => {
    const userId = socket.userId;
    if (!userId) return;
    const updates = {};
    if (data.nick) updates.nick = data.nick.trim();
    if (data.color) updates.color = data.color;
    if (data.description !== undefined) updates.description = data.description;
    if (data.theme) updates.theme = data.theme;
    const profile = await Profile.findOneAndUpdate({ id: userId }, updates, { new: true });
    if (!profile) return;
    socket.emit('profileUpdated', profile.toObject());
    // Оповещаем комнаты и контакты?
    const rooms = await Room.find({ participants: userId });
    for (let room of rooms) {
      io.to(room.id).emit('userChanged', {
        userId,
        nick: profile.nick,
        color: profile.color,
        avatar: profile.avatar
      });
    }
  });

  // --- ЗАГРУЗКА АВАТАРА ---
  app.post('/upload/avatar', upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    await Profile.findOneAndUpdate({ id: req.body.userId }, { avatar: req.file.filename });
    res.json({ avatar: req.file.filename });
  });

  // --- СОЗДАНИЕ ЧАТА / КАНАЛА ---
  socket.on('createRoom', async (data) => {
    const { name, type } = data; // type: 'chat' или 'channel'
    const userId = socket.userId;
    if (!name) return;
    const chatId = await generateChatId();
    const room = await Room.create({
      id: chatId,
      name,
      type: type || 'chat',
      creator: userId,
      admins: [userId],
      participants: [userId],
      messages: [{
        time: getCurrentTime(),
        user: 'System',
        text: `Комната создана (${type === 'channel' ? 'канал' : 'чат'}): ${chatId}`
      }]
    });
    // Подписываем создателя
    await Profile.findOneAndUpdate({ id: userId }, { $addToSet: { subscribedRooms: chatId } });
    socket.emit('roomCreated', { roomId: chatId, name, type });
    joinRoom(socket, chatId);
  });

  // --- ДОБАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ В КОНТАКТЫ ---
  socket.on('addContact', async (targetId) => {
    const userId = socket.userId;
    if (userId === targetId) return socket.emit('systemMessage', { text: 'Нельзя добавить самого себя' });
    const target = await Profile.findOne({ id: targetId });
    if (!target) return socket.emit('systemMessage', { text: 'Пользователь не найден' });
    await Profile.findOneAndUpdate({ id: userId }, { $addToSet: { contacts: targetId } });
    // Возвращаем обновлённый список контактов клиенту
    const profile = await Profile.findOne({ id: userId });
    socket.emit('contactsUpdated', profile.contacts);
  });

  // --- ПОЛУЧЕНИЕ ПОЛНОГО СПИСКА ДЛЯ ГЛАВНОГО ЭКРАНА ---
  socket.on('getMainList', async () => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;

    // Собираем контакты
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
    // Разделяем на онлайн/офлайн
    const onlineContacts = contacts.filter(c => c.online);
    const offlineContacts = contacts.filter(c => !c.online);

    // Комнаты и каналы, на которые подписан
    const rooms = await Room.find({ id: { $in: profile.subscribedRooms } });
    const roomList = rooms.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      creator: r.creator
    }));

    socket.emit('mainList', {
      onlineContacts,
      offlineContacts,
      rooms: roomList
    });
  });

  // --- ПРИСОЕДИНЕНИЕ К КОМНАТЕ / ЛИЧНОМУ ЧАТУ ---
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

  // --- ОТПРАВКА СООБЩЕНИЙ ---
  socket.on('chatMessage', async (data) => {
    const { roomId, text } = data;
    const userId = socket.userId;
    if (!userId || !text) return;

    const profile = await Profile.findOne({ id: userId });
    const room = await Room.findOne({ id: roomId });
    if (!profile || !room) return;

    // Проверка, если канал — только админы могут писать
    if (room.type === 'channel' && !room.admins.includes(userId)) {
      return socket.emit('systemMessage', { text: 'В канале могут писать только администраторы' });
    }

    // Блокировка (для личных чатов)
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

    // Команды
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

  // --- ПОДПИСКА / ОТПИСКА ---
  socket.on('subscribeRoom', async (roomId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    if (!profile.subscribedRooms.includes(roomId)) {
      profile.subscribedRooms.push(roomId);
      await profile.save();
      const room = await Room.findOne({ id: roomId });
      if (room && !room.participants.includes(userId)) {
        room.participants.push(userId);
        await room.save();
      }
      socket.emit('subscribed', roomId);
    }
  });
  socket.on('unsubscribeRoom', async (roomId) => {
    const userId = socket.userId;
    const profile = await Profile.findOne({ id: userId });
    if (!profile) return;
    profile.subscribedRooms = profile.subscribedRooms.filter(r => r !== roomId);
    await profile.save();
    socket.emit('unsubscribed', roomId);
  });

  // --- БЛОКИРОВКА ---
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

  // --- ЗАПРОС ПРОФИЛЯ (при клике на юзера) ---
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

  // --- ОТКЛЮЧЕНИЕ ---
  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId) {
      await Profile.findOneAndUpdate({ id: userId }, { lastSeen: new Date() });
    }
  });
});

// ========== ОБРАБОТКА КОМАНД ==========
async function handleCommand(room, userId, cmd, socket) {
  const parts = cmd.split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  const sendSystem = async (text) => {
    const msg = {
      time: getCurrentTime(),
      user: 'System',
      text,
      color: '#ffaa00'
    };
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
    if (!newName) {
      await sendSystem('Использование: /namechat [Новое название]');
      return;
    }
    room.name = newName;
    await room.save();
    io.to(room.id).emit('roomNameChanged', newName);
    await sendSystem(`Название изменено на: ${newName}`);
  }
  else if (command === '/op') {
    if (room.creator !== userId) {
      await sendSystem('Ошибка: Только создатель может назначать администраторов.');
      return;
    }
    const targetNick = args.trim();
    if (!targetNick) {
      await sendSystem('Использование: /op [Никнейм]');
      return;
    }
    const targetUser = await Profile.findOne({ nick: targetNick, id: { $in: room.participants } });
    if (!targetUser) {
      await sendSystem(`Участник с ником ${targetNick} не найден.`);
      return;
    }
    if (room.admins.includes(targetUser.id)) {
      await sendSystem(`${targetNick} уже администратор.`);
      return;
    }
    room.admins.push(targetUser.id);
    await room.save();
    await sendSystem(`${targetNick} теперь администратор.`);
  }
  else if (command === '/whatid') {
    const list = await Promise.all(room.participants.map(async p => {
      const profile = await Profile.findOne({ id: p });
      return `${profile?.nick || 'Unknown'} [${p}]`;
    }));
    await sendSystem(`Чат: ${room.name} [${room.id}]\nУчастники: ${list.join(', ')}`);
  }
  else {
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
    server.listen(PORT, () => console.log(`Криста 4 запущена на порту ${PORT}`));
  })
  .catch(err => {
    console.error('Ошибка MongoDB:', err);
    process.exit(1);
  });