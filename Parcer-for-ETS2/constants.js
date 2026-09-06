// Shared leaf module: constants and helpers used by BOTH app.js and
// streamValidation.js. Extracted here (rather than exported from app.js) so the
// two modules do not form an import cycle. This module imports nothing from the
// app, so it can never pull the scraper into an import graph.

export const BITRATE_SAMPLE_SIZE = 65536;
export const STREAM_VALIDATION_TIMEOUT = 12000;
export const MAX_STREAM_VALIDATION_RETRIES = 2;

export const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://onlineradiobox.com/ua/",
};

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
