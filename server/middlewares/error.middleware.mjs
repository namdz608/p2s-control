import { AppError } from '../errors/app-error.mjs';

export function notFound(_req, res) {
  res.status(404).json({ error: 'Không tìm thấy đường dẫn.' });
}

export function errorHandler(error, _req, res, _next) {
  if (res.headersSent) return res.end();
  const status =
    error instanceof AppError
      ? error.status
      : error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500;
  const message =
    error instanceof AppError
      ? error.message
      : error.code === 'LIMIT_FILE_SIZE'
        ? 'Tệp vượt quá giới hạn 200 MB.'
        : status === 400
          ? 'Dữ liệu gửi lên không hợp lệ.'
          : 'Không thực hiện được yêu cầu. Kiểm tra kết nối và thử lại.';
  res.status(status).json({ error: message });
}
