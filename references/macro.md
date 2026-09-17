# 折光纹母版生成宏

把 [工作流](../工作流.md) 里**确定性的几何生成 + 图层构造 + 母版输出**一段封装成 Photoshop 内可直接运行的宏。几何与图层构造由 `scripts/refraction_core.jsx` 提供，两个入口共用：

| 入口 | 适用 | 说明 |
|---|---|---|
| `generate_refraction_gui.jsx` | **不需要外部配置** | 弹窗列出源 PSD 全部图层，逐层勾选启用、选纹样、填参数，点生成即出母版 |
| `generate_refraction.jsx` | 已有 `job.json` 分配表 | 读 `job.json` 图层分配，按配置生成 |

两种方式都生成纯黑矢量形状、裁到各层可见区域、建立 `ZG_OUT__` 组，另存独立折光纹母版 PSD，不覆盖源 PSD。

## 运行方式（手动分配 GUI）

1. 在 Photoshop 中打开源 PSD。
2. `文件 → 脚本 → 浏览`，选择 `scripts/generate_refraction_gui.jsx`。
3. 弹窗内：点选图层 → 勾选「生成折光纹」、选纹样、填参数 →「应用到当前层」或「应用到全部启用层」。
4. 点「生成」，选输出目录，得到 `ZG_master_<时间戳>.psd` 与 `master_report_<时间戳>.txt`。

GUI 中最小线宽固定 `0.10 mm`；隐藏层默认不生成（可手动勾选启用）。下拉提供全部已实现纹样（见下表），**菜单里显示中文名**（如 `折面平行纹`、`回纹`、`六角蜂巢纹`），图层列表行里写成「中文名(键名)」便于和 `job.json`、文档对照；内部仍按键名传参，中文名与键的对应取自 `design-logic.md` 的定稿命名。`高级参数` 框可用逗号分隔 `key=value` 传入如 `branch_angle_deg=30, sector_count=10, petal_count=8, fan_arc_deg=90`。

### 智能建议（本地规则）

GUI 内置**确定性启发式建议**：选中图层即显示一行「建议: …(原因)」，可用「建议当前层 / 建议全部」一键采纳。规则为：

1. 图层名关键词匹配（中英文，见 `refraction_core.jsx` 的 `suggest` 表）：如「头发/hair→flow、脸/face→跳过、背景/bg→parallel、云/cloud→contour、水/water→wave、光环/halo→radial、羽/wing→feather、花/petal→petal_rosette、边框/frame→meander、鳞/scale→scale、科技→hex_lattice、文字/text→跳过」等。
2. 图层名含「不加折光 / [SKIP] / NO_REFRACTION」等 → 建议跳过。
3. 几何兜底：细长（长宽比>3）→ flow（方向沿长轴）；占画布<3% 的小区域 → short_curve；否则 → parallel。

建议只改纹样、方向与是否启用，不改线宽/净隙（仍用默认值或你已填的值）；它是**辅助提示而非自动决策**，采纳后仍可手动修改。

## 运行方式（job.json）

1. 打开源 PSD（或由 `job.json` 的 `source_psd` 指定）。
2. `文件 → 脚本 → 浏览`，选择 `scripts/generate_refraction.jsx`。
3. 选择 `job.json`，生成完成。

## job.json 结构

