#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_pdf.py — 本機 PDF OCR（PaddleOCR 3.x 的 PP-StructureV3；docs/local-mode.md 第 4 條）

三種用法（一次只能用一種）：

  辨識：python ocr_pdf.py --pdf <檔> --from N --to M --dpi 200 --out <目錄>
        用 PyMuPDF 把第 N～M 頁（1 起算、兩端皆含）轉成 PNG 存進 <目錄>，
        再用 PP-StructureV3（版面分析＋文字＋表格＋公式轉 LaTeX，繁體中文，只用 CPU）逐頁辨識。
        stdout 只印一個 JSON：
          { "engine": "paddleocr", "engine_version": "3.7.0", "dpi": 200,
            "pages": [ { "page": N, "image": "<PNG 的絕對路徑>", "markdown": "…" }, … ] }
        markdown 裡的公式是 $…$（行內）或 $$…$$（獨立公式塊），表格是簡化過的 HTML，
        附圖一律換成「[圖]」。

  --selftest：不需要任何輸入檔。確認套件裝好、模型都在本機、CPU 推論跑得動
        （拿一張程式自己畫的小頁面實際辨識一次）。成功印 {"ok": true, "engine_version": …}。

  --warmup：安裝時跑一次（L4 的 setup_local_ai.bat 會呼叫）。**唯一允許連網的模式**：
        把 PP-StructureV3 需要的模型下載到 ocr_service/models，再實際辨識一次確認可用。

紀律：
  1. stdout 只放最後那一個 JSON。PaddleOCR／Paddle 的 log（含 C++ 層直接寫 fd 1 的訊息）
     全部導到 stderr——程式一開始就把 fd 1 接到 fd 2，JSON 用另存的 fd 寫出，且一律 UTF-8。
  2. 錯誤只印到 stderr，並以非 0 結束（結束碼見下方 EXIT_*）。
  3. 辨識與 --selftest **不得下載任何東西**：模型不在本機就明確失敗（EXIT_NOT_READY），
     提示先跑 --warmup。做法是把 PaddleX 的「向模型平台下載」那一步換成直接丟錯，
     並關掉它啟動時的連線檢查（PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK）。
  4. 只用 CPU（device="cpu"）。
  5. 頁面影像以 numpy 陣列交給 PaddleOCR，不讓它用路徑讀檔：Windows 上路徑含中文時
     OpenCV 的 imread 會失敗（使用者名稱、專案資料夾都可能是中文）。

