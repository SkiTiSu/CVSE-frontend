import { getAuthHeaders, getAuthQueryParam } from './utils.js';

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

export async function getVideos(params) {
    const query = new URLSearchParams(params);
    const apiKey = localStorage.getItem('cvse_api_key');
    if (apiKey) {
        query.set('auth_key', apiKey);
    }

    const response = await fetch(`/api/videos?${query.toString()}`);
    return parseJsonResponse(response, '加载失败');
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
    return parseJsonResponse(response, '提交失败');
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
    return parseJsonResponse(response, '计算失败');
}

export async function getRankingPreview({ rank, index, page, pageSize, showSpecial = false }) {
    const response = await fetch(
        `/api/ranking-preview?rank=${rank}&index=${index}&page=${page}&page_size=${pageSize}&show_special=${showSpecial}${getAuthQueryParam()}`,
        { headers: getAuthHeaders() }
    );
    return parseJsonResponse(response, '获取预览失败');
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
        if (authHeaders['X-Auth-Key']) {
            url += `&auth_key=${encodeURIComponent(authHeaders['X-Auth-Key'])}`;
        }
    } else if (authHeaders['X-Auth-Key']) {
        url += `?auth_key=${encodeURIComponent(authHeaders['X-Auth-Key'])}`;
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
