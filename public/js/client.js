const urlInput = document.getElementById('url');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const bar = document.getElementById('bar');

const MAX_START_RETRIES = 5;
const MAX_RECONNECTS = 8;
const MAX_RESTARTS = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => Math.min(1000 * 2 ** n, 15000) + Math.random() * 500;

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
}

function setBar(percent) {
    bar.classList.remove('indeterminate', 'error');
    bar.style.width = percent + '%';
}

async function startWithRetry(body) {
    for (let i = 0; ; i++) {
        try {
            const res = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) return await res.json();
            if ([429, 502, 503, 504].includes(res.status) && i < MAX_START_RETRIES) {
                setStatus(res.status === 429
                    ? 'Waiting for your previous download to finish…'
                    : 'Server is busy or waking up, retrying…');
                const ra = Number(res.headers.get('Retry-After')) * 1000;
                await sleep(ra || backoff(i));
                continue;
            }
            throw new Error(await res.text());
        } catch (e) {
            if (e instanceof TypeError && i < MAX_START_RETRIES) {
                setStatus('Server unreachable, retrying…');
                await sleep(backoff(i));
                continue;
            }
            throw e;
        }
    }
}

function listen(id, onAlive) {
    return new Promise((resolve, reject) => {
        const es = new EventSource(`/api/progress/${id}`);
        const on = (name, fn) => es.addEventListener(name, e => { onAlive(); fn(JSON.parse(e.data)); });

        on('queued', ({ position }) => {
            bar.classList.add('indeterminate');
            setStatus(position > 1 ? `Queued, position ${position}…` : 'Queued, you are next…');
        });
        on('started', () => setStatus('Starting…'));
        on('log', ({ level, line }) => (level === 'error' ? console.error : console.log)('[yt-dlp]', line));
        on('progress', p => {
            setBar(p.percent.toFixed(1));
            const parts = [`Downloading ${p.percent.toFixed(1)}%`];
            if (p.totalStreams > 1) parts.push(`(part ${p.stream}/${p.totalStreams})`);
            if (p.speed) parts.push(`· ${p.speed}`);
            if (p.eta) parts.push(`· ETA ${p.eta}`);
            setStatus(parts.join(' '));
        });
        on('phase', () => {
            bar.classList.add('indeterminate');
            setStatus('Processing (merging / converting)…');
        });
        on('done', data => { es.close(); resolve(data); });
        on('failed', ({ message }) => {
            es.close();
            reject(Object.assign(new Error(message), { fatal: true }));
        });
        es.onerror = () => { es.close(); reject(new Error('stream closed')); };
    });
}

async function watch(id) {
    let failures = 0;
    while (true) {
        try {
            return await listen(id, () => (failures = 0));
        } catch (e) {
            if (e.fatal) throw e;
            if (++failures > MAX_RECONNECTS) {
                throw Object.assign(new Error('Lost connection to the server.'), { fatal: true });
            }
            setStatus(`Connection lost, reconnecting (${failures}/${MAX_RECONNECTS})…`);
            await sleep(backoff(failures));
            try {
                const r = await fetch(`/api/status/${id}`);
                if (r.status === 404) throw Object.assign(new Error('Server restarted'), { lost: true });
            } catch (err) {
                if (err.lost) throw err;
            }
        }
    }
}

async function runDownload(body) {
    for (let restart = 0; ; restart++) {
        const { id } = await startWithRetry(body);
        try {
            const { filename } = await watch(id);
            return { id, filename };
        } catch (e) {
            if (e.lost && restart < MAX_RESTARTS) {
                setStatus('Server restarted, resubmitting…');
                continue;
            }
            throw e.lost ? new Error('Server restarted, please try again.') : e;
        }
    }
}

downloadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return setStatus('Enter a URL or video ID first.', true);

    downloadBtn.disabled = true;
    progressEl.hidden = false;
    setBar(0);
    bar.classList.add('indeterminate');
    setStatus('Starting…');
    console.groupCollapsed('[downlol] download started');

    try {
        const { id, filename } = await runDownload({
            url,
            type: typeSelect.value,
            format: formatSelect.value,
            quality: qualitySelect.value
        });
        setBar(100);
        setStatus('Done! Saving ' + filename);
        console.log('[downlol] finished:', filename);

        const a = document.createElement('a');
        a.href = `/api/file/${id}`;
        a.download = filename;
        a.click();
    } catch (err) {
        bar.classList.remove('indeterminate');
        bar.classList.add('error');
        setStatus('Error: ' + err.message, true);
        console.error('[downlol]', err);
    } finally {
        downloadBtn.disabled = false;
        console.groupEnd();
    }
});