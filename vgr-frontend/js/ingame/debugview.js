(function() {
    const emptyState = {
        characterName: null,
        profileId: null,
        actorFormId: null,
        playerRefrId: null,
        raceId: null,
        lastTeleportTarget: null,

        currentAnimationEvent: null,
        previousAnimationEvent: null,
        isDodgingCMF: null,
        DirectionalCycleMoveset: null,
        isBlocking: null,
        isSneaking: null,
        isSprinting: null,
        isInAir: null,
        isWeaponDrawn: null,
        rightHandType: null,
        leftHandType: null,
        isAttacking: null,
        isPowerAttack: null,
        lastAnimationPayload: null,

        pos: null,
        rot: null,
        worldOrCell: null,
        isInterior: null,
        worldspace: null,
        exteriorGrid: null,

        subscribedRefsCount: null,
        recentlyStreamedInRefs: null,
        recentlyStreamedOutRefs: null,
        nearbyRefsAccepted: null,
        nearbyRefsSkipped: null,

        grid: null,
        acceptedRefsCount: null,
        skippedRefsCount: null,
        loadDurationMs: null,
        deferredSubscriptionUpdatesCount: null,

        cellFormId: null,
        winningCellPlugin: null,
        xcll: null,
        ltmp: null,
        ltmpInheritanceFlags: null,
        imgs: null,
        clmt: null,
        xclr: null,
        xclm: null,
        xclw: null,
        effectiveSources: {
            ambient: null,
            fog: null,
            directional: null,
            imageSpace: null,
            climate: null,
            music: null,
            water: null
        }
    };

    let debugState = mergeState(null);

    const panelDefs = [
        {
            id: 'playerState',
            icon: 'P',
            title: 'Player State',
            keys: [
                ['characterName', 'Name'],
                ['profileId', 'Profile ID'],
                ['actorFormId', 'Actor FormID'],
                ['playerRefrId', 'Player RefrID'],
                ['raceId', 'Race ID'],
                ['lastTeleportTarget', 'Last Teleport']
            ]
        },
        {
            id: 'animationCombat',
            icon: 'A',
            title: 'Animation / Combat',
            keys: [
                ['currentAnimationEvent', 'Current Anim'],
                ['previousAnimationEvent', 'Previous Anim'],
                ['isDodgingCMF', 'Dodging (CMF)'],
                ['DirectionalCycleMoveset', 'Cycle Moveset'],
                ['isBlocking', 'Blocking'],
                ['isSneaking', 'Sneaking'],
                ['isSprinting', 'Sprinting'],
                ['isInAir', 'In Air'],
                ['isWeaponDrawn', 'Weapon Drawn'],
                ['rightHandType', 'Right Hand'],
                ['leftHandType', 'Left Hand'],
                ['isAttacking', 'Attacking'],
                ['isPowerAttack', 'Power Attack'],
                ['lastAnimationPayload', 'Last Anim Payload']
            ]
        },
        {
            id: 'position',
            icon: 'X',
            title: 'Position',
            keys: [
                ['pos', 'Position'],
                ['rot', 'Rotation'],
                ['worldOrCell', 'World / Cell'],
                ['isInterior', 'Interior'],
                ['worldspace', 'Worldspace'],
                ['exteriorGrid', 'Exterior Grid']
            ]
        },
        {
            id: 'streaming',
            icon: 'S',
            title: 'Streaming / Subscription',
            keys: [
                ['subscribedRefsCount', 'Subscribed Ref Count'],
                ['recentlyStreamedInRefs', 'Streamed In'],
                ['recentlyStreamedOutRefs', 'Streamed Out'],
                ['nearbyRefsAccepted', 'Nearby Accepted'],
                ['nearbyRefsSkipped', 'Nearby Skipped']
            ]
        },
        {
            id: 'worldChunk',
            icon: 'C',
            title: 'World Chunk Loading',
            keys: [
                ['grid', 'Grid'],
                ['acceptedRefsCount', 'Accepted Refs'],
                ['skippedRefsCount', 'Skipped Refs'],
                ['loadDurationMs', 'Load Duration (ms)'],
                ['deferredSubscriptionUpdatesCount', 'Deferred Updates']
            ]
        },
        {
            id: 'cellEnv',
            icon: 'E',
            title: 'Cell / Environment',
            keys: [
                ['cellFormId', 'Cell FormID'],
                ['winningCellPlugin', 'Winning Plugin'],
                ['xcll', 'XCLL'],
                ['ltmp', 'LTMP'],
                ['ltmpInheritanceFlags', 'LTMP Flags'],
                ['imgs', 'IMGS'],
                ['clmt', 'CLMT'],
                ['xclr', 'XCLR'],
                ['xclm', 'XCLM'],
                ['xclw', 'XCLW']
            ],
            hasNested: true,
            nestedKey: 'effectiveSources',
            nestedLabel: 'Effective Sources'
        }
    ];

    const panelStates = {};

    function mergeState(next) {
        const source = next && typeof next === 'object' ? next : {};
        return {
            ...emptyState,
            ...source,
            effectiveSources: {
                ...emptyState.effectiveSources,
                ...(source.effectiveSources && typeof source.effectiveSources === 'object' ? source.effectiveSources : {})
            }
        };
    }

    function formatValue(val) {
        if (val === undefined || val === null) return { text: 'null', cls: 'nullish' };
        if (typeof val === 'boolean') {
            return {
                text: val ? 'true' : 'false',
                cls: val ? 'boolean-true' : 'boolean-false'
            };
        }
        if (typeof val === 'string' && val.trim() === '') return { text: 'empty', cls: 'nullish' };
        return { text: String(val), cls: '' };
    }

    function renderPanel(def, index) {
        const panel = document.createElement('div');
        panel.className = 'debug-panel';
        panel.dataset.index = index;

        const collapsed = panelStates[index] !== undefined ? panelStates[index] : true;
        panelStates[index] = collapsed;

        const head = document.createElement('div');
        head.className = 'debug-panel-head';
        head.innerHTML = `
            <span class="icon">${def.icon || '-'}</span>
            <span class="title">${def.title}</span>
            <span class="count-badge">${def.keys ? def.keys.length : 0}</span>
            <span class="collapse-icon${collapsed ? ' collapsed' : ''}">v</span>
        `;
        panel.appendChild(head);

        const body = document.createElement('div');
        body.className = 'debug-panel-body' + (collapsed ? ' collapsed' : '');
        body.id = `debug-panel-body-${index}`;

        if (def.keys) {
            def.keys.forEach(([key, label]) => {
                const raw = debugState[key];
                const { text, cls } = formatValue(raw);
                const kv = document.createElement('div');
                kv.className = 'kv';
                kv.innerHTML = `
                    <span class="key">${label}</span>
                    <span class="value ${cls}">${text}</span>
                `;
                body.appendChild(kv);
            });
        }

        if (def.hasNested && def.nestedKey) {
            const nestedData = debugState[def.nestedKey];
            const wrapper = document.createElement('div');
            wrapper.className = 'nested-group';

            const header = document.createElement('div');
            header.className = 'nested-group-header';
            header.textContent = def.nestedLabel || def.nestedKey;
            wrapper.appendChild(header);

            if (nestedData && typeof nestedData === 'object') {
                for (const [subKey, subVal] of Object.entries(nestedData)) {
                    const { text, cls } = formatValue(subVal);
                    const kv = document.createElement('div');
                    kv.className = 'kv';
                    kv.innerHTML = `
                        <span class="key">${subKey}</span>
                        <span class="value ${cls}">${text}</span>
                    `;
                    wrapper.appendChild(kv);
                }
            }

            body.appendChild(wrapper);
        }

        panel.appendChild(body);

        const collapseIcon = head.querySelector('.collapse-icon');
        head.addEventListener('click', function(e) {
            e.stopPropagation();
            const isCollapsed = body.classList.toggle('collapsed');
            panelStates[index] = isCollapsed;
            collapseIcon.classList.toggle('collapsed', isCollapsed);
            updateToggleAllButton();
        });

        return panel;
    }

    function updateToggleAllButton() {
        const btn = document.getElementById('toggleAllBtn');
        if (!btn) return;

        const values = Object.values(panelStates);
        const allCollapsed = values.length > 0 && values.every(Boolean);
        const allExpanded = values.length > 0 && values.every((state) => !state);

        if (allCollapsed) {
            btn.textContent = 'Expand All';
        } else if (allExpanded) {
            btn.textContent = 'Collapse All';
        } else {
            btn.textContent = 'Toggle All';
        }
    }

    function render() {
        const grid = document.getElementById('debug-panelGrid');
        if (!grid) return;

        grid.innerHTML = '';

        panelDefs.forEach((def, index) => {
            const panelEl = renderPanel(def, index);
            grid.appendChild(panelEl);
        });

        let footer = document.querySelector('.footer-timestamp');
        if (!footer) {
            footer = document.createElement('div');
            footer.className = 'footer-timestamp';
            grid.parentNode.appendChild(footer);
        }
        footer.textContent = `Updated ${new Date().toLocaleTimeString()}`;

        updateToggleAllButton();
    }

    window.vgrSetDebugViewState = function(nextState) {
        debugState = mergeState(nextState);
        render();
    };

    const debugContainer = document.querySelector('.debug-container');

    window.addEventListener('vgr:ui_manager:open:debugview', () => {
        debugContainer.classList.add('visible');
    });

    window.addEventListener('vgr:ui_manager:close:debugview', () => {
        debugContainer.classList.remove('visible');
    });

    const toggleAllBtn = document.getElementById('toggleAllBtn');
    if (toggleAllBtn) {
        toggleAllBtn.addEventListener('click', function() {
            const allCollapsed = Object.values(panelStates).every(Boolean);
            const shouldCollapse = allCollapsed;

            panelDefs.forEach((_, index) => {
                panelStates[index] = !shouldCollapse;
            });

            render();
        });
    }

    render();
})();
