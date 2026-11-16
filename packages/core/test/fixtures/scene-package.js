// PKG offsets are relative to the end of the index, not the file start.
export function packageBytes(entries = [{ name: 'scene.json', content: '{}' }]) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8, 0);
  header.write('PKGV0024', 4);
  header.writeUInt32LE(entries.length, 12);
  const index = [];
  const payload = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.content ?? '');
    const record = Buffer.alloc(4 + name.length + 8);
    record.writeUInt32LE(name.length, 0);
    name.copy(record, 4);
    record.writeUInt32LE(entry.offset ?? offset, 4 + name.length);
    record.writeUInt32LE(entry.length ?? bytes.length, 8 + name.length);
    index.push(record);
    payload.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat([header, ...index, ...payload]);
}
