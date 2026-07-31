const $ = (id) => document.getElementById(id);
const state = { jobId: null, plan: null, total: 0, done: 0, slots: new Map() };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function api(route, options) {
  const res = await fetch(route, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '请求失败');
  return body;
}

const postJson = (route, body) =>
  api(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function checkHealth() {
  try {
    const h = await api('/api/health');
    const problems = [];
    if (!h.ffmpeg || !h.ffprobe) {
      problems.push('未找到 ffmpeg / ffprobe，视频功能不可用（brew install ffmpeg）');
    }
    if (!h.sips) problems.push('未找到 sips，图片功能不可用（本工具需要 macOS）');
    if (h.ffmpeg && !h.videotoolbox) {
      problems.push('当前 ffmpeg 不支持 hevc_videotoolbox，将回退到较慢的 libx265');
    }
    if (problems.length) {
      $('health').classList.remove('hidden');
      $('health').innerHTML = problems.map((p) => `<div class="error">⚠️ ${esc(p)}</div>`).join('');
    }
  } catch {
    // 自检失败不阻塞主流程
  }
}

// ---------- 选择文件夹 ----------

const drop = $('drop');
['dragenter', 'dragover'].forEach((e) =>
  drop.addEventListener(e, (ev) => {
    ev.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((e) =>
  drop.addEventListener(e, () => drop.classList.remove('over'))
);

// 浏览器不暴露本地绝对路径，只能拿文件夹名 + 若干样本文件反查
function readSamples(dirEntry, limit) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    reader.readEntries((entries) => {
      const files = entries.filter((e) => e.isFile).slice(0, limit);
      if (files.length === 0) return resolve([]);
      const out = [];
      let pending = files.length;
      files.forEach((f) =>
        f.file(
          (file) => {
            out.push({ name: file.name, size: file.size });
            if (--pending === 0) resolve(out);
          },
          () => {
            if (--pending === 0) resolve(out);
          }
        )
      );
    }, () => resolve([]));
  });
}

drop.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const entry = ev.dataTransfer.items[0]?.webkitGetAsEntry();
  if (!entry?.isDirectory) {
    $('pickMsg').textContent = '请拖入一个文件夹，而不是单个文件。';
    return;
  }
  $('pickMsg').textContent = '正在定位文件夹…';
  try {
    const samples = await readSamples(entry, 20);
    const { candidates } = await postJson('/api/resolve', {
      folderName: entry.name,
      samples,
    });

    if (candidates.length === 1) return scan(candidates[0]);
    if (candidates.length === 0) {
      $('pickMsg').innerHTML =
        `没能在 Downloads / Desktop / Pictures / Documents / Movies 里找到「${esc(entry.name)}」，` +
        '请在下面粘贴完整路径，或点「浏览」逐级选择。';
      return;
    }
    $('pickMsg').innerHTML =
      '找到多个同名文件夹，请选择：<div class="dirlist">' +
      candidates.map((c) => `<div data-path="${esc(c)}">📁 ${esc(c)}</div>`).join('') +
      '</div>';
    $('pickMsg').querySelectorAll('[data-path]').forEach((el) =>
      el.addEventListener('click', () => scan(el.dataset.path))
    );
  } catch (err) {
    $('pickMsg').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
});

$('useBtn').addEventListener('click', async () => {
  try {
    const check = await postJson('/api/validate', { path: $('pathInput').value });
    if (!check.ok) {
      $('pickMsg').innerHTML = `<span class="error">${esc(check.error)}</span>`;
      return;
    }
    scan(check.path);
  } catch (err) {
    $('pickMsg').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
});

$('pathInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('useBtn').click();
});

$('browseBtn').addEventListener('click', () => {
  $('browser').classList.toggle('hidden');
  if (!$('browser').classList.contains('hidden')) openDir('~');
});