辨識設定（改了任何一項，services/ocr/index.js 註冊的 'ocr.v1' 模板文字要一起改版，
既有的 ocr cassette 才會失效）：見 PIPELINE_OPTIONS。
"""

import argparse
import json
import os
import re
import sys
import time

EXIT_OK = 0
EXIT_USAGE = 2          # argparse 自己用 2
EXIT_NOT_READY = 3      # 套件沒裝、模型不在本機
EXIT_INPUT = 4          # PDF 讀不到、頁碼超出範圍、輸出目錄不能寫
EXIT_OCR = 5            # 辨識過程丟例外

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_HOME = os.path.join(HERE, "models")

ENGINE = "paddleocr"
PIPELINE = "PP-StructureV3"

# PP-StructureV3 的建構參數（PaddleOCR 3.x 的 Python API）。
#   lang=chinese_cht           → 文字偵測／辨識用 PP-OCRv5 server 模型（支援繁體中文）
#   公式：PP-FormulaNet_plus-M → 官方表格 Zh-BLEU 89.76%（S 版只有 53.32%，L 版 CPU 慢一倍）
#   關掉：文件方向分類、扭曲校正、文字行方向、印章、圖表——考卷是正的掃描／電子檔，這幾個只會拖慢 CPU
#   表格辨識保留：考卷的資料表要能變成文字，結構化模型才改寫得成 LaTeX array
PIPELINE_OPTIONS = {
    "lang": "chinese_cht",
    "device": "cpu",
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
    "use_seal_recognition": False,
    "use_chart_recognition": False,
    "use_table_recognition": True,
    "use_formula_recognition": True,
    "use_region_detection": True,
    "formula_recognition_model_name": "PP-FormulaNet_plus-M",
}

MIN_DPI = 72
MAX_DPI = 600


class OcrError(Exception):
    """帶結束碼的錯誤：main() 只認這一種，其餘例外一律視為 EXIT_OCR。"""

    def __init__(self, message, code=EXIT_OCR):
        super().__init__(message)
        self.code = code


class ModelsMissing(Exception):
    """辨識／自檢模式下 PaddleX 想下載模型——代表模型不在本機。"""


# ───────────────────────── stdout 保護 ─────────────────────────

def _protect_stdout():
    """把 fd 1 接到 fd 2，回傳原本 stdout 的 fd（只有最後的 JSON 寫進去）。"""
    try:
        sys.stdout.flush()
    except Exception:
        pass
    saved = os.dup(1)
    os.dup2(2, 1)
    return saved


def _emit(fd, obj):
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _err(message):
    sys.stderr.write(str(message).rstrip() + "\n")
    sys.stderr.flush()


# ───────────────────────── 環境與離線護欄 ─────────────────────────

def _prepare_env(model_home, allow_download):
    """必須在 import paddleocr／paddlex 之前呼叫：PaddleX 在 import 當下就讀這些環境變數。"""
    os.environ["PADDLE_PDX_CACHE_HOME"] = model_home
    if not allow_download:
        # 跳過「啟動時檢查模型平台連線」；HuggingFace 用戶端也設成離線
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def _forbid_downloads():
    """把 PaddleX 的下載換成直接丟 ModelsMissing。內部 API 變了就退回只靠環境變數（印警告）。"""
    try:
        from paddlex.inference.utils import official_models as om

        def _refuse(self, hosters, model_name):
            names = model_name if isinstance(model_name, str) else ", ".join(model_name)
            raise ModelsMissing(names)

        om._ModelManager._download_from_hoster = _refuse
        # 非空的佔位清單：讓流程走到上面的 _refuse，而不是先丟「沒有可用的模型平台」
        om._ModelManager._build_hosters = lambda self: [None]
    except Exception as exc:  # pragma: no cover — 只有 PaddleX 改了內部結構才會走到
        _err(f"[ocr_pdf] 警告：無法安裝離線護欄（{exc}）；請確認模型已由 --warmup 下載完成。")


def _find_models_missing(exc):
    seen = set()
    cur = exc
    while cur is not None and id(cur) not in seen:
        if isinstance(cur, ModelsMissing):
            return cur
        seen.add(id(cur))
        cur = cur.__cause__ or cur.__context__
    return None


def _versions():
    import paddleocr
    info = {"engine_version": getattr(paddleocr, "__version__", "0.0.0")}
    try:
        import paddlex
        info["paddlex_version"] = getattr(paddlex, "__version__", None)
    except Exception:
        info["paddlex_version"] = None
    try:
        import paddle
        info["paddle_version"] = getattr(paddle, "__version__", None)
    except Exception:
        info["paddle_version"] = None
    return info


def _import_engine():
    try:
        import paddleocr  # noqa: F401
        _pymupdf()
        import numpy  # noqa: F401
    except ImportError as exc:
        raise OcrError(
            f"缺少套件：{exc}。請在 ocr_service 的虛擬環境執行 pip install -r requirements.txt。",
            EXIT_NOT_READY,
        )


def _build_pipeline(cpu_threads, allow_download):
    from paddleocr import PPStructureV3

    if not allow_download:
        _forbid_downloads()
    try:
        return PPStructureV3(cpu_threads=cpu_threads, **PIPELINE_OPTIONS)
    except Exception as exc:
        missing = _find_models_missing(exc)
        if missing is not None:
            raise OcrError(
                f"模型不在本機（{missing}）。請先執行一次 python ocr_pdf.py --warmup（需要網路，只做一次）。",
                EXIT_NOT_READY,
            )
        if allow_download:
            raise OcrError(
                f"下載或初始化模型失敗：{type(exc).__name__}: {exc}。--warmup 需要能連到 PaddleX 的模型平台"
                "（預設 HuggingFace；可用環境變數 PADDLE_PDX_MODEL_SOURCE 改成 modelscope／aistudio／bos）。",
                EXIT_NOT_READY,
            )
        raise OcrError(f"PP-StructureV3 初始化失敗：{type(exc).__name__}: {exc}", EXIT_NOT_READY)


# ───────────────────────── PDF → 影像 ─────────────────────────

def _pymupdf():
    """PyMuPDF 1.24 起的模組名是 pymupdf（舊名 fitz 會印棄用警告）。"""
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        import fitz
        return fitz


def render_pages(pdf_path, from_page, to_page, dpi, out_dir):
    """回傳 [(頁碼, PNG 絕對路徑, BGR numpy 陣列)]。PNG 用 Python 的 open() 寫，路徑含中文也沒問題。"""
    import numpy as np

    fitz = _pymupdf()
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        raise OcrError(f"PDF 打不開：{pdf_path}（{exc}）", EXIT_INPUT)
    try:
        if doc.needs_pass:
            raise OcrError("PDF 有開啟密碼，無法辨識。", EXIT_INPUT)
        total = doc.page_count
        if not (1 <= from_page <= to_page <= total):
            raise OcrError(f"頁碼超出範圍：--from {from_page} --to {to_page}，這份 PDF 共 {total} 頁。", EXIT_INPUT)
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as exc:
            raise OcrError(f"輸出目錄無法建立：{out_dir}（{exc}）", EXIT_INPUT)

        rendered = []
        for page_no in range(from_page, to_page + 1):
            page = doc.load_page(page_no - 1)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            png = pix.tobytes("png")
            image_path = os.path.abspath(os.path.join(out_dir, f"page-{page_no:04d}.png"))
            try:
                with open(image_path, "wb") as fh:
                    fh.write(png)
            except OSError as exc:
                raise OcrError(f"PNG 寫不進輸出目錄：{image_path}（{exc}）", EXIT_INPUT)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n >= 3:
                arr = arr[:, :, 2::-1].copy()   # RGB → BGR（PaddleX 以 OpenCV 慣例處理 numpy 輸入）
            rendered.append((page_no, image_path, arr))
        return rendered
    finally:
        doc.close()


# ───────────────────────── 結果 → Markdown ─────────────────────────

_IMG_HTML = re.compile(r"<div[^>]*>\s*<img[^>]*>\s*</div>|<img[^>]*>", re.IGNORECASE)
_IMG_MD = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_DIV_TAG = re.compile(r"</?div[^>]*>", re.IGNORECASE)
_BLANK_LINES = re.compile(r"\n{3,}")


def clean_markdown(text):
    """附圖換成「[圖]」、拿掉排版用的 <div>、壓掉多餘空行。表格的 HTML 與 $…$ 公式原樣保留。"""
    s = str(text or "")
    s = _IMG_HTML.sub("[圖]", s)
    s = _IMG_MD.sub("[圖]", s)
    s = _DIV_TAG.sub("", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = _BLANK_LINES.sub("\n\n", s)
    return s.strip()


def result_markdown(res):
    """PP-StructureV3 單頁結果 → Markdown 字串（不經 HTML 美化；舊版沒有 pretty 參數時退回 .markdown）。"""
    md = None
    to_md = getattr(res, "_to_markdown", None)
    if callable(to_md):
        try:
            md = to_md(pretty=False)
        except TypeError:
            md = None
    if md is None:
        md = res.markdown
    if isinstance(md, dict):
        md = md.get("markdown_texts", "")
    return clean_markdown(md)


def ocr_images(pipeline, rendered):
    pages = []
    for page_no, image_path, arr in rendered:
        try:
            results = list(pipeline.predict(arr))
        except Exception as exc:
            missing = _find_models_missing(exc)
            if missing is not None:
                raise OcrError(f"模型不在本機（{missing}）。請先執行 python ocr_pdf.py --warmup。", EXIT_NOT_READY)
            raise OcrError(f"第 {page_no} 頁辨識失敗：{type(exc).__name__}: {exc}", EXIT_OCR)
        markdown = "\n\n".join(result_markdown(r) for r in results).strip()
        pages.append({"page": page_no, "image": image_path, "markdown": markdown})
    return pages


# ───────────────────────── 自檢頁面 ─────────────────────────

def _synthetic_page(out_dir):
    """程式自己畫一頁（中文＋數字），給 --selftest／--warmup 實際跑一次辨識用。"""
    fitz = _pymupdf()
    os.makedirs(out_dir, exist_ok=True)
    pdf_path = os.path.join(out_dir, "selftest.pdf")
    doc = fitz.open()
    page = doc.new_page(width=420, height=200)
    # 內建 CJK 字型（china-t＝繁體），不依賴系統字型
    page.insert_text((24, 60), "1. 設 x + 2 = 5，求 x。", fontsize=18, fontname="china-t")
    page.insert_text((24, 110), "(A) 1  (B) 2  (C) 3  (D) 4", fontsize=16, fontname="china-t")
    doc.save(pdf_path)
    doc.close()
    return pdf_path


def _run_selfcheck(args, allow_download):
    import tempfile

    _import_engine()
    pipeline = _build_pipeline(args.cpu_threads, allow_download)
    with tempfile.TemporaryDirectory(prefix="ocr-selftest-") as tmp:
        pdf_path = _synthetic_page(tmp)
        rendered = render_pages(pdf_path, 1, 1, 150, os.path.join(tmp, "pages"))
        pages = ocr_images(pipeline, rendered)
    return pages


# ───────────────────────── CLI ─────────────────────────

def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="ocr_pdf.py",
        description="本機 PDF OCR（PaddleOCR PP-StructureV3，CPU）。stdout 只印一個 JSON。",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--selftest", action="store_true", help="確認套件與模型已就緒（不連網）")
    mode.add_argument("--warmup", action="store_true", help="下載模型並試跑一次（安裝時用，需要網路）")
    p.add_argument("--pdf", help="PDF 檔路徑")
    p.add_argument("--from", dest="from_page", type=int, help="起始頁（1 起算，含）")
    p.add_argument("--to", dest="to_page", type=int, help="結束頁（含）")
    p.add_argument("--dpi", type=int, default=200, help=f"轉圖解析度（{MIN_DPI}～{MAX_DPI}，預設 200）")
    p.add_argument("--out", help="頁面 PNG 的輸出目錄")
    p.add_argument("--model-home", default=os.environ.get("OCR_MODEL_HOME") or DEFAULT_MODEL_HOME,
                   help="模型存放目錄（預設 ocr_service/models）")
    p.add_argument("--cpu-threads", type=int, default=max(1, min(os.cpu_count() or 4, 8)),
                   help="CPU 推論執行緒數（預設 min(核心數, 8)）")
    args = p.parse_args(argv)

    if not (args.selftest or args.warmup):
        missing = [name for name, value in (("--pdf", args.pdf), ("--from", args.from_page),
                                            ("--to", args.to_page), ("--out", args.out)) if value is None]
        if missing:
            p.error(f"辨識模式缺少參數：{' '.join(missing)}")
        if args.from_page < 1 or args.to_page < args.from_page:
            p.error(f"頁碼範圍不合法：--from {args.from_page} --to {args.to_page}")
        if not (MIN_DPI <= args.dpi <= MAX_DPI):
            p.error(f"--dpi 必須在 {MIN_DPI}～{MAX_DPI} 之間，收到 {args.dpi}")
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    out_fd = _protect_stdout()
    allow_download = bool(args.warmup)
    _prepare_env(os.path.abspath(args.model_home), allow_download)
    started = time.time()
    try:
        if args.selftest or args.warmup:
            pages = _run_selfcheck(args, allow_download)
            info = _versions()
            payload = {"ok": True, "engine": ENGINE, "pipeline": PIPELINE, **info,
                       "model_home": os.path.abspath(args.model_home),
                       "sample_markdown": pages[0]["markdown"] if pages else "",
                       "elapsed_ms": int((time.time() - started) * 1000)}
            _emit(out_fd, payload)
            return EXIT_OK

        # 先檢查輸入檔再載入 PaddleOCR（載入要好幾秒；檔案不在就不必等）
        pdf_path = os.path.abspath(args.pdf)
        if not os.path.isfile(pdf_path):
            raise OcrError(f"找不到 PDF：{pdf_path}", EXIT_INPUT)
        _import_engine()
        rendered = render_pages(pdf_path, args.from_page, args.to_page, args.dpi, os.path.abspath(args.out))
        pipeline = _build_pipeline(args.cpu_threads, allow_download=False)
        pages = ocr_images(pipeline, rendered)
        info = _versions()
        _emit(out_fd, {
            "engine": ENGINE,
            "engine_version": info["engine_version"],
            "paddlex_version": info["paddlex_version"],
            "paddle_version": info["paddle_version"],
            "pipeline": PIPELINE,
            "dpi": args.dpi,
            "pages": pages,
            "elapsed_ms": int((time.time() - started) * 1000),
        })
        return EXIT_OK
    except OcrError as exc:
        _err(f"[ocr_pdf] {exc}")
        return exc.code
    except KeyboardInterrupt:
        _err("[ocr_pdf] 被中止")
        return EXIT_OCR
    except Exception as exc:  # 任何沒預期到的例外：印到 stderr、非 0 結束，stdout 保持空白
        missing = _find_models_missing(exc)
        if missing is not None:
            _err(f"[ocr_pdf] 模型不在本機（{missing}）。請先執行 python ocr_pdf.py --warmup。")
            return EXIT_NOT_READY
        import traceback
        _err(f"[ocr_pdf] 未預期的錯誤：{type(exc).__name__}: {exc}")
        traceback.print_exc(file=sys.stderr)
        return EXIT_OCR


if __name__ == "__main__":
    sys.exit(main())
