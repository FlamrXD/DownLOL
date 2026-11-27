const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const baseDir = path.dirname(process.execPath);
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join('public')));

async function openInBrowser(url) {
  const { default: open } = await import('open');
  return open(url);
}

const configPath = path.join('config.yml');

const defaultConfig = `# Application configuration
ytdlp_path: yt-dlp
cookies_path: /etc/secrets/cookies.txt
is_server: false

formats:
  video:
    - mp4
    - webm
  audio:
    - mp3
    - m4a
    - opus
    - wav

qualities:
  video:
    - best
    - "1080"
    - "720"
    - "480"
    - "360"
  audio:
    - best
    - "320"
    - "192"
    - "128"
    - "64"

limits:
  # Max number of jobs running at once
  max_concurrent: 3
  # Max number of jobs waiting for a slot
  max_queue: 10
  # Max number of jobs per IP (running + queued)
  max_jobs_per_ip: 1

timeouts_ms:
  job_ttl: 900000           # 15 * 60 * 1000
  disconnect_grace: 60000   # 60 * 1000
  run_timeout: 600000       # 10 * 60 * 1000
  keepalive: 15000          # 15 * 1000
`;

// Check and generate config.yml if missing
if (!fs.existsSync(configPath)) {
    console.log('config.yml not found. Generating default configuration file...');
    fs.writeFileSync(configPath, defaultConfig, 'utf8');
}

// Load configuration from conf.yml
const conf = yaml.load(fs.readFileSync(configPath, 'utf8'));
const YTDLP = process.env.YTDLP_PATH || conf.ytdlp_path || 'yt-dlp';
const COOKIES_SRC = process.env.COOKIES_PATH || conf.cookies_path || '/etc/secrets/cookies.txt';
console.log('cookies file:', fs.existsSync(COOKIES_SRC) ? 'found' : 'NOT found');

const is_server = conf.is_server ?? false;
const VIDEO_FORMATS = conf.formats?.video || ['mp4', 'webm'];
const AUDIO_FORMATS = conf.formats?.audio || ['mp3', 'm4a', 'opus', 'wav'];
const VIDEO_QUALITIES = conf.qualities?.video || ['best', '1080', '720', '480', '360'];
const AUDIO_QUALITIES = conf.qualities?.audio || ['best', '320', '192', '128', '64'];

// Limits (with environment variable overrides)
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || conf.limits?.max_concurrent || 3);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || conf.limits?.max_queue || 10);
const MAX_JOBS_PER_IP = Number(process.env.MAX_JOBS_PER_IP || conf.limits?.max_jobs_per_ip || 1);

// Timeouts
const JOB_TTL_MS = conf.timeouts_ms?.job_ttl || 15 * 60 * 1000;         
const DISCONNECT_GRACE_MS = conf.timeouts_ms?.disconnect_grace || 60 * 1000;
const RUN_TIMEOUT_MS = conf.timeouts_ms?.run_timeout || 10 * 60 * 1000;
const KEEPALIVE_MS = conf.timeouts_ms?.keepalive || 15 * 1000;

const jobs = new Map();
const queue = [];   // job ids waiting for a slot
let running = 0;

function extractId(input) {
    input = (input || '').trim();
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
        const u = new URL(input);
        if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12);
        if (u.hostname.endsWith('youtube.com')) {
            if (u.searchParams.get('v')) return u.searchParams.get('v');
            const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
            if (m) return m[2];
        }
    } catch {}
    return null;
}

function emit(job, event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    job.events.push(msg);
    if (job.events.length > 1000) job.events.shift();
    for (const res of job.clients) res.write(msg);
}

function broadcastQueue() {
    queue.forEach((id, i) => {
        const j = jobs.get(id);
        if (j) emit(j, 'queued', { position: i + 1, total: queue.length });
    });
}

function destroyJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    clearTimeout(job.graceTimer);
    const qi = queue.indexOf(id);
    if (qi !== -1) { queue.splice(qi, 1); broadcastQueue(); }
    job.proc?.kill('SIGKILL'); // 'close' handler frees the slot
    for (const res of job.clients) res.end();
    fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
}

// If nobody is listening to an unfinished job for a while, drop it
function armGrace(id) {
    const job = jobs.get(id);
    if (!job || job.state === 'done' || job.state === 'failed') return;
    clearTimeout(job.graceTimer);
    job.graceTimer = setTimeout(() => destroyJob(id), DISCONNECT_GRACE_MS);
}

function release(job) {
    if (!job.counted) return;
    job.counted = false;
    clearTimeout(job.runTimer);
    running--;
    scheduleNext();
}

function finishJob(id, job, event, data) {
    job.state = event === 'done' ? 'done' : 'failed';
    emit(job, event, data);
    clearTimeout(job.graceTimer);
    job.timer = setTimeout(() => destroyJob(id), JOB_TTL_MS);
}

function scheduleNext() {
    let changed = false;
    while (running < MAX_CONCURRENT && queue.length) {
        const id = queue.shift();
        const job = jobs.get(id);
        if (!job) continue;
        changed = true;
        runJob(id, job);
    }
    if (changed) broadcastQueue();
}

