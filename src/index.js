import './styles.css';

let currentDrag = null;
const LS_KEY = 'svg-desk-state';
const SVG_NS = 'http://www.w3.org/2000/svg';

class AppRoot extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
      <div class="app">
        <div class="toolbar">
          <button id="create">Создать</button>
          <button id="save">Сохранить</button>
          <button id="reset">Сбросить</button>
        </div>

        <buffer-zone class="zone">
          <div class="zone__header">Буферная зона <small>(перетащите фигуру сюда; Ctrl/Alt — быстрый способ)</small></div>
          <div class="zone__content"></div>
        </buffer-zone>

        <work-zone class="zone">
          <div class="zone__header">Рабочая зона (сетка, зум, панорамирование)</div>
          <div class="zone__content"><div class="work-content" part="work"></div></div>
        </work-zone>
      </div>
    `;

        const buffer = this.querySelector('buffer-zone');
        const work = this.querySelector('work-zone');

        const on = (id, fn) => this.querySelector('#' + id).addEventListener('click', fn);

        on('create', async () => {
            const { randInt, makePreviewPolygonData } = await import('./utils/geometry.js');
            const count = randInt(5, 20);
            buffer.addPolygons(Array.from({ length: count }, makePreviewPolygonData));
        });

        this.addEventListener('ready', () => {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            try {
                const state = JSON.parse(raw);
                if (state.buffer?.length) buffer.addPolygons(state.buffer);
                if (state.viewBox) work.setViewBox(state.viewBox);
                if (state.work?.length) work.loadShapes(state.work);
            } catch (e) {
                console.error(e);
            }
        }, { once: true });

        on('save', () => {
            const state = { buffer: buffer.serialize(), work: work.serialize(), viewBox: work.getViewBox() };
            localStorage.setItem(LS_KEY, JSON.stringify(state));
            alert('Сохранено!');
        });

        on('reset', () => {
            localStorage.removeItem(LS_KEY);
            buffer.clear();
            work.clear();
            alert('Очищено!');
        });
    }
}
customElements.define('app-root', AppRoot);

class BufferZone extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; height:100%; }
        .wrap { position:relative; width:100%; height:100%; }
        .list { padding:8px; display:flex; flex-wrap:wrap; align-content:flex-start; }
        :host([data-drop]) { outline: 2px dashed var(--accent); outline-offset: -2px; }

      </style>
      <div class="wrap">
        <slot name="header"></slot>
        <div class="list" id="list"></div>
      </div>
    `;
        this._list = this.shadowRoot.getElementById('list');

        const header = this.querySelector('.zone__header');
        if (header) header.setAttribute('slot', 'header');
        const content = this.querySelector('.zone__content');
        if (content) content.remove();

        this._list.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });

        this._list.addEventListener('drop', (e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData('application/x-polygon');
            if (!raw) return;
            const data = JSON.parse(raw);
            const pts = data.canonicalPoints || data.points;
            this.addPolygons([{ points: pts, viewBox: '0 0 100 70', fill: data.fill, stroke: data.stroke }]);
            if (currentDrag) { currentDrag.remove(); currentDrag = null; }
        });
    }

    addPolygons(datas) {
        datas.forEach(d => {
            const el = document.createElement('polygon-item');
            el.setAttribute('points', d.points);
            el.setAttribute('viewbox', d.viewBox);
            el.setAttribute('fill', d.fill || '#c2185b');
            el.setAttribute('stroke', d.stroke || '#8a1143');
            this._list.appendChild(el);
        });
    }

    serialize() {
        return [...this._list.querySelectorAll('polygon-item')].map(el => ({
            points: el.getAttribute('points'),
            viewBox: el.getAttribute('viewbox') || '0 0 100 70',
            fill: el.getAttribute('fill'),
            stroke: el.getAttribute('stroke')
        }));
    }

    clear() { this._list.innerHTML = ''; }
}
customElements.define('buffer-zone', BufferZone);

