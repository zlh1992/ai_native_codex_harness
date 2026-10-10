from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image, KeepTogether
from pypdf import PdfReader, PdfWriter
import os

ROOT = "/Users/starwin/Documents/ChatGPT/codex-harness-remote"
ORIGINAL = os.path.join(ROOT, "output/pdf/Codex_Harness_Graph_产品说明书_2026-09-30.pdf")
PART = os.path.join(ROOT, "tmp/pdfs/product_revision_pages.pdf")
OUT = os.path.join(ROOT, "output/pdf/Codex_Harness_Graph_产品说明书_2026-10-02.pdf")
SCREEN = os.path.join(ROOT, "tmp/pdfs/remote_screens")
FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
pdfmetrics.registerFont(TTFont("CN", FONT)); pdfmetrics.registerFont(TTFont("CN-Bold", FONT))
W,H=A4; ML=MR=17*mm; MT=15*mm; MB=18*mm; CW=W-ML-MR
INK=HexColor("#173b34"); MUTED=HexColor("#557069"); GREEN=HexColor("#11856d"); PALE=HexColor("#edf6f2"); PALE2=HexColor("#f5f9f7"); LINE=HexColor("#cfe0d9"); BLUE=HexColor("#edf3fb"); AMBER=HexColor("#fff3d9"); WHITE=colors.white
ss=getSampleStyleSheet()
for n,size,lead,color in [("Kicker",8.5,11,GREEN),("TitleCN",24,28,INK),("Sub",10.4,14,MUTED),("H2",14,18,INK),("Body",8.3,11.5,INK),("Small",7.2,9.5,INK),("Tiny",6.1,7.5,MUTED),("CardT",9,11.5,GREEN),("CardB",7.1,9.5,INK),("Center",8,10,INK)]:
    ss.add(ParagraphStyle(name=n,fontName="CN-Bold" if n in ("Kicker","TitleCN","H2","CardT") else "CN",fontSize=size,leading=lead,textColor=color,spaceAfter=2,alignment=TA_CENTER if n=="Center" else 0))
def P(t,s="Body"): return Paragraph(t,ss[s])
def box(items,w=CW,bg=PALE,stroke=LINE,pad=7):
    t=Table([[items]],colWidths=[w]); t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),bg),("BOX",(0,0),(-1,-1),0.7,stroke),("LEFTPADDING",(0,0),(-1,-1),pad),("RIGHTPADDING",(0,0),(-1,-1),pad),("TOPPADDING",(0,0),(-1,-1),pad),("BOTTOMPADDING",(0,0),(-1,-1),pad),("VALIGN",(0,0),(-1,-1),"TOP")]))
    return t
def card(title,body,w): return box([P(title,"CardT"),P(body,"CardB")],w,PALE2,LINE,6)
def on_page(c,doc):
    c.saveState(); c.setStrokeColor(LINE); c.line(ML,11*mm,W-MR,11*mm); c.setFont("CN",7); c.setFillColor(MUTED); c.drawString(ML,7*mm,"Codex Harness Graph · Agent 协作平台产品说明书 · 2026-10-02"); c.restoreState()
def img(path,w):
    from PIL import Image as PIL
    im=PIL.open(path); ratio=im.height/im.width; return Image(path,width=w,height=w*ratio)
def flow_row(labels, bodies, widths):
    t=Table([[P(x,"CardT") for x in labels],[P(x,"Center") for x in bodies]],colWidths=widths,rowHeights=[18,45])
    t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),PALE),("GRID",(0,0),(-1,-1),0.5,LINE),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5)])); return t

