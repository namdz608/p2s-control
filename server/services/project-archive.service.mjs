import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from '../errors/app-error.mjs';

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

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
