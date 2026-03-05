import { fetch } from "undici";
import { VERSION } from "./config.js";
const GQL_FETCH_TIMEOUT_MS = 30_000;
/** Strip HTML tags and truncate to a safe length for error messages. */
function sanitizeErrorBody(s, max = 200) {
    const stripped = s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    return stripped.length > max ? stripped.slice(0, max) + "..." : stripped;
}
export class GraphQLClient {
    opts;
    _headers;
    authenticated = false;
    constructor(opts) {
        this.opts = opts;
        this._headers = { ...(opts.headers || {}) };
        // Set authentication in priority order
        if (opts.bearer) {
            this._headers["Authorization"] = `Bearer ${opts.bearer}`;
            this.authenticated = true;
            console.error("Using Bearer token authentication");
        }
        else if (this._headers.Cookie) {
            this.authenticated = true;
            console.error("Using Cookie authentication");
        }
    }
    /** The GraphQL endpoint URL */
    get endpoint() {
        return this.opts.endpoint;
    }
    /** Current request headers (including auth) */
    get headers() {
        return { ...this._headers };
    }
    /** Cookie header value, if set */
    get cookie() {
        return this._headers["Cookie"] || "";
    }
    /** Bearer token, if set */
    get bearer() {
        const auth = this._headers["Authorization"] || "";
        return auth.startsWith("Bearer ") ? auth.slice(7) : "";
    }
    setHeaders(next) {
        this._headers = { ...this._headers, ...next };
    }
    setCookie(cookieHeader) {
        if (/[\r\n]/.test(cookieHeader)) {
            throw new Error("Cookie header contains illegal CR/LF characters");
        }
        this._headers["Cookie"] = cookieHeader;
        this.authenticated = true;
        console.error("Session cookies set from email/password login");
    }
    isAuthenticated() {
        return this.authenticated;
    }
    async request(query, variables) {
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": `affine-mcp-server/${VERSION}`,
            ...this._headers,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GQL_FETCH_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(this.opts.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ query, variables }),
                signal: controller.signal,
            });
        }
        catch (err) {
            if (err.name === "AbortError")
                throw new Error(`GraphQL request timed out after ${GQL_FETCH_TIMEOUT_MS / 1000}s`);
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
        // Handle redirects (undici may follow them but strip auth headers)
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            throw new Error(`GraphQL endpoint returned redirect ${res.status} -> ${location || "(no location)"}. ` +
                `Check AFFINE_BASE_URL.`);
        }
        const contentType = res.headers.get("content-type") || "";
        // Guard against non-JSON responses (Cloudflare challenges, HTML error pages)
        if (!contentType.includes("application/json") && !contentType.includes("application/graphql")) {
            const body = await res.text();
            const snippet = sanitizeErrorBody(body);
            throw new Error(`GraphQL endpoint returned non-JSON response (${res.status} ${res.statusText}, ` +
                `Content-Type: ${contentType || "(none)"}). Body: ${snippet}`);
        }
        if (!res.ok) {
            // Try to parse error body as JSON
            let body;
            try {
                const json = await res.json();
                body = json.errors?.map((e) => e.message).join("; ") || JSON.stringify(json);
            }
            catch {
                body = await res.text().catch(() => "(unreadable body)");
            }
            throw new Error(`GraphQL HTTP ${res.status}: ${sanitizeErrorBody(body)}`);
        }
        const json = await res.json();
        if (json.errors) {
            const msg = json.errors.map((e) => e.message).join("; ");
            throw new Error(`GraphQL error: ${sanitizeErrorBody(msg)}`);
        }
        return json.data;
    }
}
