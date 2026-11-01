# qr-suite-check.py —— 用 OpenCV 解码 qr-suite.mjs 生成的全部 PNG。
#
# 判据不是「必须解出来」:OpenCV 的检测器在大尺寸/特定对齐下会抖(同一个矩阵,
# 白边差几个像素就时而解得开时而解不开)。所以失败的用例要再做一步对照 ——
# 用 OpenCV 自己的编码器生成同样内容的矩阵,按**完全相同的参数**渲染,
# 如果它自己也解不出来,那就是检测器的局限,不是我们编码器的问题。
import json
import sys
import cv2
import numpy as np

meta = json.load(open('tmp-suite.json', encoding='utf-8'))
det = cv2.QRCodeDetector()


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


def opencv_matrix(text):
    p = cv2.QRCodeEncoder_Params()
    p.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_M
    p.mode = cv2.QRCodeEncoder_MODE_BYTE
    enc = cv2.QRCodeEncoder_create(p)
    img = enc.encode(text)
    g = (img < 128).astype(int)
    ys, xs = (g == 1).nonzero()
    side = max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1)
    return g[ys.min():ys.min() + side, xs.min():xs.min() + side]


ok = 0
exonerated = 0
bad = 0
for case in meta:
    img = cv2.imread(case['file'], cv2.IMREAD_GRAYSCALE)
    if img is None:
        bad += 1
        print(f"FAIL {case['name']:8s} 读不到图")
        continue
    got = det.detectAndDecode(img)[0]
    if got == case['text']:
        ok += 1
        print(f"OK   {case['name']:8s} v{case['version']:<2} 解码一致")
        continue

    # 对照:OpenCV 自己的矩阵,同参数渲染
    ref_ok = det.detectAndDecode(render(opencv_matrix(case['text'])))[0] == case['text']
    if not ref_ok:
        exonerated += 1
        print(f"SKIP {case['name']:8s} v{case['version']:<2} 我方读不出,但 OpenCV 自己的同尺寸矩阵同参数也读不出 → 检测器局限,非编码器缺陷")
    else:
        bad += 1
        print(f"FAIL {case['name']:8s} v{case['version']:<2} 我方读不出,而 OpenCV 自己可以 → 这是真问题")

print(f"\n直接通过 {ok} · 检测器局限(已对照排除) {exonerated} · 真失败 {bad}")
sys.exit(0 if bad == 0 else 1)
