import { fetch } from "undici";
const AUTH_FETCH_TIMEOUT_MS = 30_000;
function extractCookiePairs(setCookies) {
    const pairs = [];
    for (const sc of setCookies) {
        const first = sc.split(";")[0];
        if (first)
            pairs.push(first.trim());
    }
    return pairs.join("; ");
}
/** Reject cookie values containing CR/LF to prevent header injection. */
function assertNoCRLF(value, label) {
    if (/[\r\n]/.test(value)) {
        throw new Error(`${label} contains illegal CR/LF characters`);
    }
}
export async function loginWithPassword(baseUrl, email, password) {
    const url = `${baseUrl.replace(/\/$/, "")}/api/auth/sign-in`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
            signal: controller.signal,
        });
    }
    catch (err) {
        if (err.name === "AbortError")
            throw new Error(`Sign-in request timed out after ${AUTH_FETCH_TIMEOUT_MS / 1000}s`);
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const raw = await res.text().catch(() => "");
        const sanitized = raw.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        const truncated = sanitized.length > 200 ? sanitized.slice(0, 200) + "..." : sanitized;
        throw new Error(`Sign-in failed: ${res.status} ${truncated}`);
    }
    const anyHeaders = res.headers;
    let setCookies = [];
    if (typeof anyHeaders.getSetCookie === "function") {
        setCookies = anyHeaders.getSetCookie();
    }
    else {
        const sc = res.headers.get("set-cookie");
        if (sc)
            setCookies = [sc];
    }
    if (!setCookies.length) {
        throw new Error("Sign-in succeeded but no Set-Cookie received");
    }
    const cookieHeader = extractCookiePairs(setCookies);
    assertNoCRLF(cookieHeader, "Cookie header from sign-in");
    return { cookieHeader };
}
