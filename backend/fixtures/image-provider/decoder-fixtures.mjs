import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const local = resolve('decoder.local', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
export const decoderPython = process.env.KMT_IMAGE_DECODER_PYTHON || (existsSync(local) ? local : null)
export function realImageFixtures() {
  if (!decoderPython) throw new Error('Real decoder tests require KMT_IMAGE_DECODER_PYTHON with scripts/image-decoder-requirements.txt installed')
  const script = `import io,json,base64
from PIL import Image
result = {}
for fmt in ['PNG','JPEG','GIF','WEBP','BMP']:
 b=io.BytesIO(); Image.new('RGB',(4,3),'red').save(b,format=fmt)
 result[fmt.lower()]=base64.b64encode(b.getvalue()).decode()
b=io.BytesIO(); Image.new('RGB',(4,3),'red').save(b,format='GIF',save_all=True,append_images=[Image.new('RGB',(4,3),'blue')],duration=10,loop=0)
result['animated']=base64.b64encode(b.getvalue()).decode()
b=io.BytesIO(); Image.new('RGB',(4096,4096),'red').save(b,format='PNG')
result['large']=base64.b64encode(b.getvalue()).decode()
print(json.dumps(result))`
  const run = spawnSync(decoderPython, ['-I', '-B', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  if (run.status !== 0) throw new Error('Unable to generate local decoder fixtures')
  return Object.fromEntries(Object.entries(JSON.parse(run.stdout)).map(([key, value]) => [key, Buffer.from(value, 'base64')]))
}
