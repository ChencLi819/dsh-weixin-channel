# cv-ref-any.py —— 用 OpenCV 编码任意文本,导出模块矩阵 + 读出的格式信息
# 用法: python cv-ref-any.py <文本> <输出json>
import cv2
import numpy as np
import json
import sys

text = sys.argv[1]
out = sys.argv[2]
p = cv2.QRCodeEncoder_Params()
p.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_M
p.mode = cv2.QRCodeEncoder_MODE_BYTE
enc = cv2.QRCodeEncoder_create(p)
img = enc.encode(text)
g = (img < 128).astype(int)
ys, xs = (g == 1).nonzero()
y0, x0 = int(ys.min()), int(xs.min())
h = int(ys.max()) - y0 + 1
w = int(xs.max()) - x0 + 1
size = max(h, w)
mods = g[y0:y0 + size, x0:x0 + size].tolist()
version = (size - 17) // 4
json.dump({'size': size, 'modules': mods, 'version': version, 'text': text}, open(out, 'w'))
print(f'OpenCV: 文本 {len(text)} 字节 → {size}x{size} (版本 {version}), 导出 {out}')

# 读出格式信息(副本1)
at = lambda r, c: mods[r][c] == 1
v = 0
for i in range(0, 6):
    if at(i, 8):
        v |= 1 << i
if at(7, 8):
    v |= 1 << 6
if at(8, 8):
    v |= 1 << 7
if at(8, 7):
    v |= 1 << 8
for i in range(9, 15):
    if at(8, 14 - i):
        v |= 1 << i
ROWS = {'L': [0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976],
        'M': [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0],
        'Q': [0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED],
        'H': [0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B]}
TABLE = {vv: (e, m) for e, arr in ROWS.items() for m, vv in enumerate(arr)}
print('格式信息 0x%04x →' % v, TABLE.get(v, '不在表里'))
