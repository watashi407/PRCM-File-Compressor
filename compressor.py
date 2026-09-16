"""Content-based detection and size-checked compression. MB means 1,000,000 bytes."""
from __future__ import annotations

import io
import math
import re
import shutil
import subprocess
import threading
import zipfile
from pathlib import Path

import imageio_ffmpeg
import pymupdf
from PIL import Image, ImageOps, UnidentifiedImageError

TARGET = 4_800_000
MAXIMUM = 5_000_000
PDF_LOCK = threading.Lock()  # MuPDF does not support concurrent use in threads.
Image.MAX_IMAGE_PIXELS = 60_000_000


class CompressionError(Exception):
    pass


def ffmpeg(args: list[str], timeout: int = 600):
    try:
        return subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-nostdin', *args],
            capture_output=True, text=True, errors='replace', timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise CompressionError('This file took too long to process. Try a shorter or smaller file.') from exc


def detect(path: Path) -> dict:
    with path.open('rb') as stream:
        header = stream.read(1024)
    if b'%PDF-' in header:
        return {'kind': 'pdf', 'format': 'PDF', 'extension': '.pdf'}
    try:
        with Image.open(path) as img:
            fmt = img.format or 'image'
            animated = getattr(img, 'n_frames', 1) > 1
            return {'kind': 'archive' if animated else 'image', 'format': fmt,
                    'extension': {'JPEG': '.jpg', 'TIFF': '.tiff'}.get(fmt, '.' + fmt.lower()),
                    'animated': animated}
    except (UnidentifiedImageError, OSError, ValueError):
        pass
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
        fmt = 'DOCX' if 'word/document.xml' in names else 'XLSX' if 'xl/workbook.xml' in names else 'PPTX' if 'ppt/presentation.xml' in names else 'EPUB' if 'META-INF/container.xml' in names else 'ZIP'
        return {'kind': 'archive', 'format': fmt, 'extension': ''}
    for signature, fmt in [(b'7z\xbc\xaf\x27\x1c', '7Z'), (b'Rar!\x1a\x07', 'RAR'), (b'\x1f\x8b', 'GZIP'), (b'MZ', 'EXE'), (b'\xd0\xcf\x11\xe0', 'Office document')]:
        if header.startswith(signature):
            return {'kind': 'archive', 'format': fmt, 'extension': ''}
    # Restrict input protocols so uploaded playlists cannot fetch remote resources.
    probe = ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', str(path)], timeout=30)
    info = probe.stderr
    duration_match = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', info)
    if duration_match and ('Video:' in info or 'Audio:' in info):
        h, m, s = map(float, duration_match.groups())
        duration = h * 3600 + m * 60 + s
        is_video = 'Video:' in info and '(attached pic)' not in info
        container = re.search(r'Input #0, (.*?), from ', info)
        fmt = container.group(1).split(',')[0].upper() if container else 'MEDIA'
        return {'kind': 'video' if is_video else 'audio', 'format': fmt,
                'extension': '', 'duration': duration, 'has_audio': 'Audio:' in info}
    try:
        text = header.decode('utf-8-sig')
        is_text = bool(text) and all(character.isprintable() or character.isspace() for character in text)
    except UnicodeDecodeError:
        is_text = False
    return {'kind': 'archive', 'format': 'Text' if is_text else 'File', 'extension': ''}


def compress_image(source: Path, output: Path, update) -> tuple[Path, str]:
    with Image.open(source) as original:
        img = ImageOps.exif_transpose(original)
        has_alpha = img.mode in ('RGBA', 'LA') or 'transparency' in img.info
        img = img.convert('RGBA' if has_alpha else 'RGB')
        fmt, extension = ('WEBP', '.webp') if has_alpha else ('JPEG', '.jpg')
        result = output.with_suffix(extension)
        for resize_attempt in range(12):
            best = None
            low, high = 35, 95
            while low <= high:
                quality = (low + high) // 2
                buffer = io.BytesIO()
                img.save(buffer, fmt, quality=quality, **({'optimize': True} if fmt == 'JPEG' else {}))
                data = buffer.getvalue()
                if len(data) <= TARGET:
                    best = data
                    low = quality + 1
                else:
                    high = quality - 1
            if best is not None:
                result.write_bytes(best)
                return result, f'Converted to {fmt}. Image quality and dimensions adjusted only as needed.'
            update(30 + resize_attempt * 4, 'Adjusting image dimensions')
            img = img.resize((max(1, int(img.width * .8)), max(1, int(img.height * .8))), Image.Resampling.LANCZOS)
    raise CompressionError('This image could not be reduced below 5 MB.')