story=[]
# 1. OPC hero
story += [P("AGENT COLLABORATION PLATFORM","Kicker"), P("Codex Harness Graph", "TitleCN"), P("面向 OPC 团队的 Agent 协作平台", "TitleCN"), P("老板与员工共享一套 AI Agent，通过 Codex 驱动协同，把项目从目标、任务、执行推进到可验收交付。", "Sub")]
story += [box([P("一个项目 · 一套共享 Agent · 一条可交付工作链", "H2"), P("老板负责目标、优先级与验收；员工和 Agent 在各自授权空间推进工作；Codex 把任务、资料、依赖、结果和审核意见串在同一条项目线上。", "Body")],bg=PALE,stroke=GREEN)]
story += [Spacer(1,8),P("产品价值","H2")]
cw=(CW-8*mm)/3
vals=[("让老板看见进度", "目标拆解、任务派发、风险和待验收成果集中呈现。"),("让员工与 Agent 一起推进", "员工在独立工作区使用 Codex，Agent 负责研究、写作、开发和检查。"),("让交付可以复盘", "每一步保留成果、审核意见和交接记录，项目不会只停留在聊天记录里。")]
story += [Table([[card(a,b,cw) for a,b in vals]],colWidths=[cw]*3,style=TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),("VALIGN",(0,0),(-1,-1),"TOP")])),Spacer(1,8)]
story += [box([P("适合谁", "CardT"),P("正在使用 ChatGPT/Codex、希望用微信和飞书推进业务、由老板直接带领 3-30 人团队的 OPC、小型工作室和专业服务团队。", "Body")],bg=BLUE,stroke=HexColor("#b9cee8"))]
story.append(PageBreak())

# Demo pages, each scenario has a real screenshot
demo=[
 ("微信打通", "老板在微信发出任务，Mac 上的微信 relay 将消息送入固定项目入口；结果和待办再回到微信。", "wx_native_harness_github.png", "公开项目页：github.com/zlh1992/wx_native_harness"),
 ("隐私模式", "涉及客户名单、内部资料或本地知识时，切换到独立隐私项目；资料留在本机工作区，结果不进入共享项目。", "employee_login.png", "远端员工入口：workbench4.winy.cc/employee"),
 ("Codex 联合研发", "员工与 Agent 在独立 Codex 工作台推进研究、代码和文档，老板只接收阶段成果与审核请求。", "employee_login.png", "远端员工入口：workbench4.winy.cc/employee"),
 ("老板分享项目给员工", "老板创建项目、设定范围与交付标准，再把项目授权给指定员工；共享的是工作图和交付边界，不是整台电脑。", "boss_login.png", "远端老板入口：workbench3.winy.cc/boss/login"),
 ("流程派发", "一个目标被拆成研究、制作、检查、发布等任务，按依赖关系派发给人或 Agent；每个环节都有状态和回执。", "boss_login.png", "远端老板入口：workbench3.winy.cc/boss/login"),
 ("用户隔离", "老板、员工、标准项目和隐私项目分别绑定身份与权限；员工只看到自己被授权的项目和资料。", "employee_login.png", "远端员工入口：workbench4.winy.cc/employee"),
]
for page in range(3):
    story += [P("附录 B · DEMO 场景", "Kicker"), P("常见使用场景：从入口到交付", "TitleCN"), P("以下截图来自实际打开的远端工作台或公开连接器项目页，用于说明各角色入口和协作边界。", "Sub")]
    for title,desc,fn,cap in demo[page*2:page*2+2]:
        story += [box([P(title,"CardT"),P(desc,"Body"),img(os.path.join(SCREEN,fn),CW-42*mm),P("截图说明："+cap,"Tiny")],bg=PALE2,stroke=LINE,pad=6),Spacer(1,5)]
    if page<2: story.append(PageBreak())

