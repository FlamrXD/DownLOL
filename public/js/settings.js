const toggle = document.getElementById('settingsToggle');
const panel = document.getElementById('settingsPanel');
const typeSelect = document.getElementById('type');
const formatSelect = document.getElementById('format');
const qualitySelect = document.getElementById('quality');

const OPTIONS = {
    video: {
        formats: [
            { value: 'mp4', label: 'MP4' },
            { value: 'webm', label: 'WebM' }
        ],
        qualities: [
            { value: 'best', label: 'Best available' },
            { value: '1080', label: '1080p' },
            { value: '720', label: '720p' },
            { value: '480', label: '480p' },
            { value: '360', label: '360p' }
        ]
    },
    audio: {
        formats: [
            { value: 'mp3', label: 'MP3' },
            { value: 'm4a', label: 'M4A' },
            { value: 'opus', label: 'Opus' },
            { value: 'wav', label: 'WAV (lossless)' }
        ],
        qualities: [
            { value: 'best', label: 'Best available' },
            { value: '320', label: '320 kbps' },
            { value: '192', label: '192 kbps' },
            { value: '128', label: '128 kbps' },
            { value: '64', label: '64 kbps' }
        ]
    }
};

function fill(select, items) {
    select.innerHTML = '';
    for (const { value, label } of items) {
        select.add(new Option(label, value));
    }
}

function updateOptions() {
    const { formats, qualities } = OPTIONS[typeSelect.value];
    fill(formatSelect, formats);
    fill(qualitySelect, qualities);
}

typeSelect.addEventListener('change', updateOptions);
updateOptions(); // populate on load

toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open);
    toggle.textContent = open ? 'Settings ▴' : 'Settings ▾';
});