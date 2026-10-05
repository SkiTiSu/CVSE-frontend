export function getAuthHeaders() {
    const apiKey = localStorage.getItem('cvse_api_key');
    if (apiKey) {
        return { 'X-Auth-Key': apiKey };
    }
    return {};
}

export function normalizeCoverUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return `https://${url.slice(7)}`;
    return url;
}

export function getCoverFallbackDataUrl() {
    return "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 160 90%22><rect fill=%22%23e2e8f0%22 width=%22160%22 height=%2290%22/><text fill=%22%2394a3b8%22 x=%2280%22 y=%2245%22 text-anchor=%22middle%22>无封面</text></svg>";
}

export function limitDateYear(input) {
    if (!input.value) return;
    const match = input.value.match(/^(\d+)(-\d{2}-\d{2})$/);
    if (!match) return;
    const [, year, suffix] = match;
    if (year.length > 4) {
        input.value = `${year.slice(0, 4)}${suffix}`;
    }
}

export function formatLocalDateInput(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function getEmptyStats() {
    return {
        total: 0,
        domestic: 0,
        sv: 0,
        utau: 0,
        republish: 0,
        uncheck: 0,
        exclusion: 0,
        other: 0,
    };
}

export function parseVideoId(value, { exact = false } = {}) {
    const text = value.trim();
    if (!text) return { bvid: '', avid: '', value: '' };
    if (/^(?:av)?[1-9]\d{0,15}$/i.test(text)) {
        const digits = text.replace(/^av/i, '');
        if (BigInt(digits) >= 2n ** 51n) throw new Error('AV号超出有效范围');
        return { bvid: '', avid: digits, value: `av${digits}` };
    }
    if (/^bv/i.test(text) && (exact ? /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/ : /^BV[1-9A-HJ-NP-Za-km-z]+$/).test(`BV${text.slice(2)}`)) {
        const bvid = `BV${text.slice(2)}`;
        return { bvid, avid: '', value: bvid };
    }
    throw new Error(exact ? '请输入完整的 BV号或 AV号，也可输入数字 AV号。' : '请输入 BV号、AV号或数字 AV号。');
}
