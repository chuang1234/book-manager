import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/**
 * 用 Node 自带 zlib 编码 RGBA 位图为 PNG（8bit / color type 6 / 无交错）。
 * 存在的原因：PDF 内嵌封面取出来的是裸像素数组，主进程不引 sharp/canvas
 * 这类原生模块——一本书一张封面，zlib 压缩 + 手写 40 行封包完全够快。
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace: none

  // 逐行加 filter byte 0（None）再整体 deflate
  const rowSize = width * 4
  const raw = Buffer.alloc((rowSize + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * rowSize, rowSize).copy(
      raw,
      y * (rowSize + 1) + 1,
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * pdfjs 图片对象 -> RGBA Uint8Array。
 * kind: 1 = GRAYSCALE, 2 = RGB, 3 = RGBA（pdfjs 3.x ImageKind）
 */
export function imageToRgba(width: number, height: number, kind: number, data: Uint8Array): Uint8Array {
  const pixels = width * height
  const out = new Uint8Array(pixels * 4)
  if (kind === 3) {
    out.set(data.subarray(0, pixels * 4))
  } else if (kind === 1) {
    for (let i = 0; i < pixels; i++) {
      const v = data[i]
      out[i * 4] = v
      out[i * 4 + 1] = v
      out[i * 4 + 2] = v
      out[i * 4 + 3] = 255
    }
  } else {
    // RGB
    for (let i = 0; i < pixels; i++) {
      out[i * 4] = data[i * 3]
      out[i * 4 + 1] = data[i * 3 + 1]
      out[i * 4 + 2] = data[i * 3 + 2]
      out[i * 4 + 3] = 255
    }
  }
  return out
}
