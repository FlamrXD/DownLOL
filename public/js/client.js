const urlInput = document.getElementById('url');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const bar = document.getElementById('bar');

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
}

function setBar(percent) {
    bar.classList.remove('indeterminate', 'error');
    bar.style.width = percent + '%';
}

downloadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return setStatus('Enter a URL or video ID first.', true);

    // Reset UI
    downloadBtn.disabled = true;
    progressEl.hidden = false;
    setBar(0);
    bar.classList.add('indeterminate');
    setStatus('Starting…');
    console.groupCollapsed('[downlol] download started');

    let finished = false;
    const finish = () => {
        finished = true;
        downloadBtn.disabled = false;
        console.groupEnd();
    };

    try {
        const res = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                type: typeSelect.value,
                format: formatSelect.value,
                quality: qualitySelect.value
            })
        });
        if (!res.ok) throw new Error(await res.text());
        const { id } = await res.json();

        const es = new EventSource(`/api/progress/${id}`);

        es.addEventListener('log', e => {
            const { level, line } = JSON.parse(e.data);
            if (level === 'error') console.error('[yt-dlp]', line);
            else console.log('[yt-dlp]', line);
        });

        es.addEventListener('progress', e => {
            const p = JSON.parse(e.data);
            setBar(p.percent.toFixed(1));
            const parts = [`Downloading ${p.percent.toFixed(1)}%`];
            if (p.totalStreams > 1) parts.push(`(part ${p.stream}/${p.totalStreams})`);
            if (p.speed) parts.push(`· ${p.speed}`);
            if (p.eta) parts.push(`· ETA ${p.eta}`);
            setStatus(parts.join(' '));
        });

        es.addEventListener('phase', () => {
            bar.classList.add('indeterminate');
            setStatus('Processing (merging / converting)…');
        });

        es.addEventListener('done', e => {
            const { filename } = JSON.parse(e.data);
            es.close();
            setBar(100);
            setStatus('Done! Saving ' + filename);
            console.log('[downlol] finished:', filename);

            // The browser downloads the file directly (no memory buffering)
            const a = document.createElement('a');
            a.href = `/api/file/${id}`;
            a.download = filename;
            a.click();
            finish();
        });

        // Named "failed" because "error" is also EventSource's built-in connection event
        es.addEventListener('failed', e => {
            const { message } = JSON.parse(e.data);
            es.close();
            bar.classList.remove('indeterminate');
            bar.classList.add('error');
            setStatus('Error: ' + message, true);
            console.error('[downlol] failed:', message);
            finish();
        });

        es.onerror = () => {
            if (finished) return;
            es.close();
            bar.classList.remove('indeterminate');
            bar.classList.add('error');
            setStatus('Lost connection to the server.', true);
            console.error('[downlol] SSE connection lost');
            finish();
        };
    } catch (err) {
        bar.classList.remove('indeterminate');
        bar.classList.add('error');
        setStatus('Error: ' + err.message, true);
        console.error('[downlol]', err);
        finish();
    }
});