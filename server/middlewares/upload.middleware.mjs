import multer from 'multer';
import path from 'node:path';
import { AppError } from '../errors/app-error.mjs';

export function projectUpload(directory) {
  return multer({
    dest: path.join(directory, 'uploads'),
    limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 1, fieldSize: 128 },
    fileFilter: (_req, file, done) =>
      done(
        file.originalname.toLowerCase().endsWith('.gcode.3mf')
          ? null
          : new AppError('Chọn tệp .gcode.3mf đã slice cho P2S.'),
        true,
      ),
  }).single('file');
}
