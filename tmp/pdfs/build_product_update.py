from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from pypdf import PdfReader, PdfWriter
import os

ROOT = "/Users/starwin/Documents/ChatGPT/codex-harness-remote"
ORIGINAL = os.path.join(ROOT, "output/pdf/Codex_Harness_Graph_产品说明书_2026-09-30.pdf")
PAGES = os.path.join(ROOT, "tmp/pdfs/product_update_appendix.pdf")
OUT = os.path.join(ROOT, "output/pdf/Codex_Harness_Graph_产品说明书_2026-10-02.pdf")
os.makedirs(os.path.dirname(PAGES), exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
pdfmetrics.registerFont(TTFont("CN", FONT))
pdfmetrics.registerFont(TTFont("CN-Bold", FONT))

W, H = A4
ML, MR = 17*mm, 17*mm
MT, MB = 15*mm, 22*mm
CW = W - ML - MR
INK = HexColor("#173b34")
MUTED = HexColor("#557069")
GREEN = HexColor("#11856d")
PALE = HexColor("#edf6f2")
PALE2 = HexColor("#f5f9f7")
LINE = HexColor("#cfe0d9")
BLUE = HexColor("#edf3fb")
AMBER = HexColor("#fff3d9")
WHITE = colors.white

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Kicker", fontName="CN-Bold", fontSize=8.5, leading=11, textColor=GREEN, spaceAfter=3))
styles.add(ParagraphStyle(name="TitleCN", fontName="CN-Bold", fontSize=23, leading=27, textColor=INK, spaceAfter=4))
styles.add(ParagraphStyle(name="Sub", fontName="CN", fontSize=10.2, leading=14, textColor=MUTED, spaceAfter=7))
styles.add(ParagraphStyle(name="H2", fontName="CN-Bold", fontSize=13.5, leading=17, textColor=INK, spaceBefore=2, spaceAfter=5))
styles.add(ParagraphStyle(name="Body", fontName="CN", fontSize=8.2, leading=11.5, textColor=INK, spaceAfter=2))
styles.add(ParagraphStyle(name="Small", fontName="CN", fontSize=7.25, leading=9.7, textColor=INK, spaceAfter=1))
styles.add(ParagraphStyle(name="Tiny", fontName="CN", fontSize=6.1, leading=7.6, textColor=MUTED, spaceAfter=1))
styles.add(ParagraphStyle(name="CardT", fontName="CN-Bold", fontSize=8.7, leading=11, textColor=GREEN, spaceAfter=2))
styles.add(ParagraphStyle(name="CardB", fontName="CN", fontSize=7.0, leading=9.4, textColor=INK))
styles.add(ParagraphStyle(name="TH", fontName="CN-Bold", fontSize=7.0, leading=8.5, textColor=WHITE, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="TC", fontName="CN", fontSize=6.9, leading=8.8, textColor=INK))
styles.add(ParagraphStyle(name="TCC", fontName="CN", fontSize=6.9, leading=8.8, textColor=INK, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="FlowN", fontName="CN-Bold", fontSize=9.5, leading=12, textColor=GREEN, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="FlowB", fontName="CN", fontSize=6.9, leading=9.1, textColor=INK, alignment=TA_CENTER))

def P(txt, style="Body"):
    return Paragraph(txt, styles[style])

def box(items, width=CW, bg=PALE, stroke=LINE, pad=7):
    t = Table([[items]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND",(0,0),(-1,-1),bg),("BOX",(0,0),(-1,-1),0.7,stroke),
        ("LEFTPADDING",(0,0),(-1,-1),pad),("RIGHTPADDING",(0,0),(-1,-1),pad),
        ("TOPPADDING",(0,0),(-1,-1),pad),("BOTTOMPADDING",(0,0),(-1,-1),pad),
        ("VALIGN",(0,0),(-1,-1),"TOP")
    ]))
    return t

def card(title, body, width):
    return Table([[[P(title,"CardT"), P(body,"CardB")]]], colWidths=[width], style=TableStyle([
        ("BACKGROUND",(0,0),(-1,-1),PALE2),("BOX",(0,0),(-1,-1),0.6,LINE),
        ("LEFTPADDING",(0,0),(-1,-1),6),("RIGHTPADDING",(0,0),(-1,-1),6),
        ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),
        ("VALIGN",(0,0),(-1,-1),"TOP")
    ]))

def footer(c, doc):
    c.saveState()
    c.setStrokeColor(LINE); c.setLineWidth(0.6)
    c.line(ML, 12*mm, W-MR, 12*mm)
    c.setFont("CN", 7); c.setFillColor(MUTED)
    c.drawString(ML, 8*mm, "Codex Harness Graph · Agent 协作平台产品说明书 · 2026-10-02")
    c.drawRightString(W-MR, 8*mm, str(doc.page + 6))
    c.restoreState()

