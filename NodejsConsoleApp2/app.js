const { DOMParser } = require("@xmldom/xmldom");
const fs = require("node:fs").promises;
const http = require("node:http");
const https = require("node:https");

// List of known broken streams
const KNOWN_BROKEN_STREAMS = [
    "http://176.102.194.71:44808/radio",
    "http://185.96.188.24:8000/live",
    "http://78.154.164.191:18001/4",
    "http://91.203.4.121:8000/stream160",
    "http://complex.in.ua:80/struy",
    "http://online.sokal.lviv.ua:8000/sokalfm96.mp3",
    "http://stream-154.zeno.fm/ilibzonk6hotv",
    "https://audio.x-on.com.ua:8443/x-on-mp3-320.mp3",
    "https://bestfm.fm/",
    "https://c2.radioboss.fm:18472/stream",
    "https://cdn-br2.live-tv.cloud/sferarvFM/64k/icecast.audio",
    "https://cdn.vsnw.net:8943/kyiv_fm_128k",
    "https://complex.in.ua/b128",
    "https://complex.in.ua/buskfm",
    "https://complex.in.ua/tvoeRadio",
    "https://complex.in.ua/yantarne",
    "https://complex.in.ua/Yavir",
    "https://complex.in.ua/zhudachiv",
    "https://ec5.yesstreaming.net:2225/stream",
    "https://globalic.stream:1155/stream",
    "https://globalic.stream:1440/stream",
    "https://globalic.stream:1535/stream",
    "https://globalic.stream:1575/stream",
    "https://greeksonic.alphaserver.gr/8010/stream",
    "https://icecast.xtvmedia.pp.ua/melodeon.mp3",
    "https://icecast.xtvmedia.pp.ua/radiowandafm_hq.mp3",
    "https://icecast.xtvmedia.pp.ua/UKRNR.mp3",
    "https://listen6.myradio24.com/82192",
    "https://live.1tv.od.ua/radio/stream/icecast.audio",
    "https://main.inf.fm:8101/;",
    "https://myradio24.org/46801;stream.nsv",
    "https://onair.lviv.fm:8443/lviv.fm",
    "https://online-radio.nv.ua/radionv.mp3",
    "https://online.radiorecord.com.ua/rr_320",
    "https://play.radiotakt.com.ua/",
    "https://pulzusfm.eu/sionelo",
    "https://radio.bestfm.ua/bestfm",
    "https://radio.bug.fm:8000/radioBug",
    "https://radio.c4.com.ua:8443/320",
    "https://radio.dzvony.org.ua/",
    "https://radio.groza.ua:8443/neoradio",
    "https://radio.mfm.ua/online128",
    "https://radio.perec.fm/radio-stilnoe",
    "https://radio.radioshansonplus.com:8005/radio",
    "https://radio.radioshansonplus.com:8055/radio",
    "https://radio.rai.ua:9000/rai",
    "https://radio.ukr.radio/ur3-mp3-m",
    "https://radio.ukr.radio/ur5-mp3",
    "https://radio.zfm.com.ua:8443/zfm",
    "https://radiofm.stream:8443/muzvar_sq",
    "https://radiolla.com/",
    "https://radiostream.nakypilo.ua/full",
    "https://rockradioua.online:8433/rock_dodatok_256",
    "https://s5.radioforge.com:7908/live",
    "https://s61.radiolize.com/radio/8000/radio.mp3",
    "https://stream-153.zeno.fm/nkeaps48xg0uv",
    "https://stream-157.zeno.fm/m7tw0rc5kuhvv",
    "https://stream-159.zeno.fm/5ez2dnpgixktv",
    "https://stream-159.zeno.fm/swzfd3a9dchvv",
    "https://stream.blits-fm.ua/stream320",
    "https://stream.chv.ua:8443/acc.mp3",
    "https://stream.mistofm.com/listen/misto_fm_deep/radio.mp3",
    "https://stream.mistonadbugom.com.ua:8006/radiomistonadbugom",
    "https://stream.mjoy.ua:8443/kredens-cafe-radio_mp3",
    "https://stream.mjoy.ua:8443/radio-egoisty",
    "https://stream.mjoy.ua:8443/radio-great",
    "https://stream.mjoy.ua:8443/radio-mousse",
    "https://stream.radio.co/s4360dbc20/listen",
    "https://stream.radio.silpo.ua/silpo",
    "https://stream4.nadaje.com:9889/lux64",
];

