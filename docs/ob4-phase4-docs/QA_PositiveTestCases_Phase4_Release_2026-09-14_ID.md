# Phase 4 OB4 — Test Case Positif (Manual, Pra-Rilis)

*(Versi Bahasa Indonesia dari `QA_PositiveTestCases_Phase4_Release_2026-09-14.md` —
penjelasan DAN kalimat trigger sudah diterjemahkan ke Bahasa Indonesia; nama tool dan
field JSON dibiarkan apa adanya. Maha membalas sesuai bahasa pesan yang dikirim, jadi
trigger Indonesia di bawah ini tetap valid untuk menguji tool yang sama — hasil balasan
Maha akan dalam Bahasa Indonesia, bukan Arab.)*

Hanya kasus HAPPY PATH — satu per tool, seperti apa bentuk panggilan sukses normal dan
apa yang harus dicek di reply/DB/UI. Tidak ada kasus negatif/error di sini (itu sudah
tercover oleh code review + unit test suite `tests/` + spec Playwright di
`scenarios/ob4-crm-export/`). Untuk verifikasi klik-manual sebelum rilis.

Konvensi: **Trigger** = pesan chat realistis yang akan diketik owner (Bahasa
Indonesia, versi terjemahan dari trigger Arab aslinya). **Expected** = apa yang benar-
benar dikembalikan tool / apa yang berubah di DB atau UI — cek ini, bukan cuma "Maha
membalas dengan baik."

Semua contoh mengasumsikan clinic test dengan kapabilitas `crm`+`export`+`charts`+
`staff_reminders` aktif (sama seperti env suite Playwright). Ganti id
contact/reminder/segment/template dengan yang real dari data test kamu sendiri — id di
bawah ini semuanya bukan id asli.

**Catatan cakupan:** ini hanya mencakup tool surface milik OB4/Maha sendiri
(`maha_inapp_agent.py`). "Agent Segments" (popup Marketing → Agent Segments,
`segments_agent.py`) adalah **orchestrator/prompt/endpoint terpisah** yang kebetulan
berbagi resolver yang sama (`inapp_agent/tools/segments.py`) dengan CRM-12/TPL-02 —
itu BUKAN salah satu tool di bawah, dan tidak tercover checklist ini walau keduanya
mudah tertukar karena nama file.

**Update 2026-09-15:** beberapa happy path di bawah ini sekarang juga tercover oleh
suite Playwright otomatis (`scenarios/ob4-crm-export/`), dijalankan sungguhan terhadap
data lokal clinic 611 — CRM-11, CRM-12, EXP-01 (kind contact_list/analytics/
contact_card), DSP-01 (contact_list bar+line, appointment_list, analytics, penolakan
pie), dan TPL-02 (baik kasus frozen maupun live-segment). Itu tidak berarti klik-manual
di bawah jadi tidak perlu — suite Playwright cuma mengecek bentuk reply/API dan state
DB, bukan apakah widget chart benar-benar *tampil* secara visual, apakah PDF benar-benar
*bisa dibuka* dengan bersih, atau apakah tampilan UI Marketing *terlihat* benar — tapi
kalau waktu terbatas, baris-baris tool itu yang paling aman untuk dilewati dari manual
pass. Satu hal yang tidak perlu ditemukan ulang oleh QA manual: TPL-02 tidak perlu
submit baru lewat TPL-01 untuk dites — clinic 611 sudah punya template asli yang
APPROVED di Meta dari pemakaian sebelumnya (mis.
`appointment_reminder_for_next_week_611`).

---

## CRM

### CRM-01 — `crm_search_contacts`
**Trigger:** "Cari pasien yang belum berkunjung sejak 2 bulan lalu"
**Expected:** `{rows: [...], total, set_ref}`. Setiap row punya `patient_id, name,
phone_masked, last_visit, consent_state` — nomor telepon DI-MASK secara default.
`set_ref` muncul dan bisa dipakai ulang oleh export/chart/save-as-segment/bulk-apply
selama ~30 menit ke depan.

### CRM-01b — `crm_search_conversation_content`
**Trigger:** "Carikan pasien yang mengeluh kesakitan di percakapan mereka"
**Expected:** `{candidates: [...]}` — ringkasan interaksi terbaru per kandidat kontak,
BUKAN daftar match final. Maha harus menampilkan ini dan meminta konfirmasi mana yang
benar-benar cocok sebelum memasukkannya ke panggilan `crm_search_contacts` lewat
`conversation_matched_patient_ids`.