顶层：

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_psd` | string | 源 PSD 绝对路径；为空则用当前活动文档。反斜杠需写成 `\\` |
| `canvas` | object | 可选；`width_mm`/`height_mm`/`resolution_ppi`，不填则沿用源 PSD 画布与 ppi |
| `output_dir` | string | 可选；为空则输出到 job.json 所在目录 |
| `defaults` | object | 全局默认参数，可被逐层覆盖 |
| `layers` | array | 逐层分配，见下 |

`layers[]` 每项（仅 `enabled=false` 的项可只写 `source_path`）：

| 字段 | 说明 |
|---|---|
| `source_path` | 源图层完整路径，用 `/` 分隔，如 `人物/头发` |
| `enabled` | `false` 跳过；名称含 `不加折光`/`[SKIP]` 等标记也会自动跳过 |
| `output_name` | 输出组后缀名；缺省用叶子图层名 |
| `pattern` | 纹样键，见下方纹样表 |
| `line_mm` | 线宽（≥ `min_line_mm`） |
| `gap_dense_mm` / `gap_mid_mm` / `gap_sparse_mm` | 三档净隙，须 dense≤mid≤sparse |
| `direction_deg` | 画布向右 0°、向下 90°（方向类纹样的主轴） |
| `amplitude_mm` | 振幅（wave/zigzag）、鱼骨分支长基准（feather）、鳞片/点阵半径（scale/dot_field/petal 瓣宽） |
| `wavelength_mm` | 波长（wave/zigzag）；网格/单元格大小（herringbone/meander/lattice/checker/carbon/scale/hex/dot_field 等） |
| `gradient_axis` / `dense_end` | 密度渐变轴（`vertical`/`horizontal`/`none`）与密端（`top`/`bottom`/`left`/`right`） |
| `center_x` / `center_y` / `inner_radius_mm` | 中心类纹样中心（0–1 为画布比例，>1 视为 mm）与中心留空/起始半径 |
| `segment_length_mm` | 短线长（short_curve/dash_field/carbon_fiber） |
| `branch_angle_deg` | 鱼骨/羽片分支与主轴夹角（默认 45） |
| `sector_count` | sunburst 扇区数（默认 8） |
| `petal_count` | petal_rosette 花瓣数（默认 6） |
| `fan_arc_deg` | fan 扇形展开角（默认 120） |
| `path_tolerance_px` | 透明度→路径取样容差，越小越精确但节点越多 |

示例见 `scripts/job.example.json`。

## 纹样对照表

| 键 | 中文 | 宏内实现 | 键 | 中文 | 宏内实现 |
|---|---|---|---|---|---|
| `parallel` | 单向平行纹 | 实现（=facet 均匀） | `fan` | 扇形纹 | 实现 |
| `facet` | 折面平行纹 | 实现 | `cone` | 锥形/透视束纹 | 实现 |
| `flow` | 顺势流线 | 实现 | `sunburst` | 分区爆发纹 | 实现 |
| `wave` | 平行波纹 | 实现 | `concentric` | 同心纹 | 实现 |
| `zigzag` | 连续折线纹 | 实现 | `ripple` | 涟漪纹 | 实现（三心同心近似） |
| `chevron` | 鱼骨/脊线纹 | 实现（脊线+斜支） | `spiral` | 螺旋纹 | 实现 |
| `feather` | 羽片纹 | 实现（脊线+弯支） | `vortex` | 涡旋流场 | 实现（双臂螺旋近似） |
| `herringbone` | 人字错列纹 | 实现 | `petal_rosette` | 花瓣玫瑰纹 | 实现（椭圆花瓣） |
| `bilateral_flow` | 双向流线 | 实现（中缝留白） | `diamond_lattice` | 菱形网格 | 实现（两组斜线） |
| `meander` | 回纹/迷宫纹 | 实现（简化） | `triangle_lattice` | 三角网格 | 实现（三组线） |
| `contour` | 等距轮廓纹 | 实现 | `hex_lattice` | 六角蜂巢纹 | 实现 |
| `topographic` | 地形等高纹 | 实现（=contour） | `checker` | 棋盘方向纹 | 实现 |
| `radial` | 放射纹 | 实现 | `carbon_fiber` | 碳纤维纹 | 实现 |
| `scale` | 鳞片纹 | 实现（弧形搭接） | `dash_field` | 错相短线场 | 实现 |
| `dot_field` | 点阵/环点场 | 实现（环点） | `short_curve` | 稀疏短曲线 | 实现 |

**未实现（设计意图，宏会明确报错）**：`interlace`、`braid`、`cube_iso`、`guilloche`、`organic_field`，以及 F 组复合光学纹 `moire_pair`、`angle_switch`、`density_switch`、`latent_image`、`image_switch`。这些涉及交叉断口、随形变形场、遮罩第二图或对位/材料敏感，需按 [工作流](../工作流.md) 手工制作。

## 避免重复生成（默认开启）

源图里同一片区域常被多个图层覆盖（组容器≈其子层的并集、背景层压在角色下、边框压在所有层上）。若每层都按自己的区域生成，这片区域会叠上好几套纹样，几乎变成实黑。生成核心因此按**列表顺序**累加"已生成区域"，每层只生成 `本层区域 − 已生成区域`：

- **列表顺序 = 生成顺序 = 子层优先**：`collectLayers` 输出的是后序（组内子层先列，组容器排在其子层之后），因此细节纹样（outline/hair/gold…）先占位，组容器、背景层最后只补空隙。纯容器组（区域正好等于子层并集）的残留为空，会被记为 `COVERED` 并跳过。
- 实现方式是 Photoshop 的通道布尔：母版里临时建一个 Alpha 通道 `ZG_used_region`，每层用「路径→选区 → 减去已生成区域 → 转回工作路径」得到裁剪后的区域，再用它做组矢量蒙版与纹样区域；随后把本层区域并入该通道。**保存母版前删除该通道**，交付物里不留中间元素；组矢量蒙版仍是矢量路径，不是像素蒙版。
- GUI 里勾选「避免重复生成（子层优先）」可开关（默认开）；job.json 用 `no_overlap: false` 关闭。`fast` 诊断模式不参与。
- 完全被覆盖的层在报告里写 `COVERED`，数量记在 `master_report_*.txt` 的「避免重复生成」一行。若某版本无法建立通道（`channels.add` 失败），核心会记录警告并自动关闭该功能，其余照常生成。

## 不折光命名（模糊识别 + 生成后隐藏）

图层或**编组**命名里带「不折光」类的字样时，该层及其全部子项仍然**照常生成**，但生成的输出组会被**隐藏**（`visible=false`），使母版与源文件的层级/可见性对应；这些隐藏组不参与「避免重复生成」的占用计算，因此不会挡住下面真正要用的层。

- 识别为模糊匹配，中英文与简写都算：`不加折光 / 不需要折光 / 不折光 / 不做折光 / 不要折光 / 不用折光 / 无需折光 / 无须折光 / 免折光 / 不加纹 / 无纹 / 不做 / 不用 / 不要 / 跳过 / no_refraction / [SKIP] / skip`。
- 标记在编组上时对整棵子树生效（因为匹配的是图层完整路径）。例：`A编组/B子集/D图层` 中 A 带标记 → D 也生成后隐藏。
- 报告里这类层写成 `OK(hidden)`，`master_report_*.txt` 会统计「不折光命名(已生成但隐藏): N 组」。若希望某层彻底不生成，在 GUI 里取消勾选即可。

## 输出组的父子级

生成完成后，核心会按**源图层层级**把 `ZG_OUT__NNN__xxx` 组嵌进各自的父组（`layer.move(parent, INSIDE)`），只建立父子关系，**不建立剪辑蒙版**——区域裁切仍由每组自己的矢量蒙版负责。源里未生成的中间层会被跳过，子组挂到最近的已生成祖先上。报告里写「输出组父子级: 已嵌套 N 组」。

**容器组与「本层纹样」子组**：如果某层下面还有会被生成的子层，该层的区域蒙版不能挂在容器组上（否则会把嵌进来的子层一起裁掉）。因此这类层会生成两层结构：

```
ZG_OUT__051__front(person+falcon)-*不折光        ← 容器组, 无蒙版, 可见性按源/标记
    ZG_OUT__051__front(person+falcon)-*不折光 本层纹样   ← 本层纹样 + 区域矢量蒙版
    ZG_OUT__026__falcon                          ← 子层组(各自带蒙版)
    ZG_OUT__050__human
