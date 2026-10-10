from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    KeepTogether, HRFlowable
)
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import simpleSplit
from reportlab.lib.colors import Color
import os

OUT = "/Users/starwin/Documents/ChatGPT/codex-harness-remote/output/pdf/Codex_Harness_Graph_竞品分析_2026-10-02.pdf"
os.makedirs(os.path.dirname(OUT), exist_ok=True)
FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
pdfmetrics.registerFont(TTFont("CN", FONT))
pdfmetrics.registerFont(TTFont("CN-Bold", BOLD))

PAGE_W, PAGE_H = A4
MARGIN_L = 17*mm
MARGIN_R = 17*mm
MARGIN_T = 15*mm
MARGIN_B = 15*mm
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

INK = HexColor("#173b34")
MUTED = HexColor("#557069")
GREEN = HexColor("#11856d")
PALE = HexColor("#edf6f2")
PALE2 = HexColor("#f5f9f7")
LINE = HexColor("#cfe0d9")
AMBER = HexColor("#fff3d9")
REDPALE = HexColor("#fdebea")
BLUEPALE = HexColor("#edf3fb")
PURPLEPALE = HexColor("#f3effb")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="TitleCN", fontName="CN-Bold", fontSize=25, leading=29,
    textColor=INK, spaceAfter=4
))
styles.add(ParagraphStyle(
    name="SubTitleCN", fontName="CN", fontSize=10.8, leading=15,
    textColor=MUTED, spaceAfter=8
))
styles.add(ParagraphStyle(
    name="Kicker", fontName="CN-Bold", fontSize=8.5, leading=11,
    textColor=GREEN, uppercase=True, spaceAfter=3
))
styles.add(ParagraphStyle(
    name="H2CN", fontName="CN-Bold", fontSize=14, leading=18,
    textColor=INK, spaceBefore=2, spaceAfter=6
))
styles.add(ParagraphStyle(
    name="H3CN", fontName="CN-Bold", fontSize=9.5, leading=12,
    textColor=GREEN, spaceAfter=3
))
styles.add(ParagraphStyle(
    name="BodyCN", fontName="CN", fontSize=8.5, leading=12.2,
    textColor=INK, spaceAfter=2
))
styles.add(ParagraphStyle(
    name="BodySmall", fontName="CN", fontSize=7.5, leading=10.2,
    textColor=INK, spaceAfter=1
))
styles.add(ParagraphStyle(
    name="TinyCN", fontName="CN", fontSize=6.3, leading=8,
    textColor=MUTED, spaceAfter=1
))
styles.add(ParagraphStyle(
    name="CardTitle", fontName="CN-Bold", fontSize=9.2, leading=12,
    textColor=GREEN, spaceAfter=3
))
styles.add(ParagraphStyle(
    name="CardBody", fontName="CN", fontSize=7.55, leading=10.7,
    textColor=INK, spaceAfter=1
))
styles.add(ParagraphStyle(
    name="TableHead", fontName="CN-Bold", fontSize=7.2, leading=9,
    textColor=colors.white, alignment=TA_CENTER
))
styles.add(ParagraphStyle(
    name="TableCell", fontName="CN", fontSize=7.0, leading=9.1,
    textColor=INK, alignment=TA_LEFT
))
styles.add(ParagraphStyle(
    name="TableCellCenter", fontName="CN", fontSize=7.0, leading=9.1,
    textColor=INK, alignment=TA_CENTER
))
styles.add(ParagraphStyle(
    name="BoxLead", fontName="CN-Bold", fontSize=10, leading=14,
    textColor=INK, spaceAfter=3
))
styles.add(ParagraphStyle(
    name="BoxBody", fontName="CN", fontSize=8.0, leading=11.2,
    textColor=INK
))

def P(text, style="BodyCN"):
    return Paragraph(text, styles[style])

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN_L, 12*mm, PAGE_W-MARGIN_R, 12*mm)
    canvas.setFont("CN", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_L, 8*mm, "Codex Harness Graph · 小团队 AI-native 办公竞品分析 · 2026-10-02")
    canvas.drawRightString(PAGE_W-MARGIN_R, 8*mm, f"{doc.page}")
    canvas.restoreState()

