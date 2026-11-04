/* WebTalk client: lobby, WebRTC mesh (perfect negotiation), text chat. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const ERRORS = {
    'invalid-room': 'Room names can only use letters, numbers, "-" and "_".',
    'invalid-name': 'Please enter a name.',
    'room-full': 'That room is full.',
    'not-in-room': 'You are not in a room.',
    'rate-limited': 'Slow down a little.',
  };

  // ---------- State ----------
  const state = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    localStream: new MediaStream(),
    screenTrack: null,
    micOn: true,
    camOn: true,
    name: '',
    roomId: '',
    selfId: null,
    inRoom: false,
    chatOpen: false,
    unread: 0,
  };
  /** @type {Map<string, any>} */
  const peers = new Map();
  const mediaSupported = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const screenSupported = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });

  // ---------- Elements ----------
  const el = {
    lobby: $('#lobby'),
    room: $('#room'),
    previewVideo: $('#preview-video'),
    previewPlaceholder: $('#preview-placeholder'),
    previewAvatar: $('#preview-avatar'),
    previewStatus: $('#preview-status'),
    previewMic: $('#preview-mic'),
    previewCam: $('#preview-cam'),
    joinForm: $('#join-form'),
    nameInput: $('#name-input'),
    roomInput: $('#room-input'),
    randomRoom: $('#random-room'),
    joinError: $('#join-error'),
    joinBtn: $('#join-btn'),
    roomTitle: $('#room-title'),
    peerCount: $('#peer-count'),
    copyLink: $('#copy-link'),
    grid: $('#grid'),
    messages: $('#messages'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    closeChat: $('#close-chat'),
    micBtn: $('#mic-btn'),
    camBtn: $('#cam-btn'),
    screenBtn: $('#screen-btn'),
    chatBtn: $('#chat-btn'),
    unread: $('#unread'),
    leaveBtn: $('#leave-btn'),
    toast: $('#toast'),
    tileTemplate: $('#tile-template'),
  };

  // ---------- Helpers ----------
  let toastTimer = null;
  function toast(text, ms = 2600) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function randomRoomName() {
    const a = ['amber', 'brisk', 'calm', 'dusty', 'eager', 'fuzzy', 'gentle', 'happy', 'icy', 'jolly', 'lucky', 'misty', 'noble', 'quiet', 'rapid', 'sunny', 'tidy', 'vivid', 'witty', 'zesty'];
    const b = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'tiger', 'cedar', 'river', 'pepper', 'lynx', 'meadow', 'orbit', 'panda', 'quartz', 'raven', 'tulip', 'walrus', 'yak', 'zebra', 'koala'];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    return `${pick(a)}-${pick(b)}-${Math.floor(100 + Math.random() * 900)}`;
  }

  function audioTrack() { return state.localStream.getAudioTracks()[0] || null; }
  function cameraTrack() { return state.localStream.getVideoTracks()[0] || null; }
  function outgoingVideoTrack() { return state.screenTrack || cameraTrack(); }

  function mediaState() {
    return {
      audio: Boolean(state.micOn && audioTrack()),
      video: Boolean(state.camOn && cameraTrack()),
      screen: Boolean(state.screenTrack),
    };
  }

  function setPressed(btn, on) { btn.setAttribute('aria-pressed', String(Boolean(on))); }

  // ---------- Local media ----------
  async function getUserMediaSafe(constraints) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn('getUserMedia failed', constraints, err);
      return null;
    }
  }

  async function acquireInitialMedia() {
    if (!mediaSupported) {
      el.previewStatus.textContent = location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'This browser has no camera/mic support'
        : 'Camera & mic need HTTPS (or localhost)';
      state.micOn = false;
      state.camOn = false;
      return;
    }
    const stream =
      (await getUserMediaSafe({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS })) ||
      (await getUserMediaSafe({ audio: AUDIO_CONSTRAINTS })) ||
      (await getUserMediaSafe({ video: VIDEO_CONSTRAINTS }));
    if (stream) stream.getTracks().forEach((t) => state.localStream.addTrack(t));
    if (!audioTrack()) state.micOn = false;
    if (!cameraTrack()) state.camOn = false;
    if (!stream) el.previewStatus.textContent = 'No camera or microphone access';
  }

  async function setMic(on) {
    if (on && !audioTrack()) {
      if (!mediaSupported) return toast('Microphone is not available here');
      const stream = await getUserMediaSafe({ audio: AUDIO_CONSTRAINTS });
      if (!stream) return toast('Could not access the microphone');
      state.localStream.addTrack(stream.getAudioTracks()[0]);
    }
    state.micOn = Boolean(on && audioTrack());
    const track = audioTrack();
    if (track) track.enabled = state.micOn;
    afterLocalMediaChange();
  }

  async function setCam(on) {
    if (on) {
      if (!cameraTrack()) {
        if (!mediaSupported) return toast('Camera is not available here');
        const stream = await getUserMediaSafe({ video: VIDEO_CONSTRAINTS });
        if (!stream) return toast('Could not access the camera');
        state.localStream.addTrack(stream.getVideoTracks()[0]);
      }
      state.camOn = true;
    } else {
      // Stop the camera completely so its light turns off.
      const track = cameraTrack();
      if (track) {
        track.stop();
        state.localStream.removeTrack(track);
      }
      state.camOn = false;
    }
    afterLocalMediaChange();
  }

  async function toggleScreen() {
    if (state.screenTrack) return stopScreen();
    if (!screenSupported) return toast('Screen sharing is not supported on this device');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') toast('Could not share the screen');
      return;
    }
    const track = stream.getVideoTracks()[0];
    if ('contentHint' in track) track.contentHint = 'detail';
    track.addEventListener('ended', stopScreen);
    state.screenTrack = track;
    afterLocalMediaChange();
  }

  function stopScreen() {
    if (!state.screenTrack) return;
    state.screenTrack.removeEventListener('ended', stopScreen);
    state.screenTrack.stop();
    state.screenTrack = null;
    afterLocalMediaChange();
  }

  function afterLocalMediaChange() {
    setPressed(el.previewMic, state.micOn);
    setPressed(el.previewCam, state.camOn);
    setPressed(el.micBtn, state.micOn);
    setPressed(el.camBtn, state.camOn);
    setPressed(el.screenBtn, Boolean(state.screenTrack));
    renderPreview();
    if (state.inRoom) {
      renderSelfTile();
      for (const peer of peers.values()) syncPeerTracks(peer);
      socket.emit('media-state', mediaState());
    }
  }

  function renderPreview() {
    const cam = cameraTrack();
    const showVideo = Boolean(state.camOn && cam);
    el.previewVideo.srcObject = showVideo ? new MediaStream([cam]) : null;
    el.previewPlaceholder.hidden = showVideo;
    el.previewAvatar.textContent = initials(el.nameInput.value);
    if (mediaSupported && !showVideo) {
      el.previewStatus.textContent = cam || state.camOn === false ? 'Camera is off' : 'No camera';
    }
  }

  // ---------- Audio level (speaking indicator) ----------
  let audioCtx = null;
  const levelWatchers = new Map(); // key -> {analyser, source, buffer, tile}

  function watchLevel(key, track, tile) {
    unwatchLevel(key);
    if (!track || !window.AudioContext) return;
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      levelWatchers.set(key, { analyser, source, buffer: new Uint8Array(analyser.fftSize), tile, track, level: 0 });
    } catch (err) {
      console.warn('level meter unavailable', err);
    }
  }

  function unwatchLevel(key) {
    const w = levelWatchers.get(key);
    if (!w) return;
    try { w.source.disconnect(); } catch { /* ignore */ }
    w.tile.classList.remove('speaking');
    levelWatchers.delete(key);
  }

  setInterval(() => {
    for (const w of levelWatchers.values()) {
      w.analyser.getByteTimeDomainData(w.buffer);
      let sum = 0;
      for (let i = 0; i < w.buffer.length; i++) {
        const v = (w.buffer[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / w.buffer.length);
      w.level = w.level * 0.6 + rms * 0.4;
      const speaking = w.track.enabled && w.track.readyState === 'live' && w.level > 0.02;
      w.tile.classList.toggle('speaking', speaking);
    }
  }, 120);

  // ---------- Tiles ----------
  function createTile(id, name, { self = false } = {}) {
    const tile = el.tileTemplate.content.firstElementChild.cloneNode(true);
    tile.dataset.peer = id;
    tile.classList.toggle('self', self);
    tile.querySelector('.name').textContent = self ? `${name} (you)` : name;
    tile.querySelector('.avatar').textContent = initials(name);
    const video = tile.querySelector('video');
    if (self) video.muted = true;
    el.grid.appendChild(tile);
    layoutGrid();
    return tile;
  }

  function removeTile(tile) {
    if (!tile) return;
    const video = tile.querySelector('video');
    video.srcObject = null;
    tile.remove();
    layoutGrid();
  }

  function layoutGrid() {
    const n = el.grid.children.length || 1;
    const portrait = window.innerWidth < 760 && window.innerHeight > window.innerWidth;
    let cols;
    if (portrait) cols = n <= 2 ? 1 : 2;
    else cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    el.grid.style.setProperty('--cols', cols);
    el.grid.style.setProperty('--rows', Math.ceil(n / cols));
    el.peerCount.textContent = String(n);
  }
  window.addEventListener('resize', layoutGrid);

  let selfTile = null;
  function renderSelfTile() {
    if (!selfTile) return;
    const video = outgoingVideoTrack();
    const showVideo = Boolean(state.screenTrack || (state.camOn && video));
    const videoEl = selfTile.querySelector('video');
    const current = videoEl.srcObject && videoEl.srcObject.getVideoTracks()[0];
    if (showVideo && current !== video) videoEl.srcObject = new MediaStream([video]);
    if (!showVideo) videoEl.srcObject = null;
    selfTile.classList.toggle('no-video', !showVideo);
    selfTile.classList.toggle('screen', Boolean(state.screenTrack));
    selfTile.querySelector('.mic-off').hidden = state.micOn;
    const mic = audioTrack();
    if (mic && !levelWatchers.has('self')) watchLevel('self', mic, selfTile);
    else if (mic && levelWatchers.get('self').track !== mic) watchLevel('self', mic, selfTile);
    else if (!mic) unwatchLevel('self');
  }

  function renderPeerTile(peer) {
    const { tile, media, remoteStream } = peer;
    // track.muted is unreliable after a glare rollback in Chrome, so trust decoded frames instead.
    const videoEl = tile.querySelector('video');
    const hasLiveVideo = videoEl.videoWidth > 0 && remoteStream.getVideoTracks().some((t) => t.readyState === 'live');
    const showVideo = Boolean((media.video || media.screen) && hasLiveVideo);
    tile.classList.toggle('no-video', !showVideo);
    tile.classList.toggle('screen', Boolean(media.screen));
    tile.querySelector('.mic-off').hidden = Boolean(media.audio);
    const cs = peer.pc.connectionState;
    const expectsMedia = Boolean(media.audio || media.video || media.screen || audioTrack() || outgoingVideoTrack());
    tile.querySelector('.conn').hidden = !(expectsMedia && (cs === 'new' || cs === 'connecting' || cs === 'disconnected'));
    tile.querySelector('.conn').textContent = cs === 'disconnected' ? 'reconnecting…' : 'connecting…';
  }

  // ---------- Peer connections ----------
  // Topology: full mesh. The newcomer is the initiator: it creates one audio and one video
  // transceiver per peer and sends the offer; existing members answer and attach their tracks
  // to the offered transceivers. All later changes (mute, camera, screen share) use
  // replaceTrack, so the initial offer/answer is the only negotiation. Perfect-negotiation
  // guards remain for ICE restarts.
  function sendSignal(to, data) {
    socket.emit('signal', { to, data });
  }

  function createPeer(id, name, media, { initiator = false } = {}) {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    const peer = {
      id,
      name,
      media: { audio: true, video: true, screen: false, ...(media || {}) },
      pc,
      // Deterministic roles: the peer with the larger id is "polite" and yields on glare.
      polite: String(state.selfId) > String(id),
      makingOffer: false,
      ignoreOffer: false,
      initiator,
      audioTx: null,
      videoTx: null,
      remoteStream: new MediaStream(),
      tile: createTile(id, name),
    };
    peers.set(id, peer);
    const videoEl = peer.tile.querySelector('video');
    videoEl.srcObject = peer.remoteStream;
    for (const ev of ['loadeddata', 'resize', 'playing']) videoEl.addEventListener(ev, () => renderPeerTile(peer));

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription.toJSON() });
      } catch (err) {
        console.error('negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(id, { candidate: candidate.toJSON() });
    };

    pc.ontrack = ({ track }) => {
      if (!peer.remoteStream.getTracks().includes(track)) peer.remoteStream.addTrack(track);
      videoEl.srcObject = peer.remoteStream; // refresh so the element picks up new tracks
      videoEl.play().catch(() => {});
      track.addEventListener('mute', () => renderPeerTile(peer));
      track.addEventListener('unmute', () => renderPeerTile(peer));
      track.addEventListener('ended', () => {
        peer.remoteStream.removeTrack(track);
        renderPeerTile(peer);
      });
      if (track.kind === 'audio') watchLevel(id, track, peer.tile);
      renderPeerTile(peer);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      renderPeerTile(peer);
    };

    if (initiator) {
      // Adding the transceivers fires negotiationneeded, which sends the offer.
      peer.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [state.localStream] });
      peer.videoTx = pc.addTransceiver('video', { direction: 'sendrecv', streams: [state.localStream] });
      syncPeerTracks(peer);
    }
    renderPeerTile(peer);
    return peer;
  }

  /** Answerer side: adopt the transceivers created by the remote offer. */
  function adoptTransceivers(peer) {
    const txs = peer.pc.getTransceivers();
    for (const [key, kind] of [['audioTx', 'audio'], ['videoTx', 'video']]) {
      if (peer[key]) continue;
      const tx = txs.find((t) => t.receiver.track.kind === kind && !t.stopped);
      if (!tx) continue;
      tx.direction = 'sendrecv';
      if (tx.sender.setStreams) tx.sender.setStreams(state.localStream);
      peer[key] = tx;
    }
  }

  function setSender(tx, track) {
    if (tx && tx.sender.track !== track) {
      tx.sender.replaceTrack(track).catch((err) => console.warn('replaceTrack failed', err));
    }
  }

  function syncPeerTracks(peer) {
    setSender(peer.audioTx, audioTrack());
    setSender(peer.videoTx, state.screenTrack || (state.camOn ? cameraTrack() : null));
  }

  async function handleSignal({ from, data }) {
    if (!state.inRoom || !data) return;
    let peer = peers.get(from);
    if (!peer) peer = createPeer(from, 'Guest');
    const { pc } = peer;
    try {
      if (data.description) {
        const description = data.description;
        const offerCollision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          adoptTransceivers(peer);
          syncPeerTracks(peer);
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('signal handling failed', err);
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    unwatchLevel(id);
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    removeTile(peer.tile);
    peers.delete(id);
  }

  function closeAllPeers() {
    for (const id of [...peers.keys()]) closePeer(id);
  }

  // ---------- Chat ----------
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function addMessage({ from, name, text, ts }) {
    const mine = from === state.selfId;
    const li = document.createElement('li');
    li.className = `msg${mine ? ' mine' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('b');
    who.textContent = mine ? 'You' : name;
    meta.append(who, document.createTextNode(formatTime(ts)));
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    li.append(meta, body);
    appendToMessages(li);
    if (!mine && !state.chatOpen) {
      state.unread += 1;
      el.unread.textContent = state.unread > 99 ? '99+' : String(state.unread);
      el.unread.hidden = false;
    }
  }

  function addSystemMessage(text) {
    const li = document.createElement('li');
    li.className = 'msg system';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    li.append(body);
    appendToMessages(li);
  }

  function appendToMessages(li) {
    const atBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40;
    el.messages.appendChild(li);
    if (atBottom || li.classList.contains('mine')) el.messages.scrollTop = el.messages.scrollHeight;
  }

  function setChatOpen(open) {
    state.chatOpen = open;
    el.room.classList.toggle('chat-open', open);
    setPressed(el.chatBtn, open);
    if (open) {
      state.unread = 0;
      el.unread.hidden = true;
      el.messages.scrollTop = el.messages.scrollHeight;
      if (window.matchMedia('(hover: hover)').matches) el.chatInput.focus();
    }
    layoutGrid();
  }

  function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    socket.emit('chat', text, (res) => {
      if (res && res.ok) {
        el.chatInput.value = '';
        autoGrow();
      } else {
        toast(ERRORS[res && res.error] || 'Message not sent');
      }
    });
  }

  function autoGrow() {
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 120)}px`;
  }

  // ---------- Joining / leaving ----------
  function joinRoom() {
    return new Promise((resolve) => {
      socket.emit('join', { roomId: state.roomId, name: state.name, media: mediaState() }, resolve);
    });
  }

  async function enterRoom() {
    el.joinError.hidden = true;
    const name = el.nameInput.value.trim();
    const roomId = el.roomInput.value.trim().toLowerCase();
    if (!name) return showJoinError('invalid-name');
    if (!/^[a-z0-9_-]{1,64}$/.test(roomId)) return showJoinError('invalid-room');
    state.name = name;
    state.roomId = roomId;
    try { localStorage.setItem('webtalk:name', name); } catch { /* ignore */ }

    el.joinBtn.disabled = true;
    el.joinBtn.textContent = 'Joining…';
    try {
      if (!socket.connected) {
        socket.connect();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 10000);
          socket.once('connect', () => { clearTimeout(timer); resolve(); });
        });
      }
      const res = await joinRoom();
      if (!res || !res.ok) return showJoinError(res && res.error);
      onJoined(res);
    } catch {
      showJoinError('server');
    } finally {
      el.joinBtn.disabled = false;
      el.joinBtn.textContent = 'Join room';
    }
  }

  function showJoinError(code) {
    el.joinError.textContent = ERRORS[code] || 'Could not reach the server. Try again.';
    el.joinError.hidden = false;
  }

  function onJoined(res) {
    state.selfId = res.id;
    state.inRoom = true;
    el.lobby.hidden = true;
    el.room.hidden = false;
    el.roomTitle.textContent = res.roomId;
    document.title = `${res.roomId} · WebTalk`;
    const url = new URL(location.href);
    url.searchParams.set('room', res.roomId);
    history.replaceState(null, '', url);

    if (!selfTile) selfTile = createTile(res.id, state.name, { self: true });
    else selfTile.dataset.peer = res.id;
    for (const p of res.peers) createPeer(p.id, p.name, p.media, { initiator: true });
    afterLocalMediaChange();
    layoutGrid();
    if (res.peers.length === 0) addSystemMessage('You are the first one here. Share the invite link!');
  }

  function leaveRoom() {
    if (!state.inRoom) return;
    socket.emit('leave');
    state.inRoom = false;
    stopScreen();
    closeAllPeers();
    unwatchLevel('self');
    removeTile(selfTile);
    selfTile = null;
    el.messages.replaceChildren();
    setChatOpen(false);
    state.unread = 0;
    el.unread.hidden = true;
    el.room.hidden = true;
    el.lobby.hidden = false;
    document.title = 'WebTalk';
    renderPreview();
  }

  // ---------- Socket events ----------
  socket.on('peer-joined', ({ id, name, media }) => {
    if (!state.inRoom || peers.has(id)) return;
    createPeer(id, name, media);
    addSystemMessage(`${name} joined`);
  });

  socket.on('peer-left', ({ id }) => {
    const peer = peers.get(id);
    if (!peer) return;
    addSystemMessage(`${peer.name} left`);
    closePeer(id);
  });

  socket.on('peer-media', ({ id, media }) => {
    const peer = peers.get(id);
    if (!peer) return;
    peer.media = { ...peer.media, ...media };
    renderPeerTile(peer);
  });

  socket.on('signal', handleSignal);

  socket.on('chat', (message) => {
    if (state.inRoom) addMessage(message);
  });

  socket.on('disconnect', (reason) => {
    if (!state.inRoom) return;
    if (reason === 'io client disconnect') return;
    toast('Connection lost — reconnecting…', 4000);
  });

  socket.io.on('reconnect', async () => {
    if (!state.inRoom) return;
    // We have a new socket id: drop old peer connections and join again.
    closeAllPeers();
    const res = await joinRoom();
    if (!res || !res.ok) {
      toast(ERRORS[res && res.error] || 'Could not rejoin the room');
      leaveRoom();
      return;
    }
    state.selfId = res.id;
    if (selfTile) selfTile.dataset.peer = res.id;
    for (const p of res.peers) createPeer(p.id, p.name, p.media, { initiator: true });
    afterLocalMediaChange();
    toast('Reconnected');
  });

  // ---------- UI wiring ----------
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    enterRoom();
  });
  el.randomRoom.addEventListener('click', () => { el.roomInput.value = randomRoomName(); });
  el.nameInput.addEventListener('input', () => { el.previewAvatar.textContent = initials(el.nameInput.value); });
  el.previewMic.addEventListener('click', () => setMic(!state.micOn));
  el.previewCam.addEventListener('click', () => setCam(!state.camOn));
  el.micBtn.addEventListener('click', () => setMic(!state.micOn));
  el.camBtn.addEventListener('click', () => setCam(!state.camOn));
  el.screenBtn.addEventListener('click', toggleScreen);
  el.chatBtn.addEventListener('click', () => setChatOpen(!state.chatOpen));
  el.closeChat.addEventListener('click', () => setChatOpen(false));
  el.leaveBtn.addEventListener('click', leaveRoom);
  el.copyLink.addEventListener('click', async () => {
    const link = `${location.origin}/?room=${encodeURIComponent(state.roomId)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  });
  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });
  el.chatInput.addEventListener('input', autoGrow);

  // Shortcuts follow Google Meet: Ctrl/⌘+D toggles the mic, Ctrl/⌘+E the camera, Esc closes chat.
  document.addEventListener('keydown', (e) => {
    if (!state.inRoom) return;
    if (e.key === 'Escape' && state.chatOpen) {
      setChatOpen(false);
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === 'd') {
      e.preventDefault();
      setMic(!state.micOn);
    } else if (key === 'e') {
      e.preventDefault();
      setCam(!state.camOn);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.inRoom) socket.emit('leave');
  });

  // Read-only snapshot for debugging in the console and for the E2E test.
  window.webtalkDebug = () => ({
    selfId: state.selfId,
    media: mediaState(),
    peers: [...peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      polite: p.polite,
      connection: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      signaling: p.pc.signalingState,
      media: p.media,
      remoteTracks: p.remoteStream.getTracks().map((t) => `${t.kind}:${t.readyState}`),
      transceivers: p.pc.getTransceivers().map((t) => `${t.mid}:${t.receiver.track.kind}:${t.currentDirection}`),
    })),
  });

  // ---------- Boot ----------
  async function boot() {
    if (!screenSupported) {
      el.screenBtn.disabled = true;
      el.screenBtn.classList.add('unsupported');
      el.screenBtn.title = 'Screen sharing is not supported on this device';
    }
    try { el.nameInput.value = localStorage.getItem('webtalk:name') || ''; } catch { /* ignore */ }
    const params = new URLSearchParams(location.search);
    el.roomInput.value = (params.get('room') || '').toLowerCase() || randomRoomName();
    if (params.get('name')) el.nameInput.value = params.get('name');

    fetch('/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => { if (cfg && Array.isArray(cfg.iceServers)) state.iceServers = cfg.iceServers; })
      .catch(() => {});

    await acquireInitialMedia();
    afterLocalMediaChange();
    (el.nameInput.value ? el.joinBtn : el.nameInput).focus();
  }

  boot();
})();
