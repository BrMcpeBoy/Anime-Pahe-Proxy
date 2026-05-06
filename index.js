import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cookieJar = new Map();

function createSafeSender(res) {
    let sent = false;
    return (statusCode, data) => {
        if (!sent) {
            sent = true;
            res.status(statusCode).send(data);
        }
    };
}

// ── Global CORS middleware — must run before every route ──────────────────────
// Handles preflight OPTIONS and sets headers for ALL responses.
app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Range, Authorization, Cookie');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
// ─────────────────────────────────────────────────────────────────────────────

function isOriginAllowed(origin) {
    if (CONFIG.ALLOWED_ORIGINS.includes("*")) {
        return true;
    }
    if (CONFIG.ALLOWED_ORIGINS.length && !CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        return false;
    }
    return true;
}

function buildUpstreamHeaders(req, url, headersParam) {
    const headers = {
        "User-Agent": CONFIG.DEFAULT_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1"
    };

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            const additionalHeaders = JSON.parse(headersParam);
            Object.entries(additionalHeaders).forEach(([key, value]) => {
                const lk = key.toLowerCase();
                headers[lk] = value;
                if (lk === 'referer' || lk === 'referrer') referer = value;
            });
        } catch (e) { }
    }

    if (referer) {
        let refStr = decodeURIComponent(referer);

        if (url.hostname.includes('kwik') || url.hostname.includes('kwics')) {
            refStr = CONFIG.ANIMEPAHE_BASE;
            if (!refStr.endsWith('/')) refStr += '/';
        } else if (url.hostname.includes('owocdn') || url.hostname.includes('cdn')) {
            if (!refStr.includes('kwik.cx')) {
                refStr = CONFIG.DEFAULT_REFERER;
            }
        }

        if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
            refStr += '/';
        }
        headers['referer'] = refStr;

        try {
            headers['origin'] = new URL(refStr).origin;
        } catch (e) {
            headers['origin'] = refStr;
        }
    }

    if (url.hostname.includes('owocdn')) {
        headers['Sec-Fetch-Dest'] = 'iframe';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'cross-site';
    } else {
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
    }

    const storedCookies = cookieJar.get(url.hostname);
    if (storedCookies) {
        headers['cookie'] = headers['cookie']
            ? `${headers['cookie']}; ${storedCookies}`
            : storedCookies;
    }

    return headers;
}

