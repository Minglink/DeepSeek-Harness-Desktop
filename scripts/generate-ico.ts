import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const pngPath = path.join(rootDir, 'resources', 'icon.png')
const icoPath = path.join(rootDir, 'resources', 'icon.ico')

async function main() {
  const pngBuffer = fs.readFileSync(pngPath)

  // We can package the PNG buffer directly into an ICO header.
  // Standard Windows Vista+ ICO format supports embedded PNG images.
  // We'll write an ICO containing the 256x256 PNG data.
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // Reserved
  header.writeUInt16LE(1, 2) // Type 1 = Icon
  header.writeUInt16LE(1, 4) // 1 image

  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // Width (0 = 256px)
  entry.writeUInt8(0, 1) // Height (0 = 256px)
  entry.writeUInt8(0, 2) // Colors (0 = no palette)
  entry.writeUInt8(0, 3) // Reserved
  entry.writeUInt16LE(1, 4) // Color planes
  entry.writeUInt16LE(32, 6) // Bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8) // Size of image data
  entry.writeUInt32LE(6 + 16, 12) // Offset of image data from start of file (22 bytes)

  const icoBuffer = Buffer.concat([header, entry, pngBuffer])
  fs.writeFileSync(icoPath, icoBuffer)
  console.log(`Generated ${icoPath} (${icoBuffer.length} bytes)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
