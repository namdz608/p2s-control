# Printroom · P2S Control

Webapp tiếng Việt để theo dõi và điều khiển Bambu Lab P2S Combo, tự host trên Ubuntu bằng Docker Compose. Một URL dùng trên điện thoại, tablet và máy tính.

## Cấu trúc MVC và API

```text
server/
  index.mjs                  # Khởi động HTTP, xử lý shutdown
  bootstrap.mjs              # Khởi tạo model và các kết nối runtime
  app.mjs                    # Ghép middleware, controller và router
  routes/
    api/v1/                  # Route theo nhóm auth, printer, projects, camera
    legacy-api.routes.mjs    # Tương thích URL API cũ
    web.routes.mjs           # Route trang web
  controllers/               # Đọc request, trả JSON hoặc luồng camera
  models/                    # Cấu hình mã hóa, session, trạng thái và thư viện tệp
  services/                  # Nghiệp vụ, MQTT, FTPS, camera, đọc 3MF
  middlewares/               # Xác thực, Origin, upload, headers và lỗi tập trung
  validators/                # Kiểm tra dữ liệu cấu hình
  views/                     # HTML giao diện
  errors/                    # Lỗi ứng dụng
  utils/                     # Ghi tệp atomically
public/                      # JavaScript, CSS, SVG của view
test/                        # Kiểm thử nghiệp vụ và hợp đồng HTTP
scripts/                     # Kiểm tra cú pháp toàn bộ mã JavaScript
```

Luồng xử lý: middleware → route → controller → service → model hoặc máy in. Model và service không nhận `req`/`res` của Express. Controller xử lý HTTP; route chỉ khai báo URL, method và middleware.

API chính dùng **`/api/v1`**, chia thành `/auth`, `/printer`, `/projects`, `/camera`; xem toàn bộ method, payload, response và mã lỗi trong [API.md](API.md). Frontend và Docker healthcheck đã dùng v1. URL cũ vẫn tương thích, dữ liệu Docker volume giữ nguyên định dạng.

## Chạy trên Ubuntu

Cần Docker Engine và Docker Compose plugin. Đặt thư mục này trên máy Ubuntu rồi chạy:

```bash
cd p2s-control
chmod +x start.sh
./start.sh
```

Script hỏi mật khẩu đăng nhập (nhập ẩn, tối thiểu 8 ký tự), lưu vào `.env` quyền `600` và chạy hai container. Mở **http://IP_UBUNTU:3080** và đăng nhập. Những lần sau chỉ cần:

```bash
docker compose up -d
```

Chọn **Kết nối máy in**, nhập IP nội bộ, serial và Access Code 8 ký tự từ máy in. Trên P2S bật **Settings → LAN Only → LAN Only + Developer Mode**, bật thêm **LAN Only Liveview** để xem camera. LAN Only ngắt Bambu Cloud/Bambu Handy. [Hướng dẫn chính thức của Bambu Lab](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode).

Ubuntu phải truy cập được IP máy in. Máy Ubuntu trong cùng LAN dùng trực tiếp; một VPS ngoài Internet cần VPN/định tuyến về LAN máy in. Không cần cài Node.js lên Ubuntu.

## Những gì đã triển khai