function updateCookieJar(url, targetResponse) {
    const setCookie = targetResponse.headers['set-cookie'];
    if (setCookie) {
        const current = cookieJar.get(url.hostname) || "";
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];

        const merged = [...new Set([
            ...current.split('; '),
            ...cookies.map(c => c.split(';')[0])
        ])].filter(Boolean).join('; ');

        cookieJar.set(url.hostname, merged);
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    res.setHeader('Cache-Control', CONFIG.CACHE_CONTROL);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function generateProxyUrl(targetUrl, headersParam) {
    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, headersParam) {
    return content.split("\n").map((line) => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) {
            return line;
        }

        if (trimmed.startsWith("#")) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(abs, headersParam)}${suffix}`;
                } catch (e) {
                    return match;
                }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam);
        } catch (e) {
            return line;
        }
    }).join("\n");
}

app.get('/', (req, res) => {
    const origin = req.headers.origin || "";
    if (!isOriginAllowed(origin)) {
        res.status(403).send(`The origin "${origin}" was blacklisted by the operator of this proxy.`);
        return;
    }
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.get("/m3u8-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    const origin = req.headers.origin || "";

    if (!isOriginAllowed(origin)) {
        return safeSend(403, `The origin "${origin}" was blacklisted by the operator of this proxy.`);
    }

    try {
        const urlStr = req.query.url;
        if (!urlStr) {
            return safeSend(400, { message: "URL is required" });
        }

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = url.pathname.endsWith(".mp4") ? "0" : "1";

        const options = {
            method: 'GET',
            url: url.href,
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20000
        };
        try {
            const targetResponse = await cloudscraper(options);

            updateCookieJar(url, targetResponse);
            setCorsHeaders(req, res);

            const contentType = targetResponse.headers['content-type'] || '';
            const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8") ||
                contentType.includes("mpegURL") ||
                contentType.includes("application/x-mpegurl");

            if (isPlaylist) {
                const content = targetResponse.body.toString('utf8');
                const proxiedContent = proxyPlaylistContent(content, url, headersParam);
                res.setHeader('Content-Type', "application/vnd.apple.mpegurl");
                res.status(200).send(proxiedContent);
            } else {
                if (targetResponse.statusCode >= 400) {
                    const bodyStr = targetResponse.body.toString('utf8');
                    return safeSend(targetResponse.statusCode, {
                        message: "Upstream returned error",
                        upstreamStatus: targetResponse.statusCode,
                        body: bodyStr.substring(0, 1000)
                    });
                }

                Object.entries(targetResponse.headers).forEach(([k, v]) => {
                    if (CONFIG.UPSTREAM_HEADERS.includes(k.toLowerCase())) {
                        res.setHeader(k, v);
                    }
                });

                res.writeHead(targetResponse.statusCode);
                res.end(targetResponse.body);
            }

        } catch (err) {
            console.error("Cloudscraper error:", err.message);
            if (err.response) {
                return safeSend(err.response.statusCode || 502, {
                    message: "Upstream error (Cloudscraper)",
                    error: err.message
                });
            }
            return safeSend(500, { message: err.message });
        }

    } catch (e) {
        if (!res.headersSent) {
            safeSend(500, { message: e.message });
        }
    }
});

app.get("/subs-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    const origin = req.headers.origin || "";

    if (!isOriginAllowed(origin)) {
        return safeSend(403, `The origin "${origin}" was blacklisted.`);
    }

    try {
        const urlStr = req.query.url;
        if (!urlStr) return safeSend(400, { message: "URL is required" });

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        const options = {
            method: 'GET',
            url: url.href,
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 15000
        };

        const targetResponse = await cloudscraper(options);
        updateCookieJar(url, targetResponse);
        setCorsHeaders(req, res);

        res.setHeader('Content-Type', 'text/vtt');
        res.status(targetResponse.statusCode).send(targetResponse.body);

    } catch (err) {
        console.error("Subs Proxy Error:", err.message);
        safeSend(err.response?.statusCode || 500, { error: err.message });
    }
});

app.get("/thumbnails-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    try {
        const urlStr = req.query.url;
        if (!urlStr) return safeSend(400, { message: "URL is required" });

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        const targetResponse = await cloudscraper({
            url: url.href,
            method: 'GET',
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 15000
        });

        updateCookieJar(url, targetResponse);
        setCorsHeaders(req, res);

        let content = targetResponse.body.toString('utf8');
        const lines = content.split('\n').map(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('WEBVTT') && !trimmed.includes('-->')) {
                try {
                    const [urlPart, hashPart] = trimmed.split('#');
                    const absUrl = new URL(urlPart, url.href).href;
                    
                    let proxyUrl = `/image-segments-proxy?url=${encodeURIComponent(absUrl)}`;
                    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
                    
                    return hashPart ? `${proxyUrl}#${hashPart}` : proxyUrl;
                } catch (e) { return line; }
            }
            return line;
        });

        res.setHeader('Content-Type', 'text/vtt');
        res.status(200).send(lines.join('\n'));

    } catch (err) {
        console.error("Thumbnails VTT Error:", err.message);
        safeSend(err.response?.statusCode || 500, { error: err.message });
    }
});

app.get("/image-segments-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    try {
        const urlStr = req.query.url;
        if (!urlStr) return safeSend(400, { message: "URL is required" });

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        const targetResponse = await cloudscraper({
            url: url.href,
            method: 'GET',
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20000
        });

        updateCookieJar(url, targetResponse);
        setCorsHeaders(req, res);

        const contentType = targetResponse.headers['content-type'];
        if (contentType) res.setHeader('Content-Type', contentType);
        
        res.setHeader('Cache-Control', 'public, max-age=3600');

        res.status(targetResponse.statusCode).send(targetResponse.body);

    } catch (err) {
        console.error("Image Segment Error:", err.message);
        safeSend(err.response?.statusCode || 500, { error: err.message });
    }
});

