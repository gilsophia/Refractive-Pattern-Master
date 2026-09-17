/* 折光纹核心库: 几何生成 + 图层构造 + 母版输出。
 * 由 generate_refraction.jsx (job.json 模式) 与 generate_refraction_gui.jsx (手动分配模式) 通过 $.evalFile 共用。
 * 不包含 UI 与 JSON 解析, 只暴露 ZG.generate / ZG.collectLayers 等。 */
var ZG = {};
var ZG_CORE_VERSION = '2026-09-16h';   // 便于在 zg_progress.txt 里确认实际运行的版本

(function () {
    var c = charIDToTypeID, s = stringIDToTypeID;

    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }
    function pad3(n) { return (n < 10 ? '00' : (n < 100 ? '0' : '')) + n; }
    function leafName(p) { var a = String(p).split('/'); return a[a.length - 1]; }
    function sanitize(v) { v = String(v).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_'); if (v.length > 80) v = v.substring(0, 80); return v || 'layer'; }
    function stamp() { var d = new Date(); function p(n) { return n < 10 ? '0' + n : String(n); } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
    function num(v, d) { return (typeof v === 'number') ? v : d; }
    function toNum(v) {
        if (typeof v === 'number') return v;
        if (v && typeof v.value === 'number') return v.value;
        return parseFloat(String(v));
    }
    /* PathPointInfo 写入按 point；DOM PathPoint 读取跟随标尺单位。
     * 内部统一 pixel，取样固定 PIXELS，写入时才转换为 point。 */
    // DOM PathPoint reads follow rulerUnits; getRegionSubs explicitly uses PIXELS.
    function ptToPx(doc, v) { return v && v.as ? v.as('px') : toNum(v); }
    function pxToPt(doc, v) { return toNum(v) * 72 / doc.resolution; }
    function subsPxToPt(doc, source) {
        var out = [];
        for (var i = 0; i < source.length; i++) {
            var raw = source[i], pts = [];
            for (var j = 0; j < raw.entireSubPath.length; j++) {
                var p = raw.entireSubPath[j], q = new PathPointInfo();
                q.kind = p.kind;
                q.anchor = [pxToPt(doc, p.anchor[0]), pxToPt(doc, p.anchor[1])];
                q.leftDirection = [pxToPt(doc, p.leftDirection[0]), pxToPt(doc, p.leftDirection[1])];
                q.rightDirection = [pxToPt(doc, p.rightDirection[0]), pxToPt(doc, p.rightDirection[1])];
                pts.push(q);
            }
            var si = new SubPathInfo();
            si.closed = raw.closed; si.operation = raw.operation; si.entireSubPath = pts; out.push(si);
        }
        return out;
    }

    /* ---------------- Photoshop 路径硬限制与点数压缩 ----------------
     * 实测 Photoshop 2020 (21.2): pathItems.add() 单条路径最多 1000 个子路径、
     * 每个子路径最多 1000 个锚点, 超限直接抛「非法参数」。
     * 生成前必须把每个子路径压到上限内, 否则整次生成会在中途中断。 */
    var MAX_SUBPATHS = 900, MAX_SUB_POINTS = 1000;

    function ptDist(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
    function rdpMark(pts, i0, i1, eps, keep) {
        var stack = [[i0, i1]];
        while (stack.length) {
            var seg = stack.pop(), a = seg[0], b = seg[1];
            if (b - a <= 1) continue;
            var ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
            var len = Math.sqrt(dx * dx + dy * dy), maxD = -1, maxI = -1;
            for (var i = a + 1; i < b; i++) {
                var d = (len < 1e-9) ? ptDist(pts[i], pts[a]) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
                if (d > maxD) { maxD = d; maxI = i; }
            }
            if (maxD > eps && maxI > a) { keep[maxI] = 1; stack.push([a, maxI]); stack.push([maxI, b]); }
        }
    }
    function rdpOpen(pts, eps) {
        var n = pts.length;
        if (n <= 2) return pts.slice(0);
        var keep = new Array(n); keep[0] = 1; keep[n - 1] = 1;
        rdpMark(pts, 0, n - 1, eps, keep);
        var out = [];
        for (var i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
        return out;
    }
    function rdpClosed(poly, eps) {
        var n = poly.length, i;
        if (n <= 3) return poly.slice(0);
        var far = 0, best = -1;
        for (i = 1; i < n; i++) { var d = ptDist(poly[i], poly[0]); if (d > best) { best = d; far = i; } }
        var far2 = 0; best = -1;
        for (i = 0; i < n; i++) { var d2 = ptDist(poly[i], poly[far]); if (d2 > best) { best = d2; far2 = i; } }
        var a = Math.min(far, far2), b = Math.max(far, far2);
        var r1 = rdpOpen(poly.slice(a, b + 1), eps);
        var r2 = rdpOpen(poly.slice(b).concat(poly.slice(0, a + 1)), eps);
        var out = r1.slice(0);
        for (i = 1; i < r2.length - 1; i++) out.push(r2[i]);
        if (out.length < 3) out = poly.slice(0, 3);
        return out;
    }
    // 把折线/闭合多边形压到 maxPts 点以内, 容差自适应(先 0.05px, 不够再放宽)
    function limitPoly(poly, maxPts) {
        if (poly.length <= maxPts) return poly;
        var eps = 0.05, out = poly, guard = 0;
        while (out.length > maxPts && guard < 24) { out = rdpClosed(poly, eps); eps *= 1.5; guard++; }
        if (out.length > maxPts) {
            var stride = Math.ceil(out.length / maxPts), tmp = [];
            for (var i = 0; i < out.length; i += stride) tmp.push(out[i]);
            out = tmp;
        }
        return out;
    }
    function normalizePolys(polys) {
        var out = [];
        for (var i = 0; i < polys.length; i++) {
            var p = polys[i];
            if (!p || p.length < 3) continue;
            if (p.length > MAX_SUB_POINTS) p = limitPoly(p, MAX_SUB_POINTS);
            if (p.length >= 3) out.push(p);
        }
        return out;
    }
    // 把带曲线的子路径展平成折线(压缩前用), 每段取 5 个采样点
    function flattenSubPoly(sub) {
        var src = sub.entireSubPath, n = src.length, poly = [];
        for (var i = 0; i < n; i++) {
            var a = src[i];
            poly.push([a.anchor[0], a.anchor[1]]);
            if (!sub.closed && i === n - 1) break;
            var nb = src[(i + 1) % n], c1 = a.rightDirection, c2 = nb.leftDirection, p1 = nb.anchor;
            for (var k = 1; k < 6; k++) {
                var t = k / 6, mt = 1 - t;
                poly.push([
                    mt * mt * mt * a.anchor[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0],
                    mt * mt * mt * a.anchor[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1]
                ]);
            }
        }
        return poly;
    }
    function limitSub(sub) {
        if (sub.entireSubPath.length <= MAX_SUB_POINTS) return sub;
        var poly = limitPoly(flattenSubPoly(sub), MAX_SUB_POINTS), pts = [];
        for (var i = 0; i < poly.length; i++) {
            var pi = new PathPointInfo();
            pi.kind = PointKind.CORNERPOINT;
            pi.anchor = poly[i]; pi.leftDirection = poly[i]; pi.rightDirection = poly[i];
            pts.push(pi);
        }
        var si = new SubPathInfo();
        si.closed = sub.closed; si.operation = sub.operation; si.entireSubPath = pts;
        return si;
    }
    /* 子路径的近似面积(px², 有符号: 正负代表环绕方向, 即外框/洞)与周长。
     * 只按锚点算, 忽略贝塞尔控制点 —— 用于筛碎片足够, 不做几何交付。 */
    function subSignedArea(sub) {
        var pts = sub.entireSubPath, n = pts.length, s = 0;
        if (n < 3) return 0;
        for (var i = 0; i < n; i++) {
            var a = pts[i].anchor, b = pts[(i + 1) % n].anchor;
            s += a[0] * b[1] - b[0] * a[1];
        }
        return s / 2;
    }
    function subPerimeter(sub) {
        var pts = sub.entireSubPath, n = pts.length, p = 0;
        for (var i = 0; i < n; i++) {
            var a = pts[i].anchor, b = pts[(i + 1) % n].anchor;
            p += Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        }
        return p;
    }
    /* 把子路径压进 Photoshop 单条路径上限(1000 条子路径)。
     * 按 |面积| 从大到小保留: 外框的面积必然大于它内部的洞, 所以按面积取前 N 条
     * 不会出现「洞留下、外框被丢」把蒙版填反的错。
     * 旧写法按节点数排序, 在大区域上是灾难: 4 点的大块被丢、5 点的碎屑留下。
     * 实测 007 母版里 卡面 / background / bg-woods / inner / human / queen 等 11 个组的
     * 蒙版子路径数都恰好 900(截断上限), 蒙版碎成噪点。 */
    function limitSubs(subs) {
        var out = [], i;
        for (i = 0; i < subs.length; i++) out.push(limitSub(subs[i]));
        if (out.length <= MAX_SUBPATHS) return out;
        var arr = [];
        for (i = 0; i < out.length; i++) arr.push({ s: out[i], a: Math.abs(subSignedArea(out[i])) });
        arr.sort(function (x, y) { return y.a - x.a; });
        var kept = [];
        for (i = 0; i < MAX_SUBPATHS; i++) kept.push(arr[i].s);
        return kept;
    }
    /* 蒙版裁切边界简化(只在子路径数超过 Photoshop 单条路径上限时才动手, 不超上限就原样保留):
     * 先丢掉放不下「线宽+密隙」一个重复单元的碎屑(面积 < 单元², 或平均宽度 2A/P < 单元) ——
     * 这类碎片是布尔相减与路径容差留下的毛边, 留着只会让蒙版变成噪点、让 Photoshop 卡在建路径上;
     * 若还超上限, 再按 |面积| 保留最大的 MAX_SUBPATHS 条。
     * 面积与平均宽度都按「包含关系」单调(外框 > 洞), 不会错配岛/洞。 */
    function simplifyMaskSubs(subs, cfg) {
        var out = [], i;
        if (subs.length <= MAX_SUBPATHS) {
            for (i = 0; i < subs.length; i++) out.push(limitSub(subs[i]));
            return { subs: out, dropped: 0, areaKept: 0, areaAll: 0 };
        }
        var unit = cfg.linePx + cfg.gapDensePx;
        var minArea = unit * unit, minWidth = unit;
        var kept = [], dropped = 0, areaKept = 0, areaAll = 0;
        for (i = 0; i < subs.length; i++) {
            var a = Math.abs(subSignedArea(subs[i])), per = subPerimeter(subs[i]);
            areaAll += a;
            if (a < minArea || (per > 1e-6 && 2 * a / per < minWidth)) { dropped++; continue; }
            kept.push({ s: subs[i], a: a });
            areaKept += a;
        }
        if (kept.length > MAX_SUBPATHS) {
            kept.sort(function (x, y) { return y.a - x.a; });
            for (i = MAX_SUBPATHS; i < kept.length; i++) { dropped++; areaKept -= kept[i].a; }
            kept = kept.slice(0, MAX_SUBPATHS);
        }
        out = [];
        for (i = 0; i < kept.length; i++) out.push(limitSub(kept[i].s));
        return { subs: out, dropped: dropped, areaKept: areaKept, areaAll: areaAll };
    }

    /* ---------------- DOM 辅助 ---------------- */
    function loadTransparency(doc, layer) {
        app.activeDocument = doc;
        var desc = new ActionDescriptor(), ref = new ActionReference();
        ref.putProperty(c('Chnl'), c('fsel'));
        desc.putReference(c('null'), ref);
        var ref1 = new ActionReference();
        ref1.putEnumerated(c('Chnl'), c('Chnl'), c('Trsp'));
        ref1.putIdentifier(c('Lyr '), layer.id);
        desc.putReference(c('T   '), ref1);
        executeAction(c('setd'), desc, DialogModes.NO);
    }
    function subInfosFromPath(path, doc) {
        var out = [];
        for (var i = 0; i < path.subPathItems.length; i++) {
            var sp = path.subPathItems[i], pts = [];
            for (var j = 0; j < sp.pathPoints.length; j++) {
                var p = sp.pathPoints[j], pi = new PathPointInfo();
                pi.kind = p.kind;
                pi.anchor = [ptToPx(doc, p.anchor[0]), ptToPx(doc, p.anchor[1])];
                pi.leftDirection = [ptToPx(doc, p.leftDirection[0]), ptToPx(doc, p.leftDirection[1])];
                pi.rightDirection = [ptToPx(doc, p.rightDirection[0]), ptToPx(doc, p.rightDirection[1])];
                pts.push(pi);
            }
            var si = new SubPathInfo();
            si.closed = sp.closed; si.operation = sp.operation; si.entireSubPath = pts;
            out.push(si);
        }
        return out;
    }
    /* ---------------- 工作路径快速读取 (ActionManager) ----------------
     * DOM 逐点访问是 O(n^2): 实测同一工作路径 1108 点, DOM 读 74 秒, AM 读 4 毫秒。
     * 因此优先用 ActionManager 一次取回整条路径; 任何一步不符合预期就返回 null,
     * 由调用方回退到 DOM 读取(结果不变, 只是慢)。 */
    var pathReadInfo = '未测';   // 记录本次运行实际使用的读取方式
    function readUnitVal(doc, p, key) {
        var k = c(key);
        var t = p.getType(k);
        if (t === DescValueType.DOUBLETYPE) return p.getDouble(k);
        if (t !== DescValueType.UNITDOUBLE) return null;
        var v = p.getUnitDoubleValue(k), u = '';
        try { u = typeIDToStringID(p.getUnitDoubleType(k)); } catch (e) { u = ''; }
        if (u === 'pixelsUnit' || u === '') return v;
        var res = doc.resolution;
        if (u === 'pointsUnit') return v * res / 72;
        if (u === 'picasUnit') return v * res / 6;
        if (u === 'inchesUnit') return v * res;
        if (u === 'cmUnit') return v * res / 2.54;
        if (u === 'mmUnit') return v * res / 25.4;
        return null;
    }
    function readPointFast(doc, p) {
        var x = readUnitVal(doc, p, 'Hrzn'), y = readUnitVal(doc, p, 'Vrtc');
        if (x === null || y === null || !isFinite(x) || !isFinite(y)) return null;
        return [x, y];
    }
    function pointKindFrom(a, f, b) {
        var v1x = a[0] - f[0], v1y = a[1] - f[1], v2x = a[0] - b[0], v2y = a[1] - b[1];
        var l1 = Math.sqrt(v1x * v1x + v1y * v1y), l2 = Math.sqrt(v2x * v2x + v2y * v2y);
        if (l1 < 1e-6 || l2 < 1e-6) return PointKind.CORNERPOINT;
        return ((v1x * v2x + v1y * v2y) / (l1 * l2) < -0.999) ? PointKind.SMOOTHPOINT : PointKind.CORNERPOINT;
    }
    function shapeOpFrom(str) {
        var v = String(str).toLowerCase();
        if (v.indexOf('subtract') >= 0) return ShapeOperation.SHAPESUBTRACT;
        if (v.indexOf('intersect') >= 0) return ShapeOperation.SHAPEINTERSECT;
        if (v.indexOf('xor') >= 0 || v.indexOf('exclude') >= 0 || v.indexOf('difference') >= 0) return ShapeOperation.SHAPEXOR;
        return ShapeOperation.SHAPEADD;
    }
    function readWorkPathFast(doc) {
        try {
            var ref = new ActionReference();
            ref.putProperty(c('Path'), s('workPath'));
            var desc = executeActionGet(ref);
            if (!desc.hasKey(s('pathContents'))) return null;
            var pc = desc.getObjectValue(s('pathContents'));
            if (!pc.hasKey(s('pathComponents'))) return null;
            var comps = pc.getList(s('pathComponents')), out = [];
            for (var i = 0; i < comps.count; i++) {
                var comp = comps.getObjectValue(i);
                if (!comp.hasKey(s('subpathListKey'))) continue;
                var op = ShapeOperation.SHAPEADD;
                try { op = shapeOpFrom(typeIDToStringID(comp.getEnumerationValue(s('shapeOperation')))); } catch (e0) {}
                var spl = comp.getList(s('subpathListKey'));
                for (var j = 0; j < spl.count; j++) {
                    var sp = spl.getObjectValue(j), closed = true;
                    try { if (sp.hasKey(s('closedSubpath'))) closed = sp.getBoolean(s('closedSubpath')); } catch (e1) {}
                    var pl = sp.getList(s('points')), pts = [];
                    for (var k = 0; k < pl.count; k++) {
                        var po = pl.getObjectValue(k);
                        var a = readPointFast(doc, po.getObjectValue(s('anchor')));
                        var f = readPointFast(doc, po.getObjectValue(s('forward')));
                        var b = readPointFast(doc, po.getObjectValue(s('backward')));
                        if (!a || !f || !b) return null;
                        var pi = new PathPointInfo();
                        pi.kind = pointKindFrom(a, f, b);
                        pi.anchor = a;
                        pi.leftDirection = f;    // AM 的 forward 对应 DOM 的 leftDirection
                        pi.rightDirection = b;   // AM 的 backward 对应 DOM 的 rightDirection
                        pts.push(pi);
                    }
                    var si = new SubPathInfo();
                    si.closed = closed; si.operation = op; si.entireSubPath = pts;
                    out.push(si);
                }
            }
            return out.length ? out : null;
        } catch (e) { return null; }
    }
    function subsBBox(subs) {
        var b = [1e18, 1e18, -1e18, -1e18], n = 0;
        for (var i = 0; i < subs.length; i++) {
            var pts = subs[i].entireSubPath;
            for (var j = 0; j < pts.length; j++) {
                var a = pts[j].anchor; n++;
                if (a[0] < b[0]) b[0] = a[0]; if (a[0] > b[2]) b[2] = a[0];
                if (a[1] < b[1]) b[1] = a[1]; if (a[1] > b[3]) b[3] = a[1];
            }
        }
        return n ? b : null;
    }
    // 结构校验: 路径包围盒应落在选区边界附近(不要求逐边相等, 否则会误判回退 DOM)。
    // 单位换算错误(例如差 12.5 倍)会被这里挡住。
    function bboxSane(bb, bd) {
        if (!bb || !bd) return false;
        var x0 = toNum(bd[0]), y0 = toNum(bd[1]), x1 = toNum(bd[2]), y1 = toNum(bd[3]);
        if (!(x1 > x0) || !(y1 > y0)) return false;
        var maxd = Math.max(x1 - x0, y1 - y0);
        var m = 4 + 0.01 * maxd;
        return bb[0] >= x0 - m && bb[1] >= y0 - m && bb[2] <= x1 + m && bb[3] <= y1 + m;
    }
    function subsMatch(a, b, tol) {
        if (!a || !b || a.length !== b.length) return false;
        var count = 0;
        for (var i = 0; i < a.length; i++) {
            var pa = a[i].entireSubPath, pb = b[i].entireSubPath;
            if (pa.length !== pb.length) return false;
            if (a[i].closed !== b[i].closed) return false;
            if (String(a[i].operation) !== String(b[i].operation)) return false;
            for (var j = 0; j < pa.length; j++) {
                if (Math.abs(pa[j].anchor[0] - pb[j].anchor[0]) > tol) return false;
                if (Math.abs(pa[j].anchor[1] - pb[j].anchor[1]) > tol) return false;
                if (Math.abs(pa[j].leftDirection[0] - pb[j].leftDirection[0]) > tol) return false;
                if (Math.abs(pa[j].leftDirection[1] - pb[j].leftDirection[1]) > tol) return false;
                if (Math.abs(pa[j].rightDirection[0] - pb[j].rightDirection[0]) > tol) return false;
                if (Math.abs(pa[j].rightDirection[1] - pb[j].rightDirection[1]) > tol) return false;
                count++;
            }
        }
        return count > 0;
    }
    function rectSub(l, t, r, b) {
        var pts = [], cs = [[l, t], [r, t], [r, b], [l, b]];
        for (var i = 0; i < 4; i++) {
            var pi = new PathPointInfo();
            pi.kind = PointKind.CORNERPOINT; pi.anchor = cs[i];
            pi.leftDirection = cs[i]; pi.rightDirection = cs[i]; pts.push(pi);
        }
        var si = new SubPathInfo(); si.closed = true; si.operation = ShapeOperation.SHAPEADD; si.entireSubPath = pts;
        return si;
    }
    function applyVectorMaskOnce(doc, target, path, mode) {
        doc.activeLayer = target;
        path.select();
        var mask = new ActionDescriptor(), newPath = new ActionReference();
        newPath.putClass(c('Path')); mask.putReference(c('null'), newPath);
        var at = new ActionReference();
        at.putEnumerated(c('Path'), c('Path'), mode === 2 ? s('mask') : s('vectorMask'));
        mask.putReference(c('At  '), at);
        var using = new ActionReference();
        if (mode === 1 && path.name) using.putName(c('Path'), path.name);      // 按路径名引用
        else using.putEnumerated(c('Path'), c('Ordn'), c('Trgt'));              // 按当前目标路径引用
        mask.putReference(c('Usng'), using);
        executeAction(c('Mk  '), mask, DialogModes.NO);
    }
    /* 把路径挂成图层/组的矢量蒙版。
     * 不同 Photoshop 版本对「建立: 路径 → 矢量蒙版」的写法略有差异, 依次尝试几种写法,
     * 全部失败才抛出; 记住首次成功的写法, 后续层不再重复试错。 */
    var vectorMaskMode = -1;
    function applyVectorMask(doc, target, path) {
        var order = vectorMaskMode >= 0 ? [vectorMaskMode, 0, 1, 2] : [0, 1, 2];
        var lastErr = null;
        for (var i = 0; i < order.length; i++) {
            if (i > 0 && order[i] === order[0]) continue;
            try { applyVectorMaskOnce(doc, target, path, order[i]); vectorMaskMode = order[i]; return; }
            catch (e) { lastErr = e; }
        }
        throw new Error(lastErr && lastErr.message ? lastErr.message : String(lastErr));
    }
    function hasVectorMask(layer) {
        try {
            var ref = new ActionReference(); ref.putIdentifier(s('layer'), layer.id);
            var desc = executeActionGet(ref);
            return desc.hasKey(s('hasVectorMask')) && desc.getBoolean(s('hasVectorMask'));
        } catch (e) { return false; }
    }
    /* 形状分批: 每批 ≤900 条子路径且 ≤10000 节点。
     * 单条路径的点数越多, Photoshop 建立形状层的耗时会超线性增长
     * (实测 9600 点 ≈0.32ms/点, 30392 点 ≈0.7ms/点), 所以宁多分几批也不要堆成一条大路径,
     * 避免某一批把 Photoshop 卡住几十秒到几分钟。 */
    function planShapeBatches(polys) {
        var batches = [], start = 0, points = 0, total = 0;
        var maxPaths = MAX_SUBPATHS, maxPoints = 10000;
        for (var i = 0; i < polys.length; i++) {
            var n = polys[i].length;
            if (n > MAX_SUB_POINTS) throw new Error('单条路径节点数 ' + n + ' 超过 Photoshop 单子路径上限 ' + MAX_SUB_POINTS + '；未截断纹样');
            if (i > start && (i - start >= maxPaths || points + n > maxPoints)) {
                batches.push({ start: start, end: i, points: points });
                start = i; points = 0;
            }
            points += n; total += n;
            if (total > 250000 || i >= 60000)
                throw new Error('单区域纹样超过安全预算（60000 条 / 250000 节点），请放大「容差px」、加大线宽净隙或拆成多个区域分次生成；未截断纹样');
        }
        if (start < polys.length) batches.push({ start: start, end: polys.length, points: points });
        return { batches: batches, points: total };
    }

    function createSolidShape(doc, polys, name) {
        app.activeDocument = doc;
        var subs = [];
        for (var k = 0; k < polys.length; k++) {
            var pts = [];
            for (var j = 0; j < polys[k].length; j++) {
                var pi = new PathPointInfo();
                pi.kind = PointKind.CORNERPOINT;
                pi.anchor = [polys[k][j][0], polys[k][j][1]];
                pi.leftDirection = pi.anchor; pi.rightDirection = pi.anchor; pts.push(pi);
            }
            var si = new SubPathInfo(); si.closed = true; si.operation = ShapeOperation.SHAPEADD; si.entireSubPath = pts;
            subs.push(si);
        }
        var layer = null, path = null;
        try {
            path = doc.pathItems.add('ZG_temp_shape_' + String(new Date().getTime()), subsPxToPt(doc, subs));
            path.select();
            var d = new ActionDescriptor(), ref = new ActionReference();
            ref.putClass(s('contentLayer')); d.putReference(c('null'), ref);
            var use = new ActionDescriptor(), fill = new ActionDescriptor(), rgb = new ActionDescriptor();
            rgb.putDouble(c('Rd  '), 0); rgb.putDouble(c('Grn '), 0); rgb.putDouble(c('Bl  '), 0);
            fill.putObject(c('Clr '), c('RGBC'), rgb); use.putObject(c('Type'), s('solidColorLayer'), fill);
            d.putObject(c('Usng'), s('contentLayer'), use);
            executeAction(c('Mk  '), d, DialogModes.NO);
            layer = doc.activeLayer;
            layer.name = name;
            path.remove();
            path = null;
            if (layer.kind !== LayerKind.SOLIDFILL || !hasVectorMask(layer)) throw new Error('未建立黑色填充矢量蒙版');
            return { layer: layer, via: 'shape' };
        } catch (e) {
            try { if (path) path.remove(); } catch (e2) {}
            try { if (layer) layer.remove(); } catch (e3) {}
            throw new Error(name + ': 形状层建立失败，已停止生成: ' + (e && e.message ? e.message : String(e)));
        }
        return { layer: layer, via: 'shape' };
    }
    /* 校验母版: 输出组现在可以按源层级嵌套, 因此递归检查;
     * 「本层纹样」子组与叶子组必须带区域矢量蒙版, 纯容器组(只有子组)允许无蒙版。 */
    /* 把组 sub 放进容器组 target(用于「本层纹样」子组与父子级嵌套)。
     * Photoshop 各版本对「把组移进组」的支持不一致(2020 实测 ElementPlacement.INSIDE 会报非法参数),
     * 因此依次尝试三种写法, 每种都校验「target 的子组数确实 +1」, 成功返回所用方式编号, 失败返回 0。 */
    var nestMethodUsed = 0;
    function nestGroup(doc, sub, target) {
        var beforeChildren = target.layerSets.length, beforeTop = doc.layerSets.length;
        function ok() { return target.layerSets.length === beforeChildren + 1 && doc.layerSets.length === beforeTop - 1; }
        nestMethodUsed = 0;
        // 方式1: 直接移进目标组
        try {
            sub.move(target, ElementPlacement.INSIDE);
            if (ok()) { nestMethodUsed = 1; return 1; }
        } catch (e1) {}
        // 方式2: 借目标组内一个临时普通图层定位, 把组插到它前面
        var dummy = null;
        try {
            dummy = doc.artLayers.add();
            dummy.name = 'ZG_temp_nest';
            dummy.move(target, ElementPlacement.INSIDE);
            sub.move(dummy, ElementPlacement.PLACEBEFORE);
            try { dummy.remove(); } catch (e2) {}
            if (ok()) { nestMethodUsed = 2; return 2; }
        } catch (e3) { try { if (dummy) dummy.remove(); } catch (e4) {} }
        // 方式3: ActionManager 的 move 命令
        try {
            var d = new ActionDescriptor(), r1 = new ActionReference();
            r1.putIdentifier(s('layer'), sub.id); d.putReference(c('null'), r1);
            var r2 = new ActionReference(); r2.putIdentifier(s('layer'), target.id);
            d.putReference(s('to'), r2);
            d.putEnumerated(s('insertion'), s('insertion'), s('inside'));
            executeAction(s('move'), d, DialogModes.NO);
            if (ok()) { nestMethodUsed = 3; return 3; }
        } catch (e5) {}
        return 0;
    }
    function validateMasterDoc(doc, expectedGroups, requireRegionMask, wpx, hpx) {
        var shapeCount = 0, patternHosts = 0;
        function walk(container, topLevel) {
            for (var gi = 0; gi < container.layerSets.length; gi++) {
                var group = container.layerSets[gi];
                if (String(group.name).indexOf('ZG_OUT__') !== 0) throw new Error(group.name + ': 出现非 ZG_OUT 输出组');
                if (group.artLayers.length) {
                    patternHosts++;
                    if (requireRegionMask && !hasVectorMask(group)) throw new Error(group.name + ': 缺少区域矢量蒙版');
                    for (var gi2 = 0; gi2 < group.artLayers.length; gi2++) {
                        var layer = group.artLayers[gi2];
                        if (layer.kind !== LayerKind.SOLIDFILL || !hasVectorMask(layer))
                            throw new Error(group.name + '/' + layer.name + ': 检测到像素层或无矢量蒙版图层');
                        var bd = layer.bounds, l = toNum(bd[0]), t = toNum(bd[1]), r = toNum(bd[2]), b = toNum(bd[3]);
                        if (l < -wpx || t < -hpx || r > wpx * 2 || b > hpx * 2)
                            throw new Error(group.name + '/' + layer.name + ': 形状边界异常 ' + l + ',' + t + '..' + r + ',' + b);
                        shapeCount++;
                    }
                } else if (!group.layerSets.length) {
                    throw new Error(group.name + ': 空输出组');
                }
                walk(group, false);
            }
        }
        walk(doc, true);
        if (patternHosts !== expectedGroups)
            throw new Error('母版纹样组数不符: 期望 ' + expectedGroups + '，实际 ' + patternHosts);
        if (!shapeCount) throw new Error('母版没有可用形状层');
        return shapeCount;
    }
    function resolveLayer(container, parts, idx) {
        if (idx >= parts.length) return null;
        var name = parts[idx], found = null, j;
        for (j = 0; j < container.layers.length; j++) if (container.layers[j].name === name) { found = container.layers[j]; break; }
        if (!found) for (j = 0; j < container.layerSets.length; j++) if (container.layerSets[j].name === name) { found = container.layerSets[j]; break; }
        if (!found) return null;
        if (idx === parts.length - 1) return found;
        if (found.typename !== 'LayerSet') return null;
        return resolveLayer(found, parts, idx + 1);
    }
    function collectLayers(container, prefix, out) {
        var i;
        function bnd(l) { try { return l.bounds; } catch (e) { return null; } }
        for (i = 0; i < container.layers.length; i++) {
            var l = container.layers[i];
            if (l.typename === 'LayerSet') {
                /* 后序(子层优先): 先列出组内子层, 再列出组本身。
                 * 这样「避免重叠」按列表顺序累加时, 细节纹样(子层)优先, 组容器只补空隙。 */
                var p = prefix + l.name;
                collectLayers(l, p + '/', out);
                out.push({ layer: l, path: p, name: l.name, type: 'LayerSet', kind: 'LayerSet', visible: l.visible, bounds: bnd(l) });
                continue;
            }
            var kind = '';
            try { kind = String(l.kind); } catch (e2) {}
            out.push({ layer: l, path: prefix + l.name, name: l.name, type: l.typename, kind: kind, visible: l.visible, bounds: bnd(l) });
        }
    }

    /* ---------------- "不折光"标记 (模糊识别) ----------------
     * 图层或编组命名里带这些字样即表示该层(及其全部子项)不做折光:
     * 照常生成, 但生成的输出组会被隐藏, 便于与源文件的层级/可见性对应。
     * 允许简写与不同称呼, 中英文均可。
     * 注意: 这里不能用长中文交替正则! ExtendScript(PS 2020 实测)对长中文交替的
     * 正则 (旧版 20 项 | 交替共 117 字符) 会漏匹配: 'hot stamp/Silver（不做折光）'
     * 判 false, 而同一串用短正则 /不做折光/ 判 true。漏判的后果是「不做折光」组被
     * 当成普通层: 输出组没隐藏, 还占用了区域占用通道, 后面 BG 这类背景层的蒙版
     * 被整片挖掉(2026-09-16 008 次日志里 Silver/Queen 就是这么被算进去的)。
     * 中文标记改用 indexOf 逐项查找, 英文标记保留短正则。 */
    var NO_REFRACTION_MARKS = ['不加折光', '不需要折光', '不需要加折光纹', '不折光', '不做折光', '不要折光', '不用折光', '无需折光', '无须折光', '不需折光', '免折光', '不压纹', '不加纹', '无纹', '不做', '不用', '不要', '跳过'];
    var NO_REFRACTION_ASCII_RE = /\bskip\b|no[\s_-]?refraction|\[skip\]/i;
    function isNoRefraction(name) {
        var v = String(name == null ? '' : name);
        for (var i = 0; i < NO_REFRACTION_MARKS.length; i++) if (v.indexOf(NO_REFRACTION_MARKS[i]) >= 0) return true;
        return NO_REFRACTION_ASCII_RE.test(v);
    }

    /* ---------------- 启发式建议 (本地规则) ---------------- */
    function suggest(info, canvasW, canvasH) {
        var name = String(info.name || '');
        var bd = info.bounds;
        var r = { pattern: 'facet', direction_deg: 0, skip: false, hide: false, reason: '' };
        if (isNoRefraction(name)) { r.hide = true; r.reason = '名称含不折光标记 → 照常生成但输出组隐藏'; return r; }
        var table = [
            [/脸|face|皮肤|skin|五官|眼睛|眼|口|鼻|唇|五官/i, { skip: true, why: '面部/五官 → 留白' }],
            [/文字|标题|title|logo|签名|水印|text|字/i, { skip: true, why: '文字/签名 → 通常不加纹' }],
            [/头发|发丝|发束|毛发|hair/i, { pattern: 'flow', why: '头发 → flow' }],
            [/云|cloud|烟|smoke|雾|气/i, { pattern: 'contour', why: '云/烟 → contour' }],
            [/水|波|浪|海|河|湖|water|wave|浪/i, { pattern: 'wave', why: '水 → wave' }],
            [/飘带|丝带|衣|布|裙|袖|袍|cloth|fabric|ribbon|带/i, { pattern: 'flow', why: '织物/飘带 → flow' }],
            [/羽|翅|翼|feather|wing/i, { pattern: 'feather', why: '羽翼 → feather' }],
            [/花|花瓣|flower|petal|玫瑰|rose/i, { pattern: 'petal_rosette', why: '花卉 → petal_rosette' }],
            [/光环|光晕|光芒|光线|放射|太阳|日轮|ray|sun|halo|星芒|radial/i, { pattern: 'radial', why: '光环/太阳 → radial' }],
            [/圆|币|coin|表盘|镜|盘|环|ring/i, { pattern: 'concentric', why: '圆/盘 → concentric' }],
            [/边框|框|border|边饰|花边|frame|饰带|菱格|三角/i, { pattern: 'diamond_tri', why: '边框/边饰 → 三角菱格纹' }],
            [/回纹|迷宫|meander|希腊/i, { pattern: 'meander', why: '回纹 → meander' }],
            [/鳞|鱼鳞|龙鳞|scale|甲/i, { pattern: 'scale', why: '鳞片 → scale' }],
            [/涡|旋|漩涡|spiral|vortex|星云/i, { pattern: 'spiral', why: '漩涡 → spiral' }],
            [/科技|机械|电路|机甲|装甲|蜂巢|honey|tech/i, { pattern: 'hex_lattice', why: '科技/机械 → hex_lattice' }],
            [/石|建筑|墙|砖|building|城堡|岩石/i, { pattern: 'facet', why: '建筑/硬质 → facet' }],
            [/背景|天空|底|background|bg|夜空|大面积/i, { pattern: 'moire_radial', why: '背景/大面积 → 辐射摩尔纹' }],
            [/纺织|编织|格|棋盘|checker|weave|格子/i, { pattern: 'herringbone', why: '纺织/格 → herringbone' }]
        ];
        var matched = false;
        for (var i = 0; i < table.length; i++) {
            if (table[i][0].test(name)) { r.pattern = table[i][1].pattern || r.pattern; r.skip = !!table[i][1].skip; r.reason = table[i][1].why; matched = true; break; }
        }
        if (r.skip) return r;
        var w = 0, h = 0;
        if (bd && bd.length === 4) { w = toNum(bd[2]) - toNum(bd[0]); h = toNum(bd[3]) - toNum(bd[1]); }
        if (w > 0 && h > 0) {
            r.direction_deg = (w >= h) ? 0 : 90;
            var aspect = Math.max(w, h) / Math.min(w, h);
            var areaFrac = (w * h) / (canvasW * canvasH);
            if (!matched && /NORMAL/i.test(String(info.kind || '')) && areaFrac > 0.95) {
                r.skip = true; r.reason = '疑似整图合成/底图层 → 默认跳过'; return r;
            }
            if (!matched) {
                if (aspect > 3) { r.pattern = 'flow'; r.reason = '细长(长宽比 ' + aspect.toFixed(1) + ') → flow'; }
                else if (areaFrac < 0.03) { r.pattern = 'short_curve'; r.reason = '小区域 → short_curve'; }
                else if (areaFrac > 0.6) { r.pattern = 'moire_radial'; r.reason = '大面积(占画布 ' + Math.round(areaFrac * 100) + '%) → 辐射摩尔纹'; }
                else { r.pattern = 'parallel'; r.reason = '规则区域 → parallel'; }
            }
        }
        return r;
    }
    var lastReadMode = '', lastSampleMs = null;
    /* 取样用的临时文档只建一次并复用。
     * 原因: 逐层新建/关闭文档会在几十层后触发 Photoshop「不能创建新文档…没有足够的空间来停放它们」，
     * 一旦触发后续所有层都会失败(实测 17:28 那次 91 层全废)。复用同一个文档同时也更快。 */
    function resetTempDoc(t) {
        // 新建一个空图层当底, 再删掉其余图层/组 —— 新图层必然透明, 不依赖"清空内容"的 API。
        var fresh = null;
        try { fresh = t.artLayers.add(); } catch (e0) {}
        try { while (t.layerSets.length) t.layerSets[0].remove(); } catch (e1) {}
        try {
            var guard = 0;
            while (t.artLayers.length > 1 && guard++ < 500) {
                var l = t.artLayers[0];
                if (fresh && l.id === fresh.id && t.artLayers.length > 1) l = t.artLayers[1];
                if (!l) break;
                l.remove();
            }
        } catch (e2) {}
        if (!t.artLayers.length) { try { t.artLayers.add(); } catch (e3) {} }
        var keep = t.artLayers.length ? t.artLayers[0] : null;
        if (keep) { try { t.activeLayer = keep; } catch (e4) {} }
        return keep;
    }
    function tempDocIsEmpty(t) {
        if (!t.artLayers.length) return true;
        try {
            loadTransparency(t, t.artLayers[0]);
            t.selection.bounds;
            try { t.selection.deselect(); } catch (e1) {}
            return false;
        } catch (e2) { return true; }
    }
    function tryResetVerified(t) {
        try {
            resetTempDoc(t);
            if (tempDocIsEmpty(t)) return true;
            try { if (t.artLayers.length) t.artLayers[0].delete(); } catch (e1) {}   // 备用清空方式
            if (!t.artLayers.length) { try { t.artLayers.add(); } catch (e2) {} }
            if (tempDocIsEmpty(t)) return true;
        } catch (e3) {}
        return false;
    }
    function ensureTempDoc(doc, reuse) {
        if (reuse.doc) {
            // 每 15 层把取样文档回退到初始状态, 清掉累积的历史与内存占用
            reuse.count = (reuse.count || 0) + 1;
            if (reuse.count % 15 === 0) {
                try { reuse.doc.activeHistoryState = reuse.doc.historyStates[0]; } catch (eH) {}
            }
            if (tryResetVerified(reuse.doc)) return reuse.doc;
            try { reuse.doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC) {}   // 复位失败: 关掉重建
            reuse.doc = null;
        }
        var t = null;
        try {
            t = app.documents.add(doc.width, doc.height, doc.resolution,
                'ZG_region_sample', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        } catch (eNew) {
            try {   // 退路: 用源文档的合并副本当临时文档
                app.activeDocument = doc;
                t = doc.duplicate('ZG_region_sample', true);
                t.activeLayer.name = 'ZG_base';
            } catch (eDup) { t = null; }
        }
        if (!t) throw new Error('无法建立取样临时文档(Photoshop 报「没有足够空间停放新文档」；可在首选项里关闭「以选项卡方式打开文档」后重试)');
        reuse.doc = t;
        tryResetVerified(t);
        return t;
    }
    function getRegionSubs(doc, layer, tol, fast, reuse) {
        var previousDoc = app.activeDocument, oldUnits = app.preferences.rulerUnits;
        var temp = null, stage = '建立临时取样文档';
        var tStart = new Date().getTime(), tMark = tStart, tDup = tStart, tMerge = tStart, tLoad = tStart, tMwp = tStart;
        lastReadMode = ''; lastSampleMs = null;
        try {
            app.preferences.rulerUnits = Units.PIXELS;
            if (fast) {
                var fb = layer.bounds;
                if (toNum(fb[2]) <= toNum(fb[0]) || toNum(fb[3]) <= toNum(fb[1])) return [];
                return [rectSub(toNum(fb[0]), toNum(fb[1]), toNum(fb[2]), toNum(fb[3]))];
            }
            if (reuse) {
                temp = ensureTempDoc(doc, reuse);
            } else {
                temp = app.documents.add(doc.width, doc.height, doc.resolution,
                    'ZG_region_sample', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
                resetTempDoc(temp);
            }
            tMark = new Date().getTime();
            app.activeDocument = doc;
            stage = '复制待取样图层';
            var copied = layer.duplicate(temp, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = temp;
            copied.visible = true;
            tDup = new Date().getTime();
            stage = '渲染图层及蒙版';
            // 透明底 + 复制来的图层, 用 mergeVisibleLayers 渲染文字/智能对象/组, 不碰源文档。
            var raster = null;
            try {
                temp.mergeVisibleLayers();
                raster = temp.activeLayer;
            } catch (eMerge) {   // 个别版本/图层类型合并失败时退化处理
                raster = copied;
                plog('警告: mergeVisibleLayers 失败, 改用复制图层本身: ' + (eMerge && eMerge.message ? eMerge.message : String(eMerge)));
            }
            tMerge = new Date().getTime();
            var rb = raster.bounds;
            if (toNum(rb[2]) <= toNum(rb[0]) || toNum(rb[3]) <= toNum(rb[1])) return [];
            stage = '载入渲染透明度';
            loadTransparency(temp, raster);
            var bd;
            try { bd = temp.selection.bounds; } catch (emptySelection) { return []; }
            if (toNum(bd[2]) <= toNum(bd[0]) || toNum(bd[3]) <= toNum(bd[1])) return [];
            tLoad = new Date().getTime();
            stage = '把选区转换为工作路径';
            temp.selection.makeWorkPath(tol);
            tMwp = new Date().getTime();
            // Photoshop 2020 returns void; obtain the work path from PathItems.
            var wp = null;
            for (var i = 0; i < temp.pathItems.length; i++)
                if (temp.pathItems[i].kind === PathKind.WORKPATH) { wp = temp.pathItems[i]; break; }
            if (!wp) throw new Error('选区转换后没有工作路径');
            stage = '读取工作路径锚点';
            /* 优先用 ActionManager 读路径(DOM 读取是 O(n^2), 大路径要几分钟)。
             * 首次遇到小路径(≤150 点)时与 DOM 逐点比对做严格标定;
             * 大路径只做结构校验(路径包围盒需落在选区边界附近), 避免标定本身变成瓶颈。
             * 任何一步不符合预期就回退 DOM, 结果不变, 只是慢。 */
            var fastSubs = readWorkPathFast(temp);
            var amTotal = 0;
            if (fastSubs) for (var ci = 0; ci < fastSubs.length; ci++) amTotal += fastSubs[ci].entireSubPath.length;
            var strictPending = (pathReadInfo === '未测' || pathReadInfo === 'ActionManager(快, 结构校验)');
            if (strictPending && fastSubs && amTotal <= 150) {
                var domSubs = subInfosFromPath(wp, temp);
                pathReadInfo = subsMatch(fastSubs, domSubs, 0.01) ? 'ActionManager(快, 已与DOM比对)' : 'DOM(慢, O(n^2))';
                lastReadMode = 'DOM(标定)';
                return domSubs;
            }
            if (fastSubs && pathReadInfo !== 'DOM(慢, O(n^2))') {
                var fb2 = subsBBox(fastSubs);
                if (fb2 && bboxSane(fb2, bd)) {
                    if (pathReadInfo === '未测') pathReadInfo = 'ActionManager(快, 结构校验)';
                    lastReadMode = 'ActionManager';
                    return fastSubs;
                }
                lastReadMode = 'ActionManager(校验不符,回退DOM)';
            } else {
                lastReadMode = 'DOM(回退)';
            }
            if (pathReadInfo === '未测') pathReadInfo = 'DOM(慢, O(n^2))';
            return subInfosFromPath(wp, temp);
        } catch (e) {
            throw new Error('无法从图层取得有效轮廓 [' + stage + ']: ' + (e.message || String(e)));
        } finally {
            var tEnd = new Date().getTime();
            lastSampleMs = {
                doc: tMark - tStart, dup: tDup - tMark, merge: tMerge - tDup,
                load: tLoad - tMerge, mwp: tMwp - tLoad, read: tEnd - tMwp, total: tEnd - tStart
            };
            if (temp && !reuse) temp.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = previousDoc;
            app.preferences.rulerUnits = oldUnits;
        }
    }

    /* ---------------- 纹样生成 (单位 px) ---------------- */
    function gapFor(b, cfg, x, y) {
        var u;
        if (cfg.gradientAxis === 'vertical') { u = (y - b.y0) / (b.y1 - b.y0); if (cfg.denseEnd === 'top') u = 1 - u; }
        else if (cfg.gradientAxis === 'horizontal') { u = (x - b.x0) / (b.x1 - b.x0); if (cfg.denseEnd === 'left') u = 1 - u; }
        else return cfg.gapMidPx;
        u = clamp(u, 0, 1);
        return cfg.gapSparsePx + (cfg.gapDensePx - cfg.gapSparsePx) * smooth(u);
    }
    function ribbon2(sx, sy, ex, ey, half) {
        var dx = ex - sx, dy = ey - sy, len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return null;
        var nx = -dy / len * half, ny = dx / len * half;
        return [[sx + nx, sy + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [sx - nx, sy - ny]];
    }
    function offsetPolyline(points, half) {
        var n = points.length, top = [], bot = [];
        for (var i = 0; i < n; i++) {
            var prev = points[i === 0 ? 0 : i - 1], next = points[i === n - 1 ? n - 1 : i + 1];
            var dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.sqrt(dx * dx + dy * dy);
            var nx, ny;
            if (len < 1e-6) { nx = 0; ny = 1; } else { nx = -dy / len; ny = dx / len; }
            top.push([points[i][0] + nx * half, points[i][1] + ny * half]);
            bot.push([points[i][0] - nx * half, points[i][1] - ny * half]);
        }
        var poly = top.slice(0);
        for (var j = bot.length - 1; j >= 0; j--) poly.push(bot[j]);
        return poly;
    }
    function projections(b, cfg) {
        var dx = Math.cos(cfg.dirRad), dy = Math.sin(cfg.dirRad), nx = -dy, ny = dx;
        var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        var corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
        var tmin = 1e18, tmax = -1e18, smin = 1e18, smax = -1e18;
        for (var k = 0; k < 4; k++) {
            var ox = corners[k][0] - cx, oy = corners[k][1] - cy;
            var t = ox * dx + oy * dy, sn = ox * nx + oy * ny;
            if (t < tmin) tmin = t; if (t > tmax) tmax = t;
            if (sn < smin) smin = sn; if (sn > smax) smax = sn;
        }
        var margin = (typeof cfg.marginPx === 'number') ? cfg.marginPx : (cfg.linePx + cfg.gapSparsePx + (cfg.ampPx || 0));
        return { dx: dx, dy: dy, nx: nx, ny: ny, cx: cx, cy: cy, tmin: tmin - margin, tmax: tmax + margin, smin: smin - margin, smax: smax + margin };
    }
    function genFacet(b, cfg) {
        var p = projections(b, cfg), polys = [], ss = p.smin, guard = 0;
        while (ss <= p.smax && guard < 300000) {
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny;
            var gap = gapFor(b, cfg, px, py);
            var poly = ribbon2(px + p.tmin * p.dx, py + p.tmin * p.dy, px + p.tmax * p.dx, py + p.tmax * p.dy, cfg.linePx / 2);
            if (poly) polys.push(poly);
            ss += cfg.linePx + gap;
            guard++;
        }
        return polys;
    }
    function genFlow(b, cfg) {
        var p = projections(b, cfg), polys = [], ss = p.smin;
        var amp = cfg.ampPx || 0, wave = cfg.wavePx || 1, samples = 24;
        while (ss <= p.smax) {
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny;
            var gap = gapFor(b, cfg, px, py);
            var pts = [], step = (p.tmax - p.tmin) / samples;
            for (var i = 0; i <= samples; i++) {
                var t = p.tmin + i * step, f = amp * Math.sin(2 * Math.PI * t / wave);
                pts.push([px + t * p.dx + f * p.nx, py + t * p.dy + f * p.ny]);
            }
            polys.push(offsetPolyline(pts, cfg.linePx / 2));
            ss += cfg.linePx + gap;
        }
        return polys;
    }
    function tri(u) { var f = u - Math.floor(u); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }
    function parallelFamily(b, cfg, dispFn, samples) {
        var p = projections(b, cfg);
        var polys = [], ss = p.smin, guard = 0;
        while (ss <= p.smax && guard < 300000) {
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny;
            var gap = gapFor(b, cfg, px, py);
            var pts = [], step = (p.tmax - p.tmin) / samples;
            for (var i = 0; i <= samples; i++) {
                var t = p.tmin + i * step, f = dispFn(t);
                pts.push([px + t * p.dx + f * p.nx, py + t * p.dy + f * p.ny]);
            }
            polys.push(offsetPolyline(pts, cfg.linePx / 2));
            ss += cfg.linePx + gap;
            guard++;
        }
        return polys;
    }
    function genWave(b, cfg) {
        var amp = cfg.ampPx || 0, wave = cfg.wavePx || 1;
        return parallelFamily(b, cfg, function (t) { return amp * Math.sin(2 * Math.PI * t / wave); }, 24);
    }
    function genZigzag(b, cfg) {
        var amp = cfg.ampPx || 0, wave = cfg.wavePx || 1;
        return parallelFamily(b, cfg, function (t) { return amp * tri(t / wave); }, 40);
    }
    function genChevron(b, cfg) {
        var p = projections(b, cfg), ba = cfg.branchAngleRad || (Math.PI / 4), polys = [];
        polys.push(offsetPolyline([[p.cx + p.tmin * p.dx, p.cy + p.tmin * p.dy], [p.cx + p.tmax * p.dx, p.cy + p.tmax * p.dy]], cfg.linePx / 2));
        var sinBa = Math.sin(ba); if (sinBa < 0.2) sinBa = 0.2;
        var pitch = (cfg.linePx + cfg.gapMidPx) / sinBa;
        var L = (p.smax - p.smin) + cfg.linePx;
        for (var s = 0; s < 2; s++) {
            var ang = cfg.dirRad + (s === 0 ? ba : -ba);
            var vx = Math.cos(ang), vy = Math.sin(ang);
            var startT = p.tmin + (s === 0 ? 0 : pitch / 2);
            for (var t = startT; t <= p.tmax + pitch; t += pitch) {
                var S = [p.cx + t * p.dx, p.cy + t * p.dy];
                var rb = ribbon2(S[0], S[1], S[0] + L * vx, S[1] + L * vy, cfg.linePx / 2);
                if (rb) polys.push(rb);
            }
        }
        return polys;
    }
    function genFeather(b, cfg) {
        var p = projections(b, cfg), ba = cfg.branchAngleRad || (Math.PI / 4), polys = [];
        polys.push(offsetPolyline([[p.cx + p.tmin * p.dx, p.cy + p.tmin * p.dy], [p.cx + p.tmax * p.dx, p.cy + p.tmax * p.dy]], cfg.linePx / 2));
        var sinBa = Math.sin(ba); if (sinBa < 0.2) sinBa = 0.2;
        var pitch = (cfg.linePx + cfg.gapMidPx) / sinBa;
        var L = (p.smax - p.smin) + cfg.linePx;
        for (var s = 0; s < 2; s++) {
            var a0 = cfg.dirRad + (s === 0 ? ba : -ba), a1 = cfg.dirRad + (s === 0 ? ba * 2.2 : -ba * 2.2);
            var startT = p.tmin + (s === 0 ? 0 : pitch / 2);
            for (var t = startT; t <= p.tmax + pitch; t += pitch) {
                var S = [p.cx + t * p.dx, p.cy + t * p.dy], pts = [];
                for (var i = 0; i <= 8; i++) {
                    var u = i / 8, ang = a0 + (a1 - a0) * u, len = L * u;
                    pts.push([S[0] + len * Math.cos(ang), S[1] + len * Math.sin(ang)]);
                }
                polys.push(offsetPolyline(pts, cfg.linePx / 2));
            }
        }
        return polys;
    }
    function genBilateral(b, cfg) {
        var p = projections(b, cfg), polys = [], ss = p.smin, amp = cfg.ampPx || 0, wave = cfg.wavePx || 1;
        var gapBand = cfg.linePx + cfg.gapMidPx;
        while (ss <= p.smax) {
            if (Math.abs(ss) < gapBand / 2) { ss += cfg.linePx + cfg.gapMidPx; continue; }
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny;
            var gap = gapFor(b, cfg, px, py);
            var pts = [], step = (p.tmax - p.tmin) / 24;
            for (var i = 0; i <= 24; i++) {
                var t = p.tmin + i * step, f = amp * Math.sin(2 * Math.PI * t / wave);
                pts.push([px + t * p.dx + f * p.nx, py + t * p.dy + f * p.ny]);
            }
            polys.push(offsetPolyline(pts, cfg.linePx / 2));
            ss += cfg.linePx + gap;
        }
        return polys;
    }
    /* 单元类纹样(回纹/人字/蜂巢/碳纤维/鳞片/点阵)的格子尺寸统一由「线宽+中隙」推导。
     * 旧版直接用 wavelength_mm(默认 12mm) 当格子, 600ppi 下格距约 283px,
     * 与其它纹样的基准间距(线宽+净隙≈7px)差 40 倍, 结果就是「只有两三条线」的过疏效果。
     * 现在: 把 wavelength_mm 当作单元尺寸(mm)输入, 换算成基准间距的倍数后夹在 [minMult, maxMult] 内,
     * 既保留参数手感, 又保证与平行纹同一量级的密度。 */
    function unitCellPx(cfg, minMult, maxMult) {
        var pitch = cfg.linePx + cfg.gapMidPx;
        var mult = minMult;
        if (cfg.wavePx > 0) mult = cfg.wavePx / pitch;
        if (!(mult > 0)) mult = minMult;
        if (mult < minMult) mult = minMult;
        if (mult > maxMult) mult = maxMult;
        return pitch * mult;
    }
    function genHerringbone(b, cfg) {
        // 单元 = 基准间距的 2~5 倍; 行距 = 单元/2, 斜线间法向净距 ≈ 0.7×行距 ≥ 基准间距
        var p = projections(b, cfg), cell = unitCellPx(cfg, 2, 5), half = cfg.linePx / 2, polys = [];
        var row = p.smin;
        while (row <= p.smax + cell) {
            var pts = [], t = p.tmin, up = true;
            while (t < p.tmax) {
                var o = row + (up ? cell / 2 : -cell / 2);
                pts.push([p.cx + t * p.dx + o * p.nx, p.cy + t * p.dy + o * p.ny]);
                t += cell / 2;
                up = !up;
            }
            if (pts.length >= 2) polys.push(offsetPolyline(pts, half));
            row += cell / 2;
        }
        return polys;
    }
    function genMeander(b, cfg) {
        /* 回纹: 单元 = 基准间距, 行距 = 2×单元 + 基准间距(保证相邻行之间留出净距),
         * 隔行错开一个单元形成咬合。旧版行距=单元, 相邻行的波峰波谷正好重合, 既过疏又会叠线。 */
        var p = projections(b, cfg), half = cfg.linePx / 2, polys = [];
        var pitch = cfg.linePx + cfg.gapMidPx;
        var cell = unitCellPx(cfg, 1, 4);
        var rowStep = cell + pitch;              // 行带高 = cell, 行间再留一个基准净距
        var rows = Math.max(1, Math.round((p.smax - p.smin) / rowStep));
        for (var r = 0; r < rows; r++) {
            var o = p.smin + rowStep * (r + 0.5), pts = [], t = p.tmin;
            var ph = (r % 2) ? cell : 0;   // 隔行错相
            pts.push([p.cx + (t + ph) * p.dx + o * p.nx, p.cy + (t + ph) * p.dy + o * p.ny]);
            while (t < p.tmax + cell * 2) {
                var s1 = o + cell / 2;
                pts.push([p.cx + (t + ph + cell) * p.dx + s1 * p.nx, p.cy + (t + ph + cell) * p.dy + s1 * p.ny]);
                pts.push([p.cx + (t + ph + cell) * p.dx + (s1 - cell) * p.nx, p.cy + (t + ph + cell) * p.dy + (s1 - cell) * p.ny]);
                pts.push([p.cx + (t + ph + cell * 2) * p.dx + (o - cell / 2) * p.nx, p.cy + (t + ph + cell * 2) * p.dy + (o - cell / 2) * p.ny]);
                pts.push([p.cx + (t + ph + cell * 2) * p.dx + o * p.nx, p.cy + (t + ph + cell * 2) * p.dy + o * p.ny]);
                t += cell * 2;
            }
            polys.push(offsetPolyline(pts, half));
        }
        return polys;
    }
    function genRadial(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]], R = 0;
        for (var k = 0; k < 4; k++) { var ox = corners[k][0] - cx, oy = corners[k][1] - cy, dd = Math.sqrt(ox * ox + oy * oy); if (dd > R) R = dd; }
        R += cfg.linePx + cfg.gapSparsePx;
        var r0 = defaultInnerRadius(cfg, R);
        var dtheta = (cfg.linePx + cfg.gapDensePx) / r0;
        var n = Math.floor(2 * Math.PI / dtheta); if (n < 2) n = 2;
        var step = 2 * Math.PI / n, polys = [];
        for (var i = 0; i < n; i++) {
            var th = i * step, d0 = cfg.linePx / (2 * r0), d1 = cfg.linePx / (2 * R);
            polys.push([
                [cx + r0 * Math.cos(th - d0), cy + r0 * Math.sin(th - d0)],
                [cx + R * Math.cos(th - d1), cy + R * Math.sin(th - d1)],
                [cx + R * Math.cos(th + d1), cy + R * Math.sin(th + d1)],
                [cx + r0 * Math.cos(th + d0), cy + r0 * Math.sin(th + d0)]
            ]);
        }
        return polys;
    }
    function genShortCurve(b, cfg) {
        var L = cfg.segLenPx, w = cfg.linePx;
        if (!(L > 0 && w > 0)) throw new Error('short_curve: 线长和线宽必须大于零');
        var p = projections(b, cfg), polys = [];
        var gap = cfg.gradientAxis === 'none' ? cfg.gapMidPx :
            Math.max(cfg.gapDensePx, cfg.gapMidPx, cfg.gapSparsePx);
        // Use one continuous wave phase for every row. Alternating row phases
        // collide when densely packed. Reserve width as well as clear gap at ends.
        var cut = w + gap, cell = L + cut;
        var bend = Math.min(Math.abs(cfg.ampPx), L * 0.30);
        var slope = Math.PI * bend / cell;
        var pitch = (w + gap) * Math.sqrt(1 + slope * slope);
        // This Lipschitz bound guarantees normal clearance between translated
        // curves, even at the steepest part of a wave. Length no longer sets pitch.
        for (var ss = p.smin - bend; ss <= p.smax + bend; ss += pitch) {
            var first = Math.floor(p.tmin / cell), last = Math.ceil(p.tmax / cell);
            for (var j = first; j < last; j++) {
                var pts = [];
                for (var k = 0; k <= 24; k++) {
                    var t = j * cell + cut / 2 + L * k / 24;
                    var sn = ss + bend * Math.sin(Math.PI * t / cell);
                    pts.push([p.cx + t * p.dx + sn * p.nx, p.cy + t * p.dy + sn * p.ny]);
                }
                polys.push(offsetPolyline(pts, w / 2));
            }
        }
        return polys;
    }
    function resolveCoord(v, totalPx, scale) { return (typeof v !== 'number') ? totalPx / 2 : (v <= 1 ? v * totalPx : v * scale); }

    /* ---------------- 中心 / 弧形 / 旋转纹 ---------------- */
    function maxDistFrom(b, cx, cy) {
        var corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]], R = 0;
        for (var k = 0; k < 4; k++) { var dx = corners[k][0] - cx, dy = corners[k][1] - cy; var d = Math.sqrt(dx * dx + dy * dy); if (d > R) R = d; }
        return R;
    }
    /* 中心类纹样的起始半径: 未指定内径时按「线宽+中隙」推导, 避免默认 0 导致内半径只有半条线宽、
     * 角间距过大而只生成两三条射线(旧版 radial 在大面积上实测只有 3 条线)。 */
    function defaultInnerRadius(cfg, R) {
        if (cfg.innerRadiusPx > 0) return Math.max(cfg.innerRadiusPx, cfg.linePx);
        var pitch = cfg.linePx + cfg.gapMidPx;
        var r0 = Math.max(cfg.linePx * 4, pitch * 8);
        if (R && r0 > R * 0.6) r0 = R * 0.6;
        return Math.max(r0, cfg.linePx);
    }
    function withDir(cfg, ang) { var o = {}; for (var k in cfg) o[k] = cfg[k]; o.dirRad = ang; return o; }
    // 圆弧分段数按弦高(0.25px)计算, 不再固定 400 段, 大半径时点数可减到 1/3
    function arcSegments(r) {
        var target = 0.25, rr = Math.max(r, target);
        var c = 1 - target / rr; if (c > 1) c = 1; if (c < -1) c = -1;
        var seg = Math.ceil(Math.PI / Math.acos(c));
        if (!isFinite(seg) || seg < 24) seg = 24;
        if (seg > 240) seg = 240;
        return seg;
    }
    function circleRibbon(cx, cy, r, half) {
        var seg = arcSegments(r);
        var pts = [];
        for (var i = 0; i <= seg; i++) { var th = i / seg * 2 * Math.PI; pts.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]); }
        return offsetPolyline(pts, half);
    }
    function ellipseRibbon(cx, cy, rx, ry, rot, half) {
        var seg = arcSegments(Math.max(rx, ry));
        var pts = [], cr = Math.cos(rot), sr = Math.sin(rot);
        for (var i = 0; i <= seg; i++) {
            var th = i / seg * 2 * Math.PI, x = rx * Math.cos(th), y = ry * Math.sin(th);
            pts.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
        }
        return offsetPolyline(pts, half);
    }
    function wedge(cx, cy, r0, R, th, linePx) {
        var d0 = linePx / (2 * r0), d1 = linePx / (2 * R);
        return [[cx + r0 * Math.cos(th - d0), cy + r0 * Math.sin(th - d0)], [cx + R * Math.cos(th - d1), cy + R * Math.sin(th - d1)], [cx + R * Math.cos(th + d1), cy + R * Math.sin(th + d1)], [cx + r0 * Math.cos(th + d0), cy + r0 * Math.sin(th + d0)]];
    }
    function genFan(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy) + cfg.linePx + cfg.gapSparsePx;
        var r0 = defaultInnerRadius(cfg, R);
        var arc = cfg.fanArcRad || (Math.PI * 2 / 3), base = cfg.dirRad - arc / 2;
        var dtheta = (cfg.linePx + cfg.gapDensePx) / r0, n = Math.max(1, Math.floor(arc / dtheta)), polys = [];
        for (var i = 0; i < n; i++) polys.push(wedge(cx, cy, r0, R, base + arc * i / n, cfg.linePx));
        return polys;
    }
    function genCone(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx;
        var corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]], angs = [], rmin = 1e18, rmax = 0;
        for (var k = 0; k < 4; k++) {
            var dx = corners[k][0] - cx, dy = corners[k][1] - cy, d = Math.sqrt(dx * dx + dy * dy);
            if (d < rmin) rmin = d; if (d > rmax) rmax = d; angs.push(Math.atan2(dy, dx));
        }
        angs.sort(function (a, b) { return a - b; });
        var maxGap = 0, gapStart = 0;
        for (var m = 0; m < 4; m++) {
            var a0 = angs[m], a1 = (m === 3) ? angs[0] + 2 * Math.PI : angs[m + 1];
            var g = a1 - a0; if (g > maxGap) { maxGap = g; gapStart = a0; }
        }
        var span = 2 * Math.PI - maxGap, aMin = gapStart + maxGap;
        var inside = (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
        var rNear = inside ? defaultInnerRadius(cfg, rmax) : rmin;
        if (rNear < cfg.linePx) rNear = cfg.linePx;
        var R = rmax + cfg.linePx + cfg.gapSparsePx;
        var dtheta = (cfg.linePx + cfg.gapDensePx) / rNear, n = Math.max(1, Math.floor(span / dtheta)), polys = [];
        for (var i = 0; i <= n; i++) polys.push(wedge(cx, cy, rNear, R, aMin + span * i / n, cfg.linePx));
        return polys;
    }
    function genSunburst(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy) + cfg.linePx + cfg.gapSparsePx;
        var r0 = defaultInnerRadius(cfg, R);
        var n = cfg.sectorCount || 8, sec = 2 * Math.PI / n, polys = [];
        for (var k = 0; k < n; k++) {
            var gap = (k % 2 === 0) ? cfg.gapDensePx : cfg.gapSparsePx;
            var dtheta = (cfg.linePx + gap) / r0, m = Math.max(1, Math.floor(sec / dtheta)), step = sec / m;
            for (var i = 0; i < m; i++) polys.push(wedge(cx, cy, r0, R, k * sec + i * step, cfg.linePx));
        }
        return polys;
    }
    function genConcentric(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy) + cfg.linePx, polys = [];
        var r = cfg.innerRadiusPx + cfg.linePx / 2, guard = 0; if (r < cfg.linePx) r = cfg.linePx;
        while (r < R && guard < 100000) { polys.push(circleRibbon(cx, cy, r, cfg.linePx / 2)); r += cfg.linePx + cfg.gapMidPx; guard++; }
        return polys;
    }
    function genRipple(b, cfg) {
        var d = cfg.wavePx || 40, polys = [];
        for (var k = -1; k <= 1; k++) {
            var cc = {}; for (var key in cfg) cc[key] = cfg[key];
            cc.cxPx = cfg.cxPx + k * d * Math.cos(cfg.dirRad);
            cc.cyPx = cfg.cyPx + k * d * Math.sin(cfg.dirRad);
            polys = polys.concat(genConcentric(b, cc));
        }
        return polys;
    }
    function genSpiral(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy);
        var a = cfg.innerRadiusPx + cfg.linePx; if (a < cfg.linePx) a = cfg.linePx;
        var grow = (cfg.linePx + cfg.gapMidPx) / (2 * Math.PI), thMax = (R - a) / grow; if (thMax <= 0) return [];
        var steps = 600, pts = [];
        for (var i = 0; i <= steps; i++) { var th = thMax * i / steps, r = a + grow * th; pts.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]); }
        return [offsetPolyline(pts, cfg.linePx / 2)];
    }
    function genVortex(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy);
        var a = cfg.innerRadiusPx + cfg.linePx; if (a < cfg.linePx) a = cfg.linePx;
        var grow = (cfg.linePx + cfg.gapMidPx) / (2 * Math.PI), thMax = (R - a) / grow; if (thMax <= 0) return [];
        var steps = 600, polys = [];
        for (var arm = 0; arm < 2; arm++) {
            var pts = [];
            for (var i = 0; i <= steps; i++) { var th = thMax * i / steps + arm * Math.PI, r = a + grow * (thMax * i / steps); pts.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]); }
            polys.push(offsetPolyline(pts, cfg.linePx / 2));
        }
        return polys;
    }
    function genPetal(b, cfg) {
        var cx = cfg.cxPx, cy = cfg.cyPx, R = maxDistFrom(b, cx, cy) * 0.8;
        var n = cfg.petalCount || 6, w = cfg.ampPx || (cfg.linePx * 3); if (w < cfg.linePx) w = cfg.linePx;
        var polys = [];
        for (var k = 0; k < n; k++) {
            var ang = k * 2 * Math.PI / n;
            polys.push(ellipseRibbon(cx + (R / 2) * Math.cos(ang), cy + (R / 2) * Math.sin(ang), R / 2, w, ang, cfg.linePx / 2));
        }
        return polys;
    }

    /* ---------------- 网格 / 几何 / 材料感纹 ---------------- */
    function genDiamond(b, cfg) { return genFacet(b, withDir(cfg, cfg.dirRad + Math.PI / 4)).concat(genFacet(b, withDir(cfg, cfg.dirRad - Math.PI / 4))); }
    function genTriLattice(b, cfg) { return genFacet(b, withDir(cfg, cfg.dirRad)).concat(genFacet(b, withDir(cfg, cfg.dirRad + Math.PI / 3))).concat(genFacet(b, withDir(cfg, cfg.dirRad - Math.PI / 3))); }
    function hexRibbon(cx, cy, r, half) {
        var pts = [];
        for (var i = 0; i < 6; i++) { var th = Math.PI / 6 + i * Math.PI / 3; pts.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]); }
        pts.push([pts[0][0], pts[0][1]]);
        return offsetPolyline(pts, half);
    }
    function genHex(b, cfg) {
        /* 蜂巢: 格子半径 = 基准间距的 1~4 倍; 六边形按比例内缩, 使相邻六边形之间留出净隙
         * (旧版半径 = wavelength/2 = 6mm, 且相邻六边形共用边会叠线)。 */
        var pitch = cfg.linePx + cfg.gapMidPx;
        var r = unitCellPx(cfg, 1, 4);
        var e = r - (pitch + cfg.linePx / 2) / Math.sqrt(3);   // 内缩量, 格间净距 ≈ 基准净隙(含线宽余量)
        if (e < r * 0.45) e = r * 0.45;
        var half = cfg.linePx / 2, polys = [], dx = Math.sqrt(3) * r, dy = 1.5 * r, row = 0;
        for (var y = b.y0 - dy; y < b.y1 + dy; y += dy) {
            var off = (row % 2) * dx / 2;
            for (var x = b.x0 - dx + off; x < b.x1 + dx; x += dx) polys.push(hexRibbon(x, y, e, half));
            row++;
        }
        return polys;
    }
    /* 三角菱格纹: 正倒三角咬合成菱形, 菱形内再套内缩菱形(更细的线条), 菱形连续铺满区域。
     * 用于卡牌边框/边饰带: 单元 = 基准间距的 3~6 倍; 轮廓按半净隙内缩, 内圈每 2 倍基准间距一圈,
     * 水平对角线在每个内圈顶点处自动断开, 保证处处留出基准净距。 */
    function genDiamondTri(b, cfg) {
        var pitch = cfg.linePx + cfg.gapMidPx;
        var d = unitCellPx(cfg, 3, 6);                                   // 菱形半对角线
        var half = cfg.linePx / 2;
        var innerW = Math.max(cfg.minLinePx || cfg.linePx, cfg.linePx * 0.7);   // 格内细线宽(不低于最小线宽)
        var polys = [], rows = 0, y = b.y0 - d;
        while (y < b.y1 + d) {
            var off = (rows % 2) ? d : 0;
            for (var x = b.x0 - d + off; x < b.x1 + d; x += d * 2) {
                var e = d - pitch / 2;                                   // 轮廓按半净隙内缩, 相邻菱形之间留净距
                if (e < d * 0.3) e = d * 0.3;
                var c = [[x, y - e], [x + e, y], [x, y + e], [x - e, y]];
                polys.push(offsetPolyline(c.concat([c[0]]), half));
                var cuts = [];                                           // 内圈顶点处需要让开的区间
                for (var k = 1; k <= 2; k++) {
                    var ek = e - k * 2 * pitch;
                    if (ek < e * 0.25) break;
                    cuts.push([x - ek - pitch, x - ek + pitch]);
                    cuts.push([x + ek - pitch, x + ek + pitch]);
                    var ck = [[x, y - ek], [x + ek, y], [x, y + ek], [x - ek, y]];
                    polys.push(offsetPolyline(ck.concat([ck[0]]), innerW / 2));
                }
                var segs = [[x - e, x + e]];                             // 正倒三角: 水平对角线(避开内圈)
                for (var ci = 0; ci < cuts.length; ci++) {
                    var keep = [], a0 = cuts[ci][0], a1 = cuts[ci][1];
                    for (var si = 0; si < segs.length; si++) {
                        var s0 = segs[si][0], s1 = segs[si][1];
                        if (a1 <= s0 || a0 >= s1) { keep.push([s0, s1]); continue; }
                        if (a0 > s0) keep.push([s0, a0]);
                        if (a1 < s1) keep.push([a1, s1]);
                    }
                    segs = keep;
                }
                for (var sj = 0; sj < segs.length; sj++) {
                    if (segs[sj][1] - segs[sj][0] < pitch) continue;      // 过短的段不要
                    polys.push(offsetPolyline([[segs[sj][0], y], [segs[sj][1], y]], half));
                }
            }
            y += d; rows++;
        }
        return polys;
    }
    /* 辐射摩尔纹: 2~3 组圆心微错位、相位微错开的放射线族叠加, 线间交叉形成放射状摩尔条纹,
     * 压纹反光时呈现极光式流动感。适合大面积背景/夜空。
     * 未指定内径时: 起始半径按区域大小取 1/4(保证外缘线距不过疏), 内圈用同间距同心圆环
     * 收口 —— 否则中心会留一个半径达区域半径 1/4 的大圆空白(1200ppi 的 BG 层实测半径
     * 583px ≈ 12mm, 直径接近卡宽一半)。显式指定 inner_radius_mm 时按指定值留空, 不加环。 */
    function genMoireRadial(b, cfg) {
        var pitch = cfg.linePx + cfg.gapMidPx;
        var R0 = maxDistFrom(b, cfg.cxPx, cfg.cyPx) + cfg.linePx + cfg.gapSparsePx;
        var autoInner = !(cfg.innerRadiusPx > 0);
        var r0 = autoInner ? Math.max(R0 * 0.25, pitch * 6) : Math.max(cfg.innerRadiusPx, cfg.linePx);
        if (r0 > R0 * 0.7) r0 = R0 * 0.7;
        var dtheta = (cfg.linePx + cfg.gapDensePx) / r0;                 // 内半径处角间距 ≈ 密区中心距
        var n = Math.floor(2 * Math.PI / dtheta);
        if (n < 24) n = 24;
        if (n > 720) n = 720;
        var amp = (cfg.ampPx && cfg.ampPx > 0) ? Math.max(cfg.ampPx, cfg.linePx * 2) : Math.max(cfg.linePx * 3, pitch * 2);   // 圆心错位量 → 决定摩尔条纹疏密
        var groups = [[0, 0], [1, 0], [0.34, 0.94]];
        var polys = [];
        if (autoInner) {
            /* 环形收口: 内圈用与外圈放射线同间距的同心圆环填满, 在 r0 处与射线接上 */
            var ringPitch = cfg.linePx + cfg.gapDensePx, guard = 0;
            for (var rr = ringPitch; rr <= r0 && guard < 5000; rr += ringPitch) {
                polys.push(circleRibbon(cfg.cxPx, cfg.cyPx, rr, cfg.linePx / 2));
                guard++;
            }
        }
        for (var g = 0; g < groups.length; g++) {
            var cx = cfg.cxPx + groups[g][0] * amp, cy = cfg.cyPx + groups[g][1] * amp;
            var Rg = maxDistFrom(b, cx, cy) + cfg.linePx + cfg.gapSparsePx;
            var ph = g / (groups.length * n);                            // 每组相位微错开, 避免完全重合
            for (var i = 0; i < n; i++) {
                var th = (i + ph) * (2 * Math.PI / n);
                var d0 = cfg.linePx / (2 * r0), d1 = cfg.linePx / (2 * Rg);
                polys.push([
                    [cx + r0 * Math.cos(th - d0), cy + r0 * Math.sin(th - d0)],
                    [cx + Rg * Math.cos(th - d1), cy + Rg * Math.sin(th - d1)],
                    [cx + Rg * Math.cos(th + d1), cy + Rg * Math.sin(th + d1)],
                    [cx + r0 * Math.cos(th + d0), cy + r0 * Math.sin(th + d0)]
                ]);
            }
        }
        return polys;
    }
    function genChecker(b, cfg) {
        var cell = cfg.wavePx || 24, polys = [], r = 0;
        for (var y = b.y0; y < b.y1; y += cell) {
            var c2 = 0;
            for (var x = b.x0; x < b.x1; x += cell) {
                var cb = { x0: x, y0: y, x1: Math.min(x + cell, b.x1), y1: Math.min(y + cell, b.y1) };
                var cc = withDir(cfg, cfg.dirRad + (((r + c2) % 2 === 0) ? 0 : Math.PI / 2));
                cc.gradientAxis = 'none'; cc.marginPx = 0;
                polys = polys.concat(genFacet(cb, cc));
                c2++;
            }
            r++;
        }
        return polys;
    }
    function genCarbon(b, cfg) {
        // 网格步距 = 纤维长 + 基准间距(旧版步距 = wavelength = 12mm, 纤维只有 2mm, 中间空一大片)
        var pitch = cfg.linePx + cfg.gapMidPx;
        var L = cfg.segLenPx || (pitch * 4);
        var cell = Math.max(L + pitch, unitCellPx(cfg, 2, 4));
        var polys = [], row = 0;
        var dx = Math.cos(cfg.dirRad) * L, dy = Math.sin(cfg.dirRad) * L;
        for (var y = b.y0; y < b.y1; y += cell) {
            var off = (row % 2) * cell / 2;
            for (var x = b.x0 + off; x < b.x1; x += cell) { var rb = ribbon2(x, y, x + dx, y + dy, cfg.linePx / 2); if (rb) polys.push(rb); }
            row++;
        }
        return polys;
    }
    function genScale(b, cfg) {
        // 单元 = 基准间距的 2~4 倍(旧版 12mm, 鳞片半径 5.4mm, 与其它纹样差一个数量级)
        var cell = unitCellPx(cfg, 2, 4), half = cfg.linePx / 2, polys = [], row = 0;
        for (var y = b.y0; y < b.y1; y += cell * 0.75) {
            var off = (row % 2) * cell / 2;
            for (var x = b.x0 + off; x < b.x1; x += cell) {
                var pts = [];
                for (var i = 0; i <= 16; i++) { var th = Math.PI + Math.PI * i / 16; pts.push([x + cell * 0.36 * Math.cos(th), y + cell * 0.36 * Math.sin(th)]); }
                polys.push(offsetPolyline(pts, half));
            }
            row++;
        }
        return polys;
    }
    function genDash(b, cfg) {
        var p = projections(b, cfg), dash = cfg.segLenPx || 12, gap = cfg.gapSparsePx, polys = [], ss = p.smin;
        while (ss <= p.smax) {
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny, g = gapFor(b, cfg, px, py);
            for (var t = p.tmin; t < p.tmax; t += dash + gap) {
                var e = Math.min(t + dash, p.tmax);
                var rb = ribbon2(px + t * p.dx, py + t * p.dy, px + e * p.dx, py + e * p.dy, cfg.linePx / 2);
                if (rb) polys.push(rb);
            }
            ss += cfg.linePx + g;
        }
        return polys;
    }
    function genDots(b, cfg) {
        /* 点阵: 网格步距 = 基准间距的 2~4 倍(旧版 = wavelength = 12mm);
         * 点半径按网格与净隙自动收敛, 保证相邻点之间留出净距。 */
        var pitch = cfg.linePx + cfg.gapMidPx;
        var cell = unitCellPx(cfg, 2, 4);
        var r = cfg.ampPx || cfg.linePx * 3;
        var rMax = (cell - pitch) / 2 - cfg.linePx / 2;   // 扣掉线宽半宽, 保证相邻点之间留出净距
        if (rMax < cfg.linePx / 2) rMax = cfg.linePx / 2;
        if (r > rMax) r = rMax;
        if (r < cfg.linePx / 2) r = cfg.linePx / 2;
        var half = cfg.linePx / 2, polys = [], row = 0;
        for (var y = b.y0; y < b.y1; y += cell) {
            var off = (row % 2) * cell / 2;
            for (var x = b.x0 + off; x < b.x1; x += cell) polys.push(circleRibbon(x, y, r, half));
            row++;
        }
        return polys;
    }

    /* ---------------- 同心等距轮廓 (contour) ---------------- */
    function signedArea(poly) {
        var a = 0, n = poly.length;
        for (var i = 0; i < n; i++) { var j = (i + 1) % n; a += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
        return a / 2;
    }
    function pointInPoly(pt, poly) {
        var inside = false, n = poly.length, j = n - 1;
        for (var i = 0; i < n; i++) {
            if (((poly[i][1] > pt[1]) !== (poly[j][1] > pt[1])) &&
                (pt[0] < (poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]))
                inside = !inside;
            j = i;
        }
        return inside;
    }
    function resamplePoly(poly, spacing, maxPts) {
        var cap = maxPts || 2000;
        var n = poly.length, i, total = 0, seg = [];
        for (i = 0; i < n; i++) {
            var a = poly[i], b = poly[(i + 1) % n];
            var dx = b[0] - a[0], dy = b[1] - a[1];
            var L = Math.sqrt(dx * dx + dy * dy); seg.push(L); total += L;
        }
        var out = [];
        for (i = 0; i < n; i++) {
            var a = poly[i], b = poly[(i + 1) % n];
            out.push([a[0], a[1]]);
            var L = seg[i], nsub = Math.floor(L / spacing);
            for (var m = 1; m <= nsub; m++) {
                var t = m / (nsub + 1);
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        if (out.length > cap) {
            var count = cap, stepLen = total / count, acc = 0, ei = 0, pts = poly.concat([poly[0]]);
            out = [[poly[0][0], poly[0][1]]];
            for (var m2 = 1; m2 < count; m2++) {
                var target = m2 * stepLen;
                while (ei < n && acc + seg[ei] < target - 1e-9) { acc += seg[ei]; ei++; }
                if (ei >= n) ei = n - 1;
                var t2 = (target - acc) / (seg[ei] || 1); if (t2 < 0) t2 = 0; if (t2 > 1) t2 = 1;
                var aa = pts[ei], bb = pts[ei + 1];
                out.push([aa[0] + (bb[0] - aa[0]) * t2, aa[1] + (bb[1] - aa[1]) * t2]);
            }
        }
        return out;
    }
    function computeOffsets(base) {
        var n = base.length, en = [], i;
        for (i = 0; i < n; i++) {
            var a = base[i], b = base[(i + 1) % n];
            var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.sqrt(dx * dx + dy * dy);
            en.push(l < 1e-9 ? [0, 0] : [-dy / l, dx / l]);
        }
        var eps = 0.5;
        var sign = pointInPoly([base[0][0] + en[0][0] * eps, base[0][1] + en[0][1] * eps], base) ? 1 : -1;
        var offsets = [];
        for (var k = 0; k < n; k++) {
            var np = en[(k - 1 + n) % n], nn = en[k];
            var n1x = np[0] * sign, n1y = np[1] * sign, n2x = nn[0] * sign, n2y = nn[1] * sign;
            var denom = 1 + (n1x * n2x + n1y * n2y);
            if (denom < 0.5) denom = 0.5;   // 尖锐凸角截断为斜接, 避免尖刺
            offsets.push([(n1x + n2x) / denom, (n1y + n2y) / denom]);
        }
        return offsets;
    }
    function genContour(subs, cfg) {
        var polys = [], polyList = [], bestA = 0, refSign = 0, i, j;
        for (i = 0; i < subs.length; i++) {
            var pts = subs[i].entireSubPath, poly = [];
            for (j = 0; j < pts.length; j++) poly.push([pts[j].anchor[0], pts[j].anchor[1]]);
            polyList.push(poly);
        }
        for (i = 0; i < polyList.length; i++) { var a = signedArea(polyList[i]); if (Math.abs(a) > bestA) { bestA = Math.abs(a); refSign = (a >= 0) ? 1 : -1; } }
        if (bestA < 1) return [];
        var half = cfg.linePx / 2, step = cfg.linePx + cfg.gapMidPx, maxRings = 400;
        var maxBase = 400;   // 环基线点数上限(offsetPolyline 后翻倍, 需低于 Photoshop 单子路径 1000 点上限)
        for (i = 0; i < polyList.length; i++) {
            var a = signedArea(polyList[i]); if (a === 0) continue;
            if (((a >= 0) ? 1 : -1) !== refSign) continue;   // 跳过孔洞(反向环)
            if (polyList[i].length < 3) continue;
            var perim = 0;
            for (j = 0; j < polyList[i].length; j++) {
                var pa = polyList[i][j], pb = polyList[i][(j + 1) % polyList[i].length];
                perim += Math.sqrt((pb[0] - pa[0]) * (pb[0] - pa[0]) + (pb[1] - pa[1]) * (pb[1] - pa[1]));
            }
            var spacing = Math.max(0.5, cfg.linePx / 4, perim / maxBase);
            var base = resamplePoly(polyList[i], spacing, maxBase); if (base.length < 3) continue;
            var baseArea = signedArea(base), offsets = computeOffsets(base);
            var d = half, ringCount = 0, prevArea = Math.abs(baseArea);
            while (ringCount < maxRings) {
                var ring = [];
                for (j = 0; j < base.length; j++) ring.push([base[j][0] + offsets[j][0] * d, base[j][1] + offsets[j][1] * d]);
                var ra = signedArea(ring);
                if (ra * baseArea <= 0) break;                       // 反转塌陷
                if (Math.abs(ra) >= prevArea - 1e-6) break;          // 不再收缩
                if (Math.abs(ra) < step * step) break;               // 中心过小
                polys.push(offsetPolyline(ring, half));
                prevArea = Math.abs(ra); d += step; ringCount++;
            }
        }
        return polys;
    }

    /* ---------------- 编排 ---------------- */
    function generate(config) {
        var src = config.sourceDoc;
        var oldUnits = app.preferences.rulerUnits, oldDialogs = app.displayDialogs;
        var master = null, saved = false;
        var report = [];
        var dflt = config.defaults || {};
        var layers = config.layers || [];
        var scale = config.ppi / 25.4;
        var wpx = config.widthPx, hpx = config.heightPx, ppi = config.ppi;
        var ts = stamp();

        function log(m) { report.push(m); }

        var outFolderEarly = new Folder(config.outputDir);
        if (!outFolderEarly.exists) { try { outFolderEarly.create(); } catch (e) {} }
        var progressFile = new File(config.outputDir + '/zg_progress.txt');
        try {
            progressFile.encoding = 'UTF8';
            if (progressFile.open('w')) { progressFile.write('RUN ' + ts + '\n'); progressFile.close(); }
        } catch (e0) {}
        function plog(m) {
            try {
                progressFile.encoding = 'UTF8';
                if (!progressFile.open('a')) { progressFile.open('w'); }
                progressFile.write(String(new Date().getTime()) + '  ' + m + '\n');
                progressFile.close();
            } catch (e) {}
        }

        var stage = '准备';
        try {
            app.preferences.rulerUnits = Units.PIXELS;
            app.displayDialogs = DialogModes.NO;
            plog('环境: Photoshop ' + app.version + ' / ' + app.name + ' / 核心版本 ' + ZG_CORE_VERSION);
            if (src.mode !== DocumentMode.RGB || src.bitsPerChannel !== BitsPerChannelType.EIGHT) log('警告: 源文档非 RGB/8, 母版恒为 RGB/8。');

            /* 取样用的临时文档在开工前建好并全程复用。
             * 逐层新建/关闭文档会在若干层后触发 Photoshop「不能创建新文档…没有足够空间停放」，
             * 之后所有层都会失败；复用同一个文档即可避免，同时更快。 */
            var sampleReuse = { doc: null };
            if (!config.fast) {
                stage = '建立取样临时文档';
                ensureTempDoc(src, sampleReuse);
                plog('取样临时文档已建立(全程复用)');
            }

            stage = '建立母版文档';
            master = app.documents.add(UnitValue(wpx, 'px'), UnitValue(hpx, 'px'), ppi, 'ZG_refraction_master', NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT);
            plog('开始: 图层 ' + layers.length + ' 画布 ' + wpx + 'x' + hpx + '@' + ppi + ' fast=' + (config.fast ? 1 : 0));
            var blank = master.activeLayer;

            var idx = 0, made = 0, failed = [], covered = 0, hiddenCount = 0, readModeLogged = false, nestMethodSeen = 0;
            /* 避免重复生成: 用母版里的一个 Alpha 通道累计"已生成区域"。
             * 每层只生成"本层区域 − 已生成区域"; 列表按子层优先(后序)排列,
             * 因此细节纹样先占位, 组容器/背景层最后只补空隙。保存前删除该通道。 */
            var noOverlap = (config.noOverlap !== false) && !config.fast;
            var usedCh = null, usedBox = null;
            /* 输出组的父子关系: 生成完成后按源图层层级把 ZG_OUT 组嵌进各自的父组。
             * 只做父子级关联, 不建立剪辑蒙版(区域裁切仍由各组自己的矢量蒙版负责)。 */
            var groupByPath = {}, madePaths = [], containerPaths = {};
            /* "不折光"输出组要在存盘前最后再压一次隐藏(见下方说明), 这里记住它们的引用。 */
            var hiddenGroups = [];
            // 预判哪些源路径下面还有"会被生成"的子层: 这些层需要容器组 + 本层纹样子组
            var genPathSet = {};
            for (var gp = 0; gp < layers.length; gp++) {
                if (layers[gp].enabled === false) continue;
                genPathSet[String(layers[gp].source_path || '')] = true;
            }
            function hasGeneratedChild(p) {
                var pre = String(p) + '/';
                for (var k in genPathSet) if (k.indexOf(pre) === 0) return true;
                return false;
            }
            function nearestAncestorGroup(p) {
                var parts = String(p).split('/');
                for (var j = parts.length - 2; j >= 0; j--) {   // 由最近的父级向外找
                    var seg = parts.slice(0, j + 1).join('/');
                    // 只挂进"无蒙版的容器组", 否则父组的区域蒙版会把子组整片裁掉
                    if (containerPaths[seg] && groupByPath[seg]) return groupByPath[seg];
                }
                return null;
            }
            /* 本层没有纹样可放(被先做的层完全覆盖 / 剩余区域只剩碎屑)但下面还有已生成的子层时,
             * 仍建一个空容器组(纯容器允许无蒙版), 让子层按源层级嵌进去; 否则子层会散落在母版顶层。 */
            function keepContainerForChildren(p, hideOutFlag, L2) {
                if (!hasGeneratedChild(p)) return null;
                try {
                    idx++;
                    var cG = master.layerSets.add();
                    cG.blendMode = BlendMode.NORMAL;
                    cG.name = 'ZG_OUT__' + pad3(idx) + '__' + sanitize(L2.output_name || leafName(p));
                    cG.visible = !hideOutFlag;
                    if (hideOutFlag) hiddenGroups.push(cG);
                    groupByPath[p] = cG;
                    madePaths.push(p);
                    containerPaths[p] = true;
                    plog('为子层保留空容器组: ' + cG.name);
                    return cG;
                } catch (eCg) {
                    plog('警告: 空容器组建立失败: ' + (eCg && eCg.message ? eCg.message : String(eCg)));
                    return null;
                }
            }
            function boxHit(a, c) {
                return !!a && !!c && a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0;
            }
            function ensureUsedChannel() {
                if (usedCh) return usedCh;
                try {
                    var first = null;
                    for (var gi = 0; gi < master.layerSets.length && !first; gi++)
                        if (master.layerSets[gi].artLayers.length) first = master.layerSets[gi].artLayers[0];
                    if (!first && master.artLayers.length) first = master.artLayers[0];
                    if (first) master.activeLayer = first;   // 某些版本下当前图层为组时 channels.add 会失败
                    var ch = master.channels.add();
                    ch.name = 'ZG_used_region';
                    master.activeChannels = [master.channels[0], master.channels[1], master.channels[2]];
                    usedCh = ch;
                    plog('已建立区域占用通道 ZG_used_region');
                } catch (e) {
                    usedCh = null; noOverlap = false;
                    plog('警告: 无法建立区域占用通道(' + (e && e.message ? e.message : String(e)) + '), 已关闭「避免重复生成」');
                    log('警告: 无法建立区域占用通道, 已关闭「避免重复生成」');
                }
                return usedCh;
            }
            for (var li = 0; li < layers.length; li++) {
                var L = layers[li];
                var srcPath = L.source_path || '';
                var enabled = L.enabled !== false;
                // 命名含"不折光"(含祖先编组): 照常生成, 生成后把输出组设为隐藏
                var hideOut = isNoRefraction(srcPath);
                if (!enabled) { log('SKIP ' + srcPath); continue; }

                var layer = resolveLayer(src, String(srcPath).split('/'), 0);
                if (!layer) { log('MISSING 未找到图层: ' + srcPath); continue; }

                /* ---- 单层处理开始: 任何一层出错只跳过该层, 不中断整次生成 ---- */
                var group = null;
                try {
                var pattern = L.pattern || dflt.pattern || 'facet';
                var lineMm = num(L.line_mm, num(dflt.line_mm, 0.15));
                var minLineMm = num(L.min_line_mm, num(dflt.min_line_mm, 0.10));
                var gapDenseMm = num(L.gap_dense_mm, num(dflt.gap_dense_mm, 0.12));
                var gapMidMm = num(L.gap_mid_mm, num(dflt.gap_mid_mm, 0.15));
                var gapSparseMm = num(L.gap_sparse_mm, num(dflt.gap_sparse_mm, 0.20));
                if (lineMm < minLineMm) throw new Error(srcPath + ': line_mm ' + lineMm + ' 小于 min_line_mm ' + minLineMm);
                if (!(lineMm > 0)) throw new Error(srcPath + ': 线宽必须大于 0（为 0 会导致纹样步距为 0 而陷入死循环）');
                if (!(gapMidMm > 0)) throw new Error(srcPath + ': 中隙必须大于 0（为 0 会导致纹样步距为 0 而陷入死循环）');
                if (!(gapDenseMm <= gapMidMm && gapMidMm <= gapSparseMm)) throw new Error(srcPath + ': 净隙需 dense<=mid<=sparse');
                var tolPx = num(L.path_tolerance_px, num(dflt.path_tolerance_px, 1.0));

                var cfg = {
                    linePx: lineMm * scale, minLinePx: minLineMm * scale,
                    gapDensePx: gapDenseMm * scale, gapMidPx: gapMidMm * scale, gapSparsePx: gapSparseMm * scale,
                    dirRad: num(L.direction_deg, num(dflt.direction_deg, 0)) * Math.PI / 180,
                    ampPx: num(L.amplitude_mm, num(dflt.amplitude_mm, 0.9)) * scale,
                    wavePx: num(L.wavelength_mm, num(dflt.wavelength_mm, 12)) * scale,
                    segLenPx: num(L.segment_length_mm, num(dflt.segment_length_mm, 2)) * scale,
                    gradientAxis: L.gradient_axis || dflt.gradient_axis || 'none',
                    denseEnd: L.dense_end || dflt.dense_end || 'bottom',
                    branchAngleRad: num(L.branch_angle_deg, num(dflt.branch_angle_deg, 45)) * Math.PI / 180,
                    fanArcRad: num(L.fan_arc_deg, num(dflt.fan_arc_deg, 120)) * Math.PI / 180,
                    sectorCount: Math.max(2, Math.round(num(L.sector_count, num(dflt.sector_count, 8)))),
                    petalCount: Math.max(2, Math.round(num(L.petal_count, num(dflt.petal_count, 6)))),
                    cxPx: resolveCoord(L.center_x, wpx, scale),
                    cyPx: resolveCoord(L.center_y, hpx, scale),
                    innerRadiusPx: num(L.inner_radius_mm, num(dflt.inner_radius_mm, 0)) * scale
                };

                stage = '取样区域: ' + srcPath;
                var subs = getRegionSubs(src, layer, tolPx, config.fast, sampleReuse);
                if (!readModeLogged) { readModeLogged = true; plog('路径读取方式(标定结果): ' + pathReadInfo); }
                plog('[' + (li + 1) + '/' + layers.length + '] ' + srcPath + ' 纹样=' + pattern + ' 区域子路径=' + subs.length);
                if (lastSampleMs) plog('取样明细 ms: 建文档=' + lastSampleMs.doc + ' 复制=' + lastSampleMs.dup + ' 合并=' + lastSampleMs.merge + ' 载入透明度=' + lastSampleMs.load + ' 转路径=' + lastSampleMs.mwp + ' 读路径=' + lastSampleMs.read + ' 合计=' + lastSampleMs.total + ' 读取=' + lastReadMode);
                app.activeDocument = master;
                if (!subs.length) { log('EMPTY 区域为空, 跳过: ' + srcPath); continue; }

                var bb = subsBBox(subs);
                if (!bb || !isFinite(bb[0]) || !isFinite(bb[1]) || !isFinite(bb[2]) || !isFinite(bb[3]) || bb[2] <= bb[0] || bb[3] <= bb[1])
                    throw new Error(srcPath + ': 区域轮廓没有有效锚点');
                if (bb[0] < -wpx || bb[1] < -hpx || bb[2] > wpx * 2 || bb[3] > hpx * 2)
                    throw new Error(srcPath + ': 区域边界异常，疑似坐标单位错误: ' + bb[0] + ',' + bb[1] + '..' + bb[2] + ',' + bb[3]);
                var b = { x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3] };

                /* ---- 扣除已生成区域(子层优先): 只保留本层尚未被占用的部分 ---- */
                var maskSubs = subs;
                if (noOverlap && !hideOut && usedBox && boxHit(b, usedBox) && ensureUsedChannel()) {
                    stage = '扣除已生成区域: ' + srcPath;
                    var tBool = new Date().getTime(), regPathB = null;
                    try {
                        if (subs.length > MAX_SUBPATHS) plog('区域路径按面积截断(相减用): ' + subs.length + ' -> ' + MAX_SUBPATHS + ' 条子路径');
                        regPathB = master.pathItems.add('ZG_temp_bool_' + String(new Date().getTime()), subsPxToPt(master, limitSubs(subs)));
                        regPathB.makeSelection();
                        master.selection.load(usedCh, SelectionType.DIMINISH);
                        var kept = true;
                        try { master.selection.bounds; } catch (eEmptySel) { kept = false; }
                        if (!kept) {
                            try { master.selection.deselect(); } catch (eD0) {}
                            try { regPathB.remove(); } catch (eR0) {}
                            covered++;
                            plog('COVERED 已被先做的层完全覆盖, 跳过: ' + srcPath + ' ms=' + (new Date().getTime() - tBool));
                            log('COVERED 已被先做的层完全覆盖, 跳过: ' + srcPath);
                            keepContainerForChildren(srcPath, hideOut, L);
                            continue;
                        }
                        master.selection.makeWorkPath(Math.max(tolPx, 2.0));   // 蒙版是裁切边界, 用较粗容差显著减少碎片与耗时
                        var clippedSubs = readWorkPathFast(master);
                        if (clippedSubs && clippedSubs.length) maskSubs = clippedSubs;
                        try { master.selection.deselect(); } catch (eD1) {}
                        try {   // 清掉布尔运算留下的工作路径
                            for (var wi = 0; wi < master.pathItems.length; wi++)
                                if (master.pathItems[wi].kind === PathKind.WORKPATH) { master.pathItems[wi].remove(); break; }
                        } catch (eWp) {}
                        try { regPathB.remove(); } catch (eR1) {}
                        regPathB = null;
                        var mb0 = subsBBox(maskSubs);
                        if (mb0 && mb0[2] > mb0[0] && mb0[3] > mb0[1]) b = { x0: mb0[0], y0: mb0[1], x1: mb0[2], y1: mb0[3] };
                        plog('扣除完成: 子路径 ' + subs.length + ' -> ' + maskSubs.length + ' ms=' + (new Date().getTime() - tBool));
                    } catch (eBool) {
                        try { if (regPathB) regPathB.remove(); } catch (eR2) {}
                        try { master.selection.deselect(); } catch (eD2) {}
                        plog('警告: 扣除已生成区域失败, 本层按原区域生成: ' + (eBool && eBool.message ? eBool.message : String(eBool)));
                    }
                }
                /* ---- 蒙版边界简化: 丢掉比纹样还小的碎屑, 并把子路径数压进路径上限 ---- */
                var sim = simplifyMaskSubs(maskSubs, cfg);
                if (sim.dropped) plog('蒙版简化: 子路径 ' + maskSubs.length + ' -> ' + sim.subs.length + ' (丢碎屑 ' + sim.dropped + ', 保留面积 ' + (sim.areaAll > 0 ? Math.round(100 * sim.areaKept / sim.areaAll) : 100) + '%)');
                if (!sim.subs.length) {
                    /* 剩余区域全是放不下一条线的碎屑 —— 本层没有可放纹样的地方。
                     * 若本层下面还有已生成的子层, 仍建一个空容器组(纯容器允许无蒙版)把子层按源层级收进去,
                     * 否则它们会散落在母版顶层、丢掉源文件的层级。 */
                    covered++;
                    plog('COVERED 剩余区域仅碎屑(小于纹样尺度), 跳过本层纹样: ' + srcPath);
                    log('COVERED 剩余区域仅碎屑, 跳过: ' + srcPath);
                    keepContainerForChildren(srcPath, hideOut, L);
                    continue;
                }
                maskSubs = sim.subs;
                var mbSim = subsBBox(maskSubs);
                if (mbSim && mbSim[2] > mbSim[0] && mbSim[3] > mbSim[1]) b = { x0: mbSim[0], y0: mbSim[1], x1: mbSim[2], y1: mbSim[3] };
                plog('bbox ' + b.x0 + ',' + b.y0 + '..' + b.x1 + ',' + b.y1 + ' linePx=' + cfg.linePx + ' gapMid=' + cfg.gapMidPx + ' gapSparse=' + cfg.gapSparsePx + ' dirRad=' + cfg.dirRad);

                var polys;
                stage = '生成纹样: ' + srcPath;
                if (pattern === 'parallel' || pattern === 'facet') polys = genFacet(b, cfg);
                else if (pattern === 'flow') polys = genFlow(b, cfg);
                else if (pattern === 'wave') polys = genWave(b, cfg);
                else if (pattern === 'zigzag') polys = genZigzag(b, cfg);
                else if (pattern === 'chevron') polys = genChevron(b, cfg);
                else if (pattern === 'feather') polys = genFeather(b, cfg);
                else if (pattern === 'herringbone') polys = genHerringbone(b, cfg);
                else if (pattern === 'bilateral_flow') polys = genBilateral(b, cfg);
                else if (pattern === 'meander') polys = genMeander(b, cfg);
                else if (pattern === 'contour' || pattern === 'topographic') polys = genContour(maskSubs, cfg);
                else if (pattern === 'radial') polys = genRadial(b, cfg);
                else if (pattern === 'fan') polys = genFan(b, cfg);
                else if (pattern === 'cone') polys = genCone(b, cfg);
                else if (pattern === 'sunburst') polys = genSunburst(b, cfg);
                else if (pattern === 'concentric') polys = genConcentric(b, cfg);
                else if (pattern === 'ripple') polys = genRipple(b, cfg);
                else if (pattern === 'spiral') polys = genSpiral(b, cfg);
                else if (pattern === 'vortex') polys = genVortex(b, cfg);
                else if (pattern === 'petal_rosette') polys = genPetal(b, cfg);
                else if (pattern === 'diamond_lattice') polys = genDiamond(b, cfg);
                else if (pattern === 'diamond_tri') polys = genDiamondTri(b, cfg);
                else if (pattern === 'moire_radial') polys = genMoireRadial(b, cfg);
                else if (pattern === 'triangle_lattice') polys = genTriLattice(b, cfg);
                else if (pattern === 'hex_lattice') polys = genHex(b, cfg);
                else if (pattern === 'checker') polys = genChecker(b, cfg);
                else if (pattern === 'carbon_fiber') polys = genCarbon(b, cfg);
                else if (pattern === 'scale') polys = genScale(b, cfg);
                else if (pattern === 'dash_field') polys = genDash(b, cfg);
                else if (pattern === 'dot_field') polys = genDots(b, cfg);
                else if (pattern === 'short_curve') polys = genShortCurve(b, cfg);
                else if (pattern === 'interlace' || pattern === 'braid' || pattern === 'cube_iso' || pattern === 'guilloche' || pattern === 'organic_field' || pattern === 'moire_pair' || pattern === 'angle_switch' || pattern === 'density_switch' || pattern === 'latent_image' || pattern === 'image_switch')
                    throw new Error(srcPath + ': 纹样 ' + pattern + ' 为设计意图, 宏内尚未实现, 请按《工作流》手工制作。');
                else throw new Error(srcPath + ': 未知纹样 ' + pattern);

                polys = normalizePolys(polys);   // 压到 Photoshop 单子路径 1000 点上限内
                if (!polys.length) { log('NOLINES 区域过小未产生线, 跳过: ' + srcPath); continue; }

                var plan = planShapeBatches(polys);
                plog('纹样完成: 多边形 ' + polys.length + ' 节点 ' + plan.points);

                idx++;
                var outName = sanitize(L.output_name || leafName(srcPath));
                var groupName = 'ZG_OUT__' + pad3(idx) + '__' + outName;
                group = master.layerSets.add();
                group.name = groupName; group.blendMode = BlendMode.NORMAL;
                /* 若本层下面还有要生成的子层, 本层纹样放进子组, 容器组不放蒙版 ——
                 * 否则容器的区域蒙版会把嵌进来的子层一起裁掉。
                 * 任何一步失败都退回单层结构(不中断该层), 只是该子树不参与父子级嵌套。 */
                var shapeHost = group, containerOK = false;
                if (hasGeneratedChild(srcPath)) {
                    var subG = null;
                    try {
                        subG = master.layerSets.add();
                        subG.blendMode = BlendMode.NORMAL;
                        subG.name = groupName + ' 本层纹样';
                        containerOK = nestGroup(master, subG, group) > 0;
                    } catch (eCg) { containerOK = false; }
                    if (containerOK) { shapeHost = subG; containerPaths[srcPath] = true; nestMethodSeen = nestMethodUsed; }
                    else {
                        try { if (subG) subG.remove(); } catch (eRm) {}
                        plog('警告: 无法建立容器组, 本层按单层结构输出(该层子级不嵌套): ' + srcPath);
                    }
                }
                groupByPath[srcPath] = group;
                madePaths.push(srcPath);
                group.visible = false; // Avoid repeatedly compositing the growing group.

                var cnt = 0;
                plog('开始建形状层, 共 ' + plan.batches.length + ' 批; activeDoc=' + app.activeDocument.name);
                for (var bi = 0; bi < plan.batches.length; bi++) {
                    var batch = plan.batches[bi], batchStarted = new Date().getTime();
                    stage = '建立形状层: ' + srcPath + ' 批 ' + (bi + 1) + '/' + plan.batches.length;
                    plog(stage + ' 节点=' + batch.points + ' 开始');
                    var chunk = polys.slice(batch.start, batch.end);
                    var sh = createSolidShape(master, chunk, outName + '_shape' + (cnt + 1));
                    var sb = sh.layer.bounds;
                    var sl = toNum(sb[0]), stp = toNum(sb[1]), sr = toNum(sb[2]), sbb = toNum(sb[3]);
                    if (sl < -wpx || stp < -hpx || sr > wpx * 2 || sbb > hpx * 2) {
                        try { sh.layer.remove(); } catch (e3) {}
                        throw new Error(srcPath + ': 形状越界，疑似 pixel/point 换算错误: ' + sl + ',' + stp + '..' + sr + ',' + sbb);
                    }
                    sh.layer.move(shapeHost, ElementPlacement.INSIDE);
                    cnt++;
                    plog('批 ' + cnt + ' 完成, ms=' + (new Date().getTime() - batchStarted));
                    chunk = null;
                    $.sleep(10); // Yield between synchronous Photoshop calls.
                }
                plog('形状层完成: ' + cnt + ' 层 (via=shape, vectorMask=1)');

                if (!config.fast) {
                    var regPath = null;
                    try {
                        stage = '建立组矢量蒙版: ' + srcPath;
                        regPath = master.pathItems.add('ZG_temp_region_' + String(new Date().getTime()), subsPxToPt(master, limitSubs(maskSubs)));
                        plog('已加区域路径, 挂组蒙版...');
                        applyVectorMask(master, shapeHost, regPath);
                        if (noOverlap && !hideOut && ensureUsedChannel()) {
                            // 把本层实际占用的区域并入"已生成区域"
                            regPath.makeSelection();
                            try { master.selection.store(usedCh, SelectionType.EXTEND); }
                            catch (eSt) {   // 少数版本不支持带类型的 store, 退回 载入+存储
                                master.selection.load(usedCh, SelectionType.EXTEND);
                                master.selection.store(usedCh);
                            }
                            try { master.selection.deselect(); } catch (eD3) {}
                            var mb1 = subsBBox(maskSubs);
                            if (mb1) usedBox = usedBox
                                ? { x0: Math.min(usedBox.x0, mb1[0]), y0: Math.min(usedBox.y0, mb1[1]), x1: Math.max(usedBox.x1, mb1[2]), y1: Math.max(usedBox.y1, mb1[3]) }
                                : { x0: mb1[0], y0: mb1[1], x1: mb1[2], y1: mb1[3] };
                        }
                        regPath.remove();
                        regPath = null;
                        if (!hasVectorMask(shapeHost)) throw new Error('组矢量蒙版验证失败');
                        plog('组蒙版完成 (vectorMask=1)');
                    } catch (e) {
                        try { if (regPath) regPath.remove(); } catch (e2) {}
                        try { master.selection.deselect(); } catch (eD4) {}
                        throw new Error('区域裁切失败: ' + (e && e.message ? e.message : String(e)));
                    }
                } else {
                    plog('警告: fast=1，仅按矩形边界生成，不用于生产交付');
                }

                group.visible = !hideOut;
                if (hideOut) { hiddenCount++; hiddenGroups.push(group); }
                made++;
                log((hideOut ? 'OK(hidden) ' : 'OK ') + srcPath + ' -> ' + groupName + ' | ' + pattern + ' 线数=' + polys.length + ' 形状层=' + cnt + ' 矢量=是 区域蒙版=' + (!config.fast ? '是' : '否(诊断模式)') + ' 子路径=' + subs.length + ' 蒙版=' + maskSubs.length);
                } catch (layerErr) {
                    var lmsg = (layerErr && layerErr.message) ? layerErr.message : String(layerErr);
                    plog('失败(已跳过该层): ' + srcPath + ' | ' + lmsg);
                    log('FAIL ' + srcPath + ' | ' + lmsg);
                    failed.push(srcPath + ' | ' + lmsg);
                    try { if (group) group.remove(); } catch (e4) {}
                    try { app.activeDocument = master; } catch (e5) {}
                    continue;
                }
                /* ---- 单层处理结束 ---- */
            }

            blank.remove();

            /* ---- 按源图层层级嵌套输出组(只做父子级, 不加剪辑蒙版) ---- */
            var nested = 0, nestFail = 0;
            for (var np = 0; np < madePaths.length; np++) {
                var npPath = madePaths[np], npGroup = groupByPath[npPath];
                if (!npGroup) continue;
                var parentG = nearestAncestorGroup(npPath);
                if (parentG && parentG !== npGroup) {
                    if (nestGroup(master, npGroup, parentG) > 0) { nested++; if (!nestMethodSeen) nestMethodSeen = nestMethodUsed; }
                    else { nestFail++; plog('警告: 组嵌套失败 ' + npPath); }
                }
            }
            // 嵌套后仍为空的容器组: 子层嵌套失败时会留下空组, 结构校验会判「空输出组」, 这里先清掉
            var emptyC = 0;
            for (var eci = 0; eci < madePaths.length; eci++) {
                var eg = groupByPath[madePaths[eci]];
                if (eg && !eg.artLayers.length && !eg.layerSets.length) { try { eg.remove(); emptyC++; } catch (eEc) {} }
            }
            if (emptyC) plog('已清理空容器组: ' + emptyC + ' 个');
            // 清理母版顶层可能残留的散层(嵌套用的临时图层等)
            var strays = 0;
            try {
                while (master.artLayers.length) { master.artLayers[0].remove(); strays++; }
            } catch (eStray) {}
            if (strays) plog('已清理母版顶层散层: ' + strays + ' 个');
            plog('输出组父子级: 已嵌套 ' + nested + ' 组, 失败 ' + nestFail + ' 组, 容器组 ' + (function () { var c = 0; for (var k in containerPaths) c++; return c; })() + ', 嵌套方式=' + nestMethodSeen);

            stage = '母版结构验证';
            var qaShapeCount = validateMasterDoc(master, made, !config.fast, wpx, hpx);
            log('MASTER_QA PASS | 组=' + made + ' 形状层=' + qaShapeCount + ' 全部为黑色填充+矢量蒙版' + (!config.fast ? ' 区域蒙版=完整' : ' 区域蒙版=诊断模式未建立'));

            var outFolder = new Folder(config.outputDir);
            if (!outFolder.exists) outFolder.create();
            var psdFile = new File(outFolder.fsName + '/ZG_master_' + ts + '.psd');
            var opts = new PhotoshopSaveOptions(); opts.layers = true; opts.embedColorProfile = true;
            stage = '保存母版';
            // 先释放取样文档, 降低保存时的内存/暂存压力(大图层保存慢多与此有关)
            if (sampleReuse && sampleReuse.doc) {
                try { sampleReuse.doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eSC0) {}
                sampleReuse.doc = null;
                plog('已关闭取样临时文档');
            }
            if (usedCh) {   // 交付物里不留中间通道
                try { usedCh.remove(); } catch (eCh) {}
                usedCh = null;
                try { master.activeChannels = [master.channels[0], master.channels[1], master.channels[2]]; } catch (eCh2) {}
                plog('已删除区域占用通道 ZG_used_region');
            }
            plog('保存母版...');
            /* 存盘前最后再压一次"不折光"输出组的隐藏状态。
             * PS 2020 实测: 给组(尤其带矢量蒙版的组)设 visible=false 之后, 只要再删过/移过别的图层
             * (母版空白层清理 blank.remove()、嵌套用的临时图层增删、清理散层), 组的 visible 会被
             * 悄悄还原成 true —— 生成时日志写着 OK(hidden), 存出来的母版里这些组却是亮的。
             * 这里在最后统一重设一遍并回读确认, 让"不折光"真正落到交付的 PSD 里。 */
            if (hiddenGroups.length) {
                var hidFail = 0;
                for (var hgi = 0; hgi < hiddenGroups.length; hgi++) {
                    try { hiddenGroups[hgi].visible = false; } catch (eHg) { hidFail++; continue; }
                    try { if (hiddenGroups[hgi].visible) hidFail++; } catch (eHg2) { hidFail++; }
                }
                plog('不折光输出组隐藏确认: ' + (hiddenGroups.length - hidFail) + '/' + hiddenGroups.length + (hidFail ? (' (仍可见 ' + hidFail + ' 组)') : ''));
            }
            master.saveAs(psdFile, opts, false, Extension.LOWERCASE);
            saved = true;
            plog('完成: ' + psdFile.fsName);
            plog('路径读取方式: ' + pathReadInfo + '; 失败层=' + failed.length + '; 被覆盖跳过=' + covered);

            report.unshift('折光纹母版生成报告', '时间: ' + new Date().toString(), '源: ' + src.name,
                '画布: ' + wpx + 'x' + hpx + ' px @ ' + ppi + ' ppi', '输出: ' + psdFile.fsName,
                '生成组数: ' + made, '未生成/跳过: ' + (layers.length - made), '失败层: ' + failed.length,
                '避免重复生成: ' + (config.noOverlap !== false && !config.fast ? '开(子层优先, 被覆盖跳过 ' + covered + ' 层)' : '关'),
                '不折光命名(已生成但隐藏): ' + hiddenCount + ' 组',
                '输出组父子级: 已嵌套 ' + nested + ' 组, 失败 ' + nestFail + ' 组',
                '路径读取方式: ' + pathReadInfo, '');
            var repFile = new File(outFolder.fsName + '/master_report_' + ts + '.txt');
            repFile.encoding = 'UTF8';
            if (repFile.open('w')) { repFile.write('\uFEFF' + report.join('\r\n')); repFile.close(); }

            return { count: made, failed: failed, report: report, psd: psdFile.fsName };
        } catch (e) {
            throw new Error(stage + ' 失败: ' + (e && e.message ? e.message : String(e)));
        } finally {
            if (sampleReuse && sampleReuse.doc) {
                try { sampleReuse.doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eSC) {}
                sampleReuse.doc = null;
            }
            if (master && !saved) master.close(SaveOptions.DONOTSAVECHANGES);
            app.preferences.rulerUnits = oldUnits;
            app.displayDialogs = oldDialogs;
        }
    }

    ZG.generate = generate;
    ZG.collectLayers = collectLayers;
    ZG.suggest = suggest;
    ZG.sanitize = sanitize;
    ZG.num = num;
    ZG.pathReadInfo = function () { return pathReadInfo; };
    /* 仅供 scripts/ 下的自检脚本调用, 不参与生成流程。
     * 用途: 在 Photoshop 里直接跑纯函数自检(不建文档、不生成母版), 见 references/validation.md。 */
    ZG.__selftest = {
        isNoRefraction: isNoRefraction,
        limitSubs: limitSubs,
        simplifyMaskSubs: simplifyMaskSubs,
        subSignedArea: subSignedArea,
        subPerimeter: subPerimeter,
        genMoireRadial: genMoireRadial,
        getRegionSubs: getRegionSubs,
        subsBBox: subsBBox,
        subsPxToPt: subsPxToPt,
        MAX_SUBPATHS: MAX_SUBPATHS
    };
}());
