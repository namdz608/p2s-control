# Kết quả xác minh

## Nút In tất cả và hàng đợi tự chuyển tệp — revision 8 (2026-11-08)

### Nguyên nhân nút bị mờ

Giao diện `canPrint()` yêu cầu `sdcard === true` rồi gán `disabled` cho cả nút mở bước chuẩn bị. Máy thật kết nối tốt nhưng báo `sdcard: false`; vì vậy người dùng không thể mở bước chuẩn bị và không có thông báo tại thư viện. Đây là trạng thái được ứng dụng chủ động chặn, không phải exception có stack trace trong log web.

Lệnh chẩn đoán ban đầu trong container web (chỉ đọc, không phát lệnh in):

```bash
kubectl -n p2s-control exec deployment/p2s-control -c web -- node --input-type=module -e 'import {ConfigStore} from "./server/models/printer-config.model.mjs"; import {PrinterService} from "./server/services/printer.service.mjs"; const config=await ConfigStore.open(process.env.DATA_DIR); const printer=new PrinterService(config); await printer.start(); await new Promise(r=>setTimeout(r,4000)); const s=printer.snapshot(); console.log(JSON.stringify({connection:s.connection,fresh:s.fresh,status:s.status,sdcard:s.sdcard,printError:s.printError,jobPending:s.jobPending,rawSdcard:printer.raw.print?.sdcard,printKeys:Object.keys(printer.raw.print||{})})); await printer.close();'
```

Trích kết quả (bỏ danh sách tên trường `printKeys`):

```json
{"connection":"connected","fresh":true,"status":"IDLE","sdcard":false,"printError":0,"jobPending":false,"rawSdcard":false}
```

Không suy đoán do chưa cắm thẻ, thẻ hỏng hay chưa format: dữ liệu chỉ xác nhận máy đang báo chưa nhận thẻ. Authenticated API còn xác nhận chỉ khay AMS2 có loại vật liệu, trong khi bốn tệp tên AMS1–AMS4 yêu cầu bốn khay tương ứng.

### Thay đổi

- Một nút **In tất cả (4 tệp)** tạo hàng đợi trên server, xếp tên theo số 01 → 02 → 03 → 04 và plate theo số. Bố đã xác nhận máy có cơ chế tự dọn bàn nên tự chuyển lượt sau khi hoàn thành.
- Kiểm tra tất cả tệp và khay trước lượt đầu. Với tệp một vật liệu, hậu tố AMS1… xác định khay; trường hợp khác chỉ chọn vật liệu/màu khi khớp duy nhất. Không tự chọn nhầm khay.
- Chờ đúng tác vụ bắt đầu rồi hoàn thành mới gửi lượt tiếp theo. Bỏ qua FINISH/FAILED cũ trong thời gian chờ bắt đầu và chờ tên tác vụ cập nhật sau delta PREPARE. Tạm dừng không chuyển lượt; lỗi/tác vụ khác/không xác nhận thì dừng hàng đợi.
- Hủy lúc upload chặn publish; hủy hàng đợi giữ tác vụ đã bắt đầu. Dừng in hủy các lượt tiếp theo. Khóa in riêng, xóa tệp và thay cấu hình khi đang chạy hàng đợi.
- Đóng trình duyệt vẫn chạy; restart server dừng hàng đợi, không tự phát lại lệnh.
- Nút In riêng mở được bước chuẩn bị kể cả khi máy chưa sẵn sàng, đồng thời hiện lý do và giữ khóa gửi thực tế. Trang Tệp in hiển thị rõ thẻ nhớ chưa được nhận.

### Kiểm thử và triển khai

```bash
cd /root/p2s-control
node --test test/print-queue.test.mjs test/print-ui.test.mjs
npm test
npm run check
node /tmp/p2s-browser/queue-qa.mjs
node /tmp/p2s-browser/queue-live-qa.mjs
helm test p2s-control -n p2s-control --logs --timeout 2m
```

Trước sửa, UI regression thất bại với `AssertionError: print setup must remain clickable so the user can inspect the blocking reason`; HTML thực tế chứa `data-project="a" disabled`. Các test hàng đợi thất bại vì chưa có queue. Sau sửa:

```text
npm test: tests 29, pass 29, fail 0
npm run check: Syntax OK: 49 JavaScript files; All matched files use Prettier code style!
queue-qa.mjs: PASS (auth, Origin, lý do SD, không phát lệnh khi thiếu SD,
  bấm một lần, đóng/mở trình duyệt, 4 lượt đúng thứ tự, hoàn thành, responsive, không lỗi JS)
queue-live-qa.mjs: PASS (HTTPS thật, đăng nhập, In tất cả 4 tệp,
  xếp 01–04, In riêng bấm được, lý do SD, mobile, không lỗi JS); printerCommandsSent=0
helm test: Phase Succeeded; PASS: health, web view and authentication guard
```

