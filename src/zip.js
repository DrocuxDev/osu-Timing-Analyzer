import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Generador nativo de archivos ZIP / OSZ en memoria (sin dependencias externas).
 * Compatible con la especificacion ZIP standard y descompresion nativa de osu! (.NET / SharpZipLib).
 */
export function createZipArchive(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Se requiere al menos un archivo para crear el paquete ZIP/OSZ.');
  }

  const localEntries = [];
  const centralEntries = [];
  let offset = 0;

  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name.trim()) {
      throw new Error('Cada entrada del archivo ZIP debe tener un nombre válido.');
    }
    const safeFileName = path.basename(file.name.replace(/\\/g, '/'));
    const nameBuf = Buffer.from(safeFileName, 'utf8');
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8');
    const uncompressedSize = rawData.length;
    if (uncompressedSize > 0xffffffff) {
      throw new RangeError(`El archivo '${safeFileName}' excede el límite de 4GB del formato ZIP estándar.`);
    }
    const crc = zlib.crc32(rawData);

    // Comprimir con DEFLATE; si es un archivo de audio ya comprimido (como MP3/OGG) y no reduce tamano,
    // usamos STORE (metodo 0) para maxima velocidad y eficiencia.
    let compressedData = zlib.deflateRawSync(rawData);
    let method = 8;
    if (compressedData.length >= uncompressedSize) {
      compressedData = rawData;
      method = 0;
    }
    const compressedSize = compressedData.length;

    // Local file header (30 bytes + nombre)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // Bit 11 = UTF-8 filename
    localHeader.writeUInt16LE(method, 8);     // Compression method (0 = store, 8 = deflate)
    localHeader.writeUInt16LE(dosTime, 10);   // File mod time
    localHeader.writeUInt16LE(dosDate, 12);   // File mod date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);   // Filename length
    localHeader.writeUInt16LE(0, 28);                // Extra field length
    nameBuf.copy(localHeader, 30);

    localEntries.push(localHeader, compressedData);

    // Central directory header (46 bytes + nombre)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8);     // Bit 11 = UTF-8 filename
    centralHeader.writeUInt16LE(method, 10);    // Compression method
    centralHeader.writeUInt16LE(dosTime, 12);   // Mod time
    centralHeader.writeUInt16LE(dosDate, 14);   // Mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);   // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);   // Filename length
    centralHeader.writeUInt16LE(0, 30);                // Extra field length
    centralHeader.writeUInt16LE(0, 32);                // Comment length
    centralHeader.writeUInt16LE(0, 34);                // Disk number start
    centralHeader.writeUInt16LE(0, 36);                // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);                // External file attributes
    centralHeader.writeUInt32LE(offset, 42);           // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralEntries.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralEntries) {
    centralDirSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Disk number
  eocd.writeUInt16LE(0, 6);          // Start disk
  eocd.writeUInt16LE(files.length, 8);  // Entries on disk
  eocd.writeUInt16LE(files.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);    // Central directory size
  eocd.writeUInt32LE(centralDirOffset, 16);  // Central directory offset
  eocd.writeUInt16LE(0, 20);                 // Comment length

  return Buffer.concat([...localEntries, ...centralEntries, eocd]);
}
