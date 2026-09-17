import dns from "node:dns/promises";
import net from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 5;
const MAX_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

const parseIpv4 = address => {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts;
};

const isPrivateIpv4 = address => {
    const parts = parseIpv4(address);
    if (!parts) return false;

    const [first, second] = parts;
    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 0) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51) ||
        (first === 203 && second === 0) ||
        first >= 224
    );
};

const ipv6ToBigInt = address => {
    const normalized = address.toLowerCase().split("%")[0];
    const [left, right] = normalized.split("::");
    const leftParts = left ? left.split(":") : [];
    let rightParts = right ? right.split(":") : [];

    if (rightParts.some(part => part.includes("."))) {
        const ipv4 = parseIpv4(rightParts.pop());
        if (!ipv4) return null;
        rightParts.push(((ipv4[0] << 8) | ipv4[1]).toString(16));
        rightParts.push(((ipv4[2] << 8) | ipv4[3]).toString(16));
    }

    const parts = address.includes("::")
        ? [...leftParts, ...Array(8 - leftParts.length - rightParts.length).fill("0"), ...rightParts]
        : [...leftParts, ...rightParts];
    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;

    return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
};

const isPrivateIpv6 = address => {
    const value = ipv6ToBigInt(address);
    if (value === null) return false;

    const first16 = Number(value >> 112n);
    const first32 = Number(value >> 96n);
    const isIpv4Mapped = first32 === 0xffff;
    const mappedIpv4 = isIpv4Mapped ? Number(value & 0xffffffffn) : null;

    return (
        value === 0n ||
        value === 1n ||
        (first16 & 0xfe00) === 0xfc00 ||
        (first16 & 0xffc0) === 0xfe80 ||
        (mappedIpv4 !== null && isPrivateIpv4([
            mappedIpv4 >>> 24,
            (mappedIpv4 >>> 16) & 255,
            (mappedIpv4 >>> 8) & 255,
            mappedIpv4 & 255,
        ].join(".")))
    );
};

const isPrivateAddress = address => net.isIP(address) === 4
    ? isPrivateIpv4(address)
    : isPrivateIpv6(address);

export const normalizeRemoteUrl = async input => {
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        throw new Error("Invalid remote URL");
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
        throw new Error("Remote URL credentials are not allowed");
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostname || hostname === "localhost" || isPrivateAddress(hostname)) {
        throw new Error("Private or local network URLs are not allowed");
    }

    if (net.isIP(hostname) === 0) {
        let records;
        try {
            records = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch {
            throw new Error("Remote hostname could not be resolved");
        }
        if (!records.length || records.some(record => isPrivateAddress(record.address))) {
            throw new Error("Remote hostname resolves to a private or local address");
        }
    }

    return parsed;
};

export const safeFetch = async (input, init = {}) => {
    let currentUrl = (await normalizeRemoteUrl(input)).href;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        const response = await fetch(currentUrl, { ...init, redirect: "manual" });
        if (response.status < 300 || response.status >= 400) return response;

        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
            throw new Error("Too many or invalid redirects");
        }

        currentUrl = (await normalizeRemoteUrl(new URL(location, currentUrl))).href;
    }

    throw new Error("Too many redirects");
};

export const readTextWithLimit = async (response, maxBytes = MAX_TEXT_RESPONSE_BYTES) => {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error("Remote text response exceeds the size limit");
    }

    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                throw new Error("Remote text response exceeds the size limit");
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        return chunks.join("");
    } finally {
        reader.releaseLock();
    }
};

export { ALLOWED_PROTOCOLS, MAX_REDIRECTS, MAX_TEXT_RESPONSE_BYTES, isPrivateAddress };
