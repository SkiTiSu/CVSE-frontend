import {
    calculateRankings as calculateRankingsRequest,
    getRankingPreview,
    cancelRankingPreview,
    getVideo,
    getVideos,
    sendDebugRequest as sendDebugRequestApi,
    submitChanges as submitChangesRequest,
    validateAuthKey,
} from './api.js';
import {
    formatLocalDateInput,
    getEmptyStats,
    limitDateYear,
    parseVideoId,
} from './utils.js';
import {
    createChangeItems,
    createEditPanel,
    createPreviewContent,
    createVideoCard,
    createPreviewError,
} from './renderers.js';

class CVSEApp {
    constructor() {
        this.videos = [];
        this.originalVideos = new Map();
        this.changes = new Map();
        this.selectedVideos = new Set();
        this.currentPage = 'recording';
        this.currentDate = formatLocalDateInput();
        this.currentPageSize = 50;
        this.currentPageIndex = 1;
        this.previewData = null;
        this.previewTotal = 0;
        this.previewPage = 1;
        this.previewPageSize = 20;
        this.previewRank = 'domestic';
        this.previewIndex = 1;
        this.previewShowSpecial = false;
        this.previewVideoId = '';
        this.recordingRequestId = 0;
        this.editRequestId = 0;
        this.previewRequestId = 0;
        this.totalItems = 0;
        this.totalPages = 0;
        this.stats = getEmptyStats();
        this.layoutMode = localStorage.getItem('cvse_layout_mode') || 'double';
        this.lastRequestSignature = '';
        this.changesPanelOffset = 0;
        this.changesPanelObserver = null;
        this.changesPanelScrollTimer = null;
        this.init();
    }

    init() {
        this.setupNavigation();
        this.setupEditDismissal();
        this.setupFilters();
        this.setupChangesPanel();
        this.setupDebugPanel();
        this.setupSettingsModal();
        this.setupUnsyncedChangesGuard();
        this.loadApiKey();
        document.getElementById('dateFilter').value = this.currentDate;
        document.getElementById('currentPage').value = this.currentPageIndex;
        document.getElementById('currentPageBottom').value = this.currentPageIndex;
        document.getElementById('layoutModeSelect').value = this.layoutMode;
        this.applyLayoutMode();
        this.updateSelectionBar([]);
        this.loadVideos({ force: true });
    }