// URL patterns for partial matching (for zeno.fm with tokens)
const BROKEN_URL_PATTERNS = [
    "stream-154.zeno.fm/ilibzonk6hotv",
    "stream-153.zeno.fm/nkeaps48xg0uv",
    "stream-157.zeno.fm/m7tw0rc5kuhvv",
    "stream-159.zeno.fm/5ez2dnpgixktv",
    "stream-159.zeno.fm/swzfd3a9dchvv",
];

const FETCH_TIMEOUT = 5000;
const DELAY_MS = 100;
const BASE_URL = "https://onlineradiobox.com/ua/?cs=ua.radiorelax.com.ua";
const PAGE_COUNT = 14;
const CONCURRENT_LIMIT = 8;
const STREAM_BATCH_SIZE = 20;
const BITRATE_SAMPLE_SIZE = 65536;
const STREAM_VALIDATION_TIMEOUT = 12000;
const MAX_STREAM_VALIDATION_RETRIES = 2;

const streamCache = new Map();
const cookieJar = new Map();
const skippedStreamsCount = { value: 0 };

// Intentionally suppresses xmldom parser diagnostics (warnings/errors). The
// scraped HTML is frequently malformed and these messages are pure noise for
// this tool, so the handlers are deliberately empty. Shared by both DOMParser
// call sites below.
const SILENT_ERROR_HANDLER = { warning() { }, error() { } };

// Reject stream candidates in formats this tool does not support (AAC, OGG,
// HLS/m3u8) or that point at the unsupported "https://cast" hosts. Matches the
// original inline checks exactly (both endsWith and includes variants).
const isUnsupportedAudioUrl = candidate => {
    const lower = candidate.toLowerCase();
    return (
        lower.endsWith("aac") ||
        lower.endsWith("ogg") ||
        lower.endsWith("m3u8") ||
        lower.includes("aac") ||
        lower.includes("ogg") ||
        lower.includes("m3u8") ||
        lower.startsWith("https://cast")
    );
};

// Same rejection check as isUnsupportedAudioUrl but against dotted extensions
// (".aac"/".ogg"/".m3u8"), as used for URLs extracted from <source>/<audio>.
const isUnsupportedAudioSource = candidate => {
    const lower = candidate.toLowerCase();
    return (
        lower.endsWith(".aac") ||
        lower.endsWith(".ogg") ||
        lower.endsWith(".m3u8") ||
        lower.includes(".aac") ||
        lower.includes(".ogg") ||
        lower.includes(".m3u8") ||
        lower.startsWith("https://cast")
    );
};

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://onlineradiobox.com/ua/",
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url, maxRetries = 3, initialTimeout = FETCH_TIMEOUT) => {
    let retries = 0;
    let timeoutId;

    while (retries < maxRetries) {
        try {
            const controller = new AbortController();
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(), initialTimeout);

            const options = {
                signal: controller.signal,
                headers: { ...headers },
                keepalive: true,
                redirect: "follow",
                timeout: initialTimeout,
            };

            const domain = new URL(url).hostname;
            if (cookieJar.has(domain)) {
                options.headers.Cookie = cookieJar.get(domain);
            }

            const res = await fetch(url, options);

            const setCookieHeader = res.headers.get("set-cookie");
            if (setCookieHeader) {
                cookieJar.set(domain, setCookieHeader);
            }

            if (timeoutId) clearTimeout(timeoutId);
            return res;
        } catch {
            if (timeoutId) clearTimeout(timeoutId);
            retries++;

            if (retries >= maxRetries) {
                throw new Error(`Failed to load ${url}`);
            }

            const backoff = Math.min(200 * (1.2 ** retries) + Math.random() * 100, 1000);
            await delay(backoff);
        }
    }
};

// Check if URL is a known broken stream
const isKnownBrokenStream = (url) => {
    if (KNOWN_BROKEN_STREAMS.includes(url)) {
        return true;
    }

    for (const pattern of BROKEN_URL_PATTERNS) {
        if (url.includes(pattern)) {
            return true;
        }
    }

    return false;
};