### CRM-02 — `crm_get_contact`
**Trigger:** "Buka file pasien [nama]" (setelah pencarian)
**Expected:** Profil lengkap — nama, telepon, bahasa, tag, catatan, penanggung jawab,
consent, riwayat janji temu, riwayat percakapan (hanya jumlah/timestamp, tidak pernah
isi pesan), riwayat kampanye, follow_ups, `crm_sync_authority` per field. `source`
kembali kosong, tercantum di `not_yet_available`.

### CRM-03 — `crm_update_contact`
**Trigger:** "Ubah nama pasien [nama lama] jadi [nama baru]"
**Expected:** `{success: true, field, old_value, new_value}` (atau `already_correct`
kalau tidak ada yang berubah). Field benar-benar terupdate di DB — jalankan ulang CRM-02
dan konfirmasi nilai barunya melekat. Panggilan `crm_get_audit_trail` setelahnya
menunjukkan perubahan ini.

### CRM-04 — `crm_set_responsible`
**Trigger:** "Jadikan [nama staff] penanggung jawab pasien ini"
**Expected:** `{success: true, assignee_id, assignee_name}`. Notifikasi dashboard
dibuat untuk assignee (cek tabel `notifications`). `already_correct` kalau mereka
memang sudah jadi penanggung jawab.

### CRM-05 — `crm_add_note`
**Trigger:** "Catat: pasien minta janji temu hari Kamis"
**Expected:** `{success: true, note_id, created_at, author_name}`. Catatan ditambahkan,
tidak pernah mengedit/mengganti catatan yang sudah ada (append-only) — CRM-02
setelahnya menampilkan catatan lama dan baru.

### CRM-06a — `crm_create_follow_up`
**Trigger:** "Ingatkan saya telepon pasien ini hari Minggu"
**Expected:** `{success: true, follow_up_id, due_date, assignee_display_name}`.
Notifikasi dashboard dibuat untuk assignee.

### CRM-06b — `crm_list_follow_ups`
**Trigger:** "Tunjukkan pengingat yang masih terbuka"
**Expected:** `{rows: [...], total}`, yang paling dekat jatuh temponya duluan, hanya
follow-up yang masih OPEN (belum di-clear).

### CRM-06c — `crm_clear_follow_up`
**Trigger:** "Sudah, saya sudah telepon pasiennya — hapus pengingatnya"
**Expected:** `{success: true}`. `crm_list_follow_ups` setelahnya tidak lagi
menampilkannya.

### CRM-07 — `crm_merge_contacts`
**Trigger:** "Pasien ini duplikat — gabungkan dengan [nama pasien asli]" (Maha harus
menyebutkan kedua kontak dan mana yang bertahan, dan bilang ini permanen, SEBELUM
meminta konfirmasi)
**Expected:** `{success: true, survivor: {...}, absorbed_summary, is_reversible:
false}`. Catatan/tag/follow-up/janji-temu/percakapan kontak yang diserap semuanya
pindah ke yang bertahan; id yang diserap tidak lagi muncul di search/get_contact.

### CRM-08 — `crm_record_consent`
**Trigger:** "Pasien ini setuju untuk dipasarkan — catat persetujuannya"
**Expected:** Ini masih STUB hari ini — selalu `{success: false, error:
"not_yet_available"}` dengan pesan yang mengarahkan ke Inbox/Marketing. **Belum ada
kasus sukses untuk tool ini** — konfirmasi dia gagal dengan jujur, tidak pernah
memalsukan penyimpanan.

### CRM-09 — `crm_aggregate`
**Trigger:** "Berapa jumlah pasien baru bulan lalu?"
**Expected:** `{success: true, value or rows, definition_applied, period_summary}`.
`group_by=month/branch` berfungsi untuk ketiga metrik (new_contacts_count,
conversations_count, bookings_count); `doctor_requested`/`service_requested` hanya
valid untuk `bookings_count`.

### CRM-10 — `crm_get_audit_trail`
**Trigger:** "Tunjukkan riwayat perubahan pasien ini"
**Expected:** `{rows: [...], total}` — setiap write crm_update_contact/set_responsible/
add_note/create_follow_up/clear_follow_up/merge_contacts/bulk_apply pada kontak ini
muncul, terbaru duluan, dengan `author_name` (nama staff asli kalau acting_user_id
diberikan, kalau tidak owner clinic).

### CRM-11 — `crm_bulk_apply`
**Trigger:** (setelah `crm_search_contacts`) "Tambahkan tag 'VIP' untuk semua pasien
ini"
**Expected:** `{total, processed, changed, already_correct, failed: [...],
is_reversible: false}` — SELALU detail per-row, tidak pernah cuma angka telanjang.
Sebutkan sifat tidak-bisa-dibatalkan SEBELUM meminta konfirmasi (tier 3). Verifikasi
jumlah `changed` cocok dengan jumlah hasil pencarian, bukan seluruh clinic.

