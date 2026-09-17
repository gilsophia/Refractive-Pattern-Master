#target photoshop
/* Export only prepared ZG_OUT__ groups (any nesting depth). Never overwrite source.
 * 母版里的输出组现在按源图层层级嵌套: 只导出"带形状层的纹样组", 纯容器组不单独导出;
 * 命名含不折光标记而被隐藏的组按设计跳过, 并记录到清单。 */
(function () {
    var src, oldUnits = app.preferences.rulerUnits, oldDialogs = app.displayDialogs;
    var tmp = null, rows = [], out;
    function s(v) { return stringIDToTypeID(v); }
    function quote(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
    function safe(v) { return v.replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').substr(0, 90); }
    function pad(v) { return v < 10 ? '0' + v : String(v); }
    function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '_' + pad(d.getMilliseconds()); }
    function check(layer) {
        if (!layer.visible) throw Error('Hidden output content: ' + layer.name);
        if (layer.opacity !== 100) throw Error('Opacity must be 100: ' + layer.name);
        if (layer.blendMode !== BlendMode.NORMAL && !(layer.typename === 'LayerSet' && layer.blendMode === BlendMode.PASSTHROUGH)) throw Error('Unsupported blend mode: ' + layer.name);
        var ref = new ActionReference(); ref.putIdentifier(s('layer'), layer.id);
        var desc = executeActionGet(ref);
        if (desc.hasKey(s('layerEffects'))) throw Error('Remove layer effects: ' + layer.name);
        if (desc.hasKey(s('hasUserMask')) && desc.getBoolean(s('hasUserMask'))) throw Error('Pixel mask requires separate disclosed workflow: ' + layer.name);
        if (layer.typename === 'LayerSet') {
            if (!layer.layers.length) throw Error('Empty group: ' + layer.name);
            for (var k=0;k<layer.layers.length;k++) check(layer.layers[k]);
        } else {
            if (layer.kind !== LayerKind.SOLIDFILL || !desc.hasKey(s('hasVectorMask')) || !desc.getBoolean(s('hasVectorMask'))) throw Error('Expected a solid shape with vector mask: ' + layer.name);
            if (layer.fillOpacity !== 100) throw Error('Fill opacity must be 100: ' + layer.name);
        }
    }
    try {
        if (!app.documents.length) throw Error('Open the prepared RGB shape master first.');
        src = app.activeDocument;
        if (src.mode !== DocumentMode.RGB || src.bitsPerChannel !== BitsPerChannelType.EIGHT) throw Error('Use a dedicated RGB/8 shape master.');
        var groups = [], hidden = [], containers = 0;
        function collect(container) {
            for (var i = 0; i < container.layerSets.length; i++) {
                var g = container.layerSets[i];
                if (String(g.name).indexOf('ZG_OUT__') !== 0) continue;
                if (g.artLayers.length) {
                    if (g.visible) { check(g); groups.push(g); }
                    else hidden.push(g.name);          // 不折光命名 → 生成后隐藏, 按设计不导出
                } else {
                    containers++;                       // 纯容器组, 其子组会各自导出
                }
                collect(g);
            }
        }
        collect(src);
        if (!groups.length) throw Error('No visible ZG_OUT__ pattern groups.');
        var parent = typeof ZG_EXPORT_PARENT !== 'undefined' ? new Folder(ZG_EXPORT_PARENT) : Folder.selectDialog('Choose export parent folder');
        if (!parent) return;
        if (!parent.exists) throw Error('Export parent does not exist.');
        out = new Folder(parent.fsName + '/ZG_export_' + stamp());
        if (out.exists || !out.create()) throw Error('Cannot create unique export directory.');
        app.preferences.rulerUnits = Units.PIXELS;
        app.displayDialogs = DialogModes.NO;
        var w = src.width.as('px'), h = src.height.as('px'), ppi = src.resolution;
        rows.push('source_group,file_base,width_px,height_px,ppi');
        for (var j=0;j<groups.length;j++) {
            tmp = app.documents.add(UnitValue(w,'px'), UnitValue(h,'px'), ppi, 'ZG_export_temp', NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT);
            var blank = tmp.activeLayer;
            app.activeDocument = src;
            var copied = groups[j].duplicate(tmp, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = tmp;
            copied.visible = true;
            blank.remove();
            var base = pad(j+1) + '__' + safe(groups[j].name);
            var psd = new PhotoshopSaveOptions(); psd.layers = true; psd.embedColorProfile = true; psd.alphaChannels = true;
            tmp.saveAs(new File(out.fsName + '/' + base + '.psd'), psd, true, Extension.LOWERCASE);
            var png = new PNGSaveOptions(); png.interlaced = false; png.compression = 6;
            // 不显式设 compression 时 Photoshop 默认按 0(不压缩)存, 线稿 PNG 会比压缩后大数百倍
            tmp.saveAs(new File(out.fsName + '/' + base + '.png'), png, true, Extension.LOWERCASE);
            rows.push([quote(groups[j].name),quote(base),w,h,ppi].join(','));
            tmp.close(SaveOptions.DONOTSAVECHANGES); tmp = null;
        }
        var report = new File(out.fsName + '/export_manifest.csv'); report.encoding = 'UTF8';
        if (!report.open('w')) throw Error('Cannot write manifest.'); report.write('\uFEFF' + rows.join('\n')); report.close();
        if (hidden.length) {
            var skipLog = new File(out.fsName + '/skipped_hidden_groups.txt'); skipLog.encoding = 'UTF8';
            if (skipLog.open('w')) { skipLog.write('\uFEFF' + '按不折光命名隐藏、未导出的组:\r\n' + hidden.join('\r\n')); skipLog.close(); }
        }
        $.global.ZG_LAST_EXPORT = out.fsName;
        if (typeof ZG_QUIET === 'undefined' || !ZG_QUIET) alert('Exported ' + groups.length + ' groups' + (hidden.length ? ' (' + hidden.length + ' hidden groups skipped)' : '') + ':\n' + out.fsName + '\nRun PNG and geometry QA before production.');
    } catch (e) {
        if (out && out.exists) { var err = new File(out.fsName + '/EXPORT_FAILED.txt'); err.encoding='UTF8'; if(err.open('w')) {err.write(String(e));err.close();} }
        throw e;
    } finally {
        if (tmp) tmp.close(SaveOptions.DONOTSAVECHANGES);
        if (src) app.activeDocument = src;
        app.preferences.rulerUnits = oldUnits; app.displayDialogs = oldDialogs;
    }
}());