Đã build/import image `p2s-control:queue-20261108-v1`, Helm revision **8**, deployment Available 1/1, Pod `p2s-control-65786f8c6b-sq584` 2/2 Running, 0 restarts. Không phát lệnh tới máy thật trong QA. Chưa xác minh chu kỳ in thật hoặc cơ chế tự dọn bàn.

Lệnh đọc lại trạng thái ứng dụng thật sau triển khai (script chỉ đăng nhập nội bộ bằng biến môi trường, không in credential):

```bash
kubectl -n p2s-control exec -i deployment/p2s-control -c web -- node --input-type=module < /tmp/p2s-queue-readiness.mjs
```

```json
{"connection":"connected","fresh":true,"status":"IDLE","sdcard":false,"printError":0,"loadedAmsSlots":[2],"queueStatus":"idle"}
```

Ảnh: `artifacts/queue-live-desktop.png`, `artifacts/queue-live-mobile.png`, `artifacts/queue-no-sdcard.png`, `artifacts/queue-completed.png`. Mã nguồn `/root/p2s-control` không có Git; chart vẫn ở checkout `/root/helm`, nhánh `main`, thư mục `p2s-control/` untracked từ trước; chưa commit.

## Kết nối máy in qua Windows Tailscale — revision 7 (2026-11-07)

Máy Windows đã quảng bá và được duyệt tuyến `192.168.102.13/32`. Node bật nhận tuyến. Có hai lỗi được xác nhận và sửa:

### 1. Calico packet mark trùng Tailscale bypass

Lệnh kiểm tra từ container web, thực hiện lúc `2026-11-07T12:06:27.530Z`:

```bash
kubectl -n p2s-control exec -i deployment/p2s-control -c web -- node --input-type=module < /tmp/p2s-printer-network-check.mjs
```

```text
{"label":"printer MQTT","port":8883,"elapsedMs":6007,"result":"TIMEOUT"}
{"label":"printer FTPS","port":990,"elapsedMs":6006,"result":"TIMEOUT"}
{"label":"printer camera","port":322,"elapsedMs":6006,"result":"TIMEOUT"}
```

Cùng thời điểm, TCP từ node tới cả ba cổng đều CONNECTED. Lệnh sau xác định gói Pod mang mark bị đi ra ens3 thay vì tailscale0:

```bash
iptables -t raw -S
ip route get 192.168.102.13 from 10.42.0.139 iif cali644bc08c1ed mark 0x80000
```

Trích kết quả:

```text
-A cali-PREROUTING -i cali+ ... -j MARK --set-xmark 0x80000/0x80000
192.168.102.13 from 10.42.0.139 via 192.168.0.1 dev ens3 mark 0x80000
```

Packet capture `timeout 15 tcpdump -nn -i any 'host 192.168.102.13 and tcp port 8883' -c 12` cũng xác nhận SYN từ Pod đi ra ens3, không có trả lời. Policy rule Tailscale `5210` tra main cho mark `0x80000/0xff0000`, trùng mark của Calico.

Đã thêm rule ưu tiên `5200 from 10.42.0.0/16 to 192.168.102.13/32 lookup 52` qua unit `/etc/systemd/system/p2s-printer-route.service`, enabled và active. Bản sao để dựng lại node nằm trong Helm `files/p2s-printer-route.service`. Chỉ nguồn Pod tới đúng IP máy in bị tác động; không đổi các rule Calico/Tailscale khác.

### 2. TLS không chấp nhận chứng chỉ thiết bị thiếu issuer CA

Sau khi TCP thông, dùng đúng credential đã lưu trong Pod (không in credential) để kiểm tra:

```bash
kubectl -n p2s-control exec -i deployment/p2s-control -c web -- node --input-type=module < /tmp/p2s-mqtt-diagnostic.mjs
```

Kết quả lúc `2026-11-07T12:08:29.148Z`:

```text
MQTT ERROR: {"code":"UNABLE_TO_GET_ISSUER_CERT_LOCALLY","message":"unable to get local issuer certificate"}
```

App dùng chứng chỉ thiết bị thu được làm trust anchor nhưng chưa cho phép partial chain. Đã thêm `allowPartialTrustChain: true`, giữ `rejectUnauthorized: true`, fingerprint precheck và callback kiểm tra đúng chứng chỉ. Node tối thiểu tăng lên `22.9.0`, phiên bản hỗ trợ tùy chọn này. Không tắt kiểm tra chứng chỉ trên kết nối MQTT có credential.

