import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuid } from 'uuid';

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',') }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: (process.env.CORS_ORIGIN || '*').split(',') } });

const SESSIONS = new Map();
const TTL = (parseInt(process.env.SESSION_TTL_MIN || '60',10))*60*1000;

function newSession(pin){ const id = uuid(), now = Date.now();
  SESSIONS.set(id, { pin: String(pin), roles:{}, createdAt: now, expiresAt: now+TTL, status:'waiting' });
  return id;
}
function getSession(id){
  const s = SESSIONS.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { SESSIONS.delete(id); return null; }
  return s;
}
function closeSession(id){ SESSIONS.delete(id); }

setInterval(()=>{ const now=Date.now();
  for (const [id,s] of SESSIONS) if (now > s.expiresAt) SESSIONS.delete(id);
}, 300000);

app.get('/health', (_req,res)=> res.json({ ok:true, sessions: SESSIONS.size }));

io.on('connection', (socket)=>{
  socket.on('create-session', ({pin}, cb)=>{
    try { const id = newSession(pin); cb?.({ok:true, sessionId:id}); }
    catch { cb?.({ok:false, error:'CREATE_FAILED'}); }
  });

  socket.on('join', ({sessionId, pin, role}, cb)=>{
    const s = getSession(sessionId);
    if(!s) return cb?.({ok:false, error:'NO_SESSION'});
    if(String(pin)!==s.pin) return cb?.({ok:false, error:'BAD_PIN'});
    if (role==='emitter' && s.roles.emitter) return cb?.({ok:false, error:'EMITTER_TAKEN'});
    if (role==='receiver' && s.roles.receiver) return cb?.({ok:false, error:'RECEIVER_TAKEN'});
    s.roles[role]=socket.id;
    s.status = (s.roles.emitter && s.roles.receiver) ? 'connected' : 'waiting';
    socket.join(sessionId);
    socket.data = { sessionId, role };
    socket.to(sessionId).emit('peer-joined', { role });
    cb?.({ok:true, status:s.status});
  });

  socket.on('offer',  ({sessionId,sdp})       => socket.to(sessionId).emit('offer',  {sdp}));
  socket.on('answer', ({sessionId,sdp})       => socket.to(sessionId).emit('answer', {sdp}));
  socket.on('ice',    ({sessionId,candidate}) => socket.to(sessionId).emit('ice',    {candidate}));
  socket.on('state',  ({sessionId,state,ts})  => socket.to(sessionId).emit('state',  {state,ts}));

  socket.on('close', ({sessionId})=>{
    socket.to(sessionId).emit('close');
    closeSession(sessionId);
  });

  socket.on('disconnect', ()=>{
    const info = socket.data;
    if(!info?.sessionId) return;
    io.to(info.sessionId).emit('close');
    closeSession(info.sessionId);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=> console.log('Signaling on', PORT));
