const DB_NAME = 'playlist_studio';
const DB_VERSION = 1;
const PLAYLIST_STORE = 'playlists';
const TRACK_STORE = 'tracks';

const state = {
  playlists: [],
  libraryTracks: [],
  activePlaylistId: null,
  currentIndex: null,
  currentTrackId: null,
  currentUrl: null,
  selectedIndex: null,
  librarySelectedIndex: null,
  isSeeking: false,
  seekRatio: 0,
  waveformCache: new Map(),
  waveformTrackId: null,
  waveformPeaks: null,
  waveformProgress: 0,
  audioContext: null,
  rafId: null,
};

const elements = {
  playlistNameInput: document.getElementById('playlist-name'),
  createPlaylistButton: document.getElementById('create-playlist'),
  deletePlaylistButton: document.getElementById('delete-playlist'),
  playlistList: document.getElementById('playlist-list'),
  playlistTitle: document.getElementById('playlist-title'),
  playlistCount: document.getElementById('playlist-count'),
  fileInput: document.getElementById('file-input'),
  libraryList: document.getElementById('library-list'),
  libraryCount: document.getElementById('library-count'),
  exportJson: document.getElementById('export-json'),
  importJson: document.getElementById('import-json'),
  trackList: document.getElementById('track-list'),
  nowTitle: document.getElementById('now-title'),
  nowSubtitle: document.getElementById('now-subtitle'),
  waveform: document.getElementById('waveform'),
  timeCurrent: document.getElementById('time-current'),
  timeDuration: document.getElementById('time-duration'),
  prevTrack: document.getElementById('prev-track'),
  togglePlay: document.getElementById('toggle-play'),
  nextTrack: document.getElementById('next-track'),
  volume: document.getElementById('volume'),
  audio: document.getElementById('audio'),
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function updateSeekUI() {
  const duration = elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    elements.timeCurrent.textContent = '0:00';
    elements.timeDuration.textContent = '0:00';
    state.waveformProgress = 0;
    drawWaveform();
    return;
  }
  const ratio = state.isSeeking ? state.seekRatio : elements.audio.currentTime / duration;
  state.waveformProgress = Math.min(Math.max(ratio, 0), 1);
  if (!state.isSeeking) {
    state.seekRatio = state.waveformProgress;
  }
  const displayTime = state.waveformProgress * duration;
  elements.timeCurrent.textContent = formatTime(displayTime);
  elements.timeDuration.textContent = formatTime(duration);
  drawWaveform();
}

function getCssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function resizeWaveformCanvas() {
  const canvas = elements.waveform;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.floor(rect.width * ratio));
  const nextHeight = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }
}

function drawWaveform() {
  const canvas = elements.waveform;
  if (!canvas) return;
  resizeWaveformCanvas();
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = rect.width;
  const height = rect.height;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const peaks = state.waveformPeaks;
  const baseColor = getCssVar('--waveform-base', '#2a313d');
  const playedColor = getCssVar('--waveform-played', '#ff5500');
  const progress = state.waveformProgress || 0;

  if (!peaks || peaks.length === 0) {
    ctx.strokeStyle = baseColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.strokeStyle = playedColor;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width * progress, height / 2);
    ctx.stroke();
    return;
  }

  const barCount = peaks.length;
  const barWidth = width / barCount;
  const center = height / 2;
  for (let i = 0; i < barCount; i += 1) {
    const value = peaks[i];
    const barHeight = Math.max(2, value * height);
    const x = i * barWidth;
    const y = center - barHeight / 2;
    ctx.fillStyle = i / barCount <= progress ? playedColor : baseColor;
    ctx.fillRect(x, y, Math.max(1, barWidth * 0.7), barHeight);
  }
}

function getWaveformRatio(event) {
  const rect = elements.waveform.getBoundingClientRect();
  if (!rect.width) return 0;
  const ratio = (event.clientX - rect.left) / rect.width;
  return Math.min(Math.max(ratio, 0), 1);
}

