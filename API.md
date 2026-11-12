# API Printroom v1

Base URL: `/api/v1`. Các phản hồi JSON giữ định dạng hiện có; camera trả JPEG hoặc MJPEG. Web dùng API v1. API cũ được duy trì qua lớp route tương thích.

## Xác thực và quy ước

- Đăng nhập nhận cookie `p2s_session`, HttpOnly, SameSite=Strict, thời hạn 12 giờ. Browser gửi cookie cùng origin; API không dùng Access Code máy in làm mật khẩu web.
- Mọi thao tác ghi (`POST`, `PUT`, `DELETE`) phải có `Origin` trùng origin của web. Khi reverse proxy đổi Host, cấu hình `PUBLIC_ORIGIN` theo README.
- JSON dùng `Content-Type: application/json`, tối đa 32 KB. Upload dùng `multipart/form-data`, đúng một trường tệp `file`.
- Ngoại trừ health và các thao tác auth, endpoint yêu cầu phiên đăng nhập. Mọi phản hồi API có `Cache-Control: no-store`.
- Response lỗi: `{ "error": "Thông báo lỗi" }`. Access Code và chứng chỉ đầy đủ không xuất hiện trong response.

## Các nhóm endpoint

| Nhóm | Method | Đường dẫn | Kết quả thành công |
| --- | --- | --- | --- |
| Hệ thống | GET | `/api/v1/health` | `200 { "ok": true }`, không cần đăng nhập |
| Auth | GET | `/api/v1/auth/session` | `200 { "authenticated": boolean }` |
| Auth | POST | `/api/v1/auth/login` | `200 { "ok": true }` và cookie phiên |
| Auth | POST | `/api/v1/auth/logout` | `200 { "ok": true }`, hủy cookie/phiên nếu có |
| Máy in | GET | `/api/v1/printer` | `200 { "printer": ..., "settings": ..., "events": [...], "queue": ..., "health": ... }` |
| Máy in | GET | `/api/v1/printer/config` | `200`, cấu hình công khai không chứa Access Code |
| Máy in | PUT | `/api/v1/printer/config` | `200`, cấu hình sau khi lưu và khởi tạo kết nối |
| Máy in | POST | `/api/v1/printer/reconnect` | `200 { "ok": true }`, yêu cầu kết nối lại |
| Máy in | POST | `/api/v1/printer/commands` | `202 { "ok": true, "message": "..." }` |
| Máy in | POST | `/api/v1/printer/diagnostics` | `200`, kết quả kiểm tra và `lastCheck` |
| Tệp in | GET | `/api/v1/projects` | `200`, mảng metadata tệp lưu trên server |
| Tệp in | POST | `/api/v1/projects` | `201`, metadata tệp `.gcode.3mf` đã kiểm tra |
| Thư mục | GET | `/api/v1/projects/folders` | `200`, mảng `{ id, name }` |
| Thư mục | POST | `/api/v1/projects/folders` | `201`, thư mục mới `{ id, name }` |
| Tệp in | PATCH | `/api/v1/projects/:id/folder` | `200`, metadata sau khi chuyển thư mục |
| Tệp in | DELETE | `/api/v1/projects/:id` | `200 { "ok": true, "usb": "removed" \| "absent" \| "unconfigured" \| "skipped" }`, xóa thư viện và gỡ `/{id}.gcode.3mf` trên USB nếu có |
| Tệp in | POST | `/api/v1/projects/:id/start` | `202 { "ok": true, "message": "..." }` |
| Hàng đợi | GET | `/api/v1/projects/queue` | `200`, trạng thái và danh sách lượt in |
| Hàng đợi | POST | `/api/v1/projects/queue/start` | `202`, hàng đợi đã được kiểm tra và nhận |
| Hàng đợi | POST | `/api/v1/projects/queue/cancel` | `200`, trạng thái sau khi hủy |
| Camera | GET | `/api/v1/camera/snapshot` | `200 image/jpeg` |
| Camera | GET | `/api/v1/camera/stream` | `200 multipart/x-mixed-replace`, MJPEG liên tục |
| Timelapse | GET | `/api/v1/timelapses` | `200`, thiết lập, bản ghi hiện tại và thư viện |
| Timelapse | PUT | `/api/v1/timelapses/settings` | `200`, thiết lập sau khi lưu |
| Timelapse | POST | `/api/v1/timelapses/start` | `201`, bản ghi sau khi chụp ảnh đầu tiên |
| Timelapse | POST | `/api/v1/timelapses/:id/stop` | `202`, dừng ghi và bắt đầu ghép MP4 |
| Timelapse | POST | `/api/v1/timelapses/:id/render` | `202`, ghép lại bản ghi bị lỗi/gián đoạn |
| Timelapse | GET | `/api/v1/timelapses/:id/video` | `200/206 video/mp4`, hỗ trợ Range để tua video |
| Timelapse | DELETE | `/api/v1/timelapses/:id` | `200 { "ok": true }`, xóa bản ghi và các tệp |

