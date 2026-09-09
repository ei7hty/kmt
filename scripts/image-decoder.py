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
    formats = ['PNG', 'JPEG', 'GIF', 'WEBP']
    # Restrict plugin discovery, verify container integrity, reopen and fully decode.
    with Image.open(io.BytesIO(data), formats=formats) as image:
        width, height = image.size
        fmt = image.format
        if width * height > pixels or getattr(image, 'n_frames', 1) > frames:
            raise ValueError('pixel or frame budget')
        image.verify()
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
    if fmt == 'GIF' and not data.endswith(b';'):
        raise ValueError('truncated gif')
    if fmt == 'PNG' and not data.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82'):
        raise ValueError('truncated png')
    if fmt == 'WEBP' and (len(data) < 12 or int.from_bytes(data[4:8], 'little') + 8 != len(data)):
        raise ValueError('truncated webp')
    print(json.dumps(dict(width=width, height=height, format=fmt.lower(), frames=1,
                          decoder=PIL.__version__, isolation=isolation)))


if __name__ == '__main__':
    try:
        decode()
    except BaseException:
        # Never leak native errors, filenames, input, or inherited environment.
        sys.exit(2)