- Đăng nhập bằng mật khẩu; phiên đăng nhập 12 giờ, cookie HttpOnly, chống yêu cầu khác origin, giới hạn đăng nhập sai.
- Trạng thái tự cập nhật mỗi 3 giây: tác vụ, lớp in, tiến độ, thời gian còn lại, nhiệt đầu phun/bàn/buồng in, trạng thái thẻ nhớ.
- Tạm dừng, tiếp tục, dừng in; đổi tốc độ, bật/tắt đèn; đặt nhiệt đầu phun 0–300°C và bàn in 0–110°C. Lệnh dừng và gia nhiệt cần xác nhận.
- Đọc nhiều hộp AMS: khay, loại vật liệu, màu, lượng còn lại nếu máy cung cấp, độ ẩm thực và nhiệt độ.
- Camera RTSPS của P2S qua go2rtc, chuyển sang MJPEG 960×540/5 fps để trình duyệt xem trực tiếp. Giới hạn 3 lượt xem cùng lúc. Chỉ cổng web được publish ra host; dịch vụ camera ở mạng Docker nội bộ.
- Trang **Timelapse** có ghi thủ công, tự ghi theo từng bản in, xem và tải MP4, xóa bản ghi và ghép lại sau gián đoạn. Mặc định chụp mỗi 10 giây, xuất MP4 H.264 24 fps; thay đổi khoảng chụp 2–300 giây và video 1–60 fps qua API (giao diện có 12/24/30/60 fps). Bấm **Lưu thiết lập** sau khi bật tự ghi. Thiết lập lưu trên server; đóng trình duyệt hoặc tắt xem camera không dừng ghi.
- Thư viện `.gcode.3mf` tối đa 200 MB/tệp: đọc plate và vật liệu từ ZIP/XML, chọn plate, ánh xạ vật liệu AMS, gửi tệp tới thẻ nhớ qua FTPS rồi yêu cầu bắt đầu in. File STL hoặc 3MF chưa slice không được chấp nhận.
- Nút **In tất cả** tạo hàng đợi chạy ở server, xếp tên tệp theo số (01 → 02 → 03…), in các plate theo thứ tự và chỉ chuyển lượt sau khi máy xác nhận đúng tác vụ đã hoàn thành. Đóng trình duyệt không ngắt hàng đợi. Chế độ này dùng cho máy có cơ chế tự dọn bàn giữa các lượt. Hủy hàng đợi bỏ các lượt còn lại; Dừng in dừng tác vụ trên máy và hủy hàng đợi.
- Tự chọn vật liệu theo hậu tố AMS1, AMS2… cho plate một vật liệu; nếu không có hậu tố, chỉ chọn khi loại/màu khớp duy nhất. Kiểm tra toàn bộ tệp trước lượt đầu. Chọn **In riêng** nếu muốn tự ánh xạ khay.
- **In riêng** mặc định **Tự chọn khay A1–A4**: bấm trực tiếp một trong bốn nút A1, A2, A3, A4 cho từng filament; khay đang chọn được tô viền và đánh dấu. Xem màu/loại nhựa và dòng xác nhận khay sẽ dùng. Lựa chọn thủ công được ưu tiên hơn hậu tố AMS trong tên tệp và màu metadata. Khay chưa khai báo vật liệu vẫn chọn được thủ công, kèm nhắc kiểm tra cuộn đã nạp đúng loại nhựa; app không tự xác nhận khay có cuộn. Khay đã khai báo khác loại nhựa không được chọn. Có thể đổi sang **Tự động theo màu** để app gợi ý khay khớp.
- Kiểm tra máy đang rảnh, dữ liệu còn mới, thẻ nhớ và loại vật liệu AMS trước khi gửi; khóa gửi đồng thời. Máy chưa sẵn sàng được giải thích ngay trên trang Tệp in. Hàng đợi dừng khi server khởi động lại; app không tự phát lệnh khi khởi động.
- Nhật ký hoạt động trong bộ nhớ của phiên chạy server. Thư viện tệp và cấu hình giữ lại trong Docker volume.
- Trang **Lỗi & kiểm tra** hiển thị từng mã lỗi in/HMS, mức độ, mô tả kỹ thuật từ Bambu (tiếng Anh khi có Internet) và liên kết hướng dẫn. Khi mất mạng hoặc chưa tra được mã, vẫn giữ mã gốc để kiểm tra trên máy. Cảnh báo không bị tự xóa bởi app.
- **Kiểm tra kết nối & trạng thái** yêu cầu dữ liệu mới qua MQTT, kiểm tra cấu hình, lỗi/HMS, thẻ nhớ, tác vụ và giá trị cảm biến nhiệt. Khi máy ngoại tuyến, app thử kết nối lại nếu không có tác vụ đang giữ kết nối. Kiểm tra chỉ đọc dữ liệu, không gia nhiệt hay di chuyển máy. Một cập nhật nhiệt độ không đủ làm mới trạng thái/lỗi đã cũ.
- **Tự kiểm tra / hiệu chuẩn trên máy** cho chọn cân bàn, bù rung và giảm ồn động cơ; cần xác nhận bàn in/vùng chuyển động đã sẵn sàng. Chỉ cho chạy khi máy rảnh, có dữ liệu trạng thái/lỗi mới và không có lỗi nghiêm trọng hoặc hàng đợi. Khóa in trong lúc chờ/chạy hiệu chuẩn. App chỉ báo bắt đầu/kết thúc sau khi quan sát telemetry hiệu chuẩn; phản hồi lệnh thành công không tự được tính là hoàn tất. Nếu không xác nhận được, kiểm tra trực tiếp P2S rồi kết nối lại trước khi thử tiếp.

