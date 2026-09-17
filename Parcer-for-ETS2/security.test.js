import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRemoteUrl, readTextWithLimit, safeFetch } from "./networkSecurity.js";
import { parseRadioInfoHtml } from "./app.js";

test("allows public HTTP and HTTPS URLs", async () => {
    assert.equal((await normalizeRemoteUrl("https://8.8.8.8/radio")).protocol, "https:");
    assert.equal((await normalizeRemoteUrl("http://1.1.1.1/radio")).protocol, "http:");
});

test("rejects unsafe protocols and URL credentials", async () => {
    await assert.rejects(() => normalizeRemoteUrl("file:///etc/passwd"));
    await assert.rejects(() => normalizeRemoteUrl("javascript:alert(1)"));
    await assert.rejects(() => normalizeRemoteUrl("data:text/plain,radio"));
    await assert.rejects(() => normalizeRemoteUrl("https://user:password@example.com/"));
});

test("rejects local, private, metadata, and normalized IP addresses", async () => {
    for (const url of [
        "http://localhost/test",
        "http://127.0.0.1/test",
        "http://127.1/test",
        "http://2130706433/test",
        "http://0.0.0.0/test",
        "http://[::1]/test",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
    ]) {
        await assert.rejects(() => normalizeRemoteUrl(url), url);
    }
});

test("validates every redirect target", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
    });

    try {
        await assert.rejects(() => safeFetch("https://8.8.8.8/start"));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("limits remote text responses", async () => {
    const response = new Response("0123456789");
    await assert.rejects(() => readTextWithLimit(response, 5));
});

test("HTML parsing returns structured station data, never raw markup", () => {
    const result = parseRadioInfoHtml(`
        <html><body><section class="stations__station">
            <button class="b-play station_play" stream="https://8.8.8.8/radio" radioName="News &amp; &#34;FM&#34;"></button>
            <a href="/ua/genre/news">news</a>
            <script>alert(1)</script>
            <img src=x onerror="alert(1)">
        </section></body></html>
    `);

    assert.deepEqual(result, [{
        stream: "https://8.8.8.8/radio",
        radioName: "News & 'FM'",
        genre: "News",
    }]);
    assert.equal(result.some(station => Object.values(station).some(value => value.includes("<script>"))), false);
});
