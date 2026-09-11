/*
 * Navigation Dropdown Menus
 * Parent Unraid navigation anchors are never replaced.
 */
(() => {
    'use strict';

    const BUILD = '1.0.0';
    const BOOT = window.JND_BOOTSTRAP;
    const ALL_TARGETS = ['Main', 'Shares', 'Users', 'Settings', 'Plugins', 'Docker', 'VMs', 'Tools'];
    const TARGETS = ALL_TARGETS.filter(target => BOOT?.dropdowns?.[target] !== false);
    const SORTABLE_TARGETS = new Set(['Shares', 'Users', 'Docker', 'VMs']);
    const STATIC_CACHE_MS = 60000;
    const DYNAMIC_CACHE_MS = 12000;
    const REQUEST_TIMEOUT_MS = 6000;
    const ACTION_TIMEOUT_MS = 30000;
    const TRANSITION_POLL_MS = 850;
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
        udItems: [],
        udLoaded: false,
        udCacheTime: 0,
        udInFlight: null,
        transitions: new Map(),
        transitionTimer: null,
        transitionPollInFlight: false,
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
        overlay.setAttribute('role', 'menu');
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
            expectedState: cleanText(expectedState).toLowerCase(),
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
            if (controlKey(item.control) === key) return item;

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
            if (currentState === transition.expectedState) {
                state.transitions.delete(key);
            }
        }
    }

    function createTransitionSpinner() {
        const spinner = document.createElement('i');
        spinner.className = 'fa fa-refresh fa-spin jnd-state-icon';
        spinner.setAttribute('aria-hidden', 'true');
        return spinner;
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
            window.open(href, '_blank', 'scrollbars=yes,resizable=yes');
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

        const transition = getTransition(control);
        if (transition) {
            const busy = document.createElement('button');
            busy.type = 'button';
            busy.className = 'jnd-status-control';
            busy.disabled = true;
            busy.title = `Transitioning: ${cleanText(item.label)}`;
            busy.setAttribute('aria-label', busy.title);
            busy.setAttribute('aria-busy', 'true');
            busy.appendChild(createTransitionSpinner());
            return busy;
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
            a.setAttribute('role', 'menuitem');
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
        a.setAttribute('role', 'menuitem');
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
                    trigger.setAttribute('role', 'menuitem');
                    trigger.setAttribute('aria-haspopup', 'menu');
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
                sub.setAttribute('role', 'menu');

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
        if (!state.overlay || !state.activeNavItem) return;

        const rect = state.activeNavItem.getBoundingClientRect();
        const overlay = state.overlay;
        const gap = 4;
        const margin = 8;
        const sidebar = document.documentElement.classList.contains('Theme--sidebar');

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

            if (top + height > window.innerHeight - margin &&
                rect.top - height - gap >= margin) {
                top = rect.top - height - gap;
            }
        }

        left = Math.max(margin, left);
        top = Math.max(margin, top);

        overlay.style.left = `${Math.round(left)}px`;
        overlay.style.top = `${Math.round(top)}px`;

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
            const forceFresh = target === 'Docker' || target === 'VMs';
            items = await getProviderItems(target, {forceFresh});
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
                state.overlay.querySelector('a[role="menuitem"], .jnd-submenu-trigger[tabindex="0"]')?.focus();
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
            state.overlay.querySelectorAll('a[role="menuitem"], .jnd-submenu-trigger[tabindex="0"]')
        ).filter(el => el.offsetParent !== null);

        if (!focusable.length) return;

        event.preventDefault();
        const current = Math.max(0, focusable.indexOf(document.activeElement));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        focusable[(current + delta + focusable.length) % focusable.length].focus();
    }

    function cacheGet(key, maxAge) {
        const hit = state.cache.get(key);
        if (!hit) return null;

        if (Date.now() - hit.time > maxAge) {
            state.cache.delete(key);
            return null;
        }

        return cloneData(hit.items);
    }

    function cachePut(key, items) {
        state.cache.set(key, {time: Date.now(), items: cloneData(items)});
        return items;
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

        beginTransition(target, control, expectedState);

        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.replaceChildren(createTransitionSpinner());

        if (state.activeTarget === target) {
            scheduleTransitionPolling(300);
        }

        try {
            if (kind === 'docker') {
                const data = await jqAjax({
                    url: '/plugins/dynamix.docker.manager/include/Events.php',
                    type: 'POST',
                    dataType: 'json',
                    timeout: ACTION_TIMEOUT_MS,
                    data: {
                        action,
                        container: id,
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
                    data: {
                        action,
                        uuid: id,
                    },
                });

                if (data?.error) {
                    throw new Error(String(data.error));
                }
            }

            state.cache.delete(target);

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
            console.warn(`[JND] ${kind} quick action failed:`, error);
            showQuickActionError(error?.message || error);

            state.cache.delete(target);
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
        const items = Array.isArray(remotes) ? remotes : [];

        if (!items.length) return [];

        return [
            {type: 'separator'},
            {type: 'heading', label: 'Unassigned Devices'},
            ...items,
        ];
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
                state.udItems = cloneData(Array.isArray(items) ? items : []);
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

    function ensureMainUDFresh() {
        if (!BOOT.features?.ud || mainUDIsFresh()) return;
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
        }

        let items;

        if (target === 'Docker') {
            items = await loadDynamicProvider('docker');
        } else if (target === 'VMs') {
            items = await loadDynamicProvider('vms');
        } else {
            items = cloneData(BOOT.providers[target] || []);
        }

        items = sortItemsForTarget(target, items);
        reconcileTransitions(target, items);
        return cachePut(target, items);
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
        state.attached = true;

        /*
         * Prewarm MAIN's optional Unassigned Devices supplement immediately
         * after the stock navigation is attached. This is fire-and-forget:
         * page rendering and menu interaction never wait for it.
         */
        if (TARGETS.includes('Main')) ensureMainUDFresh();

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