def box(content, width=CONTENT_W, bg=PALE, stroke=LINE, pad=8, valign="TOP"):
    t = Table([[content]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), bg),
        ("BOX", (0,0), (-1,-1), 0.7, stroke),
        ("LEFTPADDING", (0,0), (-1,-1), pad),
        ("RIGHTPADDING", (0,0), (-1,-1), pad),
        ("TOPPADDING", (0,0), (-1,-1), pad),
        ("BOTTOMPADDING", (0,0), (-1,-1), pad),
        ("VALIGN", (0,0), (-1,-1), valign),
    ]))
    return t

def card(title, body, width):
    inner = [P(title, "CardTitle"), P(body, "CardBody")]
    return Table([[inner]], colWidths=[width], style=TableStyle([
        ("BACKGROUND",(0,0),(-1,-1),PALE2),
        ("BOX",(0,0),(-1,-1),0.6,LINE),
        ("LEFTPADDING",(0,0),(-1,-1),7),
        ("RIGHTPADDING",(0,0),(-1,-1),7),
        ("TOPPADDING",(0,0),(-1,-1),7),
        ("BOTTOMPADDING",(0,0),(-1,-1),6),
        ("VALIGN",(0,0),(-1,-1),"TOP"),
    ]))

def tag(text, bg=PALE):
    t = Table([[P(text, "BodySmall")]], colWidths=[None], style=TableStyle([
        ("BACKGROUND",(0,0),(-1,-1),bg),
        ("BOX",(0,0),(-1,-1),0.6,LINE),
        ("LEFTPADDING",(0,0),(-1,-1),7),
        ("RIGHTPADDING",(0,0),(-1,-1),7),
        ("TOPPADDING",(0,0),(-1,-1),4),
        ("BOTTOMPADDING",(0,0),(-1,-1),4),
    ]))
    return t

def source_line(text):
    return P(text, "TinyCN")

story = []

# PAGE 1
story += [
    P("COMPETITIVE LANDSCAPE", "Kicker"),
    P("小团队 AI-native 办公竞品分析", "TitleCN"),
    P("面向 OPC / 小型专业团队：Mac PC + 微信 + 飞书，最好模型可达，数据留在可控边界内。", "SubTitleCN"),
]
lead = [
    P("<b>先说判断：</b>如果只买“能在微信、飞书里调用 Agent”，WorkBuddy、QwenWork 和飞书 Aily 已经是强替代；如果只追求最强 OpenAI 模型，Dots / Codex 更强但在中国大陆的账号、网络和官方支持范围存在不确定性。", "BoxBody"),
    Spacer(1, 4),
    P("本项目仍有潜力，但不应定位成又一个通用办公聊天机器人，而应定位为：<b>把不同入口的 Agent 工作组织成可派发、可验收、可追溯的交付流程。</b>", "BoxLead"),
]
story.append(box(lead, bg=PALE, stroke=GREEN, pad=9))
story.append(Spacer(1, 8))
story.append(P("目标团队真正要买什么", "H2CN"))
chips = [
    [tag("一台 Mac 做执行中心"), tag("微信随时下达 / 收结果"), tag("飞书承接团队协作"), tag("OpenAI Pro 可用")],
    [tag("小团队不追求复杂计费"), tag("个人/用户隔离"), tag("敏感项目可留本机"), tag("结果能复核、能交接")],
]
chip_table = Table(chips, colWidths=[CONTENT_W/4]*4, hAlign="LEFT")
chip_table.setStyle(TableStyle([
    ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),5),
]))
story.append(chip_table)
story.append(Spacer(1, 3))
story.append(P("针对以上条件的相对匹配度（5 = 强，* = 依赖地区、套餐、账号或二次配置）", "TinyCN"))
headers = ["产品", "PC / Agent", "微信", "飞书", "OpenAI", "隐私", "团队交付"]
rows = [
    ["本项目", "4\nMac 执行+Codex", "3*\n已有 relay", "1\n暂无", "4*\nPro/账号", "4\n本地私密模式", "5\n工作图/验收"],
    ["OpenAI Dots", "5\n云端+本地", "1", "1", "5\n原生", "3\n云端治理", "4\n持续任务"],
    ["Meta Muse", "4\nSecure VM", "1", "1", "1", "4\n专用 VM", "3\n个人目标"],
    ["豆包工作 / Aily", "4\n工作台", "2*", "5\n飞书原生", "2", "4\n租户/DLP", "4\n技能/流程"],
    ["QwenWork", "5\n桌面+浏览器", "5", "5", "3*\nBYOK", "3", "4\n任务/连接器"],
    ["腾讯 WorkBuddy", "5\n本地电脑", "5", "4", "4*\n自定义", "4\n本地模型", "4\n多 Agent"],
]
data = [[P(h, "TableHead") for h in headers]]
for row in rows:
    data.append([P(c.replace("\n","<br/>"), "TableCellCenter" if i in [1,2,3,4,5] else "TableCell") for i,c in enumerate(row)])