def compress_pdf(source: Path, output: Path, update) -> tuple[Path, str]:
    result = output.with_suffix('.pdf')
    with PDF_LOCK:
        with pymupdf.open(source) as doc:
            if doc.needs_pass:
                raise CompressionError('This PDF is password protected. Upload an unlocked copy.')
            if not doc.page_count:
                raise CompressionError('This PDF has no pages.')
            if doc.get_sigflags() > 0:
                raise CompressionError('This PDF contains a digital signature. Compression would invalidate it. Upload an unsigned copy.')
            doc.save(result, garbage=4, deflate=True, use_objstms=1)
        if result.stat().st_size <= TARGET:
            return result, 'PDF optimized. Text, links, and pages preserved.'
        for index, (dpi, quality) in enumerate([(180, 85), (140, 70), (110, 55), (85, 40), (65, 30)]):
            update(25 + index * 12, 'Optimizing PDF images')
            with pymupdf.open(source) as doc:
                doc.rewrite_images(dpi_threshold=dpi + 20, dpi_target=dpi, quality=quality)
                doc.save(result, garbage=4, deflate=True, use_objstms=1)
            if result.stat().st_size <= TARGET:
                return result, 'PDF images compressed. Text stays selectable; pages and links are preserved.'
        if result.stat().st_size <= MAXIMUM:
            return result, 'PDF images compressed. Text stays selectable; pages and links are preserved.'
    raise CompressionError('This PDF cannot fit under 5 MB while preserving its pages and text. Split it into smaller documents.')


def compress_media(source: Path, output: Path, info: dict, update) -> tuple[Path, str]:
    duration = info['duration']
    if duration <= 0 or not math.isfinite(duration):
        raise CompressionError('The duration of this media file could not be read.')
    video = info['kind'] == 'video'
    result = output.with_suffix('.mp4' if video else '.mp3')
    budget = int(TARGET * 8 * .95 / duration)
    for attempt in range(3):
        update(25 + attempt * 20, 'Encoding video' if video else 'Encoding audio')
        args = ['-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map_metadata', '-1']
        if video:
            audio_rate = min(96_000, max(24_000, int(budget * .15))) if info['has_audio'] else 0
            rate = budget - audio_rate
            if rate < 45_000:
                raise CompressionError('This video is too long to fit under 5 MB at usable quality. Trim it and try again.')
            width = 1280 if rate >= 1_000_000 else 854 if rate >= 400_000 else 640 if rate >= 150_000 else 426
            encoding = ['-map', '0:v:0', '-vf', f'scale=w=min({width}\\,iw):h=-2:force_divisible_by=2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-b:v', str(rate),
                        '-passlogfile', str(output.parent / 'encode-pass')]
            update(30 + attempt * 20, 'Analyzing video frames')
            first = ffmpeg([*args, *encoding, '-pass', '1', '-an', '-f', 'null', '-'])
            if first.returncode != 0:
                raise CompressionError('This video could not be decoded. Try exporting it as an MP4 first.')
            update(40 + attempt * 20, 'Compressing video frames')
            args += encoding + ['-pass', '2', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', str(audio_rate or 24_000), '-ac', '2', '-movflags', '+faststart']
        else:
            rates = [16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
            possible = [rate for rate in rates if rate * 1000 <= budget]
            if not possible:
                raise CompressionError('This audio is too long to fit under 5 MB. Trim it and try again.')
            args += ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', f'{max(possible)}k', '-ac', '2']
        encoded = ffmpeg([*args, str(result)])
        if encoded.returncode != 0:
            raise CompressionError('This media file could not be encoded. It may be damaged or use an unsupported codec.')
        if result.stat().st_size <= TARGET:
            return result, 'Converted to MP4 with the first video and audio tracks.' if video else 'Converted to MP3 with the first audio track.'
        budget = int(budget * .88)
    if result.exists() and result.stat().st_size <= MAXIMUM:
        return result, 'Media compressed and verified below 5 MB.'
    raise CompressionError('This media file could not be reduced below 5 MB.')


def compress(source: Path, name: str, update=lambda *_: None) -> dict:
    update(8, 'Detecting file format')
    info = detect(source)
    update(16, f"Detected {info['format']}", info)
    size = source.stat().st_size
    if size == 0:
        raise CompressionError('This file is empty. Choose a file with content.')
    stem = Path(name).stem or 'file'
    output = source.parent / 'compressed'
    if size <= TARGET:
        result = output.with_suffix(info['extension'] or Path(name).suffix or '.bin')
        shutil.copyfile(source, result)
        note = 'Already below 4.8 MB. Your file is unchanged.'
        download_name = name
    else:
        update(22, 'Compressing file')
        if info['kind'] == 'image':
            result, note = compress_image(source, output, update)
        elif info['kind'] == 'pdf':
            result, note = compress_pdf(source, output, update)
        elif info['kind'] in ('video', 'audio'):
            result, note = compress_media(source, output, info, update)
        else:
            result = output.with_suffix('.zip')
            with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                archive.write(source, arcname=name)
            note = 'Packed into a ZIP archive. Extract it to get the original file.'
        download_name = stem + '-compressed' + result.suffix
    final_size = result.stat().st_size
    if final_size > MAXIMUM or final_size >= size > MAXIMUM:
        raise CompressionError('This file cannot be compressed below 5 MB without changing its contents. Try splitting it into smaller files.')
    if not final_size:
        raise CompressionError('The compressor produced an empty file. Try another file.')
    update(100, 'Ready to download')
    return {'path': str(result), 'name': download_name, 'size': final_size,
            'original_size': size, 'detected': info, 'note': note}