function commitSeek() {
  if (!state.isSeeking) return;
  const duration = elements.audio.duration;
  if (Number.isFinite(duration) && duration > 0) {
    elements.audio.currentTime = state.seekRatio * duration;
  }
  state.isSeeking = false;
  updateSeekUI();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const [header, data] = dataUrl.split(',');
  if (!data) return null;
  const match = /data:(.*?);base64/.exec(header);
  const mime = match ? match[1] : 'audio/mpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function clearStore(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function exportJson() {
  const playlists = await getAll(PLAYLIST_STORE);
  const tracks = await getAll(TRACK_STORE);
  const exportedTracks = [];
  for (const track of tracks) {
    if (!track) continue;
    const dataUrl = track.blob ? await blobToDataUrl(track.blob) : null;
    exportedTracks.push({
      id: track.id,
      name: track.name,
      memo: track.memo || '',
      artist: track.artist || '',
      createdAt: track.createdAt || Date.now(),
      blobDataUrl: dataUrl,
    });
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    activePlaylistId: state.activePlaylistId,
    playlists,
    tracks: exportedTracks,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const filename = `playlist-studio-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importJson(file) {
  if (!file) return;
  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch (error) {
    alert('JSONの読み込みに失敗しました。');
    return;
  }

  if (!data || !Array.isArray(data.playlists) || !Array.isArray(data.tracks)) {
    alert('JSONの形式が正しくありません。');
    return;
  }

  const confirmed = confirm('現在のデータを上書きして読み込みますか？');
  if (!confirmed) return;

  clearCurrentPlayback();

  await clearStore(PLAYLIST_STORE);
  await clearStore(TRACK_STORE);
  state.waveformCache.clear();
  state.waveformPeaks = null;
  state.waveformTrackId = null;
  state.waveformProgress = 0;
  updateSeekUI();
  state.libraryTracks = [];

  const importedTrackIds = new Set();
  for (const track of data.tracks) {
    if (!track || !track.id || !track.name) continue;
    const blob = track.blobDataUrl ? dataUrlToBlob(track.blobDataUrl) : null;
    if (!blob) continue;
    await putItem(TRACK_STORE, {
      id: track.id,
      name: track.name,
      memo: track.memo || '',
      artist: track.artist || '',
      createdAt: track.createdAt || Date.now(),
      blob,
    });
    importedTrackIds.add(track.id);
  }

  for (const playlist of data.playlists) {
    if (!playlist || !playlist.id || !playlist.name) continue;
    const filtered = Array.isArray(playlist.trackIds)
      ? playlist.trackIds.filter((id) => importedTrackIds.has(id))
      : [];
    await putItem(PLAYLIST_STORE, {
      id: playlist.id,
      name: playlist.name,
      trackIds: filtered,
      createdAt: playlist.createdAt || Date.now(),
    });
  }

  if (data.activePlaylistId) {
    setActivePlaylist(data.activePlaylistId);
  } else {
    state.activePlaylistId = null;
  }

  await loadPlaylists();
}

function startWaveformFollow() {
  if (state.rafId !== null) return;
  const step = () => {
    if (!elements.audio || elements.audio.paused || elements.audio.ended) {
      state.rafId = null;
      return;
    }
    if (!state.isSeeking) {
      updateSeekUI();
    }
    state.rafId = requestAnimationFrame(step);
  };
  state.rafId = requestAnimationFrame(step);
}

function stopWaveformFollow() {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioContext;
}

function generateWaveformPeaks(buffer, peakCount) {
  const channelData = buffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / peakCount);
  const peaks = [];
  for (let i = 0; i < peakCount; i += 1) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channelData.length);
    let max = 0;
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(channelData[j]);
      if (value > max) max = value;
    }
    peaks.push(max);
  }
  return peaks;
}

async function loadWaveformForTrack(track) {
  if (!track) return;
  state.waveformTrackId = track.id;
  if (state.waveformCache.has(track.id)) {
    state.waveformPeaks = state.waveformCache.get(track.id);
    drawWaveform();
    return;
  }
  try {
    const context = ensureAudioContext();
    const buffer = await track.blob.arrayBuffer();
    const decoded = await context.decodeAudioData(buffer);
    const peaks = generateWaveformPeaks(decoded, 320);
    state.waveformCache.set(track.id, peaks);
    if (state.waveformTrackId === track.id) {
      state.waveformPeaks = peaks;
      drawWaveform();
    }
  } catch (error) {
    state.waveformPeaks = null;
    drawWaveform();
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
        db.createObjectStore(PLAYLIST_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        db.createObjectStore(TRACK_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getById(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function putItem(storeName, item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteItem(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function setActivePlaylist(id) {
  state.activePlaylistId = id;
  localStorage.setItem('activePlaylistId', id || '');
}

function getActivePlaylistId() {
  const stored = localStorage.getItem('activePlaylistId');
  return stored || null;
}

function createPlaylistRecord(name) {
  return {
    id: crypto.randomUUID(),
    name,
    trackIds: [],
    createdAt: Date.now(),
  };
}

async function loadPlaylists() {
  const playlists = await getAll(PLAYLIST_STORE);
  playlists.sort((a, b) => a.createdAt - b.createdAt);
  state.playlists = playlists;
  state.libraryTracks = await getAll(TRACK_STORE);
  state.libraryTracks.sort((a, b) => a.createdAt - b.createdAt);

  const stored = state.activePlaylistId;
  const exists = playlists.some((item) => item.id === stored);
  if (!exists && playlists.length) {
    setActivePlaylist(playlists[0].id);
  } else if (!playlists.length) {
    setActivePlaylist(null);
  }

  renderPlaylists();
  renderLibrary();
  await renderTracks();
}

function renderPlaylists() {
  elements.playlistList.innerHTML = '';
  state.playlists.forEach((playlist) => {
    const li = document.createElement('li');
    li.textContent = playlist.name;
    if (playlist.id === state.activePlaylistId) {
      li.classList.add('active');
    }
    li.addEventListener('click', async () => {
      setActivePlaylist(playlist.id);
      renderPlaylists();
      await renderTracks();
    });
    elements.playlistList.appendChild(li);
  });
}

function updateLibraryMemoDisplay(trackId, memo) {
  const item = elements.libraryList.querySelector(`[data-track-id="${trackId}"]`);
  if (!item) return;
  const memoNode = item.querySelector('.track-meta span');
  if (memoNode) {
    memoNode.textContent = memo ? memo : 'メモを入力';
  }
}

function updateLibrarySelectionUI(shouldScroll = false) {
  const items = elements.libraryList.querySelectorAll('li');
  items.forEach((item) => {
    const index = Number(item.dataset.index);
    item.classList.toggle('selected', index === state.librarySelectedIndex);
  });
  if (shouldScroll) {
    const active = elements.libraryList.querySelector('li.selected');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function setLibrarySelectedIndex(index, shouldScroll = false) {
  if (state.libraryTracks.length === 0) {
    state.librarySelectedIndex = null;
    updateLibrarySelectionUI();
    return;
  }
  const next = Math.min(Math.max(index, 0), state.libraryTracks.length - 1);
  state.librarySelectedIndex = next;
  updateLibrarySelectionUI(shouldScroll);
}

function renderLibrary() {
  elements.libraryList.innerHTML = '';
  elements.libraryCount.textContent = `${state.libraryTracks.length} 曲`;

  if (state.libraryTracks.length === 0) {
    state.librarySelectedIndex = null;
  } else if (
    state.librarySelectedIndex === null ||
    state.librarySelectedIndex >= state.libraryTracks.length
  ) {
    state.librarySelectedIndex = 0;
  }

  state.libraryTracks.forEach((track, index) => {
    if (!track) return;
    const li = document.createElement('li');
    li.dataset.trackId = track.id;
    li.dataset.index = String(index);
    if (index === state.librarySelectedIndex) {
      li.classList.add('selected');
    }

    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = String(index + 1).padStart(2, '0');

    const meta = document.createElement('div');
    meta.className = 'track-meta';
    const title = document.createElement('strong');
    title.textContent = track.name;
    const subtitle = document.createElement('span');
    subtitle.textContent = track.memo ? track.memo : 'メモを入力';
    meta.appendChild(title);
    meta.appendChild(subtitle);

    const actions = document.createElement('div');
    actions.className = 'track-actions';
    const addButton = document.createElement('button');
    addButton.className = 'button button--ghost';
    addButton.textContent = '追加';
    addButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await addTrackToPlaylist(track.id);
    });

    const playButton = document.createElement('button');
    playButton.className = 'button button--ghost';
    playButton.textContent = '再生';
    playButton.addEventListener('click', (event) => {
      event.stopPropagation();
      playLibraryTrack(track.id, index);
    });

    actions.appendChild(playButton);
    actions.appendChild(addButton);

    li.appendChild(number);
    li.appendChild(meta);
    li.appendChild(actions);
    li.addEventListener('click', () => {
      setLibrarySelectedIndex(index);
      playLibraryTrack(track.id, index);
    });
    elements.libraryList.appendChild(li);
  });
}

async function renderTracks() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) {
    elements.playlistTitle.textContent = 'プレイリスト未選択';
    elements.playlistCount.textContent = '0 曲';
    elements.trackList.innerHTML = '';
    state.selectedIndex = null;
    return;
  }

  elements.playlistTitle.textContent = playlist.name;
  elements.playlistCount.textContent = `${playlist.trackIds.length} 曲`;

  const currentIndex = playlist.trackIds.findIndex((id) => id === state.currentTrackId);
  state.currentIndex = currentIndex === -1 ? null : currentIndex;

  const tracks = await Promise.all(playlist.trackIds.map((id) => getById(TRACK_STORE, id)));

  elements.trackList.innerHTML = '';
  if (playlist.trackIds.length === 0) {
    state.selectedIndex = null;
  } else if (state.selectedIndex === null || state.selectedIndex >= playlist.trackIds.length) {
    state.selectedIndex = state.currentIndex !== null ? state.currentIndex : 0;
  }

  tracks.forEach((track, index) => {
    if (!track) return;
    const li = document.createElement('li');
    li.dataset.index = String(index);
    li.dataset.trackId = track.id;
    li.draggable = true;
    if (track.id === state.currentTrackId) {
      li.classList.add('playing');
    }
    if (index === state.selectedIndex) {
      li.classList.add('selected');
    }

    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = String(index + 1).padStart(2, '0');

    const meta = document.createElement('div');
    meta.className = 'track-meta';
    const title = document.createElement('strong');
    title.textContent = track.name;
    const subtitle = document.createElement('span');
    subtitle.textContent = track.memo ? track.memo : 'メモを入力';
    meta.appendChild(title);
    meta.appendChild(subtitle);

    const actions = document.createElement('div');
    actions.className = 'track-actions';
    const playButton = document.createElement('button');
    playButton.className = 'button button--ghost';
    playButton.textContent = '再生';
    playButton.addEventListener('click', (event) => {
      event.stopPropagation();
      playTrackAt(index);
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'button button--ghost';
    removeButton.textContent = '削除';
    removeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await removeTrackFromPlaylist(index);
    });

    const memoButton = document.createElement('button');
    memoButton.className = 'button button--ghost';
    memoButton.textContent = 'メモ';

    actions.appendChild(playButton);
    actions.appendChild(memoButton);
    actions.appendChild(removeButton);

    const memo = document.createElement('div');
    memo.className = 'track-memo';
    if (track.memo) memo.classList.add('visible');
    const memoField = document.createElement('textarea');
    memoField.placeholder = 'この曲のメモを入力';
    memoField.value = track.memo || '';
    memoField.addEventListener('click', (event) => event.stopPropagation());
    memoField.addEventListener('change', async () => {
      track.memo = memoField.value;
      subtitle.textContent = track.memo ? track.memo : 'メモを入力';
      if (track.id === state.currentTrackId) {
        elements.nowSubtitle.textContent = track.memo ? track.memo : 'メモを入力';
      }
      updateLibraryMemoDisplay(track.id, track.memo);
      await putItem(TRACK_STORE, track);
    });
    memo.appendChild(memoField);

    memoButton.addEventListener('click', (event) => {
      event.stopPropagation();
      memo.classList.toggle('visible');
      if (memo.classList.contains('visible')) {
        memoField.focus();
      }
    });

    li.appendChild(number);
    li.appendChild(meta);
    li.appendChild(actions);
    li.appendChild(memo);

    li.addEventListener('click', () => {
      setSelectedIndex(index);
      playTrackAt(index);
    });
    elements.trackList.appendChild(li);
  });
}

function updateSelectionUI(shouldScroll = false) {
  const items = elements.trackList.querySelectorAll('li');
  items.forEach((item) => {
    const index = Number(item.dataset.index);
    item.classList.toggle('selected', index === state.selectedIndex);
  });
  if (shouldScroll) {
    const active = elements.trackList.querySelector('li.selected');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function setSelectedIndex(index, shouldScroll = false) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist || playlist.trackIds.length === 0) {
    state.selectedIndex = null;
    updateSelectionUI();
    return;
  }
  const next = Math.min(Math.max(index, 0), playlist.trackIds.length - 1);
  state.selectedIndex = next;
  updateSelectionUI(shouldScroll);
}

async function removeTrackFromPlaylist(index) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) return;
  playlist.trackIds.splice(index, 1);
  await putItem(PLAYLIST_STORE, playlist);
  await loadPlaylists();
}

async function addTrackToPlaylist(trackId) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) {
    alert('先にプレイリストを作成してください。');
    return;
  }
  if (playlist.trackIds.includes(trackId)) return;
  playlist.trackIds.push(trackId);
  await putItem(PLAYLIST_STORE, playlist);
  await loadPlaylists();
}

async function playLibraryTrack(trackId, index) {
  const track = await getById(TRACK_STORE, trackId);
  if (!track) return;

  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
  }

  state.currentIndex = null;
  state.selectedIndex = null;
  state.currentTrackId = trackId;
  state.librarySelectedIndex = index;
  state.currentUrl = URL.createObjectURL(track.blob);
  elements.audio.src = state.currentUrl;
  elements.audio.play();
  elements.togglePlay.textContent = '一時停止';
  elements.nowTitle.textContent = track.name;
  elements.nowSubtitle.textContent = track.memo ? track.memo : 'メモを入力';
  renderTracks();
  renderLibrary();
  updateSeekUI();
  loadWaveformForTrack(track);
}

async function playTrackAt(index) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) return;
  const trackId = playlist.trackIds[index];
  if (!trackId) return;
  const track = await getById(TRACK_STORE, trackId);
  if (!track) return;

  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
  }

  state.currentIndex = index;
  state.selectedIndex = index;
  state.currentTrackId = trackId;
  state.currentUrl = URL.createObjectURL(track.blob);
  elements.audio.src = state.currentUrl;
  elements.audio.play();
  elements.togglePlay.textContent = '一時停止';
  elements.nowTitle.textContent = track.name;
  elements.nowSubtitle.textContent = track.memo ? track.memo : 'メモを入力';
  renderTracks();
  updateSeekUI();
  loadWaveformForTrack(track);
}

function playNext() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist || playlist.trackIds.length === 0) return;
  const nextIndex = state.currentIndex === null ? 0 : state.currentIndex + 1;
  if (nextIndex >= playlist.trackIds.length) {
    elements.audio.pause();
    elements.togglePlay.textContent = '再生';
    return;
  }
  playTrackAt(nextIndex);
}

function playPrev() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist || playlist.trackIds.length === 0) return;
  const prevIndex = state.currentIndex === null ? 0 : Math.max(0, state.currentIndex - 1);
  playTrackAt(prevIndex);
}

function togglePlay() {
  if (!elements.audio.src) {
    playNext();
    return;
  }

  if (elements.audio.paused) {
    elements.audio.play();
    elements.togglePlay.textContent = '一時停止';
  } else {
    elements.audio.pause();
    elements.togglePlay.textContent = '再生';
  }
}

async function addTracks(files) {
  for (const file of files) {
    const id = crypto.randomUUID();
    const track = {
      id,
      name: file.name.replace(/\.[^/.]+$/, ''),
      artist: '',
      memo: '',
      blob: file,
      createdAt: Date.now(),
    };
    await putItem(TRACK_STORE, track);
  }
  await loadPlaylists();
}

function registerDnD() {
  elements.trackList.addEventListener('dragstart', (event) => {
    const target = event.target.closest('li');
    if (!target) return;
    target.classList.add('dragging');
    event.dataTransfer.setData('text/plain', target.dataset.index || '');
  });

  elements.trackList.addEventListener('dragend', (event) => {
    const target = event.target.closest('li');
    if (!target) return;
    target.classList.remove('dragging');
  });

  elements.trackList.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  elements.trackList.addEventListener('drop', async (event) => {
    event.preventDefault();
    const target = event.target.closest('li');
    if (!target) return;
    const fromIndex = Number(event.dataTransfer.getData('text/plain'));
    const toIndex = Number(target.dataset.index);

    if (Number.isNaN(fromIndex) || Number.isNaN(toIndex) || fromIndex === toIndex) return;

    const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
    if (!playlist) return;

    const selectedTrackId =
      state.selectedIndex !== null ? playlist.trackIds[state.selectedIndex] : null;

    const [moved] = playlist.trackIds.splice(fromIndex, 1);
    playlist.trackIds.splice(toIndex, 0, moved);

    if (selectedTrackId) {
      state.selectedIndex = playlist.trackIds.indexOf(selectedTrackId);
    }
    await putItem(PLAYLIST_STORE, playlist);
    await loadPlaylists();
  });
}

function clearCurrentPlayback() {
  elements.audio.pause();
  elements.audio.src = '';
  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
    state.currentUrl = null;
  }
  state.currentIndex = null;
  state.currentTrackId = null;
  state.selectedIndex = null;
  state.librarySelectedIndex = null;
  state.waveformTrackId = null;
  state.waveformPeaks = null;
  state.waveformProgress = 0;
  elements.togglePlay.textContent = '再生';
  elements.nowTitle.textContent = '曲を選択';
  elements.nowSubtitle.textContent = 'プレイリストから再生できます';
  updateSeekUI();
}

async function handleCreatePlaylist() {
  const name = elements.playlistNameInput.value.trim();
  if (!name) return;
  const playlist = createPlaylistRecord(name);
  await putItem(PLAYLIST_STORE, playlist);
  elements.playlistNameInput.value = '';
  setActivePlaylist(playlist.id);
  await loadPlaylists();
}

async function handleDeletePlaylist() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) return;

  const confirmed = confirm(`「${playlist.name}」を削除しますか？`);
  if (!confirmed) return;

  if (state.currentTrackId && playlist.trackIds.includes(state.currentTrackId)) {
    clearCurrentPlayback();
  }

  await deleteItem(PLAYLIST_STORE, playlist.id);
  state.activePlaylistId = null;
  await loadPlaylists();
}

function registerEvents() {
  elements.createPlaylistButton.addEventListener('click', handleCreatePlaylist);
  elements.playlistNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleCreatePlaylist();
  });
  elements.deletePlaylistButton.addEventListener('click', handleDeletePlaylist);
  elements.exportJson.addEventListener('click', exportJson);
  elements.importJson.addEventListener('change', async (event) => {
    const file = event.target.files ? event.target.files[0] : null;
    if (file) {
      await importJson(file);
    }
    elements.importJson.value = '';
  });
  elements.fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      await addTracks(files);
      elements.fileInput.value = '';
    }
  });
  elements.prevTrack.addEventListener('click', playPrev);
  elements.nextTrack.addEventListener('click', playNext);
  elements.togglePlay.addEventListener('click', togglePlay);
  elements.volume.addEventListener('input', () => {
    const value = Number(elements.volume.value);
    elements.audio.volume = Number.isFinite(value) ? value : 0.8;
    localStorage.setItem('playerVolume', String(elements.audio.volume));
  });
  elements.audio.addEventListener('ended', playNext);
  elements.audio.addEventListener('play', startWaveformFollow);
  elements.audio.addEventListener('pause', stopWaveformFollow);
  elements.audio.addEventListener('ended', stopWaveformFollow);
  elements.audio.addEventListener('timeupdate', () => {
    if (!state.isSeeking) updateSeekUI();
  });
  elements.audio.addEventListener('loadedmetadata', updateSeekUI);
  elements.waveform.addEventListener('pointerdown', (event) => {
    const duration = elements.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    state.isSeeking = true;
    elements.waveform.setPointerCapture(event.pointerId);
    state.seekRatio = getWaveformRatio(event);
    updateSeekUI();
  });
  elements.waveform.addEventListener('pointermove', (event) => {
    if (!state.isSeeking) return;
    state.seekRatio = getWaveformRatio(event);
    updateSeekUI();
  });
  elements.waveform.addEventListener('pointerup', (event) => {
    if (!state.isSeeking) return;
    state.seekRatio = getWaveformRatio(event);
    commitSeek();
  });
  elements.waveform.addEventListener('pointercancel', commitSeek);
  window.addEventListener('resize', drawWaveform);
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && target.closest('input, textarea, select, button')) return;

    if (event.code === 'Space') {
      event.preventDefault();
      const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
      if (playlist && playlist.trackIds.length > 0 && state.selectedIndex !== null) {
        if (state.currentIndex !== state.selectedIndex) {
          playTrackAt(state.selectedIndex);
        } else {
          togglePlay();
        }
      } else {
        togglePlay();
      }
      return;
    }

    if (event.key === 'Backspace') {
      const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
      if (!playlist || playlist.trackIds.length === 0) return;
      if (state.selectedIndex === null) return;
      event.preventDefault();
      removeTrackFromPlaylist(state.selectedIndex);
      return;
    }

    if (event.key === 'Enter') {
      if (state.librarySelectedIndex === null) return;
      const track = state.libraryTracks[state.librarySelectedIndex];
      if (!track) return;
      event.preventDefault();
      addTrackToPlaylist(track.id);
      return;
    }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
    if (!playlist || playlist.trackIds.length === 0) return;
    event.preventDefault();
    const base =
      state.selectedIndex === null
        ? state.currentIndex !== null
          ? state.currentIndex
          : 0
        : state.selectedIndex;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    setSelectedIndex(base + delta, true);
  }

  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    if (state.libraryTracks.length === 0) return;
    event.preventDefault();
    const base = state.librarySelectedIndex === null ? 0 : state.librarySelectedIndex;
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    setLibrarySelectedIndex(base + delta, true);
  }
});
}

async function init() {
  state.activePlaylistId = getActivePlaylistId();
  const storedVolume = Number(localStorage.getItem('playerVolume'));
  if (Number.isFinite(storedVolume)) {
    elements.audio.volume = Math.min(Math.max(storedVolume, 0), 1);
    elements.volume.value = String(elements.audio.volume);
  } else {
    elements.audio.volume = Number(elements.volume.value);
  }
  await loadPlaylists();
  registerDnD();
  registerEvents();
  updateSeekUI();
}

init();
