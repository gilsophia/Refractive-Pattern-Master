#target photoshop
/* 折光纹工具箱 / Refraction pattern master — 母版生成宏 (手动分配模式, 不需要 job.json)
 * 运行: 文件 -> 脚本 -> 浏览 -> generate_refraction_gui.jsx
 * 列出源 PSD 全部图层, 弹窗逐层勾选启用、选纹样、填参数, 点生成即可产出独立母版 PSD。
 * 使用模态 dialog (可靠常驻) + 紧凑多列布局, 避免窗口过长。 */
(function () {
    var scriptDir = '';
    /* 定位同目录的 refraction_core.jsx。
     * 用 $.fileName(本脚本被运行时的真实路径) 推导, 不写死任何绝对路径, 换电脑/换目录都能用。
     * 先用 Folder.getFiles 直接取 File 对象(不做路径字符串拼接), 这样中文/非 ASCII 路径、
     * Windows 反斜杠与 macOS 正斜杠的差异都不会出问题; 取不到再退回手拼路径。 */
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

    var PATTERNS = ['parallel', 'facet', 'flow', 'content_flow', 'wave', 'zigzag', 'chevron', 'feather', 'herringbone', 'bilateral_flow', 'meander', 'contour', 'topographic', 'fan', 'concentric', 'ripple', 'vortex', 'petal_rosette', 'diamond_lattice', 'diamond_tri', 'moire_radial', 'triangle_lattice', 'hex_lattice', 'checker', 'carbon_fiber', 'scale', 'dash_field', 'dot_field', 'short_curve'];
    /* 纹样键 -> 中文名(取自 references/design-logic.md 的定稿命名)。下拉菜单显示中文, 内部仍用键名传参。 */
    var PATTERN_LABELS = {
        parallel: '单向平行纹', facet: '折面平行纹', flow: '顺势流线', content_flow: '随形流场', wave: '平行波纹', zigzag: '连续折线纹',
        chevron: '鱼骨纹', feather: '羽片纹', herringbone: '人字错列纹', bilateral_flow: '双向流线',
        meander: '回纹', contour: '等距轮廓纹', topographic: '地形等高纹', fan: '扇形纹',
        concentric: '同心纹', ripple: '涟漪纹',
        vortex: '涡旋流场', petal_rosette: '花瓣玫瑰纹', diamond_lattice: '菱形网格', diamond_tri: '三角菱格纹',
        moire_radial: '辐射摩尔纹', triangle_lattice: '三角网格',
        hex_lattice: '六角蜂巢纹', checker: '棋盘方向纹', carbon_fiber: '碳纤维纹', scale: '鳞片纹',
        dash_field: '错相短线场', dot_field: '点阵纹', short_curve: '稠密短曲线'
    };
    function patternLabel(key) { return PATTERN_LABELS[key] || String(key); }
    function patternLabelList() {
        var out = [];
        for (var i = 0; i < PATTERNS.length; i++) out.push(patternLabel(PATTERNS[i]));
        return out;
    }
    var DEFAULT_PATTERN = 'facet';
    var MIN_LINE_MM = 0.10;
    /* 内容拆分(实验性)的分类模式 */
    var SPLIT_MODES = ['auto', 'character', 'scenery', 'interior'];
    var SPLIT_MODE_LABELS = { auto: '自动', character: '人物', scenery: '景色', interior: '室内' };
    function splitModeLabel(key) { return SPLIT_MODE_LABELS[key] || String(key); }
    function splitModeIndex(key) { for (var m = 0; m < SPLIT_MODES.length; m++) if (SPLIT_MODES[m] === key) return m; return 0; }

    function DEFAULTS() {
        return {
            enabled: true,
            pattern: DEFAULT_PATTERN,
            line_mm: '0.15', gap_dense_mm: '0.12', gap_mid_mm: '0.15', gap_sparse_mm: '0.20',
            direction_deg: '0', amplitude_mm: '0.9', wavelength_mm: '12', segment_length_mm: '2',
            inner_radius_mm: '0', center_x: '0.5', center_y: '0.5', path_tolerance_px: '1.0',
            extra: '',
            split: false,          // 内容拆分(实验性): 勾选后点"执行拆分"处理该层
            split_mode: 'auto'     // auto|character|scenery|interior
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
        /* 一次性给出全部建议: 名字规则选候选集, 再按"相邻区块不同纹样/不同家族 + 全库用量轮换"定稿。 */
        var initialSugg = ZG.suggestAll(infos, src.width.as('px'), src.height.as('px'));
        for (i = 0; i < infos.length; i++) {
            var a = copyDefaults();
            var s0 = initialSugg[i];
            a.pattern = s0.pattern;
            a.direction_deg = String(s0.direction_deg);
            a.enabled = infos[i].visible && !s0.skip; // 隐藏层、整图合成层和明确排除层默认不生成
            asg.push(a);
        }

        var dlg = new Window('dialog', '折光纹工具箱 · 生成折光纹（手动分配）');
        dlg.orientation = 'column';
        dlg.alignChildren = 'left';
        dlg.preferredSize.width = 950;

        dlg.add('statictext', undefined, '源: ' + src.name + '   Photoshop ' + app.version + '  (共 ' + infos.length + ' 层; 最小线宽固定 ' + MIN_LINE_MM + ' mm)');

        // ---- 图层列表 ----
        dlg.add('statictext', undefined, '图层分配（点选一行编辑；列表即生成顺序：子层优先，组容器排在其子层之后；隐藏层、整图合成层和明确排除层默认不生成）');
        var lb = dlg.add('listbox', undefined, undefined);
        lb.preferredSize.width = 916; lb.preferredSize.height = 150;

        function rowText(idx) {
            var a = asg[idx];
            return (a.enabled ? '[启用]' : '[跳过]') + (a.split ? ' [拆分:' + splitModeLabel(a.split_mode) + ']' : '') + '  ' + patternLabel(a.pattern) + '(' + a.pattern + ')  ' + infos[idx].path + (infos[idx].visible ? '' : '  (隐藏)');
        }
        function refreshList() {
            refreshingList = true;
            var sel = lb.selection ? lb.selection.index : 0;
            lb.removeAll();
            for (var n = 0; n < infos.length; n++) lb.add('item', rowText(n));
            if (sel >= 0 && sel < lb.items.length) lb.selection = lb.items[sel];
            refreshingList = false;
        }

        // ---- 参数与纹样预览并排显示 ----
        var body = dlg.add('group'); body.orientation = 'row'; body.alignChildren = ['left', 'top'];
        var p = body.add('panel', undefined, '当前图层参数');
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
        var anCb = r0.add('checkbox', undefined, '读取画面内容');
        anCb.value = true;
        anCb.helpTip = '点"建议当前层/建议全部"时先分析画面（走向/一致度/弯折/径向/细节，每层约 1-2 秒），按内容修正纹样与方向；关闭则只用名称与几何规则（更快）。';
        r0.add('statictext', undefined, '   纹样:');
        var dd = r0.add('dropdownlist', undefined, patternLabelList());
        dd.selection = dd.items[0];

        var r0b = p.add('group'); r0b.orientation = 'row'; r0b.alignChildren = 'left';
        var splitCb = r0b.add('checkbox', undefined, '内容拆分（实验性）');
        splitCb.value = false;
        splitCb.helpTip = '实验性功能，谨慎使用：按画面内容把当前图层拆成多个命名子图层（如 轮廓线稿/脸部/头发/衣物/天空/地面/墙面/书架…），原图层会变成一个组，组内保留一个隐藏的原始备份。\n勾选后点下方"执行拆分（实验性）"；执行前会先把当前文档另存一份副本（文件名带 -拆分前副本）。\n分类模式：自动（按画面猜人物/景色）、人物、景色、室内。每层约半分钟。';
        var splitDd = r0b.add('dropdownlist', undefined, ['自动（推荐）', '人物', '景色', '室内']);
        splitDd.selection = splitDd.items[0];
        splitDd.helpTip = '内容拆分的分类模式：自动会先找脸部判断是否人物层；也可强制指定 人物/景色/室内 规则。';
        r0b.add('statictext', undefined, '  勾选后点下方"执行拆分（实验性）"：会先另存副本，再逐层拆分');

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

        var previewPanel = body.add('panel', undefined, '纹样预览');
        previewPanel.orientation = 'column'; previewPanel.alignChildren = 'left';
        previewPanel.preferredSize.width = 214;
        var previewFolder = new Folder(new Folder(scriptDir).parent.fsName + '/texture-preview');
        function previewFile(key) {
            return new File(previewFolder.fsName + '/' + patternLabel(key) + '-' + key + '.png');
        }
        var initialPreviewFile = previewFile(DEFAULT_PATTERN);
        var previewImage = previewPanel.add('image', undefined, initialPreviewFile.exists ? initialPreviewFile : undefined);
        previewImage.preferredSize = [188, 188];
        // The source PNG is 256x256; drawImage fits it into the smaller viewport.
        previewImage.onDraw = function () {
            if (this.image) this.graphics.drawImage(this.image, 0, 0, this.size.width, this.size.height);
        };
        var previewName = previewPanel.add('statictext', undefined, '');
        var previewKey = previewPanel.add('statictext', undefined, '');
        var previewNote = previewPanel.add('statictext', undefined, '示意图；参数不实时重绘');
        function updatePreview(key) {
            var file = previewFile(key);
            previewName.text = patternLabel(key);
            previewKey.text = key;
            try {
                if (file.exists) previewImage.image = file;
                else { try { previewImage.image = null; } catch (eN) {} }   // 控件不接受 null 时忽略, 避免把整个宏打挂
                previewNote.text = file.exists ? '示意图；参数不实时重绘' : '缺少预览图：texture-preview';
            } catch (e) {
                try { previewImage.image = null; } catch (eN2) {}
                previewNote.text = '预览图读取失败';
            }
            if (dlg.visible) dlg.update();
        }

        // ---- 编辑逻辑 ----
        function selectedIndex() { return lb.selection ? lb.selection.index : -1; }
        function patIndex(name) { for (var m = 0; m < PATTERNS.length; m++) if (PATTERNS[m] === name) return m; return 0; }
        function selectedPatternKey() {   // 下拉菜单显示中文, 取键名按索引回查
            return (dd.selection && dd.selection.index >= 0 && dd.selection.index < PATTERNS.length) ? PATTERNS[dd.selection.index] : DEFAULT_PATTERN;
        }
        function loadIntoFields(idx) {
            var a = asg[idx];
            enabledCb.value = a.enabled;
            splitCb.value = !!a.split;
            splitDd.selection = splitDd.items[splitModeIndex(a.split_mode)];
            dd.selection = dd.items[patIndex(a.pattern)];
            eLine.text = a.line_mm; eDir.text = a.direction_deg; eAmp.text = a.amplitude_mm; eWave.text = a.wavelength_mm;
            eDense.text = a.gap_dense_mm; eMid.text = a.gap_mid_mm; eSparse.text = a.gap_sparse_mm; eSeg.text = a.segment_length_mm;
            eTol.text = a.path_tolerance_px; eCx.text = a.center_x; eCy.text = a.center_y; eInner.text = a.inner_radius_mm; eExtra.text = a.extra;
            updatePreview(a.pattern);
            updateHint(idx);
        }
        function fieldsToAssign(idx) {
            var a = asg[idx];
            a.enabled = enabledCb.value;
            a.split = splitCb.value;
            a.split_mode = SPLIT_MODES[splitDd.selection.index] || 'auto';
            a.pattern = selectedPatternKey();
            a.line_mm = eLine.text; a.direction_deg = eDir.text; a.amplitude_mm = eAmp.text; a.wavelength_mm = eWave.text;
            a.gap_dense_mm = eDense.text; a.gap_mid_mm = eMid.text; a.gap_sparse_mm = eSparse.text;
            a.segment_length_mm = eSeg.text; a.path_tolerance_px = eTol.text; a.center_x = eCx.text; a.center_y = eCy.text; a.inner_radius_mm = eInner.text; a.extra = eExtra.text;
            updateHint(idx);
        }
        var editingIndex = -1, refreshingList = false;
        dd.onChange = function () { updatePreview(selectedPatternKey()); };
        splitCb.onClick = function () { var k = selectedIndex(); if (k < 0) return; asg[k].split = splitCb.value; refreshList(); };
        splitDd.onChange = function () { var k = selectedIndex(); if (k < 0) return; asg[k].split_mode = SPLIT_MODES[splitDd.selection.index] || 'auto'; refreshList(); };
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
            var pats = [];
            for (var n = 0; n < infos.length; n++) pats.push(asg[n].pattern);
            var s = ZG.suggestFor(infos, src.width.as('px'), src.height.as('px'), k, pats);
            hint.text = '建议: ' + (s.skip ? '[跳过] ' : '') + patternLabel(s.pattern) + '(' + s.pattern + ')' + (s.reason ? '  ' + s.reason : '');
        }
        var aReuse = {}, analysisCache = {};
        /* 按需分析画面内容(结果按图层 id 缓存); 关闭勾选时返回 null。 */
        function analysisOf(k) {
            if (!anCb.value) return null;
            var id = infos[k].id;
            if (analysisCache[id] !== undefined) return analysisCache[id];
            var an = ZG.analyzeLayer(src, infos[k].layer, aReuse);
            analysisCache[id] = an;
            return an;
        }
        function applySuggest(k) {
            infos[k].analysis = analysisOf(k);
            var pats = [];
            for (var n = 0; n < infos.length; n++) pats.push(asg[n].pattern);
            var s = ZG.suggestFor(infos, src.width.as('px'), src.height.as('px'), k, pats);
            asg[k].pattern = s.pattern;
            asg[k].direction_deg = String(s.direction_deg);
            asg[k].enabled = !s.skip;
            return s;
        }
        function applySuggestAll() {
            for (var k = 0; k < infos.length; k++) {
                if (anCb.value) {
                    hint.text = '读取画面内容 ' + (k + 1) + '/' + infos.length + ' …';
                    try { dlg.update(); } catch (eU) {}
                }
                infos[k].analysis = analysisOf(k);
            }
            var sugg = ZG.suggestAll(infos, src.width.as('px'), src.height.as('px'));
            for (var n = 0; n < infos.length; n++) {
                asg[n].pattern = sugg[n].pattern;
                asg[n].direction_deg = String(sugg[n].direction_deg);
                asg[n].enabled = !sugg[n].skip;
            }
        }

        // ---- 按钮 (紧凑两行) ----
        var gb1 = dlg.add('group'); gb1.orientation = 'row'; gb1.alignChildren = 'left';
        var bSuggest = gb1.add('button', undefined, '建议当前层');
        var bSuggestAll = gb1.add('button', undefined, '建议全部');
        var bApply = gb1.add('button', undefined, '应用到当前层');
        var bApplyAll = gb1.add('button', undefined, '线宽/间隙应用到全部');
        bSuggest.onClick = function () { var k = selectedIndex(); if (k < 0) { alert('请先点选一个图层'); return; } applySuggest(k); loadIntoFields(k); refreshList(); };
        bSuggestAll.onClick = function () { applySuggestAll(); refreshList(); if (lb.items.length) { lb.selection = lb.items[0]; editingIndex = 0; loadIntoFields(0); } };
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
        gb2.add('statictext', undefined, '   ');
        var bSplit = gb2.add('button', undefined, '执行拆分（实验性）');
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

        // ---- 内容拆分(实验性) ----
        /* 先另存副本, 再逐层拆分; 拆完重建图层列表(文档结构已改变)。 */
        function savePreSplitCopy() {
            var opts = new PhotoshopSaveOptions();
            try { opts.embedColorProfile = true; } catch (e0) {}
            try { opts.alphaChannels = true; } catch (e1) {}
            try { opts.layers = true; } catch (e2) {}
            var target = null;
            if (src.path) {
                var nm = String(src.name).replace(/\.(psd|psb|tif|tiff|png)$/i, '');
                target = new File(src.path.fsName + '/' + nm + '-拆分前副本.psd');
            } else {
                var dir = Folder.selectDialog('当前文档尚未保存过。请选择存放"拆分前副本"的目录');
                if (!dir) return null;
                target = new File(dir.fsName + '/' + String(src.name) + '-拆分前副本.psd');
            }
            src.saveAs(target, opts, true);   // asCopy=true: 只写副本, 不影响当前文档
            return target;
        }
        function rebuildAfterSplit() {
            infos = [];
            ZG.collectLayers(src, '', infos);
            if (!infos.length) { dlg.close(); return; }
            var sugg2 = ZG.suggestAll(infos, src.width.as('px'), src.height.as('px'));
            asg = [];
            for (var n2 = 0; n2 < infos.length; n2++) {
                var a2 = copyDefaults();
                a2.pattern = sugg2[n2].pattern;
                a2.direction_deg = String(sugg2[n2].direction_deg);
                a2.enabled = infos[n2].visible && !sugg2[n2].skip;
                asg.push(a2);
            }
            analysisCache = {};
            editingIndex = -1;
            refreshList();
            if (lb.items.length) { lb.selection = lb.items[0]; editingIndex = 0; loadIntoFields(0); }
        }
        function doSplit() {
            var k = selectedIndex(); if (k >= 0) fieldsToAssign(k);
            var targets = [];
            for (var n = 0; n < infos.length; n++) if (asg[n].split) targets.push(n);
            if (!targets.length) { alert('没有勾选要拆分的图层。\n\n在图层行点选后，勾选参数区的“内容拆分（实验性）”，再点“执行拆分（实验性）”。'); return; }
            if (!confirm('内容拆分（实验性，谨慎使用）\n\n将对 ' + targets.length + ' 个图层按画面内容拆分成多个命名子图层：\n原图层会变成一个组，组内保留一个隐藏的原始备份。\n\n执行前会先把当前文档另存一份副本（文件名带“-拆分前副本”）。\n每层约需半分钟，请勿操作 Photoshop。\n\n继续？')) return;
            var copyFile = null;
            hint.text = '正在另存拆分前副本 …';
            try { dlg.update(); } catch (eU0) {}
            try {
                copyFile = savePreSplitCopy();
            } catch (eS) {
                if (!confirm('另存副本失败：' + (eS && eS.message ? eS.message : String(eS)) + '\n\n仍要继续拆分吗？（建议先手动另存一份）')) { hint.text = ''; return; }
            }
            var done = [], fails = [];
            for (var t = 0; t < targets.length; t++) {
                var idx = targets[t];
                hint.text = '内容拆分 ' + (t + 1) + '/' + targets.length + '：' + infos[idx].path + ' …（每层约半分钟）';
                try { dlg.update(); } catch (eU1) {}
                var r = null;
                try {
                    r = ZG.splitLayer(src, infos[idx].layer, aReuse, { mode: asg[idx].split_mode, k: 10, longSide: 256, minClassFrac: 0.003 });
                } catch (eX) {
                    r = { ok: false, err: (eX && eX.message ? eX.message : String(eX)) };
                }
                if (r && r.ok) {
                    var names = [];
                    for (var pi = 0; pi < r.parts.length; pi++) names.push(r.parts[pi].name + ' ' + Math.round(r.parts[pi].frac * 100) + '%');
                    done.push(infos[idx].path + ' → ' + r.group + '：' + names.join('、'));
                } else {
                    fails.push(infos[idx].path + '：' + (r && r.err ? r.err : '未知错误') + (r && r.errors && r.errors.length ? '；' + r.errors.join('；') : ''));
                }
            }
            hint.text = '';
            var msg = '内容拆分完成。\n\n成功 ' + done.length + ' 层：\n' + (done.length ? done.join('\n') : '（无）');
            if (fails.length) msg += '\n\n失败 ' + fails.length + ' 层：\n' + fails.join('\n');
            if (copyFile) msg += '\n\n拆分前副本：' + copyFile.fsName;
            alert(msg);
            try {
                rebuildAfterSplit();
            } catch (eR) {
                alert('拆分后刷新图层列表失败：' + (eR && eR.message ? eR.message : String(eR)) + '\n请关闭窗口后重新运行脚本。');
            }
        }
        bSplit.onClick = function () { doSplit(); };

        // ---- 生成逻辑 ----
        function parseNum(t) { var v = parseFloat(t); return isNaN(v) ? null : v; }
        function doGenerate() {
            var outDir = Folder.selectDialog('选择输出目录');
            if (!outDir) return;
            var layers = [];
            for (var n = 0; n < infos.length; n++) {
                var a = asg[n];
                var entry = { source_path: infos[n].path, source_id: infos[n].id, enabled: a.enabled, pattern: a.pattern };
                if (infos[n].analysis) entry.analysis = infos[n].analysis;
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
            } finally {
                if (aReuse.doc) { try { aReuse.doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eAC) {} aReuse.doc = null; }
            }
        }

        refreshList();
        if (lb.items.length) { lb.selection = lb.items[0]; editingIndex = 0; loadIntoFields(0); }

        /* 关掉交互对话框: 分析/拆分/生成过程中的命令错误(如"合并可见图层不可用")不应弹窗卡住流程 */
        var oldDialogs = app.displayDialogs;
        try { app.displayDialogs = DialogModes.NO; } catch (eD0) {}
        try {
            dlg.show();
            if (!ok) return;
            doGenerate();
        } finally {
            try { app.displayDialogs = oldDialogs; } catch (eD1) {}
        }
    }

    try {
        var coreFile = findCore();
        if (!coreFile) throw new Error('找不到 refraction_core.jsx。请确认它与 generate_refraction_gui.jsx 在同一个目录里, 并用 文件→脚本→浏览 打开本脚本。' + (scriptDir ? ('\n脚本目录: ' + scriptDir) : '\n(无法确定脚本目录: $.fileName 为空, 可能不是用 文件→脚本 运行的)'));
        $.evalFile(coreFile);
        main();
    } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        var loc = '';
        if (e && e.fileName) loc += '\n文件: ' + e.fileName;
        if (e && e.line !== undefined) loc += '\n行: ' + e.line;
        var wroteLog = false;
        if (scriptDir) try {
            var lf = new File(scriptDir + '/zg_error_log.txt');
            lf.encoding = 'UTF8';
            if (lf.open('w')) { lf.write(msg + loc); lf.close(); wroteLog = true; }
        } catch (e2) {}
        alert('折光纹宏出错:\n' + msg + loc + (wroteLog ? '\n\n详情已写入脚本目录 zg_error_log.txt' : ''));
    }
}());
