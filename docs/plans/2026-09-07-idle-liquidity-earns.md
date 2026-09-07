# Modal yang menunggu, tetap bekerja

**7 September 2026.** Ditulis sebelum kontraknya diubah, sementara dua pemeriksaan independen
berjalan dan boleh membantah isinya.

## Dari mana ini datang

Seorang juri 1inch membaca deskripsi kami — *"an aqua app where swaps only execute within maker
signed limits"* — dan menjawab bahwa itu terdengar **quite general**.

Dia benar, dan pemiliknya yang mendiagnosis kenapa: **membatasi agent itu kewajiban, bukan
keunggulan.** Kami menjual rem sebagai fitur mobil.

Empat ide pengganti diuji dan dicoret hari itu juga. Dua di antaranya dicoret oleh pemiliknya
sendiri, bukan oleh kami:

- **Cross-chain tanpa bridge.** Solver bayar di chain tujuan, lalu menagih di chain asal. Pertanyaan
  pemiliknya: *"kalau aku sudah terima, lalu cepat-cepat kupindahkan uangku, gimana?"* Tidak ada
  jawabannya. Jaminan Aqua berasal dari **atomicity** — kirim dan bayar ada di satu transaksi — dan
  itu hilang persis di batas chain. Setiap tambalan mengembalikan escrow, yang menghapus alasan
  memakai Aqua.
- **Over-commitment digabung dark pool.** Pertanyaan pemiliknya: *"kan tetap kelihatan uangnya dari
  aku, ZK-nya jadi kurang bermakna?"* Benar, dan lebih buruk: `Shipped` dan `Pushed` mengumumkan
  maker, token dan jumlah. Kalau orang bisa melihat kamu menjanjikan lima kali modalmu, mereka bisa
  **memilih mana yang dimatikan** dengan memicu satu. Dua ide itu saling melemahkan.

Filter yang tersisa dari kedua bantahan itu, dan yang dipakai untuk menerima ide di bawah:
**apa pun yang mengandalkan jaminan Aqua harus selesai dalam satu transaksi, di satu chain.**

## Idenya

Idenya dari pemiliknya:

> *"kalau kita udah kasih allowance, otomatis uang kita kan nganggur tuh. supaya tidak nganggur,
> uang kita ditaruh di lending protocol agar menghasilkan yield. jika ada yang membeli, otomatis
> uangnya kita withdraw dari lending protocol lalu diambil oleh taker."*

Karena Aqua tidak pernah mengambil custody, token maker masih **miliknya sepenuhnya** — jadi masih
bisa disuruh bekerja sambil menunggu. Modal yang sama mengerjakan dua pekerjaan: menghasilkan
bunga, dan siap jadi likuiditas.

Ini mustahil di AMM. Token yang disetor ke pool Uniswap ada **di dalam pool**; tidak bisa
dipinjamkan, tidak bisa apa-apa. Satu modal, satu pekerjaan.

Dan ini menjawab pertanyaan prize secara harfiah: *"a sophisticated DeFi position"* — ini memang
sebuah posisi, bukan sebuah batasan.

## Yang sudah dibuktikan, sebelum apa pun ditulis

`contracts/test/ForkAaveIdle.t.sol`, tiga test terhadap Aave v3 sungguhan di Arbitrum One.

**Mekanismenya jalan.** Men-supply USDC mengubahnya jadi aUSDC, dan `pull` meminta USDC dari dompet
yang tidak lagi memilikinya. Jadi penarikannya harus terjadi **di dalam swap yang sama** — dan itu
bisa: dengan izin atas aToken, pihak ketiga bisa `transferFrom`, `withdraw` ke maker, dan USDC-nya
kembali dalam satu panggilan. Sisa posisinya tetap menghasilkan.

**Yield-nya nyata.** 100.000 USDC menghasilkan **224,47** dalam 30 hari pada rate saat itu. Diukur,
bukan dikutip.

**Yang rusak, dan seberapa besar.** Penarikan melebihi yang bisa dibayar pasar akan gagal. Pasar
sedang memegang sekitar **29,9 juta USDC**. Itu risiko yang harus dijaga.

### Satu temuan yang membentuk kontraknya

Saldo aToken adalah *scaled amount* dikali indeks, jadi men-supply 100.000 menyisakan **sedikit
kurang** dari 100.000. Selisihnya 1 pada satu run, 2 pada run berikutnya.

Aturannya bukan "beri toleransi sekian". Aturannya: **jangan pernah mengasumsikan saldonya sama
dengan yang disetor, dan jangan pernah memindahkan jumlah tetap dari situ.** Dua percobaan pertama
gagal persis karena itu.

## Peran enclave, dan kenapa jadi tak tergantikan

Pemiliknya mengoreksi satu hal penting. Risiko likuiditas di atas kami perlakukan sebagai kelemahan
yang harus diterima. Dia menolak itu:

> *"CRE yang harus mengatur ini. kalau liquidity-nya bersisa sekian persen dan tinggal sedikit,
> otomatis CRE yang menarik funds-nya."*

Itu memberi enclave **dua pekerjaan nyata**, bukan satu yang dekoratif:

1. **Routing** — modal pergi ke pasar yang hasilnya terbaik
2. **Penjaga** — modal ditarik lebih dulu ketika likuiditas sebuah pasar menipis, supaya sebuah swap
   tidak pernah gagal karena alasan itu

Keduanya keputusan berulang atas data yang berubah. Itu bukan "AI menjelaskan keputusan" — itu AI
yang benar-benar memutuskan sesuatu, dan tanpanya mekanisme ini rapuh.

## Yang belum diputuskan

Ditulis sebagai pertanyaan terbuka, bukan disamarkan jadi rencana:

- **Sumber yield masuk ke mandat, atau di luarnya?** Kalau di dalam, maker berkomitmen "modalku
  boleh duduk di Aave" dan kontrak memaksakannya. Kalau di luar, maker kebetulan sudah men-supply
  dan kontrak menyesuaikan diri.
- **Izin atas aToken adalah kuasa baru yang kami pegang.** Apa saja yang bisa kami lakukan dengannya
  yang seharusnya tidak bisa? Ini harus dijawab secara adversarial sebelum ditulis.
- **Penarikan sebagian.** Swap butuh 40rb, maker punya 100rb ter-supply, pasar cuma bisa membayar
  30rb sekarang. Apa yang benar?
- **Siapa yang boleh memindahkan modal antar pasar,** dan apa yang mencegah kuasa itu disalahgunakan.
  Hari ini kontrak hanya menggerbang `msg.sender == mandate.agent`.

## Yang rencana ini tidak lakukan

- **Tidak mengklaim modal jadi bebas risiko.** Ini menambah ketergantungan pada protokol lain, dan
  kegagalan Aave sekarang bisa menggagalkan sebuah swap. Itu risiko baru yang sebelumnya tidak ada.
- **Tidak menjanjikan yield besar.** ~2,7% setahun. Nilainya bukan pada angkanya, melainkan pada
  modal yang tidak menganggur sama sekali.
- **Tidak menyentuh jalur Uniswap.** `HelicoVault` dan test fork-nya tetap hijau.