// Validate if a stream URL actually works
const validateStream = (url) => {
    return new Promise((resolve) => {
        try {
            if (isKnownBrokenStream(url)) {
                console.log(`Known broken stream: ${url}`);
                resolve(false);
                return;
            }

            const parsedUrl = new URL(url);
            const protocol = parsedUrl.protocol === "https:" ? https : http;

            const timeoutId = setTimeout(() => {
                if (req && !req.destroyed) {
                    req.destroy();
                }
                console.log(`Stream validation timeout exceeded for ${url}`);
                resolve(false);
            }, STREAM_VALIDATION_TIMEOUT);

            const requestTimeout = STREAM_VALIDATION_TIMEOUT - 1000;

            const req = protocol.get(url, {
                headers: {
                    ...headers,
                    "Range": "bytes=0-16384",
                },
                timeout: requestTimeout,
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    clearTimeout(timeoutId);
                    req.destroy();

                    if (url.includes("_redirect_count=")) {
                        const redirectCount = parseInt(url.match(/_redirect_count=(\d+)/)[1], 10);
                        if (redirectCount >= 5) {
                            console.log(`Too many redirects for ${url}`);
                            resolve(false);
                            return;
                        }
                    }

                    const redirectUrl = new URL(res.headers.location, url).href;
                    console.log(`Following redirect from ${url} to ${redirectUrl}`);

                    const nextUrl = redirectUrl.includes("_redirect_count=")
                        ? redirectUrl.replace(/_redirect_count=(\d+)/, (_match, p1) => `_redirect_count=${parseInt(p1, 10) + 1}`)
                        : `${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}_redirect_count=1`;

                    validateStream(nextUrl).then(resolve);
                    return;
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    clearTimeout(timeoutId);
                    req.destroy();
                    console.log(`Stream validation failed for ${url}: HTTP ${res.statusCode}`);
                    resolve(false);
                    return;
                }

                let dataReceived = false;
                let bytesReceived = 0;
                const minBytesToConfirm = 128;

                res.on("data", (chunk) => {
                    bytesReceived += chunk.length;

                    if (!dataReceived && bytesReceived >= minBytesToConfirm) {
                        dataReceived = true;
                        clearTimeout(timeoutId);
                        req.destroy();
                        console.log(`Stream validated successfully: ${url} (received ${bytesReceived} bytes)`);
                        resolve(true);
                    }
                });

                res.on("end", () => {
                    clearTimeout(timeoutId);
                    if (!dataReceived) {
                        console.log(`Stream validation incomplete for ${url}: received only ${bytesReceived} bytes`);
                        resolve(bytesReceived > 0);
                    } else {
                        resolve(true);
                    }
                });

                res.on("error", (err) => {
                    clearTimeout(timeoutId);
                    console.log(`Stream validation response error for ${url}: ${err.message}`);
                    resolve(false);
                });
            });

            req.on("error", (err) => {
                clearTimeout(timeoutId);
                if (err.code === "ECONNREFUSED") {
                    console.log(`Stream connection refused for ${url}`);
                } else if (err.code === "ENOTFOUND") {
                    console.log(`Stream host not found for ${url}`);
                } else if (err.code === "ETIMEDOUT") {
                    console.log(`Stream connection timed out for ${url}`);
                } else {
                    console.log(`Stream request error for ${url}: ${err.code || err.message}`);
                }
                resolve(false);
            });

            req.on("timeout", () => {
                clearTimeout(timeoutId);
                req.destroy();
                console.log(`Stream validation request timeout for ${url}`);
                resolve(false);
            });

            req.on("abort", () => {
                clearTimeout(timeoutId);
                console.log(`Stream request aborted for ${url}`);
                resolve(false);
            });

        } catch (error) {
            console.log(`Stream validation exception for ${url}: ${error.message}`);
            resolve(false);
        }
    });
};