```

叶子层（没有要生成的子层）保持单层结构，直接是「纹样 + 区域蒙版」。`export_groups.jsx` 会递归收集所有 `ZG_OUT__` 组，只导出**带形状层的纹样组**（纯容器组不单独出文件），并把因不折光命名而隐藏的组记录到 `skipped_hidden_groups.txt`。

**把组移进组的写法要容错**：Photoshop 2020 实测 `LayerSet.move(target, ElementPlacement.INSIDE)` 会报「非法参数」，所以 `nestGroup()` 依次尝试三种写法——①直接 `move(INSIDE)`；②在目标组里放一个临时普通图层，把组 `move(..., PLACEBEFORE)` 到它前面；③ActionManager 的 `move` 命令——每种都校验「目标组子组数 +1 且顶层组数 −1」。任何写法都不成功时**不中断该层**：本层退回单层结构，该层子级不参与嵌套，并在 `zg_progress.txt` 写明警告；进度日志末尾的「输出组父子级: … 嵌套方式=N」会指出实际生效的写法（0 = 全部失败）。

## 输出结构

每个启用层生成一个顶层组 `ZG_OUT__NNN__输出名`，组内为纯黑（RGB `#000000`、正常混合、无效果）`solidColor` 形状层，区域裁剪以**组级矢量蒙版**实现（透明度取样路径，含孔洞子路径）。母版为透明 RGB/8。形状层按批建立：每批 ≤900 条子路径、≤60000 节点，且每条子路径 ≤1000 锚点。生成完成后按源层级嵌套（见上）。