    setupNavigation() {
        document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`${btn.dataset.page}-page`).classList.add('active');
                this.closeEditPanel();
                this.currentPage = btn.dataset.page;
            });
        });
    }

    setupFilters() {
        document.getElementById('searchBtn').addEventListener('click', () => this.searchVideos());
        document.getElementById('refreshBtn').addEventListener('click', () => this.refreshVideos());
        document.getElementById('toggleRecordingFilters').addEventListener('click', event => {
            const open = document.getElementById('recordingFilters').classList.toggle('mobile-filters-open');
            event.currentTarget.setAttribute('aria-expanded', String(open));
            event.currentTarget.textContent = open ? '收起筛选' : '展开筛选';
        });
        document.getElementById('clearRecordingFiltersBtn').addEventListener('click', () => this.clearRecordingFilters());

        ['videoIdFilter', 'searchKeyword'].forEach(id => {
            document.getElementById(id).addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.searchVideos();
            });
        });

        const updateRankLabel = () => {
            const labels = { domestic: '国产类', sv: 'SV类', utau: 'UTAU类', other: '其他' };
            const selected = [...document.querySelectorAll('#rankFilter input:checked')].map(input => labels[input.value]);
            document.getElementById('rankFilterSummary').textContent = selected.join('、') || '全部期刊';
        };
        document.getElementById('rankFilter').addEventListener('change', updateRankLabel);
        document.getElementById('clearRankFilter').addEventListener('click', () => {
            document.querySelectorAll('#rankFilter input').forEach(input => { input.checked = false; });
            updateRankLabel();
        });
        document.addEventListener('click', event => {
            const menu = document.getElementById('rankFilter');
            if (!menu.contains(event.target)) menu.open = false;
        });

        document.getElementById('layoutModeSelect').addEventListener('change', (e) => this.setLayoutMode(e.target.value));
        document.getElementById('pageSizeSelect').addEventListener('change', () => this.searchVideos());
        document.getElementById('dateFilter').addEventListener('input', (e) => limitDateYear(e.target));
        document.getElementById('dateFilter').addEventListener('change', (e) => limitDateYear(e.target));
        document.getElementById('dateFilter').addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            limitDateYear(e.target);
            this.searchVideos();
        });

        document.getElementById('calculateBtn').addEventListener('click', () => this.calculateRankings());
        document.getElementById('getPreviewBtn').addEventListener('click', () => this.getPreview());
        document.getElementById('previewVideoId').addEventListener('keydown', event => {
            if (event.key === 'Enter') this.getPreview();
        });
        document.getElementById('clearPreviewSearch').addEventListener('click', () => {
            document.getElementById('previewVideoId').value = '';
            this.getPreview();
        });
        document.getElementById('previewPageSize').addEventListener('change', () => {
            this.previewPage = 1;
            this.getPreview();
        });
        document.getElementById('previewRank').addEventListener('change', () => this.invalidatePreview());
        document.getElementById('previewIndex').addEventListener('change', () => this.invalidatePreview());
        document.getElementById('previewPrevPageBtn').addEventListener('click', () => this.previewChangePage(-1));
        document.getElementById('previewNextPageBtn').addEventListener('click', () => this.previewChangePage(1));
        document.getElementById('previewPrevPageBtnTop').addEventListener('click', () => this.previewChangePage(-1));
        document.getElementById('previewNextPageBtnTop').addEventListener('click', () => this.previewChangePage(1));
        for (const suffix of ['', 'Top']) {
            const input = document.getElementById(`previewPageInput${suffix}`);
            document.getElementById(`previewGoPageBtn${suffix}`).addEventListener('click', () => this.previewGoPage(Number(input.value)));
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') this.previewGoPage(Number(input.value));
            });
        }

        document.getElementById('pikaSearchBtn').addEventListener('click', () => this.pikaSearch());
        document.getElementById('pikaKeyword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.pikaSearch();
        });

        document.getElementById('selectVisibleBtn').addEventListener('click', () => this.selectVisibleVideos());
        document.getElementById('clearSelectionBtn').addEventListener('click', () => this.clearSelection());
        document.getElementById('batchMarkExaminedBtn').addEventListener('click', () => this.batchMarkExamined());
        document.getElementById('batchRejectBtn').addEventListener('click', () => this.batchReject());
        document.getElementById('previewShowSpecial').addEventListener('change', () => {
            this.previewShowSpecial = document.getElementById('previewShowSpecial').checked;
            if (this.previewData) this.renderPreview();
        });
    }

    setupEditDismissal() {
        // Capture runs before a new Edit button opens its panel.
        document.addEventListener('click', (event) => {
            const panel = document.getElementById('editPanel');
            if (!panel || !panel.contains(event.target)) this.closeEditPanel();
        }, true);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') this.closeEditPanel();
        });
    }

    setChangesExpanded(expanded) {
        document.getElementById('changesPanel').classList.toggle('expanded', expanded);
        document.getElementById('changesBackdrop').classList.toggle('open', expanded);
        const toggle = document.getElementById('toggleChangesBtn');
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? '收起' : '查看';
        this.syncChangesPanelOffset();
    }

    setupChangesPanel() {
        document.getElementById('toggleChangesBtn').addEventListener('click', () =>
            this.setChangesExpanded(!document.getElementById('changesPanel').classList.contains('expanded')));
        document.getElementById('changesBackdrop').addEventListener('click', () => this.setChangesExpanded(false));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.setChangesExpanded(false);
        });
        const more = document.getElementById('selectionMore');
        const mobileQuery = window.matchMedia?.('(max-width: 768px)');
        more.open = !mobileQuery?.matches;
        mobileQuery?.addEventListener('change', event => {
            more.open = !event.matches;
            this.setChangesExpanded(false);
        });
        more.addEventListener('click', event => { if (mobileQuery?.matches && event.target.closest('button')) more.open = false; });
        document.addEventListener('click', event => { if (mobileQuery?.matches && !more.contains(event.target)) more.open = false; });
        let swipeStart = null;
        const header = document.querySelector('.changes-header');
        header.addEventListener('touchstart', event => { swipeStart = event.touches[0].clientY; }, {passive: true});
        header.addEventListener('touchend', event => {
            if (swipeStart !== null && event.changedTouches[0].clientY - swipeStart > 50) this.setChangesExpanded(false);
            swipeStart = null;
        }, {passive: true});
        document.getElementById('clearChangesBtn').addEventListener('click', () => this.clearChanges());
        document.getElementById('submitChangesBtn').addEventListener('click', () => this.showSubmitModal());
        document.getElementById('modalClose').addEventListener('click', () => this.hideModal());
        document.getElementById('modalCancel').addEventListener('click', () => this.hideModal());
        document.getElementById('modalOverlay').addEventListener('click', () => this.hideModal());
        document.getElementById('modalConfirm').addEventListener('click', () => this.submitChanges());
        this.bindPaginationControls('');
        this.bindPaginationControls('Bottom');

        const panel = document.getElementById('changesPanel');
        if ('ResizeObserver' in window) {
            this.changesPanelObserver = new ResizeObserver(() => this.syncChangesPanelOffset());
            this.changesPanelObserver.observe(panel);
        }
        window.addEventListener('resize', () => this.syncChangesPanelOffset());
        this.syncChangesPanelOffset();
    }

    setupDebugPanel() {
        document.getElementById('debugSendBtn').addEventListener('click', () => this.sendDebugRequest());
        document.getElementById('debugEndpoint').addEventListener('change', (e) => {
            const params = document.getElementById('debugParams');
            switch(e.target.value) {
                case '/api/videos':
                    params.value = '{\n  "keyword": "",\n  "rank": "all",\n  "examined": "",\n  "page": 1,\n  "page_size": 20\n}';
                    break;
                case '/api/video/BVxxx':
                    params.value = '';
                    break;
                case '/api/submit-changes':
                    params.value = '{\n  "changes": [\n    {\n      "bvid": "BVxxx",\n      "ranks": ["domestic", "sv"],\n      "is_examined": true,\n      "is_republish": false\n    }\n  ]\n}';
                    break;
                case '/api/calculate-rankings':
                    params.value = '{\n  "rank": "domestic",\n  "index": 1,\n  "contain_unexamined": false,\n  "lock": false\n}';
                    break;
            }
        });
        document.getElementById('debugParams').value = '{\n  "keyword": "",\n  "rank": "all",\n  "examined": "",\n  "date": "2026-02-21",\n  "page": 1,\n  "page_size": 20\n}';
    }

    setupSettingsModal() {
        document.getElementById('settingsBtn').addEventListener('click', () => this.showSettingsModal());
        document.getElementById('settingsModalClose').addEventListener('click', () => this.hideSettingsModal());
        document.getElementById('settingsModalCancel').addEventListener('click', () => this.hideSettingsModal());
        document.getElementById('settingsModalOverlay').addEventListener('click', () => this.hideSettingsModal());
        document.getElementById('settingsModalSave').addEventListener('click', () => this.saveApiKey());
        document.getElementById('validateApiKeyBtn').addEventListener('click', () => this.validateApiKey());
        document.getElementById('clearApiKeyBtn').addEventListener('click', () => this.clearApiKey());
    }

    setupUnsyncedChangesGuard() {
        window.addEventListener('beforeunload', (event) => {
            if (this.changes.size === 0) return;

            event.preventDefault();
            event.returnValue = '';
        });
    }

    loadApiKey() {
        const savedKey = localStorage.getItem('cvse_api_key');
        if (savedKey) {
            document.getElementById('apiKeyInput').value = savedKey;
        }
    }

    showSettingsModal() {
        document.getElementById('settingsModal').classList.add('open');
        document.getElementById('settingsModalOverlay').classList.add('open');
        this.loadApiKey();
    }

    hideSettingsModal() {
        document.getElementById('settingsModal').classList.remove('open');
        document.getElementById('settingsModalOverlay').classList.remove('open');
    }

    saveApiKey() {
        const apiKey = document.getElementById('apiKeyInput').value.trim();
        if (apiKey) {
            localStorage.setItem('cvse_api_key', apiKey);
            this.hideSettingsModal();
            alert('API Key 已保存');
        } else {
            alert('请输入 API Key');
        }
    }

    async validateApiKey() {
        const apiKey = document.getElementById('apiKeyInput').value.trim();
        const statusEl = document.getElementById('apiKeyStatus');
        if (!apiKey) {
            statusEl.textContent = '请先输入 API Key';
            statusEl.style.color = 'var(--danger)';
            return;
        }
        statusEl.textContent = '验证中...';
        statusEl.style.color = 'var(--gray-500)';
        try {
            const result = await validateAuthKey(apiKey);
            if (result.success && result.valid) {
                statusEl.textContent = '✓ API Key 有效';
                statusEl.style.color = 'var(--success)';
            } else {
                statusEl.textContent = '✗ ' + (result.message || 'API Key 无效');
                statusEl.style.color = 'var(--danger)';
            }
        } catch (e) {
            statusEl.textContent = '✗ 验证失败: ' + e.message;
            statusEl.style.color = 'var(--danger)';
        }
    }

    clearApiKey() {
        if (confirm('确定要清除已保存的 API Key 吗？')) {
            localStorage.removeItem('cvse_api_key');
            document.getElementById('apiKeyInput').value = '';
            document.getElementById('apiKeyStatus').textContent = '已清除';
            document.getElementById('apiKeyStatus').style.color = 'var(--gray-500)';
        }
    }

    setLayoutMode(mode) {
        this.layoutMode = mode === 'single' ? 'single' : 'double';
        localStorage.setItem('cvse_layout_mode', this.layoutMode);
        this.applyLayoutMode();
    }

    applyLayoutMode() {
        const videoList = document.getElementById('videoList');
        videoList.classList.toggle('layout-double', this.layoutMode === 'double');
        videoList.classList.toggle('layout-single', this.layoutMode === 'single');
    }

    searchVideos() {
        document.getElementById('currentPage').value = 1;
        document.getElementById('currentPageBottom').value = 1;
        return this.loadVideos({ force: true, resetPage: true });
    }

    clearRecordingFilters() {
        document.getElementById('dateFilter').value = formatLocalDateInput();
        for (const id of ['searchKeyword', 'videoIdFilter', 'examinedFilter', 'republishFilter']) {
            document.getElementById(id).value = '';
        }
        document.querySelectorAll('#rankFilter input').forEach(input => { input.checked = false; });
        document.getElementById('rankFilterSummary').textContent = '全部期刊';
        document.getElementById('rankFilter').open = false;
        return this.searchVideos();
    }

    async refreshVideos() {
        await this.loadVideos({ force: true });
    }

    async loadVideos({ force = false, resetPage = false } = {}) {
        const videoList = document.getElementById('videoList');
        const dateFilter = document.getElementById('dateFilter').value;
        const pageSize = Number(document.getElementById('pageSizeSelect').value);
        let filters;
        try { filters = this.getRecordingFilters(); }
        catch (error) { alert(error.message); return; }
        const requestId = ++this.recordingRequestId;
        const pageIndex = resetPage ? 1 : Math.max(1, Number(document.getElementById('currentPage').value) || 1);
        const requestSignature = JSON.stringify({ dateFilter, pageSize, pageIndex, filters });

        if (force || requestSignature !== this.lastRequestSignature) {
            videoList.innerHTML = '<div class="loading">正在向服务器请求数据...</div>';
            this.currentPageIndex = pageIndex;
            this.resetStats();
            this.currentDate = dateFilter;
            document.getElementById('recordingDateLabel').textContent = `日期：${dateFilter || formatLocalDateInput()}`;
            this.currentPageSize = pageSize;
            try {
                const result = await getVideos({
                    page_size: String(pageSize),
                    page: String(this.currentPageIndex),
                    date: dateFilter,
                    keyword: filters.keyword,
                    rank: filters.rank,
                    examined: filters.examined,
                    is_republish: filters.republish,
                    bvid: filters.bvid,
                    avid: filters.avid,
                });

                if (requestId !== this.recordingRequestId) return;

                this.videos = result.data.map(video => this.changes.get(video.bvid) || video);
                this.totalItems = result.total || 0;
                this.totalPages = this.totalItems > 0 ? Math.ceil(this.totalItems / pageSize) : 0;
                this.stats = { ...getEmptyStats(), ...(result.stats || {}) };
                this.lastRequestSignature = requestSignature;
                this.selectedVideos.clear();

                if (this.totalPages > 0 && this.currentPageIndex > this.totalPages) {
                    this.currentPageIndex = this.totalPages;
                    this.setPaginationInputs(this.currentPageIndex);
                    await this.loadVideos({ force: true });
                    return;
                }
            } catch (error) {
                if (requestId !== this.recordingRequestId) return;
                this.totalItems = 0;
                this.totalPages = 0;
                this.stats = getEmptyStats();
                this.updatePagination();
                videoList.innerHTML = `<div class="empty-state">
                    <div class="empty-state-icon">❌</div>
                    <div>加载失败: ${error.message}</div>
                </div>`;
                return;
            }
        }

        this.applyRecordingFilters();
    }

    getRecordingFilters() {
        const id = parseVideoId(document.getElementById('videoIdFilter').value);
        return {
            keyword: document.getElementById('searchKeyword').value.trim(),
            rank: [...document.querySelectorAll('#rankFilter input:checked')].map(input => input.value).join(',') || 'all',
            examined: document.getElementById('examinedFilter').value,
            republish: document.getElementById('republishFilter').value,
            bvid: id.bvid,
            avid: id.avid,
        };
    }

    applyRecordingFilters() {
        const videoData = this.getVisibleVideos();
        this.updateStats();
        this.renderVideos(videoData);
        this.updatePagination();
    }

    getVisibleVideos() {
        try { return this.filterVideos(this.videos, this.getRecordingFilters()); }
        catch { return this.videos; }
    }

    filterVideos(videos = this.videos, filters) {
        const { keyword, rank, examined, republish, bvid, avid } = filters;

        let videoData = videos;
        const normalizedKeyword = keyword.toLowerCase();

        if (keyword) {
            videoData = videoData.filter(v =>
                v.title.toLowerCase().includes(normalizedKeyword)
                || v.desc.toLowerCase().includes(normalizedKeyword)
                || v.uploader.toLowerCase().includes(normalizedKeyword)
                || (v.tags || []).some(tag => tag.toLowerCase().includes(normalizedKeyword))
            );
        }

        if (rank !== 'all') {
            const selected = rank.split(',');
            videoData = videoData.filter(v => selected.some(r => r === 'other'
                ? !v.is_examined && v.ranks.length === 0 : v.ranks.includes(r)));
        }

        switch (examined) {
            case 'true':
                videoData = videoData.filter(v => v.is_examined && v.ranks.length > 0);
                break;
            case 'false':
                videoData = videoData.filter(v => !v.is_examined);
                break;
            case 'exclusion':
                videoData = videoData.filter(v => v.is_examined && v.ranks.length === 0);
                break;
        }

        if (republish === 'true' || republish === 'false') {
            videoData = videoData.filter(v => Boolean(v.is_republish) === (republish === 'true'));
        }

        if (bvid) {
            videoData = videoData.filter(v => v.bvid.toLowerCase().includes(bvid.toLowerCase()));
        }

        if (avid) {
            videoData = videoData.filter(v => v.avid.toLowerCase().includes(avid.toLowerCase()));
        }
        return videoData;
    }

    resetStats() {
        this.setPaginationInputs(this.currentPageIndex);
        this.setPaginationStatuses('第0页 / 共0页');
        document.getElementById('totalCount').textContent = '-';
        document.getElementById('domesticCount').textContent = '-';
        document.getElementById('svCount').textContent = '-';
        document.getElementById('utauCount').textContent = '-';
        document.getElementById('republishCount').textContent = '-';
        document.getElementById('uncheckCount').textContent = '-';
        document.getElementById('exclusionCount').textContent = '-';
        document.getElementById('otherCount').textContent = '-';
    }

    updateStats() {
        const stats = { ...getEmptyStats(), ...(this.stats || {}) };

        this.setPaginationInputs(this.currentPageIndex);
        document.getElementById('totalCount').textContent = stats.total || 0;
        document.getElementById('domesticCount').textContent = stats.domestic || 0;
        document.getElementById('svCount').textContent = stats.sv || 0;
        document.getElementById('utauCount').textContent = stats.utau || 0;
        document.getElementById('republishCount').textContent = stats.republish || 0;
        document.getElementById('uncheckCount').textContent = stats.uncheck || 0;
        document.getElementById('exclusionCount').textContent = stats.exclusion || 0;
        document.getElementById('otherCount').textContent = stats.other || 0;
    }

    renderVideos(videos = this.videos) {
        const videoList = document.getElementById('videoList');
        this.reconcileSelection(videos);

        if (videos.length === 0) {
            videoList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div>暂无数据</div></div>';
            this.updateSelectionBar(videos);
            this.applyLayoutMode();
            return;
        }

        videoList.innerHTML = videos.map(video => createVideoCard(video, {
            hasChange: this.changes.has(video.bvid),
            isSelected: this.selectedVideos.has(video.bvid),
        })).join('');
        this.updateSelectionBar(videos);
        this.applyLayoutMode();
    }

    reconcileSelection(videos = this.videos) {
        const visibleBvids = new Set(videos.map(video => video.bvid));
        this.selectedVideos = new Set(
            Array.from(this.selectedVideos).filter(bvid => visibleBvids.has(bvid))
        );
    }

    updateSelectionBar(videos = this.videos) {
        const selectionCount = this.selectedVideos.size;
        document.getElementById('selectionBar').classList.toggle('has-selection', selectionCount > 0);
        document.getElementById('selectionSummary').textContent = `已选择 ${selectionCount} 项`;
        document.getElementById('selectVisibleBtn').disabled = videos.length === 0;
        document.getElementById('clearSelectionBtn').disabled = selectionCount === 0;
        document.getElementById('batchMarkExaminedBtn').disabled = selectionCount === 0;
        document.getElementById('batchRejectBtn').disabled = selectionCount === 0;
    }

    updatePagination() {
        const prevDisabled = this.currentPageIndex <= 1 || this.totalPages === 0;
        const nextDisabled = this.totalPages === 0 || this.currentPageIndex >= this.totalPages;

        ['prevPageBtn', 'prevPageBtnBottom'].forEach(id => document.getElementById(id).disabled = prevDisabled);
        ['nextPageBtn', 'nextPageBtnBottom'].forEach(id => document.getElementById(id).disabled = nextDisabled);
        this.setPaginationInputs(this.currentPageIndex);
        this.setPaginationStatuses(this.totalPages === 0
            ? '第0页 / 共0页'
            : `第${this.currentPageIndex}页 / 共${this.totalPages}页`);
    }

    bindPaginationControls(suffix) {
        const input = document.getElementById(`currentPage${suffix}`);
        document.getElementById(`prevPageBtn${suffix}`).addEventListener('click', () => this.changePage(-1));
        document.getElementById(`nextPageBtn${suffix}`).addEventListener('click', () => this.changePage(1));
        document.getElementById(`goPageBtn${suffix}`).addEventListener('click', () => this.goToPage(input.value));
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.goToPage(input.value);
        });
        input.addEventListener('input', () => {
            const otherInput = document.getElementById(suffix ? 'currentPage' : 'currentPageBottom');
            otherInput.value = input.value;
        });
    }

    setPaginationInputs(page) {
        document.getElementById('currentPage').value = page;
        document.getElementById('currentPageBottom').value = page;
    }

    setPaginationStatuses(text) {
        document.getElementById('pageStatus').textContent = text;
        document.getElementById('pageStatusBottom').textContent = text;
    }

    changePage(delta) {
        const deltaValue = Number(delta || 0);
        const targetPage = Math.max(
            1,
            Number.isFinite(deltaValue) ? this.currentPageIndex + deltaValue : this.currentPageIndex
        );
        this.setPaginationInputs(targetPage);
        this.loadVideos({ force: true });
    }

    goToPage(page) {
        const targetPage = Math.max(1, Number(page) || 1);
        this.setPaginationInputs(targetPage);
        this.loadVideos({ force: true });
    }

    openEditPanel(bvid) {
        this.closeEditPanel();
        const video = this.videos.find(v => v.bvid === bvid);
        if (!video) return;

        const change = this.changes.get(bvid) || { ...video };

        const panel = document.createElement('div');
        panel.className = 'edit-panel open';
        panel.id = 'editPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', `编辑 ${bvid}`);
        panel.innerHTML = createEditPanel(change, bvid, { allowExclusion: this.currentPage === 'preview' });

        document.body.appendChild(panel);
        this.currentEditingBvid = bvid;
        this.currentEditingData = { ...change, ranks: [...(change.ranks || [])] };

        panel.querySelector('.edit-panel-close').focus();
    }

    closeEditPanel() {
        this.editRequestId += 1;
        const panel = document.getElementById('editPanel');
        if (panel) panel.remove();
        this.currentEditingBvid = null;
        this.currentEditingData = null;
    }

    toggleRank(rank) {
        const idx = this.currentEditingData.ranks.indexOf(rank);
        if (idx >= 0) {
            this.currentEditingData.ranks.splice(idx, 1);
        } else {
            this.currentEditingData.ranks.push(rank);
        }
    }

    updateRepublish() {
        this.currentEditingData.is_republish = document.getElementById('isRepublish').checked;
    }

    updateExamined() {
        this.currentEditingData.is_examined = document.getElementById('isExamined').checked;
    }

    applyLocalChange(bvid, patch) {
        const currentVideo = this.videos.find(v => v.bvid === bvid);
        if (!currentVideo) return;

        if (!this.originalVideos.has(bvid)) {
            this.originalVideos.set(bvid, { ...currentVideo, ranks: [...(currentVideo.ranks || [])] });
        }

        const base = this.changes.get(bvid) || currentVideo;
        const updated = { ...base, ...patch };
        updated.ranks = [...(updated.ranks || [])];
        this.changes.set(bvid, updated);
        this.videos = this.videos.map(v => v.bvid === bvid ? { ...v, ...patch } : v);
    }

    saveChange(bvid) {
        if (bvid !== this.currentEditingBvid || !this.currentEditingData) return;
        const staffInfo = document.getElementById('staffInfo').value;
        this.currentEditingData.staff_info = staffInfo;
        this.applyLocalChange(bvid, this.currentEditingData);
        this.closeEditPanel();
        this.applyRecordingFilters();
        this.updateChangesPanel();
    }

    toggleVideoSelection(bvid, checked) {
        if (checked) {
            this.selectedVideos.add(bvid);
        } else {
            this.selectedVideos.delete(bvid);
        }
        this.applyRecordingFilters();
    }

    selectVisibleVideos() {
        this.getVisibleVideos().forEach(video => this.selectedVideos.add(video.bvid));
        this.applyRecordingFilters();
    }

    clearSelection() {
        this.selectedVideos.clear();
        this.applyRecordingFilters();
    }

    batchMarkExamined() {
        if (this.selectedVideos.size === 0) return;

        Array.from(this.selectedVideos).forEach(bvid => {
            this.applyLocalChange(bvid, { is_examined: true });
        });

        this.selectedVideos.clear();
        this.applyRecordingFilters();
        this.updateChangesPanel();
    }

    batchReject() {
        if (this.selectedVideos.size === 0) return;
        this.closeEditPanel();
        for (const bvid of this.selectedVideos) {
            this.applyLocalChange(bvid, { ranks: [], is_examined: true });
        }
        this.selectedVideos.clear();
        this.applyRecordingFilters();
        this.updateChangesPanel();
    }

    excludeEditingVideo() {
        if (!this.currentEditingData) return;
        this.currentEditingData.ranks = [];
        this.currentEditingData.is_examined = true;
        this.saveChange(this.currentEditingBvid);
    }

    async excludeVideo(bvid) {
        this.closeEditPanel();
        try {
            if (!this.videos.some(video => video.bvid === bvid)) {
                const result = await getVideo(bvid);
                if (!this.videos.some(video => video.bvid === bvid)) this.videos.push(result.data);
            }
            this.applyLocalChange(bvid, { ranks: [], is_examined: true });
            this.applyRecordingFilters();
            this.updateChangesPanel();
        } catch (error) {
            alert('获取视频数据失败: ' + error.message);
        }
    }

    updateChangesPanel() {
        if (this.previewData) this.renderPreview();
        const panel = document.getElementById('changesPanel');
        const count = document.getElementById('changesCount');
        const list = document.getElementById('changesList');

        count.textContent = this.changes.size;

        if (this.changes.size > 0) {
            panel.classList.add('open');
        } else {
            panel.classList.remove('open');
            this.setChangesExpanded(false);
        }

        list.innerHTML = createChangeItems(Array.from(this.changes.entries()));

        this.syncChangesPanelOffset();
    }

    syncChangesPanelOffset() {
        const panel = document.getElementById('changesPanel');
        const compact = window.matchMedia?.('(max-width: 768px)').matches ?? false;
        const height = compact ? panel.querySelector('.changes-header').offsetHeight : panel.offsetHeight;
        const offset = panel.classList.contains('open') ? height : 0;
        const previousOffset = this.changesPanelOffset;
        const distanceFromBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;

        document.documentElement.style.setProperty('--changes-panel-offset', `${offset}px`);
        this.changesPanelOffset = offset;

        if (offset > previousOffset && distanceFromBottom <= previousOffset + 32) {
            clearTimeout(this.changesPanelScrollTimer);
            this.changesPanelScrollTimer = setTimeout(() => {
                window.scrollTo(0, document.documentElement.scrollHeight);
            }, 320);
        }
    }

    removeChange(bvid) {
        this.changes.delete(bvid);
        this.selectedVideos.delete(bvid);
        const original = this.originalVideos.get(bvid);
        if (original) {
            this.videos = this.videos.map(v =>
                v.bvid === bvid ? { ...original } : v
            );
            this.originalVideos.delete(bvid);
        } else {
            const originalVideo = this.videos.find(v => v.bvid === bvid);
            if (originalVideo) {
                this.videos = this.videos.map(v =>
                    v.bvid === bvid ? { ...originalVideo } : v
                );
            }
        }
        this.applyRecordingFilters();
        this.updateChangesPanel();
    }

    clearChanges() {
        if (this.changes.size === 0) return;

        for (const [bvid, original] of this.originalVideos.entries()) {
            this.videos = this.videos.map(v =>
                v.bvid === bvid ? { ...original } : v
            );
        }

        this.changes.clear();
        this.originalVideos.clear();
        this.selectedVideos.clear();
        this.applyRecordingFilters();
        this.updateChangesPanel();
    }

    showSubmitModal() {
        if (this.changes.size === 0) return;
        document.getElementById('submitCount').textContent = this.changes.size;
        document.getElementById('modalOverlay').classList.add('open');
        document.getElementById('submitModal').classList.add('open');
    }

    hideModal() {
        document.getElementById('modalOverlay').classList.remove('open');
        document.getElementById('submitModal').classList.remove('open');
    }

    async submitChanges() {
        const changes = Array.from(this.changes.values()).map(c => ({
            avid: c.avid,
            bvid: c.bvid,
            ranks: c.ranks,
            is_examined: c.is_examined,
            is_republish: c.is_republish,
            staff_info: c.staff_info
        }));

        try {
            const result = await submitChangesRequest(changes);

            if (!result.success) {
                alert('提交失败: ' + result.error);
                return;
            }

            alert('提交成功!');
            // Apply submitted state to already loaded preview rows before clearing the queue.
            if (this.previewData) {
                for (const entry of [...(this.previewData.entries || []), ...(this.previewData.special_entries || [])]) {
                    const change = this.changes.get(entry.bvid);
                    if (change) Object.assign(entry, { ranks: [...change.ranks], is_examined: change.is_examined });
                }
            }
            this.changes.clear();
            this.originalVideos.clear();
            this.selectedVideos.clear();
            this.hideModal();
            this.updateChangesPanel();
            await this.loadVideos({ force: true });
        } catch (error) {
            alert('提交失败: ' + error.message);
        }
    }

    async calculateRankings() {
        if (this.calculationInFlight) return;
        const rank = document.getElementById('previewRank').value;
        const indexInput = Number.parseInt(document.getElementById('previewIndex').value, 10);
        const index = Number.isNaN(indexInput) ? 1 : Math.max(1, indexInput);
        document.getElementById('previewIndex').value = index;
        const preview = document.getElementById('rankingPreview');
        const totalDuration = 90; // 秒

        // 确认对话框
        const rankNames = { domestic: '国产榜', sv: 'SV刊', utau: 'UTAU刊' };
        const rankName = rankNames[rank] || rank.toUpperCase();
        if (!confirm(`确定要重新计算 ${rankName} 第 ${index} 期排行榜吗？\n\n计算过程可能需要约3～5分钟，请耐心等待。`)) {
            return;
        }

        this.calculationInFlight = true;
        cancelRankingPreview();
        const requestId = ++this.previewRequestId;
        // 显示进度条
        const overlay = document.getElementById('progressOverlay');
        const bar = document.getElementById('progressBar');
        const percentEl = document.getElementById('progressPercent');
        const timeEl = document.getElementById('progressTime');
        const titleEl = document.getElementById('progressTitle');

        titleEl.textContent = `${rankName} 第${index}期排行榜计算中...`;
        bar.style.width = '0%';
        percentEl.textContent = '0';
        timeEl.textContent = '0';
        overlay.classList.add('open');

        // 启动动画计时器：90 秒内从 0% 走到 95%
        let elapsed = 0;
        const startTime = Date.now();

        const timer = setInterval(() => {
            elapsed = (Date.now() - startTime) / 1000;
            if (elapsed > totalDuration) elapsed = totalDuration;
            const percent = Math.min(95, (elapsed / totalDuration) * 95);
            bar.style.width = percent + '%';
            percentEl.textContent = Math.round(percent);
            timeEl.textContent = Math.round(elapsed);
            if (elapsed >= totalDuration) {
                clearInterval(timer);
            }
        }, 100);

        preview.innerHTML = '<div class="loading">正在计算排行榜...</div>';

        try {
            await calculateRankingsRequest({ rank, index, containUnexamined: true, lock: false });
            if (requestId !== this.previewRequestId) {
                clearInterval(timer);
                overlay.classList.remove('open');
                return;
            }

            titleEl.textContent = `${rankName} 第${index}期排行榜计算完成，正在获取预览数据...`;

            // 计算完成后自动获取第1页预览
            this.previewShowSpecial = document.getElementById('previewShowSpecial').checked;
            this.previewRank = rank;
            this.previewIndex = index;
            this.previewPage = 1;
            this.previewVideoId = '';
            document.getElementById('previewVideoId').value = '';
            this.previewPageSize = parseInt(document.getElementById('previewPageSize').value);

            const previewData = await getRankingPreview({
                rank,
                index,
                page: 1,
                pageSize: this.previewPageSize,
                showSpecial: this.previewShowSpecial,
            });

            // 计算完成，进度条跳到 100% 并关闭
            clearInterval(timer);
            bar.style.width = '100%';
            percentEl.textContent = '100';
            elapsed = (Date.now() - startTime) / 1000;
            timeEl.textContent = Math.round(elapsed);
            titleEl.textContent = '✅ ' + titleEl.textContent;

            // 延迟一下让用户看到 100%
            await new Promise(r => setTimeout(r, 600));
            overlay.classList.remove('open');

            if (requestId !== this.previewRequestId) return;
            this.previewData = previewData.data;
            this.previewTotal = this.previewData.total ?? this.previewData.stat.count;
            this.renderPreview();
        } catch (error) {
            clearInterval(timer);
            overlay.classList.remove('open');
            if (requestId !== this.previewRequestId) return;
            preview.innerHTML = `<div class="empty-state">计算失败: ${error.message}</div>`;
        } finally {
            this.calculationInFlight = false;
        }
    }

    invalidatePreview() {
        cancelRankingPreview();
        this.previewRequestId += 1;
        this.previewPage = 1;
        this.previewData = null;
        this.previewTotal = 0;
        this.setPreviewLoading(false);
        document.getElementById('rankingPreview').innerHTML = '<div class="empty-state">预览参数已更改，请点击“预览”获取数据</div>';
        document.getElementById('previewPagination').style.display = 'none';
        document.getElementById('previewPaginationTop').style.display = 'none';
    }

    // 独立预览功能：获取预览数据（不计算排行榜）
    async getPreview() {
        let videoId;
        try { videoId = parseVideoId(document.getElementById('previewVideoId').value, { exact: true }).value; }
        catch (error) { alert(error.message); return; }
        this.previewVideoId = videoId;
        const requestId = ++this.previewRequestId;
        const rank = document.getElementById('previewRank').value;
        const indexInput = Number.parseInt(document.getElementById('previewIndex').value, 10);
        const index = Number.isNaN(indexInput) ? 1 : Math.max(1, indexInput);
        document.getElementById('previewIndex').value = index;
        this.previewShowSpecial = document.getElementById('previewShowSpecial').checked;
        this.previewRank = rank;
        this.previewIndex = index;
        this.previewPage = 1;
        this.previewPageSize = parseInt(document.getElementById('previewPageSize').value);

        const preview = document.getElementById('rankingPreview');
        this.previewData = null;
        this.setPreviewLoading(true);
        preview.innerHTML = '<div class="loading">正在获取预览数据...</div>';
        document.getElementById('previewPagination').style.display = 'none';
        document.getElementById('previewPaginationTop').style.display = 'none';

        try {
            const result = await getRankingPreview({
                rank,
                index,
                page: 1,
                pageSize: this.previewPageSize,
                videoId,
                showSpecial: this.previewShowSpecial,
            });

            if (requestId !== this.previewRequestId) return;
            this.previewData = result.data;
            this.previewTotal = result.data.total ?? result.data.stat.count;
            this.renderPreview();
        } catch (error) {
            if (requestId !== this.previewRequestId) return;
            preview.innerHTML = createPreviewError(error);
        } finally {
            if (requestId === this.previewRequestId) this.setPreviewLoading(false);
        }
    }

    setPreviewLoading(loading) {
        this.previewLoading = loading;
        for (const id of ['getPreviewBtn', 'clearPreviewSearch', 'previewPageSize', 'previewShowSpecial']) {
            document.getElementById(id).disabled = loading;
        }
        const totalPages = Math.ceil(this.previewTotal / this.previewPageSize) || 1;
        for (const suffix of ['', 'Top']) {
            document.getElementById(`previewPrevPageBtn${suffix}`).disabled = loading || this.previewPage <= 1;
            document.getElementById(`previewNextPageBtn${suffix}`).disabled = loading || this.previewPage >= totalPages;
            document.getElementById(`previewGoPageBtn${suffix}`).disabled = loading;
            document.getElementById(`previewPageInput${suffix}`).disabled = loading;
        }
    }

    // 预览分页切换
    previewChangePage(delta) {
        return this.previewGoPage(this.previewPage + delta);
    }

    previewGoPage(newPage) {
        const totalPages = Math.ceil(this.previewTotal / this.previewPageSize) || 1;
        if (!Number.isInteger(newPage) || newPage < 1 || newPage > totalPages || newPage === this.previewPage || this.previewVideoId || this.previewLoading) return;
        const requestId = ++this.previewRequestId;
        this.setPreviewLoading(true);
        this.previewData = null;

        const preview = document.getElementById('rankingPreview');
        preview.innerHTML = '<div class="loading">正在加载...</div>';

        const rank = this.previewRank;
        const index = this.previewIndex;

        return getRankingPreview({
            rank,
            index,
            page: newPage,
            pageSize: this.previewPageSize,
            showSpecial: this.previewShowSpecial,
        }).then(result => {
            if (requestId !== this.previewRequestId) return;
            this.previewPage = newPage;
            this.previewData = result.data;
            this.previewTotal = result.data.total ?? result.data.stat.count;
            this.renderPreview();
        }).catch(error => {
            if (requestId !== this.previewRequestId) return;
            preview.innerHTML = createPreviewError(error);
        }).finally(() => {
            if (requestId === this.previewRequestId) this.setPreviewLoading(false);
        });
    }

    // 渲染预览数据
    renderPreview() {
        const preview = document.getElementById('rankingPreview');
        const raw = this.previewData;
        const showSpecial = this.previewShowSpecial && this.previewPage === 1 && !raw?.search_id;
        const rows = raw ? [...(showSpecial ? raw.special_entries || [] : []), ...(raw.entries || [])] : [];
        const seen = new Set();
        const data = raw ? { ...raw, entries: rows.filter(entry => {
            const special = String(entry.special_rank ?? entry.specialRank ?? '').toLowerCase();
            if (!raw.search_id && !showSpecial && ['hot', 'sh'].includes(special)) return false;
            if (seen.has(entry.bvid)) return false;
            seen.add(entry.bvid);
            return true;
        }).map(entry => {
            const change = this.changes.get(entry.bvid);
            return change ? { ...entry, ranks: change.ranks, is_examined: change.is_examined, pending: true } : entry;
        }) } : null;

        preview.style.marginTop = '1rem';
        preview.innerHTML = createPreviewContent({
            data,
            previewRank: this.previewRank,
            previewIndex: this.previewIndex,
        });

        if (showSpecial && raw?.special_truncated) {
            const notice = document.createElement('div');
            notice.className = 'empty-state';
            notice.textContent = 'HOT/SH 超过显示上限，仅展示前 100 条';
            preview.appendChild(notice);
        }

        // 更新分页
        const totalPages = Math.ceil(this.previewTotal / this.previewPageSize) || 1;
        for (const suffix of ['', 'Top']) {
            document.getElementById(`previewPagination${suffix}`).style.display = this.previewTotal > 0 && !raw?.search_id ? 'flex' : 'none';
            document.getElementById(`previewPageInfo${suffix}`).textContent = `第 ${this.previewPage} 页 / 共 ${totalPages} 页（共 ${this.previewTotal} 项）`;
            document.getElementById(`previewPrevPageBtn${suffix}`).disabled = this.previewPage <= 1;
            document.getElementById(`previewNextPageBtn${suffix}`).disabled = this.previewPage >= totalPages;
            document.getElementById(`previewPageInput${suffix}`).value = this.previewPage;
            document.getElementById(`previewPageInput${suffix}`).max = totalPages;
        }
    }

    // 通过 bvid 打开编辑面板（用于预览页面的编辑功能）
    async openEditPanelByBvid(bvid) {
        this.closeEditPanel();
        const requestId = this.editRequestId;
        if (this.videos.some(video => video.bvid === bvid)) {
            this.openEditPanel(bvid);
            return;
        }
        try {
            const result = await getVideo(bvid);
            // A newer edit, navigation, or cancellation must win over this response.
            if (requestId !== this.editRequestId) return;
            if (!this.videos.some(video => video.bvid === bvid)) this.videos.push(result.data);
            this.openEditPanel(bvid);
        } catch (error) {
            if (requestId === this.editRequestId) alert('获取视频数据失败: ' + error.message);
        }
    }

    async pikaSearch() {
        const keyword = document.getElementById('pikaKeyword').value;
        const videoList = document.getElementById('pikaVideoList');

        if (!keyword) {
            videoList.innerHTML = '<div class="empty-state">请输入关键字搜索</div>';
            return;
        }

        videoList.innerHTML = '<div class="loading">搜索中...</div>';

        try {
            const result = await getVideos({ keyword, page_size: '100' });

            if (result.data.length === 0) {
                videoList.innerHTML = '<div class="empty-state">未找到相关稿件</div>';
                return;
            }

            videoList.innerHTML = result.data.map(video => createVideoCard(video, {
                hasChange: this.changes.has(video.bvid),
                isSelected: this.selectedVideos.has(video.bvid),
            })).join('');
        } catch (error) {
            videoList.innerHTML = `<div class="empty-state">搜索失败: ${error.message}</div>`;
        }
    }

    async sendDebugRequest() {
        const endpoint = document.getElementById('debugEndpoint').value;
        const paramsStr = document.getElementById('debugParams').value;
        const output = document.getElementById('debugOutput');

        output.className = 'debug-output';
        output.textContent = '发送请求中...';

        try {
            const { status, duration, result } = await sendDebugRequestApi(endpoint, paramsStr);

            output.className = 'debug-output success';
            output.textContent = `[${status}] ${duration}ms\n\n${JSON.stringify(result, null, 2)}`;
        } catch (error) {
            output.className = 'debug-output error';
            output.textContent = `请求失败: ${error.message}`;
        }
    }
}

window.app = new CVSEApp();