// Detect bitrate from stream
const detectBitrate = (url) => {
    return new Promise((resolve) => {
        const bitrateRegex = /(128|160|192|224|256|320)k?b?p?s?/i;
        const urlMatch = url.match(bitrateRegex);

        if (urlMatch) {
            resolve(urlMatch[1]);
            return;
        }

        const timeoutId = setTimeout(() => {
            resolve(null);
        }, 8000);

        try {
            const parsedUrl = new URL(url);
            const protocol = parsedUrl.protocol === "https:" ? https : http;

            const req = protocol.get(url, {
                headers: { ...headers },
                timeout: 8000,
            }, (res) => {
                if (res.statusCode !== 200) {
                    clearTimeout(timeoutId);
                    resolve(null);
                    return;
                }

                const chunks = [];
                let totalLength = 0;
                const startTime = Date.now();

                res.on("data", (chunk) => {
                    chunks.push(chunk);
                    totalLength += chunk.length;

                    if (totalLength >= BITRATE_SAMPLE_SIZE) {
                        const endTime = Date.now();
                        const durationSeconds = (endTime - startTime) / 1000;

                        const bitrate = Math.round((totalLength * 8) / durationSeconds / 1000);

                        const commonBitrates = [128, 160, 192, 224, 256, 320];
                        const standardBitrate = commonBitrates.reduce((prev, curr) =>
                            Math.abs(curr - bitrate) < Math.abs(prev - bitrate) ? curr : prev,
                        );

                        clearTimeout(timeoutId);
                        req.destroy();
                        resolve(standardBitrate.toString());
                    }
                });

                res.on("error", () => {
                    clearTimeout(timeoutId);
                    resolve(null);
                });
            });

            req.on("error", () => {
                clearTimeout(timeoutId);
                resolve(null);
            });

            req.on("timeout", () => {
                clearTimeout(timeoutId);
                req.destroy();
                resolve(null);
            });

        } catch {
            clearTimeout(timeoutId);
            resolve(null);
        }
    });
};

// Validate a candidate URL, retrying up to MAX_STREAM_VALIDATION_RETRIES times
// with an increasing delay. `label` is the wording used in the retry log line
// (e.g. "audio source", "URL", "source", "stream") to preserve the original
// per-call messages. Returns true as soon as validation succeeds.
const validateWithRetries = async (candidateUrl, label) => {
    let isValid = false;
    for (let retryCount = 0; retryCount <= MAX_STREAM_VALIDATION_RETRIES; retryCount++) {
        if (retryCount > 0) {
            console.log(`Retry ${retryCount}/${MAX_STREAM_VALIDATION_RETRIES} for ${label} validation: ${candidateUrl}`);
            await delay(1000 * retryCount);
        }
        isValid = await validateStream(candidateUrl);
        if (isValid) break;
    }
    return isValid;
};

// Parse an HTML document string with the shared silent error handler. Returns
// the parsed document, or null if parsing throws.
const parseHtmlDocument = html => {
    try {
        return new DOMParser({ errorHandler: SILENT_ERROR_HANDLER })
            .parseFromString(html, "text/html");
    } catch {
        return null;
    }
};

// Resolve the first <audio> element's src (if any) against the base url,
// returning the absolute URL string or null. Mirrors the original inline logic.
const extractAudioSourceUrl = (doc, baseUrl) => {
    const audioElements = doc.getElementsByTagName("audio");
    if (!audioElements || audioElements.length === 0) return null;
    const src = audioElements[0].getAttribute("src");
    if (!src) return null;
    return new URL(src, baseUrl).href;
};

// Handle the branch where the HTML document exposes an <audio> element source.
// Returns the resolved stream URL to use, or null to reject. Preserves the
// original logging, skip-counting and cache-write behavior.
const handleAudioElement = async (doc, url, normalizedStream) => {
    const fullUrl = extractAudioSourceUrl(doc, url);
    if (!fullUrl) return null;

    if (isUnsupportedAudioSource(fullUrl)) return null;

    if (isKnownBrokenStream(fullUrl)) {
        skippedStreamsCount.value++;
        console.log(`Skipped known broken audio source: ${fullUrl} (total skipped: ${skippedStreamsCount.value})`);
        return null;
    }

    const isSourceValid = await validateWithRetries(fullUrl, "audio source");
    if (!isSourceValid) {
        console.log(`Audio source validation failed after ${MAX_STREAM_VALIDATION_RETRIES + 1} attempts: ${fullUrl}`);
        return null;
    }

    streamCache.set(normalizedStream, fullUrl);
    return fullUrl;
};

// Iterate over <source> elements and return the first usable resolved URL, or
// null if none qualify. Uses `return null` for hard rejections (unsupported
// format / known broken) and skips sources that merely fail validation, exactly
// as the original inline loop did.
const handleSourceElements = async (sources, url, normalizedStream) => {
    for (const source of Array.from(sources)) {
        const sourceSrc = source.getAttribute("src");
        if (!sourceSrc) continue;

        const fullUrl = new URL(sourceSrc, url).href;
        if (isUnsupportedAudioSource(fullUrl)) return null;

        if (isKnownBrokenStream(fullUrl)) {
            skippedStreamsCount.value++;
            console.log(`Skipped known broken source: ${fullUrl} (total skipped: ${skippedStreamsCount.value})`);
            return null;
        }

        const isSourceValid = await validateWithRetries(fullUrl, "source");
        if (!isSourceValid) continue;

        streamCache.set(normalizedStream, fullUrl);
        return fullUrl;
    }

    return null;
};