let currentDir = null;
async function openDir(p) {
  try {
    const data = await api(`/api/ls?path=${encodeURIComponent(p)}`);
    currentDir = data.path;
    $('browserPath').textContent = data.path;
    $('upBtn').disabled = !data.parent;
    $('upBtn').dataset.path = data.parent || '';
    $('dirlist').innerHTML = data.dirs
      .map((d) => `<div data-path="${esc(d.path)}">📁 ${esc(d.name)}</div>`)
      .join('');
    $('dirlist').querySelectorAll('[data-path]').forEach((el) =>
      el.addEventListener('click', () => openDir(el.dataset.path))
    );
  } catch (err) {
    $('pickMsg').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}
$('upBtn').addEventListener('click', () => {
  if ($('upBtn').dataset.path) openDir($('upBtn').dataset.path);
});
$('chooseBtn').addEventListener('click', () => currentDir && scan(currentDir));

// ---------- 扫描与预演 ----------

async function scan(folderPath) {
  $('pickMsg').textContent = '正在扫描与比对，文件多时需要一会儿…';
  try {
    const plan = await postJson('/api/scan', { path: folderPath });
    state.jobId = plan.jobId;
    state.plan = plan;
    showPlan(plan);
  } catch (err) {
    $('pickMsg').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

function showPlan(plan) {
  $('pickMsg').textContent = '';
  $('step-pick').classList.add('hidden');
  $('step-plan').classList.remove('hidden');
  $('planTitle').textContent = plan.root;

  const s = plan.stats;
  const cards = [
    [s.imageCount, '张图片'],
    [s.videoCount, '个视频'],
    [s.dupCount, `个重复文件（${fmtBytes(s.dupBytes)}）`],
    [s.heicCount, '张待转 HEIC'],
    [s.imageCompressCount, '张图片超 3MB'],
    [s.videoCompressCount, '个视频待压制'],
  ];
  $('planStats').innerHTML =
    cards
      .map(([n, l]) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`)
      .join('') +
    `<div class="stat" style="grid-column:1/-1"><div class="n">约 ${fmtBytes(s.estimatedSaving)}</div>` +
    '<div class="l">预计可节省空间</div></div>';

  const nothingToDo =
    s.dupCount === 0 && s.heicCount === 0 && s.imageCompressCount === 0 && s.videoCompressCount === 0;
  $('runBtn').disabled = nothingToDo;
  $('runBtn').textContent = nothingToDo ? '没有需要处理的文件' : '开始处理';
}

$('backBtn').addEventListener('click', () => {
  $('step-plan').classList.add('hidden');
  $('step-pick').classList.remove('hidden');
});

// ---------- 执行 ----------

$('runBtn').addEventListener('click', async () => {
  $('runBtn').disabled = true;
  const options = {
    dedup: $('optDedup').checked,
    heic: $('optHeic').checked,
    imageCompress: $('optImage').checked,
    videoCompress: $('optVideo').checked,
  };

  const imageCount = state.plan.images.filter(
    (i) => (i.convert && options.heic) || (i.compress && options.imageCompress)
  ).length;
  state.total =
    (options.dedup ? state.plan.stats.dupCount : 0) +
    imageCount +
    (options.videoCompress ? state.plan.videos.length : 0);
  state.done = 0;

  $('step-plan').classList.add('hidden');
  $('step-run').classList.remove('hidden');

  try {
    await postJson('/api/run', { jobId: state.jobId, options });
  } catch (err) {
    $('phaseText').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    return;
  }

  const es = new EventSource(`/api/events?jobId=${state.jobId}`);
  es.onmessage = (ev) => handleEvent(JSON.parse(ev.data), es);
});

const ACTION_LABEL = {
  'dedup-removed': ['ok', '已删重复'],
  'heic-converted': ['ok', '已转 JPG'],
  'image-compressed': ['ok', '已压缩'],
  'video-compressed': ['ok', '已压制'],
  skipped: ['skip', '已跳过'],
  error: ['err', '失败'],
};

function handleEvent(event, es) {
  if (event.type === 'phase') {
    $('phaseText').textContent = event.message;
    return;
  }

  if (event.type === 'video-progress') {
    let slot = state.slots.get(event.rel);
    if (!slot) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<div class="name">${esc(event.rel)}</div><div class="bar"><i></i></div>`;
      $('slots').appendChild(el);
      slot = { el, bar: el.querySelector('i') };
      state.slots.set(event.rel, slot);
    }
    slot.bar.style.width = `${Math.round(event.ratio * 100)}%`;
    return;
  }

  if (event.type === 'item') {
    state.done += 1;
    $('overallBar').style.width = `${Math.round((state.done / Math.max(1, state.total)) * 100)}%`;
    state.slots.get(event.rel)?.el.remove();
    state.slots.delete(event.rel);

    const [cls, label] = ACTION_LABEL[event.action] || ['skip', event.action];
    let detail;
    if (event.action === 'error') detail = event.error;
    else if (event.action === 'skipped') detail = event.note || '无需处理';
    else detail = `${fmtBytes(event.before)} → ${fmtBytes(event.after)}`;

    const line = document.createElement('div');
    line.innerHTML =
      `<span class="tag ${cls}">${label}</span>${esc(event.rel)} ` +
      `<span class="hint">${esc(detail)}</span>`;
    $('log').prepend(line);
    return;
  }

  if (event.type === 'done') {
    es.close();
    $('overallBar').style.width = '100%';
    const r = event.report;
    $('phaseText').innerHTML =
      `全部完成，共节省 ${fmtBytes(r.savedBytes)}` +
      (r.errors.length ? `，${r.errors.length} 个文件失败` : '') +
      '<div class="hint" style="font-weight:400;margin-top:6px">原文件都在 ' +
      `<code>${esc(r.trashDir || '_trash')}</code>，确认无误后可自行删除。</div>`;
  }
}

checkHealth();