### CRM-12 — `crm_save_as_segment`
**Trigger:** "Simpan ini sebagai segmen dengan nama 'Pengunjung 2 Bulan Terakhir'"
**Expected:** `{success: true, segment_id, section_id: "marketing", contact_count}`
— `contact_count` adalah hasil re-resolve BARU, bukan angka basi dari pencarian awal.
Segment sekarang terlihat di Marketing → Agent Segments.

---

## EXP (Export)

`export_result` butuh `last_exportable_set_ref`/`last_set_ref` dari tool baca
sebelumnya di SESI yang sama. Test minimal 3 kind berbeda — bentuk hasil tool baca
memang genuinely berbeda per kind, jadi satu kind yang lolos tidak membuktikan yang
lain juga lolos.

### EXP — `contact_list` (dari `crm_search_contacts`)
**Trigger:** "Ekspor ke Excel ya" (setelah pencarian CRM-01)
**Expected:** `{success: true, download_url, filename, row_count, expires_at}`.
File benar-benar bisa didownload; PII di-mask kecuali `include_pii` diminta secara
eksplisit; header metadata menampilkan definisi/periode/cabang/timestamp.

### EXP — `appointment_list` (dari `read_appointments`)
**Trigger:** "Tolong ekspor daftar janji temu ini" (setelah menampilkan daftar janji
temu)
**Expected:** Bentuk sama seperti di atas, `data_type: "appointment_list"` di sisi
Laravel. Kalau unscoped (super_admin, menyentuh beberapa cabang), `spans_branches`
menyebutkan nama cabangnya. **Catatan local-dev (2026-09-15):** kalau ini hang/timeout
saat menjalankan app secara lokal lewat server dev bawaan PHP (`php -S`), itu quirk
yang memang khusus `php -S` soal pengiriman respons (Laravel sendiri sudah dikonfirmasi
langsung menyelesaikan request ini dengan benar di sisi server) — bukan regresi. Coba
server lokal yang beneran (Valet/Herd/php-fpm+nginx) dulu sebelum menganggap tool ini
rusak.

### EXP — `analytics` (dari `read_analytics`)
**Trigger:** "Tolong ekspor laporan statistiknya"
**Expected:** Bentuk single-record — satu baris label/value per counter MyAnalytics
(Total Komunikasi, Pertanyaan Terjawab, dll), bukan tabel kontak.

### EXP — `contact_card` (dari `crm_get_contact`)
**Trigger:** "Ekspor file pasien ini jadi PDF" (setelah CRM-02)
**Expected:** Export kartu single-record, `data_type: "single_record"` di sisi Laravel
(sesuai FORMAT_TABLE) — konfirmasi PDF-nya benar-benar terbuka dan menampilkan field
profil.

### EXP-06 — `export_get_audit_trail`
**Trigger:** "Tunjukkan file terakhir yang saya ekspor"
**Expected:** `{rows: [...], total}` — `{timestamp, set_ref, format, row_count,
download_url, expired}`, terbaru duluan, branch-scoped, `expired` dihitung langsung
terhadap masa berlaku link yang sebenarnya.

### EXP-07 — `export_result_batched`
**Trigger:** (pencarian yang hasilnya sangat besar) "Ekspor ini dibagi per cabang ya"
**Expected:** Beberapa batch, masing-masing punya `download_url` sendiri — Maha harus
menyebutkan SETIAP batch, jangan cuma totalnya. `batch_by: branch/month/n_rows`
semuanya menghasilkan pembagian yang masuk akal, dibatasi 50.000 baris total.

---

## DSP-01 — `render_chart`

Hanya 5 kind yang bisa di-chart: `contact_list`, `appointment_list`, `staff_list`,
`campaign_list`, `analytics`. Test minimal 3 yang paling sering dipakai.

### DSP — chart `contact_list`
**Trigger:** "Gambarkan sebagai diagram lingkaran" (setelah pencarian CRM-01)
**Expected:** `{success: true, chart_id, rendered: true}` — tidak ada label/value di
reply itu sendiri. Widget chart benar-benar tampil inline di chat (surface chat
AI-instruction facility, bukan `chat.blade.php`). `group_by` default ke
`consent_state`; pie ditolak di atas 6 slice.

### DSP — chart `appointment_list`
**Trigger:** "Tampilkan sebagai grafik berdasarkan status" (setelah menampilkan
daftar janji temu)
**Expected:** Chart dikelompokkan berdasarkan `status` (default) — bar per
appointment_status (confirmed/cancelled/completed/dst.), jumlahnya cocok dengan kalau
kamu hitung manual dari daftarnya.

