# Satu akun per pemilik: factory, proxy, dan pintu yang tidak bisa ditutup

Ditulis 8 September, sebelum kodenya. Keputusan yang mendasarinya ada di
[`2026-09-08-one-account-per-owner.md`](2026-09-08-one-account-per-owner.md); dokumen ini
hanya soal bagaimana membangunnya.

## Yang dibangun

Tiga bagian, dan satu di antaranya sengaja tidak bisa disentuh upgrade.

| Bagian | Tugasnya |
|---|---|
| `HelicoAccountFactory` | Menghitung alamat akun seseorang sebelum akun itu ada, lalu membukanya |
| `HelicoAccountProxy` | Kontrak yang benar-benar dimiliki pengguna. Memegang pintu darurat |
| `HelicoAccount` | Isi yang bisa diganti: siapa boleh menjalankan apa |

## Kenapa proxy-nya ditulis sendiri, bukan memakai OZ

Satu alasan, dan ini seluruh alasannya: **pintu darurat harus hidup di kontrak yang tidak bisa
di-upgrade.** Sebuah proxy meneruskan semua panggilan ke implementasi; kalau fungsi
tarik-semua-ke-pemilik ada di implementasi, maka kunci yang bisa mengganti implementasi juga
bisa menghapus jalan keluarnya. Jalan keluar yang bisa dicabut bukan jalan keluar.

Jadi `escape` adalah fungsi milik proxy itu sendiri, dan `OWNER` adalah `immutable` — ada di
bytecode, bukan di storage, sehingga tidak ada implementasi yang bisa menulisinya dan tidak ada
tabrakan slot yang bisa menggesernya.

Harganya, dan ini harus ditulis daripada ditemukan nanti: **dua selector milik proxy menutupi
implementasi.** `escape(address[])` dan `OWNER()` tidak akan pernah sampai ke implementasi.
Implementasi tidak boleh mendeklarasikan keduanya, dan ada test yang menjaga itu.

## Alamat sebelum kontraknya ada

`CREATE2` dengan `salt = keccak256(owner)`. Konsekuensinya yang berguna: alamat akun seseorang
bisa dihitung, ditampilkan, dan dikirimi token **sebelum ada transaksi apa pun yang membuatnya**.
Pengguna baru tidak perlu membayar gas hanya untuk punya alamat.

`open` bersifat idempoten — kalau kodenya sudah ada, kembalikan saja alamatnya. Dua orang yang
membuka akun yang sama secara bersamaan tidak boleh membuat salah satunya gagal.

## Upgrade

Menyalin pola yang sudah terbukti di `HelicoVault`, bukan menciptakan yang baru:

- **Diumumkan dulu, dijalankan kemudian.** `UPGRADE_DELAY` sebelum bisa dieksekusi,
  `UPGRADE_GRACE` sesudahnya sebelum kedaluwarsa.
- **Codehash dipin.** Yang dijadwalkan dan yang dieksekusi harus kontrak yang sama persis.
  Alamat yang sama dengan kode berbeda ditolak.
- **Pemilik boleh membatalkan** selama jeda.
- **Pemilik boleh menolak upgrade otomatis, sekali dan selamanya.** Setelah itu hanya dia
  sendiri yang bisa mengganti kode akunnya.

Satu perbedaan penting dari beacon: **implementasi disimpan per akun**, di slot ERC-1967 milik
proxy masing-masing. Beacon lebih murah — satu tulisan mengganti kode semua orang — dan itu
persis nasib-bersama yang arsitektur ini dibuat untuk menghindarinya. Kalau satu kunci bisa
menulis ulang kode semua akun, kita membayar ongkos satu-kontrak-per-orang tanpa mendapat
isolasinya.

## Yang rencana ini tidak lakukan

- **Tidak memindahkan `HelicoMandateSwap` ke dalam akun.** Aqua tetap satu-satunya jalan kode
  ini memindahkan token orang. Akun memegang izin, bukan saldo.
- **Tidak menambah kuasa baru untuk CRE.** Kuasa yang sudah diputuskan tetap; penjaga
  implementasi di backend dicatat di dokumen keputusan.
- **Tidak ada fungsi penyelamat untuk token nyasar selain `escape`.** Pemiliknya punya jalan
  keluar; kontrak ini tidak butuh yang kedua.