`202` xác nhận server đã gửi yêu cầu, không xác nhận máy in đã thực hiện. Đọc tiếp `/api/v1/printer` để theo dõi trạng thái thật.

## Payload

### Đăng nhập

`POST /api/v1/auth/login`

```json
{ "password": "<mat-khau-web-da-thiet-lap>" }
```

### Cấu hình máy in

`PUT /api/v1/printer/config`

```json
{
  "name": "P2S Combo",
  "host": "192.168.1.25",
  "serial": "<serial-may-in>",
  "accessCode": "<8-ky-tu>"
}
```

Host phải là IPv4 LAN hoặc VPN hợp lệ; serial gồm 8–32 chữ/số. Để trống `accessCode` chỉ được giữ mã cũ khi host và serial không thay đổi. Kết nối dùng MQTT ghim chứng chỉ ở lần đầu; cấu hình lưu trong volume hiện có, không có bước đổi định dạng dữ liệu khi nâng cấp MVC.

Response gồm `configured`, `name`, `host`, `serial`, `hasAccessCode` và `fingerprint` nếu đã ghim. Kết nối MQTT có thể vẫn đang chờ thiết bị sau khi HTTP trả về.

### Gửi lệnh

`POST /api/v1/printer/commands`

| `type` | Trường bổ sung | Điều kiện |
| --- | --- | --- |
| `pause` | Không | Máy đang `RUNNING` |
| `resume` | Không | Máy đang `PAUSE` |
| `stop` | `confirmed: true` | Máy có tác vụ đang chạy/chuẩn bị/tạm dừng |
| `light` | `value: boolean` | Có kết nối và dữ liệu mới |
| `speed` | `value: 1..4`, số nguyên | Có tác vụ in; 1 êm ái, 2 tiêu chuẩn, 3 thể thao, 4 tối đa |
| `nozzle` | `value: 0..300`, số nguyên; `confirmed: true` nếu >0 | Nhiệt độ °C; 0 tắt gia nhiệt |
| `bed` | `value: 0..110`, số nguyên; `confirmed: true` nếu >0 | Nhiệt độ °C; 0 tắt gia nhiệt |
| `calibration` | `confirmed: true`, `options: { bedLeveling?: boolean, vibration?: boolean, motorNoise?: boolean }` | Ít nhất một mục bật; máy rảnh; trạng thái/HMS/lỗi mới; không có lỗi nghiêm trọng, hàng đợi hay tác vụ đang gửi |

```json
{ "type": "light", "value": true }
```

Mọi lệnh bị chặn khi mất kết nối, dữ liệu quá cũ, đang đổi cấu hình hoặc đang gửi tác vụ in. Không có endpoint gửi G-code tùy ý.

### Báo lỗi, kiểm tra và hiệu chuẩn

`GET /api/v1/printer` trả thêm `health`: `status` (`ok`, `warning`, `error`, `unknown`), `lastReport`, `checks`, `faults`, `lastCheck`. Mỗi lỗi có `kind`, `code`, `severity`, `title`, `description`, `url`. Mã in là 8 ký tự hex; HMS là 16 ký tự (`attr` + `code`). Mô tả lấy từ `e.bambulab.com` bằng mã lỗi, không gửi IP/serial/Access Code. App giới hạn thời gian tra cứu, cache kết quả và vẫn giữ mã gốc khi mất Internet.

