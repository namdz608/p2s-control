import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from '../errors/app-error.mjs';

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const previewLimit = 2 * 1024 * 1024;

function previewRank(name) {
  const plate = /^Metadata\/plate_([1-9]\d{0,2})\.png$/i.exec(name);
  if (plate) return [0, Number(plate[1])];
  const top = /^Metadata\/top_([1-9]\d{0,2})\.png$/i.exec(name);
  if (top) return [1, Number(top[1])];
  const small = /^Metadata\/plate_([1-9]\d{0,2})_small\.png$/i.exec(name);
  if (small) return [2, Number(small[1])];
  const pick = /^Metadata\/pick_([1-9]\d{0,2})\.png$/i.exec(name);
  if (pick) return [3, Number(pick[1])];
  if (/^Metadata\/thumbnail\.png$/i.test(name)) return [4, 0];
  return null;
}

function imageType(body) {
  if (body.length > 8 && body[0] === 0x89 && body.toString('ascii', 1, 4) === 'PNG')
    return 'image/png';
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return 'image/jpeg';
  return '';
}

export function readPlatePreview(file) {
  return new Promise((resolve) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return resolve(null);
      const found = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(value);
      };
      zip.on('error', () => finish(null));
      zip.on('entry', (entry) => {
        const rank = previewRank(entry.fileName);
        if (!rank || entry.uncompressedSize <= 0 || entry.uncompressedSize > previewLimit)
          return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return zip.readEntry();
          const chunks = [];
          let size = 0;
          let advanced = false;
          const next = () => {
            if (advanced) return;
            advanced = true;
            zip.readEntry();
          };
          stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > previewLimit) {
              next();
              stream.destroy();
            } else chunks.push(chunk);
          });
          stream.on('error', next);
          stream.on('end', () => {
            if (advanced) return;
            const body = Buffer.concat(chunks);
            const type = imageType(body);
            if (type) found.push({ rank, body, type });
            next();
          });
        });
      });
      zip.on('end', () => {
        found.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
        finish(found[0] ? { body: found[0].body, type: found[0].type } : null);
      });
      zip.readEntry();
    });
  });
}

export function inspectArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new AppError('Tệp không phải kho lưu trữ 3MF hợp lệ.'));
      const plateNumbers = [];
      let metadata = '';
      let count = 0;
      let total = 0;
      const fail = (message) => {
        zip.close();
        reject(new AppError(message));
      };
      zip.on('error', () => fail('Không đọc được tệp 3MF.'));
      zip.on('entry', (entry) => {
        count++;
        total += entry.uncompressedSize;
        if (count > 10000 || total > 2 * 1024 ** 3) return fail('Tệp 3MF có quá nhiều dữ liệu.');
        const plate = /^Metadata\/plate_([1-9]\d{0,2})\.gcode$/.exec(entry.fileName);
        if (plate) plateNumbers.push(Number(plate[1]));
        if (entry.fileName !== 'Metadata/slice_info.config') return zip.readEntry();
        if (entry.uncompressedSize > 1024 * 1024) return fail('Metadata của tệp vượt quá 1 MB.');
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail('Không đọc được metadata.');
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              stream.destroy();
              fail('Metadata quá lớn.');
            } else chunks.push(chunk);
          });
          stream.on('error', () => fail('Metadata không hợp lệ.'));
          stream.on('end', () => {
            metadata = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        try {
          if (
            !plateNumbers.length ||
            !metadata ||
            /<!DOCTYPE|<!ENTITY/i.test(metadata) ||
            XMLValidator.validate(metadata) !== true
          )
            throw new AppError(
              'Chọn .gcode.3mf đã slice trong Bambu Studio/OrcaSlicer, không phải mô hình 3MF chưa slice.',
            );
          const parsed = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
            processEntities: false,
          }).parse(metadata);
          const plates = asArray(parsed.config?.plate)
            .map((plate) => {
              const values = Object.fromEntries(
                asArray(plate.metadata).map((item) => [item.key, item.value]),
              );
              const number = Number(values.index);
              if (!plateNumbers.includes(number)) return null;
              const filaments = asArray(plate.filament).map((filament) => ({
                id: Number(filament.id),
                type: String(filament.type ?? '').slice(0, 40),
                color: /^#[a-f0-9]{6}$/i.test(filament.color ?? '') ? filament.color : '#9a9fa4',
                grams: Number(filament.used_g) || null,
              }));
              const count = values.filament_maps
                ? String(values.filament_maps).trim().split(/\s+/).length
                : Math.max(0, ...filaments.map((item) => item.id));
              if (
                count < 1 ||
                count > 64 ||
                filaments.some(
                  (item) => !Number.isInteger(item.id) || item.id < 1 || item.id > count,
                )
              )
                throw new AppError('Bảng vật liệu trong tệp không hợp lệ.');
              return {
                number,
                filamentCount: count,
                filaments,
                seconds: Number(values.prediction) || null,
              };
            })
            .filter(Boolean);
          if (!plates.length) throw new AppError('Không tìm thấy plate in hợp lệ trong tệp.');
          resolve({ plates: plates.sort((a, b) => a.number - b.number) });
        } catch (failure) {
          reject(
            failure instanceof AppError ? failure : new AppError('Không phân tích được tệp in.'),
          );
        }
      });
      zip.readEntry();
    });
  });
}
