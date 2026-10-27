/** 封面图 URL：经主进程注册的 cover:// 协议加载（路径整体编码，空格/中文安全） */
export function coverUrl(coverPath: string): string {
  return `cover://${encodeURIComponent(coverPath)}`
}

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解析失败，可能不是有效图片'))
    img.src = src
  })

/**
 * 读入图片文件并压缩为 dataUrl：长边最多 maxSize 像素、JPEG 质量 quality。
 * 小图（<=300KB）原样返回，避免无谓的二次压缩损失。
 * 压缩放在渲染进程是为了不引 sharp 之类的原生模块——personal 规模一本书一张封面，
 * canvas 画几百次的开销完全可以忽略。
 */
export async function compressImageFile(file: File, maxSize = 720, quality = 0.85): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  const dataUrl = await readAsDataUrl(file)
  if (file.size <= 300 * 1024) return dataUrl
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.fillStyle = '#ffffff' // JPEG 无透明通道，先铺白底防黑边
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}