class WorkZone extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }

    connectedCallback() {
        const style = document.createElement('style');
        style.textContent = `
        :host { display:block; height:100%; position:relative; touch-action:none; }
        svg { display:block; background:#1d1d1d; width:100%; height:100%; user-select:none; }
        .shape polygon { fill:#c2185b; stroke:#8a1143; stroke-width:0.8; vector-effect:non-scaling-stroke; cursor:grab; }
        .dragging, .panning { cursor:grabbing !important; }
        text {
            fill: #bfbfbf;
            stroke: none;
            paint-order: normal;
            text-rendering: geometricPrecision; /* помогает сглаживанию */
            pointer-events: none; /* подписи не перехватывают мышь */
        }
        .hud, .hud * { pointer-events: none; } /* чтобы не перекрывал drag */
    `;
        this.shadowRoot.appendChild(style);

        this._zoom = 1;
        this._vb = { x: 0, y: 0, w: 100, h: 60 };

        const svg = document.createElementNS(SVG_NS, 'svg');
        const setVB = () => svg.setAttribute('viewBox', `${this._vb.x} ${this._vb.y} ${this._vb.w} ${this._vb.h}`);
        setVB();

        this._grid = document.createElementNS(SVG_NS, 'g');   // сетка (линии)
        this._layer = document.createElementNS(SVG_NS, 'g');   // фигуры
        this._hud = document.createElementNS(SVG_NS, 'g');   // оси, подписи, ленты
        this._hud.setAttribute('class', 'hud');
        svg.append(this._grid, this._layer, this._hud);
        this.shadowRoot.appendChild(svg);
        this._svg = svg;

        let pan = null;
        let panActive = false;
        let animId = null;
        let targetVB = { ...this._vb };

        const applyVB = () => { setVB(); this._drawGrid(); };

        const kickPanAnim = () => {
            if (animId) return;
            const alpha = 0.25;
            const eps = 0.05;

            const step = () => {
                animId = null;
                const dx = targetVB.x - this._vb.x;
                const dy = targetVB.y - this._vb.y;

                if (panActive || Math.abs(dx) > eps || Math.abs(dy) > eps) {
                    this._vb.x += dx * alpha;
                    this._vb.y += dy * alpha;
                    applyVB();
                    animId = requestAnimationFrame(step);
                } else {
                    this._vb = { ...targetVB };
                    applyVB();
                }
            };

            animId = requestAnimationFrame(step);
        };

        const updateAspect = () => {
            const r = svg.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            const aspect = r.width / r.height;
            const cx = this._vb.x + this._vb.w / 2;
            const newW = this._vb.h * aspect;
            this._vb.x = cx - newW / 2;
            this._vb.w = newW;
            applyVB();
            targetVB = { ...this._vb };
        };
        new ResizeObserver(updateAspect).observe(this.shadowRoot.host);

        // зум
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const k = (e.deltaY < 0) ? 0.9 : 1.1;
            const cur = this._toView(e.clientX, e.clientY);

            this._zoom = this._clamp((this._zoom || 1) * k, 0.5, 2); // только для текста

            const minW = 100, maxW = 300;
            const newW = this._clamp(this._vb.w * k, minW, maxW);
            const s = newW / this._vb.w;
            const newH = this._vb.h * s;

            const rx = (cur.x - this._vb.x) / this._vb.w;
            const ry = (cur.y - this._vb.y) / this._vb.h;
            this._vb = { x: cur.x - rx * newW, y: cur.y - ry * newH, w: newW, h: newH };

            applyVB();

            targetVB = { ...this._vb };

        }, { passive: false });

        // панорамирование
        svg.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.composedPath().some(n => n.tagName === 'polygon')) return;
            e.preventDefault();

            const wpp = this._vb.w / this._svg.clientWidth;
            const hpp = this._vb.h / this._svg.clientHeight;

            pan = { vx: this._vb.x, vy: this._vb.y, sx: e.clientX, sy: e.clientY, wpp, hpp };
            panActive = true;
            svg.classList.add('panning');
            kickPanAnim();
        });

        window.addEventListener('mousemove', (e) => {
            if (!pan) return;
            targetVB.x = pan.vx - (e.clientX - pan.sx) * pan.wpp;
            targetVB.y = pan.vy - (e.clientY - pan.sy) * pan.hpp;
            kickPanAnim();
        });

        window.addEventListener('mouseup', () => {
            if (!pan) return;
            pan = null;
            panActive = false;
            svg.classList.remove('panning');
            kickPanAnim();
        });



        // drop из буфера в работу
        svg.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
        svg.addEventListener('drop', (e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData('application/x-polygon');
            if (!raw) return;

            const data = JSON.parse(raw);
            const cursor = this._toView(e.clientX, e.clientY);

            const canonStr = data.canonicalPoints || data.points;
            const canon = this._parsePoints(canonStr);
            const bbox = this._bbox(canon);
            const targetW = 18;
            const s = bbox.width > 0 ? targetW / bbox.width : 1;
            const c = this._centroid(canon);
            const scaled = canon.map(([x, y]) => [(x - c.x) * s, (y - c.y) * s]);
            const pos = scaled.map(([x, y]) => [x + cursor.x, y + cursor.y]);
            const inside = this._nudgeInside(pos);

            const g = this._makeShape(inside, data.fill, data.stroke, canonStr);
            this._layer.appendChild(g);

            if (currentDrag && currentDrag !== g) { currentDrag.remove(); currentDrag = null; }
        });

        this._drawGrid();
        this._getVB = () => ({ ...this._vb });
        this._setVB = (vb) => { this._vb = { ...vb }; setVB(); this._drawGrid(); };
        queueMicrotask(() => this.dispatchEvent(new CustomEvent('ready', { bubbles: true })));
    }

    // ——— grid ———
    _drawGrid() {
        const grid = this._grid;

        if (!this._hud) {
            this._hud = document.createElementNS(SVG_NS, 'g');
            this._hud.setAttribute('class', 'hud');
            this._hud.setAttribute('style', 'pointer-events:none');
            this._svg.appendChild(this._hud);
        }
        const hud = this._hud;

        grid.innerHTML = '';
        hud.innerHTML = '';

        const worldPerPx = this._vb.w / this._svg.clientWidth;
        const strokeW = worldPerPx * 4;

        const snapX = (xWorld) => {
            const screenX = (xWorld - this._vb.x) / worldPerPx;
            const aligned = Math.round(screenX) + 0.5;
            return this._vb.x + aligned * worldPerPx;
        };
        const snapY = (yWorld) => {
            const screenY = (yWorld - this._vb.y) / worldPerPx;
            const aligned = Math.round(screenY) + 0.5;
            return this._vb.y + aligned * worldPerPx;
        };

        const nice = (v) => {
            const p = 10 ** Math.floor(Math.log10(v));
            const m = v / p;
            return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
        };

        const approxStep = 40 * worldPerPx;
        let step = Math.max(1e-6, nice(approxStep));

        const maxLines = 120;
        while ((this._vb.w / step) > maxLines) step *= 2;
        while ((this._vb.h / step) > maxLines) step *= 2;

        const pxPerStep = step / worldPerPx;
        const showEvery = Math.max(1, Math.round(55 / pxPerStep));
        const fontWorld = 14 * worldPerPx;

        const vbLeft = snapX(this._vb.x);
        const vbTop = snapY(this._vb.y);
        const vbRight = snapX(this._vb.x + this._vb.w);
        const vbBottom = snapY(this._vb.y + this._vb.h);

        const bandH = 28 * worldPerPx; // низ
        const bandW = 40 * worldPerPx; // лево

        const xAxisY = snapY(this._vb.y + this._vb.h - bandH);
        const yAxisX = snapX(this._vb.x + bandW);

        const leftBandW = yAxisX - vbLeft;
        const bottomBandH = vbBottom - xAxisY;

        const makeRect = (x, y, w, h, fill) => {
            const r = document.createElementNS(SVG_NS, 'rect');
            r.setAttribute('x', x); r.setAttribute('y', y);
            r.setAttribute('width', w); r.setAttribute('height', h);
            r.setAttribute('fill', fill);
            return r;
        };

        hud.appendChild(makeRect(vbLeft, xAxisY, this._vb.w, bottomBandH, '#2a2a2a'));
        hud.appendChild(makeRect(vbLeft, vbTop, leftBandW, this._vb.h, '#2a2a2a'));

        const gridLeft = yAxisX;
        const gridRight = vbRight;
        const gridTop = vbTop;
        const gridBottom = xAxisY;

        if (gridRight <= gridLeft || gridBottom <= gridTop) return;

        const kStartX = Math.ceil((this._vb.x - 1e-9) / step);
        const kEndX = Math.floor((this._vb.x + this._vb.w + 1e-9) / step);

        const minGapPxX = 36;
        let lastXpx = -Infinity;

        for (let k = kStartX; k <= kEndX; k++) {
            const x = k * step;
            const xs = snapX(x);
            if (xs < gridLeft || xs > gridRight) continue;

            // линии сетки — в grid
            const l = this._line(xs, gridTop, xs, gridBottom, strokeW);
            l.setAttribute('stroke-linecap', 'butt');
            grid.appendChild(l);

            if ((k % showEvery) === 0) {
                const curPx = (xs - vbLeft) / worldPerPx;
                if (curPx - lastXpx >= minGapPxX) {
                    // подписи — в HUD
                    const tx = document.createElementNS(SVG_NS, 'text');
                    tx.setAttribute('x', xs);
                    tx.setAttribute('y', xAxisY + bottomBandH / 2);
                    tx.setAttribute('text-anchor', 'middle');
                    tx.setAttribute('dominant-baseline', 'middle');
                    tx.setAttribute('font-size', fontWorld);
                    tx.setAttribute('stroke', 'none');
                    tx.setAttribute('paint-order', 'normal');
                    tx.setAttribute('text-rendering', 'geometricPrecision');
                    tx.textContent = this._formatTick(k * step, step);
                    hud.appendChild(tx);
                    lastXpx = curPx;
                }
            }
        }

        //  Y
        const kStartY = Math.ceil((this._vb.y - 1e-9) / step);
        const kEndY = Math.floor((this._vb.y + this._vb.h + 1e-9) / step);

        const minGapPxY = 24;
        let lastYpx = -Infinity;

        for (let k = kStartY; k <= kEndY; k++) {
            const y = k * step;
            const ys = snapY(y);
            if (ys < gridTop || ys > gridBottom) continue;

            const l = this._line(gridLeft, ys, gridRight, ys, strokeW);
            l.setAttribute('stroke-linecap', 'butt');
            grid.appendChild(l);

            if ((k % showEvery) === 0) {
                const curPx = (ys - vbTop) / worldPerPx;
                if (curPx - lastYpx >= minGapPxY) {
                    const ty = document.createElementNS(SVG_NS, 'text');
                    ty.setAttribute('x', vbLeft + leftBandW / 2);
                    ty.setAttribute('y', ys);
                    ty.setAttribute('text-anchor', 'middle');
                    ty.setAttribute('dominant-baseline', 'middle');
                    ty.setAttribute('font-size', fontWorld);
                    ty.setAttribute('stroke', 'none');
                    ty.setAttribute('paint-order', 'normal');
                    ty.setAttribute('text-rendering', 'geometricPrecision');
                    ty.textContent = this._formatTick(k * step, step);
                    hud.appendChild(ty);
                    lastYpx = curPx;
                }
            }
        }

        const axisW = worldPerPx * 6;

        const xAxis = this._line(gridLeft, xAxisY, gridRight, xAxisY, axisW);
        xAxis.setAttribute('stroke', '#444');
        xAxis.setAttribute('stroke-linecap', 'butt');
        hud.appendChild(xAxis); // ось поверх фигур

        const yAxis = this._line(yAxisX, gridTop, yAxisX, gridBottom, axisW);
        yAxis.setAttribute('stroke', '#444');
        yAxis.setAttribute('stroke-linecap', 'butt');
        hud.appendChild(yAxis); // ось поверх фигур
    }




    _clientToWorld(x, y) {
        const p = this._svg.createSVGPoint();
        p.x = x; p.y = y;
        return p.matrixTransform(this._svg.getScreenCTM().inverse());
    }

    _formatTick(value, step) {
        const decimals = Math.max(0, -Math.floor(Math.log10(step)));
        const snapped = Math.round(value / step) * step;
        return snapped.toFixed(decimals);
    }

    // ——— shapes ———
    _makeShape(points, fill, stroke, canonicalStr) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.classList.add('shape');

        const poly = document.createElementNS(SVG_NS, 'polygon');
        poly.setAttribute('points', this._pointsAttr(points));
        poly.setAttribute('fill', fill || '#c2185b');
        poly.setAttribute('stroke', stroke || '#8a1143');
        g.appendChild(poly);

        g.dataset.canonical = canonicalStr;
        g._tx = 0; g._ty = 0;

        let drag = null;
        let crossMode = false;

        const bufferEl = () => document.querySelector('buffer-zone');
        const inBuffer = (clientX, clientY) => {
            const el = bufferEl(); if (!el) return false;
            const r = el.getBoundingClientRect();
            return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
        };

        const onDown = (ev) => {
            if (ev.ctrlKey || ev.altKey) {
                ev.preventDefault();
                this._startLiftDrag(ev, g, poly);
                return;
            }
            if (ev.button !== 0) return;
            ev.preventDefault();
            poly.setPointerCapture(ev.pointerId);
            const v = this._toView(ev.clientX, ev.clientY);
            drag = { x: v.x, y: v.y, tx: g._tx || 0, ty: g._ty || 0, pid: ev.pointerId };
            poly.classList.add('dragging');
        };

        const onMove = (ev) => {
            if (!drag) return;
            const buf = document.querySelector('buffer-zone');
            if (buf) {
                const r = buf.getBoundingClientRect();
                const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
                if (inside) {
                    poly.classList.remove('dragging');
                    poly.releasePointerCapture?.(drag.pid);
                    drag = null;
                    this._startLiftDrag(ev, g, poly);
                    return;
                }
            }

            const v = this._toView(ev.clientX, ev.clientY);
            g._tx = drag.tx + (v.x - drag.x);
            g._ty = drag.ty + (v.y - drag.y);
            this._clampTranslate(g);
        };

        const onUp = (ev) => {
            if (drag) {
                drag = null;
                poly.classList.remove('dragging');
                poly.releasePointerCapture?.(ev.pointerId);
            }
        };

        poly.addEventListener('pointerdown', onDown);
        poly.addEventListener('pointermove', onMove);
        poly.addEventListener('pointerup', onUp);
        poly.addEventListener('pointercancel', onUp);

        return g;
    }

    _startLiftDrag(startEv, g, poly) {
        const buffer = document.querySelector('buffer-zone');
        if (!buffer) return;

        const vbStr = this._svg.getAttribute('viewBox');
        this._showOverlay(vbStr);
        this._placeOverlayOverWork();

        const placeholder = document.createComment('g-placeholder');
        if (!g._placeholder) g._placeholder = placeholder;
        else g._placeholder.replaceWith(placeholder);
        this._layer.replaceChild(placeholder, g);
        this._overlaySvg.appendChild(g);

        poly.releasePointerCapture?.(startEv.pointerId);
        poly.classList.add('dragging');

        // центр текущего полигона
        const ptsLocal = this._parsePoints(poly.getAttribute('points'));
        const cLocal = this._centroid(ptsLocal);

        const markBuffer = (inside) => {
            if (inside) buffer.setAttribute('data-drop', '');
            else buffer.removeAttribute('data-drop');
        };

        const onMove = (e) => {
            this._placeOverlayOverWork();

            // ставим центр полигона под курсор
            const cur = this._clientToOverlay(e.clientX, e.clientY);
            g._tx = cur.x - cLocal.x;
            g._ty = cur.y - cLocal.y;
            g.setAttribute('transform', `translate(${g._tx},${g._ty})`);

            // подсветка буфера
            const r = buffer.getBoundingClientRect();
            const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            markBuffer(inside);
        };

        const onUp = (e) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);

            const r = buffer.getBoundingClientRect();
            const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            markBuffer(false);
            poly.classList.remove('dragging');

            if (inside) {
                const ptsStr = g.dataset.canonical || poly.getAttribute('points');
                buffer.addPolygons([{ points: ptsStr, viewBox: '0 0 100 70', fill: poly.getAttribute('fill'), stroke: poly.getAttribute('stroke') }]);
                g.remove();
            } else {
                this._layer.replaceChild(g, g._placeholder);
                delete g._placeholder;
                this._clampTranslate(g);
            }

            this._hideOverlayIfEmpty();
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    }



    _startNativeDnD(startEv, g, poly) {
        // временный прокси под курсором
        const proxy = document.createElement('div');
        proxy.setAttribute('draggable', 'true');
        Object.assign(proxy.style, {
            position: 'fixed', left: (startEv.clientX - 1) + 'px', top: (startEv.clientY - 1) + 'px',
            width: '2px', height: '2px', zIndex: '2147483647', pointerEvents: 'auto', background: 'transparent'
        });
        document.body.appendChild(proxy);

        const dragSvg = document.createElementNS(SVG_NS, 'svg');
        dragSvg.setAttribute('width', '200');
        dragSvg.setAttribute('height', '120');
        dragSvg.setAttribute('viewBox', this._svg.getAttribute('viewBox'));
        const p2 = document.createElementNS(SVG_NS, 'polygon');

        const tx = g._tx || 0, ty = g._ty || 0;
        const pts = this._parsePoints(poly.getAttribute('points')).map(([x, y]) => [x + tx, y + ty]);
        p2.setAttribute('points', this._pointsAttr(pts));
        p2.setAttribute('fill', poly.getAttribute('fill'));
        p2.setAttribute('stroke', poly.getAttribute('stroke'));
        p2.setAttribute('stroke-width', '0.8');
        dragSvg.appendChild(p2);
        Object.assign(dragSvg.style, { position: 'fixed', left: '-1000px', top: '-1000px', pointerEvents: 'none' });

        const cleanup = () => { proxy.remove(); dragSvg.remove(); };

        proxy.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-polygon', JSON.stringify({
                canonicalPoints: g.dataset.canonical || poly.getAttribute('points'),
                fill: poly.getAttribute('fill'),
                stroke: poly.getAttribute('stroke')
            }));
            e.dataTransfer.effectAllowed = 'move';

            document.body.appendChild(dragSvg);
            e.dataTransfer.setDragImage(dragSvg, 100, 60);

            currentDrag = g;
        }, { once: true });

        proxy.addEventListener('dragend', () => {
            cleanup();
            currentDrag = null;
        }, { once: true });

        window.addEventListener('pointerup', () => { cleanup(); }, { once: true });

    }


    // utils
    _toView(x, y) { const p = this._svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(this._svg.getScreenCTM().inverse()); }
    _line(x1, y1, x2, y2, w) {
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', x1); ln.setAttribute('y1', y1);
        ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
        ln.setAttribute('stroke', '#333');
        ln.setAttribute('stroke-width', w);
        ln.setAttribute('vector-effect', 'non-scaling-stroke');
        return ln;
    } _parsePoints(a) { return a.trim().split(/\s+/).map(p => p.split(',').map(Number)); }
    _pointsAttr(arr) { return arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '); }
    _centroid(pts) { const n = pts.length; const s = pts.reduce((a, [x, y]) => (a.x += x, a.y += y, a), { x: 0, y: 0 }); return { x: s.x / n, y: s.y / n }; }
    _bbox(pts) { let miX = Infinity, miY = Infinity, maX = -Infinity, maY = -Infinity; for (const [x, y] of pts) { if (x < miX) miX = x; if (x > maX) maX = x; if (y < miY) miY = y; if (y > maY) maY = y; } return { minX: miX, minY: miY, maxX: maX, maxY: maY, width: maX - miX, height: maY - miY }; }
    _clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

    // overlay helpers
    _ensureOverlay() {
        if (this._overlaySvg) return this._overlaySvg;

        const div = document.createElement('div');
        Object.assign(div.style, {
            position: 'fixed',
            left: '0', top: '0', width: '100vw', height: '100vh',
            pointerEvents: 'none',
            zIndex: '2147483647',
            display: 'none'
        });

        const svg = document.createElementNS(SVG_NS, 'svg');
        Object.assign(svg.style, {
            position: 'absolute',
            left: '0px', top: '0px',
            width: '0px', height: '0px',
            overflow: 'visible'
        });

        div.appendChild(svg);
        document.body.appendChild(div);

        this._overlayDiv = div;
        this._overlaySvg = svg;
        return svg;
    }

    _placeOverlayOverWork() {
        const ov = this._ensureOverlay();
        const r = this._svg.getBoundingClientRect();
        ov.style.left = `${r.left}px`;
        ov.style.top = `${r.top}px`;
        ov.style.width = `${r.width}px`;
        ov.style.height = `${r.height}px`;
    }

    _showOverlay(viewBoxStr) {
        this._ensureOverlay();
        this._overlayDiv.style.display = 'block';
        this._placeOverlayOverWork();
        this._overlaySvg.setAttribute('viewBox', viewBoxStr);
    }

    _hideOverlayIfEmpty() {
        if (this._overlaySvg && this._overlaySvg.childNodes.length === 0) {
            this._overlayDiv.style.display = 'none';
        }
    }

    _clientToOverlay(x, y) {
        const p = this._overlaySvg.createSVGPoint();
        p.x = x; p.y = y;
        return p.matrixTransform(this._overlaySvg.getScreenCTM().inverse());
    }


    _clampTranslate(g) {
        const poly = g.querySelector('polygon');
        const bb = this._bbox(this._parsePoints(poly.getAttribute('points')));
        const minTx = this._vb.x - bb.minX;
        const maxTx = this._vb.x + this._vb.w - bb.maxX;
        const minTy = this._vb.y - bb.minY;
        const maxTy = this._vb.y + this._vb.h - bb.maxY;
        g._tx = this._clamp(g._tx || 0, minTx, maxTx);
        g._ty = this._clamp(g._ty || 0, minTy, maxTy);
        g.setAttribute('transform', `translate(${g._tx},${g._ty})`);
    }

    _nudgeInside(points) {
        const bb = this._bbox(points);
        let dx = 0, dy = 0;
        if (bb.minX < this._vb.x) dx += this._vb.x - bb.minX;
        if (bb.maxX > this._vb.x + this._vb.w) dx += (this._vb.x + this._vb.w) - bb.maxX;
        if (bb.minY < this._vb.y) dy += this._vb.y - bb.minY;
        if (bb.maxY > this._vb.y + this._vb.h) dy += (this._vb.y + this._vb.h) - bb.maxY;
        return dx || dy ? points.map(([x, y]) => [x + dx, y + dy]) : points;
    }

    serialize() {
        const out = [];
        this._layer.querySelectorAll('.shape').forEach(g => {
            const p = g.querySelector('polygon');
            out.push({
                points: p.getAttribute('points'),
                fill: p.getAttribute('fill'),
                stroke: p.getAttribute('stroke'),
                tx: g._tx || 0,
                ty: g._ty || 0,
                canonicalPoints: g.dataset.canonical
            });
        });
        return out;
    }
    loadShapes(items) {
        this.clear();
        items.forEach(it => {
            const pts = this._parsePoints(it.points);
            const g = this._makeShape(pts, it.fill, it.stroke, it.canonicalPoints || it.points);
            g._tx = it.tx || 0; g._ty = it.ty || 0;
            g.setAttribute('transform', `translate(${g._tx},${g._ty})`);
            this._layer.appendChild(g);
        });
    }
    clear() { this._layer.innerHTML = ''; }
    getViewBox() { return this._getVB(); }
    setViewBox(vb) { this._setVB(vb); }
}
customElements.define('work-zone', WorkZone);

