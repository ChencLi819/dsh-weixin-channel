# decisive.py —— 决定性验证:把 OpenCV 自己的 v10 矩阵,用与我方完全相同的渲染参数画出来。
# 若它也读不出,则证明 v10 读不出是 OpenCV 检测器的问题,而非我方编码器的问题。
import cv2
import numpy as np
import json

det = cv2.QRCodeDetector()

p = cv2.QRCodeEncoder_Params()
p.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_M
p.mode = cv2.QRCodeEncoder_MODE_BYTE
enc = cv2.QRCodeEncoder_create(p)
img = enc.encode('q' * 213)
g = (img < 128).astype(int)
ys, xs = (g == 1).nonzero()
mods = g[ys.min():ys.min() + 57, xs.min():xs.min() + 57]


def render(mods, scale=8, quiet=4):
    n = len(mods)
    dim = (n + 2 * quiet) * scale
    arr = np.full((dim, dim), 255, np.uint8)
    for r in range(n):
        for c in range(n):
            if mods[r][c]:
                arr[(r + quiet) * scale:(r + quiet + 1) * scale,
                    (c + quiet) * scale:(c + quiet + 1) * scale] = 0
    return arr


ref_render = render(mods)
mine = cv2.imread('tmp-suite-v10.png', cv2.IMREAD_GRAYSCALE)
print('同参数渲染 OpenCV 自己的矩阵:', ref_render.shape, '→ 解码:', repr(det.detectAndDecode(ref_render)[0][:16]))
print('我方 PNG:', mine.shape, '→ 解码:', repr(det.detectAndDecode(mine)[0][:16]))
same = (ref_render.shape == mine.shape) and int((np.abs(ref_render.astype(int) - mine.astype(int)) > 30).sum()) == 0
print('两张图逐像素完全相同:', same)