tbl = Table(data, colWidths=[64,74,51,51,62,58,76], repeatRows=1)
tbl.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),INK),
    ("GRID",(0,0),(-1,-1),0.45,LINE),
    ("BACKGROUND",(0,1),(-1,-1),colors.white),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, PALE2]),
    ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("LEFTPADDING",(0,0),(-1,-1),4),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
]))
story.append(tbl)
story.append(Spacer(1, 5))
story.append(P("表内“微信/飞书”指官方公开的入口或连接能力；本项目的微信能力来自已有 wx_native_harness / wx_codex_self relay，当前仍以老板固定项目和文字交互为主。OpenAI 模型“可达”不等于在所有地区、网络或账号条件下稳定可用。", "TinyCN"))
story.append(PageBreak())

# PAGE 2
story += [
    P("PRODUCT READOUT", "Kicker"),
    P("谁解决了什么，本项目差在哪", "TitleCN"),
    P("竞品普遍擅长“一个人给 Agent 下指令并拿结果”；本项目要补的是“几个人、几步任务、几次审核，最后交付什么”。", "SubTitleCN"),
]
w = (CONTENT_W - 7*mm) / 2
cards = [
    ("OpenAI Dots", "最强项是持续推进：云端电脑、浏览器、记忆、后台任务，可在 ChatGPT、Slack、Teams 等入口继续对话。短板是国内微信/飞书不在原生入口内，而且官方可用地区和企业治理需要单独确认。<br/><b>启示：</b>模型与持续 Agent 能力应借力，不要复制。"),
    ("Meta Muse", "面向个人和小企业的目标型 Agent，依靠 Secure VM 和连接器完成营销、资料、店铺等工作，并在发送、发布、花费前要求确认。官方资料重点覆盖 Meta/WhatsApp 及海外工具。<br/><b>启示：</b>“少配置、直接完成事情”值得学习，国内协同入口仍要自建。"),
    ("豆包工作 / 飞书 Aily", "飞书生态最完整：知识、技能、工作流、Webhook/定时触发、飞书机器人和权限治理都能承接；Aily 还提供敏感数据进入模型的拦截策略。<br/><b>启示：</b>若客户已经全面使用飞书，它是最短落地路径；本项目不要正面复制飞书工作台。"),
    ("QwenWork", "桌面和网页为控制中心，公开文档已支持微信、企业微信、飞书/Lark、钉钉等 IM，消息从哪里来就回哪里；企业版可管理模型策略，BYOK 可扩展。<br/><b>启示：</b>它已覆盖本项目的入口组合，差异必须落在交付证据和独立工作空间。"),
    ("腾讯 WorkBuddy", "对目标场景最接近：本地电脑执行，手机可用微信、企微、QQ、钉钉、飞书远程下达；支持多 Agent、技能市场、自定义 OpenAI 兼容模型和 Ollama。<br/><b>启示：</b>它是最直接的替代品；本项目必须用“可审计的跨人交付”而不是“能干活”取胜。"),
    ("当前项目 + 微信二次开发", "已有 Graph：目标拆解、负责人、依赖、独立项目空间、固定提交、三种审核、成果交接；已有 local_private 本地 Qwen 路由。wx_native_harness 已把微信私聊 relay 到老板 Portal，并保留 ACL。<br/><b>真实缺口：</b>飞书为 0；微信还偏入口/遥控器，未成为完整派发、审批和回执渠道；整体仍是 Mac 内部互信形态。"),
]
card_rows = []
for i in range(0, len(cards), 2):
    row = []
    for j in [i, i+1]:
        title, body = cards[j]
        row.append(card(title, body, w))
    card_rows.append(row)