`POST /api/v1/printer/diagnostics` nhận `{}`. Nếu chưa kết nối, app thử kết nối lại theo khóa tác vụ hiện có; nếu đang kết nối thì không ngắt MQTT. Server yêu cầu `pushall`, đợi tối đa 10 giây để nhận các trường trạng thái, lỗi in và HMS mới (có thể qua nhiều delta). Một ACK hoặc cập nhật nhiệt độ đơn lẻ không đủ xác nhận kiểm tra. Response luôn mô tả kết quả: `lastCheck: { at, received, message }`; lỗi kết nối/thiếu phản hồi được biểu diễn bằng `received: false`, không đồng nghĩa HTTP 200 là máy khỏe. Không phát lệnh gia nhiệt, chuyển động hoặc bắt đầu in trong bước này.

Ví dụ hiệu chuẩn:

```json
{ "type": "calibration", "confirmed": true, "options": { "bedLeveling": true, "vibration": true, "motorNoise": false } }
```

Payload MQTT dùng `print.command: calibration`; các bit lựa chọn theo Bambu Studio: cân bàn `2`, bù rung `4`, giảm ồn động cơ `8`. Không hỗ trợ tự truyền bit/G-code tùy ý. Chưa xác minh hiệu chuẩn trên máy P2S thật của bố.

`printer.maintenance` có `status`, `active`, `message`, `sequence` khi đã gửi, và các mốc thời gian. Trạng thái: `idle`, `awaiting_start`, `running`, `completed`, `failed`, `uncertain`, `interrupted`. ACK không xác nhận bắt đầu/kết thúc; app đợi tác vụ có `gcode_file` chứa `auto_cali_for_user` cùng trạng thái đang chạy. Sau khi quan sát chạy, trạng thái `FINISH`/`IDLE` mới kết thúc theo dõi. Quá 60 giây chưa bắt đầu hoặc gửi quá hạn/mất kết nối chuyển sang `uncertain`; giữ khóa in và yêu cầu kiểm tra máy. Tự kết nối lại có thể tiếp tục xác nhận tác vụ đã quan sát chạy. Kết nối lại thủ công xóa phiên theo dõi và yêu cầu dữ liệu máy mới trước lệnh tiếp theo; server khởi động lại không tự chạy lại hiệu chuẩn.

Khi hiệu chuẩn đang hoạt động, in riêng/hàng đợi/đổi cấu hình và các điều khiển khác bị chặn; vẫn cho đổi đèn và dừng tác vụ có xác nhận khi máy cung cấp trạng thái cho phép dừng.

### Thư viện và bắt đầu in

`POST /api/v1/projects`: form-data `file` là `.gcode.3mf` đã slice, tối đa 200 MB; trường `folderId` tùy chọn chỉ thư mục đích, bỏ qua hoặc để rỗng để lưu ở thư viện gốc. Server đọc ZIP/XML, yêu cầu có plate G-code và metadata. Response có `id`, `name`, `size`, `addedAt`, `plates`, `folderId` (`null` ở thư viện gốc). Tệp cũ chưa có `folderId` được coi là nằm ở gốc. Mỗi plate có `number`, `filamentCount`, `filaments`, `seconds`.

