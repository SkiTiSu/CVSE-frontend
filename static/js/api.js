import { getAuthHeaders } from './utils.js';

async function parseJsonResponse(response, fallbackMessage) {
    let result;
    try {
        result = await response.json();
    } catch {
        result = null;
    }

    if (!response.ok) {
        const message = result?.error
            ? `HTTP ${response.status} ${result.error}`
            : `HTTP ${response.status} ${response.statusText || fallbackMessage}`;
        throw new Error(message);
    }

    if (result && result.success === false) {
        throw new Error(result.error || fallbackMessage);
    }

    return result;
}

export async function validateAuthKey(authKey) {
    const response = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_key: authKey })
    });
    return parseJsonResponse(response, '验证失败');
}

const pendingVideoRequests = new Map();
export function getVideos(params) {
    const query = new URLSearchParams(params);
    const headers = getAuthHeaders();
    const key = JSON.stringify([query.toString(), headers]);
    if (pendingVideoRequests.has(key)) return pendingVideoRequests.get(key);
    const promise = (async () => {
        try {
            const response = await fetch(`/api/videos?${query.toString()}`, { headers });
            return await parseJsonResponse(response, '加载失败');
        } finally { pendingVideoRequests.delete(key); }
    })();
    pendingVideoRequests.set(key, promise);
    return promise;
}

export async function getVideo(bvid) {
    const response = await fetch(`/api/video/${bvid}`, {
        headers: getAuthHeaders()
    });
    return parseJsonResponse(response, '获取视频数据失败');
}

export async function submitChanges(changes) {
    const response = await fetch('/api/submit-changes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
        },
        body: JSON.stringify({ changes })
    });
    const result = await parseJsonResponse(response, '提交失败');
    previewSpecialCache.clear();
    return result;
}

export async function calculateRankings({ rank, index, containUnexamined = true, lock = false }) {
    const response = await fetch('/api/calculate-rankings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
        },
        body: JSON.stringify({
            rank,
            index,
            contain_unexamined: containUnexamined,
            lock,
        })
    });
    const result = await parseJsonResponse(response, '计算失败');
    previewSpecialCache.clear();
    return result;
}

let pendingPreview = null;
const previewSpecialCache = new Map();

export function cancelRankingPreview() {
    if (pendingPreview) {
        pendingPreview.controller.abort();
        pendingPreview = null;
    }
}

export function getRankingPreview({ rank, index, page, pageSize, videoId = '' }) {
    const query = new URLSearchParams({ rank, index, page, page_size: pageSize });
    if (videoId) query.set('video_id', videoId);
    const key = query.toString();
    if (pendingPreview?.key === key) return pendingPreview.promise;
    cancelRankingPreview();
    const specialKey = JSON.stringify([rank, index]);
    const cachedSpecial = previewSpecialCache.get(specialKey);
    if (!cachedSpecial && !videoId) query.set('include_special', 'true');
    const controller = new AbortController();
    const current = { key, controller, promise: null };
    pendingPreview = current;
    current.promise = (async () => {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
        try {
            const response = await fetch(`/api/ranking-preview?${query.toString()}`, {
                headers: getAuthHeaders(), signal: controller.signal
            });
            const result = await parseJsonResponse(response, '获取预览失败');
            if (!controller.signal.aborted && result?.data && !videoId) {
                const special = cachedSpecial || { entries: result.data.special_entries || [], truncated: result.data.special_truncated || false };
                if (!cachedSpecial) {
                    if (previewSpecialCache.size >= 8) previewSpecialCache.delete(previewSpecialCache.keys().next().value);
                    previewSpecialCache.set(specialKey, special);
                }
                result.data.special_entries = special.entries;
                result.data.special_truncated = special.truncated;
            }
            return result;
        } catch (error) {
            if (timedOut) throw new Error('预览读取超时，请稍后手动重试');
            throw error;
        } finally {
            clearTimeout(timer);
            if (pendingPreview === current) pendingPreview = null;
        }
    })();
    return current.promise;
}

export async function sendDebugRequest(endpoint, paramsStr) {
    let url = endpoint;
    let options = { method: 'GET' };
    const authHeaders = getAuthHeaders();

    if (endpoint === '/api/video/BVxxx') {
        url = `/api/video/BVxxxxxx`;
    } else if (endpoint === '/api/submit-changes' || endpoint === '/api/calculate-rankings') {
        options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            },
            body: paramsStr || '{}'
        };
    } else if (endpoint === '/api/videos' && paramsStr) {
        const params = JSON.parse(paramsStr);
        const query = new URLSearchParams(params).toString();
        url = `/api/videos?${query}`;
        options.headers = authHeaders;
    } else {
        options.headers = authHeaders;
    }

    const startTime = performance.now();
    const response = await fetch(url, options);
    const endTime = performance.now();
    const result = await response.json();

    return {
        status: response.status,
        duration: (endTime - startTime).toFixed(0),
        result,
    };
}
