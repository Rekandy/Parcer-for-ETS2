import { DOMParser } from "@xmldom/xmldom";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { isKnownBrokenStream } from "./brokenStreams.js";
import {
    MAX_STREAM_VALIDATION_RETRIES,
    headers,
    delay,
} from "./constants.js";
import { validateStream, detectBitrate, validateWithRetries } from "./streamValidation.js";

const FETCH_TIMEOUT = 5000;
const DELAY_MS = 100;
const BASE_URL = "https://onlineradiobox.com/ua/?cs=ua.radiorelax.com.ua";
const PAGE_COUNT = 14;
const CONCURRENT_LIMIT = 8;
const STREAM_BATCH_SIZE = 20;

const streamCache = new Map();
const cookieJar = new Map();
const skippedStreamsCount = { value: 0 };

// Intentionally suppresses xmldom parser diagnostics (warnings/errors). The
// scraped HTML is frequently malformed and these messages are pure noise for
// this tool, so the handlers are deliberately silent no-ops (they must NOT log,
// or they would re-introduce the noise they exist to suppress). Shared by both
// DOMParser call sites below.
const SILENT_ERROR_HANDLER = { warning() { return; }, error() { return; } };

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

// Clear a pending timeout (if one is set) and return undefined so the caller can
// reset its handle. Extracted from fetchWithRetry to keep the repeated
// clear-if-set guard out of that function's control flow.
const clearPendingTimeout = timeoutId => {
    if (timeoutId) clearTimeout(timeoutId);
    return undefined;
};

// Build the fetch options for a request, attaching any stored cookie for the
// request's domain. Returns { options, domain } so the caller can persist a
// fresh set-cookie against the same domain.
const buildFetchOptions = (url, controller, initialTimeout) => {
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

    return { options, domain };
};

const fetchWithRetry = async (url, maxRetries = 3, initialTimeout = FETCH_TIMEOUT) => {
    let retries = 0;
    let timeoutId;

    while (retries < maxRetries) {
        try {
            const controller = new AbortController();
            timeoutId = clearPendingTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(), initialTimeout);

            const { options, domain } = buildFetchOptions(url, controller, initialTimeout);

            const res = await fetch(url, options);

            const setCookieHeader = res.headers.get("set-cookie");
            if (setCookieHeader) {
                cookieJar.set(domain, setCookieHeader);
            }

            timeoutId = clearPendingTimeout(timeoutId);
            return res;
        } catch {
            timeoutId = clearPendingTimeout(timeoutId);
            retries++;

            if (retries >= maxRetries) {
                throw new Error(`Failed to load ${url}`);
            }

            // Non-cryptographic jitter for retry backoff only; Math.random is
            // appropriate here (this value is never used for security).
            const backoff = Math.min(200 * (1.2 ** retries) + Math.random() * 100, 1000);
            await delay(backoff);
        }
    }
};

// Parse an HTML document string with the shared silent error handler. Returns
// the parsed document, or null if parsing throws.
//
// NOTE ON XSS FINDINGS: the code scanner flags the DOMParser.parseFromString
// call sites (here and in fetchRadioInfo) as XSS sinks. These are false
// positives: this tool only PARSES scraped HTML to read <source>/<audio>/anchor
// attributes; it never renders that HTML into a browser DOM or writes it back to
// any HTML output, so there is no injection surface. Parsing must stay (removing
// it would break scraping) and sanitizing the input would be meaningless for a
// parser. This scanner does not honor eslint-disable suppression comments, so
// the findings are documented here rather than suppressed inline.
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

// Sentinel returned by the response helpers to mean "no decision yet, keep
// going with the normal content-type handling". Distinct from null (reject)
// and from any string URL (accept).
const FALL_THROUGH = Symbol("fallThrough");

// Handle the branch where the response has no content-type header: read the
// first body chunk and accept the URL if any bytes arrive, caching it. On a
// read error, re-validate and accept if still valid. Returns the accepted URL,
// null to reject, or FALL_THROUGH to continue with normal handling (matching
// the original code, where an empty read simply falls through).
const handleNoContentTypeResponse = async (res, url, normalizedStream) => {
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
    return FALL_THROUGH;
};

// Handle a response once validation has passed: HTML pages route through the
// source/audio extraction path, everything else is confirmed via the retry
// validator and cached. Returns the resolved URL or null.
const finalizeStreamResponse = async (res, contentType, url, normalizedStream) => {
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
};

// Resolve a stream from a freshly fetched response: reject unsupported formats,
// require validation to pass, honor the no-content-type fall-through, then hand
// off to finalizeStreamResponse. Returns the resolved URL or null.
const resolveFetchedStream = async (res, stream, normalizedStream) => {
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
        const noTypeResult = await handleNoContentTypeResponse(res, url, normalizedStream);
        if (noTypeResult !== FALL_THROUGH) return noTypeResult;
    }

    return finalizeStreamResponse(res, contentType, url, normalizedStream);
};

// Return the cached URL for a stream if present and still valid, dropping it
// from the cache when validation fails. Returns the cached URL, null when the
// cached entry is invalid, or FALL_THROUGH when there is no cache entry.
const resolveCachedStream = async normalizedStream => {
    if (!streamCache.has(normalizedStream)) return FALL_THROUGH;

    const cachedUrl = streamCache.get(normalizedStream);
    const isValid = await validateStream(cachedUrl);
    if (!isValid) {
        streamCache.delete(normalizedStream);
        console.log(`Removed invalid stream from cache: ${cachedUrl}`);
        return null;
    }
    return cachedUrl;
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

    const cachedResult = await resolveCachedStream(normalizedStream);
    if (cachedResult !== FALL_THROUGH) return cachedResult;

    try {
        new URL(stream);
    } catch {
        return null;
    }

    try {
        const res = await fetchWithRetry(stream);
        return await resolveFetchedStream(res, stream, normalizedStream);
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
        .replaceAll(/&#34;/g, '"')
        .replaceAll(/&#39;/g, "'")
        .replaceAll(/"/g, "'");

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

        for (const [offset, url] of urls.slice(i, end).entries()) {
            batchPromises.push(processPage(url, i + offset));
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

    for (const [i, info] of list.entries()) {
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

// Only run the scraper when this file is executed directly (`node app.js`).
// Merely importing app.js (e.g. a future test importing a helper) must NOT
// start the live scraper. Compare this module's URL to the executed script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}