### DSP — chart `analytics`
**Trigger:** "Tampilkan statistiknya sebagai grafik" (setelah `read_analytics`)
**Expected:** Chart selalu menampilkan ke-8 counter tetap MyAnalytics — `group_by`
diabaikan untuk kind ini (bukan error kalau tetap dikirim).

---

## RMD (Staff Reminders)

### RMD-01 — `staff_reminder_create`
**Trigger:** "Ingatkan saya telepon lab besok jam 9"
**Expected:** `{success: true, reminder_id, scheduled_at, target_display_name,
delivery_channel_used: "dashboard"}`. Permintaan eksplisit "via WhatsApp" harus gagal
dengan `whatsapp_delivery_not_yet_available`, bukan diam-diam pakai dashboard — layak
dikonfirmasi Maha bilang ini dengan jelas. Reminder dengan target `person` harus
menampilkan nama staff asli (atau "Unnamed staff member" kalau staff itu tidak punya
nama tercatat — jangan pernah kosong).

### RMD-02 — `staff_reminder_list`
**Trigger:** "Tunjukkan pengingat-pengingat saya"
**Expected:** `{rows: [...], total}` — hanya scheduled/fired (kalau
`include_fired`), tidak pernah yang cancelled/done. `target_display_name` cuma "You"
KHUSUS untuk reminder dengan target diri sendiri.

### RMD-03 — `staff_reminder_cancel`
**Trigger:** "Batalkan pengingat ini"
**Expected:** `{success: true, cancelled_at, cancelled_by}`. `cancelled_by` harus id
siapa yang sedang login dan benar-benar membatalkannya (creator/target/owner), bukan
selalu owner clinic — ini persis bug yang di-fix 2026-09-14, layak dicek ulang kalau
kamu bisa test sebagai staff non-owner.

### RMD-04 — `staff_reminder_mark_done`
**Trigger:** "Sudah selesai saya kerjakan, tandai sudah selesai"
**Expected:** `{success: true, done_at, done_by}` — cek atribusi `done_by` sama
seperti RMD-03. Tidak bisa di-un-mark setelahnya (`already_done` kalau dicoba lagi).

---

## TPL (Template Studio)

### TPL-01 — `create_template`
**Trigger:** "Buatkan saya template WhatsApp dengan dua tombol: Konfirmasi dan Batal"
**Expected:** `{success: true, template_id, meta_status: "waiting_for_approval"}`.
Hanya `quick_reply` (≤3 tombol, label ≤20 karakter) yang benar-benar berfungsi — kalau
kamu (atau Maha) coba type `"list"`, harusnya dapat `list_type_not_supported_for_templates`
yang bersih, bukan diam-diam jadi quick_reply yang salah. `ar` dan `en` yang disubmit
terpisah muncul sebagai dua template berbeda. Verifikasi di Marketing → Templates
bahwa memang tersimpan dengan konfigurasi tombol yang benar.

### TPL-01 AC#1 — `get_template_status`
**Trigger:** "Gimana status template yang saya buat tadi?"
**Expected:** `{success: true, meta_status}` — status Meta yang asli (PENDING/
APPROVED/REJECTED), dibaca langsung, bukan cache dari respons create_template.

### TPL-02 — `stage_template_send`
**Trigger:** "Kirimkan template ini ke segmen [nama segmen]" (butuh template id yang
approved-atau-pending + segment id dari `crm_save_as_segment` — tidak perlu bikin
baru lewat TPL-01 dulu: clinic 611 sudah punya template asli yang APPROVED di Meta
dari pemakaian sebelumnya, mis. `appointment_reminder_for_next_week_611`, id
`1592875955551995` — `stageSend()` cuma butuh Meta punya CATATAN template itu, status
apapun)
**Expected:** `{success: true, staged_send_id, marketing_url, audience_count,
excluded_unsubscribed_count, awaiting_meta}`. **Cek paling penting**: `audience_count`
harus cocok dengan keanggotaan ASLI segment —
- untuk segment dinamis (keep_updating=ON), hitungan live terbaru;
- untuk segment frozen (keep_updating=OFF), TEPAT jumlah snapshot yang dibekukan
  (`segment_frozen_members`), tidak pernah seluruh daftar kontak clinic. Ini bug parah
  yang di-fix 2026-09-14 — layak dites khusus terhadap segment frozen, jangan cuma
  yang dinamis. Draft harus muncul di Marketing → Campaigns, ter-highlight lewat deep
  link `marketing_url`, dan TIDAK BOLEH benar-benar terkirim apa pun (tidak ada pesan
  WhatsApp keluar) — klik Send oleh owner sendiri satu-satunya pemicu.
