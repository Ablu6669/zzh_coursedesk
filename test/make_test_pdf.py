# 生成最小测试 PDF（单页、含可选取文本）
import os

def make_pdf(path):
    content = b"BT /F1 24 Tf 72 720 Td (Hello CourseDeck PDF annotation test) Tj ET\nBT /F1 14 Tf 72 680 Td (Second line of text for selection.) Tj ET\n"
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream")

    pdf = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(pdf)
    pdf += b"xref\n0 %d\n" % (len(objs) + 1)
    pdf += b"0000000000 65535 f \n"
    for off in offsets:
        pdf += b"%010d 00000 n \n" % off
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref_pos)
    with open(path, 'wb') as f:
        f.write(pdf)
    print('OK:', path, len(pdf), 'bytes')

make_pdf(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test.pdf'))