// Process an HTML (text/html) response: pick a usable stream URL from <source>
// or <audio> elements, falling back to validating the page URL itself.
const processHtmlResponse = async (html, url, normalizedStream) => {
    if (!html) return null;

    const doc = parseHtmlDocument(html);
    if (!doc) return null;

    const sources = doc.getElementsByTagName("source");
    if (!sources || sources.length === 0) {
        const audioResult = await handleAudioElement(doc, url, normalizedStream);
        if (audioResult) return audioResult;

        const isUrlValid = await validateWithRetries(url, "URL");
        if (!isUrlValid) {
            console.log(`URL validation failed after ${MAX_STREAM_VALIDATION_RETRIES + 1} attempts: ${url}`);
            return null;
        }

        streamCache.set(normalizedStream, url);
        return url;
    }

    return handleSourceElements(sources, url, normalizedStream);
};

const processStream = async stream => {
    if (!stream) return null;

    const normalizedStream = stream.trim();

    if (isKnownBrokenStream(normalizedStream)) {
        skippedStreamsCount.value++;
        console.log(`Skipped known broken stream: ${normalizedStream} (total skipped: ${skippedStreamsCount.value})`);
        return null;
    }

    if (isUnsupportedAudioUrl(normalizedStream)) {
        return null;
    }

    if (streamCache.has(normalizedStream)) {
        const cachedUrl = streamCache.get(normalizedStream);
        const isValid = await validateStream(cachedUrl);
        if (!isValid) {
            streamCache.delete(normalizedStream);
            console.log(`Removed invalid stream from cache: ${cachedUrl}`);
            return null;
        }
        return cachedUrl;
    }

    try {
        try {
            new URL(stream);
        } catch {
            return null;
        }

        const res = await fetchWithRetry(stream);
        const url = res.redirected ? res.url : stream;

        if (isUnsupportedAudioUrl(url)) {
            return null;
        }

        const isValid = await validateStream(url);
        if (!isValid) {
            console.log(`Stream validation failed for URL: ${url}`);
            return null;
        }

        const contentType = res.headers.get("content-type");

        if (!contentType) {
            try {
                const reader = res.body.getReader();
                const { value } = await reader.read();
                if (value && value.length > 0) {
                    streamCache.set(normalizedStream, url);
                    return url;
                }
            } catch {
                const isStreamValid = await validateStream(url);
                if (!isStreamValid) return null;

                streamCache.set(normalizedStream, url);
                return url;
            }
        }

        const type = (contentType || "").toLowerCase();

        if (type.includes("text/html")) {
            const html = await res.text();
            return processHtmlResponse(html, url, normalizedStream);
        }

        const isStreamWorkingProperly = await validateWithRetries(url, "stream");
        if (!isStreamWorkingProperly) {
            console.log(`Stream validation failed after ${MAX_STREAM_VALIDATION_RETRIES + 1} attempts: ${url}`);
            return null;
        }

        const result = res.ok ? url : null;

        if (result) streamCache.set(normalizedStream, result);
        return result;
    } catch (e) {
        console.error(`Error processing stream ${stream}: ${e.message}`);
        return null;
    }
};

// Find the "b-play station_play" play button within a station element, or null.
const findPlayButton = station => {
    const buttons = station.getElementsByTagName("button");
    for (const button of Array.from(buttons)) {
        if (button.getAttribute("class") === "b-play station_play") {
            return button;
        }
    }
    return null;
};

// Derive the station genre from its genre link, capitalizing the first letter.
// Returns 'Unknown' when no genre link is present, matching the original logic.
const extractGenre = station => {
    const links = station.getElementsByTagName("a");
    for (const link of Array.from(links)) {
        const href = link.getAttribute("href");
        if (href?.includes("/ua/genre/")) {
            let genre = link.textContent.trim();
            if (genre) {
                genre = genre.charAt(0).toUpperCase() + genre.slice(1);
            }
            return genre;
        }
    }
    return "Unknown";
};