## 边界与限制（务必知悉）

- **Photoshop 路径硬上限（已实测 2020/21.2）**：`pathItems.add()` 单条路径最多 **1000 个子路径**，每个子路径最多 **1000 个锚点**；超限直接抛「非法参数」，且旧版本会让整次生成中断。核心库现在会自动把超限几何压缩到上限内（形状层纹样用 Douglas-Peucker 压缩；区域蒙版子路径按曲线展平后压缩），并把单批上限设为 900 子路径。
- **单层失败不再中断整次生成**：某一层取样、生成或挂蒙版失败时只跳过该层并记入 `master_report_*.txt` 的 `FAIL` 行与弹窗提示，其余层继续输出。
- **区域取样速度**：区域来自该层**透明度→工作路径**取样。旧版用 DOM 逐点读取路径，实测为 O(n²)：1108 点约 74 秒、3731 点约 12 分钟，这是整次生成耗时的主要来源。现在优先用 ActionManager 一次读回整条路径（同样 3731 点约 0.4 秒，结果与 DOM 完全一致），并在第一次取样时与 DOM 结果比对做标定；比对不一致会自动回退 DOM。`zg_progress.txt` 末尾的「路径读取方式」会写明本次实际使用的方式，每层还会写一行「取样明细 ms」，其中 `转路径` 是 `makeWorkPath` 耗时、`复制/合并` 是临时文档渲染耗时——排查耗时看这一行。实测 2516×3756@900 下单层取样约 1.2–1.5 秒。
- **耗时分布（118 层 / 1748×3402@600 实测）**：取样约 7 分钟、布尔相减约 6 分钟（57 次，单次最长 32 秒，出现在 `background`/`卡面` 这类几乎整图、相减后碎成数千条子路径的层）、形状层约 1 分钟、结构校验约 1 分钟、**保存母版可能很久**（同规模下实测 0.4 分钟到 14 分钟不等，与内存/暂存盘压力有关；母版是 100MB 级、含数百个矢量蒙版）。核心在保存前会先关闭取样临时文档，并每 15 层把该文档回退到初始状态以清掉累积的历史。若保存仍然极慢，先看 Photoshop 暂存盘剩余空间与内存占用。
- **取样临时文档只建一次并全程复用**：早期版本每层 `documents.add` 一次临时文档再关闭，实测跑到第 9 层左右 Photoshop 会开始报「不能创建新文档…没有足够空间来停放它们」，一旦触发后续所有层都失败（004 那次 91 层全废）。现在开工前先建好一个 `ZG_region_sample`，每层只做「加一个空图层→删掉其余图层」的复位，并校验复位后确实为空；建不出来时回退用源文档的合并副本，仍不行则立刻报出可读原因。若仍遇到该提示，可在 Photoshop 首选项→界面里关闭「以选项卡方式打开文档」，或重启 Photoshop / 复位工作区。
- 取样容差 `path_tolerance_px` 越小节点越多、越慢（默认 1 px）。大面积复杂图层可适当放大容差以缩短耗时。
- 区域来自**透明度→工作路径**取样，非严格矢量边界；存在抗锯齿偏移与容差误差，未做半线宽内缩与尖碎片清理。生产版仍建议按 `references/photoshop-workflow.md` 复检净隙/线宽。
- 恒宽由局部法线偏移近似；chevron/feather 尖角、herringbone/meander 折角、网格交点处可能有轻微失真，请放大复检。
- **单元类纹样的格子尺寸由「线宽+中隙」推导**（`unitCellPx`），不再直接用 `wavelength_mm`：旧版把 12mm 当格子用，600ppi 下格距 283px，与其它纹样的基准间距（≈7px）差约 40 倍，回纹/人字/蜂巢/碳纤维/鳞片/点阵因此只有两三条线。现在 `wavelength_mm` 仍可放大单元，但会换算成基准间距的倍数并夹在合理区间（回纹 1–4、人字 2–5、蜂巢 1–4、鳞片/点阵 2–4；碳纤维取「纤维长+间距」）。同时修正了旧版会叠线/相切的几何：回纹行距改为 `单元+基准间距`（隔行错相）、蜂巢六边形按比例内缩、鳞片弧半径 0.45→0.36 单元、点阵半径按网格与净隙收敛。实测（600ppi、0.15mm 线、22.3mm 方块）：回纹 2→17 条、蜂巢 195 格、鳞片 475 格，各纹样最小净距 0.17–0.60mm，均不低于 0.12mm 下限。
- 多心/网格类纹样（ripple/checker/carbon/scale/hex/dot_field/dash_field 等）会生成大量小形状，大区域可能较慢；dash/checker 等会产生数千多边形，逐形状层分批写入。
- `contour`（同心等距）从区域外轮廓做斜接内缩生成同心环带；孔洞环被跳过、内圈塌陷即停。对简单/浅凹多边形可靠，深凹或细长区域环带可能变形。环带基线按周长自适应重采样（每条 ≤400 点），避免单条子路径超过 1000 点上限。
- 仅生成总母版 PSD；若要逐层透明 PNG/PSD，`export_groups.jsx` 的 `check()` 会因叶子层无各自矢量蒙版而报错，需先适配组级蒙版。
- 本宏未在本机完整端到端实测；首次运行按 `references/validation.md` 最小验证步骤试跑。

## 兼容性（2020 与较新版本）

- 目标是 Photoshop 2020（ExtendScript/JSX）能跑，同时尽量兼容当前较新版本。用到的都是长期稳定的 DOM/动作接口：`documents.add`、`pathItems.add`、`PathItem.makeSelection`、`channels.add`、`selection.store/load/makeWorkPath`、`layer.duplicate`、`mergeVisibleLayers`、`saveAs(PhotoshopSaveOptions)`、`executeAction(Mk)`（contentLayer / vectorMask）。
- 版本敏感处都加了退路，失败会写进 `zg_progress.txt` 而不是中断：矢量蒙版挂载依次尝试 3 种写法（枚举目标路径 / 按路径名引用 / `mask` 枚举）；`mergeVisibleLayers` 失败时退回使用复制来的图层本身；`selection.store(ch, EXTEND)` 失败时退回「载入 + 存储」；取样临时文档建不出来时退回源文档合并副本。
- 进度日志开头会写 `环境: Photoshop <版本> / 核心版本 <日期>`，排查时先看这一行确认跑的是哪份脚本。
- 保存的是标准 PSD（图层 + 矢量蒙版），2020 存、较新版本开，或反向，均正常。