**Giới hạn xác minh:** Chưa thử với máy in thật của bố. Giao thức điều khiển trực tiếp không được Bambu cam kết ổn định giữa các firmware. API trả “đã gửi yêu cầu” sau khi gửi MQTT, không tự nhận là máy đã thực hiện lệnh. Lần in đầu cần theo dõi trực tiếp và xác nhận file đã slice đúng P2S, kích thước đầu phun, bàn in và vật liệu. App không tự slice mô hình, không điều khiển chuyển động trục, không gửi G-code tùy ý và chưa điều khiển sấy AMS.

## Dùng trong LAN và từ xa

Trong LAN, truy cập `http://IP_UBUNTU:3080`. Để truy cập từ xa, cài Tailscale trên Ubuntu và điện thoại/máy tính theo [hướng dẫn Tailscale cho Linux](https://tailscale.com/download/linux), đăng nhập cùng tailnet, rồi chạy trên Ubuntu:

```bash
sudo tailscale serve --bg http://127.0.0.1:3080
```

Tailscale in ra URL HTTPS riêng của Ubuntu. Mở URL đó khi thiết bị đang kết nối tailnet. [Tài liệu Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve). Không cần port-forward máy in. Nếu chỉ dùng URL HTTPS, đổi `SECURE_COOKIES=true` trong `.env`, sau đó:

```bash
docker compose up -d
```

Với domain và reverse proxy HTTPS riêng, proxy về `http://127.0.0.1:3080`, giữ nguyên header Host, bật `SECURE_COOKIES=true`. Nếu proxy thay Host, đặt `PUBLIC_ORIGIN=https://ten-mien-cua-bo` trong `.env`. Tắt buffering cho `/api/v1/camera/stream` nếu dùng Nginx (đường dẫn cũ `/api/camera/stream` vẫn hoạt động). Có thể đặt `BIND_ADDRESS=127.0.0.1` nếu chỉ truy cập qua reverse proxy/Tailscale Serve; để `0.0.0.0` cho truy cập LAN trực tiếp.

## Dữ liệu và vận hành

Timelapse lưu trong `timelapses/` của volume `printer-data`, dùng cùng camera LAN Liveview. Bật **Tự ghi** để app ghi khi nhận trạng thái bản in thực tế; mỗi lượt hàng đợi có video riêng. Tạm dừng in vẫn ghi; mất telemetry không tự kết luận bản in đã kết thúc. Máy hoàn thành, lỗi hoặc đổi tác vụ thì kết thúc bản ghi tự động; dừng timelapse không dừng máy in. Bản ghi thủ công chỉ kết thúc khi bố bấm dừng hoặc đạt giới hạn. App không di chuyển đầu in để lấy góc ảnh, không bật chế độ timelapse native trên máy.

Mỗi bản ghi giới hạn 24 giờ, 10.000 ảnh hoặc 1 GB ảnh; thư viện tối đa 5 GB/100 bản ghi và luôn yêu cầu ít nhất 128 MB đĩa trống (ghép video cần thêm khoảng trống). Khi đạt giới hạn app dừng ghi và ghép ảnh đã có, không tự xóa video cũ. Cần ít nhất 2 ảnh để ghép. Camera lỗi tạm thời được hiển thị, 5 lần chụp lỗi liên tiếp thì dừng. Nếu tự ghi không khởi động được, app báo lỗi và bố có thể sửa camera rồi bắt đầu thủ công hoặc bật/lưu lại tự ghi.

Server khởi động lại giữ video, ảnh và thiết lập; bản ghi chưa xong đánh dấu **Bị gián đoạn**, có nút **Ghép lại**. Nếu tự ghi đang bật và bản in vẫn chạy sau khởi động, app tạo đoạn mới; không ghép nối qua thời gian server ngừng. Ảnh gốc được xóa sau khi MP4 ghép thành công; ảnh của bản ghi lỗi được giữ để thử lại. Đang ghi/ghép thì app chặn đổi cấu hình máy in.

Image Docker đã có FFmpeg/libx264. Nếu chạy trực tiếp bằng Node, cần cài `ffmpeg`/`ffprobe` trên server. Sau khi cập nhật mã nguồn cần build lại image:

```bash
docker compose up -d --build
```

```bash
docker compose ps
docker compose logs --tail=100 web
docker compose down
# Sau khi sửa mã nguồn:
docker compose up -d --build
```

`docker compose down` giữ dữ liệu. `docker compose down -v` xóa toàn bộ cấu hình và thư viện, nên chỉ dùng khi muốn xóa dữ liệu. Sao lưu cả volume `p2s-control_printer-data` và `p2s-control_camera-data`, cùng file `.env`. `master.key` phải đi cùng `printer.json` khi phục hồi.

Access Code mã hóa AES-256-GCM trong `printer.json`; khóa nằm trong cùng volume, không phải bảo vệ khỏi quản trị viên host. Server không trả Access Code về browser và không ghi vào log. MQTT dùng chứng chỉ được ghim ở lần kết nối đầu tiên (TOFU); tự kết nối lại sẽ từ chối chứng chỉ thay đổi. Nếu đã thay máy/cài lại firmware làm thay chứng chỉ, cần xác minh thiết bị và xử lý cấu hình đã lưu thay vì tự bỏ ghim. FTPS chấp nhận chứng chỉ tự ký của máy in, chỉ dùng qua LAN/VPN tin cậy. Cấu hình go2rtc chứa Access Code ở volume camera riêng, quyền file `600`; không chia sẻ volume hoặc file `.env`.

Đổi mật khẩu: xóa dòng `APP_PASSWORD_BASE64` cũ trong `.env` rồi nhập giá trị mới theo cách an toàn, hoặc dừng app, xóa riêng `.env` và chạy `./start.sh` để đặt lại. Không xóa Docker volume. Có thể dùng biến `APP_PASSWORD` thay `APP_PASSWORD_BASE64` nếu quản lý bằng secret của hệ thống triển khai. Base64 chỉ giúp escape ký tự an toàn, không phải mã hóa mật khẩu.

## Sắp xếp thư viện tệp

Trong trang **Tệp in**, bấm **Tạo thư mục** để gom các tệp cùng bộ vào thư mục một cấp. Bấm thư mục để xem tệp; tệp cũ nằm ở **Thư viện gốc**. Kéo thẻ tệp lên thư mục để chuyển, hoặc dùng ô **Chuyển tới thư mục** trên từng tệp khi dùng điện thoại.

Kéo một hoặc nhiều file `.gcode.3mf` từ máy tính vào thẻ thư mục để upload trực tiếp. Khi bấm **Thêm tệp in**, chọn đích trong ô **Upload vào thư mục**; mặc định là thư mục đang mở. Thư mục và vị trí tệp được lưu trên server. **In tất cả** vẫn in toàn bộ thư viện, gồm mọi thư mục.

## Phát triển và kiểm thử

```bash
npm ci
npm test
npm run check
npm run format
npm audit --omit=dev --audit-level=high
```

`npm run check` kiểm tra cú pháp toàn bộ JavaScript và định dạng Prettier; `npm run format` định dạng lại mã. Bộ kiểm thử HTTP kiểm tra cả API v1 và các URL cũ.

Sau khi Docker đã chạy, kiểm thử đường chuyển đổi camera bằng video tổng hợp (không kết nối máy in):

```bash
docker compose exec -T web node --input-type=module < test/camera-smoke.mjs
```

Kết quả mong đợi: HTTP 200, `multipart/x-mixed-replace`, JPEG `960×540`. Báo cáo các kiểm tra đã thực hiện và lỗi đã sửa nằm trong [VERIFICATION.md](VERIFICATION.md).

Kiểm thử MQTT dùng broker TLS cục bộ (cần `openssl`), không phát lệnh đến máy in thật. Kiểm thử còn bao gồm xác thực HTTP, CSRF, mã hóa cấu hình, parser delta P2S, kiểm tra ZIP/XML và ánh xạ AMS. Để chạy không dùng Docker, cung cấp `APP_PASSWORD`, `DATA_DIR`, `CAMERA_CONFIG_DIR` và `CAMERA_URL` phù hợp rồi `npm start`.

Tham khảo giao thức từ [ghi chép thử nghiệm trực tiếp P2S](https://github.com/Kevinlibaba/bambu-p2s-bridge/blob/main/PROTOCOL.md) và API từ [MQTT.js](https://github.com/mqttjs/MQTT.js), [go2rtc](https://github.com/AlexxIT/go2rtc). Máy P2S dùng `device.ctc.info.temp` cho nhiệt buồng; delta được merge đệ quy và thay cả mảng; bảng AMS có độ dài theo toàn dự án, không chỉ số filament của plate.