card_table = Table(card_rows, colWidths=[w, w], rowHeights=[None, None, None], hAlign="LEFT")
card_table.setStyle(TableStyle([
    ("LEFTPADDING",(0,0),(-1,-1),0),
    ("RIGHTPADDING",(0,0),(-1,-1),7),
    ("TOPPADDING",(0,0),(-1,-1),0),
    ("BOTTOMPADDING",(0,0),(-1,-1),7),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
]))
story.append(card_table)
story.append(Spacer(1, 3))
baseline = [
    P("<b>当前可直接展示</b>：Mac 上的 Codex 协作、微信入口、工作图看板、任务依赖、固定成果和老板验收。", "BodySmall"),
    P("<b>当前不要承诺</b>：Windows 微信、飞书原生连接、敌对多租户、任意渠道审批、OpenAI 在中国大陆的稳定可达。", "BodySmall"),
]
story.append(box(baseline, bg=AMBER, stroke=HexColor("#e8c77a"), pad=8))
story.append(Spacer(1, 5))
story.append(P("当前判断不是“没有飞书就没有产品”，而是：没有飞书会直接削弱国内团队的日常采用率；一旦补上，项目才有资格把 Graph 的交付控制能力拿到同一张比较表上。", "BodyCN"))
story.append(PageBreak())