story=[]

# Chapter 07
story += [P("07 · TECHNICAL ARCHITECTURE", "Kicker"),
          P("技术架构简介：入口、执行与交付分层", "TitleCN"),
          P("平台把“用户从哪里来”“智能体在哪里工作”“谁能看到什么”“成果如何交付”分开管理，再用一条受控的工作流程把它们连接起来。", "Sub")]
arch_w=(CW-4*mm)/5
arch = [
    card("用户入口层", "浏览器工作台、微信入口；可扩展飞书。入口只负责表达目标、查看状态和接收结果。", arch_w),
    card("工作编排层", "目标、计划、任务、依赖和审核规则。负责人可以先确认计划，再启动执行。", arch_w),
    card("智能体执行层", "Codex/OpenAI 负责普通项目；本地 Qwen 可服务独立隐私项目。不同角色按任务分工。", arch_w),
    card("项目与交付层", "每个任务拥有自己的资料与工作区；成果形成固定版本，审核通过后再交给下一环节。", arch_w),
    card("安全与运行底座", "用户隔离、项目授权、审批、事件记录、暂停恢复和失败处理贯穿整条链路。", arch_w),
]
arch_table=Table([arch],colWidths=[arch_w]*5)
arch_table.setStyle(TableStyle([
    ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),
    ("VALIGN",(0,0),(-1,-1),"TOP")
]))
story += [arch_table, Spacer(1,7), P("一条请求如何变成可交付成果", "H2")]
flow_w=(CW-4*mm)/5
flow_items=[
    [P("1", "FlowN"), P("2", "FlowN"), P("3", "FlowN"), P("4", "FlowN"), P("5", "FlowN")],
    [P("从 PC、微信或未来的飞书入口提出目标", "FlowB"),
     P("平台识别用户、项目和可用资料范围", "FlowB"),
     P("工作图按依赖把任务派给对应智能体或成员", "FlowB"),
     P("智能体在授权工作区执行，生成文件、回复或阶段成果", "FlowB"),
     P("负责人或规则审核，通过后形成交接并进入下一步", "FlowB")],
]
flow=Table(flow_items,colWidths=[flow_w]*5,rowHeights=[18,52])
flow.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),PALE),("GRID",(0,0),(-1,-1),0.5,LINE),
    ("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),5),
    ("RIGHTPADDING",(0,0),(-1,-1),5),("TOPPADDING",(0,0),(-1,-1),4),
    ("BOTTOMPADDING",(0,0),(-1,-1),4)
]))
story += [flow, Spacer(1,7)]
col=(CW-4*mm)/2
story += [Table([[
    box([P("客户可以这样理解", "CardT"),
         P("入口是“门”，工作图是“流程”，智能体是“执行者”，成果审核是“质量闸门”。任何入口都不能绕过项目权限和交付规则。", "Body")], col, bg=BLUE, stroke=HexColor("#b9cee8")),
    box([P("架构带来的价值", "CardT"),
         P("团队可以替换模型、增加入口或更换行业连接器，但任务关系、用户隔离、审核和成果交接保持一致。", "Body")], col, bg=PALE, stroke=GREEN)
]], colWidths=[col,col])]
story[-1].setStyle(TableStyle([
    ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),
    ("VALIGN",(0,0),(-1,-1),"TOP")
]))
story += [Spacer(1,7), P("当前边界：现有微信能力来自独立 relay，普通项目运行在 Mac 上的 Codex 工作台；隐私项目使用本机模型并保持独立。飞书连接器尚未完成，后续接入需要把飞书身份、事件、任务和审批与同一套工作图事实连接起来。", "Tiny")]

story.append(PageBreak())

# Chapter 08
story += [P("08 · COMPETITIVE ANALYSIS", "Kicker"),
          P("竞品分析：本项目应该站在哪里", "TitleCN"),
          P("比较条件：小团队 / OPC、Mac PC、微信与飞书、一个 OpenAI Pro 订阅、适度数据隐私，不把 Windows、复杂计费和大客户部署作为前提。", "Sub")]
