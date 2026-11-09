#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Cần cài Docker Engine và Docker Compose trên Ubuntu trước.' >&2
  exit 1
fi
docker compose version >/dev/null
if [[ ! -f .env ]]; then
  printf '%s\n' 'Thiết lập mật khẩu đăng nhập Printroom (ít nhất 8 ký tự).'
  read -r -s -p 'Mật khẩu: ' p2s_password
  printf '\n'
  read -r -s -p 'Nhập lại: ' p2s_password_repeat
  printf '\n'
  if [[ ${#p2s_password} -lt 8 || "$p2s_password" != "$p2s_password_repeat" ]]; then
    printf '%s\n' 'Mật khẩu chưa đủ 8 ký tự hoặc hai lần nhập không khớp.' >&2
    exit 1
  fi
  printf 'APP_PASSWORD_BASE64=' > .env
  printf '%s' "$p2s_password" | base64 -w 0 >> .env
  printf '\nAPP_PORT=3080\nBIND_ADDRESS=0.0.0.0\nSECURE_COOKIES=false\nPUBLIC_ORIGIN=\n' >> .env
  unset p2s_password p2s_password_repeat
fi
chmod 600 .env
docker compose up -d --build
printf '\n%s\n' 'Printroom đã được khởi chạy. Mở http://IP_UBUNTU:3080 trong trình duyệt.' 'Đăng nhập bằng mật khẩu vừa đặt rồi chọn Kết nối máy in.'