# PAGE 3
story += [
    P("STRATEGY", "Kicker"),
    P("SWOT、飞书接入判断与补齐优先级", "TitleCN"),
    P("在不考虑 Windows 微信、不把部署和商业化当成前提、默认一个 OpenAI Pro 订阅够用的情况下，路线可以更聚焦。", "SubTitleCN"),
]
sw = (CONTENT_W - 7*mm) / 2
swot = [
    [card("S · 优势", "• 工作图把多个 Agent 组织成有负责人、依赖、交付、验收的可检查流程<br/>• 固定版本和 handoff 让“交付了什么”可追溯<br/>• local_private + 本地 Qwen 提供有边界的隐私模式<br/>• Codex/OpenAI 能力与 Mac 本地文件执行结合", sw),
     card("W · 劣势", "• 当前没有飞书连接器，国内团队入口不完整<br/>• 微信已有 relay 但仍偏老板入口/遥控，消息、任务、审批、附件和回执没有统一产品语义<br/>• Mac-only，不能承诺通用终端<br/>• 共享上游登录与内部互信仍是试用边界，OpenAI 可达性有条件", sw)],
    [card("O · 机会", "• 用飞书开放平台把任务卡、审批卡、附件、事件回写接进团队日常<br/>• 用微信作为老板/移动入口，飞书作为团队协作面，Mac 作为执行面<br/>• 面向研发、内容、投放、交付等需要多人接力的 OPC 场景<br/>• 做成“模型可替换、交付规则不替换”的控制层", sw),
     card("T · 威胁", "• WorkBuddy / QwenWork 已覆盖 PC + 微信 + 飞书，采用成本低<br/>• Aily / 豆包工作掌握飞书身份、数据和工作流入口<br/>• Dots / Muse 持续增强通用 Agent，模型能力差距可能被平台快速抹平<br/>• 微信/飞书平台政策、开放接口和 OpenAI 地区可用性会变化", sw)]
]
swot_table = Table(swot, colWidths=[sw, sw], hAlign="LEFT")
swot_table.setStyle(TableStyle([
    ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),7),
    ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),7),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
]))
story.append(swot_table)
story.append(Spacer(1, 2))
story.append(box([
    P("<b>飞书 CLI 不是全部答案。</b> CLI 或开放平台 SDK 能加速“建应用、发消息、读写数据、订阅事件”，但产品级连接还需要四层：<b>身份</b>（飞书用户/部门 ↔ 项目用户）、<b>事件</b>（消息/卡片/回调/重试）、<b>任务</b>（派发/状态/审批/附件/幂等）、<b>治理</b>（权限、审计、密钥、失败恢复）。所以路线应是“飞书连接器 + Graph 适配层”，而不是把 CLI 当成现成功能。", "BoxBody")
], bg=BLUEPALE, stroke=HexColor("#b9cee8"), pad=8))
story.append(Spacer(1, 6))
story.append(P("本项目最值得补的能力", "H2CN"))
priority_data = [
    [P("优先级","TableHead"), P("补什么","TableHead"), P("补完后的价值","TableHead"), P("判断","TableHead")],
    [P("P0","TableCellCenter"), P("飞书最小连接器：单聊/群聊 @、任务卡、状态卡、审批按钮、附件回传、事件幂等","TableCell"), P("飞书成为团队工作入口，Graph 仍是唯一任务事实源","TableCell"), P("可补，工作量中等","TableCellCenter")],
    [P("P0","TableCellCenter"), P("微信 relay 产品化：任务派发、进度、审批短码/按钮、结果回执；保留 wx_native_harness 的绑定和 Portal ACL","TableCell"), P("微信从“遥控器”变为老板移动驾驶舱","TableCell"), P("可补，受微信通道形态约束","TableCellCenter")],
    [P("P1","TableCellCenter"), P("统一身份与用户隔离：飞书 open_id、微信绑定、Portal 用户和项目 access 映射","TableCell"), P("不同入口进入同一人的同一工作边界，不串项目、不串记忆","TableCell"), P("必须做，决定能否卖给团队","TableCellCenter")],
    [P("P1","TableCellCenter"), P("模型路由层：OpenAI/Codex、Qwen、本地模型按项目/任务选择；Pro 订阅优先，不做复杂计费","TableCell"), P("保留最好模型，同时让隐私项目有本地退路","TableCell"), P("可补，但需明确账号与网络边界","TableCellCenter")],
    [P("P2","TableCellCenter"), P("媒体、语音、定时任务、外部系统连接器与交付模板","TableCell"), P("提高日常采用率，形成行业场景包","TableCell"), P("有潜力，放在 P0 闭环之后","TableCellCenter")],
]
pt = Table(priority_data, colWidths=[38,174,165,74], repeatRows=1)
pt.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),INK),
    ("GRID",(0,0),(-1,-1),0.45,LINE),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, PALE2]),
    ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("LEFTPADDING",(0,0),(-1,-1),4),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
]))
story.append(pt)
story.append(Spacer(1, 6))
story.append(box([
    P("<b>建议定位：</b>面向已经使用 ChatGPT/Codex、同时需要在微信和飞书推进工作的 3-30 人小团队，提供一个轻量的 Agent 交付控制层：微信负责随时下达与接收，飞书负责团队协同，Mac 负责执行，Graph 负责拆解、验收和交接。", "BoxLead"),
    P("这条路线有潜力；但潜力集中在“交付秩序和数据边界”，不在“再做一个更会聊天的 Agent”。", "BoxBody"),
], bg=PALE, stroke=GREEN, pad=8))
story.append(Spacer(1, 4))
story.append(P("<b>公开资料快照：</b> OpenAI Dots · https://learn.chatgpt.com/docs/dots　 Meta Muse · https://about.fb.com/news/2026/09/introducing-muse-small-business/　 WorkBuddy · https://cloud.tencent.com/product/workbuddy　 WorkBuddy 远程任务 · https://cloud.tencent.com/document/product/1831/134392　 QwenWork IM · https://qwenwork.cn/docs/desktop/im-channels　 飞书 Aily · https://www.feishu.cn/content/3d5z9ttt　 豆包工作安全 · https://www.feishu.cn/content/article/7680042598047763739　 OpenAI 支持地区 · https://developers.openai.com/api/docs/supported-countries。结论为公开资料与当前工作区实现的对照，不替代供应商合同或生产联调。", "TinyCN"))

doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=MARGIN_L, rightMargin=MARGIN_R,
    topMargin=MARGIN_T, bottomMargin=MARGIN_B + 7*mm,
    title="小团队 AI-native 办公竞品分析",
    author="Codex"
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)

