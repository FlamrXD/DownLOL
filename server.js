const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const app = express();
app.use(express.json());
app.use(express.static('public'));

const VIDEO_FORMATS = ['mp4', 'webm'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav'];
const VIDEO_QUALITIES = ['best', '1080', '720', '480', '360'];
const AUDIO_QUALITIES = ['best', '320', '192', '128', '64'];
const JOB_TTL_MS = 15 * 60 * 1000;

const jobs = new Map();

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

function destroyJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.proc?.kill();
    for (const res of job.clients) res.end();
    fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
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

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'downlol-'));
    const jobId = crypto.randomUUID();

    const args = [
        '--no-playlist', '--restrict-filenames', '--no-colors',
        '--newline', '--progress',
        '-o', path.join(dir, '%(title).80B.%(ext)s')
    ];

    if (isAudio) {
        args.push('-x', '--audio-format', format,
                  '--audio-quality', quality === 'best' ? '0' : `${quality}K`);
    } else {
        const h = quality === 'best' ? '' : `[height<=${quality}]`;
        args.push('-f', `bv*${h}+ba/b${h}`, '--merge-output-format', format);
    }
    args.push('--', `https://www.youtube.com/watch?v=${id}`);

    const job = {
        dir, proc: null, events: [], clients: new Set(),
        state: 'running', file: null, lastError: null,
        streamIndex: 0, totalStreams: isAudio ? 1 : 2,
        timer: setTimeout(() => destroyJob(jobId), JOB_TTL_MS)
    };
    jobs.set(jobId, job);

    const proc = spawn(YTDLP, args);
    job.proc = proc;

    pipeLines(proc.stdout, l => handleLine(job, l, false));
    pipeLines(proc.stderr, l => handleLine(job, l, true));

    proc.on('error', err => {
        job.state = 'failed';
        emit(job, 'failed', {
            message: err.code === 'ENOENT' ? 'yt-dlp is not installed or not on PATH' : err.message
        });
    });

    proc.on('close', async (code, signal) => {
        if (job.state === 'failed' || signal) return;
        if (code !== 0) {
            job.state = 'failed';
            return emit(job, 'failed', {
                message: job.lastError || `yt-dlp exited with code ${code}`
            });
        }
        const files = await fs.promises.readdir(dir);
        if (!files.length) {
            job.state = 'failed';
            return emit(job, 'failed', { message: 'No file was produced' });
        }
        job.file = files[0];
        job.state = 'done';
        emit(job, 'done', { filename: job.file });
    });

    res.json({ id: jobId });
});

app.get('/api/progress/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).send('Unknown job');

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.flushHeaders();

    for (const msg of job.events) res.write(msg);
    job.clients.add(res);

    req.on('close', () => {
        job.clients.delete(res);
        if (job.state === 'running' && job.clients.size === 0) {
            destroyJob(req.params.id);
        }
    });
});

app.get('/api/file/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.state !== 'done') return res.status(404).send('File not ready');
    res.download(path.join(job.dir, job.file), job.file, () => destroyJob(req.params.id));
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));