// Parse a single station element into { stream, radioName, genre }, or null when
// the station has no play button/stream, or is a known broken stream (in which
// case it is counted and logged as skipped, exactly as before).
const parseStation = station => {
    const btn = findPlayButton(station);

    if (!btn?.getAttribute("stream")) return null;

    const streamUrl = btn.getAttribute("stream");

    if (isKnownBrokenStream(streamUrl)) {
        skippedStreamsCount.value++;
        console.log(`Skipped known broken station: ${streamUrl} (total skipped: ${skippedStreamsCount.value})`);
        return null;
    }

    const genre = extractGenre(station);

    const radioName = (btn.getAttribute("radioName") || "Unknown")
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/"/g, "'");

    return {
        stream: streamUrl,
        radioName,
        genre,
    };
};

const fetchRadioInfo = async url => {
    try {
        const res = await fetchWithRetry(url);
        const html = await res.text();
        if (!html) return [];

        const doc = new DOMParser({ errorHandler: SILENT_ERROR_HANDLER })
            .parseFromString(html, "text/html");

        if (!doc?.getElementsByClassName) return [];

        const stations = doc.getElementsByClassName("stations__station");
        const results = [];

        for (const station of Array.from(stations)) {
            const info = parseStation(station);
            if (info) results.push(info);
        }

        return results;
    } catch {
        console.error(`Error loading page: ${url}`);
        return [];
    }
};

async function processStreamBatch(infos) {
    const results = [];

    for (let i = 0; i < infos.length; i += STREAM_BATCH_SIZE) {
        const batch = infos.slice(i, i + STREAM_BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(async info => {
                const stream = await processStream(info.stream);
                if (!stream) return null;

                const detectedBitrate = await detectBitrate(stream);
                return { ...info, stream, detectedBitrate };
            }),
        );

        results.push(...batchResults.filter(Boolean));

        if (i + STREAM_BATCH_SIZE < infos.length) {
            await delay(300);
        }
    }

    return results;
}

const fetchAllRadioInfo = async () => {
    const urls = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
        urls.push(`${BASE_URL}&p=${i}&tzLoc=Europe%2FWarsaw`);
    }

    const radioMap = new Map();

    async function processPage(url, pageIndex) {
        console.log(`Loading page ${pageIndex + 1}/${urls.length}`);
        const infos = await fetchRadioInfo(url);

        const validInfos = await processStreamBatch(infos);
        console.log(`Found ${validInfos.length} stations on page ${pageIndex + 1}`);

        validInfos.forEach(info => {
            radioMap.set(info.stream, info);
        });
    }

    for (let i = 0; i < urls.length; i += CONCURRENT_LIMIT) {
        const batchPromises = [];
        const end = Math.min(i + CONCURRENT_LIMIT, urls.length);

        for (let j = i; j < end; j++) {
            batchPromises.push(processPage(urls[j], j));
        }

        await Promise.all(batchPromises);

        if (end < urls.length) {
            await delay(DELAY_MS);
        }
    }

    return Array.from(radioMap.values())
        .sort((a, b) => a.stream.localeCompare(b.stream));
};

const generateSiiFile = async list => {
    const bitrateRegex = /(128|160|192|224|256|320)/;

    const lines = [
        "SiiNunit",
        "{",
        "live_stream_def : .live_streams {",
        `\tstream_data: ${list.length}`,
    ];

    for (let i = 0; i < list.length; i++) {
        const info = list[i];
        let bitrate = "320";

        if (info.detectedBitrate) {
            bitrate = info.detectedBitrate;
        } else {
            const streamMatch = info.stream.match(bitrateRegex);
            if (streamMatch) {
                bitrate = streamMatch[0];
            } else {
                const nameMatch = info.radioName.match(bitrateRegex);
                if (nameMatch) {
                    bitrate = nameMatch[0];
                }
            }
        }

        lines.push(`\tstream_data[${i}]: "${info.stream}|${info.radioName}|${info.genre}|UA|${bitrate}|0"`);
    }

    lines.push("}", "}");
    await fs.writeFile("live_streams.sii", lines.join("\n"), "utf8");
};

const main = async () => {
    console.time("Total execution time");
    try {
        console.log("Connecting to the service...");
        await fetchWithRetry(BASE_URL);
        await delay(1000);

        console.log("Fetching the list of radio stations...");
        const radioList = await fetchAllRadioInfo();

        console.log(`${radioList.length} working radio stations found`);
        if (!radioList.length) throw new Error("No radio stations found");

        console.log("Creating SII file...");
        await generateSiiFile(radioList);
        console.log("The file live_streams.sii has been successfully created");
    } catch (e) {
        console.error("Error:", e.message);
        process.exit(1);
    } finally {
        console.timeEnd("Total execution time");
    }
};

main();


