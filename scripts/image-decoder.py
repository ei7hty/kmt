"""Private single-image worker. Establish native allocation limits before Pillow import."""
import sys
import os
import json
import math


def constrain(memory, milliseconds):
    if os.name == 'nt':
        import ctypes as c
        from ctypes import wintypes as w

        class Basic(c.Structure):
            _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64),
                        ('flags', w.DWORD), ('min_ws', c.c_size_t), ('max_ws', c.c_size_t),
                        ('processes', w.DWORD), ('affinity', c.c_size_t),
                        ('priority', w.DWORD), ('scheduling', w.DWORD)]

        class IO(c.Structure):
            _fields_ = [(name, c.c_uint64) for name in
                        ['read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes']]

        class Extended(c.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('process_memory', c.c_size_t),
                        ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]

        kernel = c.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        kernel.CreateJobObjectW.restype = w.HANDLE
        kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        job = kernel.CreateJobObjectW(None, None)
        limits = Extended()
        # PROCESS_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | KILL_ON_JOB_CLOSE.
        limits.basic.flags = 0x2 | 0x8 | 0x100 | 0x2000
        limits.basic.process_time = math.ceil(milliseconds / 1000) * 10_000_000
        limits.basic.processes = 1
        limits.process_memory = memory
        if not job or not kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)):
            raise RuntimeError('job limit setup failed')
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise RuntimeError('job assignment failed')
        # Keep handle alive until process exit; closing it kills this worker.
        return 'windows-job'
    if os.name == 'posix':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        cpu = math.ceil(milliseconds / 1000)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        return 'posix-rlimit'
    raise RuntimeError('unsupported isolation platform')


def validate_png_stream(data, width, height):
    """Pillow checks chunk CRCs, but tolerates an absent zlib checksum/EOF.
    Stream through stdlib zlib with bounded output and exact PNG scanline size.
    This supplements the native decoder; it never implements pixel decoding.
    """
    import zlib
    depth, color, interlace = data[24], data[25], data[28]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if interlace == 0 else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    expected = 0
    for x, y, dx, dy in passes:
        w = max(0, (width - x + dx - 1) // dx)
        h = max(0, (height - y + dy - 1) // dy)
        if w and h:
            expected += h * (1 + (w * channels * depth + 7) // 8)
    chunks, offset = [], 8
    while offset < len(data):
        size = int.from_bytes(data[offset:offset + 4], 'big')
        if offset + size + 12 > len(data):
            raise ValueError('png chunk length')
        if data[offset + 4:offset + 8] == b'IDAT':
            chunks.append(data[offset + 8:offset + 8 + size])
        offset += size + 12
    pending = b''.join(chunks)
    decoder, total = zlib.decompressobj(), 0
    while True:
        block = decoder.decompress(pending, 65536)
        total += len(block)
        if total > expected or decoder.unused_data:
            raise ValueError('png decompressed size')
        pending = decoder.unconsumed_tail
        if not pending and len(block) < 65536:
            break
    if not decoder.eof or decoder.unused_data or total != expected:
        raise ValueError('incomplete png zlib stream')


def decode():
    memory, pixels, frames, milliseconds = map(int, sys.argv[1:])
    if not (0 < memory <= 512 * 1024 * 1024 and 0 < pixels <= 100_000_000 and frames == 1 and 0 < milliseconds <= 30000):
        raise ValueError('budget')
    isolation = constrain(memory, milliseconds)
    import io
    import warnings
    import PIL
    from PIL import Image, ImageFile
    if PIL.__version__ != '12.3.0':
        raise ValueError('unreviewed decoder version')
    Image.MAX_IMAGE_PIXELS = pixels
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    data = sys.stdin.buffer.read(5 * 1024 * 1024 + 1)
    if not data or len(data) > 5 * 1024 * 1024:
        raise ValueError('input size')
    # GIF/WebP are conservatively unavailable until strict payload validation
    # exists. Their Pillow paths can recover after payload bytes are removed.
    formats = ['PNG', 'JPEG']
    # Restrict plugin discovery, verify container integrity, reopen and fully decode.
    with Image.open(io.BytesIO(data), formats=formats) as image:
        width, height = image.size
        fmt = image.format
        if width * height > pixels or getattr(image, 'n_frames', 1) > frames:
            raise ValueError('pixel or frame budget')
        image.verify()
    if fmt == 'JPEG':
        # Pillow's libjpeg wrapper suppresses recoverable entropy errors, even
        # when truncation is disabled. Strict libturbojpeg errors are mandatory.
        # Keep NumPy's BLAS runtime single-threaded within the same OS limits.
        os.environ['OPENBLAS_NUM_THREADS'] = '1'
        os.environ['OMP_NUM_THREADS'] = '1'
        import simplejpeg
        import numpy
        if simplejpeg.__version__ != '1.9.0' or numpy.__version__ != '2.5.3':
            raise ValueError('unreviewed strict jpeg runtime')
        jpeg_height, jpeg_width, _, _ = simplejpeg.decode_jpeg_header(data, strict=True)
        if (jpeg_width, jpeg_height) != (width, height):
            raise ValueError('jpeg header mismatch')
        decoded = simplejpeg.decode_jpeg(data, strict=True)
        if decoded.shape[:2] != (height, width):
            raise ValueError('jpeg decode mismatch')
        del decoded
    if fmt == 'PNG':
        validate_png_stream(data, width, height)
    with Image.open(io.BytesIO(data), formats=formats) as image:
        image.load()
        # A seek proves EOF for formats whose frame count is discovered lazily.
        try:
            image.seek(1)
        except EOFError:
            pass
        else:
            raise ValueError('extra frame')
    # Some codecs tolerate missing terminal markers even with truncation disabled.
    if fmt == 'JPEG' and not data.endswith(b'\xff\xd9'):
        raise ValueError('truncated jpeg')
    if fmt == 'PNG' and not data.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82'):
        raise ValueError('truncated png')
    print(json.dumps(dict(width=width, height=height, format=fmt.lower(), frames=1,
                          decoder=PIL.__version__, isolation=isolation,
                          validation='simplejpeg-1.9.0-strict' if fmt == 'JPEG' else 'png-zlib-complete-v1')))


if __name__ == '__main__':
    try:
        decode()
    except BaseException:
        # Never leak native errors, filenames, input, or inherited environment.
        sys.exit(2)
