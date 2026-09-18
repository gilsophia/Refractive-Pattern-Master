/* 折光纹核心库: 几何生成 + 图层构造 + 母版输出。
 * 由 generate_refraction.jsx (job.json 模式) 与 generate_refraction_gui.jsx (手动分配模式) 通过 $.evalFile 共用。
 * 不包含 UI 与 JSON 解析, 只暴露 ZG.generate / ZG.collectLayers 等。 */
var ZG = {};
var ZG_CORE_VERSION = '2026-09-18a';   // 便于在 zg_progress.txt 里确认实际运行的版本

(function () {
    var c = charIDToTypeID, s = stringIDToTypeID;

    /* 进度日志: generate() 会把写文件的实现注册到 plogImpl;
     * 取样等模块级函数(如 getRegionSubs)用 plog 输出诊断, 未注册时静默丢弃。 */
    var plogImpl = null;
    function plog(m) { if (plogImpl) { try { plogImpl(m); } catch (eP) {} } }

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
    /* 图层是否"向下剪贴"到下面一层(剪贴蒙版)。
     * PS 2020 实测: 图层描述符里是布尔键 'group'(不是 'grouped'), 剪贴层为 true、基底为 false。 */
    function isClippedLayer(layer) {
        try {
            var ref = new ActionReference(); ref.putIdentifier(s('layer'), layer.id);
            var d = executeActionGet(ref);
            return d.hasKey(s('group')) && d.getBoolean(s('group'));
        } catch (e) { return false; }
    }
    /* 找剪贴基底: DOM 里 layers[0] 是最上层, 所以"下面一层"是索引增大的方向。
     * 从该层往下找第一个非剪贴层; 同一容器找完还没有, 就向父级继续找(跨组剪贴的少数情况)。 */
    function findClipBase(doc, layer) {
        var chain = [];
        function locate(container) {
            for (var i = 0; i < container.layers.length; i++) {
                var l = container.layers[i];
                if (l.id === layer.id) { chain.push({ c: container, i: i }); return true; }
                if (l.typename === 'LayerSet' && locate(l)) { chain.push({ c: container, i: i }); return true; }
            }
            return false;
        }
        if (!locate(doc)) return null;
        for (var k = 0; k < chain.length; k++) {
            var c0 = chain[k].c, idx = chain[k].i;
            for (var j = idx + 1; j < c0.layers.length; j++) {
                var b = c0.layers[j];
                if (!isClippedLayer(b)) return b;
            }
        }
        return null;
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
     * 不同 Photoshop 版本对「建立: 路径 → 矢量蒙版」的写法差异很大, 依次尝试几种写法,
     * 每种都回读 hasVectorMask 确认真的建出来了才采纳 —— 有的写法(如 At=mask)在 2020 上
     * 不报错但也什么都不建, 只看"没抛异常"会误判成功。全部失败才抛出;
     * 记住首次成功的写法, 后续层不再重复试错。
     * 实测(PS 2020 / 21.2, 目标为组): 写法0(At=vectorMask + Usng=Trgt) 可用且只建矢量蒙版;
     * 写法1(按路径名引用) 报「命令"建立:"当前不可用」; 写法2(At=mask) 无效果。 */
    var vectorMaskMode = -1;
    function applyVectorMask(doc, target, path) {
        var order = vectorMaskMode >= 0 ? [vectorMaskMode, 0, 1, 2] : [0, 1, 2];
        var lastErr = null;
        for (var i = 0; i < order.length; i++) {
            if (i > 0 && order[i] === order[0]) continue;
            try {
                applyVectorMaskOnce(doc, target, path, order[i]);
                if (hasVectorMask(target)) { vectorMaskMode = order[i]; return; }
                lastErr = new Error('写法 ' + order[i] + ' 没有建立矢量蒙版');
            } catch (e) { lastErr = e; }
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
                throw new Error('单区域纹样超过安全预算（60000 条 / 250000 节点），实际 ' + (i + 1) + ' 条 / ' + total + ' 节点；请放大「容差px」、加大线宽净隙或拆成多个区域分次生成；未截断纹样');
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
                out.push({ layer: l, id: l.id, path: p, name: l.name, type: 'LayerSet', kind: 'LayerSet', visible: l.visible, bounds: bnd(l) });
                continue;
            }
            var kind = '';
            try { kind = String(l.kind); } catch (e2) {}
            out.push({ layer: l, id: l.id, path: prefix + l.name, name: l.name, type: l.typename, kind: kind, visible: l.visible, bounds: bnd(l) });
        }
    }
    /* 按图层 ID 在整棵图层树里找层: 名字含 '/' 的层(如中文版自动命名的"色相/饱和度/明度 3")
     * 与同名层都能正确定位 —— 路径字符串只用于显示和人工核对。 */
    function findLayerById(container, id) {
        for (var i = 0; i < container.layers.length; i++) {
            var l = container.layers[i];
            if (l.id === id) return l;
            if (l.typename === 'LayerSet') { var r = findLayerById(l, id); if (r) return r; }
        }
        return null;
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

    /* ---------------- 启发式建议 (本地规则 + 候选集 + 相邻差分) ----------------
     * 每条名字规则给一个"候选集"(按适合度排序), 最终选哪一个由上下文决定:
     *   ctx.used      = { pattern: 已用次数 }   → 同类候选里优先少用过的(全库轮换)
     *   ctx.avoid     = { pattern: true }       → 相邻区域已用的, 优先排除
     *   ctx.avoidFam  = { family: true }        → 相邻区域已用的家族, 次优先排除
     * 这样既保留"名字→语义"的准确度, 又能让每种纹样都有机会被用上, 并且
     * 相邻区块不撞同一种纹样(地图涂色式差分; 家族表把 parallel/facet 这类近亲算一家)。 */
    var PATTERN_FAMILY = {
        parallel: 'linear', facet: 'linear', dash_field: 'linear', carbon_fiber: 'linear',
        zigzag: 'angular', chevron: 'angular', herringbone: 'angular', meander: 'angular', checker: 'angular',
        diamond_lattice: 'lattice', diamond_tri: 'lattice', triangle_lattice: 'lattice', hex_lattice: 'lattice', scale: 'lattice',
        flow: 'flow', content_flow: 'flow', bilateral_flow: 'flow', short_curve: 'flow',
        wave: 'wave', ripple: 'wave',
        fan: 'radial', concentric: 'radial', moire_radial: 'radial', petal_rosette: 'radial', vortex: 'radial',
        contour: 'terrain', topographic: 'terrain',
        dot_field: 'dots'
    };
    /* 名字规则表 (先命中先算). 每项: [正则, {skip/hide} 或 {cands:[...], why}] */
    var SUGGEST_RULES = [
        [/脸|face|皮肤|skin|五官|眼睛|眼|口|鼻|唇/i, { skip: true, why: '面部/五官 → 留白' }],
        [/文字|标题|title|logo|签名|水印|text|字/i, { skip: true, why: '文字/签名 → 通常不加纹' }],
        [/宝石|钻石|钻|水晶|晶石|玉|翡翠|玛瑙|珍珠|猫眼|gem|jewel|ruby|sapphire|emerald|opal|pearl|crystal/i, { cands: ['facet', 'fan', 'moire_radial', 'triangle_lattice', 'concentric'], why: '宝石/水晶' }],
        [/头发|发丝|发束|毛发|hair/i, { cands: ['content_flow', 'flow', 'chevron', 'bilateral_flow', 'short_curve'], why: '头发' }],
        [/云|cloud|烟|smoke|雾|气/i, { cands: ['contour', 'topographic', 'wave', 'vortex', 'short_curve'], why: '云/烟/雾' }],
        [/水|波|浪|海|河|湖|water|wave/i, { cands: ['wave', 'ripple', 'content_flow', 'flow', 'topographic', 'dash_field'], why: '水/波' }],
        [/印花|图案|花样|提花|print|pattern/i, { cands: ['diamond_lattice', 'checker', 'petal_rosette', 'meander', 'scale'], why: '印花/图案' }],
        [/飘带|丝带|衣|布|裙|袖|袍|cloth|fabric|ribbon|带/i, { cands: ['content_flow', 'flow', 'bilateral_flow', 'wave', 'herringbone'], why: '织物/飘带' }],
        [/羽|翅|翼|feather|wing/i, { cands: ['feather', 'chevron', 'bilateral_flow', 'scale'], why: '羽翼' }],
        [/花|花瓣|flower|petal|玫瑰|rose/i, { cands: ['petal_rosette', 'contour', 'flow', 'short_curve'], why: '花卉' }],
        [/光环|光晕|光芒|光线|放射|太阳|日轮|ray|sun|halo|星芒|radial/i, { cands: ['fan', 'moire_radial', 'concentric', 'petal_rosette'], why: '光环/太阳' }],
        [/圆|币|coin|表盘|镜|盘|环|ring/i, { cands: ['concentric', 'petal_rosette', 'ripple', 'moire_radial'], why: '圆/盘/环' }],
        [/边框|框|border|边饰|花边|frame|饰带|菱格|三角/i, { cands: ['diamond_tri', 'meander', 'diamond_lattice', 'dash_field', 'herringbone'], why: '边框/边饰' }],
        [/回纹|迷宫|meander|希腊/i, { cands: ['meander', 'herringbone', 'diamond_tri'], why: '回纹' }],
        [/鳞|鱼鳞|龙鳞|scale|甲/i, { cands: ['scale', 'hex_lattice', 'dot_field'], why: '鳞片' }],
        [/涡|旋|漩涡|spiral|vortex|星云|galaxy/i, { cands: ['vortex', 'moire_radial', 'ripple', 'petal_rosette'], why: '漩涡/星云' }],
        [/科技|机械|电路|机甲|装甲|蜂巢|honey|tech/i, { cands: ['hex_lattice', 'carbon_fiber', 'checker', 'triangle_lattice', 'dash_field'], why: '科技/机械' }],
        [/金属|金饰|银|铜|铁|钢|珠宝|首饰|戒指|项链|盔甲|metal|gold|silver|iron/i, { cands: ['facet', 'parallel', 'dash_field', 'concentric', 'fan'], why: '金属' }],
        [/石|建筑|墙|砖|building|城堡|岩石/i, { cands: ['facet', 'checker', 'parallel', 'triangle_lattice', 'topographic'], why: '建筑/岩石' }],
        [/火|焰|燃烧|flame|fire/i, { cands: ['content_flow', 'flow', 'chevron', 'zigzag', 'vortex', 'wave'], why: '火焰' }],
        [/闪电|雷|山形|zigzag/i, { cands: ['zigzag', 'chevron', 'facet'], why: '闪电/山形' }],
        [/冰|雪|霜|ice|snow|frost/i, { cands: ['facet', 'triangle_lattice', 'diamond_lattice', 'hex_lattice'], why: '冰/雪' }],
        [/木|竹|年轮|木纹|wood|bamboo/i, { cands: ['flow', 'topographic', 'wave', 'parallel'], why: '木/竹' }],
        [/皮革|毛皮|绒|leather|fur/i, { cands: ['scale', 'short_curve', 'dot_field', 'carbon_fiber'], why: '皮革/毛皮' }],
        [/纸|羊皮|书页|paper|parchment/i, { cands: ['topographic', 'short_curve', 'carbon_fiber', 'dash_field'], why: '纸/羊皮纸' }],
        [/陶瓷|瓷|漆|釉|ceramic|porcelain|lacquer/i, { cands: ['concentric', 'petal_rosette', 'meander', 'diamond_tri'], why: '陶瓷/漆器' }],
        [/蕾丝|纱|刺绣|lace|embroidery|tulle/i, { cands: ['meander', 'petal_rosette', 'diamond_lattice', 'short_curve'], why: '蕾丝/刺绣' }],
        [/绳|结|辫|braid|rope|knot/i, { cands: ['flow', 'bilateral_flow', 'wave', 'concentric'], why: '绳结/编织' }],
        [/魔法|法阵|符文|能量|magic|rune|energy/i, { cands: ['concentric', 'petal_rosette', 'ripple', 'vortex'], why: '魔法/能量' }],
        [/地图|地形|山脉|山谷|沙漠|沙丘|map|terrain|dune|mountain/i, { cands: ['topographic', 'contour', 'facet', 'zigzag', 'dot_field'], why: '地图/地形' }],
        [/沙|尘|颗粒|sand|dust/i, { cands: ['dot_field', 'carbon_fiber', 'dash_field', 'wave'], why: '沙/颗粒' }],
        [/玻璃|镜面|反光|glass|mirror/i, { cands: ['diamond_lattice', 'parallel', 'fan', 'triangle_lattice'], why: '玻璃/反光' }],
        [/装饰|花纹|元素|ornament|deco/i, { cands: ['short_curve', 'dot_field', 'petal_rosette', 'diamond_tri', 'dash_field'], why: '装饰元素' }],
        [/阴影|暗部|shadow/i, { cands: ['short_curve', 'dash_field', 'parallel'], why: '阴影/暗部' }],
        [/夜空|星空|星尘|starfield|starry|星/i, { cands: ['dot_field', 'moire_radial', 'vortex', 'dash_field'], why: '星空' }],
        [/极光|aurora|光效|glow/i, { cands: ['moire_radial', 'vortex', 'wave', 'fan'], why: '极光/光效' }],
        [/天空|sky/i, { cands: ['topographic', 'wave', 'parallel', 'dash_field'], why: '天空' }],
        [/纺织|编织|格|棋盘|checker|weave|格子/i, { cands: ['herringbone', 'checker', 'diamond_lattice', 'carbon_fiber', 'meander'], why: '纺织/格子' }],
        [/背景|底|background|bg|大面积/i, { cands: ['parallel', 'facet', 'wave', 'topographic', 'moire_radial', 'dash_field'], why: '背景/大面积' }]
    ];
    function pickCandidate(cands, ctx) {
        var avoid = ctx && ctx.avoid, avoidFam = ctx && ctx.avoidFam, used = ctx && ctx.used;
        var pool = [], i;
        for (i = 0; i < cands.length; i++) if (!(avoid && avoid[cands[i]])) pool.push(cands[i]);
        if (!pool.length) for (i = 0; i < cands.length; i++) pool.push(cands[i]);
        var pool2 = [];
        for (i = 0; i < pool.length; i++) if (!(avoidFam && avoidFam[PATTERN_FAMILY[pool[i]]])) pool2.push(pool[i]);
        if (pool2.length) pool = pool2;
        var best = pool[0], bestUse = used ? (used[best] || 0) : 0;
        for (i = 1; i < pool.length; i++) {
            var u = used ? (used[pool[i]] || 0) : 0;
            if (u < bestUse) { best = pool[i]; bestUse = u; }
        }
        return best;
    }
    function suggest(info, canvasW, canvasH, ctx) {
        var name = String(info.name || '');
        var bd = info.bounds;
        var r = { pattern: 'facet', direction_deg: 0, skip: false, hide: false, reason: '', candidates: null };
        if (isNoRefraction(name)) { r.hide = true; r.reason = '名称含不折光标记 → 照常生成但输出组隐藏'; return r; }
        /* 调整层(色阶/曲线/颜色查找/色相饱和度等)没有自己的像素, 取样必为空, 默认跳过。 */
        var adjKinds = ['LEVELS', 'CURVES', 'COLORLOOKUP', 'HUESATURATION', 'BRIGHTNESSCONTRAST', 'VIBRANCE', 'EXPOSURE', 'COLORBALANCE', 'BLACKANDWHITE', 'PHOTOFILTER', 'CHANNELMIXER', 'INVERSION', 'POSTERIZE', 'THRESHOLD', 'SELECTIVECOLOR', 'GRADIENTMAP'];
        var kindStr = String(info.kind || '').toUpperCase();
        for (var ak = 0; ak < adjKinds.length; ak++) {
            if (kindStr.indexOf(adjKinds[ak]) >= 0) { r.skip = true; r.reason = '调整层 → 无需生成纹样'; return r; }
        }
        var cands = null, why = '', matched = false;
        for (var i = 0; i < SUGGEST_RULES.length; i++) {
            if (SUGGEST_RULES[i][0].test(name)) {
                var rule = SUGGEST_RULES[i][1];
                if (rule.skip) { r.skip = true; r.reason = rule.why; return r; }
                cands = rule.cands; why = rule.why; matched = true; break;
            }
        }
        var w = 0, h = 0;
        if (bd && bd.length === 4) { w = toNum(bd[2]) - toNum(bd[0]); h = toNum(bd[3]) - toNum(bd[1]); }
        var aspect = (w > 0 && h > 0) ? Math.max(w, h) / Math.min(w, h) : 1;
        var areaFrac = (w > 0 && h > 0) ? (w * h) / (canvasW * canvasH) : 0;
        if (!matched && /NORMAL/i.test(String(info.kind || '')) && areaFrac > 0.95) {
            r.skip = true; r.reason = '疑似整图合成/底图层 → 默认跳过'; return r;
        }
        if (!cands) {
            if (aspect > 3) { cands = ['flow', 'content_flow', 'chevron', 'bilateral_flow', 'wave', 'parallel']; why = '细长(长宽比 ' + aspect.toFixed(1) + ')'; }
            else if (areaFrac < 0.03) { cands = ['short_curve', 'dash_field', 'dot_field', 'scale', 'concentric', 'petal_rosette', 'ripple', 'diamond_tri']; why = '小区域'; }
            else if (areaFrac > 0.6) { cands = ['parallel', 'wave', 'topographic', 'moire_radial', 'facet', 'dash_field', 'contour', 'checker']; why = '大面积(占画布 ' + Math.round(areaFrac * 100) + '%)'; }
            else { cands = ['parallel', 'facet', 'diamond_lattice', 'herringbone', 'checker', 'wave', 'zigzag', 'dash_field', 'carbon_fiber', 'meander']; why = '规则区域'; }
        }
        /* 画面证据(可选): 名字没命中时用内容特征选候选; 命中时只补充方向与理由。 */
        var an = info.analysis;
        if (an && an.ok) {
            var ev = '画面走向 ' + Math.round(an.dirDeg) + '°(一致度 ' + an.coherence.toFixed(2) + ', 弯折 ' + an.curvature.toFixed(2) + ', 径向 ' + an.radial.toFixed(2) + ', 细节 ' + an.busy.toFixed(2) + ')';
            if (!matched) {
                if (an.radial > 0.35) { cands = ['fan', 'moire_radial', 'petal_rosette', 'concentric', 'ripple']; why = ev + ' 放射状'; }
                else if (an.radial < -0.35) { cands = ['concentric', 'ripple', 'scale', 'petal_rosette', 'wave']; why = ev + ' 同心状'; }
                else if (an.coherence > 0.5 && an.curvature < 0.22) { cands = ['parallel', 'facet', 'dash_field', 'carbon_fiber', 'checker', 'meander']; why = ev + ' 直纹走势'; }
                else if (an.coherence > 0.35) { cands = ['content_flow', 'flow', 'chevron', 'bilateral_flow', 'wave', 'zigzag']; why = ev + ' 随形走势'; }
                else if (an.busy > 0.18) { cands = ['dot_field', 'short_curve', 'dash_field', 'scale', 'carbon_fiber']; why = ev + ' 细碎纹理'; }
                else { cands = ['topographic', 'contour', 'wave', 'short_curve', 'dot_field']; why = ev + ' 平缓面'; }
            } else {
                why = why + '（' + ev + '）';
            }
        }
        r.candidates = cands;
        r.why = why;
        r.pattern = pickCandidate(cands, ctx);
        r.reason = why + ' → 候选 ' + cands.length + ' 种';
        if (w > 0 && h > 0) r.direction_deg = (an && an.ok) ? Math.round(an.dirDeg) : ((w >= h) ? 0 : 90);
        return r;
    }
    /* 相邻判定: 包围盒重叠或间隙小于 margin(px)。用于"四色式"相邻差分。 */
    function bboxAdjacent(a, b, margin) {
        if (!a || !b || a.length !== 4 || b.length !== 4) return false;
        var ax0 = toNum(a[0]), ay0 = toNum(a[1]), ax1 = toNum(a[2]), ay1 = toNum(a[3]);
        var bx0 = toNum(b[0]), by0 = toNum(b[1]), bx1 = toNum(b[2]), by1 = toNum(b[3]);
        return (ax0 - margin <= bx1) && (bx0 - margin <= ax1) && (ay0 - margin <= by1) && (by0 - margin <= ay1);
    }
    /* 整份图层表一次性建议: 按面积从大到小贪心, 相邻区块尽量不同纹样/不同家族。
     * 返回与 infos 等长的数组; 每项同 suggest 的返回结构。 */
    function suggestAll(infos, canvasW, canvasH) {
        var n = infos.length, i, j;
        var base = [];
        for (i = 0; i < n; i++) base.push(suggest(infos[i], canvasW, canvasH, null));
        var margin = Math.max(8, Math.min(canvasW, canvasH) * 0.02);
        var adj = [];
        for (i = 0; i < n; i++) adj.push([]);
        for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
            if (bboxAdjacent(infos[i].bounds, infos[j].bounds, margin)) { adj[i].push(j); adj[j].push(i); }
        }
        var order = [];
        for (i = 0; i < n; i++) {
            var bd = infos[i].bounds, a = 0;
            if (bd && bd.length === 4) a = Math.max(0, toNum(bd[2]) - toNum(bd[0])) * Math.max(0, toNum(bd[3]) - toNum(bd[1]));
            order.push({ i: i, a: a });
        }
        /* 小区域先选(与生成的"子层优先"一致): 细节元素先占住自己的纹样,
         * 容器/背景这类大块最后补空 —— 避免大容器先把候选锁死, 子层被迫重复。 */
        order.sort(function (x, y) { return x.a - y.a; });
        var used = {}, assigned = [];
        for (i = 0; i < n; i++) assigned.push(null);
        for (var oi = 0; oi < order.length; oi++) {
            var idx = order[oi].i, r = base[idx];
            if (r.skip || r.hide) { assigned[idx] = r; continue; }
            var avoid = {}, avoidFam = {};
            for (j = 0; j < adj[idx].length; j++) {
                var nr = assigned[adj[idx][j]];
                /* 跳过层与"不折光"层不参与视觉避让: 前者无内容, 后者输出隐藏 */
                if (nr && !nr.skip && !nr.hide && nr.pattern) {
                    avoid[nr.pattern] = true;
                    if (PATTERN_FAMILY[nr.pattern]) avoidFam[PATTERN_FAMILY[nr.pattern]] = true;
                }
            }
            var cands = r.candidates || [r.pattern];
            var pick = pickCandidate(cands, { used: used, avoid: avoid, avoidFam: avoidFam });
            r.pattern = pick;
            if (avoid[pick]) r.direction_deg = (r.direction_deg + 45) % 180;   // 实在避不开时换个方向, 至少不同向
            r.reason = (r.why || '') + '；选中 ' + pick + (avoid[pick] ? '（相邻已用同纹样，已换向 45°）' : '');
            used[pick] = (used[pick] || 0) + 1;
            assigned[idx] = r;
        }
        return assigned;
    }
    /* 单层建议(带当前分配上下文): 给 GUI "建议当前层" 用。
     * patterns = 当前每层已选纹样键(与 infos 等长, 可为 null)。 */
    function suggestFor(infos, canvasW, canvasH, k, patterns) {
        var margin = Math.max(8, Math.min(canvasW, canvasH) * 0.02);
        var used = {}, avoid = {}, avoidFam = {};
        for (var i = 0; i < infos.length; i++) {
            if (i === k) continue;
            var p = patterns && patterns[i];
            if (!p) continue;
            used[p] = (used[p] || 0) + 1;
            if (bboxAdjacent(infos[i].bounds, infos[k].bounds, margin)) {
                avoid[p] = true;
                if (PATTERN_FAMILY[p]) avoidFam[PATTERN_FAMILY[p]] = true;
            }
        }
        var r = suggest(infos[k], canvasW, canvasH, { used: used, avoid: avoid, avoidFam: avoidFam });
        if (!r.skip && !r.hide) {
            if (avoid[r.pattern]) r.direction_deg = (r.direction_deg + 45) % 180;
            r.reason = (r.why || '') + '；选中 ' + r.pattern + (avoid[r.pattern] ? '（相邻已用同纹样，已换向 45°）' : '');
        }
        return r;
    }
    var lastReadMode = '', lastSampleMs = null;

    /* ---------------- 画面内容分析 (给建议器/随形流场提供"画面证据") ----------------
     * 流程: 图层复制进一个专用分析文档 → 白底压平 → 缩到 ~96px 长边 → 存 24 位 BMP →
     * 在 ExtendScript 里直接解析 BMP 字节(未压缩, 格式简单) → 算结构张量等特征。
     * 全程不碰源文档; 分析文档建一次复用, 每层用完缩回原尺寸。
     * 特征: 主走向(线方向)/方向一致度/弯折度/径向性/细节密度/内容占比 + 8x8 粗角度场。 */
    function readBMP(f) {
        try { f.encoding = 'BINARY'; } catch (eEnc) {}   // 二进制必须显式 BINARY, 默认编码会读出空串
        if (!f.open('r')) return null;
        var s = f.read();
        f.close();
        if (!s || s.length < 54) return null;
        function u8(i) { return s.charCodeAt(i) & 0xff; }
        function u16(i) { return u8(i) | (u8(i + 1) << 8); }
        function u32(i) { return (u8(i) | (u8(i + 1) << 8) | (u8(i + 2) << 16)) + u8(i + 3) * 16777216; }
        if (u8(0) !== 66 || u8(1) !== 77) return null;
        var off = u32(10), w = u32(18), h = u32(22), bpp = u16(28);
        var topDown = (h < 0);
        if (topDown) h = -h;
        if (bpp !== 24 && bpp !== 32) return null;
        if (w <= 0 || h <= 0 || off + w * h * (bpp / 8) > s.length + 4) return null;
        var bpr = (((w * bpp / 8) + 3) >> 2) << 2;
        var lum = new Array(w * h), alpha = (bpp === 32) ? new Array(w * h) : null;
        for (var y = 0; y < h; y++) {
            var row = off + (topDown ? y : (h - 1 - y)) * bpr;
            for (var x = 0; x < w; x++) {
                var p = row + x * (bpp / 8), i = y * w + x;
                lum[i] = (u8(p + 2) * 299 + u8(p + 1) * 587 + u8(p) * 114) / 1000;
                if (alpha) alpha[i] = u8(p + 3);
            }
        }
        return { w: w, h: h, lum: lum, alpha: alpha };
    }
    function computeFeatures(img) {
        var w = img.w, h = img.h, lum = img.lum, alpha = img.alpha, n = w * h;
        var i, x, y;
        /* 信号 = 内容按透明度合成到中灰(浅色/深色内容都能出现梯度), 再按内容范围拉伸对比度
         * (稀疏细纹理降采样后只剩几个灰阶, 不拉伸就全是"空")。 */
        var sig = new Array(n), lo = 255, hi = 0, cov = 0;
        for (i = 0; i < n; i++) {
            var av = alpha ? alpha[i] : 255;
            var s = (lum[i] * av + 128 * (255 - av)) / 255;
            sig[i] = s;
            if (!alpha || av > 12) { if (s < lo) lo = s; if (s > hi) hi = s; if (av > 12) cov++; }
        }
        var rng = hi - lo;
        if (rng < 6) { lo = 0; rng = 255; }   // 近似平色: 不做拉伸(避免放大噪点)
        for (i = 0; i < n; i++) {
            var v = (sig[i] - lo) * 255 / rng;
            sig[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
        }
        /* 梯度 + 每像元"双角向量"(cos2θ, sin2θ), 纯算术无三角函数:
         * θ 为线方向; 由梯度 (dx,dy) 得 cos2θ = (dy²−dx²)/m², sin2θ = −2dxdy/m²。
         * 全局走向、分块弯折、8x8 角度场都由这些向量加权求和得到。 */
        var NC = 8;
        var gm = new Array(n), c2 = new Array(n), s2 = new Array(n);
        var cellC = new Array(NC * NC), cellS = new Array(NC * NC), cellW = new Array(NC * NC);
        for (i = 0; i < n; i++) { gm[i] = 0; c2[i] = 0; s2[i] = 0; }
        for (i = 0; i < NC * NC; i++) { cellC[i] = 0; cellS[i] = 0; cellW[i] = 0; }
        var E = 0, edgeN = 0, C2 = 0, S2 = 0;
        for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
            i = y * w + x;
            var tl = sig[i - w - 1], t = sig[i - w], tr = sig[i - w + 1];
            var l = sig[i - 1], r = sig[i + 1];
            var bl = sig[i + w - 1], b = sig[i + w], br = sig[i + w + 1];
            var dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
            var dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
            var m2 = dx * dx + dy * dy, mag = Math.sqrt(m2);
            gm[i] = mag;
            if (mag > 60) edgeN++;
            E += mag;
            if (m2 > 1e-6) {
                var c2a = (dy * dy - dx * dx) / m2, s2a = -2 * dx * dy / m2;
                c2[i] = c2a; s2[i] = s2a;
                C2 += mag * c2a; S2 += mag * s2a;
                var ci = Math.min(NC - 1, Math.floor(y * NC / h)) * NC + Math.min(NC - 1, Math.floor(x * NC / w));
                cellC[ci] += mag * c2a; cellS[ci] += mag * s2a; cellW[ci] += mag;
            }
        }
        var coherence = (E > 1e-9) ? (Math.sqrt(C2 * C2 + S2 * S2) / E) : 0;
        var dirDeg = ((0.5 * Math.atan2(S2, C2) * 180 / Math.PI) % 180 + 180) % 180;
        /* 径向性: 线方向与"从质心向外"的双角余弦加权平均; >0 放射, <0 同心。
         * cos2(θ−φ) = c2θ·cos2φ + s2θ·sin2φ, 其中 cos2φ/sin2φ 由相对质心的向量直接算出。 */
        var cxw = 0, cyw = 0, W2 = 0;
        for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
            i = y * w + x;
            if (gm[i] > 30) { cxw += x * gm[i]; cyw += y * gm[i]; W2 += gm[i]; }
        }
        var cxm = cxw / (W2 || 1), cym = cyw / (W2 || 1);
        var radSum = 0, radW = 0;
        for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
            i = y * w + x;
            if (gm[i] <= 30) continue;
            var px = x - cxm, py = y - cym, r2 = px * px + py * py;
            if (r2 < 1) continue;
            radSum += gm[i] * (c2[i] * ((px * px - py * py) / r2) + s2[i] * (2 * px * py / r2));
            radW += gm[i];
        }
        var radial = radSum / (radW || 1);
        /* 弯折度: 8x8 分块主方向在相邻块间的平均转角(弧度) */
        var curvSum = 0, curvN = 0;
        for (var cy2 = 0; cy2 < NC; cy2++) for (var cx2 = 0; cx2 < NC; cx2++) {
            var ciA = cy2 * NC + cx2;
            if (cellW[ciA] < 1) continue;
            var nbs = [[cx2 + 1, cy2], [cx2, cy2 + 1]];
            for (var nb = 0; nb < 2; nb++) {
                if (nbs[nb][0] >= NC || nbs[nb][1] >= NC) continue;
                var ciB = nbs[nb][1] * NC + nbs[nb][0];
                if (cellW[ciB] < 1) continue;
                var tA = 0.5 * Math.atan2(cellS[ciA], cellC[ciA]), tB = 0.5 * Math.atan2(cellS[ciB], cellC[ciB]);
                var dth = Math.abs(tA - tB);
                while (dth > Math.PI / 2) dth = Math.abs(dth - Math.PI);
                curvSum += dth; curvN++;
            }
        }
        /* 8x8 粗角度场(供随形流线用): 只覆盖有内容(梯度)的范围 */
        var bx0 = w, by0 = h, bx1 = 0, by1 = 0;
        for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
            if (gm[y * w + x] > 30) {
                if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
                if (y < by0) by0 = y; if (y > by1) by1 = y;
            }
        }
        var field = null;
        if (bx1 > bx0 && by1 > by0) {
            var NF = 8;
            field = { nx: NF, ny: NF, x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1, cos2: [], sin2: [], w: [] };
            for (var fi = 0; fi < NF * NF; fi++) { field.cos2.push(0); field.sin2.push(0); field.w.push(0); }
            var fw = bx1 - bx0 + 1, fh = by1 - by0 + 1;
            for (y = by0; y <= by1; y++) for (x = bx0; x <= bx1; x++) {
                i = y * w + x;
                if (gm[i] <= 30) continue;
                var fidx = Math.min(NF - 1, Math.floor((y - by0) * NF / fh)) * NF + Math.min(NF - 1, Math.floor((x - bx0) * NF / fw));
                field.cos2[fidx] += gm[i] * c2[i];
                field.sin2[fidx] += gm[i] * s2[i];
                field.w[fidx] += gm[i];
            }
        }
        return {
            ok: true,
            dirDeg: dirDeg,
            coherence: coherence,
            curvature: curvN ? (curvSum / curvN) : 0,
            radial: radial,
            busy: n ? (edgeN / n) : 0,
            fill: n ? (cov / n) : 0,
            w: w, h: h,
            field: field
        };
    }
    function analyzeLayer(srcDoc, layer, reuse) {
        var prevDoc = app.activeDocument, oldUnits = app.preferences.rulerUnits;
        var out = { ok: false };
        var tAll = new Date().getTime(), tLast = tAll, msAcc = {};
        function tick(k) { var now = new Date().getTime(); msAcc[k] = now - tLast; tLast = now; }
        try {
            app.preferences.rulerUnits = Units.PIXELS;
            var W = srcDoc.width.as('px'), H = srcDoc.height.as('px');
            var doc = (reuse && reuse.doc) ? reuse.doc : null;
            if (!doc) {
                doc = app.documents.add(srcDoc.width, srcDoc.height, srcDoc.resolution, 'ZG_analyze_sample', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
                if (reuse) reuse.doc = doc;
            } else {
                app.activeDocument = doc;
                if (Math.round(doc.width.as('px')) !== Math.round(W) || Math.round(doc.height.as('px')) !== Math.round(H))
                    doc.resizeImage(W, H, doc.resolution, ResampleMethod.BILINEAR);
            }
            tick('prep');
            app.activeDocument = doc;
            var base = resetTempDoc(doc);
            if (!base) throw new Error('分析文档复位失败');
            /* 中灰底: 深色/浅色/半透明内容合成后都会偏离中灰, 配合对比度拉伸都能出梯度;
             * 白底会把浅色内容(高光层)和稀疏细纹洗掉, 黑底则丢掉深色内容。 */
            var gray = new SolidColor(); gray.rgb.hexValue = '808080';
            doc.selection.selectAll(); doc.selection.fill(gray); doc.selection.deselect();
            tick('resetFill');
            app.activeDocument = srcDoc;
            var dup = layer.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
            tick('dup');
            app.activeDocument = doc;
            dup.visible = true;
            try { doc.mergeVisibleLayers(); } catch (eM) {}
            tick('merge');
            var longSide = Math.max(W, H), sc = 128 / longSide;
            var aw = Math.max(8, Math.round(W * sc)), ah = Math.max(8, Math.round(H * sc));
            doc.resizeImage(aw, ah, doc.resolution, ResampleMethod.BILINEAR);
            tick('resizeDown');
            var bmp = new File(Folder.temp.fsName + '/ZG_analyze_' + String(new Date().getTime()) + '.bmp');
            var opts = new BMPSaveOptions();
            opts.alphaChannels = false;   // PS 的 32 位 BMP alpha 字节恒为 0, 透明度改用中灰底表达
            try { opts.depth = BMPDepthType.TWENTYFOUR; } catch (eD) {}
            opts.rleCompression = false;
            opts.flipRowOrder = false;
            doc.saveAs(bmp, opts, true);
            tick('save');
            var img = readBMP(bmp);
            tick('read');
            try { bmp.remove(); } catch (eR) {}
            doc.resizeImage(W, H, doc.resolution, ResampleMethod.BILINEAR);
            tick('resizeUp');
            if (img) {
                var f = computeFeatures(img);
                tick('compute');
                f.scale = W / aw;                      // 分析图 → 画布像素
                if (f.field) {
                    f.field.x0 *= f.scale; f.field.y0 *= f.scale;
                    f.field.x1 *= f.scale; f.field.y1 *= f.scale;
                }
                out = f;
            }
            tick('total');
            out.ms = msAcc;
        } catch (e) {
            out.ok = false; out.err = (e && e.message) ? e.message : String(e);
        } finally {
            try { app.activeDocument = prevDoc; } catch (eF) {}
            app.preferences.rulerUnits = oldUnits;
        }
        return out;
    }

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
            /* 剪贴蒙版(向下剪贴)的图层: 单独复制到临时文档会因失去基底而渲染为空(001 实测:
             * 二分1/高光1/高光2/图层 4 等 5 个剪贴层全部被判 EMPTY)。
             * 正确区域 = 该层自身透明通道(不受剪贴影响) ∩ 剪贴基底渲染出的可见 alpha。
             * 剪贴关系用 ActionManager 的布尔键 'group' 判断(PS 2020 实测, 不是 'grouped')。
             * 注意: ActionManager 的图层引用只在当前文档里解析, 上面刚建/复位过临时文档,
             * 必须先切回源文档再判断, 否则 id 对不上会被误判成非剪贴层。 */
            app.activeDocument = doc;
            var clipped = isClippedLayer(layer), clipBase = null;
            if (clipped) {
                clipBase = findClipBase(doc, layer);
                if (!clipBase) { plog('剪贴层找不到剪贴基底, 按不可见处理: ' + layer.name); return []; }
                if (!clipBase.visible) { plog('剪贴基底不可见, 按不可见处理: ' + layer.name + ' ← ' + clipBase.name); return []; }
                plog('剪贴层识别: ' + layer.name + ' ← 基底 ' + clipBase.name);
            }
            stage = '复制待取样图层';
            /* 大面积高分辨率软渐变层(如布料阴影)的 alpha 阈值轮廓极其琐碎, makeWorkPath 可能
             * 几十分钟不返回(010 实测 1200ppi 的 blouse-shade and light 卡住 15 分钟以上)。
             * 对"大层 + 高分辨率"在转路径前先做 1–2px 高斯模糊磨平轮廓: 路径点少几个数量级,
             * 区域蒙版只差零点几毫米(1200ppi 下 2px ≈ 0.04mm), 肉眼与工艺都可忽略。 */
            var blurR = 0;
            try {
                var lb = layer.bounds;
                var lw = toNum(lb[2]) - toNum(lb[0]), lh = toNum(lb[3]) - toNum(lb[1]);
                if (lw > 800 && lh > 800 && doc.resolution >= 600) {
                    blurR = doc.resolution >= 900 ? 2 : 1;
                    if (tol < blurR) tol = blurR;   // 大层高分辨率时路径容差同步放宽, 进一步减少锚点
                    plog('取样: 大层@' + doc.resolution + 'ppi, 转路径前高斯模糊 ' + blurR + 'px 平滑轮廓');
                }
            } catch (eLB) {}
            var copied = layer.duplicate(temp, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = temp;
            copied.visible = true;
            tDup = new Date().getTime();
            var raster = null;
            if (clipped) {
                stage = '读取剪贴层自身透明度';
                if (blurR) { try { copied.applyGaussianBlur(blurR); } catch (eB1) {} }
                loadTransparency(temp, copied);
                try { temp.selection.bounds; } catch (eEmptyClip) { return []; }
                var regionCh = temp.channels.add();
                regionCh.name = 'ZG_clip_region';
                temp.selection.store(regionCh);
                stage = '渲染剪贴基底';
                try { resetTempDoc(temp); } catch (eRT) {}
                app.activeDocument = doc;
                var baseCopy = clipBase.duplicate(temp, ElementPlacement.PLACEATBEGINNING);
                app.activeDocument = temp;
                baseCopy.visible = true;
                try { temp.mergeVisibleLayers(); raster = temp.activeLayer; }
                catch (eMerge2) {
                    raster = baseCopy;
                    plog('警告: 剪贴基底 mergeVisibleLayers 失败, 改用复制图层本身: ' + (eMerge2 && eMerge2.message ? eMerge2.message : String(eMerge2)));
                }
                tMerge = new Date().getTime();
                var rb2 = raster.bounds;
                if (toNum(rb2[2]) <= toNum(rb2[0]) || toNum(rb2[3]) <= toNum(rb2[1])) { try { regionCh.remove(); } catch (eC0) {} return []; }
                stage = '载入剪贴基底透明度';
                if (blurR) { try { raster.applyGaussianBlur(blurR); } catch (eB2) {} }
                loadTransparency(temp, raster);
                temp.selection.load(regionCh, SelectionType.INTERSECT);
                try { regionCh.remove(); } catch (eC1) {}
            } else {
                stage = '渲染图层及蒙版';
                // 透明底 + 复制来的图层, 用 mergeVisibleLayers 渲染文字/智能对象/组/图层样式, 不碰源文档。
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
                if (blurR) { try { raster.applyGaussianBlur(blurR); } catch (eB3) {} }
                loadTransparency(temp, raster);
            }
            var bd;
            try { bd = temp.selection.bounds; } catch (emptySelection) { return []; }
            if (toNum(bd[2]) <= toNum(bd[0]) || toNum(bd[3]) <= toNum(bd[1])) return [];
            tLoad = new Date().getTime();
            stage = '把选区转换为工作路径';
            plog('取样: 选区→工作路径(tol=' + tol + ') 开始...');
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
        var bx0 = 1e18, by0 = 1e18, bx1 = -1e18, by1 = -1e18;
        for (var i = 0; i < n; i++) {
            var prev = points[i === 0 ? 0 : i - 1], next = points[i === n - 1 ? n - 1 : i + 1];
            var dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.sqrt(dx * dx + dy * dy);
            var nx, ny;
            if (len < 1e-6) { nx = 0; ny = 1; } else { nx = -dy / len; ny = dx / len; }
            var ax = points[i][0] + nx * half, ay = points[i][1] + ny * half;
            var cx2 = points[i][0] - nx * half, cy2 = points[i][1] - ny * half;
            top.push([ax, ay]);
            bot.push([cx2, cy2]);
            if (ax < bx0) bx0 = ax; if (ax > bx1) bx1 = ax;
            if (ay < by0) by0 = ay; if (ay > by1) by1 = ay;
            if (cx2 < bx0) bx0 = cx2; if (cx2 > bx1) bx1 = cx2;
            if (cy2 < by0) by0 = cy2; if (cy2 > by1) by1 = cy2;
        }
        var poly = top.slice(0);
        for (var j = bot.length - 1; j >= 0; j--) poly.push(bot[j]);
        poly._bb = [bx0, by0, bx1, by1];   // 顺手记录包围盒, 区域裁剪时免去逐点扫描
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
    /* 随形流场: 沿画面分析得到的 8x8 角度场积分出流线, 方向随内容无缝变化;
     * 累计转角超阈值时收尾另起一段(留一个疏隙), 得到"分段走势"而不是长线乱拐。
     * cfg.flowField = { nx, ny, x0, y0, x1, y1, cos2[], sin2[], w[] } (画布像素);
     * 没有场时退回普通 genFlow。 */
    function genContentFlow(b, cfg) {
        var F = cfg.flowField;
        if (!F || !F.nx || !F.ny || !F.cos2) return genFlow(b, cfg);
        var pitch = cfg.linePx + cfg.gapMidPx;
        /* 密度与 flow 对齐: 占位格 = 目标中心距(线宽+中隙, 与 flow 默认间距一致), 种子按 0.6 格布点,
         * 这样相邻流线的中心距能贴近 pitch, 而不是被更大的格子量化成稀疏结果。 */
        var cell = Math.max(pitch, cfg.linePx * 1.5);
        var seedStep = cell * 0.5;
        function dirAt(x, y) {
            var u = (x - F.x0) / (F.x1 - F.x0) * (F.nx - 1);
            var v = (y - F.y0) / (F.y1 - F.y0) * (F.ny - 1);
            if (u < 0) u = 0; if (u > F.nx - 1) u = F.nx - 1;
            if (v < 0) v = 0; if (v > F.ny - 1) v = F.ny - 1;
            var x0 = Math.floor(u), y0 = Math.floor(v);
            var x1 = Math.min(F.nx - 1, x0 + 1), y1 = Math.min(F.ny - 1, y0 + 1);
            var fx = u - x0, fy = v - y0;
            var i00 = y0 * F.nx + x0, i10 = y0 * F.nx + x1, i01 = y1 * F.nx + x0, i11 = y1 * F.nx + x1;
            var c = F.cos2[i00] * (1 - fx) * (1 - fy) + F.cos2[i10] * fx * (1 - fy) + F.cos2[i01] * (1 - fx) * fy + F.cos2[i11] * fx * fy;
            var s = F.sin2[i00] * (1 - fx) * (1 - fy) + F.sin2[i10] * fx * (1 - fy) + F.sin2[i01] * (1 - fx) * fy + F.sin2[i11] * fx * fy;
            if (Math.abs(c) + Math.abs(s) < 1e-9) return cfg.dirRad;
            return 0.5 * Math.atan2(s, c);
        }
        var gx0 = Math.floor(b.x0 / cell) - 1, gy0 = Math.floor(b.y0 / cell) - 1;
        var gx1 = Math.ceil(b.x1 / cell) + 1, gy1 = Math.ceil(b.y1 / cell) + 1;
        var gw = gx1 - gx0 + 1;
        var occ = new Array(gw * (gy1 - gy0 + 1));
        for (var oi = 0; oi < occ.length; oi++) occ[oi] = 0;
        function mark(x, y) {
            var cx = Math.floor(x / cell) - gx0, cy = Math.floor(y / cell) - gy0;
            if (cx >= 0 && cy >= 0 && cx < gw && cy < gy1 - gy0 + 1) occ[cy * gw + cx] = 1;
        }
        function isOcc(x, y) {
            var cx = Math.floor(x / cell) - gx0, cy = Math.floor(y / cell) - gy0;
            if (cx < 0 || cy < 0 || cx >= gw || cy >= gy1 - gy0 + 1) return false;
            return occ[cy * gw + cx] === 1;
        }
        /* 只在"左右一格内都没有线"的空区起笔(沿流向方向不限制):
         * 避免贴着已有流线起笔、一迈步就被截成小点; 又不至于像 3x3 检查那样把密度压太低。 */
        function openArea(x, y) {
            var a = dirAt(x, y);
            var px2 = -Math.sin(a) * cell * 0.4, py2 = Math.cos(a) * cell * 0.4;
            return !isOcc(x + px2, y + py2) && !isOcc(x - px2, y - py2);
        }
        var polys = [], guard = 0;
        var traceStep = Math.max(cfg.linePx * 0.8, cell * 0.3);
        /* 从种子点向两个方向各追一条, 拼成整条流线; 累计转角超约 90° 或撞到已占位就收尾
         * (收尾处自然留缝, 网格上后续种子会从缝里再起一段 —— 这就是"无缝分段走势")。 */
        function traceOne(sx, sy, sgn) {
            var pts = [], x = sx, y = sy, prevA = dirAt(sx, sy), cum = 0;
            for (var step = 0; step < 600; step++) {
                var a = dirAt(x, y);
                var dA = a - prevA;
                while (dA > Math.PI / 2) dA -= Math.PI;
                while (dA < -Math.PI / 2) dA += Math.PI;
                if (Math.abs(dA) > 0.9) break;                     // 方向突变: 视为边界
                var nx2 = x + sgn * Math.cos(a) * traceStep, ny2 = y + sgn * Math.sin(a) * traceStep;
                if (nx2 < b.x0 - pitch || nx2 > b.x1 + pitch || ny2 < b.y0 - pitch || ny2 > b.y1 + pitch) break;
                if (isOcc(nx2, ny2)) break;                        // 已占位: 收尾, 不撞线
                x = nx2; y = ny2; prevA = a;
                pts.push([x, y]);
                cum += Math.abs(dA);
                if (cum > Math.PI * 0.8) break;                    // 分段: 本段到此为止(放宽阈值, 线更长更连贯)
            }
            return pts;
        }
        for (var sy = b.y0 + seedStep * 0.5; sy < b.y1 && guard < 20000; sy += seedStep) {
            for (var sx = b.x0 + seedStep * 0.5; sx < b.x1 && guard < 20000; sx += seedStep) {
                if (isOcc(sx, sy) || !openArea(sx, sy)) continue;
                var back = traceOne(sx, sy, -1);
                back.reverse();
                var line = back.concat([[sx, sy]], traceOne(sx, sy, 1));
                if (line.length < 3) continue;   // 太短就不画、也不占位, 让邻格种子把空隙补上
                for (var mi = 0; mi < line.length; mi++) mark(line[mi][0], line[mi][1]);
                polys.push(offsetPolyline(line, cfg.linePx / 2));
                guard++;
            }
        }
        return polys.length ? polys : genFlow(b, cfg);
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
        var cell = unitCellPx(cfg, 1, 2.5);
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
    function genShortCurve(b, cfg) {
        var L = cfg.segLenPx, w = cfg.linePx;
        if (!(L > 0 && w > 0)) throw new Error('short_curve: 线长和线宽必须大于零');
        var p = projections(b, cfg), polys = [];
        var gap = cfg.gapDensePx;
        // Keep one continuous wave phase, but stagger the short segments by half
        // a cell on alternate rows so the column seams never align into empty bands.
        var cut = w + gap, cell = L + cut;
        var bend = Math.min(Math.abs(cfg.ampPx), L * 0.30);
        var slope = Math.PI * bend / cell;
        var pitch = (w + cfg.gapMidPx) * Math.sqrt(1 + slope * slope);
        // This Lipschitz bound guarantees normal clearance between translated
        // curves, even at the steepest part of a wave. Length no longer sets pitch.
        for (var ss = p.smin - bend, row = 0; ss <= p.smax + bend; ss += pitch, row++) {
            var phase = (row % 2) * cell / 2;
            var first = Math.floor((p.tmin - phase) / cell) - 1;
            var last = Math.ceil((p.tmax - phase) / cell) + 1;
            for (var j = first; j < last; j++) {
                var pts = [];
                for (var k = 0; k <= 24; k++) {
                    var t = j * cell + phase + cut / 2 + L * k / 24;
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
    /* 中心类纹样的起始半径按线宽与净隙推导，避免只生成少数射线。 */
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
        var poly = offsetPolyline(pts, half);
        poly._bb = [cx - r - half, cy - r - half, cx + r + half, cy + r + half];
        return poly;
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
        var target = cfg.linePx + cfg.gapDensePx;
        var n = Math.max(1, Math.floor(arc * r0 / target)), step = arc / n, polys = [];
        function fill(a0, a1, depth) {
            if (depth >= 8) return;
            var mid = (a0 + a1) / 2;
            // A new branch starts where its nearest neighbour has enough room.
            var start = Math.max(r0, 2 * target / (a1 - a0));
            if (start >= R) return;
            polys.push(wedge(cx, cy, start, R, mid, cfg.linePx));
            fill(a0, mid, depth + 1);
            fill(mid, a1, depth + 1);
        }
        for (var i = 0; i <= n; i++)
            polys.push(wedge(cx, cy, r0, R, base + step * i, cfg.linePx));
        for (var j = 0; j < n; j++) fill(base + step * j, base + step * (j + 1), 0);
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
        var n = cfg.petalCount || 14, w = cfg.ampPx || (cfg.linePx * 3); if (w < cfg.linePx) w = cfg.linePx;
        var polys = [];
        var inner = Math.min(R * 0.24, Math.max(cfg.linePx * 2, (cfg.linePx + cfg.gapMidPx) * 2));
        var mid = (R + inner) / 2, petalRadius = (R - inner) / 2;
        for (var k = 0; k < n; k++) {
            var ang = k * 2 * Math.PI / n;
            polys.push(ellipseRibbon(cx + mid * Math.cos(ang), cy + mid * Math.sin(ang), petalRadius, w, ang, cfg.linePx / 2));
        }
        polys.push(circleRibbon(cx, cy, inner * 0.7, cfg.linePx / 2));
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
        var r = unitCellPx(cfg, 1, 3);
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
     * 未指定内径时: 外层起始半径按区域大小取 1/4(保证外缘线距不过疏), 内圈用「逐层分叉」收束 ——
     * 每向内一层线条数减半、角间距不变, 一层层接到圆心, 中心只留极小的一点空白。
     * 这样既不会留大片圆形空白(1200ppi 的 BG 层实测半径 583px ≈ 12mm, 直径接近卡宽一半),
     * 也不会像"线条直通圆心"那样把中心糊成一大块实黑。
     * 显式指定 inner_radius_mm 时按指定值留空, 不做分叉。 */
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
        var step = 2 * Math.PI / n;
        var polys = [];
        for (var g = 0; g < groups.length; g++) {
            var cx = cfg.cxPx + groups[g][0] * amp, cy = cfg.cyPx + groups[g][1] * amp;
            var Rg = maxDistFrom(b, cx, cy) + cfg.linePx + cfg.gapSparsePx;
            var ph = g / (groups.length * n);                            // 每组相位微错开, 避免完全重合
            /* 一层射线: 条数 m, 半径区间 [rIn, rOut], 角度取上一层的相邻两条中间(2^k 间隔) */
            function pushFan(k, m, rIn, rOut) {
                if (m < 1 || rOut <= rIn) return;
                var span = Math.pow(2, k), off = (span - 1) / 2;
                for (var j = 0; j < m; j++) {
                    var th = (j * span + off + ph) * step;
                    var d0 = cfg.linePx / (2 * rIn), d1 = cfg.linePx / (2 * rOut);
                    polys.push([
                        [cx + rIn * Math.cos(th - d0), cy + rIn * Math.sin(th - d0)],
                        [cx + rOut * Math.cos(th - d1), cy + rOut * Math.sin(th - d1)],
                        [cx + rOut * Math.cos(th + d1), cy + rOut * Math.sin(th + d1)],
                        [cx + rIn * Math.cos(th + d0), cy + rIn * Math.sin(th + d0)]
                    ]);
                }
            }
            pushFan(0, n, r0, Rg);                                       // 外层: n 条, r0 → 区域外缘
            if (autoInner) {
                var rHi = r0, m = Math.floor(n / 2), k = 1;
                while (m >= 3 && k < 12) {
                    var rLo = Math.max(rHi / 2, cfg.linePx * 1.5);
                    pushFan(k, m, rLo, rHi);
                    if (rLo <= cfg.linePx * 1.5) break;
                    rHi = rLo; m = Math.floor(m / 2); k++;
                }
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
        // Short diagonal fibres: the old square grid used dash length as row spacing,
        // leaving large empty bands. Pack rows by physical line width + net gap.
        var pitch = cfg.linePx + cfg.gapMidPx;
        var L = Math.min(cfg.segLenPx || pitch * 4, pitch * 4);
        var cell = L + cfg.gapMidPx;
        var p = projections(b, withDir(cfg, cfg.dirRad + Math.PI / 4));
        var polys = [], row = 0;
        for (var ss = p.smin; ss <= p.smax; ss += pitch) {
            var phase = (row % 2) * cell / 2;
            for (var t = p.tmin - cell + phase; t < p.tmax; t += cell) {
                var x = p.cx + t * p.dx + ss * p.nx, y = p.cy + t * p.dy + ss * p.ny;
                var rb = ribbon2(x, y, x + L * p.dx, y + L * p.dy, cfg.linePx / 2);
                if (rb) polys.push(rb);
            }
            row++;
        }
        return polys;
    }
    function genScale(b, cfg) {
        // Smaller overlapping scales keep the rows visually continuous.
        var cell = unitCellPx(cfg, 2, 3), half = cfg.linePx / 2, polys = [], row = 0;
        var rr = cell * 0.36, rOut = rr + half;
        /* 单位弧只算一次(每片鳞的弧角度相同) */
        var uc = new Array(17), us = new Array(17);
        for (var u = 0; u <= 16; u++) { var th0 = Math.PI + Math.PI * u / 16; uc[u] = Math.cos(th0); us[u] = Math.sin(th0); }
        var G = cfg.regionGrid;
        for (var y = b.y0; y < b.y1; y += cell * 0.65) {
            var off = (row % 2) * cell / 2;
            for (var x = b.x0 + off; x < b.x1; x += cell) {
                /* 区域外元素直接不生成(与裁剪阶段丢弃等价, 不改变输出); 大稀疏区域能省近一半 */
                if (G && gridRectOutside(G, x - rOut - half, y - rOut - half, x + rOut + half, y + half)) continue;
                var pts = [];
                for (var i = 0; i <= 16; i++) pts.push([x + cell * 0.36 * uc[i], y + cell * 0.36 * us[i]]);
                polys.push(offsetPolyline(pts, half));
            }
            row++;
        }
        return polys;
    }
    function genDash(b, cfg) {
        var p = projections(b, cfg), dash = cfg.segLenPx || 12, gap = cfg.gapMidPx;
        var cell = dash + gap, polys = [], ss = p.smin, row = 0;
        while (ss <= p.smax) {
            var px = p.cx + ss * p.nx, py = p.cy + ss * p.ny, g = gapFor(b, cfg, px, py);
            var phase = (row % 2) * cell / 2;
            for (var t = p.tmin - cell + phase; t < p.tmax; t += cell) {
                var e = Math.min(t + dash, p.tmax);
                var rb = ribbon2(px + t * p.dx, py + t * p.dy, px + e * p.dx, py + e * p.dy, cfg.linePx / 2);
                if (rb) polys.push(rb);
            }
            ss += cfg.linePx + g;
            row++;
        }
        return polys;
    }
    function genDots(b, cfg) {
        /* 点阵: 网格步距 = 基准间距的 2~4 倍(旧版 = wavelength = 12mm);
         * 点半径按网格与净隙自动收敛, 保证相邻点之间留出净距。 */
        var pitch = cfg.linePx + cfg.gapMidPx;
        var cell = unitCellPx(cfg, 2, 3);
        var r = cfg.ampPx || cfg.linePx * 3;
        var rMax = (cell - cfg.gapMidPx) / 2 - cfg.linePx / 2;   // 相邻点外轮廓保留中隙
        if (rMax < cfg.linePx / 2) rMax = cfg.linePx / 2;
        if (r > rMax) r = rMax;
        if (r < cfg.linePx / 2) r = cfg.linePx / 2;
        var half = cfg.linePx / 2, polys = [], row = 0;
        var G = cfg.regionGrid;
        for (var y = b.y0; y < b.y1; y += cell) {
            var off = (row % 2) * cell / 2;
            for (var x = b.x0 + off; x < b.x1; x += cell) {
                if (G && gridRectOutside(G, x - r - half, y - r - half, x + r + half, y + r + half)) continue;
                polys.push(circleRibbon(x, y, r, half));
            }
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
    /* ---------------- 区域裁剪: 只保留真正落在区域里的纹样 ----------------
     * 001 实测: 失败的大层都是"大 bbox + 稀疏内容"——图层13 的 bbox 是 1666x770, 但不透明像素
     * 只占 7.8%, 图层48 只有 1.6%。纹样是按 bbox 生成的, 于是十几倍的线都落在区域外, 既撞安全
     * 预算又白建形状层(蒙版本来也会把它们裁掉)。这里用偶数交叉规则判断"点是否在区域内"(孔洞天然
     * 算对), 沿多边形轮廓取样, 一条都不在区域内的就丢掉。结果与蒙版裁切后的成品一致;
     * contour/topographic 这类本来就贴着区域轮廓生成的纹样不筛。
     *
     * 加速(2026-09-17, v0.3): 原实现每个采样点都遍历候选子路径的全部节点做 even-odd,
     * 大区域(子路径上千、节点数万)时单层要 5-7 分钟(010 实测 Velvet_S 425 秒 / hot stamp 334 秒)。
     * 现改为"细网格奇偶栅格":
     *   1) 区域子路径的每条线段按 DDA 写入细网格, 同时把线段记进它经过的每个格子;
     *   2) 逐行扫描线在格心求奇偶(区域外→内翻转) → 每格的"格心内外";
     *   3) 查询任意点: 若所在格没有线段 → 直接用格心奇偶; 若有线段 → 从格心到该点连一段线,
     *      数它与格内线段的交叉次数, 奇偶翻转即得 —— 与逐点 even-odd 数学等价(测度零差异);
     *   4) 多边形先用面积和(前缀和)O(1) 判断"包围盒内是否全是没有线段的格子", 是则整块一次判定。
     * 结果与原逐点采样一致(不降生成质量), 大层从几分钟降到几秒。 */
    function segIntersect(ax, ay, bx, by, cx, cy, dx2, dy2) {
        var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        var d2 = (bx - ax) * (dy2 - ay) - (by - ay) * (dx2 - ax);
        var d3 = (dx2 - cx) * (ay - cy) - (dy2 - cy) * (ax - cx);
        var d4 = (dx2 - cx) * (by - cy) - (dy2 - cy) * (bx - cx);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }
    function buildParityGrid(subs, cellPx) {
        var bb = subsBBox(subs);
        if (!bb) return null;
        var cell = Math.max(4, cellPx || 12);
        var cols = Math.max(1, Math.ceil((bb[2] - bb[0]) / cell) + 1);
        var rows = Math.max(1, Math.ceil((bb[3] - bb[1]) / cell) + 1);
        var cellEdges = new Array(cols * rows);
        var rowSegs = new Array(rows), i;
        for (i = 0; i < rows; i++) rowSegs[i] = null;
        function addEdge(ax, ay, bx, by) {
            if (ay !== by) {   // 水平段不参与水平射线
                var r0 = Math.max(0, Math.floor((Math.min(ay, by) - bb[1]) / cell));
                var r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) - bb[1]) / cell));
                for (var r = r0; r <= r1; r++) {
                    if (!rowSegs[r]) rowSegs[r] = [];
                    rowSegs[r].push(ax, ay, bx, by);
                }
            }
            var x0 = (ax - bb[0]) / cell, y0 = (ay - bb[1]) / cell;
            var x1 = (bx - bb[0]) / cell, y1 = (by - bb[1]) / cell;
            var cx = Math.floor(x0), cy = Math.floor(y0);
            var ex = Math.floor(x1), ey = Math.floor(y1);
            var dx = x1 - x0, dy = y1 - y0;
            var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
            var tMaxX = 1e18, tMaxY = 1e18, tDeltaX = 1e18, tDeltaY = 1e18;
            if (dx !== 0) { tDeltaX = Math.abs(1 / dx); tMaxX = (dx > 0 ? (cx + 1 - x0) : (x0 - cx)) * tDeltaX; }
            if (dy !== 0) { tDeltaY = Math.abs(1 / dy); tMaxY = (dy > 0 ? (cy + 1 - y0) : (y0 - cy)) * tDeltaY; }
            var guard = 0;
            while (guard++ < 100000) {
                if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) {
                    var gi = cy * cols + cx;
                    if (!cellEdges[gi]) cellEdges[gi] = [];
                    cellEdges[gi].push(ax, ay, bx, by);
                }
                if (cx === ex && cy === ey) break;
                if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
                else { cy += stepY; tMaxY += tDeltaY; }
            }
        }
        for (var p = 0; p < subs.length; p++) {
            var pts = subs[p].entireSubPath, n = pts.length;
            if (n < 3) continue;
            for (var j = 0; j < n; j++) {
                var a = pts[j].anchor, b = pts[(j + 1) % n].anchor;
                addEdge(a[0], a[1], b[0], b[1]);
            }
        }
        var par = new Array(cols * rows);
        for (i = 0; i < par.length; i++) par[i] = 0;
        for (var r2 = 0; r2 < rows; r2++) {
            var segs = rowSegs[r2];
            if (!segs || !segs.length) continue;
            var yMid = bb[1] + (r2 + 0.5) * cell, xs = [];
            for (var s = 0; s < segs.length; s += 4) {
                var ay = segs[s + 1], by = segs[s + 3];
                if ((ay <= yMid && by > yMid) || (by <= yMid && ay > yMid))
                    xs.push(segs[s] + (yMid - ay) * (segs[s + 2] - segs[s]) / (by - ay));
            }
            if (!xs.length) continue;
            xs.sort(function (m, n2) { return m - n2; });
            var xi = 0, parity = 0;
            for (var c = 0; c < cols; c++) {
                var cxx = bb[0] + (c + 0.5) * cell;
                while (xi < xs.length && xs[xi] < cxx) { parity ^= 1; xi++; }
                par[r2 * cols + c] = parity;
            }
        }
        var w = cols + 1, sat = new Array(w * (rows + 1));
        for (i = 0; i < sat.length; i++) sat[i] = 0;
        for (var r3 = 0; r3 < rows; r3++) {
            var rowSum = 0;
            for (var c3 = 0; c3 < cols; c3++) {
                rowSum += cellEdges[r3 * cols + c3] ? 1 : 0;
                sat[(r3 + 1) * w + (c3 + 1)] = sat[r3 * w + (c3 + 1)] + rowSum;
            }
        }
        return { bb: bb, cell: cell, cols: cols, rows: rows, cellEdges: cellEdges, par: par, sat: sat, w: w };
    }
    function gridPointInside(G, x, y) {
        var c = Math.floor((x - G.bb[0]) / G.cell), r = Math.floor((y - G.bb[1]) / G.cell);
        if (c < 0 || r < 0 || c >= G.cols || r >= G.rows) return false;
        var gi = r * G.cols + c;
        var par = G.par[gi], edges = G.cellEdges[gi];
        if (!edges) return par === 1;
        var mx = G.bb[0] + (c + 0.5) * G.cell, my = G.bb[1] + (r + 0.5) * G.cell;
        var crossings = 0;
        for (var i = 0; i < edges.length; i += 4)
            if (segIntersect(mx, my, x, y, edges[i], edges[i + 1], edges[i + 2], edges[i + 3])) crossings++;
        return (par ^ (crossings & 1)) === 1;
    }
    /* 矩形是否完全在区域外: 只在"范围内没有任何线段格、且格心奇偶=外"时返回 true。
     * 生成器用它跳过区域外的元素 —— 这些元素本来也会被裁剪丢弃, 输出完全一致。 */
    function gridRectOutside(G, x0, y0, x1, y1) {
        if (!G) return false;
        if (x1 < G.bb[0] || y1 < G.bb[1] || x0 > G.bb[2] || y0 > G.bb[3]) return true;
        var c0 = Math.floor((x0 - G.bb[0]) / G.cell), c1 = Math.floor((x1 - G.bb[0]) / G.cell);
        var r0 = Math.floor((y0 - G.bb[1]) / G.cell), r1 = Math.floor((y1 - G.bb[1]) / G.cell);
        if (c0 < 0) c0 = 0; if (c1 >= G.cols) c1 = G.cols - 1;
        if (r0 < 0) r0 = 0; if (r1 >= G.rows) r1 = G.rows - 1;
        if (c0 > c1 || r0 > r1) return true;
        var s = G.sat, w = G.w;
        var ec = s[(r1 + 1) * w + (c1 + 1)] - s[r0 * w + (c1 + 1)] - s[(r1 + 1) * w + c0] + s[r0 * w + c0];
        if (ec > 0) return false;
        return G.par[r0 * G.cols + c0] === 0;
    }
    function filterPolysToRegion(polys, subs, stepPx, gridOrCell) {
        var bb0 = subsBBox(subs);
        if (!bb0) return { polys: polys, dropped: 0 };
        var G = (gridOrCell && gridOrCell.cellEdges) ? gridOrCell : null;
        if (!G) {
            var cellFine = (typeof gridOrCell === 'number' && gridOrCell > 0) ? gridOrCell
                : Math.max(16, Math.ceil(Math.max(bb0[2] - bb0[0], bb0[3] - bb0[1]) / 256));
            G = buildParityGrid(subs, cellFine);
        }
        if (!G) return { polys: polys, dropped: 0 };
        var step = Math.max(stepPx || 6, 2), out = [], dropped = 0;
        var bb = G.bb, cell = G.cell, cols = G.cols, rows = G.rows;
        for (var i = 0; i < polys.length; i++) {
            var p = polys[i];
            if (!p || p.length < 3) { dropped++; continue; }
            var px0, py0, px1, py1;
            var pbb = p._bb;   // 生成器已知包围盒时直接用, 省掉逐点扫描(大层能省几百万次读取)
            if (pbb) { px0 = pbb[0]; py0 = pbb[1]; px1 = pbb[2]; py1 = pbb[3]; }
            else {
                px0 = 1e18; py0 = 1e18; px1 = -1e18; py1 = -1e18;
                for (var q = 0; q < p.length; q++) {
                    var pt = p[q];
                    if (pt[0] < px0) px0 = pt[0]; if (pt[0] > px1) px1 = pt[0];
                    if (pt[1] < py0) py0 = pt[1]; if (pt[1] > py1) py1 = pt[1];
                }
            }
            var keep = false;
            /* 快速路径: 包围盒完全落在区域 bbox 内、且范围内没有带线段的格子 → 整块同内外, 一次判定 */
            if (px0 >= bb[0] && py0 >= bb[1] && px1 <= bb[2] && py1 <= bb[3]) {
                var c0 = Math.floor((px0 - bb[0]) / cell), c1 = Math.floor((px1 - bb[0]) / cell);
                var r0 = Math.floor((py0 - bb[1]) / cell), r1 = Math.floor((py1 - bb[1]) / cell);
                if (c0 < 0) c0 = 0; if (c1 >= cols) c1 = cols - 1;
                if (r0 < 0) r0 = 0; if (r1 >= rows) r1 = rows - 1;
                var s0 = G.sat, w = G.w;
                var ec = s0[(r1 + 1) * w + (c1 + 1)] - s0[r0 * w + (c1 + 1)] - s0[(r1 + 1) * w + c0] + s0[r0 * w + c0];
                if (ec === 0) {
                    if (G.par[r0 * cols + c0] === 1) out.push(p); else dropped++;
                    continue;
                }
            }
            for (var j = 0; j < p.length && !keep; j++) {
                var a = p[j], b2 = p[(j + 1) % p.length];
                var dx = b2[0] - a[0], dy = b2[1] - a[1];
                var len = Math.sqrt(dx * dx + dy * dy);
                var nSeg = Math.max(1, Math.ceil(len / step));
                for (var s = 0; s <= nSeg; s++) {
                    var t = s / nSeg;
                    if (gridPointInside(G, a[0] + dx * t, a[1] + dy * t)) { keep = true; break; }
                }
            }
            if (keep) out.push(p); else dropped++;
        }
        return { polys: out, dropped: dropped };
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
        plogImpl = plog;

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
        var analysisReuse = { doc: null };
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

                var layer = (L.source_id ? findLayerById(src, L.source_id) : null) || resolveLayer(src, String(srcPath).split('/'), 0);
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
                    petalCount: Math.max(2, Math.round(num(L.petal_count, num(dflt.petal_count, 14)))),
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

                /* ---- 扣除已生成区域(子层优先): 只保留本层尚未被占用的部分 ----
                 * "不折光"层同样按原优先度参与扣除与区域占用(它占下的区域后面的层不会再去铺纹样),
                 * 只是它的输出组生成后会被隐藏 —— 标记只影响可见性, 不影响生成逻辑。 */
                var maskSubs = subs;
                if (noOverlap && usedBox && boxHit(b, usedBox) && ensureUsedChannel()) {
                    stage = '扣除已生成区域: ' + srcPath;
                    var tBool = new Date().getTime(), regPathB = null;
                    try {
                        if (subs.length > MAX_SUBPATHS) plog('区域路径按面积截断(相减用): ' + subs.length + ' -> ' + MAX_SUBPATHS + ' 条子路径');
                        /* 这几步在大区域上可能各要几十秒到几分钟; 每步前后各写一行日志,
                         * 万一卡住(003 在 PS 25.11 上停过一次)能一眼看出停在哪一步。 */
                        plog('扣除步骤: 建相减路径(' + Math.min(subs.length, MAX_SUBPATHS) + ' 条子路径)...');
                        regPathB = master.pathItems.add('ZG_temp_bool_' + String(new Date().getTime()), subsPxToPt(master, limitSubs(subs)));
                        plog('扣除步骤: 建路径完成; 转选区并扣除已生成区域...');
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
                        plog('扣除步骤: 选区相减完成; 转工作路径...');
                        master.selection.makeWorkPath(Math.max(tolPx, 2.0));   // 蒙版是裁切边界, 用较粗容差显著减少碎片与耗时
                        plog('扣除步骤: 工作路径完成; 读回锚点...');
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

                /* 剩余区域比两条线还窄(被先做的层扣到只剩几像素的缝)时, 生成出来全是退化几何,
                 * 还会让 PS 在挂组蒙版/并入通道时卡死或报错(001 子树实测: 图层 4 卡 15 分钟后失败) —— 直接按覆盖跳过。 */
                if (Math.max(b.x1 - b.x0, b.y1 - b.y0) < cfg.linePx * 2) {
                    covered++;
                    plog('COVERED 剩余区域过小(' + Math.round(b.x1 - b.x0) + 'x' + Math.round(b.y1 - b.y0) + 'px < 2 线宽), 跳过本层纹样: ' + srcPath);
                    log('COVERED 剩余区域过小, 跳过: ' + srcPath);
                    keepContainerForChildren(srcPath, hideOut, L);
                    continue;
                }

                var polys;
                stage = '生成纹样: ' + srcPath;
                var tGen0 = new Date().getTime();
                /* 区域奇偶网格只建一次: 生成阶段用它跳过区域外元素, 裁剪阶段直接复用。 */
                var regionGrid = null;
                if (pattern !== 'contour' && pattern !== 'topographic') {
                    var mbG = subsBBox(maskSubs);
                    if (mbG) {
                        var cellG = Math.max(16, Math.ceil(Math.max(mbG[2] - mbG[0], mbG[3] - mbG[1]) / 256));
                        regionGrid = buildParityGrid(maskSubs, cellG);
                    }
                    cfg.regionGrid = regionGrid;
                }
                if (pattern === 'content_flow' && !cfg.flowField) {
                    /* 随形流场需要画面分析: GUI 已分析过会带在 L.analysis 里, 否则现算一次 */
                    var anF = (L.analysis && L.analysis.field) ? L.analysis : analyzeLayer(src, layer, analysisReuse);
                    if (anF && anF.ok && anF.field) cfg.flowField = anF.field;
                }
                if (pattern === 'parallel' || pattern === 'facet') polys = genFacet(b, cfg);
                else if (pattern === 'flow') polys = genFlow(b, cfg);
                else if (pattern === 'content_flow') polys = genContentFlow(b, cfg);
                else if (pattern === 'wave') polys = genWave(b, cfg);
                else if (pattern === 'zigzag') polys = genZigzag(b, cfg);
                else if (pattern === 'chevron') polys = genChevron(b, cfg);
                else if (pattern === 'feather') polys = genFeather(b, cfg);
                else if (pattern === 'herringbone') polys = genHerringbone(b, cfg);
                else if (pattern === 'bilateral_flow') polys = genBilateral(b, cfg);
                else if (pattern === 'meander') polys = genMeander(b, cfg);
                else if (pattern === 'contour' || pattern === 'topographic') polys = genContour(maskSubs, cfg);
                else if (pattern === 'fan') polys = genFan(b, cfg);
                else if (pattern === 'concentric') polys = genConcentric(b, cfg);
                else if (pattern === 'ripple') polys = genRipple(b, cfg);
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
                var tGen1 = new Date().getTime();
                if (!polys.length) { log('NOLINES 区域过小未产生线, 跳过: ' + srcPath); continue; }

                /* 只保留真正落在区域里的纹样(大 bbox + 稀疏内容时能省掉十几倍无用几何)。
                 * contour/topographic 本来就贴着区域轮廓生成, 跳过筛选避免误删。 */
                if (pattern !== 'contour' && pattern !== 'topographic') {
                    var filt = filterPolysToRegion(polys, maskSubs, cfg.linePx, regionGrid);
                    if (filt.dropped) plog('区域裁剪: 纹样 ' + polys.length + ' -> ' + filt.polys.length + ' (丢掉区域外的 ' + filt.dropped + ' 条)');
                    polys = filt.polys;
                    if (!polys.length) { log('NOLINES 区域过小未产生线, 跳过: ' + srcPath); continue; }
                }
                var tFilt1 = new Date().getTime();

                var plan = planShapeBatches(polys);
                plog('纹样完成: 多边形 ' + polys.length + ' 节点 ' + plan.points + ' ms(生成=' + (tGen1 - tGen0) + ' 裁剪=' + (tFilt1 - tGen1) + ')');

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
                        plog('组蒙版: 矢量蒙版已建立; 并入已生成区域...');
                        if (noOverlap && ensureUsedChannel()) {
                            /* 把本层实际占用的区域并入"已生成区域"("不折光"层同样占用, 见上方说明)。
                             * 这一步只影响后续层的扣除, 失败不该毁掉本层已挂好的蒙版: 记警告继续。 */
                            try {
                                regPath.makeSelection();
                                var selOK = true;
                                try { master.selection.bounds; } catch (eSelEmpty) { selOK = false; }
                                if (selOK) {
                                    try { master.selection.store(usedCh, SelectionType.EXTEND); }
                                    catch (eSt) {   // 少数版本不支持带类型的 store, 退回 载入+存储
                                        master.selection.load(usedCh, SelectionType.EXTEND);
                                        master.selection.store(usedCh);
                                    }
                                    var mb1 = subsBBox(maskSubs);
                                    if (mb1) usedBox = usedBox
                                        ? { x0: Math.min(usedBox.x0, mb1[0]), y0: Math.min(usedBox.y0, mb1[1]), x1: Math.max(usedBox.x1, mb1[2]), y1: Math.max(usedBox.y1, mb1[3]) }
                                        : { x0: mb1[0], y0: mb1[1], x1: mb1[2], y1: mb1[3] };
                                } else {
                                    plog('警告: 区域选区为空, 未并入占用通道(不影响本层输出): ' + srcPath);
                                }
                                try { master.selection.deselect(); } catch (eD3) {}
                            } catch (eUsed) {
                                try { master.selection.deselect(); } catch (eD5) {}
                                plog('警告: 并入占用通道失败(不影响本层输出): ' + (eUsed && eUsed.message ? eUsed.message : String(eUsed)));
                            }
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
                    /* 组已删除: 清掉登记, 否则后面的嵌套/空组清理会引用失效对象, 把整次生成带崩(001 子树实测) */
                    delete groupByPath[srcPath];
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
                    try {
                        if (nestGroup(master, npGroup, parentG) > 0) { nested++; if (!nestMethodSeen) nestMethodSeen = nestMethodUsed; }
                        else { nestFail++; plog('警告: 组嵌套失败 ' + npPath); }
                    } catch (eNest) {
                        nestFail++;
                        plog('警告: 组嵌套异常 ' + npPath + ' | ' + (eNest && eNest.message ? eNest.message : String(eNest)));
                    }
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
                var hidFail = 0, hidGone = 0;
                for (var hgi = 0; hgi < hiddenGroups.length; hgi++) {
                    var hg = hiddenGroups[hgi], hgAlive = true;
                    try { hg.visible = false; } catch (eHg) { hgAlive = false; }
                    if (!hgAlive) {
                        /* 组可能已被"空容器清理"删掉: 还能读到 id 才算真失败 */
                        try { var hgId = hg.id; hidFail++; } catch (eGone) { hidGone++; }
                        continue;
                    }
                    try { if (hg.visible) hidFail++; } catch (eHg2) { hidFail++; }
                }
                var hidOk = hiddenGroups.length - hidFail - hidGone;
                plog('不折光输出组隐藏确认: ' + hidOk + '/' + (hiddenGroups.length - hidGone) + (hidFail ? (' (仍可见 ' + hidFail + ' 组)') : '') + (hidGone ? (' (组已删除 ' + hidGone + ')') : ''));
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
            if (analysisReuse && analysisReuse.doc) {
                try { analysisReuse.doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eAC) {}
                analysisReuse.doc = null;
            }
            if (master && !saved) master.close(SaveOptions.DONOTSAVECHANGES);
            app.preferences.rulerUnits = oldUnits;
            app.displayDialogs = oldDialogs;
        }
    }

    ZG.generate = generate;
    ZG.collectLayers = collectLayers;
    ZG.suggest = suggest;
    ZG.suggestAll = suggestAll;
    ZG.suggestFor = suggestFor;
    ZG.PATTERN_FAMILY = PATTERN_FAMILY;
    ZG.analyzeLayer = analyzeLayer;
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
        genContentFlow: genContentFlow,
        computeFeatures: computeFeatures,
        filterPolysToRegion: filterPolysToRegion,
        buildParityGrid: buildParityGrid,
        gridPointInside: gridPointInside,
        genScale: genScale,
        genDots: genDots,
        circleRibbon: circleRibbon,
        offsetPolyline: offsetPolyline,
        getRegionSubs: getRegionSubs,
        subsBBox: subsBBox,
        subsPxToPt: subsPxToPt,
        MAX_SUBPATHS: MAX_SUBPATHS
    };
}());
