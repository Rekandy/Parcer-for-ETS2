import http from "node:http";
import https from "node:https";
import { isKnownBrokenStream } from "./brokenStreams.js";
import {
    BITRATE_SAMPLE_SIZE,
    STREAM_VALIDATION_TIMEOUT,
    MAX_STREAM_VALIDATION_RETRIES,
    headers,
    delay,
} from "./constants.js";

// Top-level replacement for the redirect-count replace callback used by
// handleValidationRedirect. Byte-identical behavior: same regex group, same
// returned template string.
const incrementRedirectCount = (_match, p1) => `_redirect_count=${parseInt(p1, 10) + 1}`;

// Handle a 3xx redirect during stream validation: enforce the redirect-count
// cap, build the next URL (incrementing/appending _redirect_count) and recurse
// through validateStream, forwarding the eventual boolean to resolve. Assumes
// the caller has already cleared the timeout and destroyed the request.
const handleValidationRedirect = (url, location, resolve) => {
    if (url.includes("_redirect_count=")) {
        const redirectCount = parseInt(url.match(/_redirect_count=(\d+)/)[1], 10);
        if (redirectCount >= 5) {
            console.log(`Too many redirects for ${url}`);
            resolve(false);
            return;
        }
    }

    const redirectUrl = new URL(location, url).href;
    console.log(`Following redirect from ${url} to ${redirectUrl}`);

    const nextUrl = redirectUrl.includes("_redirect_count=")
        ? redirectUrl.replace(/_redirect_count=(\d+)/, incrementRedirectCount)
        : `${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}_redirect_count=1`;

    validateStream(nextUrl).then(resolve);
};

// Attach the data/end/error listeners for a 2xx validation response. Resolves
// true once at least minBytesToConfirm bytes arrive (or on a partial-but-
// nonempty end), false on response error. Preserves the original log wording.
const attachValidationResponseHandlers = (req, res, url, timeoutId, resolve) => {
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
};

// Attach the request-level error/timeout/abort listeners for stream validation.
// Each resolves false; the error listener distinguishes the common error codes
// with the same log wording as the original inline handlers.
const attachValidationRequestHandlers = (req, url, timeoutId, resolve) => {
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
                    handleValidationRedirect(url, res.headers.location, resolve);
                    return;
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    clearTimeout(timeoutId);
                    req.destroy();
                    console.log(`Stream validation failed for ${url}: HTTP ${res.statusCode}`);
                    resolve(false);
                    return;
                }

                attachValidationResponseHandlers(req, res, url, timeoutId, resolve);
            });

            attachValidationRequestHandlers(req, url, timeoutId, resolve);

        } catch (error) {
            console.log(`Stream validation exception for ${url}: ${error.message}`);
            resolve(false);
        }
    });
};

// Attach the bitrate-sampling listeners to a 200 response: accumulate bytes
// until BITRATE_SAMPLE_SIZE is reached, estimate the throughput, snap it to the
// nearest common bitrate and resolve that string. Non-200 or errors resolve
// null. Behavior matches the original inline handler exactly.
const attachBitrateResponseHandlers = (req, res, timeoutId, resolve) => {
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
                attachBitrateResponseHandlers(req, res, timeoutId, resolve);
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

export { validateStream, detectBitrate, validateWithRetries };