function handleLine(job, line, isStderr) {
    line = line.trim();
    if (!line) return;

    emit(job, 'log', { level: isStderr ? 'error' : 'info', line });

    if (isStderr && line.startsWith('ERROR:')) job.lastError = line.replace(/^ERROR:\s*/, '');

    const fm = line.match(/Downloading \d+ format\(s\):\s*(\S+)/);
    if (fm) job.totalStreams = fm[1].split('+').length;

    if (/^\[download\] Destination:/.test(line)) {
        job.streamIndex++;
        return;
    }

    const pm = line.match(/^\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/);
    if (pm) {
        const pct = parseFloat(pm[1]);
        const idx = Math.max(job.streamIndex - 1, 0);
        const overall = Math.min(((idx + pct / 100) / job.totalStreams) * 100, 100);
        emit(job, 'progress', {
            percent: overall,
            streamPercent: pct,
            stream: idx + 1,
            totalStreams: job.totalStreams,
            size: pm[2] || null,
            speed: pm[3] || null,
            eta: pm[4] || null
        });
        return;
    }

    if (/^\[(Merger|ExtractAudio|VideoConvertor|FFmpeg\w*)\]/.test(line)) {
        emit(job, 'phase', { phase: 'processing' });
    }
}

function pipeLines(stream, cb) {
    let buf = '';
    stream.on('data', chunk => {
        buf += chunk;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        lines.forEach(cb);
    });
    stream.on('end', () => buf && cb(buf));
}

app.post('/api/start', async (req, res) => {
    const { url, type, format, quality } = req.body || {};

    const id = extractId(url);
    if (!id || !/^[\w-]{11}$/.test(id)) {
        return res.status(400).send('Invalid YouTube URL or video ID');
    }

    const isAudio = type === 'audio';
    const formats = isAudio ? AUDIO_FORMATS : VIDEO_FORMATS;
    const qualities = isAudio ? AUDIO_QUALITIES : VIDEO_QUALITIES;
    if (!formats.includes(format) || !qualities.includes(quality)) {
        return res.status(400).send('Invalid options');
    }

    let active = 0;
    for (const j of jobs.values()) {
        if (j.ip === req.ip && (j.state === 'queued' || j.state === 'running')) active++;
    }
    if (active >= MAX_JOBS_PER_IP) {
        return res.status(429).set('Retry-After', '10').send('You already have a download in progress');
    }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'downlol-'));
    const jobId = crypto.randomUUID();

    const args = [
        '--no-playlist', '--restrict-filenames', '--no-colors',
        '--newline', '--progress',
        '--js-runtimes', 'deno,node',
        '-o', path.join(dir, '%(title).80B.%(ext)s')
    ];

    if (fs.existsSync(COOKIES_SRC)) {
        const cookiesCopy = path.join(dir, 'cookies.txt');
        fs.copyFileSync(COOKIES_SRC, cookiesCopy);
        args.push('--cookies', cookiesCopy);
    }

    if (isAudio) {
        args.push('-f', 'ba/b', '-x', '--audio-format', format,
                '--audio-quality', quality === 'best' ? '0' : `${quality}K`);
    } else {
        const h = quality === 'best' ? '' : `[height<=${quality}]`;
        args.push('-f', `bv*${h}+ba/b${h}/bv*+ba/b`, '--merge-output-format', format);
    }
    args.push('--', `https://www.youtube.com/watch?v=${id}`);

    if (queue.length >= MAX_QUEUE) {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        return res.status(503).set('Retry-After', '15').send('Server is busy, try again in a moment');
    }

    const job = {
        dir, args, ip: req.ip, proc: null, events: [], clients: new Set(),
        state: 'queued', file: null, lastError: null, counted: false,
        streamIndex: 0, totalStreams: isAudio ? 1 : 2,
        timer: null, graceTimer: null, runTimer: null
    };
    jobs.set(jobId, job);
    queue.push(jobId);
    armGrace(jobId);
    emit(job, 'queued', { position: queue.length, total: queue.length });
    scheduleNext();

    res.json({ id: jobId });
});

function runJob(id, job) {
    running++;
    job.counted = true;
    job.state = 'running';
    emit(job, 'started', {});

    const proc = spawn(YTDLP, job.args);
    job.proc = proc;
    job.runTimer = setTimeout(() => {
        job.lastError = 'Download timed out';
        proc.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    pipeLines(proc.stdout, l => handleLine(job, l, false));
    pipeLines(proc.stderr, l => handleLine(job, l, true));

    proc.on('error', err => {
        finishJob(id, job, 'failed', {
            message: err.code === 'ENOENT' ? 'yt-dlp is not installed or not on PATH' : err.message
        });
        release(job);
    });

    proc.on('close', async (code, signal) => {
        try {
            if (job.state === 'failed') return;
            if (signal) {
                if (jobs.has(id)) finishJob(id, job, 'failed', { message: job.lastError || 'Download cancelled' });
                return;
            }
            if (code !== 0) {
                return finishJob(id, job, 'failed', {
                    message: job.lastError || `yt-dlp exited with code ${code}`
                });
            }
            const files = (await fs.promises.readdir(job.dir)).filter(f => f !== 'cookies.txt');
            if (!files.length) return finishJob(id, job, 'failed', { message: 'No file was produced' });
            job.file = files[0];
            finishJob(id, job, 'done', { filename: job.file });
        } finally {
            release(job);
        }
    });
}

app.get('/api/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).send('Unknown job');
    res.json({ state: job.state });
});

app.get('/api/progress/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).send('Unknown job');

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    clearTimeout(job.graceTimer);
    for (const msg of job.events) res.write(msg);
    job.clients.add(res);

    const ping = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);

    req.on('close', () => {
        clearInterval(ping);
        job.clients.delete(res);
        if (job.clients.size === 0) armGrace(req.params.id);
    });
});

app.get('/api/file/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.state !== 'done') return res.status(404).send('File not ready');
    res.download(path.join(job.dir, job.file), job.file, () => destroyJob(req.params.id));
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));
if (is_server === false) {
    openInBrowser("http://localhost:3000");
}