class PolygonItem extends HTMLElement {
    static get observedAttributes() { return ['points', 'viewbox', 'fill', 'stroke']; }
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    get points() { return this.getAttribute('points') || ''; }
    get viewBox() { return this.getAttribute('viewbox') || '0 0 100 70'; }
    get fill() { return this.getAttribute('fill') || '#c2185b'; }
    get stroke() { return this.getAttribute('stroke') || '#8a1143'; }

    connectedCallback() { this._render(); this._setupDnD(); }
    attributeChangedCallback() { this._render(); }

    _render() {
        this.shadowRoot.innerHTML = `
      <style>
        :host { display:inline-block; margin:6px; cursor:grab; }
        svg { display:block; width:120px; height:84px; }
        polygon { vector-effect:non-scaling-stroke; stroke-width:2; }
      </style>
      <svg viewBox="${this.viewBox}">
        <polygon points="${this.points}" fill="${this.fill}" stroke="${this.stroke}"></polygon>
      </svg>
    `;
    }

    _setupDnD() {
        this.setAttribute('draggable', 'true');
        this.addEventListener('dragstart', (e) => {
            currentDrag = this;
            const svg = this.shadowRoot.querySelector('svg');
            const r = svg.getBoundingClientRect();
            const clone = svg.cloneNode(true);
            clone.setAttribute('width', Math.round(r.width));
            clone.setAttribute('height', Math.round(r.height));
            Object.assign(clone.style, { position: 'fixed', pointerEvents: 'none', top: '-1000px', left: '-1000px' });
            document.body.appendChild(clone);
            e.dataTransfer.setDragImage(clone, r.width / 2, r.height / 2);
            this._dragPreview = clone;

            e.dataTransfer.setData('application/x-polygon', JSON.stringify({
                canonicalPoints: this.points, fill: this.fill, stroke: this.stroke
            }));
            e.dataTransfer.effectAllowed = 'move';
        });

        this.addEventListener('dragend', () => {
            if (this._dragPreview) { this._dragPreview.remove(); this._dragPreview = null; }
            currentDrag = null;
        });
    }
}
customElements.define('polygon-item', PolygonItem);
