# 生成最小可用的测试 PPTX / DOCX（纯 stdlib）
import zipfile, os

out = os.path.join(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(out, exist_ok=True)

CT_PPTX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''

PRES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst>
</p:presentation>'''

PRES_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>'''

def slide(title, bullets):
    body = ''.join(
        '<a:p><a:r><a:t>%s</a:t></a:r></a:p>' % b for b in bullets)
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>%s</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>''' % (title, body)

pptx_path = os.path.join(out, '测试课件-睡眠拖延研究.pptx')
with zipfile.ZipFile(pptx_path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT_PPTX)
    z.writestr('_rels/.rels', RELS)
    z.writestr('ppt/presentation.xml', PRES)
    z.writestr('ppt/_rels/presentation.xml.rels', PRES_RELS)
    z.writestr('ppt/slides/slide1.xml', slide('睡前拖延（Bedtime Procrastination）导论', [
        '定义：在没有外部阻碍的情况下，个体仍推迟就寝时间的行为',
        'Kroese et al. (2014) 首次提出该构念',
        '与自我调节失败（self-regulation failure）密切相关']))
    z.writestr('ppt/slides/slide2.xml', slide('三种拖延模式', [
        'deliberate：有意识地熬夜，为了获得自由时间',
        'mindless：无意识刷屏，时间知觉失真',
        'strategic：策略性推迟，为次日任务储备精力',
        '研究问题：本科生如何在这三种模式之间切换？']))
    z.writestr('ppt/slides/slide3.xml', slide('研究方法', [
        '8-12 次深度访谈',
        '屏幕使用时间截图激发法（photo elicitation）',
        '主题分析（thematic analysis）编码']))

CT_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

RELS_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

def wp(text, style=None):
    ppr = '<w:pPr><w:pStyle w:val="%s"/></w:pPr>' % style if style else ''
    return '<w:p>%s<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % (ppr, text)

STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>'''

doc_body = ''.join([
    wp('访谈大纲：睡前拖延的模式与切换', 'Heading1'),
    wp('本大纲用于 ENG2001 研究项目的半结构化访谈，目标时长 45-60 分钟。'),
    wp('第一部分：日常作息画像', 'Heading1'),
    wp('请描述你典型的一天：几点起床、上课、自习、娱乐分别占用什么时间？'),
    wp('你通常几点上床？上床后多久真正入睡？中间在做什么？'),
    wp('第二部分：拖延体验', 'Heading1'),
    wp('有没有「明明很困却不想睡」的时刻？当时你在做什么、想什么？'),
    wp('你觉得这是主动选择还是不知不觉发生的？'),
    wp('第三部分：截图回顾', 'Heading1'),
    wp('请打开屏幕使用时间报告，我们一起看看昨晚的时间分布。'),
    wp('这个数字和你的预期一致吗？哪一段最让你意外？'),
    wp('第四部分：反思与策略', 'Heading1'),
    wp('你尝试过哪些方法改善睡眠？效果如何？为什么？'),
])
DOC = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s</w:body></w:document>''' % doc_body

docx_path = os.path.join(out, '测试文档-访谈大纲.docx')
with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT_DOCX)
    z.writestr('_rels/.rels', RELS_DOCX)
    z.writestr('word/styles.xml', STYLES)
    z.writestr('word/document.xml', DOC)
    z.writestr('word/_rels/document.xml.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''')

print('OK:', pptx_path)
print('OK:', docx_path)