# Architecture pages
story += [PageBreak(),P("技术架构简介 · 01", "Kicker"),P("域名部署：入口与本机执行分开", "TitleCN"),P("远端域名承担身份入口与团队看板，真正的 Codex 执行仍发生在管理员指定的 Mac 工作区；这样既能让团队随时访问，也能把代码和本地资料留在可控设备。", "Sub")]
widths=[(CW-16*mm)/5]*5
story += [flow_row(["微信 / 飞书入口","域名工作台","Portal 与权限","本机 Codex","结果与审计"],["消息、任务、审批和回执进入统一入口","老板域名、员工域名按角色分流","确认身份、项目范围和可见资料","Mac 上执行命令、读写工作区、调用模型","交付文件、审核意见、事件记录可追溯"],widths),Spacer(1,8)]
story += [box([P("域名部署的关键边界","CardT"),P("域名只暴露必要的工作台和状态；Portal 通过固定角色入口连接本机服务，项目权限在服务端再次校验。微信 relay 与未来飞书连接器都只能调用受控接口，不能绕过工作图、审批和用户隔离。", "Body")],bg=BLUE,stroke=HexColor("#b9cee8"))]
story += [Spacer(1,7),P("Codex → 微信 / OpenClaw", "H2")]
story += [flow_row(["老板消息","微信 relay","Portal 固定入口","Codex / Agent","微信回执"],["提出目标或追问进度","扫码绑定、私聊转发、身份签名","映射到老板项目并检查 ACL","拆解、执行、生成成果或审核请求","回复状态、链接、文件和下一步"],widths)]
story.append(PageBreak())

story += [P("技术架构简介 · 02", "Kicker"),P("老板与员工隔离：共享项目，分开执行", "TitleCN"),P("平台把“共同推进一件事”和“每个人只能看到被授权内容”同时落地。老板可以分享项目，员工拥有独立账号、工作区和执行上下文。", "Sub")]
story += [flow_row(["老板 Agent","项目授权","员工账号","独立工作区","固定成果"],["维护目标、优先级和验收标准","只授予指定项目、任务和资料范围","员工登录自己的入口，身份可审计","员工与 Agent 在授权目录中推进","通过审核的文件和意见回到项目主线"],widths),Spacer(1,8)]
story += [Table([[box([P("老板看到","CardT"),P("全局目标、任务依赖、风险、审核请求、员工交付和项目历史。", "Body")],(CW-4*mm)/2,bg=PALE,stroke=GREEN),box([P("员工看到","CardT"),P("自己被授权的项目、任务、资料和 Codex 工作台；看不到其他员工的私有项目。", "Body")],(CW-4*mm)/2,bg=PALE2,stroke=LINE)]],colWidths=[(CW-4*mm)/2]*2,style=TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4)])),Spacer(1,8)]
story += [box([P("隐私项目单独走本地模型","CardT"),P("local_private 项目不分享给其他用户，优先使用本机 Qwen 和本地资料；即使老板拥有全局视图，也只能看到明确允许交付的结果。", "Body")],bg=AMBER,stroke=HexColor("#e8c77a"))]
story.append(PageBreak())

story += [P("技术架构简介 · 03", "Kicker"),P("员工推进交付：与老板 Agent 形成闭环", "TitleCN"),P("员工不是被动接单，而是在自己的 Codex 工作台里推进任务；老板 Agent 负责目标澄清、依赖协调和质量门，员工 Agent 负责具体产出。", "Sub")]
story += [flow_row(["老板 Agent","任务派发","员工 + Agent","交付提交","老板审核"],["给出目标、背景和标准","按依赖派发研究、制作、检查任务","在独立工作区执行并记录过程","提交文件、链接、测试和说明","通过、退回或提出下一轮修改"],widths),Spacer(1,8)]
story += [P("典型交互", "H2")]
inter=[("1. 澄清", "老板 Agent 把一句话目标变成范围、负责人、截止时间和验收标准。"),("2. 推进", "员工在 Codex 中调用自己的 Agent，完成研究、写作、编码或运营动作。"),("3. 回传", "提交固定成果和摘要，系统记录版本、依赖、检查结果与风险。"),("4. 决策", "老板 Agent 结合项目状态提出通过、退回、转派或升级建议，老板作最终确认。")]
story += [Table([[card(a,b,(CW-4*mm)/2) for a,b in inter[:2]],[card(a,b,(CW-4*mm)/2) for a,b in inter[2:]]],colWidths=[(CW-4*mm)/2]*2,style=TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),("TOPPADDING",(0,0),(-1,-1),4)]))]
story += [Spacer(1,7),box([P("飞书接入判断","CardT"),P("接入飞书 CLI 或开放平台可以解决消息、群、任务卡、附件和事件回调的入口问题，但仍需补齐身份映射、幂等、状态回写、审批、审计和失败恢复。最短路径是复用现有 Work Graph 和 Portal，只新增飞书适配层。", "Body")],bg=BLUE,stroke=HexColor("#b9cee8"))]
story.append(PageBreak())