Kiểm thử real MQTT/TLS mới dùng leaf được CA riêng ký, không cung cấp issuer CA cho client. Trước sửa: `node --test test/mqtt.test.mjs` thất bại `Timed out waiting for MQTT` (1 pass, 1 fail). Sau sửa: 2/2 pass, gồm từ chối fingerprint đã thay đổi; toàn bộ `npm test` 18/18 pass, `npm run check` syntax46 + formatting pass.

### Xác minh bản triển khai

Helm chart `0.1.2`, release revision `7`, image `p2s-control:helm-6ef71718328b`, Pod `p2s-control-7785d4f454-n7kf9` 2/2 Running, 0 restarts. Chạy lại lệnh network probe phía trên lúc `2026-11-07T12:11:37.227Z`:

```text
{"label":"printer MQTT","port":8883,"elapsedMs":39,"result":"CONNECTED"}
{"label":"printer FTPS","port":990,"elapsedMs":38,"result":"CONNECTED"}
{"label":"printer camera","port":322,"elapsedMs":38,"result":"CONNECTED"}
```

```bash
python3 /tmp/p2s-reconnect-check.py
helm test p2s-control -n p2s-control --logs --timeout 2m
curl --fail --silent --show-error https://p2scombo.viet-tv.online/api/v1/health
systemctl show p2s-printer-route.service -p ActiveState -p SubState -p UnitFileState
```

Trạng thái thực tế từ authenticated API: `connection=connected`, `fresh=true`, `status=IDLE`, `lastReport=2026-11-07T12:11:36.922Z`, nozzle34°C, bed31°C, chamber31°C, nhiệt độ đích nozzle/bed0. Helm test Succeeded, log `PASS: health, web view and authentication guard`; public health `{"ok":true}`; route service `ActiveState=active`, `SubState=exited`, `UnitFileState=enabled`.

Đã xác nhận MQTT auth và nhận dữ liệu thật. Chưa thử in, thay nhiệt độ hay kiểm tra hình camera; CONNECTED cổng camera/FTPS chỉ xác nhận TCP. Windows phải tiếp tục online, truy cập được máy in và không ngủ. Không commit Git; chart tiếp tục trên branch main, còn untracked `p2s-control/`.

## Chuyển ô IP sang bàn phím chữ — Helm revision 6

Người dùng gửi ảnh iPhone vẫn hiện bàn phím số và yêu cầu dùng bàn phím chữ. Kiểm tra HTML nguồn và HTTPS thật trước sửa cho thấy `type="text" inputmode="url"`. Chưa xác định được vì sao bàn phím native iPhone vẫn hiện dạng số; không kết luận nguyên nhân là cache hay WebView.

Lệnh kiểm tra nguồn tại `/root/p2s-control`:

```bash
rg -n -A 12 -B 3 'name="host"' server/views/index.html
```

Trích kết quả trước sửa:

```html
type="text"
inputmode="url"
```

Đã đổi rõ `inputmode="text"` theo yêu cầu, giữ `type="text"`. Image `p2s-control:helm-b625a48908df` đã triển khai lên revision 6, Pod 2/2 Running. Link mở mới: `https://p2scombo.viet-tv.online/?v=keyboard-text`.

Vòng kiểm tra trên domain thật:

```bash
node /tmp/p2s-browser/ip-text-keyboard-qa.mjs
```

Trước rollout:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
'url' !== 'text'
actual: 'url'
expected: 'text'
```

Sau rollout, `npm run check` đạt cú pháp 46 file/Prettier; HTML công khai có `type="text" inputmode="text"`; cùng vòng kiểm tra trả:

```text
PASS: deployed IP field uses text keyboard hint and text validation; dotted IPv4 entry accepted on mobile viewport. No printer configuration was saved. Native iOS keyboard not available in headless testing.
```

Chưa xác minh hiển thị phím trên iPhone thật; chỉ xác nhận gợi ý bàn phím text, nhập IPv4 và validation trong browser mobile viewport. Không lưu hay thay cấu hình máy in.

## Sửa bàn phím nhập IP trên iOS — Helm revision 5

Nguyên nhân: ảnh iOS người dùng gửi cho thấy bàn phím số chỉ có dấu phẩy, trong khi HTML thật dùng `inputmode="decimal"`. Decimal inputmode chọn dấu thập phân theo locale; không phù hợp với IPv4 cần dấu chấm. Đây là lỗi giao diện, không có exception/log lỗi server.

Lệnh kiểm tra nguồn tại `/root/p2s-control`:

```bash
rg -n -A 10 -B 5 'name="host"' server/views/index.html
```

Trích HTML gốc, cũng đã đối chiếu với nội dung HTTPS đang chạy:

```html
<input name="host" required placeholder="192.168.1.25" inputmode="decimal" autocomplete="off" />
```

Vòng kiểm tra trước/sau trên domain thật:

```bash
node /tmp/p2s-browser/ip-keyboard-qa.mjs
```

Trước triển khai bản sửa:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
'decimal' !== 'url'
actual: 'decimal'
expected: 'url'
```

