import { writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export async function atomicWrite(file, data) {
  const temporary = `${file}.${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}
