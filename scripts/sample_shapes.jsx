#target photoshop
/* Independent rectangular samples; not an automatic segmentation tool.
   Closed filled ribbons are native Photoshop shape layers.
   Adjust parameters below as needed. */
(function () {
    var cfg = { minLine:0.10, line:0.15, minGap:0.12, dense:0.12, sparse:0.20, ppi:600, width:90, height:50 };
    if (cfg.line < cfg.minLine || cfg.dense < cfg.minGap || cfg.sparse < cfg.dense) throw Error('Inconsistent minimum width/gap settings.');
    var parent = typeof ZG_SAMPLE_PARENT !== 'undefined' ? new Folder(ZG_SAMPLE_PARENT) : Folder.selectDialog('Choose sample output parent');
    if (!parent) return;
    if (!parent.exists) throw Error('Output parent does not exist.');
    var oldUnits=app.preferences.rulerUnits, oldDialogs=app.displayDialogs, doc;
    var previousExportParent = $.global.ZG_EXPORT_PARENT;
    var c=charIDToTypeID, s=stringIDToTypeID, scale=cfg.ppi/25.4;
    var scriptDir = new File($.fileName).parent;
    function sibling(name) {   // 同目录文件: 先 getFiles 取 File 对象, 再退回手拼路径
        try { var c = scriptDir.getFiles(name); if (c && c.length) return c[0]; } catch (e0) {}
        return new File(scriptDir.fsName + '/' + name);
    }
    function shape(polys, name, group) {
        var subs=[];
        for(var k=0;k<polys.length;k++) {
            var points=[];
            for(var j=0;j<polys[k].length;j++) {var p=new PathPointInfo();p.kind=PointKind.CORNERPOINT;p.anchor=[polys[k][j][0]*scale,polys[k][j][1]*scale];p.leftDirection=p.anchor;p.rightDirection=p.anchor;points.push(p);}
            var sub=new SubPathInfo();sub.closed=true;sub.operation=ShapeOperation.SHAPEADD;sub.entireSubPath=points;subs.push(sub);
        }
        /* 顺序与 refraction_core.jsx 的 createSolidShape 一致: 先建路径并选中, 再 Mk contentLayer,
         * 新形状层会自动把当前路径作为矢量蒙版 —— 不要反过来"先建层再挂蒙版":
         * PS 2020/21.2 上给已带矢量蒙版的层再挂路径会悄悄加出一个位图蒙版(export_groups 会拒收)。 */
        var path=doc.pathItems.add('ZG_temp_path',subs);
        path.select();
        var d=new ActionDescriptor(), ref=new ActionReference(); ref.putClass(s('contentLayer')); d.putReference(c('null'),ref);
        var use=new ActionDescriptor(), fill=new ActionDescriptor(), rgb=new ActionDescriptor();
        rgb.putDouble(c('Rd  '),0);rgb.putDouble(c('Grn '),0);rgb.putDouble(c('Bl  '),0);
        fill.putObject(c('Clr '),c('RGBC'),rgb);use.putObject(c('Type'),s('solidColorLayer'),fill);d.putObject(c('Usng'),s('contentLayer'),use);
        executeAction(c('Mk  '),d,DialogModes.NO);
        var layer=doc.activeLayer;layer.name=name;
        path.remove();
        var vr=new ActionReference();vr.putIdentifier(s('layer'),layer.id);var vd=executeActionGet(vr);
        if(layer.kind!==LayerKind.SOLIDFILL||!vd.hasKey(s('hasVectorMask'))||!vd.getBoolean(s('hasVectorMask')))throw Error('形状层建立失败(缺矢量蒙版): '+name);
        layer.move(group,ElementPlacement.INSIDE);
        return layer;
    }
    try {
        app.preferences.rulerUnits=Units.PIXELS;app.displayDialogs=DialogModes.NO;
        doc=app.documents.add(UnitValue(Math.round(cfg.width*scale),'px'),UnitValue(Math.round(cfg.height*scale),'px'),cfg.ppi,'ZG_shape_samples',NewDocumentMode.RGB,DocumentFill.TRANSPARENT,1,BitsPerChannelType.EIGHT);
        var blank=doc.activeLayer, info=['Native shape samples. Rectangular panels only.','Line minimum='+cfg.minLine+' mm; gap minimum='+cfg.minGap+' mm.','Actual ribbon width includes slope allowance and 0.01 mm reserve.','Analytic minimum applies to ribbon bodies, not arbitrary future masks.'];
        for(var panel=0;panel<3;panel++) {
            var name=['parallel','flow','chevron'][panel], group=doc.layerSets.add();group.name='ZG_OUT__00'+(panel+1)+'__'+name;group.blendMode=BlendMode.NORMAL;
            var amp=panel===1?0.9:0, lambda=12, slope=panel===1?amp*2*Math.PI/lambda:(panel===2?0.4:0);
            var allowance=Math.sqrt(1+slope*slope), thick=(cfg.line+0.01)*allowance;
            var y=5, index=0, batch=[];
            function f(x) { if(panel===1)return amp*Math.sin(2*Math.PI*x/lambda); if(panel===2)return 0.4*Math.abs(x-11); return 0; }
            while(y+thick+5<46) {
                var poly=[], x0=4+panel*29, count=panel===2?2:88;
                for(var a=0;a<=count;a++) {var x=22*a/count;poly.push([x0+x,y+f(x)]);}
                for(var b=count;b>=0;b--) {var xx=22*b/count;poly.push([x0+xx,y+f(xx)+thick]);}
                batch.push(poly);index++;
                if(batch.length===4) {shape(batch,name+'_'+index,group);batch=[];}
                var u=Math.min(1,(y-5)/35), smooth=u*u*(3-2*u), gap=cfg.sparse+(cfg.dense-cfg.sparse)*smooth;
                y+=thick+(gap+0.02)*allowance;
            }
            if(batch.length)shape(batch,name+'_'+index,group);
            info.push(name+': '+index+' ribbons; vertical thickness='+thick+' mm; slopeBound='+slope);
        }
        blank.remove();
        var out = new Folder(parent.fsName+'/ZG_sample_'+new Date().getTime());if(out.exists||!out.create())throw Error('Cannot create sample folder.');
        var opts=new PhotoshopSaveOptions();opts.layers=true;opts.embedColorProfile=true;
        doc.saveAs(new File(out.fsName+'/master_shapes.psd'),opts,false,Extension.LOWERCASE);
        var log=new File(out.fsName+'/sample_parameters.txt');log.encoding='UTF8';log.open('w');log.write(info.join('\n'));log.close();
        $.global.ZG_EXPORT_PARENT=out.fsName;
        $.evalFile(sibling('export_groups.jsx'));
        $.global.ZG_LAST_SAMPLE=out.fsName;
    } finally {
        if (typeof previousExportParent === 'undefined') delete $.global.ZG_EXPORT_PARENT;
        else $.global.ZG_EXPORT_PARENT = previousExportParent;
        app.preferences.rulerUnits=oldUnits;app.displayDialogs=oldDialogs;
    }
}());
