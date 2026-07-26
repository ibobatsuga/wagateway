# ATSUGA WhatsApp Gateway - User Credentials Database

Berikut adalah daftar kredensial akun **Super Admin** dan **20 Admin** yang telah digenerate untuk akses workspace ATSUGA WhatsApp API Gateway:

---

### 🔑 Super Admin Account (Full Permissions & Access to Reset State)

| Role | Username | Password | Full Name | Email Domain |
| :--- | :--- | :--- | :--- | :--- |
| **Super Admin** | `superadmin` | `SuperAdminPass2026!` | Super Admin | `superadmin@atsuga.io` |

> ℹ️ **Catatan Super Admin**: Tombol **Reset State** hanya akan muncul pada Dashboard & Header jika Anda masuk (login) menggunakan akun `superadmin`.

---

### 👤 20 Admin Accounts (Standard Management Access)

| No | Role | Username | Password | Full Name | Email Domain |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Admin | `admin1` | `AdminPass101!` | Admin One | `admin1@atsuga.io` |
| 2 | Admin | `admin2` | `AdminPass102!` | Admin Two | `admin2@atsuga.io` |
| 3 | Admin | `admin3` | `AdminPass103!` | Admin Three | `admin3@atsuga.io` |
| 4 | Admin | `admin4` | `AdminPass104!` | Admin Four | `admin4@atsuga.io` |
| 5 | Admin | `admin5` | `AdminPass105!` | Admin Five | `admin5@atsuga.io` |
| 6 | Admin | `admin6` | `AdminPass106!` | Admin Six | `admin6@atsuga.io` |
| 7 | Admin | `admin7` | `AdminPass107!` | Admin Seven | `admin7@atsuga.io` |
| 8 | Admin | `admin8` | `AdminPass108!` | Admin Eight | `admin8@atsuga.io` |
| 9 | Admin | `admin9` | `AdminPass109!` | Admin Nine | `admin9@atsuga.io` |
| 10 | Admin | `admin10` | `AdminPass110!` | Admin Ten | `admin10@atsuga.io` |
| 11 | Admin | `admin11` | `AdminPass111!` | Admin Eleven | `admin11@atsuga.io` |
| 12 | Admin | `admin12` | `AdminPass112!` | Admin Twelve | `admin12@atsuga.io` |
| 13 | Admin | `admin13` | `AdminPass113!` | Admin Thirteen | `admin13@atsuga.io` |
| 14 | Admin | `admin14` | `AdminPass114!` | Admin Fourteen | `admin14@atsuga.io` |
| 15 | Admin | `admin15` | `AdminPass115!` | Admin Fifteen | `admin15@atsuga.io` |
| 16 | Admin | `admin16` | `AdminPass116!` | Admin Sixteen | `admin16@atsuga.io` |
| 17 | Admin | `admin17` | `AdminPass117!` | Admin Seventeen | `admin17@atsuga.io` |
| 18 | Admin | `admin18` | `AdminPass118!` | Admin Eighteen | `admin18@atsuga.io` |
| 19 | Admin | `admin19` | `AdminPass119!` | Admin Nineteen | `admin19@atsuga.io` |
| 20 | Admin | `admin20` | `AdminPass120!` | Admin Twenty | `admin20@atsuga.io` |

---

### 🛡️ Aturan Otorisasi Akses:
1. **Super Admin (`superadmin`)**:
   - Dapat mengakses semua fitur.
   - **Tombol Reset State** tampil di Header Bar.
2. **Admin (`admin1` s/d `admin20`)**:
   - Dapat mengelola sesi WA, broadcast, kontak, API key, AI chatbot, & Google Sheets sync.
   - **Tombol Reset State TIDAK TAMPIL** (disembunyikan dari DOM).
