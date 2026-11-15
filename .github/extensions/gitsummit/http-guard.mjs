import { timingSafeEqual } from "node:crypto";

export function authorizeRequest(req, url, { origin, token }) {
    if (req.headers.host !== new URL(origin).host) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/events") return true;
    const supplied = req.headers["x-gitsummit-token"] || url.searchParams.get("token") || "";
    const expected = Buffer.from(token), actual = Buffer.from(supplied);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
