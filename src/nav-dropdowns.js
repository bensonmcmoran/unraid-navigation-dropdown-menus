/*
 * Navigation Dropdown Menus
 * Parent Unraid navigation anchors are never replaced.
 */
(() => {
    'use strict';

    const BUILD = '1.0.2';
    const BOOT = window.JND_BOOTSTRAP;
    const ALL_TARGETS = ['Main', 'Shares', 'Users', 'Settings', 'Plugins', 'Docker', 'VMs', 'Tools'];
    const TARGETS = ALL_TARGETS.filter(target => BOOT?.dropdowns?.[target] !== false);
    const SORTABLE_TARGETS = new Set(['Shares', 'Users', 'Docker', 'VMs']);
    const STATIC_CACHE_MS = 60000;
    const DYNAMIC_CACHE_MS = 15000;
    const SESSION_CACHE_SCHEMA = 3;
    const SESSION_CACHE_PREFIX = 'jnd-provider-cache';
    const SESSION_CACHE_TARGETS = new Set(['Docker', 'VMs', 'ud_remotes']);
    const SYNC_CHANNEL_SCHEMA = 1;
    const SYNC_CHANNEL_NAME = 'jnd-nav-sync-v1';
    const REQUEST_TIMEOUT_MS = 6000;
    const ACTION_TIMEOUT_MS = 30000;
    const TRANSITION_POLL_MS = 850;
    const NATIVE_LIFECYCLE_REFRESH_DELAY_MS = 500;
    const TRANSITION_TIMEOUT_MS = 60000;
    const ALLOWED_HOVER_OPEN_MS = new Set([75, 100, 150, 200]);
    const configuredHoverOpenMs = Number(BOOT?.preferences?.hoverOpenMs);
    const HOVER_OPEN_MS = ALLOWED_HOVER_OPEN_MS.has(configuredHoverOpenMs) ? configuredHoverOpenMs : 100;
    const HOVER_CLOSE_MS = 320;
    const SORT_MODE = BOOT?.preferences?.sortMode === 'alphabetical' ? 'alphabetical' : 'unraid';
    const LABEL_COLLATOR = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

    if (!BOOT || BOOT.schema !== 3) {
        console.warn('[JND] Bootstrap unavailable or incompatible; normal Unraid navigation will continue to work.');
        return;
    }

    const query = new URLSearchParams(window.location.search);
    const DISABLE_KEY = `jnd-disabled:${BOOT.version || BUILD}`;
    try {
        if (query.get('navdropdowns') === 'off') sessionStorage.setItem(DISABLE_KEY, '1');
        else if (query.get('navdropdowns') === 'on') sessionStorage.removeItem(DISABLE_KEY);

        if (sessionStorage.getItem(DISABLE_KEY) === '1') {
            console.info('[JND] Disabled for this browser session. Use ?navdropdowns=on to re-enable.');
            return;
        }
    } catch (_) {
        if (query.get('navdropdowns') === 'off') return;
    }

    const state = {
        overlay: null,
        scroll: null,
        activeTarget: null,
        activeNavItem: null,
        openTimer: null,
        closeTimer: null,
        cache: new Map(),
        inFlight: new Map(),
        providerEpoch: new Map(),
        warmQueueStarted: false,
        udItems: [],
        udLoaded: false,
        udCacheTime: 0,
        udInFlight: null,
        transitions: new Map(),
        transitionTimer: null,
        transitionPollInFlight: false,
        syncChannel: null,
        syncSource: '',
        attached: false,
    };

    function sameOriginPath(value) {
        if (value === null || value === undefined) return null;

        const raw = String(value).trim();
        if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') return null;

        try {
            const u = new URL(raw, window.location.origin);
            if (u.origin !== window.location.origin) return null;
            return u.pathname + u.search + u.hash;
        } catch (_) {
            return null;
        }
    }

    function safeWebUrl(value) {
        if (value === null || value === undefined) return null;

        const raw = String(value).trim();
        if (!raw || raw === '#' || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') return null;

        try {
            const url = new URL(raw, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol)) return null;
            if (url.username || url.password) return null;
            return url.href;
        } catch (_) {
            return null;
        }
    }

    function cleanText(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function cloneData(value) {
        if (Array.isArray(value)) return value.map(cloneData);
        if (value && typeof value === 'object') {
            const copy = {};
            for (const [key, child] of Object.entries(value)) copy[key] = cloneData(child);
            return copy;
        }
        return value;
    }

    function compatibilityCheck() {
        const style = getComputedStyle(document.documentElement);
        if (!style.getPropertyValue('--background-color').trim() ||
            !style.getPropertyValue('--text-color').trim() ||
            !style.getPropertyValue('--header-background-color').trim()) {
            console.warn('[JND] Required Dynamix theme variables are absent; stock navigation left untouched.');
            return null;
        }

        const navTile = document.querySelector('#menu .nav-tile:not(.right)');
        if (!navTile) {
            console.warn('[JND] Compatible stock navigation container was not found; stock navigation left untouched.');
            return null;
        }

        return navTile;
    }

    function ensureOverlay() {
        if (state.overlay) return state.overlay;

        const overlay = document.createElement('div');
        overlay.id = 'jnd-overlay';
        overlay.setAttribute('aria-label', 'Navigation submenu');

        const scroll = document.createElement('div');
        scroll.className = 'jnd-scroll';
        overlay.appendChild(scroll);

        overlay.addEventListener('mouseenter', cancelClose);
        overlay.addEventListener('mouseleave', scheduleClose);
        overlay.addEventListener('keydown', onOverlayKeyDown);
        overlay.addEventListener('click', (event) => {
            if (!window.matchMedia('(max-width: 767px)').matches) return;

            const trigger = event.target.closest('.jnd-submenu-trigger');
            if (!trigger) return;

            const wrap = trigger.closest('.jnd-submenu-wrap');
            if (!wrap?.querySelector(':scope > .jnd-submenu')) return;

            event.preventDefault();
            wrap.classList.toggle('jnd-mobile-submenu-open');
        });

        document.body.appendChild(overlay);
        state.overlay = overlay;
        state.scroll = scroll;
        return overlay;
    }

    function createLabel(item) {
        const span = document.createElement('span');
        span.className = 'jnd-label';
        span.textContent = cleanText(item.label) || 'Untitled';

        return span;
    }

    function createAppIcon(icon) {
        if (!icon || typeof icon !== 'object') return null;

        if (icon.kind === 'img') {
            const src = sameOriginPath(icon.src);
            if (!src) return null;

            const img = document.createElement('img');
            img.className = 'jnd-app-icon';
            if (icon.variant === 'avatar') img.classList.add('jnd-user-avatar');
            img.src = src;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');

            const fallback = sameOriginPath(icon.fallback);
            if (fallback && fallback !== src) {
                img.addEventListener('error', () => {
                    if (img.dataset.jndFallbackApplied === '1') return;
                    img.dataset.jndFallbackApplied = '1';
                    img.src = fallback;
                }, { once: true });
            }

            return img;
        }

        if (icon.kind === 'class') {
            const classes = cleanText(icon.className)
                .split(' ')
                .filter(c => /^(?:fa|fa-[A-Za-z0-9_-]+|icon-[A-Za-z0-9_-]+|PanelIcon|PanelImg|title)$/.test(c));

            if (!classes.length) return null;

            const i = document.createElement('i');
            i.className = `${classes.join(' ')} jnd-app-icon`;
            i.setAttribute('aria-hidden', 'true');
            return i;
        }

        return null;
    }

    function stateIconClass(value) {
        const stateName = cleanText(value).toLowerCase();

        if (stateName === 'started' || stateName === 'running') {
            return 'fa fa-play started green-text jnd-state-icon';
        }
        if (stateName === 'paused') {
            return 'fa fa-pause paused orange-text jnd-state-icon';
        }
        return 'fa fa-square stopped red-text jnd-state-icon';
    }

    function createStateIcon(value) {
        const stateName = cleanText(value).toLowerCase();
        if (!stateName) return null;

        const i = document.createElement('i');
        i.className = stateIconClass(stateName);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function appendRowContents(container, item) {
        const icon = createAppIcon(item.icon);
        if (icon) container.appendChild(icon);

        const status = createStateIcon(item.state);
        if (status) container.appendChild(status);

        container.appendChild(createLabel(item));
    }

    function actionLabel(control) {
        if (!control || typeof control !== 'object') return '';

        if (control.kind === 'docker') {
            return control.action === 'stop' ? 'Stop container' : 'Start container';
        }
        if (control.kind === 'vm') {
            return control.action === 'domain-stop' ? 'Stop VM' : 'Start VM';
        }
        return '';
    }


    function controlKey(control) {
        if (!control || typeof control !== 'object') return '';

        const kind = cleanText(control.kind).toLowerCase();
        const id = cleanText(control.id);
        if (!kind || !id) return '';

        return `${kind}:${id}`;
    }

    function pruneExpiredTransitions() {
        const now = Date.now();

        for (const [key, transition] of state.transitions) {
            if (!transition || transition.expiresAt <= now) {
                state.transitions.delete(key);
            }
        }
    }

    function getTransition(control) {
        pruneExpiredTransitions();
        const key = controlKey(control);
        return key ? (state.transitions.get(key) || null) : null;
    }

    function beginTransition(target, control, expectedState) {
        const key = controlKey(control);
        if (!key) return null;

        const now = Date.now();
        const transition = {
            key,
            target,
            kind: cleanText(control.kind).toLowerCase(),
            id: cleanText(control.id),
            action: cleanText(control.action),
            expectedState: cleanText(expectedState).toLowerCase(),
            actionComplete: false,
            startedAt: now,
            expiresAt: now + TRANSITION_TIMEOUT_MS,
        };

        state.transitions.set(key, transition);
        return transition;
    }

    function clearTransition(control) {
        const key = controlKey(control);
        if (key) state.transitions.delete(key);
    }

    function markTransitionActionComplete(control) {
        const key = controlKey(control);
        if (!key) return null;
        const transition = state.transitions.get(key) || null;
        if (transition) transition.actionComplete = true;
        return transition;
    }

    function expectedStateForControl(control) {
        const kind = cleanText(control?.kind).toLowerCase();
        const action = cleanText(control?.action);
        if (kind === 'docker' && action === 'start') return 'started';
        if (kind === 'docker' && action === 'stop') return 'stopped';
        if (kind === 'vm' && action === 'domain-start') return 'started';
        if (kind === 'vm' && action === 'domain-stop') return 'stopped';
        return '';
    }

    function validSyncControl(target, control, expectedState) {
        if (!['Docker', 'VMs'].includes(target) || !control || typeof control !== 'object') return null;
        const kind = cleanText(control.kind).toLowerCase();
        const id = cleanText(control.id);
        const action = cleanText(control.action);
        if (!id || id.length > 256) return null;
        if (target === 'Docker' && kind !== 'docker') return null;
        if (target === 'VMs' && kind !== 'vm') return null;
        const normalized = {kind, id, action};
        const expected = expectedStateForControl(normalized);
        if (!expected || expected !== cleanText(expectedState).toLowerCase()) return null;
        return normalized;
    }

    function publishSync(phase, target, control, expectedState) {
        if (!state.syncChannel || !['begin', 'refresh', 'cancel'].includes(phase)) return;
        const normalized = validSyncControl(target, control, expectedState);
        if (!normalized) return;
        try {
            state.syncChannel.postMessage({
                schema: SYNC_CHANNEL_SCHEMA,
                source: state.syncSource,
                phase,
                target,
                control: normalized,
                expectedState: cleanText(expectedState).toLowerCase(),
                time: Date.now(),
            });
        } catch (_) {}
    }

    function renderTransitionSnapshot(target, items) {
        if (state.activeTarget !== target || !Array.isArray(items)) return;
        renderMenu(items);
        requestAnimationFrame(positionOverlay);
        if (hasTransitionsFor(target)) scheduleTransitionPolling(300);
    }

    function refreshOpenProvider(target, warningLabel) {
        if (state.activeTarget !== target) return;
        void getProviderItems(target, {forceFresh: true})
            .then(items => {
                if (state.activeTarget !== target) return;
                renderMenu(items);
                requestAnimationFrame(positionOverlay);
                if (hasTransitionsFor(target)) scheduleTransitionPolling();
            })
            .catch(error => console.warn('[JND] ' + target + ' ' + warningLabel + ' refresh failed:', error));
    }

    function handleSyncMessage(event) {
        const msg = event?.data;
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        if (msg.schema !== SYNC_CHANNEL_SCHEMA || msg.source === state.syncSource) return;
        if (!['begin', 'refresh', 'cancel'].includes(msg.phase)) return;
        const time = Number(msg.time);
        if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 5000 || Date.now() - time > TRANSITION_TIMEOUT_MS) return;
        const control = validSyncControl(msg.target, msg.control, msg.expectedState);
        if (!control) return;

        const snapshot = state.activeTarget === msg.target ? cachePeek(msg.target)?.items : null;

        if (msg.phase === 'begin') {
            beginTransition(msg.target, control, msg.expectedState);
            invalidateProviderObservation(msg.target);
            renderTransitionSnapshot(msg.target, snapshot);
            return;
        }

        if (msg.phase === 'cancel') {
            clearTransition(control);
            invalidateProviderObservation(msg.target);
            refreshOpenProvider(msg.target, 'cross-tab cancel');
            return;
        }

        markTransitionActionComplete(control);
        invalidateProviderObservation(msg.target);
        refreshStockPage(msg.target);
        refreshOpenProvider(msg.target, 'cross-tab');
    }

    function attachCrossTabSync() {
        if (typeof window.BroadcastChannel !== 'function' || state.syncChannel) return;
        try {
            state.syncSource = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
            state.syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
            state.syncChannel.addEventListener('message', handleSyncMessage);
        } catch (_) {
            state.syncChannel = null;
            state.syncSource = '';
        }
    }

    function hasTransitionsFor(target) {
        pruneExpiredTransitions();

        for (const transition of state.transitions.values()) {
            if (transition?.target === target) return true;
        }
        return false;
    }

    function findControlItem(items, control) {
        const key = controlKey(control);
        if (!key) return null;

        for (const item of items || []) {
            if (!item || typeof item !== 'object') continue;
            if (controlKey(itemTransitionIdentity(item)) === key) return item;

            if (Array.isArray(item.children)) {
                const child = findControlItem(item.children, control);
                if (child) return child;
            }
        }

        return null;
    }

    function reconcileTransitions(target, items) {
        pruneExpiredTransitions();

        for (const [key, transition] of state.transitions) {
            if (transition?.target !== target) continue;

            const item = findControlItem(items, transition);
            if (!item) continue;

            const currentState = cleanText(item.state).toLowerCase();
            if (transition.actionComplete === true && currentState === transition.expectedState) {
                state.transitions.delete(key);
            }
        }
    }

    function transitionColorClass(transition, itemState = '') {
        const action = cleanText(transition?.action);
        if (action === 'start' || action === 'domain-start') return 'red-text';
        if (action === 'stop' || action === 'domain-stop') return 'green-text';
        const stateName = cleanText(itemState).toLowerCase();
        if (stateName === 'started' || stateName === 'running') return 'green-text';
        if (stateName === 'paused') return 'orange-text';
        return 'red-text';
    }

    function createTransitionSpinner(transition, itemState = '') {
        const spinner = document.createElement('i');
        spinner.className = 'fa fa-refresh fa-spin ' + transitionColorClass(transition, itemState);
        spinner.setAttribute('aria-hidden', 'true');
        return spinner;
    }

    function createTransitionIndicator(transition, item) {
        const wrapper = document.createElement('span');
        const spinner = createTransitionSpinner(transition, item?.state);
        const label = 'Transitioning: ' + cleanText(item?.label);
        wrapper.setAttribute('role', 'status');
        wrapper.setAttribute('aria-label', label);
        wrapper.setAttribute('aria-busy', 'true');
        wrapper.title = label;
        wrapper.appendChild(spinner);
        return wrapper;
    }

    function stopTransitionPolling() {
        if (state.transitionTimer) {
            clearTimeout(state.transitionTimer);
            state.transitionTimer = null;
        }
    }

    function scheduleTransitionPolling(delay = TRANSITION_POLL_MS) {
        stopTransitionPolling();

        const target = state.activeTarget;
        if (!target || !['Docker', 'VMs'].includes(target) || !hasTransitionsFor(target)) return;

        state.transitionTimer = setTimeout(pollVisibleTransitions, delay);
    }

    async function pollVisibleTransitions() {
        state.transitionTimer = null;

        const target = state.activeTarget;
        if (!target || !['Docker', 'VMs'].includes(target) || !hasTransitionsFor(target)) return;

        if (state.transitionPollInFlight) {
            scheduleTransitionPolling();
            return;
        }

        state.transitionPollInFlight = true;

        try {
            const latest = await getProviderItems(target, {forceFresh: true});

            if (state.activeTarget === target && Array.isArray(latest)) {
                renderMenu(latest);
                requestAnimationFrame(positionOverlay);
            }
        } catch (error) {
            console.warn(`[JND] ${target} transition refresh failed:`, error);
        } finally {
            state.transitionPollInFlight = false;

            if (state.activeTarget === target && hasTransitionsFor(target)) {
                scheduleTransitionPolling();
            }
        }
    }

    function statusKind(item) {
        const value = cleanText(item?.statusKind || item?.control?.kind).toLowerCase();
        return value === 'docker' || value === 'vm' ? value : '';
    }

    function itemTransitionIdentity(item) {
        const kind = statusKind(item);
        const id = cleanText(item?.statusId);
        if (kind && id) return {kind, id};
        const control = item?.control;
        return control && typeof control === 'object' ? control : null;
    }

    function statusIndicatorsEnabled(item) {
        const kind = statusKind(item);
        if (kind === 'docker') return BOOT.features?.statusIndicators?.docker === true;
        if (kind === 'vm') return BOOT.features?.statusIndicators?.vms === true;
        return false;
    }

    function createInlinePlaceholder(kind) {
        const span = document.createElement('span');
        span.className = `jnd-inline-placeholder jnd-${kind}-placeholder`;
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function createWebUiControl(item) {
        if (BOOT.features?.dockerWebUIButtons !== true) return null;
        if (statusKind(item) !== 'docker' || cleanText(item?.state).toLowerCase() !== 'started') return null;

        const href = safeWebUrl(item?.webui);
        if (!href) return null;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jnd-inline-control jnd-webui-control';
        button.title = `Open WebUI: ${cleanText(item?.label)}`;
        button.setAttribute('aria-label', button.title);

        const icon = document.createElement('i');
        icon.className = 'fa fa-globe';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (BOOT.features?.webUiNewTab === true) {
                window.open(href, '_blank', 'noopener,noreferrer');
            } else {
                window.location.assign(href);
            }
        });

        return button;
    }

    function createLogControl(item) {
        const kind = statusKind(item);
        const enabled =
            (kind === 'docker' && BOOT.features?.dockerLogButtons === true) ||
            (kind === 'vm' && BOOT.features?.vmLogButtons === true);

        if (!enabled || !item?.log || typeof item.log !== 'object') return null;
        if (typeof window.openTerminal !== 'function') return null;

        const tag = kind === 'docker' ? 'docker' : 'log';
        const name = cleanText(item.log.name);
        const more = String(item.log.more ?? '');
        if (!name || !more) return null;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jnd-inline-control jnd-log-control';
        button.title = `Open log: ${cleanText(item?.label)}`;
        button.setAttribute('aria-label', button.title);

        const icon = document.createElement('i');
        icon.className = 'fa fa-navicon';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.openTerminal(tag, name, more);
        });

        return button;
    }

    function safeSameOriginUrl(value) {
        const href = safeWebUrl(value);
        if (!href) return null;

        try {
            const url = new URL(href);
            return url.origin === window.location.origin ? url.href : null;
        } catch (_) {
            return null;
        }
    }

    function createVncConsoleControl(item) {
        if (BOOT.features?.vmVncConsoleButtons !== true) return null;
        if (statusKind(item) !== 'vm') return null;

        const href = safeSameOriginUrl(item?.vncConsole);
        if (!href) return null;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jnd-inline-control jnd-vnc-control';
        button.title = `Open VNC console: ${cleanText(item?.label)}`;
        button.setAttribute('aria-label', button.title);

        const icon = document.createElement('i');
        icon.className = 'fa fa-desktop';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const popup = window.open(href, '_blank', 'scrollbars=yes,resizable=yes,noopener');
            if (popup) popup.opener = null;
        });

        return button;
    }

    function buildInlineLayout(items) {
        const list = Array.isArray(items) ? items : [];
        return {
            reserveDockerWebUi:
                BOOT.features?.dockerWebUIButtons === true &&
                list.some(item =>
                    statusKind(item) === 'docker' &&
                    cleanText(item?.state).toLowerCase() === 'started' &&
                    safeWebUrl(item?.webui)
                ),
            reserveDockerLog:
                BOOT.features?.dockerLogButtons === true &&
                list.some(item => statusKind(item) === 'docker' && item?.log),
            reserveVmLog:
                BOOT.features?.vmLogButtons === true &&
                list.some(item => statusKind(item) === 'vm' && item?.log),
            reserveVmVnc:
                BOOT.features?.vmVncConsoleButtons === true &&
                list.some(item => statusKind(item) === 'vm' && safeSameOriginUrl(item?.vncConsole)),
        };
    }

    function createStatusControl(item) {
        const control = item?.control;
        if (!statusIndicatorsEnabled(item)) return null;

        const icon = createStateIcon(item?.state);
        if (!icon) return null;

        const kind = statusKind(item);
        const quickEnabled = kind === 'docker'
            ? BOOT.features?.quickActions?.docker === true
            : (kind === 'vm' ? BOOT.features?.quickActions?.vms === true : false);

        const transition = getTransition(itemTransitionIdentity(item));
        if (transition) {
            return createTransitionIndicator(transition, item);
        }

        if (!quickEnabled || !control || typeof control !== 'object') {
            const span = document.createElement('span');
            span.className = 'jnd-status-static';
            span.appendChild(icon);
            return span;
        }

        const label = actionLabel(control);
        if (!label) {
            const span = document.createElement('span');
            span.className = 'jnd-status-static';
            span.appendChild(icon);
            return span;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jnd-status-control';
        button.title = `${label}: ${cleanText(item.label)}`;
        button.setAttribute('aria-label', button.title);
        button.appendChild(icon);

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await performQuickAction(item, button);
        });

        return button;
    }

    function createStatusRow(item, layout) {
        const row = document.createElement('div');
        row.className = `jnd-status-row${Number(item.indent) === 1 ? ' jnd-indent-1' : ''}`;

        const icon = createAppIcon(item.icon);
        if (icon) row.appendChild(icon);

        const kind = statusKind(item);

        // For VMs, VNC is the first inline control to the right of the VM icon.
        if (kind === 'vm' && layout?.reserveVmVnc) {
            row.appendChild(createVncConsoleControl(item) || createInlinePlaceholder('vnc'));
        }

        const status = createStatusControl(item);
        if (status) row.appendChild(status);

        if (kind === 'docker' && layout?.reserveDockerLog) {
            row.appendChild(createLogControl(item) || createInlinePlaceholder('log'));
        } else if (kind === 'vm' && layout?.reserveVmLog) {
            row.appendChild(createLogControl(item) || createInlinePlaceholder('log'));
        }

        if (kind === 'docker' && layout?.reserveDockerWebUi) {
            row.appendChild(createWebUiControl(item) || createInlinePlaceholder('webui'));
        }

        const href = sameOriginPath(item.href);
        if (href) {
            const a = document.createElement('a');
            a.href = href;
            a.appendChild(createLabel(item));
            row.appendChild(a);
        } else {
            row.appendChild(createLabel(item));
        }

        return row;
    }

    function createLink(item) {
        const href = sameOriginPath(item.href);
        if (!href) return null;

        const a = document.createElement('a');
        a.href = href;
        appendRowContents(a, item);
        return a;
    }

    function renderItems(items, container) {
        const inlineLayout = buildInlineLayout(items);

        for (const raw of items || []) {
            const item = raw && typeof raw === 'object' ? raw : {};
            const type = item.type || 'item';

            if (type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'jnd-separator';
                sep.setAttribute('role', 'separator');
                container.appendChild(sep);
                continue;
            }

            if (type === 'heading') {
                const row = document.createElement('div');
                row.className = 'jnd-heading';

                const link = item.href ? createLink(item) : null;
                if (link) {
                    row.appendChild(link);
                } else {
                    const span = document.createElement('span');
                    span.textContent = cleanText(item.label);
                    row.appendChild(span);
                }

                container.appendChild(row);
                continue;
            }

            if (type === 'submenu' && Array.isArray(item.children) && item.children.length) {
                const wrap = document.createElement('div');
                wrap.className = 'jnd-submenu-wrap';

                const href = item.href ? sameOriginPath(item.href) : null;
                let trigger;

                if (href) {
                    trigger = document.createElement('a');
                    trigger.href = href;
                } else {
                    trigger = document.createElement('div');
                    trigger.tabIndex = 0;
                    trigger.setAttribute('aria-haspopup', 'true');
                }

                trigger.className = 'jnd-submenu-trigger';
                appendRowContents(trigger, item);

                const arrow = document.createElement('span');
                arrow.className = 'jnd-submenu-arrow';
                arrow.setAttribute('aria-hidden', 'true');
                arrow.innerHTML = '<i class="fa fa-caret-right"></i>';
                trigger.appendChild(arrow);
                wrap.appendChild(trigger);

                const sub = document.createElement('div');
                sub.className = 'jnd-submenu';

                if (item.layout === 'grid') {
                    sub.classList.add('jnd-grid-submenu');
                    if (item.children.length > 20) sub.classList.add('jnd-grid-3');
                }

                renderItems(item.children, sub);
                wrap.appendChild(sub);
                container.appendChild(wrap);
                continue;
            }

            if (item.state) {
                container.appendChild(createStatusRow(item, inlineLayout));
                continue;
            }

            const row = document.createElement('div');
            const link = createLink(item);

            if (link) {
                row.className = `jnd-row${Number(item.indent) === 1 ? ' jnd-indent-1' : ''}`;
                row.appendChild(link);
            } else {
                row.className = `jnd-static-row${Number(item.indent) === 1 ? ' jnd-indent-1' : ''}`;
                appendRowContents(row, item);
            }

            container.appendChild(row);
        }
    }

    function renderLoading() {
        ensureOverlay();
        state.scroll.replaceChildren();

        const loading = document.createElement('div');
        loading.className = 'jnd-loading';
        loading.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i>Loading…';
        state.scroll.appendChild(loading);
    }

    function renderMenu(items) {
        ensureOverlay();
        state.scroll.replaceChildren();

        const safeItems = Array.isArray(items) ? items : [];
        if (!safeItems.length) {
            renderItems([{type: 'item', label: 'No navigation items available', href: null}], state.scroll);
        } else {
            renderItems(safeItems, state.scroll);
        }
    }

    function positionOverlay() {
        if (!state.overlay || !state.activeNavItem || !state.scroll) return;

        const rect = state.activeNavItem.getBoundingClientRect();
        const overlay = state.overlay;
        const scroll = state.scroll;
        const gap = 4;
        const margin = 8;
        const rootRem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const bottomClearance = rootRem;
        const sidebar = document.documentElement.classList.contains('Theme--sidebar');

        scroll.classList.remove('jnd-scroll-constrained');
        scroll.style.maxHeight = '';

        overlay.style.left = '0px';
        overlay.style.top = '0px';
        overlay.classList.remove('jnd-flip-submenus');

        const width = overlay.offsetWidth || 300;
        const height = overlay.offsetHeight || 200;
        let left;
        let top;

        if (sidebar) {
            left = rect.right + gap;
            top = rect.top;

            if (left + width > window.innerWidth - margin) {
                left = Math.max(margin, rect.left - width - gap);
            }
        } else {
            left = rect.left;
            top = rect.bottom + gap;

            if (left + width > window.innerWidth - margin) {
                left = Math.max(margin, window.innerWidth - width - margin);
            }

            if (top + height > window.innerHeight - bottomClearance &&
                rect.top - height - gap >= margin) {
                top = rect.top - height - gap;
            }
        }

        left = Math.max(margin, left);
        top = Math.max(margin, top);

        overlay.style.left = `${Math.round(left)}px`;
        overlay.style.top = `${Math.round(top)}px`;

        const overlayChrome = Math.max(0, overlay.offsetHeight - scroll.offsetHeight);
        const availableScrollHeight = Math.max(1, Math.floor(
            window.innerHeight - top - bottomClearance - overlayChrome
        ));

        if (availableScrollHeight > 0 && scroll.scrollHeight > availableScrollHeight) {
            scroll.style.maxHeight = `${availableScrollHeight}px`;
            scroll.classList.add('jnd-scroll-constrained');
        }

        const estimatedSubmenuWidth = 430;
        if (left + width + estimatedSubmenuWidth > window.innerWidth - margin) {
            overlay.classList.add('jnd-flip-submenus');
        }
    }

    function cancelOpen() {
        if (state.openTimer) {
            clearTimeout(state.openTimer);
            state.openTimer = null;
        }
    }

    function cancelClose() {
        if (state.closeTimer) {
            clearTimeout(state.closeTimer);
            state.closeTimer = null;
        }
    }

    function scheduleClose() {
        cancelClose();
        state.closeTimer = setTimeout(closeMenu, HOVER_CLOSE_MS);
    }

    function closeMenu() {
        cancelOpen();
        cancelClose();
        stopTransitionPolling();

        if (state.overlay) {
            state.overlay.classList.remove('jnd-visible', 'jnd-flip-submenus');
        }

        if (state.activeNavItem) {
            state.activeNavItem.classList.remove('jnd-open');
        }

        state.activeTarget = null;
        state.activeNavItem = null;
    }

    function scheduleOpen(target, navItem) {
        cancelOpen();
        cancelClose();

        if (target === 'Main') ensureMainUDFresh();

        state.openTimer = setTimeout(() => openMenu(target, navItem, false), HOVER_OPEN_MS);
    }

    async function openMenu(target, navItem, focusFirst) {
        cancelOpen();
        cancelClose();

        if (!TARGETS.includes(target) || !navItem?.isConnected) return;

        if (state.activeNavItem && state.activeNavItem !== navItem) {
            state.activeNavItem.classList.remove('jnd-open');
        }

        state.activeTarget = target;
        state.activeNavItem = navItem;
        navItem.classList.add('jnd-open');

        ensureOverlay();

        for (const className of Array.from(state.overlay.classList)) {
            if (className.startsWith('jnd-target-')) state.overlay.classList.remove(className);
        }
        state.overlay.classList.add(`jnd-target-${target.toLowerCase()}`);

        renderLoading();
        state.overlay.classList.add('jnd-visible');
        positionOverlay();

        let items;
        try {
            items = await getProviderItems(target);
        } catch (error) {
            console.warn(`[JND] ${target} provider failed:`, error);
            items = [{type: 'item', label: 'Dropdown data unavailable', href: null}];
        }

        if (state.activeTarget !== target || state.activeNavItem !== navItem) return;

        renderMenu(items);

        if (hasTransitionsFor(target)) {
            scheduleTransitionPolling();
        }

        requestAnimationFrame(() => {
            positionOverlay();
            if (focusFirst) {
                state.overlay.querySelector('a[href], button:not([disabled]), .jnd-submenu-trigger[tabindex="0"]')?.focus();
            }
        });
    }

    function onOverlayKeyDown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            const anchor = state.activeNavItem?.querySelector(':scope > a');
            closeMenu();
            anchor?.focus();
            return;
        }

        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

        const focusable = Array.from(
            state.overlay.querySelectorAll('a[href], button:not([disabled]), .jnd-submenu-trigger[tabindex="0"]')
        ).filter(el => el.offsetParent !== null);

        if (!focusable.length) return;

        event.preventDefault();
        const current = Math.max(0, focusable.indexOf(document.activeElement));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        focusable[(current + delta + focusable.length) % focusable.length].focus();
    }

    function sessionCacheKey(key) {
        const server = cleanText(window.location.host).toLowerCase();
        const unraid = cleanText(BOOT.unraidVersion) || 'unknown';
        return `${SESSION_CACHE_PREFIX}:${SESSION_CACHE_SCHEMA}:${server}:${unraid}:${BUILD}:${key}`;
    }

    function validCachedItems(items) {
        if (!Array.isArray(items) || items.length > 1000) return false;

        return items.every(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            if (cleanText(item.type || 'item') !== 'item') return false;

            const label = cleanText(item.label);
            if (!label || label.length > 512) return false;

            if (item.href !== null && item.href !== undefined && !sameOriginPath(item.href)) return false;
            if (item.indent !== undefined && ![0, 1].includes(Number(item.indent))) return false;

            if (item.icon !== null && item.icon !== undefined) {
                const icon = item.icon;
                if (!icon || typeof icon !== 'object' || Array.isArray(icon)) return false;

                if (icon.kind === 'img') {
                    if (!sameOriginPath(icon.src)) return false;
                    if (icon.fallback !== undefined && icon.fallback !== null && !sameOriginPath(icon.fallback)) return false;
                    if (icon.variant !== undefined && !['', 'avatar'].includes(cleanText(icon.variant))) return false;
                } else if (icon.kind === 'class') {
                    const classes = cleanText(icon.className).split(' ').filter(Boolean);
                    if (!classes.length || classes.length > 8) return false;
                    if (!classes.every(c => /^(?:fa|fa-[A-Za-z0-9_-]+|icon-[A-Za-z0-9_-]+|PanelIcon|PanelImg|title)$/.test(c))) return false;
                } else {
                    return false;
                }
            }

            const status = cleanText(item.statusKind).toLowerCase();
            const stateName = cleanText(item.state).toLowerCase();
            const statusId = cleanText(item.statusId);
            if (status) {
                if (!['docker', 'vm'].includes(status)) return false;
                if (!['started', 'stopped', 'paused'].includes(stateName)) return false;
                if (!statusId || statusId.length > 512) return false;
            } else if (stateName || statusId) {
                return false;
            }

            const control = item.control;
            if (control !== null && control !== undefined) {
                if (!control || typeof control !== 'object' || Array.isArray(control)) return false;
                const kind = cleanText(control.kind).toLowerCase();
                const action = cleanText(control.action);
                const id = cleanText(control.id);
                if (!id || id.length > 256 || kind !== status || id !== statusId || stateName === 'paused') return false;
                if (kind === 'docker' && action !== (stateName === 'started' ? 'stop' : 'start')) return false;
                if (kind === 'vm' && action !== (stateName === 'started' ? 'domain-stop' : 'domain-start')) return false;
            }

            if (item.webui !== null && item.webui !== undefined && !safeWebUrl(item.webui)) return false;
            if (item.vncConsole !== null && item.vncConsole !== undefined && !safeSameOriginUrl(item.vncConsole)) return false;

            if (item.log !== null && item.log !== undefined) {
                const log = item.log;
                if (!log || typeof log !== 'object' || Array.isArray(log)) return false;
                if (cleanText(log.kind).toLowerCase() !== status) return false;
                if (!cleanText(log.name) || cleanText(log.name).length > 512) return false;
                if (!String(log.more ?? '') || String(log.more).length > 1024) return false;
            }

            return true;
        });
    }

    function sessionCacheRead(key) {
        if (!SESSION_CACHE_TARGETS.has(key)) return null;

        try {
            const raw = sessionStorage.getItem(sessionCacheKey(key));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const time = Number(parsed?.time);

            if (
                parsed?.schema !== SESSION_CACHE_SCHEMA ||
                !Number.isFinite(time) ||
                time <= 0 ||
                time > Date.now() + 60000 ||
                !validCachedItems(parsed?.items)
            ) {
                sessionStorage.removeItem(sessionCacheKey(key));
                return null;
            }

            return {time, items: cloneData(parsed.items)};
        } catch (_) {
            return null;
        }
    }

    function sessionCacheWrite(key, entry) {
        if (!SESSION_CACHE_TARGETS.has(key)) return;

        try {
            sessionStorage.setItem(sessionCacheKey(key), JSON.stringify({
                schema: SESSION_CACHE_SCHEMA,
                time: entry.time,
                items: entry.items,
            }));
        } catch (_) {
            // Browser persistence is an optimization only; memory caching remains available.
        }
    }

    function cachePeek(key) {
        let hit = state.cache.get(key);
        if (!hit) {
            hit = sessionCacheRead(key);
            if (hit) state.cache.set(key, hit);
        }
        return hit ? {time: hit.time, items: cloneData(hit.items)} : null;
    }

    function cacheGet(key, maxAge) {
        const hit = cachePeek(key);
        if (!hit || Date.now() - hit.time > maxAge) return null;
        return cloneData(hit.items);
    }

    function cachePut(key, items) {
        const entry = {time: Date.now(), items: cloneData(items)};
        state.cache.set(key, entry);
        sessionCacheWrite(key, entry);
        return items;
    }

    function providerEpoch(key) {
        return state.providerEpoch.get(key) || 0;
    }

    function invalidateProviderObservation(key) {
        state.providerEpoch.set(key, providerEpoch(key) + 1);
        cacheInvalidate(key, {bumpEpoch: false});
    }

    function cacheInvalidate(key, options = {}) {
        if (options?.bumpEpoch !== false && ['Docker', 'VMs'].includes(key)) {
            state.providerEpoch.set(key, providerEpoch(key) + 1);
        }

        state.cache.delete(key);
        if (!SESSION_CACHE_TARGETS.has(key)) return;
        try {
            sessionStorage.removeItem(sessionCacheKey(key));
        } catch (_) {}
    }

    function jqAjax(options) {
        return new Promise((resolve, reject) => {
            if (!window.jQuery?.ajax) {
                reject(new Error('jQuery AJAX unavailable'));
                return;
            }

            const request = window.jQuery.ajax({
                cache: false,
                timeout: REQUEST_TIMEOUT_MS,
                ...options,
            });

            request.done(resolve);
            request.fail((_xhr, status, error) => reject(new Error(error || status || 'AJAX request failed')));
        });
    }

    function showQuickActionError(message) {
        const text = cleanText(message) || 'The requested action failed.';

        if (typeof window.swal === 'function') {
            window.swal({
                title: 'Execution error',
                text,
                type: 'error',
                html: false,
                confirmButtonText: 'Ok',
            });
        } else {
            window.alert(`Execution error: ${text}`);
        }
    }


    function confirmStopAction(item, control) {
        const kind = cleanText(control?.kind).toLowerCase();
        const action = cleanText(control?.action);

        const requiresConfirmation =
            (kind === 'docker' && action === 'stop' && BOOT.features?.confirmStop?.docker === true) ||
            (kind === 'vm' && action === 'domain-stop' && BOOT.features?.confirmStop?.vms === true);

        if (!requiresConfirmation) return true;

        const label = cleanText(item?.label);
        const subject = kind === 'docker' ? 'Docker container' : 'VM';
        return window.confirm(`Stop ${subject} "${label}"?`);
    }

    function refreshStockPage(target) {
        const pagePath = window.location.pathname.replace(/\/+$/, '') || '/';
        const matchingPage =
            (target === 'Docker' && pagePath === '/Docker') ||
            (target === 'VMs' && pagePath === '/VMs');
        if (!matchingPage || typeof window.loadlist !== 'function') return;
        try {
            window.loadlist();
        } catch (error) {
            console.warn('[JND] ' + target + ' stock page refresh failed:', error);
        }
    }

    async function performQuickAction(item, button) {
        const control = item?.control;
        const enabled = control?.kind === 'docker'
            ? BOOT.features?.quickActions?.docker === true
            : (control?.kind === 'vm' ? BOOT.features?.quickActions?.vms === true : false);
        if (!control || button.disabled || !enabled) return;

        const kind = cleanText(control.kind).toLowerCase();
        const id = cleanText(control.id);
        const action = cleanText(control.action);

        if (!id) return;

        let target;
        let expectedState;

        if (kind === 'docker' && (action === 'start' || action === 'stop')) {
            target = 'Docker';
            expectedState = action === 'start' ? 'started' : 'stopped';
        } else if (kind === 'vm' && (action === 'domain-start' || action === 'domain-stop')) {
            target = 'VMs';
            expectedState = action === 'domain-start' ? 'started' : 'stopped';
        } else {
            return;
        }

        if (!confirmStopAction(item, control)) return;

        const csrf = typeof window.csrf_token === 'string' ? window.csrf_token : '';
        if (!csrf) {
            showQuickActionError('Security token unavailable.');
            return;
        }

        const transition = beginTransition(target, control, expectedState);
        invalidateProviderObservation(target);
        publishSync('begin', target, control, expectedState);

        button.replaceWith(createTransitionIndicator(transition, item));

        try {
            if (kind === 'docker') {
                const data = await jqAjax({
                    url: '/plugins/dynamix.docker.manager/include/Events.php',
                    type: 'POST',
                    dataType: 'json',
                    timeout: ACTION_TIMEOUT_MS,
                    jndLifecycleOwned: true,
                    data: {
                        action,
                        container: id,
                        csrf_token: csrf,
                    },
                });

                if (data?.success !== true) {
                    throw new Error(typeof data?.success === 'string' ? data.success : 'Docker action failed.');
                }
            } else {
                const data = await jqAjax({
                    url: '/plugins/dynamix.vm.manager/include/VMajax.php',
                    type: 'POST',
                    dataType: 'json',
                    timeout: ACTION_TIMEOUT_MS,
                    jndLifecycleOwned: true,
                    data: {
                        action,
                        uuid: id,
                        csrf_token: csrf,
                    },
                });

                if (data?.error) {
                    throw new Error(String(data.error));
                }
            }

            markTransitionActionComplete(control);
            cacheInvalidate(target, {bumpEpoch: false});
            publishSync('refresh', target, control, expectedState);

            await new Promise(resolve => setTimeout(resolve, NATIVE_LIFECYCLE_REFRESH_DELAY_MS));
            refreshStockPage(target);

            if (state.activeTarget === target) {
                try {
                    const latest = await getProviderItems(target, {forceFresh: true});
                    if (state.activeTarget === target) {
                        renderMenu(latest);
                        requestAnimationFrame(positionOverlay);
                    }
                } catch (_) {}

                if (hasTransitionsFor(target)) {
                    scheduleTransitionPolling();
                }
            }
        } catch (error) {
            clearTransition(control);
            publishSync('cancel', target, control, expectedState);
            console.warn(`[JND] ${kind} quick action failed:`, error);
            showQuickActionError(error?.message || error);

            cacheInvalidate(target, {bumpEpoch: false});
            stopTransitionPolling();

            try {
                const latest = await getProviderItems(target, {forceFresh: true});
                if (state.activeTarget === target) {
                    renderMenu(latest);
                    requestAnimationFrame(positionOverlay);
                }
            } catch (_) {}
        }
    }

    function parseInertHtml(html) {
        const doc = document.implementation.createHTMLDocument('');
        const template = doc.createElement('template');
        template.innerHTML = String(html || '');
        return template.content;
    }

    function parseUDBrowseItems(html) {
        const seen = new Set();
        const children = [];
        const fragment = parseInertHtml(html);

        for (const a of fragment.querySelectorAll('a[href*="/Browse?dir="]')) {
            const href = sameOriginPath(a.getAttribute('href'));
            const label = cleanText(a.textContent);

            if (!href || !label || seen.has(href)) continue;
            if (!href.startsWith('/Main/Browse?dir=')) continue;

            seen.add(href);
            children.push({
                type: 'item',
                label,
                href,
                icon: {kind: 'class', className: 'fa fa-folder-o'},
                indent: 1,
            });
        }

        return children;
    }

    async function loadUDItems() {
        if (!BOOT.features?.ud) return [];

        /*
         * The public behavior is intentionally mounted-only for Unassigned
         * Devices remote shares. Use the lightweight provider backed by the
         * current mount table instead of asking Unassigned Devices to build
         * its full HTML content payload.
         */
        const remotes = await loadDynamicProvider('ud_remotes');
        return Array.isArray(remotes) ? remotes : [];
    }

    function composeMainItems() {
        const items = cloneData(BOOT.providers.Main || []);
        if (state.udLoaded && state.udItems.length) {
            items.push(...cloneData(state.udItems));
        }
        return items;
    }

    function mainUDIsFresh() {
        return state.udLoaded && (Date.now() - state.udCacheTime <= DYNAMIC_CACHE_MS);
    }

    function refreshMainUD() {
        if (!BOOT.features?.ud) return Promise.resolve([]);
        if (state.udInFlight) return state.udInFlight;

        state.udInFlight = loadUDItems()
            .then(items => {
                const remotes = cloneData(Array.isArray(items) ? items : []);
                cachePut('ud_remotes', remotes);
                state.udItems = remotes.length ? [
                    {type: 'separator'},
                    {type: 'heading', label: 'Unassigned Devices'},
                    ...remotes,
                ] : [];
                state.udLoaded = true;
                state.udCacheTime = Date.now();

                /*
                 * If MAIN is still visible, supplement it in place. The user
                 * never has to close/reopen the dropdown to see the refreshed
                 * Unassigned Devices state.
                 */
                if (state.activeTarget === 'Main' && state.activeNavItem?.isConnected) {
                    renderMenu(composeMainItems());
                    requestAnimationFrame(positionOverlay);
                }

                return cloneData(state.udItems);
            })
            .catch(error => {
                console.warn('[JND] Unassigned Devices read failed:', error);
                return cloneData(state.udItems);
            })
            .finally(() => {
                state.udInFlight = null;
            });

        return state.udInFlight;
    }

    function restoreMainUDCache() {
        if (!BOOT.features?.ud || state.udLoaded) return;

        const hit = cachePeek('ud_remotes');
        if (!hit) return;

        const remotes = cloneData(hit.items);
        state.udItems = remotes.length ? [
            {type: 'separator'},
            {type: 'heading', label: 'Unassigned Devices'},
            ...remotes,
        ] : [];
        state.udLoaded = true;
        state.udCacheTime = hit.time;
    }

    function ensureMainUDFresh() {
        if (!BOOT.features?.ud) return;
        restoreMainUDCache();
        if (mainUDIsFresh()) return;
        void refreshMainUD();
    }

    function sortItemsForTarget(target, items) {
        if (SORT_MODE !== 'alphabetical' || !SORTABLE_TARGETS.has(target) || !Array.isArray(items)) {
            return items;
        }

        if (items.some(item => (item?.type || 'item') !== 'item')) return items;

        return [...items].sort((left, right) =>
            LABEL_COLLATOR.compare(cleanText(left?.label), cleanText(right?.label))
        );
    }

    async function loadDynamicProvider(provider) {
        const data = await jqAjax({
            url: `/plugins/nav.dropdown.menus/provider.php?provider=${encodeURIComponent(provider)}`,
            type: 'GET',
            dataType: 'json',
        });

        if (!data?.ok || !Array.isArray(data.items)) {
            throw new Error(`${provider} provider returned an invalid response`);
        }

        return data.items;
    }

    async function getProviderItems(target, options = {}) {
        /*
         * MAIN's array/pool/boot inventory is already present in BOOT. Return
         * it immediately and refresh optional Unassigned Devices content in
         * the background instead of holding the entire menu behind AJAX.
         */
        if (target === 'Main') {
            ensureMainUDFresh();
            return composeMainItems();
        }

        const dynamic = ['Docker', 'VMs'].includes(target);
        const maxAge = dynamic ? DYNAMIC_CACHE_MS : STATIC_CACHE_MS;
        const forceFresh = options?.forceFresh === true;

        if (!forceFresh) {
            const cached = cacheGet(target, maxAge);
            if (cached) {
                reconcileTransitions(target, cached);
                return cached;
            }

            if (dynamic) {
                const stale = cachePeek(target);
                if (stale) {
                    reconcileTransitions(target, stale.items);
                    void refreshProvider(target, {renderIfOpen: true}).catch(error => {
                        console.warn(`[JND] ${target} stale revalidation failed:`, error);
                    });
                    return stale.items;
                }
            }
        }

        if (!dynamic) {
            const items = sortItemsForTarget(target, cloneData(BOOT.providers[target] || []));
            reconcileTransitions(target, items);
            return cachePut(target, items);
        }

        if (forceFresh && state.inFlight.has(target)) {
            try {
                await state.inFlight.get(target);
            } catch (_) {
                // A failed older observation must not prevent this authoritative refresh.
            }
        }

        return refreshProvider(target, {renderIfOpen: false});
    }

    function refreshProvider(target, options = {}) {
        const existing = state.inFlight.get(target);
        if (existing) return existing;

        const provider = target === 'Docker' ? 'docker' : (target === 'VMs' ? 'vms' : '');
        if (!provider) return Promise.reject(new Error(`Unsupported dynamic provider: ${target}`));

        const observationEpoch = providerEpoch(target);
        const request = loadDynamicProvider(provider)
            .then(items => {
                const normalized = sortItemsForTarget(target, items);
                reconcileTransitions(target, normalized);

                /*
                 * A lifecycle action can begin while this request is in flight.
                 * Never allow an observation that started before that boundary to
                 * repopulate cache or overwrite the visible post-action state.
                 */
                if (providerEpoch(target) !== observationEpoch) {
                    return cloneData(normalized);
                }

                cachePut(target, normalized);

                if (options.renderIfOpen && state.activeTarget === target && state.activeNavItem?.isConnected) {
                    renderMenu(normalized);
                    requestAnimationFrame(positionOverlay);
                }

                return cloneData(normalized);
            })
            .finally(() => {
                if (state.inFlight.get(target) === request) state.inFlight.delete(target);
            });

        state.inFlight.set(target, request);
        return request;
    }

    async function warmDynamicProviders() {
        if (state.warmQueueStarted) return;
        state.warmQueueStarted = true;

        for (const target of ['Docker', 'VMs']) {
            if (!TARGETS.includes(target)) continue;
            const hit = cachePeek(target);
            if (hit && Date.now() - hit.time <= DYNAMIC_CACHE_MS) continue;

            try {
                await refreshProvider(target, {renderIfOpen: true});
            } catch (error) {
                console.warn(`[JND] ${target} background warm-up failed:`, error);
            }
        }
    }

    function revalidateStaleDynamicProviders() {
        for (const target of ['Docker', 'VMs']) {
            if (!TARGETS.includes(target)) continue;
            const hit = cachePeek(target);
            if (hit && Date.now() - hit.time <= DYNAMIC_CACHE_MS) continue;
            void refreshProvider(target, {renderIfOpen: true}).catch(error => {
                console.warn(`[JND] ${target} lifecycle revalidation failed:`, error);
            });
        }
    }

    function parseAjaxData(data) {
        if (!data) return {};
        if (typeof data === 'object' && !Array.isArray(data)) return data;
        if (typeof data !== 'string') return {};
        const out = {};
        for (const [key, value] of new URLSearchParams(data)) out[key] = value;
        return out;
    }

    function nativeMutationTarget(url, data) {
        let path = '';
        try { path = new URL(String(url || ''), window.location.origin).pathname; }
        catch (_) { return ''; }
        const action = cleanText(parseAjaxData(data).action);
        if (!action) return '';
        if (path.endsWith('/plugins/dynamix.docker.manager/include/Events.php') &&
            ['start', 'stop', 'pause', 'resume', 'restart'].includes(action)) return 'Docker';
        if (path.endsWith('/plugins/dynamix.docker.manager/include/ContainerManager.php') &&
            ['start', 'stop', 'pause', 'unpause'].includes(action)) return 'Docker';
        if (path.endsWith('/plugins/dynamix.vm.manager/include/VMajax.php') &&
            ['domain-start', 'domain-stop', 'domain-pause', 'domain-resume', 'domain-restart',
             'domain-pmsuspend', 'domain-pmwakeup', 'domain-destroy',
             'domain-start-console', 'domain-start-consoleRV'].includes(action)) return 'VMs';
        if (path.endsWith('/plugins/dynamix.vm.manager/include/VMManager.php') &&
            ['start', 'stop'].includes(action)) return 'VMs';
        return '';
    }

    function nativeTransitionDescriptor(url, data) {
        let path = '';
        try { path = new URL(String(url || ''), window.location.origin).pathname; }
        catch (_) { return null; }

        const parsed = parseAjaxData(data);
        const action = cleanText(parsed.action);

        if (path.endsWith('/plugins/dynamix.docker.manager/include/Events.php') &&
            ['start', 'stop'].includes(action)) {
            const control = {kind: 'docker', id: cleanText(parsed.container), action};
            const expectedState = expectedStateForControl(control);
            return validSyncControl('Docker', control, expectedState)
                ? {target: 'Docker', control, expectedState}
                : null;
        }

        if (path.endsWith('/plugins/dynamix.vm.manager/include/VMajax.php') &&
            ['domain-start', 'domain-stop'].includes(action)) {
            const control = {kind: 'vm', id: cleanText(parsed.uuid), action};
            const expectedState = expectedStateForControl(control);
            return validSyncControl('VMs', control, expectedState)
                ? {target: 'VMs', control, expectedState}
                : null;
        }

        return null;
    }

    function nativeMutationApplicationFailed(xhr, descriptor) {
        if (!descriptor) return false;
        let response = xhr?.responseJSON;
        if ((!response || typeof response !== 'object') && typeof xhr?.responseText === 'string') {
            try { response = JSON.parse(xhr.responseText); } catch (_) { response = null; }
        }
        if (!response || typeof response !== 'object') return false;
        if (descriptor.target === 'Docker' && Object.prototype.hasOwnProperty.call(response, 'success')) {
            return response.success !== true;
        }
        if (descriptor.target === 'VMs') {
            return Boolean(response.error);
        }
        return false;
    }

    function nativeListTarget(url) {
        let path = '';
        try { path = new URL(String(url || ''), window.location.origin).pathname; }
        catch (_) { return ''; }
        if (path.endsWith('/plugins/dynamix.docker.manager/include/DockerContainers.php')) return 'Docker';
        if (path.endsWith('/plugins/dynamix.vm.manager/include/VMMachines.php')) return 'VMs';
        return '';
    }

    function attachNativeLifecycleObserver() {
        if (!window.jQuery?.fn?.jquery) return;
        const pagePath = window.location.pathname.replace(/\/+$/, '') || '/';
        const pageTarget = pagePath === '/Docker' ? 'Docker' : (pagePath === '/VMs' ? 'VMs' : '');
        if (!pageTarget || !TARGETS.includes(pageTarget)) return;

        window.jQuery(document).on('ajaxSend.jndNativeLifecycle', (_event, _xhr, settings) => {
            if (settings?.jndLifecycleOwned === true) return;

            const mutationTarget = nativeMutationTarget(settings?.url, settings?.data);
            if (!mutationTarget || mutationTarget !== pageTarget) return;

            const descriptor = nativeTransitionDescriptor(settings?.url, settings?.data);
            if (!descriptor || descriptor.target !== pageTarget) return;

            const snapshot = state.activeTarget === pageTarget ? cachePeek(pageTarget)?.items : null;
            beginTransition(descriptor.target, descriptor.control, descriptor.expectedState);
            invalidateProviderObservation(descriptor.target);
            publishSync('begin', descriptor.target, descriptor.control, descriptor.expectedState);
            renderTransitionSnapshot(descriptor.target, snapshot);
        });

        window.jQuery(document).on('ajaxComplete.jndNativeLifecycle', (_event, xhr, settings) => {
            if (settings?.jndLifecycleOwned === true) return;

            const status = Number(xhr?.status || 0);
            const mutationTarget = nativeMutationTarget(settings?.url, settings?.data);

            if (mutationTarget) {
                if (mutationTarget !== pageTarget) return;
                const descriptor = nativeTransitionDescriptor(settings?.url, settings?.data);
                const failed =
                    status < 200 ||
                    status >= 400 ||
                    nativeMutationApplicationFailed(xhr, descriptor);

                if (failed) {
                    if (descriptor) {
                        clearTransition(descriptor.control);
                        publishSync('cancel', descriptor.target, descriptor.control, descriptor.expectedState);
                    }
                    invalidateProviderObservation(mutationTarget);
                    refreshOpenProvider(mutationTarget, 'native failure');
                } else if (descriptor) {
                    markTransitionActionComplete(descriptor.control);
                    publishSync('refresh', descriptor.target, descriptor.control, descriptor.expectedState);
                }
                return;
            }

            if (status < 200 || status >= 400) return;
            const listTarget = nativeListTarget(settings?.url);
            if (!listTarget || listTarget !== pageTarget) return;
            invalidateProviderObservation(listTarget);
            refreshOpenProvider(listTarget, 'native lifecycle');
        });
    }

    function attachBrowserLifecycleRevalidation() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') revalidateStaleDynamicProviders();
        });
        window.addEventListener('online', revalidateStaleDynamicProviders);
        window.addEventListener('pageshow', event => {
            if (event.persisted === true) revalidateStaleDynamicProviders();
        });
    }

    function attachNav(anchor, target) {
        const navItem = anchor.parentElement;
        if (!navItem || navItem.dataset.jndAttached === '1') return;

        navItem.dataset.jndAttached = '1';
        navItem.addEventListener('mouseenter', () => scheduleOpen(target, navItem));
        navItem.addEventListener('mouseleave', scheduleClose);

        anchor.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                openMenu(target, navItem, true);
            }
        });
    }

    function attach() {
        if (state.attached) return false;

        if (!TARGETS.length) {
            state.attached = true;
            console.info(`[JND] Navigation dropdowns ${BUILD}: all dropdowns are disabled; stock Unraid navigation remains unchanged.`);
            return true;
        }

        const navTile = compatibilityCheck();
        if (!navTile) return false;

        let count = 0;

        for (const target of TARGETS) {
            const anchor = navTile.querySelector(`.nav-item > a[href="/${target}"]`);
            if (!anchor) continue;

            const navItem = anchor.parentElement;
            if (!navItem?.classList.contains('nav-item') || anchor.parentElement !== navItem) {
                console.warn(`[JND] ${target} stock anchor structure is incompatible; that dropdown was skipped.`);
                continue;
            }

            attachNav(anchor, target);
            count++;
        }

        if (!count) return false;

        ensureOverlay();
        attachCrossTabSync();
        attachNativeLifecycleObserver();
        attachBrowserLifecycleRevalidation();
        state.attached = true;

        /*
         * Prewarm MAIN's optional Unassigned Devices supplement immediately
         * after the stock navigation is attached. This is fire-and-forget:
         * page rendering and menu interaction never wait for it.
         */
        if (TARGETS.includes('Main')) {
            restoreMainUDCache();
            if (!mainUDIsFresh()) void refreshMainUD();
        }
        setTimeout(() => { void warmDynamicProviders(); }, 0);

        document.addEventListener('pointerdown', (event) => {
            if (!state.overlay?.classList.contains('jnd-visible')) return;
            if (state.overlay.contains(event.target) || state.activeNavItem?.contains(event.target)) return;
            closeMenu();
        }, true);

        window.addEventListener('resize', positionOverlay, {passive: true});
        window.addEventListener('scroll', positionOverlay, {passive: true, capture: true});

        console.info(`[JND] Navigation dropdowns ${BUILD} active on Unraid ${BOOT.unraidVersion || 'unknown'}.`);
        return true;
    }

    function boot() {

        if (attach()) return;

        const observer = new MutationObserver(() => {
            if (attach()) observer.disconnect();
        });

        observer.observe(document.documentElement, {childList: true, subtree: true});
        setTimeout(() => observer.disconnect(), 8000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, {once: true});
    } else {
        boot();
    }
})();
