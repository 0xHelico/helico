# Satu akun per pemilik

**8 September 2026.** Ditulis sebelum kodenya ada, sementara dua pemeriksaan independen berjalan.
Lima hari ke batas submission, tiga hari ke rekaman video.

## Bagaimana kami sampai di sini

Ini dokumen ketiga dalam satu rantai, dan rantainya sendiri adalah bagian dari catatan.

**Pertama**, `2026-09-07-aqua-mandate-swap.md`: aplikasi Aqua yang strateginya adalah mandat.
Selesai, teruji, 11 dari 11 mutasi tertangkap.

**Lalu seorang juri 1inch membacanya dan menjawab: *quite general*.** Pemiliknya yang mendiagnosis
kenapa, dan diagnosisnya benar: **membatasi agent itu kewajiban, bukan keunggulan.** Kami menjual
rem sebagai fitur.

**Kedua**, `2026-09-07-idle-liquidity-earns.md`: empat ide pengganti diuji, dua dicoret oleh
pemiliknya sendiri lewat pertanyaan yang tidak bisa kami jawab. Yang bertahan datang darinya:
karena Aqua tidak pernah memegang uang, uang itu masih bisa bekerja sambil menunggu.

**Ketiga**, dokumen ini. Karena begitu kontraknya perlu menyentuh posisi lending seseorang,
pertanyaan *"siapa yang memegang apa"* tidak bisa ditunda lagi.

## Pertanyaan yang memaksa perubahan ini

Untuk menarik dana dari Aave, kamu harus memegang tanda terimanya. Aave tidak punya cara menarik
atas nama orang lain — sudah diperiksa langsung ke kodenya.

Jadi tanda terima itu harus berpindah. Dan dari situ semuanya bercabang:

- **Izin ke kontrak bersama** — ditolak. Itu kuasa tak terbatas atas posisi lending seseorang,
  hidup di luar mandat, tidak dicabut saat mandat berakhir. Dan satu bug membocorkan semua orang
  sekaligus, bukan satu.
- **Tanda terima masuk ke dalam mandat** — dibangun kemarin, dan aman. Tapi masih memakai kontrak
  bersama.
- **Akun per pemilik** — pertanyaan pemiliknya: *"kontrak itu sama dengan dompet user, kan
  mindset-nya satu user satu kontrak"*. Dia benar, dan analogi kami sebelumnya salah karena masih
  memakai kerangka lama.

Dalam kerangka akun-per-pemilik, masalah izin **hilang seluruhnya** — bukan diamankan, tapi tidak
pernah ada. Akun itu memegang tanda terimanya sendiri, karena akun itu memang milik pemiliknya.

## Dua keputusan pemiliknya, dan apa yang keduanya beli

Ditanyakan eksplisit, dijawab eksplisit, dan dicatat di sini karena keduanya memindahkan garis
kepercayaan.

### Kode boleh diganti, dan CRE boleh melakukannya otomatis

Yang dibeli: perbaikan darurat sampai ke pengguna tanpa menunggu mereka bangun.

Yang dibayar: **kunci CRE yang bocor berarti kode yang memegang uang bisa ditulis ulang.** Ini
kuasa terbesar dalam sistem, dan tidak ada gunanya menyamarkannya.

Yang meredam, dan harus ada sejak versi pertama:

- **Pintu darurat yang tidak bisa di-upgrade.** Fungsi tarik-semua-ke-pemilik hidup di proxy, bukan
  di implementasi. Kode boleh diganti seluruhnya; jalan keluar pemiliknya tetap ada.
- **Jeda untuk upgrade yang bukan darurat**, dan pemilik boleh membatalkannya dalam jeda itu.
- **Pemilik boleh menolak auto-upgrade** sepenuhnya, sekali, permanen.

Yang **tidak** bisa diredam, dan harus dikatakan: CRE yang dikompromikan bisa mengganti kode lalu
memindahkan dana. Pintu darurat hanya menolong pemilik yang sempat memakainya. Satu-satunya
pertahanan sesungguhnya adalah kunci itu memang hidup di dalam enclave dan tidak pernah keluar —
yang justru inti klaim Chainlink kami, dan sekarang jadi taruhannya juga.

### CRE boleh memakai protokol lending di luar daftar pemiliknya

Yang dibeli: modal mengejar hasil terbaik tanpa pemiliknya harus memperbarui mandat.

Yang dibayar: CRE bisa menaruh uang di protokol yang pemiliknya belum pernah setujui — termasuk
yang baru, tipis, atau sedang bermasalah.

Yang meredam:

- **Porsi maksimal di luar daftar**, ditentukan pemiliknya. Sisanya tetap di tempat yang dia pilih.
- **Jeda sebelum efektif**, supaya pemilik sempat menolak.
- **Pintu darurat menarik dari mana pun**, termasuk protokol yang tidak dia kenal.

## Yang belum diputuskan, dan sedang diperiksa

Bukan disamarkan jadi rencana:

- **Pola akun yang dipakai.** Buatan sendiri yang minimal, Safe beserta modulnya, ERC-4337, atau
  ERC-7579. Yang menentukan bukan kelengkapan fitur, tapi berapa banyak kode yang harus kami tulis
  dan pertanggungjawabkan dalam lima hari.
- **Deploy yang tidak terasa.** Pemiliknya menginginkan pengguna tidak pernah melihat langkah
  "buat akun" — alamatnya dihitung di depan, kontraknya lahir saat pertama dipakai. Pola ini nyata
  dan dipakai di produksi, tapi punya mode kegagalan sendiri yang harus diperiksa sebelum dipilih.
- **Bagaimana aplikasi meminta akun menyiapkan dana** di tengah swap, tanpa memberi aplikasi kuasa
  yang lebih besar dari yang dibutuhkan.

## Yang rencana ini tidak lakukan

- **Tidak membuang kontrak yang sudah jadi.** Aturan mandat, plafon per token, kurva harga,
  penolakan bernama, dan 28 test-nya tetap. Yang berubah dari mana uangnya diambil.
- **Tidak mengklaim ini lebih aman secara mutlak.** Akun per pemilik memberi isolasi kalau ada bug,
  dan mengambil kembali sebagian isolasi itu lewat kode yang bisa diganti. Pertukarannya nyata dan
  pemiliknya memilihnya dengan tahu.
- **Tidak menyentuh jalur Uniswap.** `HelicoVault` dan test fork-nya tetap hijau.