headers=[P("产品","TH"),P("公开能力强项","TH"),P("相对本项目的启示","TH")]
comp=[
    ["OpenAI Dots","持续 Agent、云端电脑、浏览器、记忆和后台任务；可在 ChatGPT、Slack、Teams 等入口继续工作。","模型与持续 Agent 能力应借力；微信、飞书和国内团队流程需要额外连接。"],
    ["Meta Muse","面向个人/小企业目标，专用安全虚拟机和海外连接器，发送、发布、花费前需确认。","“给目标就能推进”值得学习；国内入口和团队交付规则不是它的重点。"],
    ["豆包工作 / 飞书 Aily","飞书身份、知识、技能、工作流、机器人和数据保护形成完整生态。","已使用飞书的客户落地最快；本项目应避开工作台正面竞争，强调跨入口和交付证据。"],
    ["QwenWork","桌面/网页控制中心，支持微信、企微、飞书/Lark、钉钉等 IM，支持连接器和 BYOK。","入口覆盖已很强；本项目差异必须落在多人交付、审核和独立工作空间。"],
    ["腾讯 WorkBuddy","本地电脑执行，微信/企微/QQ/钉钉/飞书远程任务，多 Agent，自定义 OpenAI 兼容模型和 Ollama。","是最直接替代品；本项目要卖“交付过程可审计”，而不是“也能完成任务”。"],
    ["本项目","Work Graph：目标拆解、依赖派发、独立空间、固定成果、三种审核、交接；已有微信 relay 和隐私项目。","飞书连接、微信任务化、统一身份是 P0；形成跨入口 Agent 交付控制层后才有清晰位置。"],
]
comp_data=[headers]+[[P(r[0],"TC"),P(r[1],"TC"),P(r[2],"TC")] for r in comp]
ct=Table(comp_data,colWidths=[82,198,183],repeatRows=1)
ct.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),INK),("GRID",(0,0),(-1,-1),0.45,LINE),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[WHITE,PALE2]),("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4)
]))
story += [ct, Spacer(1,6)]
story += [box([P("本项目的机会", "CardT"),
               P("把微信、飞书和 Mac Agent 统一到一条有负责人、依赖、交付物和验收标准的工作链中。通用 Agent 解决“帮我做一件事”，本项目要解决“让一组人和智能体把一件事交付完成”。", "Body")], bg=PALE, stroke=GREEN)]
story += [Spacer(1,6), P("能补上与难补上的部分", "H2")]
col2=(CW-4*mm)/2
story += [Table([[
    box([P("二次开发可补", "CardT"),
         P("• 飞书单聊/群聊、任务卡、审批卡、附件和状态回写<br/>• 微信任务派发、进度、审批和回执<br/>• 飞书用户、微信绑定、Portal 用户与项目权限映射<br/>• OpenAI/Codex、Qwen、本地模型按项目路由<br/>• 语音、媒体、定时任务和行业连接器", "Body")], col2, bg=PALE, stroke=GREEN),
    box([P("短期难以补齐", "CardT"),
         P("• 飞书、微信、钉钉等平台原生生态的广度<br/>• OpenAI 在中国大陆的稳定官方可达承诺<br/>• Windows 与跨终端执行能力<br/>• 平台级知识资产、企业客户覆盖和供应商治理体系<br/>• 面向敌对租户的完整 SaaS 隔离与商业化体系", "Body")], col2, bg=AMBER, stroke=HexColor("#e8c77a"))
]], colWidths=[col2,col2])]
story += [Spacer(1,6)]
story += [box([P("建议定位", "CardT"),
               P("面向已经在使用 ChatGPT/Codex、又需要用微信和飞书推进工作的 3-30 人小团队，提供轻量的 Agent 交付控制层：微信负责随时下达与接收，飞书负责团队协同，Mac 负责执行，Graph 负责拆解、审核和交接。", "Body")], bg=BLUE, stroke=HexColor("#b9cee8"))]
story += [Spacer(1,5)]
story += [P("<b>公开资料：</b> OpenAI Dots：https://learn.chatgpt.com/docs/dots　Meta Muse：https://about.fb.com/news/2026/09/introducing-muse-small-business/　WorkBuddy：https://cloud.tencent.com/document/product/1831/134392　QwenWork：https://qwenwork.cn/docs/desktop/im-channels　飞书 Aily：https://www.feishu.cn/content/3d5z9ttt　OpenAI 支持地区：https://developers.openai.com/api/docs/supported-countries。竞品结论为 2026-10-02 公开资料快照，不替代供应商合同或生产联调。", "Tiny")]

doc=SimpleDocTemplate(PAGES,pagesize=A4,leftMargin=ML,rightMargin=MR,topMargin=MT,bottomMargin=MB,title="产品说明书补充章节",author="Codex")
doc.build(story,onFirstPage=footer,onLaterPages=footer)

reader=PdfReader(ORIGINAL)
appendix=PdfReader(PAGES)
writer=PdfWriter()
for page in reader.pages: writer.add_page(page)
for page in appendix.pages: writer.add_page(page)
writer.add_metadata({
    "/Title":"Codex Harness Graph 产品说明书",
    "/Author":"Codex",
    "/Subject":"产品说明书补充：技术架构简介与竞品分析",
})
with open(OUT,"wb") as f: writer.write(f)
print(OUT)