Đã sửa ô IP thành `type="text" inputmode="url"`, tắt autocapitalize/autocorrect/spellcheck. Kiểu text giữ IPv4 hợp lệ mà không yêu cầu scheme URL. Image `p2s-control:helm-ce63332ad2bd` đã triển khai lên release revision 5; Pod 2/2 Running.

Kiểm tra `npm run check` đạt cú pháp 46 file và Prettier. Chạy lại chính vòng kiểm tra browser sau deploy:

```text
PASS: deployed IP field uses URL keyboard hint and text validation; dotted IPv4 entry accepted on mobile viewport. No printer configuration was saved. Native iOS keyboard not available in headless testing.
```

Browser kiểm tra đăng nhập, mở dialog, xác nhận inputMode/type và nhập `192.168.1.25` hợp lệ ở viewport điện thoại. Không bấm lưu cấu hình, không phát lệnh máy in. Không có bàn phím iOS native trong môi trường headless nên chưa xác minh trực tiếp giao diện phím trên iPhone thật. Tham khảo [HTML input modalities](https://html.spec.whatwg.org/multipage/interaction.html#input-modalities) và [MDN inputmode](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode).

## Refactor MVC và API v1 — kết quả mới nhất

Đã tách cấu trúc MVC, chuyển trang HTML vào `server/views`, nhóm API theo `/api/v1`, duy trì URL cũ bằng router tương thích và định dạng mã bằng Prettier. Không đổi định dạng cấu hình/thư viện trong Docker volume. Các đường dẫn file trong log lịch sử phía dưới là vị trí trước khi tách MVC.

Lệnh đã chạy sau refactor:

```bash
cd /root/p2s-control
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker compose -p p2s-control-mvc-qa --env-file /tmp/p2s-control-test.env up -d --build --wait
curl -fsS http://127.0.0.1:3082/api/v1/health
curl -fsS http://127.0.0.1:3082/api/health
docker compose -p p2s-control-mvc-qa --env-file /tmp/p2s-control-test.env exec -T web node --input-type=module < test/camera-smoke.mjs
node /tmp/p2s-browser/qa-mvc.mjs
```

Kết quả thực tế:

```text
tests 16
pass 16
fail 0
Syntax OK: 45 JavaScript files.
All matched files use Prettier code style!
found 0 vulnerabilities
Container p2s-control-mvc-qa-web-1 Healthy
/api/v1/health: {"ok":true}
/api/health: {"ok":true}
```

Camera Docker dùng video tổng hợp:

```json
{"test":"H264 via RTSP to MJPEG camera","status":200,"type":"multipart/x-mixed-replace; boundary=frame","bytes":17131,"dimensions":{"width":960,"height":540}}
```

Kiểm tra trình duyệt sau khi chuyển view và API:

```json
{"result":"PASS","checks":["login","empty_state_no_fake_telemetry","offline_controls_disabled","settings_validation","upload_3mf","delete_confirmation","ams_empty_state","responsive_390_768_1440","logout","no_javascript_errors"],"screenshots":4}
```

Review độc lập đối chiếu với bản trước: không phát hiện lỗi quan trọng; kiểm tra thêm 4 lượt HTTP camera liên tiếp với upstream giả, client đóng stream đều đưa số lượt xem về 0. Các kiểm tra không phát lệnh đến máy in thật. Container/volume và mật khẩu QA là dữ liệu thử riêng, được dọn sau khi xác minh.

## Lịch sử xác minh trước refactor MVC

Thực hiện ngày 2026-11-07 trong `/root/p2s-control`, trên Ubuntu/Docker. Không có kết nối đến máy in thật. File môi trường thử nghiệm `/tmp/p2s-control-test.env` chứa mật khẩu ngẫu nhiên chỉ dùng cho QA, không nằm trong gói mã nguồn và không được in ra log.

## Kết quả cuối

```bash
cd /root/p2s-control
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker compose --env-file /tmp/p2s-control-test.env up -d --build --wait
curl -fsS http://127.0.0.1:3080/api/health
docker compose --env-file /tmp/p2s-control-test.env exec -T web node --input-type=module < test/camera-smoke.mjs
```

Kết quả thực tế:

```text
tests 14
pass 14
fail 0
node --check server/index.mjs && node --check public/app.js: exit 0
found 0 vulnerabilities
Container p2s-control-web-1 Healthy
{"ok":true}
{"test":"H264 via RTSP to MJPEG camera","status":200,"type":"multipart/x-mixed-replace; boundary=frame","bytes":17131,"dimensions":{"width":960,"height":540}}
```

MQTT đã thử với broker Aedes thật qua TLS: username/password, subscribe, báo cáo delta, gửi lệnh, chặn khi cũ/mất kết nối. Thư viện 3MF thử ZIP/XML thật. Docker đã chạy với cả volume hiện có và một bộ volume thử nghiệm hoàn toàn mới.

Kiểm thử trình duyệt bằng Playwright/Chrome headless trên trang Docker thật, lệnh `node /tmp/p2s-browser/qa.mjs`, kết quả:

```json
{"result":"PASS","checks":["login","empty_state_no_fake_telemetry","offline_controls_disabled","settings_validation","upload_3mf","delete_confirmation","ams_empty_state","responsive_390_768_1440","logout","no_javascript_errors"],"screenshots":4}
```

Script QA tạm thời chỉ dùng mật khẩu thử nghiệm và video/tệp tổng hợp. Ảnh giao diện nằm trong `artifacts/`. Review mã độc lập đã kiểm tra backend/frontend/Compose và xác nhận các findings được sửa trước khi bàn giao.

## Lỗi phát hiện trong triển khai và sửa

### 1. Quyền volume camera làm app không khởi động

Lệnh lấy log container web, 5 phút gần nhất:

```bash
cd /root/p2s-control
docker compose --env-file /tmp/p2s-control-test.env logs --since=5m --tail=55 web
stat -c '%U:%G %u:%g %a %n' /var/lib/docker/volumes/p2s-control_printer-data/_data /var/lib/docker/volumes/p2s-control_camera-data/_data
```

Trích log và kết quả gốc:

```text
Error: EACCES: permission denied, open '/app/camera/go2rtc.yaml.a776ba3e79.tmp'
at async atomicWrite (file:///app/server/config.mjs:23:3)
at async Camera.init (file:///app/server/camera.mjs:13:13)
1000:1000 700 /var/lib/docker/volumes/p2s-control_printer-data/_data
0:0 755 /var/lib/docker/volumes/p2s-control_camera-data/_data
```

Nguyên nhân đã xác nhận: volume camera thuộc root trong khi web chạy UID 1000. Sửa: service `init-data` đặt owner 1000 và quyền 700 trước khi web chạy; app chính và camera tiếp tục chạy non-root. Kiểm tra lại `docker compose ... up -d --build --wait`: web healthy; triển khai volume mới cũng thành công.

### 2. Dependency basic-ftp thuộc dải có cảnh báo

```bash
cd /root/p2s-control
npm audit --omit=dev --audit-level=high
```

Trích kết quả gốc:

```text
basic-ftp <=6.2.0
Severity: high
Quadratic-time CPU denial of service in Client.list() Unix directory-listing parser
fix available ... basic-ftp@6.2.6
```

Nguyên nhân: ràng buộc phiên bản ban đầu dùng nhánh 5.x. Sửa package và lockfile sang nhánh `^6.2.6`, kiểm tra lại cùng lệnh: `found 0 vulnerabilities`. App không sử dụng chức năng list() có lỗi; vẫn cập nhật dependency trước khi bàn giao.

### 3. Gửi in liên tiếp và vượt giới hạn camera

```bash
cd /root/p2s-control
node --test test/camera.test.mjs test/projects.test.mjs
```

Trích kết quả hồi quy trước sửa:

```text
AssertionError: fourth viewer must be rejected
0 !== 1
AssertionError: must wait for printer telemetry after publishing
false !== true
```

Nguyên nhân: khóa gửi in được giải phóng ngay sau publish QoS0 dù telemetry chưa đổi; camera kiểm tra giới hạn trước await nhưng tăng bộ đếm sau await. Sửa: giữ reservation gửi in đến telemetry bận, phản hồi lỗi hoặc timeout 60 giây kèm thông báo; giữ chỗ camera trước await và hoàn trả trong finally. Cùng các kiểm thử đã đạt trong bộ 14/14 cuối. Những lỗi này không được tái hiện bằng máy in thật và không phát lệnh in vật lý.

### 4. Callback máy cũ ghim chứng chỉ lên máy mới

```bash
cd /root/p2s-control
node --test test/core.test.mjs
```

Trích kiểm thử trước sửa:

```text
AssertionError: new printer must not inherit a stale callback certificate
actual: 'OLD-A'
expected: undefined
```

Nguyên nhân: lưu identity mới trước khi vô hiệu kết nối cũ; pin chứng chỉ chưa kiểm identity. Sửa: kiểm tra cấu hình, đóng client cũ trước save; pin đối chiếu host/serial/accessCode; xếp hàng các lần ghi snapshot; kiểm generation sau tác vụ bất đồng bộ. Kiểm thử hồi quy đã đạt trong 14/14 cuối.

### 5. go2rtc từ chối tham số FFmpeg có dấu cách trong nguồn API

Kiểm thử tại service web, API nội bộ camera. Lệnh điều tra đã chạy qua stdin:

```bash
docker compose -p p2s-control-fresh --env-file /tmp/p2s-control-test.env exec -T web node --input-type=module - <<'JS'
const sources = ['rtsp://127.0.0.1:8554/qa_source', 'ffmpeg:qa_bridge#video=mjpeg#raw=-vf scale=960:540,fps=5'];
const p = new URLSearchParams({name:'qa_bridge'});
for (const s of sources) p.append('src', s);
const r = await fetch('http://camera:1984/api/streams?' + p, {method:'PUT'});
console.log('PUT', r.status, await r.text());
JS
```

Kết quả gốc:

```text
PUT 400 streams: source with spaces may be insecure
```

Nguyên nhân: go2rtc Validate chặn dấu cách trong nguồn API; raw FFmpeg chứa khoảng trắng. Sửa: chuyển bộ lọc scale/fps vào template FFmpeg trong cấu hình, nguồn API chỉ còn `ffmpeg:p2s#video=mjpeg`. Camera chờ web healthy để đọc cấu hình đã khởi tạo. Thêm hồi quy `camera source is accepted by go2rtc API that rejects sources containing spaces` và kiểm tra Docker `test/camera-smoke.mjs` với video H.264/RTSP tổng hợp. Kết quả cuối là MJPEG HTTP 200, JPEG 960×540 như trên.

## Giới hạn còn lại

Chưa xác minh P2S/firmware, Access Code, AMS hoặc camera thật của bố. Chưa thử FTPS truyền tệp sang máy thật hay bắt đầu in vật lý. Kiểm thử đường camera dùng video tổng hợp, không chứng minh khả năng mở RTSPS của thiết bị thật. Từ xa cần Ubuntu có đường tới LAN máy in và thiết bị truy cập có VPN/HTTPS đúng cấu hình theo README. Không có cấu hình SSH, tài khoản Bambu hoặc thông tin riêng của bố trong mã nguồn/gói bàn giao.

## Bổ sung lỗi và kiểm tra/hiệu chuẩn — 2026-11-08

Thực hiện trực tiếp tại `/root/p2s-control`. Thư mục không có Git checkout nên không tạo branch/worktree hay commit. Màn hình mới **Lỗi & kiểm tra** có danh sách mã in/HMS, mô tả và liên kết Bambu, kiểm tra kết nối/trạng thái, cùng lựa chọn cân bàn/bù rung/giảm ồn động cơ. Giới hạn xác minh máy thật ở trên vẫn áp dụng; không phát lệnh đến máy thật trong đợt này.

Giao thức đối chiếu nguồn: [Bambu Studio `command_start_calibration`](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.cpp), [Bambu Studio HMS decoder](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevHMS.cpp). Chỉ gửi bit cân bàn `2`, bù rung `4`, giảm ồn động cơ `8`. Xác nhận lệnh không được coi là xác nhận chạy/hoàn thành. Dịch vụ `https://e.bambulab.com/query.php?lang=en&e=07004025` thực tế trả mô tả `Failed to read the filament information.`; không gửi thông tin định danh máy để tra cứu.

### Lỗi tái hiện và sửa trong lần kiểm tra

Các lệnh dưới chạy ở checkout nguồn `/root/p2s-control`, không dùng service/container và không có bộ lọc thời gian vì là kiểm thử xác định.

1. Khóa hiệu chuẩn sau mất kết nối và nhận nhầm tác vụ cũ:

```bash
node --test --test-name-pattern='after reconnect|old calibration' test/printer-health.test.mjs
```

Log gốc rút gọn, giữ nguyên actual/expected:

```text
calibration completion after reconnect releases its lock after an observed run
actual: 'uncertain'
expected: 'completed'
an old calibration filename does not identify an unrelated new task as calibration
actual: 'completed'
expected: 'awaiting_start'
```

Nguyên nhân tại `server/services/printer-maintenance.service.mjs`: chỉ xử lý kết thúc khi status còn `running`, và đọc tên tệp đã merge từ trước khi gửi lệnh mới. Sửa bằng giữ bằng chứng đã quan sát chạy qua mất kết nối; yêu cầu tên tệp hiệu chuẩn được quan sát sau lệnh mới; tác vụ khác không được báo hoàn thành hiệu chuẩn.

2. Dữ liệu nhiệt độ mới làm tình trạng/lỗi cũ được coi là mới:

```bash
node --test --test-name-pattern='recent temperature' test/printer-health.test.mjs
```

```text
actual: 'warning'
expected: 'unknown'
```

Nguyên nhân tại `server/services/printer.service.mjs`: thời điểm `lastReport` chung cho mọi trường. Sửa bằng độ mới riêng cho `gcode_state`, `print_error`, `hms`, thẻ nhớ và hai cảm biến; hiệu chuẩn yêu cầu cả ba trường trạng thái/lỗi còn mới. Diagnostics đợi cả ba trường được nhận sau yêu cầu (có thể nhiều delta), không coi ACK/progress/nhiệt độ đơn lẻ là phản hồi đủ.

3. HMS chứa `null` làm hỏng trạng thái:

```bash
node --test --test-name-pattern='health exposes' test/printer-health.test.mjs
```

```text
TypeError: Cannot read properties of null (reading 'attr')
at server/models/printer-state.model.mjs:36:51
```

Nguyên nhân: `summarize` đọc `item.attr` trước khi kiểm tra object. Sửa bằng lọc mục không phải object trước map. Kiểm tra MQTT/TLS thật còn xác nhận trường HMS hỏng không được cấp dấu thời gian khỏe và bản tin hợp lệ tiếp theo phục hồi được.

### Kết quả xác minh

```bash
npm test
npm run check
docker build -t p2s-control:health-check .
```

Kết quả: **45/45 tests pass**, **54 tệp JavaScript đúng cú pháp**, **Prettier pass**, Docker build **exit 0**. Các lệnh tái hiện lỗi phía trên đều nằm trong bộ 45 test cuối và đã pass sau sửa. Kiểm thử giao diện bổ sung xác nhận khi nhiệt độ mới nhưng trường lỗi cũ thì danh sách không báo “không có lỗi”, banner và nhãn dữ liệu dùng cùng điều kiện độ mới như kết quả chẩn đoán.

Kiểm tra HTTP trong image Docker (container tạm, không publish cổng, không khởi động kết nối máy in): đăng nhập, tải trang mới, đọc health chưa cấu hình, chạy diagnostics trả `received:false`, từ chối hiệu chuẩn không kết nối bằng HTTP 409. Kết quả `PASS Docker image: login, health page, status API, unconfigured diagnostics, calibration refused without connection. No device connection or commands.`

Kiểm tra Playwright bằng Chrome headless tại 1440×1050 và 390×844: hiển thị hai mã lỗi, kiểm tra trạng thái, hủy xác nhận không gửi lệnh, gửi đúng các lựa chọn khi xác nhận, khóa in khi hiệu chuẩn, dữ liệu cũ, không tràn ngang và không lỗi JavaScript. Mọi endpoint đến máy in được intercept bằng dữ liệu mô phỏng. Ảnh: `artifacts/printer-health-desktop.png`, `artifacts/printer-health-mobile.png`.

## Ghi camera timelapse — 2026-11-08

Triển khai trực tiếp tại `/root/p2s-control`: trang Timelapse; ghi thủ công và tự động theo bản in; JPEG qua CameraService; encoder FFmpeg/libx264; MP4 xem/tải với HTTP Range và xác thực; xóa/ghép lại; lưu ảnh/metadata/thiết lập trong volume hiện có. Đóng trình duyệt không dừng ghi. Giới hạn 24 giờ/10.000 ảnh/1 GB ảnh mỗi bản, tổng 5 GB/100 bản ghi và ít nhất 128 MB đĩa trống. Không tự xóa video cũ, không điều khiển chuyển động hoặc dừng máy in.

Tài liệu FFmpeg dùng đối chiếu: [image2 demuxer](https://github.com/FFmpeg/FFmpeg/blob/master/doc/demuxers.texi) (`-framerate`, `-start_number`, dãy tên ảnh). Đã xác minh encoder và định dạng đầu ra bằng FFmpeg/ffprobe thực tế trong Docker.

### Lỗi phát hiện trong rà soát và bằng chứng sửa

Tất cả lệnh dưới chạy tại `/root/p2s-control`, dữ liệu thử trong `/tmp`, không dùng thiết bị thật; là kiểm thử xác định nên không có bộ lọc thời gian/log service.

```bash
node --test --test-name-pattern='configuration change|auto off during|after close' test/timelapse.test.mjs
```

Log trước sửa (rút gọn, giữ đúng giá trị lỗi):

```text
recording refuses a printer configuration change already in progress
AssertionError: Missing expected rejection.
turning auto off during encoder readiness never starts a recording
actual: { mode: 'auto', status: 'recording', ... }
expected: null
render preparation cannot launch an encoder after close has returned
actual: 1
expected: 0
```

Nguyên nhân tại `server/services/timelapse.service.mjs`: chỉ kiểm tra điều kiện trước khi chờ `encoder.available()`, không kiểm lại sau khi await; `start` chưa chặn cấu hình máy in đang đổi. Sửa: chặn `printer.configPending`; kiểm lại cờ auto, tác vụ và shutdown sau các bước chuẩn bị; không khởi động encoder sau shutdown; tick kết thúc bản tự động khi auto tắt. Ba ca trên sau sửa đều pass.

Một ca bổ sung: MQTT có thể gửi tên tệp sau trạng thái/tên bản in. Dùng tên tệp chưa ổn định làm khóa tác vụ làm một bản in bị tách thành hai bản ghi.

```bash
node --test --test-name-pattern='delayed filename' test/timelapse.test.mjs
```

Log trước sửa (ID thử ngẫu nhiên):

```text
actual: '778bbec3d062f897900b7dc19217ab74'
expected: 'd3bed0d7b51090d24449653ff552ad7b'
```

Sửa bằng dùng tên tác vụ ổn định và chỉ số lượt hàng đợi; không dùng tên tệp đến muộn làm khóa. Chạy lại ca này pass 1/1. Tổng lệnh tái hiện bốn ca:

```bash
node --test --test-name-pattern='configuration change|auto off during|after close|delayed filename' test/timelapse.test.mjs
```

Kết quả sau sửa: **4 tests, 4 pass, 0 fail**.

### Xác minh cuối

```bash
npm test
npm run check
docker build -t p2s-control:timelapse-check .
docker run --rm -i --entrypoint node p2s-control:timelapse-check --input-type=module < test/timelapse-smoke.mjs
```

Kết quả thực tế:

```text
tests 61
pass 61
fail 0
Syntax OK: 63 JavaScript files.
All matched files use Prettier code style!
Docker build: exit 0
PASS: CameraService HTTP JPEG → 3 captures → FFmpeg H.264 MP4 960×540, 24 fps, 0.125000s; camera viewers released. No physical printer connection.
```

Bộ test bao phủ chụp/ghi/ghép, trùng lệnh, camera lỗi, thiếu encoder, quota, ảnh đang chụp lúc dừng, khôi phục sau restart, tự ghi khi RUNNING, giữ ghi khi PAUSE/telemetry cũ, kết thúc theo trạng thái thật, bỏ qua hiệu chuẩn và không tự ghi lại cùng bản sau dừng thủ công. HTTP kiểm tra auth/CSRF, payload, path traversal, download/video Range và xóa khi đang ghi. Encoder smoke tạo ảnh tổng hợp bằng FFmpeg, đưa qua HTTP JPEG và CameraService thật rồi ghép MP4; ffprobe xác minh codec, kích thước, số ảnh, fps và duration.

Playwright/Chrome headless tại 1440×1080 và 390×844: xem MP4 960×540 trong dialog, tải attachment có đăng nhập, bật/lưu auto, ghi thủ công, tải lại trang vẫn ghi và số ảnh tăng, dừng/ghép, xác nhận/hủy xóa; không tràn ngang và không có JavaScript page errors. Browser dùng dữ liệu camera/video tổng hợp và encoder mô phỏng; encoder thực được kiểm chứng riêng trong Docker như trên. Ảnh `artifacts/timelapse-desktop.png`, `artifacts/timelapse-mobile.png`; video tổng hợp `artifacts/timelapse-sample.mp4`.

**Giới hạn:** Chưa xác minh camera/mạng/P2S thật của bố, chưa chạy ghi kéo dài nhiều giờ. Auto theo telemetry có chu kỳ quan sát 2 giây; server ngừng sẽ tạo khoảng trống và đánh dấu bản đang ghi gián đoạn, không tự nối video. Sau cập nhật cần `docker compose up -d --build` để image có FFmpeg. Gói bàn giao mới giữ nguyên các tính năng lỗi/kiểm tra máy in đã làm trước đó.