// ─── AnimePahe HD-2 Endpoints ─────────────────────────────────────────────────
// These use cloudscraper so they can reach AnimePahe even behind Cloudflare.
// Called directly from the frontend (useWatch.js) since Vercel API servers
// can't reach AnimePahe (blocked by Vercel's network allowlist).

const PAHE_MIRRORS = [
    'https://animepahe.ru',
    'https://animepahe.com',
    'https://animepahe.org',
];

const paheAnimeCache = new Map();   // norm(title) → { session, title }
const paheEpisodeCache = new Map(); // `${session}::${ep}` → epSession
const PAHE_CACHE_TTL = 30 * 60 * 1000;

function paheCacheSet(map, key, value) {
    map.set(key, { value, ts: Date.now() });
}
function paheCacheGet(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > PAHE_CACHE_TTL) { map.delete(key); return null; }
    return entry.value;
}

function normTitle(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleSimilarity(a, b) {
    const wa = normTitle(a).split(' ').filter(w => w.length > 1);
    const wb = normTitle(b).split(' ').filter(w => w.length > 1);
    if (!wa.length || !wb.length) return 0;
    const bSet = new Set(wb);
    const common = wa.filter(w => bSet.has(w)).length;
    return common / Math.max(wa.length, wb.length);
}

function paheHeaders(base) {
    return {
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': base + '/',
    };
}

async function tryPaheMirrors(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    let lastErr;
    for (const base of PAHE_MIRRORS) {
        try {
            const res = await cloudscraper({
                method: 'GET',
                url: `${base}${path}?${qs}`,
                headers: paheHeaders(base),
                resolveWithFullResponse: true,
                timeout: 15000,
            });
            return JSON.parse(res.body);
        } catch (err) {
            lastErr = err;
            console.warn(`[pahe] Mirror ${base} failed: ${err.message}`);
        }
    }
    throw lastErr;
}

/** Unpack dean.edwards packer used by kwik.cx */
function unpackKwik(packed) {
    try {
        const match = packed.match(/\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
        if (!match) return null;
        const p = match[1], a = parseInt(match[2]), c = parseInt(match[3]);
        const k = match[4].split('|');
        let result = p;
        for (let i = c - 1; i >= 0; i--) {
            if (k[i]) result = result.replace(new RegExp(`\\b${i.toString(a)}\\b`, 'g'), k[i]);
        }
        return result;
    } catch { return null; }
}

/**
 * GET /pahe/search?title=<anime-title>
 * Search AnimePahe and return anime session + title matches
 */
app.get('/pahe/search', async (req, res) => {
    setCorsHeaders(req, res);
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const cacheKey = normTitle(title);
    const cached = paheCacheGet(paheAnimeCache, cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    try {
        // Try full title first
        let data = (await tryPaheMirrors('/api', { m: 'search', q: title }))?.data;

        // Fallback: first 3 words
        if (!data?.length) {
            const short = title.split(' ').slice(0, 3).join(' ');
            if (short !== title) {
                data = (await tryPaheMirrors('/api', { m: 'search', q: short }))?.data;
            }
        }

        if (!data?.length) {
            return res.status(404).json({ success: false, error: `"${title}" not found on AnimePahe` });
        }

        // Pick best match
        let best = data[0], bestScore = 0;
        for (const item of data) {
            const score = Math.max(
                titleSimilarity(title, item.title),
                titleSimilarity(title, item.title_english || ''),
                titleSimilarity(title, item.title_japanese || '')
            );
            if (score > bestScore) { bestScore = score; best = item; }
        }

        const result = { session: best.session, title: best.title, score: bestScore };
        paheCacheSet(paheAnimeCache, cacheKey, result);
        console.log(`[pahe] search "${title}" → "${best.title}" (score: ${bestScore.toFixed(2)})`);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error('[pahe/search] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /pahe/episode?session=<anime-session>&ep=<episode-number>
 * Get the kwik.cx URL for a specific episode
 */
app.get('/pahe/episode', async (req, res) => {
    setCorsHeaders(req, res);
    const { session, ep } = req.query;
    const episodeNum = parseInt(ep, 10);
    if (!session || isNaN(episodeNum)) {
        return res.status(400).json({ error: 'session and ep are required' });
    }

    const cacheKey = `${session}::${episodeNum}`;
    const cached = paheCacheGet(paheEpisodeCache, cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    try {
        // Search pages near the expected page
        const targetPage = Math.ceil(episodeNum / 30);
        const pagesToTry = [...new Set([targetPage, targetPage - 1, targetPage + 1, 1])].filter(p => p >= 1);

        let epSession = null;
        for (const page of pagesToTry) {
            const data = (await tryPaheMirrors('/api', {
                m: 'release', id: session, sort: 'episode_asc', page
            }))?.data;
            if (!data?.length) continue;
            const found = data.find(e => Math.round(e.episode) === episodeNum);
            if (found) { epSession = found.session; break; }
        }

        // Full scan fallback
        if (!epSession) {
            let page = 1;
            while (page <= 15) {
                const resp = await tryPaheMirrors('/api', { m: 'release', id: session, sort: 'episode_asc', page });
                const data = resp?.data || [];
                const lastPage = resp?.last_page || 1;
                const found = data.find(e => Math.round(e.episode) === episodeNum);
                if (found) { epSession = found.session; break; }
                if (page >= lastPage) break;
                page++;
            }
        }

        if (!epSession) {
            return res.status(404).json({ success: false, error: `Episode ${episodeNum} not found` });
        }

        // Get kwik links
        const links = (await tryPaheMirrors('/api', { m: 'links', id: session, session: epSession, p: 'kwik' }))?.links;
        let flatLinks = Array.isArray(links) ? Object.assign({}, ...links) : links;

        // Pick best quality kwik URL
        let kwikUrl = null;
        for (const q of ['1080', '720', '480', '360']) {
            if (flatLinks?.[q]?.kwik) { kwikUrl = flatLinks[q].kwik; break; }
        }
        if (!kwikUrl) {
            for (const key of Object.keys(flatLinks || {})) {
                if (flatLinks[key]?.kwik) { kwikUrl = flatLinks[key].kwik; break; }
            }
        }

        if (!kwikUrl) {
            return res.status(502).json({ success: false, error: 'No kwik URL found' });
        }

        paheCacheSet(paheEpisodeCache, cacheKey, { kwikUrl, epSession });
        return res.json({ success: true, data: { kwikUrl, epSession } });
    } catch (err) {
        console.error('[pahe/episode] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /pahe/stream?kwikUrl=<encoded-kwik-url>
 * Extract m3u8 URL from a kwik.cx embed page using cloudscraper
 */
app.get('/pahe/stream', async (req, res) => {
    setCorsHeaders(req, res);
    const { kwikUrl } = req.query;
    if (!kwikUrl) return res.status(400).json({ error: 'kwikUrl is required' });

    try {
        const decoded = decodeURIComponent(kwikUrl);
        const response = await cloudscraper({
            method: 'GET',
            url: decoded,
            headers: {
                'User-Agent': CONFIG.DEFAULT_USER_AGENT,
                'Referer': `${PAHE_MIRRORS[0]}/`,
                'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            resolveWithFullResponse: true,
            timeout: 20000,
        });

        const html = response.body.toString('utf8');

        // Method 1: direct m3u8
        let m3u8 = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)?.[0];

        // Method 2: unpack eval
        if (!m3u8) {
            const evalMatch = html.match(/eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\(.*?\)\)/s);
            if (evalMatch) {
                const unpacked = unpackKwik(evalMatch[0]);
                m3u8 = unpacked?.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)?.[0];
            }
        }

        // Method 3: source= pattern
        if (!m3u8) m3u8 = html.match(/source\s*=\s*["']([^"']+\.m3u8[^"']*)/)?.[1];

        // Method 4: quoted URL
        if (!m3u8) m3u8 = html.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/)?.[1];

        if (!m3u8) {
            return res.status(502).json({ success: false, error: 'Could not extract m3u8 from kwik page' });
        }

        setCorsHeaders(req, res);
        return res.json({ success: true, data: { m3u8, kwikUrl: decoded } });
    } catch (err) {
        console.error('[pahe/stream] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, () => {
    console.log(`Server listening on PORT: ${CONFIG.PORT}`);
});