# competitor final page, positive framing
story += [P("竞品分析 · OPC 视角", "Kicker"),P("本项目的机会：做跨入口的 Agent 交付控制层", "TitleCN"),P("OpenAI Dots、Meta Muse、豆包工作 / 飞书 Aily、QwenWork、腾讯 WorkBuddy 各自在模型、入口或本地执行上有优势；本项目的潜力来自“老板与员工共享 Agent、由 Codex 推进交付”的组合。", "Sub")]
story += [box([P("相对竞品的独特位置","CardT"),P("微信负责随时下达与接收，飞书负责团队协同，Mac 负责执行，Graph 负责拆解、审核和交接。项目不追求再做一个聊天机器人，而是让一组人和智能体把事情交付完成。", "Body")],bg=PALE,stroke=GREEN),Spacer(1,7)]
story += [P("优势、可补空间与边界", "H2")]
story += [Table([[box([P("当前优势","CardT"),P("• 已有 Work Graph、任务依赖、独立空间、固定成果和三种审核<br/>• 已有 Mac 本地执行和隐私项目边界<br/>• `wx_native_harness` / `wx_codex_self` 已具备微信 relay、扫码绑定和本地知识图谱基础<br/>• 一个 OpenAI Pro 订阅即可作为小团队的主要模型入口", "Body")],(CW-4*mm)/2,bg=PALE,stroke=GREEN),box([P("二次开发可补","CardT"),P("• 飞书单聊/群聊、任务卡、审批卡、附件与状态回写<br/>• 微信任务化、进度回执和媒体消息<br/>• 微信、飞书、Portal 用户与项目权限映射<br/>• OpenAI/Codex、Qwen、本地模型按项目路由<br/>• 语音、定时任务和行业连接器", "Body")],(CW-4*mm)/2,bg=PALE2,stroke=LINE)]],colWidths=[(CW-4*mm)/2]*2,style=TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4)])),Spacer(1,7)]
story += [box([P("面向 OPC 团队的建议路线", "CardT"),P("先把微信 relay、飞书适配层、统一身份和任务回执做成稳定入口；再把项目分享、交付审核和老板 Agent 协调做成默认流程。这样项目可以利用最好的 OpenAI/Codex 能力，同时保留国内生态入口和本机隐私边界。", "Body")],bg=BLUE,stroke=HexColor("#b9cee8")),Spacer(1,7)]
story += [P("公开资料快照（2026-10-02）：OpenAI Dots、Meta Muse、豆包工作 / 飞书 Aily、QwenWork、腾讯 WorkBuddy 的能力与地区可用性会变化；本页用于产品定位，不替代供应商合同或生产联调。", "Tiny")]

os.makedirs(os.path.dirname(PART),exist_ok=True)
doc=SimpleDocTemplate(PART,pagesize=A4,leftMargin=ML,rightMargin=MR,topMargin=MT,bottomMargin=MB,title="Codex Harness Graph 产品说明书",author="Codex")
doc.build(story,onFirstPage=on_page,onLaterPages=on_page)

orig=PdfReader(ORIGINAL); add=PdfReader(PART); writer=PdfWriter()
writer.add_page(add.pages[0])
for i in range(1,5): writer.add_page(orig.pages[i])
for i in range(1,len(add.pages)): writer.add_page(add.pages[i])
writer.add_metadata({"/Title":"Codex Harness Graph 产品说明书","/Author":"Codex","/Subject":"OPC Agent 协作平台产品说明书"})
with open(OUT,"wb") as f: writer.write(f)
print(OUT, len(writer.pages))
