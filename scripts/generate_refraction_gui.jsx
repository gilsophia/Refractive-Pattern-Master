#target photoshop
/* 折光纹工具箱 / Refraction pattern master — 母版生成宏 (手动分配模式, 不需要 job.json)
 * 运行: 文件 -> 脚本 -> 浏览 -> generate_refraction_gui.jsx
 * 列出源 PSD 全部图层, 弹窗逐层勾选启用、选纹样、填参数, 点生成即可产出独立母版 PSD。
 * 使用模态 dialog (可靠常驻) + 紧凑多列布局, 避免窗口过长。 */
(function () {
    var scriptDir = new File($.fileName).parent.fsName;

    var PATTERNS = ['parallel', 'facet', 'flow', 'wave', 'zigzag', 'chevron', 'feather', 'herringbone', 'bilateral_flow', 'meander', 'contour', 'topographic', 'radial', 'fan', 'cone', 'sunburst', 'concentric', 'ripple', 'spiral', 'vortex', 'petal_rosette', 'diamond_lattice', 'diamond_tri', 'moire_radial', 'triangle_lattice', 'hex_lattice', 'checker', 'carbon_fiber', 'scale', 'dash_field', 'dot_field', 'short_curve'];
    /* 纹样键 -> 中文名(取自 references/design-logic.md 的定稿命名)。下拉菜单显示中文, 内部仍用键名传参。 */
    var PATTERN_LABELS = {
        parallel: '单向平行纹', facet: '折面平行纹', flow: '顺势流线', wave: '平行波纹', zigzag: '连续折线纹',
        chevron: '鱼骨纹', feather: '羽片纹', herringbone: '人字错列纹', bilateral_flow: '双向流线',
        meander: '回纹', contour: '等距轮廓纹', topographic: '地形等高纹', radial: '放射纹', fan: '扇形纹',
        cone: '锥形束纹', sunburst: '分区爆发纹', concentric: '同心纹', ripple: '涟漪纹', spiral: '螺旋纹',
        vortex: '涡旋流场', petal_rosette: '花瓣玫瑰纹', diamond_lattice: '菱形网格', diamond_tri: '三角菱格纹',
        moire_radial: '辐射摩尔纹', triangle_lattice: '三角网格',
        hex_lattice: '六角蜂巢纹', checker: '棋盘方向纹', carbon_fiber: '碳纤维纹', scale: '鳞片纹',
        dash_field: '错相短线场', dot_field: '点阵纹', short_curve: '稀疏短曲线'
    };
    function patternLabel(key) { return PATTERN_LABELS[key] || String(key); }
    function patternLabelList() {
        var out = [];
        for (var i = 0; i < PATTERNS.length; i++) out.push(patternLabel(PATTERNS[i]));
        return out;
    }
    var DEFAULT_PATTERN = 'facet';
    var MIN_LINE_MM = 0.10;

    function DEFAULTS() {
        return {
            enabled: true,
            pattern: DEFAULT_PATTERN,
            line_mm: '0.15', gap_dense_mm: '0.12', gap_mid_mm: '0.15', gap_sparse_mm: '0.20',
            direction_deg: '0', amplitude_mm: '0.9', wavelength_mm: '12', segment_length_mm: '2',
            inner_radius_mm: '0', center_x: '0.5', center_y: '0.5', path_tolerance_px: '1.0',
            extra: ''
        };
    }
    function copyDefaults() { var d = DEFAULTS(), o = {}; for (var k in d) o[k] = d[k]; return o; }

    function main() {
        if (!app.documents.length) { alert('请先打开源 PSD。'); return; }
        var src = app.activeDocument;

        var infos = [];
        ZG.collectLayers(src, '', infos);
        if (!infos.length) { alert('源文档没有图层。'); return; }

        var asg = [];
        var i;
        for (i = 0; i < infos.length; i++) {
            var a = copyDefaults();
            var initialSuggestion = ZG.suggest(infos[i], src.width.as('px'), src.height.as('px'));
            a.enabled = infos[i].visible && !initialSuggestion.skip; // 隐藏层、整图合成层和明确排除层默认不生成
            asg.push(a);
        }

        var dlg = new Window('dialog', '折光纹工具箱 · 生成折光纹（手动分配）');
        dlg.orientation = 'column';
        dlg.alignChildren = 'left';
        dlg.preferredSize.width = 680;

        dlg.add('statictext', undefined, '源: ' + src.name + '  (共 ' + infos.length + ' 层; 最小线宽固定 ' + MIN_LINE_MM + ' mm)');

        // ---- 图层列表 ----
        dlg.add('statictext', undefined, '图层分配（点选一行编辑；列表即生成顺序：子层优先，组容器排在其子层之后；隐藏层、整图合成层和明确排除层默认不生成）');
        var lb = dlg.add('listbox', undefined, undefined);
        lb.preferredSize.width = 660; lb.preferredSize.height = 150;

        function rowText(idx) {
            return (asg[idx].enabled ? '[启用]' : '[跳过]') + '  ' + patternLabel(asg[idx].pattern) + '(' + asg[idx].pattern + ')  ' + infos[idx].path + (infos[idx].visible ? '' : '  (隐藏)');
        }
        function refreshList() {
            refreshingList = true;
            var sel = lb.selection ? lb.selection.index : 0;
            lb.removeAll();
            for (var n = 0; n < infos.length; n++) lb.add('item', rowText(n));
            if (sel >= 0 && sel < lb.items.length) lb.selection = lb.items[sel];
            refreshingList = false;
        }

        // ---- 参数面板 (紧凑多列布局) ----
        var p = dlg.add('panel', undefined, '当前图层参数');
        p.orientation = 'column';
        p.alignChildren = 'left';

        function fld2(row, label, val, w) {
            var g = row.add('group'); g.orientation = 'row'; g.alignChildren = 'left';
            g.add('statictext', undefined, label);
            var e = g.add('edittext', undefined, val);
            e.characters = w || 7;
            return e;
        }

        var r0 = p.add('group'); r0.orientation = 'row'; r0.alignChildren = 'left';
        var enabledCb = r0.add('checkbox', undefined, '生成折光纹');
        var fastCb = r0.add('checkbox', undefined, '矩形诊断模式（生产禁用）');
        fastCb.value = false; fastCb.enabled = false;
        var noOverlapCb = r0.add('checkbox', undefined, '避免重复生成（子层优先）');
        noOverlapCb.value = true;
        noOverlapCb.helpTip = '按列表顺序生成时，每层只生成"尚未被先做的层占用"的部分，避免同一区域叠多套纹样变成实黑。列表为子层优先：细节纹样先占位，组容器与背景层只补空隙。';
        r0.add('statictext', undefined, '   纹样:');
        var dd = r0.add('dropdownlist', undefined, patternLabelList());
        dd.selection = dd.items[0];

        var r1 = p.add('group'); r1.orientation = 'row'; r1.alignChildren = 'left';
        var eLine = fld2(r1, '线宽mm', '0.15');
        var eDir = fld2(r1, '方向°', '0');
        var eAmp = fld2(r1, '振幅mm', '0.9');
        var eWave = fld2(r1, '波长mm', '12');

        var r2 = p.add('group'); r2.orientation = 'row'; r2.alignChildren = 'left';
        var eDense = fld2(r2, '密隙', '0.12');
        var eMid = fld2(r2, '中隙', '0.15');
        var eSparse = fld2(r2, '疏隙', '0.20');
        var eSeg = fld2(r2, '线长mm', '2');

        var r3 = p.add('group'); r3.orientation = 'row'; r3.alignChildren = 'left';
        var eTol = fld2(r3, '容差px', '1.0');
        var eCx = fld2(r3, '中心X', '0.5');
        var eCy = fld2(r3, '中心Y', '0.5');
        var eInner = fld2(r3, '内径mm', '0');

        var r4 = p.add('group'); r4.orientation = 'row'; r4.alignChildren = 'left';
        var eExtra = fld2(r4, '高级参数', '', 34);

        // ---- 编辑逻辑 ----
        function selectedIndex() { return lb.selection ? lb.selection.index : -1; }
        function patIndex(name) { for (var m = 0; m < PATTERNS.length; m++) if (PATTERNS[m] === name) return m; return 0; }
        function selectedPatternKey() {   // 下拉菜单显示中文, 取键名按索引回查
            return (dd.selection && dd.selection.index >= 0 && dd.selection.index < PATTERNS.length) ? PATTERNS[dd.selection.index] : DEFAULT_PATTERN;
        }
        function loadIntoFields(idx) {
            var a = asg[idx];
            enabledCb.value = a.enabled;
            dd.selection = dd.items[patIndex(a.pattern)];
            eLine.text = a.line_mm; eDir.text = a.direction_deg; eAmp.text = a.amplitude_mm; eWave.text = a.wavelength_mm;
            eDense.text = a.gap_dense_mm; eMid.text = a.gap_mid_mm; eSparse.text = a.gap_sparse_mm; eSeg.text = a.segment_length_mm;
            eTol.text = a.path_tolerance_px; eCx.text = a.center_x; eCy.text = a.center_y; eInner.text = a.inner_radius_mm; eExtra.text = a.extra;
            updateHint(idx);
        }
        function fieldsToAssign(idx) {
            var a = asg[idx];
            a.enabled = enabledCb.value;
            a.pattern = selectedPatternKey();
            a.line_mm = eLine.text; a.direction_deg = eDir.text; a.amplitude_mm = eAmp.text; a.wavelength_mm = eWave.text;
            a.gap_dense_mm = eDense.text; a.gap_mid_mm = eMid.text; a.gap_sparse_mm = eSparse.text;
            a.segment_length_mm = eSeg.text; a.path_tolerance_px = eTol.text; a.center_x = eCx.text; a.center_y = eCy.text; a.inner_radius_mm = eInner.text; a.extra = eExtra.text;
            updateHint(idx);
        }
        var editingIndex = -1, refreshingList = false;
        lb.onChange = function () {
            if (refreshingList) return;
            var k = selectedIndex();
            if (editingIndex >= 0 && editingIndex !== k) fieldsToAssign(editingIndex);
            editingIndex = k;
            if (k >= 0) loadIntoFields(k);
        };

        var hint = dlg.add('statictext', undefined, '');
        function updateHint(k) {
            if (k < 0) { hint.text = ''; return; }
            var s = ZG.suggest(infos[k], src.width.as('px'), src.height.as('px'));
            hint.text = '建议: ' + (s.skip ? '[跳过] ' : '') + patternLabel(s.pattern) + '(' + s.pattern + ')' + (s.reason ? '  (' + s.reason + ')' : '');
        }
        function applySuggest(k) {
            var s = ZG.suggest(infos[k], src.width.as('px'), src.height.as('px'));
            asg[k].pattern = s.pattern;
            asg[k].direction_deg = String(s.direction_deg);
            asg[k].enabled = !s.skip;
            return s;
        }

        // ---- 按钮 (紧凑两行) ----
        var gb1 = dlg.add('group'); gb1.orientation = 'row'; gb1.alignChildren = 'left';
        var bSuggest = gb1.add('button', undefined, '建议当前层');
        var bSuggestAll = gb1.add('button', undefined, '建议全部');
        var bApply = gb1.add('button', undefined, '应用到当前层');
        var bApplyAll = gb1.add('button', undefined, '线宽/间隙应用到全部');
        bSuggest.onClick = function () { var k = selectedIndex(); if (k < 0) { alert('请先点选一个图层'); return; } applySuggest(k); loadIntoFields(k); refreshList(); };
        bSuggestAll.onClick = function () { for (var n = 0; n < infos.length; n++) applySuggest(n); refreshList(); if (lb.items.length) { lb.selection = lb.items[0]; editingIndex = 0; loadIntoFields(0); } };
        bApply.onClick = function () { var k = selectedIndex(); if (k < 0) { alert('请先点选一个图层'); return; } fieldsToAssign(k); refreshList(); };
        bApplyAll.onClick = function () {
            var k = selectedIndex();
            if (k < 0) { alert('请先点选一个图层'); return; }
            fieldsToAssign(k);
            var source = asg[k];
            for (var n = 0; n < infos.length; n++) if (asg[n].enabled) {
                asg[n].line_mm = source.line_mm;
                asg[n].gap_dense_mm = source.gap_dense_mm;
                asg[n].gap_mid_mm = source.gap_mid_mm;
                asg[n].gap_sparse_mm = source.gap_sparse_mm;
            }
            refreshList();
        };

        var gb2 = dlg.add('group'); gb2.orientation = 'row'; gb2.alignChildren = 'left';
        var bAllOn = gb2.add('button', undefined, '全部启用');
        var bAllOff = gb2.add('button', undefined, '全部禁用');
        bAllOn.onClick = function () { for (var n = 0; n < infos.length; n++) asg[n].enabled = true; refreshList(); };
        bAllOff.onClick = function () { for (var n = 0; n < infos.length; n++) asg[n].enabled = false; refreshList(); };
        gb2.add('statictext', undefined, '          ');
        var bGen = gb2.add('button', undefined, '生成');
        var bCancel = gb2.add('button', undefined, '取消');

        var ok = false;
        bGen.onClick = function () {
            var k = selectedIndex(); if (k >= 0) fieldsToAssign(k);
            var enabledCount = 0; for (var n = 0; n < asg.length; n++) if (asg[n].enabled) enabledCount++;
            if (!enabledCount) { alert('没有启用任何图层。请先逐层确认并勾选“生成折光纹”。'); return; }
            ok = true; dlg.close();
        };
        bCancel.onClick = function () { dlg.close(); };

        // ---- 生成逻辑 ----
        function parseNum(t) { var v = parseFloat(t); return isNaN(v) ? null : v; }
        function doGenerate() {
            var outDir = Folder.selectDialog('选择输出目录');
            if (!outDir) return;
            var layers = [];
            for (var n = 0; n < infos.length; n++) {
                var a = asg[n];
                var entry = { source_path: infos[n].path, enabled: a.enabled, pattern: a.pattern };
                var map = { line_mm: a.line_mm, gap_dense_mm: a.gap_dense_mm, gap_mid_mm: a.gap_mid_mm, gap_sparse_mm: a.gap_sparse_mm, direction_deg: a.direction_deg, amplitude_mm: a.amplitude_mm, wavelength_mm: a.wavelength_mm, segment_length_mm: a.segment_length_mm, inner_radius_mm: a.inner_radius_mm, center_x: a.center_x, center_y: a.center_y, path_tolerance_px: a.path_tolerance_px };
                for (var k in map) { var v = parseNum(map[k]); if (v !== null) entry[k] = v; }
                if (a.extra) {
                    var parts = String(a.extra).split(',');
                    for (var e2 = 0; e2 < parts.length; e2++) {
                        var kv = parts[e2].split('=');
                        if (kv.length === 2) { var key = kv[0].replace(/^\s+|\s+$/g, ''); var val = parseNum(kv[1]); if (key && val !== null) entry[key] = val; }
                    }
                }
                layers.push(entry);
            }
            var config = {
                sourceDoc: src,
                widthPx: src.width.as('px'), heightPx: src.height.as('px'), ppi: src.resolution,
                outputDir: outDir.fsName,
                defaults: { min_line_mm: MIN_LINE_MM },
                fast: false,
                noOverlap: noOverlapCb.value,
                layers: layers
            };
            try {
                var res = ZG.generate(config);
                var msg = '折光纹母版已生成 (' + res.count + ' 组):\n' + res.psd;
                if (res.failed && res.failed.length) {
                    msg += '\n\n有 ' + res.failed.length + ' 层失败(已跳过, 其余正常输出):\n';
                    for (var f = 0; f < res.failed.length && f < 8; f++) msg += '· ' + res.failed[f] + '\n';
                    if (res.failed.length > 8) msg += '… 其余见 master_report 的 FAIL 行。\n';
                } else {
                    msg += '\n\n首次运行请按 references/validation.md 最小验证步骤复查。';
                }
                alert(msg);
            } catch (e) {
                alert('生成出错:\n' + (e && e.message ? e.message : String(e)));
            }
        }

        refreshList();
        if (lb.items.length) { lb.selection = lb.items[0]; editingIndex = 0; loadIntoFields(0); }

        dlg.show();
        if (!ok) return;
        doGenerate();
    }

    try {
        $.evalFile(new File(scriptDir + '/refraction_core.jsx'));
        main();
    } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        var loc = '';
        if (e && e.fileName) loc += '\n文件: ' + e.fileName;
        if (e && e.line !== undefined) loc += '\n行: ' + e.line;
        try {
            var lf = new File(scriptDir + '/zg_error_log.txt');
            lf.encoding = 'UTF8';
            if (lf.open('w')) { lf.write(msg + loc); lf.close(); }
        } catch (e2) {}
        alert('折光纹宏出错:\n' + msg + loc + '\n\n详情已写入脚本目录 zg_error_log.txt');
    }
}());