`GET /api/v1/projects/folders` trả danh sách thư mục một cấp, sắp xếp theo tên. `POST /api/v1/projects/folders` nhận `{ "name": "Batman" }`; tên có 1–80 ký tự sau khi bỏ khoảng trắng hai đầu, không chứa dấu `/`, `\`, ký tự điều khiển hoặc chỉ là `.`/`..`. Tên trùng không phân biệt hoa/thường trả `409`; dữ liệu sai trả `400`.

`PATCH /api/v1/projects/:id/folder` nhận `{ "folderId": "<id-thu-muc>" }` hoặc `{ "folderId": null }` để chuyển về gốc. Thư mục hoặc tệp không tồn tại trả `404`. Chuyển thư mục giữ nguyên ID, metadata in và nội dung tệp. Cả tạo thư mục, chuyển tệp và upload đều yêu cầu đăng nhập và kiểm tra cùng origin. Danh sách thư mục nằm trong `project-folders/` của volume dữ liệu; phân loại nằm trong metadata mỗi tệp, được giữ qua khởi động lại. Hàng đợi in tất cả vẫn lấy toàn bộ thư viện, gồm các thư mục.

`POST /api/v1/projects/:id/start`

```json
{
  "plate": 8,
  "useAms": true,
  "mappingMode": "manual",
  "mapping": [-1, -1, -1, 0],
  "confirmed": true
}
```

- `plate` lấy từ metadata, không mặc định luôn là plate 1.
- Với AMS, `mapping` phải dài bằng `filamentCount` của dự án. Vị trí không dùng là `-1`; giá trị khay là `ams_id * 4 + slot_id`. Vật liệu khay phải khớp loại filament được slice.
- `mappingMode: "manual"` dùng đúng khay đã chọn, không khóa theo hậu tố tên tệp hoặc màu metadata. Khay có trong dữ liệu AMS nhưng chưa khai báo loại nhựa vẫn được chọn thủ công; giao diện nhắc kiểm tra cuộn đã nạp đúng loại nhựa đã slice. Nếu máy có khai báo loại nhựa, loại đó vẫn phải khớp. `"auto"` hoặc bỏ trường này yêu cầu khay đã khai báo vật liệu và giữ kiểm tra màu trước khi gửi. Khay không có trong dữ liệu AMS luôn bị từ chối. Hàng đợi tiếp tục chọn khay tự động.
- Với cuộn ngoài, `useAms: false`; chỉ chấp nhận plate một vật liệu.
- `confirmed: true` xác nhận tệp đã slice đúng P2S/đầu phun/vật liệu và bàn in sẵn sàng.
- Máy phải có dữ liệu mới, đang rảnh, không báo lỗi in và xác nhận có thẻ nhớ. Tệp được gửi qua FTPS trước khi phát lệnh MQTT. Khóa gửi trùng được giữ trong lúc chờ phản hồi/trạng thái mới; nếu hết 60 giây sẽ có thông báo cần kiểm tra máy trước khi thử lại.

### In tất cả theo hàng đợi

`POST /api/v1/projects/queue/start` với `{ "confirmed": true }` xác nhận bắt đầu toàn bộ thư viện trên máy có cơ chế tự dọn bàn. Server kiểm tra toàn bộ tệp/vật liệu trước khi gửi lượt đầu, xếp tên tệp theo số rồi theo số plate. Với plate một filament, hậu tố `AMS1` tương ứng khay 0, `AMS2` tương ứng khay 1…; nếu không có hậu tố, chỉ dùng khay khớp loại/màu duy nhất. Không xác định được khay sẽ trả lỗi trước khi gửi bất kỳ tệp nào.

Response và `GET /api/v1/projects/queue` gồm `status`, `active`, `message`, `current` (chỉ số lượt, từ 0), `completed`, `items`. Mỗi item có `id`, `name`, `plate`, `status`, `mapping`. Trạng thái hàng đợi: `idle`, `preparing`, `submitting`, `awaiting_start`, `printing`, `completed`, `failed`, `cancelled`. `/api/v1/printer` cũng trả `queue` để giao diện đồng bộ cùng trạng thái máy.

Server chỉ chuyển lượt sau khi đã quan sát đúng tác vụ đang in rồi nhận `FINISH`; trạng thái `FINISH`/`FAILED` của lượt cũ không được tính cho lượt mới. Máy tạm dừng thì hàng đợi chờ; mất dữ liệu mới không gửi thêm lượt; lỗi, tác vụ khác hoặc quá thời hạn xác nhận thì dừng hàng đợi. Đóng trình duyệt không ngắt hàng đợi; khởi động lại server hủy tiến trình, không tự tiếp tục hoặc in lại.

`POST /api/v1/projects/queue/cancel` với `{}` hủy các lượt còn lại và chặn phát lệnh nếu còn đang upload. Tác vụ đã bắt đầu vẫn in; lệnh `stop` có xác nhận hủy cả hàng đợi và gửi dừng tác vụ. Khi hàng đợi hoạt động, server chặn in riêng, xóa tệp và đổi/kết nối lại cấu hình.

## HTTP lỗi

### Timelapse

Tất cả endpoint timelapse yêu cầu đăng nhập, kể cả xem/tải video; thao tác ghi yêu cầu Origin cùng web. Thêm `?download=1` vào URL video để nhận attachment MP4. ID là 32 ký tự hex; server không nhận đường dẫn tệp của client. Không có URL công khai cho ảnh thô.

`PUT /api/v1/timelapses/settings`:

```json
{ "auto": true, "interval": 10, "fps": 24 }
```

`POST /api/v1/timelapses/start`:

```json
{ "name": "Tượng Batman", "interval": 10, "fps": 24 }
```

`interval`: số nguyên 2–300 giây; `fps`: số nguyên 1–60. `name` tùy chọn, loại ký tự điều khiển và giới hạn 100 ký tự; tên không dùng làm đường dẫn. Bắt đầu thủ công độc lập với cờ `auto`. Cài đặt thời gian mới chỉ áp dụng cho bản ghi tiếp theo. Tắt auto sẽ kết thúc bản ghi tự động hiện tại, không dừng bản ghi thủ công.

Response thư viện gồm `settings`, `busy`, `active`, `clips`, `usedBytes`, `limits`, `autoError`. Mỗi clip có `id`, `name`, `mode` (`manual`/`auto`), `interval`, `fps`, `frames`, `duration` (giây video = frames/fps), `frameBytes`, `size`, `missedFrames`, `startedAt`, các mốc chụp/dừng nếu có, `status`, `message`, `lastError` nếu có. `printer` API cũng trả `timelapse` để cập nhật giao diện qua polling hiện có. `status`: `recording`, `stopping`, `rendering`, `ready`, `failed`, `interrupted`; chỉ `ready` mới xem/tải được. `202` nhận yêu cầu ghép, không có nghĩa video đã sẵn sàng; đọc lại trạng thái.

Một server chỉ ghi hoặc ghép một bản tại một thời điểm. Dừng ghi đợi ảnh đang chụp kết thúc trước khi ghép; cần ít nhất hai ảnh. Khi server ngừng, bản ghi chưa xong được đánh dấu gián đoạn, giữ ảnh và cho ghép lại. Không tự xóa video cũ. Giới hạn: 10.000 ảnh/1 GB ảnh/24 giờ mỗi bản, tổng 5 GB và 100 bản ghi; kiểm tra đĩa còn tối thiểu 128 MB và chừa dung lượng cho encode. Dung lượng tổng tính cả ảnh chưa ghép. MP4 thành công thì xóa ảnh nguồn để tiết kiệm đĩa.

Tự ghi theo telemetry mới của bản in, bỏ qua hiệu chuẩn; giữ ghi khi tạm dừng hoặc telemetry cũ, kết thúc khi có trạng thái mới xác nhận hoàn thành/lỗi/đổi tác vụ. Các lượt hàng đợi phân biệt theo chỉ số lượt. Bấm dừng chủ động ngăn tự ghi lại ngay cùng bản in. Camera không sẵn sàng lúc tự ghi thì báo `autoError` và không liên tục tạo bản lỗi; có thể bắt đầu thủ công sau khi xử lý camera. Timelapse không phát lệnh chuyển động, bắt đầu/dừng in hay sửa thiết lập in trên máy.

### Mã trạng thái

| Mã | Ý nghĩa |
| --- | --- |
| 400 | Payload, xác nhận hoặc metadata không hợp lệ |
| 401 | Sai mật khẩu hoặc chưa đăng nhập/phiên hết hạn |
| 403 | Origin không khớp |
| 404 | Không có endpoint/tệp |
| 409 | Máy chưa sẵn sàng, đang bận hoặc thao tác xung đột |
| 413 | Upload vượt 200 MB |
| 429 | Quá số lần đăng nhập sai hoặc quá 3 lượt xem camera |
| 500 | Lỗi nội bộ, thông báo đã được làm gọn |
| 502/503 | Dịch vụ camera hoặc kết nối chuyển tệp chưa sẵn sàng |
| 504 | Quá thời gian gửi lệnh |

## Tương thích API cũ

| API cũ | API v1 |
| --- | --- |
| `GET /api/health` | `GET /api/v1/health` |
| `/api/auth/*` | `/api/v1/auth/*`, cùng method |
| `GET /api/state` | `GET /api/v1/printer` |
| `GET /api/config` | `GET /api/v1/printer/config` |
| `POST /api/config` | `PUT /api/v1/printer/config` |
| `POST /api/reconnect` | `POST /api/v1/printer/reconnect` |
| `POST /api/commands` | `POST /api/v1/printer/commands` |
| `/api/projects/*` | `/api/v1/projects/*`, cùng method |
| `/api/camera/*` | `/api/v1/camera/*`, cùng method |

Các URL tương thích dùng chung controller, middleware và service với v1, không sao chép nghiệp vụ.
