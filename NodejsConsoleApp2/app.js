const { DOMParser } = require('xmldom');
const fs = require('fs').promises;

const SUPPORTED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3']);
const FETCH_TIMEOUT = 5000;
const DELAY_MS = 500;
const BASE_URL = 'https://onlineradiobox.com/ua/?cs=ua.radiorelax.com.ua';
const PAGE_COUNT = 15;
const CONCURRENT_LIMIT = 3;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, timeout = FETCH_TIMEOUT) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } catch (e) {
        throw e.name === 'AbortError' ? new Error('Timeout') : e;
    } finally {
        clearTimeout(id);
    }
};

const processStream = async stream => {
    if (!stream) return null;
    try {
        const res = await fetchWithTimeout(stream);
        const url = res.redirected ? res.url : stream;
        const type = res.headers.get('content-type')?.toLowerCase() || '';

        if (!type) return null;

        if (type.includes('text/html')) {
            const html = await res.text();
            if (!html) return null;
            const doc = new DOMParser({ errorHandler: { warning: () => { }, error: () => { } } })
                .parseFromString(html, 'text/html');
            if (!doc?.getElementsByTagName) return null;
            return Array.from(doc.getElementsByTagName('source'))
                .some(s => SUPPORTED_AUDIO_TYPES.has(s.getAttribute('type')))
                ? url : null;
        }

        return SUPPORTED_AUDIO_TYPES.has(type.split(';')[0]) ? url : null;
    } catch (e) {
        console.error(`Stream error (${stream}): ${e.message}`);
        return null;
    }
};

const fetchRadioInfo = async url => {
    try {
        const res = await fetchWithTimeout(url);
        const html = await res.text();
        if (!html) return [];

        const doc = new DOMParser({ errorHandler: { warning: () => { }, error: () => { } } })
            .parseFromString(html, 'text/html');
        if (!doc?.getElementsByClassName) return [];

        return Array.from(doc.getElementsByClassName('stations__station'))
            .map(station => {
                const btn = Array.from(station.getElementsByTagName('button'))
                    .find(b => b.getAttribute('class') === 'b-play station_play');
                if (!btn?.getAttribute('stream')) return null;
                return {
                    stream: btn.getAttribute('stream'), 
                    radioName: (btn.getAttribute('radioName') || 'Unknown').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/"/g, "'"), 
                    genre: (Array.from(station.getElementsByTagName('a'))
                        .find(a => a.getAttribute('href')?.includes('/ua/genre/'))
                        ?.textContent.trim().replace(/^./, s => s.toUpperCase())) || 'Unknown'
                };
            })
            .filter(Boolean);
    } catch (e) {
        console.error(`Fetch error (${url}): ${e.message}`);
        return [];
    }
};

const fetchAllRadioInfo = async () => {
    const urls = Array.from({ length: PAGE_COUNT }, (_, i) =>
        `${BASE_URL}&p=${i}&tzLoc=Europe%2FWarsaw`);
    const radioSet = new Set();

    const processBatch = async (batch, batchIndex) => {
        console.log(`Processing batch ${batchIndex + 1}/${Math.ceil(urls.length / CONCURRENT_LIMIT)}`);
        const results = await Promise.all(batch.map(async (url, i) => {
            console.log(`Fetching ${batchIndex * CONCURRENT_LIMIT + i + 1}/${urls.length}: ${url}`);
            const infos = await fetchRadioInfo(url);
            return Promise.all(infos.map(async info => {
                const stream = await processStream(info.stream);
                return stream ? { ...info, stream } : null;
            }));
        }));

        results.flat().filter(Boolean).forEach(info => radioSet.add(JSON.stringify(info)));
    };

    for (let i = 0; i < urls.length; i += CONCURRENT_LIMIT) {
        const batch = urls.slice(i, i + CONCURRENT_LIMIT);
        await processBatch(batch, i / CONCURRENT_LIMIT);
        if (i + CONCURRENT_LIMIT < urls.length) await delay(DELAY_MS);
    }

    return Array.from(radioSet, JSON.parse)
        .sort((a, b) => a.stream.localeCompare(b.stream));
};

const generateSiiFile = async list => {
    const bitrateRegex = /(128|160|192|256|320)/;
    const lines = [
        'SiiNunit',
        '{',
        'live_stream_def : .live_streams {',
        ` stream_data: ${list.length - 1}`
    ];

    list.forEach((info, i) => {
        const bitrate = (info.stream.match(bitrateRegex) ||
            info.radioName.match(bitrateRegex) || ['320'])[0];
        lines.push(` stream_data[${i}]: "${info.stream}|${info.radioName}|${info.genre}|UA|${bitrate}|0"`);
    });

    lines.push('}', '}');
    await fs.writeFile('live_streams.sii', lines.join('\n'), 'utf8');
};

const main = async () => {
    try {
        const radioList = await fetchAllRadioInfo();
        if (!radioList.length) throw new Error('No radio info collected');
        await generateSiiFile(radioList);
        console.log('live_streams.sii written successfully');
    } catch (e) {
        console.error('Main error:', e.message);
        process.exit(1);
    }
};

main();