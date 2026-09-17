#target photoshop
/* 折光纹工具箱 · 核心自检 (不建文档、不生成母版、不修改任何文件)
 * 运行: 文件 → 脚本 → 浏览 → selftest_core.jsx (需与本目录的 refraction_core.jsx 在一起)
 * 用途: 换电脑/换 Photoshop 版本后先跑一次, 确认核心函数行为正常。
 * 结果写入本脚本同目录的 selftest_result.txt (目录不可写时写到桌面), 并弹窗给出摘要。 */
(function () {
    var out = [], fails = 0;
    function t(k, v) { out.push(k + ' => ' + v); }
    function eq(k, got, want) {
        var ok = (String(got) === String(want));
        if (!ok) fails++;
        t((ok ? '[OK]  ' : '[FAIL] ') + k, got + (ok ? '' : '  (期望 ' + want + ')'));
    }
    var scriptDir = '';
    function findCore() {
        var sf = null;
        try { sf = new File($.fileName); } catch (e0) { sf = null; }
        if (!sf || !sf.exists || !sf.parent) return null;
        scriptDir = sf.parent.fsName;
        try {
            var cand = sf.parent.getFiles('refraction_core.jsx');
            if (cand && cand.length) return cand[0];
        } catch (e1) {}
        var f = new File(scriptDir + '/refraction_core.jsx');
        return f.exists ? f : null;
    }
    try {
        app.displayDialogs = DialogModes.NO;
        var core = findCore();
        if (!core) throw new Error('找不到 refraction_core.jsx: 请把 selftest_core.jsx 与本目录的 refraction_core.jsx 放在一起, 用 文件→脚本→浏览 运行。' + (scriptDir ? ('\n脚本目录: ' + scriptDir) : ''));
        $.evalFile(core);
        var ST = ZG.__selftest;
        t('环境', app.name + ' ' + app.version + ' / ' + app.locale);
        t('核心版本', ZG_CORE_VERSION);
        if (!ST) throw new Error('核心版本过旧: 没有 ZG.__selftest, 请使用配套的 refraction_core.jsx。');
        /* 1) "不折光"标记识别 (中文标记走 indexOf, 不受 ExtendScript 长中文正则缺陷影响) */
        var marks = [
            ['hot stamp/Silver（不做折光）', true], ['Queen（不做折光）', true],
            ['hot stamp/Red/bg-2（不做折光）', true], ['卡面/frame decos/water lily-*不做折光', true],
            ['卡面/frame decos/flowers bottom-*不做折光/flowers-front-sketch 副本', true],
            ['人物/头发/不做', true], ['x 跳过 y', true], ['skip me', true],
            ['no refraction', true], ['[skip] 层', true],
            ['hot stamp', false], ['BG/图层 4', false], ['Queen/crowns', false], ['色相/饱和度/明度 3', false]
        ];
        var bad = 0;
        for (var i = 0; i < marks.length; i++) if (ST.isNoRefraction(marks[i][0]) !== marks[i][1]) { bad++; t('  [FAIL] isNoRefraction', marks[i][0]); }
        eq('不折光标记识别 ' + (marks.length - bad) + '/' + marks.length, bad === 0 ? 'ok' : ('误判 ' + bad), 'ok');
        /* 2) 蒙版子路径简化 (纯几何, 不碰文档) */
        function mkSub(pts) {
            var arr = [];
            for (var k = 0; k < pts.length; k++) {
                var p = new PathPointInfo();
                p.kind = PointKind.CORNERPOINT; p.anchor = [pts[k][0], pts[k][1]];
                p.leftDirection = p.anchor; p.rightDirection = p.anchor; arr.push(p);
            }
            var si = new SubPathInfo(); si.closed = true; si.operation = ShapeOperation.SHAPEADD; si.entireSubPath = arr;
            return si;
        }
        function rect(x, y, w, h) { return mkSub([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
        var cfgT = { linePx: 7.0866, gapDensePx: 5.6693, gapMidPx: 7.0866, gapSparsePx: 9.4488 };
        var few = [rect(0, 0, 100, 100), rect(200, 0, 2, 200)];
        eq('少量子路径不筛', ST.simplifyMaskSubs(few, cfgT).subs.length, 2);
        var many = [];
        for (var b1 = 0; b1 < 5; b1++) many.push(rect(b1 * 200, 0, 100, 100));
        for (var s1 = 0; s1 < 1500; s1++) many.push(rect(s1 * 3, 300, 2, 200));
        var r1 = ST.simplifyMaskSubs(many, cfgT);
        eq('1505 条(5 大块+1500 碎屑) -> 保留', r1.subs.length, 5);
        eq('  ...丢弃碎屑数', r1.dropped, 1500);
        var blocks = [];
        for (var b2 = 0; b2 < 1000; b2++) blocks.push(rect(b2 * 30, 0, 30, 30));
        eq('超上限 1000 条 -> 压到', ST.simplifyMaskSubs(blocks, cfgT).subs.length, ST.MAX_SUBPATHS);
        var nested = [rect(0, 0, 1000, 1000), mkSub([[100, 100], [100, 300], [300, 300], [300, 100]])];
        for (var s2 = 0; s2 < 1500; s2++) nested.push(rect(s2 * 3, 1500, 2, 200));
        var r3 = ST.simplifyMaskSubs(nested, cfgT);
        var hasHole = false;
        for (var h1 = 0; h1 < r3.subs.length; h1++) if (ST.subSignedArea(r3.subs[h1]) < 0) hasHole = true;
        eq('岛+洞: 输出条数/洞保留', r3.subs.length + '/' + hasHole, '2/true');
        /* 3) 辐射摩尔纹: 中心用同心圆环收口, 不再留大片空白 */
        var cfgM = { linePx: 7.0866, gapDensePx: 5.6693, gapMidPx: 7.0866, gapSparsePx: 9.4488, cxPx: 1299, cyPx: 2362, innerRadiusPx: 0, ampPx: 42.5 };
        var bM = { x0: 65, y0: 502, x1: 2440, y1: 4323 };
        var polys = ST.genMoireRadial(bM, cfgM), minD = 1e18;
        for (var p1 = 0; p1 < polys.length; p1++)
            for (var q1 = 0; q1 < polys[p1].length; q1++) {
                var dx = polys[p1][q1][0] - cfgM.cxPx, dy = polys[p1][q1][1] - cfgM.cyPx;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d < minD) minD = d;
            }
        t('摩尔纹多边形数', polys.length);
        eq('摩尔纹距中心最近点 < 20px (无大空白)', minD < 20 ? 'ok' : minD.toFixed(1), 'ok');
        var cfgM2 = { linePx: 7.0866, gapDensePx: 5.6693, gapMidPx: 7.0866, gapSparsePx: 9.4488, cxPx: 1299, cyPx: 2362, innerRadiusPx: 400, ampPx: 42.5 };
        var polys2 = ST.genMoireRadial(bM, cfgM2), minD2 = 1e18;
        for (var p2 = 0; p2 < polys2.length; p2++)
            for (var q2 = 0; q2 < polys2[p2].length; q2++) {
                var dx2 = polys2[p2][q2][0] - cfgM2.cxPx, dy2 = polys2[p2][q2][1] - cfgM2.cyPx;
                var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                if (d2 < minD2) minD2 = d2;
            }
        eq('指定内径 400px 时按指定留空', minD2 > 300 ? 'ok' : minD2.toFixed(1), 'ok');
        t('结论', fails ? ('有 ' + fails + ' 项不符, 请检查 Photoshop 版本/脚本文件是否配套') : '全部通过');
    } catch (e) {
        fails++;
        t('[FAIL] 异常', (e && e.message ? e.message : String(e)) + (e && e.line ? (' @line ' + e.line) : ''));
    }
    /* 写结果: 脚本目录 -> 桌面 -> 系统临时目录 */
    var txt = out.join('\n') + '\n';
    var targets = [];
    if (scriptDir) targets.push(new File(scriptDir + '/selftest_result.txt'));
    try { targets.push(new File(Folder.desktop.fsName + '/ZG_selftest_result.txt')); } catch (eD) {}
    try { targets.push(new File(Folder.temp.fsName + '/ZG_selftest_result.txt')); } catch (eT) {}
    var savedPath = '(未写出)';
    for (var ti = 0; ti < targets.length; ti++) {
        try {
            targets[ti].encoding = 'UTF8';
            if (targets[ti].open('w')) { targets[ti].write('\uFEFF' + txt); targets[ti].close(); savedPath = targets[ti].fsName; break; }
        } catch (eW) {}
    }
    alert('核心自检 ' + (fails ? '未通过 (' + fails + ' 项)' : '通过') + '\n' + app.name + ' ' + app.version + ' / 核心 ' + (typeof ZG_CORE_VERSION !== 'undefined' ? ZG_CORE_VERSION : '?') + '\n\n结果: ' + savedPath);
}());
